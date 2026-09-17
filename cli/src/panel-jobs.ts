import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { ConfigError } from './exit.js';
import { redactSecrets } from './github.js';
import { AGENT_MODELS, canonicalModel } from './models.js';
import { isRunId, readRuns, runDirectory, withLedgerLock, writeAtomic } from './runs-store.js';
import { pidExists, processStartTime } from './trace-store.js';
import type { PanelAction, PanelJob, PanelJobRequest, PanelProject } from './panel-types.js';

const ACTIONS: PanelAction[] = ['run', 'plan', 'resume', 'stop', 'doctor', 'chart'];
const MUTATING = new Set<PanelAction>(['run', 'plan', 'resume', 'chart']);
const ACTIVE = new Set<PanelJob['status']>(['starting', 'running']);
const ID = /^[a-f0-9-]{36}$/;
const MAX_LINE = 32 * 1024;
const MAX_LINES = 200;
interface Stored {
  version: 1; job: PanelJob; projectPath: string; processStartedAt: number | null;
  ownerPid: number; ownerStartedAt: number; requestedRunId?: string;
  stopRequested: boolean; stopTarget?: string;
}
interface Owned { child: ChildProcess; done: Promise<void>; finish(): void; }

// The launcher only bridges our owned IPC channel to the CLI's existing
// SIGINT handlers. It never evaluates input or implements a session loop.
const LAUNCHER = `import { pathToFileURL } from 'node:url';
let requested = false, delivered = false, detached = false;
const channels = [process.stdout, process.stderr];
for (const stream of channels) {
  const write = stream.write.bind(stream);
  stream.write = (...args) => {
    if (!detached) return write(...args);
    const callback = args.at(-1); if (typeof callback === 'function') queueMicrotask(callback);
    return true;
  };
}
const handlersReady = () => process.listeners('SIGINT').some(listener => listener !== observed);
function observed() { requested = true; if (handlersReady()) delivered = true; }
process.prependListener('SIGINT', observed);
function stop() { requested = true; }
process.on('message', value => { if (value?.type === 'genesis-panel-stop') stop(); });
process.on('disconnect', () => {
  detached = true;
  // A closed display must not abort the CLI before it records final billing.
  for (const stream of channels) { stream.removeAllListeners('error'); stream.on('error', () => {}); }
  stop();
});
process.channel?.unref();
const timer = setInterval(() => {
  if (requested && !delivered && handlersReady()) {
    delivered = true; process.emit('SIGINT');
  }
}, 20); timer.unref();
process.send?.({ type: 'genesis-panel-ready', pid: process.pid, startedAt: Date.now() - Math.floor(process.uptime() * 1000) });
const cli = process.argv[2]; process.argv.splice(1, 1);
await import(pathToFileURL(cli).href);
`;

