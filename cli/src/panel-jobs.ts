import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { ConfigError } from './exit.js';
import { redactSecrets } from './github.js';
import { AGENT_MODELS, canonicalModel } from './models.js';
import { isRunId, readRuns, runDirectory, withLedgerLock, writeAtomic } from './runs-store.js';
import { pidExists, processStartTime } from './trace-store.js';
import type { PanelAction, PanelJob, PanelJobRequest, PanelProject } from './panel-types.js';

const ACTIONS: PanelAction[] = ['run', 'plan', 'resume', 'stop', 'doctor', 'chart'];
const MUTATING = new Set<PanelAction>(['run', 'plan', 'resume', 'chart']);
/** Statuses backed by a process. A queued job has none yet. */
const ACTIVE = new Set<PanelJob['status']>(['starting', 'running']);
const STATUSES: PanelJob['status'][] = ['queued', 'starting', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'];
const ID = /^[a-f0-9-]{36}$/;
const MAX_LINE = 32 * 1024;
const MAX_LINES = 200;
const MAX_READ = 256 * 1024;
const IDENTITY_TTL_MS = 10_000;
export const DEFAULT_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 32;
interface Stored {
  version: 1; job: PanelJob; projectPath: string; processStartedAt: number | null;
  ownerPid: number; ownerStartedAt: number; requestedRunId?: string;
  stopRequested: boolean; stopTarget?: string;
  /** The exact CLI arguments a queued job launches with, fixed when it was accepted. */
  argv?: string[];
  /** Bytes of each output file already folded into the job record. */
  offsets?: { stdout: number; stderr: number };
}
interface Owned { child: ChildProcess; done: Promise<void>; finish(): void; }
interface Receipt { pid: number; startedAt: number; code: number | null; at: number }

// The launcher runs the shipped CLI in-process and bridges two files to its
// existing SIGINT handlers: a stop request the panel writes, and an exit
// receipt the launcher writes. Neither depends on the panel staying alive.
// It never evaluates input or implements a session loop.
const LAUNCHER = `import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [cli, control] = process.argv.slice(2, 4);
process.argv.splice(1, 3, cli);
const startedAt = Date.now() - Math.floor(process.uptime() * 1000);
let requested = false, delivered = false;
const handlersReady = () => process.listeners('SIGINT').some(listener => listener !== observed);
function observed() { requested = true; if (handlersReady()) delivered = true; }
process.prependListener('SIGINT', observed);
const timer = setInterval(() => {
  if (!requested && existsSync(control + '.stop')) requested = true;
  if (requested && !delivered && handlersReady()) { delivered = true; process.emit('SIGINT'); }
}, 100); timer.unref();
process.on('exit', code => { try { writeFileSync(control + '.exit.json', JSON.stringify({ pid: process.pid, startedAt, code, at: Date.now() }) + '\\n'); } catch {} });
try { writeFileSync(control + '.ready.json', JSON.stringify({ pid: process.pid, startedAt }) + '\\n'); } catch {}
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
function receipt(path: string): Receipt | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<Receipt>;
    const code = value.code ?? null;
    if (!Number.isSafeInteger(value.pid) || !Number.isFinite(value.startedAt) || (code !== null && !Number.isSafeInteger(code))) return undefined;
    return { pid: value.pid!, startedAt: value.startedAt!, code, at: Number.isFinite(value.at) ? value.at! : Date.now() };
  } catch { return undefined; }
}

/**
 * Runs the shipped commands; the panel has no second implementation of them.
 * Commands are detached processes that outlive the panel: a restarted panel
 * adopts them from their records, output files and exit receipts. Paid
 * commands wait in a persistent queue for a free execution slot.
 */
export class PanelJobManager {
  private readonly storage: string;
  private readonly launcher: string;
  private readonly cliPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly concurrency: number;
  private readonly records = new Map<string, Stored>();
  private readonly owned = new Map<string, Owned>();
  private readonly verified = new Map<string, number>();
  private readonly dropping = new Map<string, { stdout: boolean; stderr: boolean }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly began = Date.now() - Math.floor(process.uptime() * 1000);
  private closed = false;
  private closing?: Promise<PanelJob[]>;
  constructor(options: { root: string; cliPath: string; env?: NodeJS.ProcessEnv; concurrency?: number }) {
    this.storage = join(directory(resolve(options.root)), '.exolvra-genesis', 'control-panel');
    safeParents(this.storage); mkdirSync(join(this.storage, 'jobs'), { recursive: true });
    this.cliPath = resolve(options.cliPath);
    if (!statSync(this.cliPath).isFile()) throw new ConfigError('the CLI entry point is not a file');
    this.env = { ...(options.env ?? process.env) };
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new ConfigError('concurrency must be an integer from 1 to ' + String(MAX_CONCURRENCY));
    this.concurrency = concurrency;
    this.launcher = join(this.storage, 'launch.mjs');
    safeParents(this.launcher); writeAtomic(this.launcher, LAUNCHER);
    this.load();
    this.timer = setInterval(() => this.tick(), 250); this.timer.unref();
  }
  /** The number of paid commands that may run at once across all projects. */
  get limit(): number { return this.concurrency; }
  private control(id: string): string { return join(this.storage, 'jobs', id); }
  private clean(text: string): string {
    let clean = stripVTControlCharacters(text).replace(/[ --‪-‮⁦-⁩]/g, '');
    for (const [name, value] of Object.entries(this.env)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(name) && value && value.length >= 6) clean = clean.split(value).join('[redacted]');
    return redactSecrets(clean).replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/g, '[redacted]').slice(0, 4096);
  }
  private persist(record: Stored): void {
    const path = this.control(record.job.id) + '.json'; safeParents(path);
    writeAtomic(path, JSON.stringify(record) + '\n'); this.records.set(record.job.id, record);
  }
  private load(): void {
    for (const name of readdirSync(join(this.storage, 'jobs'))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(this.storage, 'jobs', name); safeParents(path);
      if (statSync(path).size > 4 * 1024 * 1024) throw new ConfigError('oversized panel job history');
      const record = JSON.parse(readFileSync(path, 'utf8')) as Stored;
      if (record.version !== 1 || !record.job || record.job.id + '.json' !== name || !ACTIONS.includes(record.job.action) || !STATUSES.includes(record.job.status) || typeof record.projectPath !== 'string' || !isAbsolute(record.projectPath) || !Array.isArray(record.job.output) || record.job.output.length > MAX_LINES || record.job.output.some(line => typeof line.text !== 'string' || line.text.length > 4096) || (record.job.pid !== null && (!Number.isSafeInteger(record.job.pid) || record.job.pid <= 0)) || (record.processStartedAt !== null && !Number.isFinite(record.processStartedAt)) || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0 || !Number.isFinite(record.ownerStartedAt)) throw new ConfigError('invalid panel job history');
      if (record.argv !== undefined && (!Array.isArray(record.argv) || record.argv.some(part => typeof part !== 'string'))) throw new ConfigError('invalid panel job history');
      if (record.offsets !== undefined && (!Number.isSafeInteger(record.offsets?.stdout) || record.offsets.stdout < 0 || !Number.isSafeInteger(record.offsets?.stderr) || record.offsets.stderr < 0)) throw new ConfigError('invalid panel job history');
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
  /**
   * Folds new bytes of the command's output files into the record. Only whole
   * lines advance the persisted offset, so a restarted panel resumes exactly
   * where the previous one stopped reading; `final` flushes a trailing partial line.
   */
  private drain(record: Stored, final = false): void {
    const offsets = record.offsets ??= { stdout: 0, stderr: 0 };
    const dropping = this.dropping.get(record.job.id) ?? { stdout: false, stderr: false }; this.dropping.set(record.job.id, dropping);
    for (const stream of ['stdout', 'stderr'] as const) {
      const path = this.control(record.job.id) + (stream === 'stdout' ? '.out.log' : '.err.log');
      let fd: number;
      try { fd = openSync(path, 'r'); } catch { continue; }
      try {
        const size = fstatSync(fd).size;
        if (size < offsets[stream]) offsets[stream] = 0;
        const length = Math.min(size - offsets[stream], MAX_READ);
        if (length <= 0) continue;
        const buffer = Buffer.allocUnsafe(length);
        const read = readSync(fd, buffer, 0, length, offsets[stream]);
        const chunk = buffer.subarray(0, read);
        let boundary = chunk.lastIndexOf(0x0a) + 1;
        if (boundary === 0 && !final && read < MAX_READ) continue;
        if (boundary === 0) boundary = read;
        offsets[stream] += boundary;
        for (const part of chunk.subarray(0, boundary).toString('utf8').split(/(?<=\n)/)) {
          const complete = part.endsWith('\n');
          if (dropping[stream]) { if (complete) dropping[stream] = false; continue; }
          if (part.length > MAX_LINE) { this.output(record, stream, '[oversized output line omitted]'); dropping[stream] = !complete; continue; }
          const text = part.replace(/\r?\n$/, '');
          if (complete || text) this.output(record, stream, text);
        }
      } finally { closeSync(fd); }
    }
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
    // Start-time probes spawn a process; an identity confirmed recently only needs the cheap liveness check.
    const verifiedAt = this.verified.get(record.job.id);
    if (verifiedAt !== undefined && Date.now() - verifiedAt < IDENTITY_TTL_MS) return 'alive';
    const started = processStartTime(pid);
    if (started === null) return 'unknown';
    if (Math.abs(started - record.processStartedAt) > 2000) return 'dead';
    this.verified.set(record.job.id, Date.now());
    return 'alive';
  }
  private settle(record: Stored, code: number | null, signal: string | null): void {
    try { this.drain(record, true); } catch (error) { record.job.error = this.clean('Final output could not be read: ' + String(error)); }
    this.link(record); record.job.exitCode = code; record.job.finishedAt = Date.now();
    record.job.status = code === 0 ? 'succeeded' : record.stopRequested || signal !== null ? 'interrupted' : 'failed';
    if (code === 0) record.job.error = null;
    if (code !== 0 && !record.job.error) record.job.error = signal ? 'Command ended after ' + signal : 'Command exited with ' + String(code) + '; inspect its output.';
    try { this.persist(record); } catch (error) { record.job.error = this.clean('Command ended, but its final job record could not be saved: ' + String(error)); }
    this.verified.delete(record.job.id); this.dropping.delete(record.job.id);
  }
  /** Observes a process this panel did not start: its output, its identity and its durable exit receipt. */
  private observe(record: Stored): void {
    if (!ACTIVE.has(record.job.status) || this.owned.has(record.job.id) || record.stopTarget) return;
    if (record.processStartedAt === null && record.job.pid !== null) {
      const ready = receipt(this.control(record.job.id) + '.ready.json');
      if (ready && ready.pid === record.job.pid) record.processStartedAt = ready.startedAt;
    }
    this.link(record); this.drain(record);
    const exit = receipt(this.control(record.job.id) + '.exit.json');
    if (exit && exit.pid === record.job.pid && record.processStartedAt !== null && Math.abs(exit.startedAt - record.processStartedAt) <= 2000) { this.settle(record, exit.code, null); return; }
    const identity = this.identity(record);
    if (identity === 'dead') {
      try { this.drain(record, true); } catch { /* The record keeps what was readable. */ }
      record.job.status = 'interrupted'; record.job.finishedAt = Date.now();
      record.job.error = 'The original command process is gone; its exit result was not observed. Inspect the run ledger for settled work and billing.';
    } else {
      record.job.status = identity === 'alive' ? 'running' : 'starting';
      record.job.error = identity === 'alive' ? 'Command continues from an earlier panel session; this panel observes it and can request a stop.' : 'Process identity cannot yet be verified; no success, exit, or stop is assumed.';
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
    if (record.job.runId) {
      try {
        const path = join(runDirectory(record.projectPath, record.job.runId), 'control.json');
        const control = JSON.parse(readFileSync(path, 'utf8'));
        if (control.pid === record.job.pid && Math.abs(control.startedAt - (record.processStartedAt ?? 0)) <= 2000) {
          writeAtomic(join(dirname(path), 'stop-request.json'), JSON.stringify({ run: record.job.runId, requestedAt: Date.now(), ownerPid: control.pid, ownerStartedAt: control.startedAt }) + '\n'); return;
        }
      } catch { /* The stop file also covers early preflight, before a run id exists. */ }
    }
    const stop = this.control(record.job.id) + '.stop';
    if (!existsSync(stop)) writeAtomic(stop, JSON.stringify({ requestedAt: Date.now(), by: process.pid }) + '\n');
  }
  private tick(): void {
    if (this.closed) return;
    for (const record of this.records.values()) if (ACTIVE.has(record.job.status)) {
      try { if (this.owned.has(record.job.id)) {
        this.link(record); this.drain(record); if (record.stopRequested) this.requestStop(record);
      } else if (record.stopTarget) {
        const target = this.records.get(record.stopTarget);
        if (target && !ACTIVE.has(target.job.status)) { record.job.status = 'succeeded'; record.job.finishedAt = Date.now(); record.job.exitCode = 0; record.job.runId = target.job.runId; this.output(record, 'stdout', 'The owned command has settled.'); }
      } else this.observe(record); } catch (error) { record.job.error = this.clean('Job monitoring needs attention: ' + String(error)); }
    }
    if ([...this.records.values()].some(record => record.job.status === 'queued')) {
      try { withLedgerLock(this.storage, () => { this.load(); for (const row of this.records.values()) this.observe(row); this.schedule(); }); }
      catch (error) { for (const record of this.records.values()) if (record.job.status === 'queued') record.job.error = this.clean('Queue scheduling needs attention: ' + String(error)); }
    }
  }
  /** Launches queued paid commands in arrival order: one per project, at most `limit` at once. Callers hold the ledger lock. */
  private schedule(): void {
    if (this.closed) return;
    const rows = [...this.records.values()];
    const busy = new Set(rows.filter(row => MUTATING.has(row.job.action) && ACTIVE.has(row.job.status)).map(row => key(row.projectPath)));
    let running = busy.size;
    for (const record of rows.filter(row => row.job.status === 'queued').sort((a, b) => a.job.createdAt - b.job.createdAt)) {
      if (running >= this.concurrency) break;
      if (busy.has(key(record.projectPath))) continue;
      this.launch(record); busy.add(key(record.projectPath)); running += 1;
    }
  }
  private launch(record: Stored): void {
    let cwd: string;
    try {
      if (!record.argv) throw new ConfigError('the queued command has no recorded arguments');
      cwd = directory(record.projectPath);
    } catch (error) {
      record.job.status = 'failed'; record.job.finishedAt = Date.now(); record.job.error = this.clean(error instanceof Error ? error.message : String(error)); this.persist(record); return;
    }
    const control = this.control(record.job.id);
    const out = openSync(control + '.out.log', 'a'), err = openSync(control + '.err.log', 'a');
    let child: ChildProcess;
    try { child = spawn(process.execPath, [this.launcher, this.cliPath, control, ...record.argv], { cwd, env: this.env, shell: false, detached: true, windowsHide: true, stdio: ['ignore', out, err] }); }
    finally { closeSync(out); closeSync(err); }
    let finish!: () => void; const done = new Promise<void>(resolveDone => { finish = resolveDone; });
    this.owned.set(record.job.id, { child, done, finish });
    record.ownerPid = process.pid; record.ownerStartedAt = this.began; record.offsets ??= { stdout: 0, stderr: 0 };
    record.job.status = 'starting'; record.job.pid = child.pid ?? null; record.job.error = null; this.persist(record);
    child.on('error', error => { record.job.error = this.clean(error.message); });
    let observedExit = false;
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (observedExit) return;
      observedExit = true;
      if (this.owned.get(record.job.id)?.child === child) { this.settle(record, code, signal); this.owned.delete(record.job.id); }
      finish(); this.tick();
    };
    child.once('exit', settle); child.once('close', settle);
    const readiness = setInterval(() => {
      if (observedExit || record.processStartedAt !== null || this.closed) { clearInterval(readiness); return; }
      const ready = receipt(control + '.ready.json');
      if (!ready || ready.pid !== child.pid) return;
      clearInterval(readiness); record.processStartedAt = ready.startedAt; record.job.status = 'running';
      try { this.persist(record); if (record.stopRequested) this.requestStop(record); } catch (error) { record.job.error = this.clean('Could not persist command readiness: ' + String(error)); }
    }, 50); readiness.unref();
  }
  start(project: Pick<PanelProject, 'id' | 'name' | 'path'>, request: PanelJobRequest): PanelJob {
    if (this.closed) throw new ConfigError('the control panel is closing');
    const selected = { ...project, path: directory(project.path) };
    const argv = argumentsFor(request, selected);
    return withLedgerLock(this.storage, () => {
      this.load();
      for (const row of this.records.values()) this.observe(row);
      const record: Stored = { version: 1, projectPath: selected.path, processStartedAt: null, ownerPid: process.pid, ownerStartedAt: this.began, requestedRunId: request.runId, stopRequested: false, argv,
        job: { id: randomUUID(), projectId: selected.id, projectName: this.clean(selected.name), action: request.action, status: MUTATING.has(request.action) ? 'queued' : 'starting', createdAt: Date.now(), finishedAt: null, runId: request.action === 'stop' ? request.runId ?? null : null, exitCode: null, pid: null, output: [], error: null } };
      this.persist(record);
      if (request.action === 'stop') {
        const active = [...this.records.values()].filter(row => key(row.projectPath) === key(selected.path) && MUTATING.has(row.job.action) && ACTIVE.has(row.job.status));
        const target = active.find(row => request.runId === undefined || row.job.runId === request.runId || row.requestedRunId === request.runId);
        if (target && !request.force) {
          record.stopTarget = target.job.id; record.job.status = 'running'; this.persist(record);
          this.requestStop(target); this.output(record, 'stdout', 'Stop requested; waiting for the command and its billing to settle.');
          return structuredClone(record.job);
        }
      }
      if (MUTATING.has(request.action)) this.schedule(); else this.launch(record);
      return structuredClone(record.job);
    });
  }
  /** Removes a queued command before it starts. Running commands are stopped, never cancelled. */
  cancel(id: string): PanelJob {
    if (!ID.test(id)) throw new ConfigError('invalid job id');
    return withLedgerLock(this.storage, () => {
      this.load();
      const record = this.records.get(id);
      if (!record) throw new ConfigError('job not found');
      if (record.job.status !== 'queued') throw new ConfigError('only a queued command can be cancelled; stop a running command instead');
      record.job.status = 'cancelled'; record.job.finishedAt = Date.now(); record.job.error = null;
      this.output(record, 'stdout', 'Cancelled before it started.');
      return structuredClone(record.job);
    });
  }
  list(): PanelJob[] { this.load(); for (const row of this.records.values()) this.observe(row); this.tick(); return [...this.records.values()].map(row => structuredClone(row.job)).sort((a,b) => b.createdAt - a.createdAt); }
  get(id: string): PanelJob | undefined { if (!ID.test(id)) return undefined; return this.list().find(job => job.id === id); }
  /**
   * Lets go of owned commands: by default they continue detached and the
   * returned jobs are still active for the next panel to adopt. With `settle`,
   * every owned command is asked to stop and given a bounded grace period.
   */
  close(options: { settle?: boolean } = {}): Promise<PanelJob[]> {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.timer);
    this.closing = (async () => {
      if (options.settle) {
        for (const id of this.owned.keys()) { const record = this.records.get(id); if (record && ACTIVE.has(record.job.status)) this.requestStop(record); }
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([...this.owned.values()].map(task => task.done)),
            new Promise<never>((_, reject) => { deadline = setTimeout(() => {
              for (const id of this.owned.keys()) {
                const record = this.records.get(id);
                if (record) { record.job.error = 'Stop requested, but the command has not settled after 15 seconds; billing may still be pending.'; try { this.persist(record); } catch { /* Keep the truthful live record in memory. */ } }
              }
              reject(new ConfigError('owned commands have not settled; their active jobs and pending billing remain recorded'));
            }, 15000); }),
          ]);
        } finally { if (deadline !== undefined) clearTimeout(deadline); for (const task of this.owned.values()) task.child.unref(); }
      }
      const continuing: PanelJob[] = [];
      for (const [id, task] of this.owned) {
        const record = this.records.get(id);
        if (record && ACTIVE.has(record.job.status)) {
          try { this.drain(record); } catch { /* The next panel reads the rest. */ }
          record.job.error = 'Continues after the panel that started it; a restarted panel observes and can stop it.';
          try { this.persist(record); } catch { /* The launcher still writes its exit receipt. */ }
          continuing.push(structuredClone(record.job));
        }
        // Detach references, never kill. The CLI owns settlement; its output
        // and exit receipt live in files, so the next panel reads the truth.
        task.child.removeAllListeners('exit'); task.child.removeAllListeners('close'); task.child.unref();
      }
      return continuing;
    })();
    return this.closing;
  }
}