function directory(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || !statSync(path).isDirectory()) throw new ConfigError('project path must name an existing absolute directory');
  return realpathSync(path);
}
function safeParents(path: string): void {
  for (let candidate = resolve(path); ; candidate = dirname(candidate)) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) throw new ConfigError('control-panel storage cannot traverse symbolic links');
    if (dirname(candidate) === candidate) break;
  }
}
function key(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }
function argumentsFor(request: PanelJobRequest, project: Pick<PanelProject, 'id' | 'name' | 'path'>): string[] {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !ACTIONS.includes(request.action)) throw new ConfigError('unknown panel action');
  if (typeof request.projectId !== 'string' || request.projectId !== project.id) throw new ConfigError('job project does not match the selected project');
  const allowed: Record<PanelAction, string[]> = {
    run: ['input','model','builderModel','criticModel','maxCostUsd','maxRounds','maxTurns','permissionMode'],
    plan: ['input','model','builderModel','criticModel','maxTurns','permissionMode','force'],
    resume: ['runId','maxCostUsd','maxRounds','maxTurns','permissionMode'],
    stop: ['runId','force'], doctor: [], chart: ['input','model'],
  };
  for (const name of Object.keys(request)) if (!['action','projectId',...allowed[request.action]].includes(name)) throw new ConfigError('unsupported field for ' + request.action + ': ' + name);
  if (['run','plan','chart'].includes(request.action) && (typeof request.input !== 'string' || !request.input.trim() || request.input.length > 16384 || request.input.includes('\0'))) throw new ConfigError('input must contain between one and 16384 characters without NUL');
  if (request.runId !== undefined && (typeof request.runId !== 'string' || !isRunId(request.runId))) throw new ConfigError('invalid run id');
  if (request.action === 'resume' && request.runId === undefined) throw new ConfigError('resume requires a run id');
  if (request.runId !== undefined && !readRuns(project.path).some(run => run.id === request.runId)) throw new ConfigError('the selected project has no such run');
  if (request.force !== undefined && typeof request.force !== 'boolean') throw new ConfigError('force must be boolean');
  if (request.action === 'stop' && request.force && request.runId === undefined) throw new ConfigError('force stop requires a recorded run id');
  const argv = [request.action, '-C', project.path];
  if (request.action === 'run') argv.push('--auto', '--json', '--no-config');
  if (request.action === 'resume') argv.push('--json');
  if (request.action === 'doctor') argv.push('--read-only', '--json');
  if (request.action === 'chart') argv.push('--afk', '--tracker', 'local');
  if (request.model !== undefined) {
    const model = typeof request.model === 'string' ? canonicalModel(request.model) : undefined;
    if (model === undefined) throw new ConfigError('unknown lead model');
    argv.push('--model', model);
  }
  for (const [field, flag] of [['builderModel','--builder-model'],['criticModel','--critic-model']] as const) {
    const value = request[field];
    if (value !== undefined) {
      if (typeof value !== 'string' || !(AGENT_MODELS as readonly string[]).includes(value)) throw new ConfigError(field + ' must name a supported model family');
      argv.push(flag, value);
    }
  }
  for (const [field, flag] of [['maxCostUsd','--max-cost'],['maxRounds','--max-rounds'],['maxTurns','--max-turns']] as const) {
    const value = request[field];
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (field !== 'maxCostUsd' && !Number.isSafeInteger(value))) throw new ConfigError(field + ' must be a positive ' + (field === 'maxCostUsd' ? 'number' : 'integer'));
      argv.push(flag, String(value));
    }
  }
  if (request.permissionMode !== undefined) {
    if (!['bypassPermissions','acceptEdits','default'].includes(request.permissionMode)) throw new ConfigError('invalid permission mode');
    argv.push('--permission-mode', request.permissionMode);
  }
  if (request.force) argv.push('--force');
  if (request.input !== undefined) argv.push('--', request.input);
  else if (request.runId !== undefined) argv.push('--', request.runId);
  return argv;
}

/** Runs the shipped commands; the panel has no second implementation of them. */
export class PanelJobManager {
  private readonly storage: string;
  private readonly launcher: string;
  private readonly cliPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly records = new Map<string, Stored>();
  private readonly owned = new Map<string, Owned>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly began = Date.now() - Math.floor(process.uptime() * 1000);
  private closed = false;
  private closing?: Promise<void>;
  constructor(options: { root: string; cliPath: string; env?: NodeJS.ProcessEnv }) {
    this.storage = join(directory(resolve(options.root)), '.exolvra-genesis', 'control-panel');
    safeParents(this.storage); mkdirSync(join(this.storage, 'jobs'), { recursive: true });
    this.cliPath = resolve(options.cliPath);
    if (!statSync(this.cliPath).isFile()) throw new ConfigError('the CLI entry point is not a file');
    this.env = { ...(options.env ?? process.env) };
    this.launcher = join(this.storage, 'launch.mjs');
    safeParents(this.launcher); writeAtomic(this.launcher, LAUNCHER);
    this.load();
    this.timer = setInterval(() => this.tick(), 250); this.timer.unref();
  }
  private clean(text: string): string {
    let clean = stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
    for (const [name, value] of Object.entries(this.env)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(name) && value && value.length >= 6) clean = clean.split(value).join('[redacted]');
    return redactSecrets(clean).replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/g, '[redacted]').slice(0, 4096);
  }
  private persist(record: Stored): void {
    const path = join(this.storage, 'jobs', record.job.id + '.json'); safeParents(path);
    writeAtomic(path, JSON.stringify(record) + '\n'); this.records.set(record.job.id, record);
  }
  private load(): void {
    for (const name of readdirSync(join(this.storage, 'jobs'))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(this.storage, 'jobs', name); safeParents(path);
      if (statSync(path).size > 4 * 1024 * 1024) throw new ConfigError('oversized panel job history');
      const record = JSON.parse(readFileSync(path, 'utf8')) as Stored;
      if (record.version !== 1 || !record.job || record.job.id + '.json' !== name || !ACTIONS.includes(record.job.action) || !['starting','running','succeeded','failed','interrupted'].includes(record.job.status) || typeof record.projectPath !== 'string' || !isAbsolute(record.projectPath) || !Array.isArray(record.job.output) || record.job.output.length > MAX_LINES || record.job.output.some(line => typeof line.text !== 'string' || line.text.length > 4096) || (record.job.pid !== null && (!Number.isSafeInteger(record.job.pid) || record.job.pid <= 0)) || (record.processStartedAt !== null && !Number.isFinite(record.processStartedAt)) || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0 || !Number.isFinite(record.ownerStartedAt)) throw new ConfigError('invalid panel job history');
      record.job.output = record.job.output.map(line => ({ ...line, text: this.clean(line.text) }));
      record.job.projectName = this.clean(record.job.projectName);
      if (record.job.error !== null) record.job.error = this.clean(record.job.error);
      if (!this.owned.has(record.job.id)) this.records.set(record.job.id, record);
    }
  }
  private output(record: Stored, stream: 'stdout' | 'stderr', text: string): void {
    record.job.output.push({ seq: (record.job.output.at(-1)?.seq ?? 0) + 1, at: Date.now(), stream, text: this.clean(text) });
    if (record.job.output.length > MAX_LINES) record.job.output.splice(0, record.job.output.length - MAX_LINES);
    try { this.persist(record); } catch (error) { record.job.error = this.clean('Could not persist job output: ' + String(error)); }
  }
  private capture(record: Stored, stream: 'stdout' | 'stderr', source: NodeJS.ReadableStream): void {
    const decoder = new StringDecoder('utf8'); let pending = '', dropping = false;
    const consume = (chunk: string): void => {
      for (const part of chunk.split(/(?<=\n)/)) {
        if (!dropping) pending += part;
        if (pending.length > MAX_LINE) { pending = ''; dropping = true; }
        if (part.endsWith('\n')) {
          this.output(record, stream, dropping ? '[oversized output line omitted]' : pending.replace(/\r?\n$/, ''));
          pending = ''; dropping = false;
        }
      }
    };
    source.on('data', (chunk: Buffer) => consume(decoder.write(chunk)));
    source.on('end', () => { consume(decoder.end()); if (pending || dropping) this.output(record, stream, dropping ? '[oversized output line omitted]' : pending); });
  }
  private identity(record: Stored): 'alive' | 'dead' | 'unknown' {
    const pid = record.job.pid;
    if (pid === null) {
      if (!pidExists(record.ownerPid)) return 'dead';
      const ownerStart = processStartTime(record.ownerPid);
      return ownerStart !== null && Math.abs(ownerStart - record.ownerStartedAt) > 2000 ? 'dead' : 'unknown';
    }
    if (!pidExists(pid)) return 'dead';
    if (record.processStartedAt === null) return 'unknown';
    const started = processStartTime(pid);
    if (started === null) return 'unknown';
    return Math.abs(started - record.processStartedAt) <= 2000 ? 'alive' : 'dead';
  }
  private recover(record: Stored): void {
    if (!ACTIVE.has(record.job.status) || this.owned.has(record.job.id) || record.stopTarget) return;
    const identity = this.identity(record);
    if (identity === 'dead') {
      record.job.status = 'interrupted'; record.job.finishedAt = Date.now();
      record.job.error = 'The original command process is gone; its exit result was not observed. Inspect the run ledger for settled work and billing.';
    } else {
      record.job.status = identity === 'alive' ? 'running' : 'starting';
      record.job.error = identity === 'alive' ? 'Command is still running under its original process; this controller does not own it.' : 'Process identity cannot yet be verified; no success, exit, or stop is assumed.';
    }
    this.persist(record);
  }
  private link(record: Stored): void {
    if (!['run','resume'].includes(record.job.action) || record.job.runId || record.job.pid === null || record.processStartedAt === null) return;
    try {
      const candidates = readRuns(record.projectPath).filter(run => !record.requestedRunId || run.id === record.requestedRunId);
      for (const run of candidates) {
        const control = JSON.parse(readFileSync(join(runDirectory(record.projectPath, run.id), 'control.json'), 'utf8'));
        if (control.run === run.id && control.pid === record.job.pid && typeof control.startedAt === 'number' && Math.abs(control.startedAt - record.processStartedAt) <= 2000) { record.job.runId = run.id; this.persist(record); return; }
      }
    } catch { /* A not-yet-created or atomically replaced ledger is retried. */ }
  }
  private requestStop(record: Stored): void {
    record.stopRequested = true; this.persist(record); this.link(record);
    const owned = this.owned.get(record.job.id);
    if (!owned) return;
    if (record.job.runId) {
      try {
        const path = join(runDirectory(record.projectPath, record.job.runId), 'control.json');
        const control = JSON.parse(readFileSync(path, 'utf8'));
        if (control.pid === record.job.pid && Math.abs(control.startedAt - (record.processStartedAt ?? 0)) <= 2000) {
          writeAtomic(join(dirname(path), 'stop-request.json'), JSON.stringify({ run: record.job.runId, requestedAt: Date.now(), ownerPid: control.pid, ownerStartedAt: control.startedAt }) + '\n'); return;
        }
      } catch { /* The IPC bridge also covers early preflight, before a run id exists. */ }
    }
    if (owned.child.connected) owned.child.send({ type: 'genesis-panel-stop' }, () => {});
  }
  private tick(): void {
    for (const record of this.records.values()) if (ACTIVE.has(record.job.status)) {
      try { if (this.owned.has(record.job.id)) {
        this.link(record); if (record.stopRequested) this.requestStop(record);
      } else if (record.stopTarget) {
        const target = this.records.get(record.stopTarget);
        if (target && !ACTIVE.has(target.job.status)) { record.job.status = 'succeeded'; record.job.finishedAt = Date.now(); record.job.exitCode = 0; record.job.runId = target.job.runId; this.output(record, 'stdout', 'The owned command has settled.'); }
      } } catch (error) { record.job.error = this.clean('Job monitoring needs attention: ' + String(error)); }
    }
  }
  start(project: Pick<PanelProject, 'id' | 'name' | 'path'>, request: PanelJobRequest): PanelJob {
    if (this.closed) throw new ConfigError('the control panel is closing');
    const selected = { ...project, path: directory(project.path) };
    const argv = argumentsFor(request, selected);
    return withLedgerLock(this.storage, () => {
      this.load();
      for (const row of this.records.values()) this.recover(row);
      const active = [...this.records.values()].filter(row => key(row.projectPath) === key(selected.path) && MUTATING.has(row.job.action) && ACTIVE.has(row.job.status));
      if (MUTATING.has(request.action) && active.length) throw new ConfigError('a command is already active for this project; wait for it to settle before starting another');
      const record: Stored = { version: 1, projectPath: selected.path, processStartedAt: null, ownerPid: process.pid, ownerStartedAt: this.began, requestedRunId: request.runId, stopRequested: false,
        job: { id: randomUUID(), projectId: selected.id, projectName: this.clean(selected.name), action: request.action, status: 'starting', createdAt: Date.now(), finishedAt: null, runId: request.action === 'stop' ? request.runId ?? null : null, exitCode: null, pid: null, output: [], error: null } };
      this.persist(record);
      const target = request.action === 'stop' ? active.find(row => this.owned.has(row.job.id) && (request.runId === undefined || row.job.runId === request.runId || row.requestedRunId === request.runId)) : undefined;
      if (target && !request.force) {
        record.stopTarget = target.job.id; record.job.status = 'running'; this.persist(record);
        this.requestStop(target); this.output(record, 'stdout', 'Stop requested; waiting for the owned command and billing to settle.');
        return structuredClone(record.job);
      }
      const child = spawn(process.execPath, [this.launcher, this.cliPath, ...argv], { cwd: selected.path, env: this.env, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe','ipc'] });
      let finish!: () => void; const done = new Promise<void>(resolveDone => { finish = resolveDone; });
      this.owned.set(record.job.id, { child, done, finish }); record.job.pid = child.pid ?? null; this.persist(record);
      this.capture(record, 'stdout', child.stdout!); this.capture(record, 'stderr', child.stderr!);
      child.on('message', (message: unknown) => {
        const value = message as { type?: string; pid?: number; startedAt?: number } | null;
        if (value?.type === 'genesis-panel-ready' && value.pid === child.pid && typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)) {
          record.processStartedAt = value.startedAt; record.job.status = 'running';
          try { this.persist(record); if (record.stopRequested) this.requestStop(record); } catch (error) { record.job.error = this.clean('Could not persist command readiness: ' + String(error)); }
        }
      });
      child.on('error', error => { record.job.error = this.clean(error.message); });
      let observedExit = false;
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (observedExit) return;
        observedExit = true;
        this.link(record); record.job.exitCode = code; record.job.finishedAt = Date.now();
        record.job.status = code === 0 ? 'succeeded' : record.stopRequested || signal !== null ? 'interrupted' : 'failed';
        if (code === 0) record.job.error = null;
        if (code !== 0 && !record.job.error) record.job.error = signal ? 'Command ended after ' + signal : 'Command exited with ' + String(code) + '; inspect its output.';
        try { this.persist(record); } catch (error) { record.job.error = this.clean('Command ended, but its final job record could not be saved: ' + String(error)); }
        this.owned.delete(record.job.id); finish(); this.tick();
      };
      child.once('exit', settle); child.once('close', settle);
      return structuredClone(record.job);
    });
  }
  list(): PanelJob[] { this.load(); for (const row of this.records.values()) this.recover(row); this.tick(); return [...this.records.values()].map(row => structuredClone(row.job)).sort((a,b) => b.createdAt - a.createdAt); }
  get(id: string): PanelJob | undefined { if (!ID.test(id)) return undefined; return this.list().find(job => job.id === id); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      for (const id of this.owned.keys()) { const record = this.records.get(id); if (record && ACTIVE.has(record.job.status)) this.requestStop(record); }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([...this.owned.values()].map(task => task.done)),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => {
            for (const [id, task] of this.owned) {
              const record = this.records.get(id);
              if (record) { record.job.error = 'Stop requested, but the command has not settled after 15 seconds; billing may still be pending.'; try { this.persist(record); } catch { /* Keep the truthful live record in memory. */ } }
              // Detach references, never kill. The CLI still owns settlement
              // and its launcher tolerates output pipes whose reader closed.
              task.child.unref(); task.child.channel?.unref();
              for (const stream of [task.child.stdout, task.child.stderr]) (stream as (NodeJS.ReadableStream & { unref?(): void }) | null)?.unref?.();
              if (task.child.connected) task.child.disconnect();
            }
            reject(new ConfigError('owned commands have not settled; their active jobs and pending billing remain recorded'));
          }, 15000); }),
        ]);
      } finally { if (deadline !== undefined) clearTimeout(deadline); this.tick(); clearInterval(this.timer); }
    })();
    return this.closing;
  }
}
