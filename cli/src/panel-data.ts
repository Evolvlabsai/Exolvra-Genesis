import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { splitFrontmatter } from './agents.js';
import { ConfigError } from './exit.js';
import { goalsDir, listGoals } from './goals.js';
import { redactSecrets } from './github.js';
import { projectStatus } from './live-status.js';
import { loadPluginSources, PLUGIN_FILES } from './plugin-dir.js';
import { isRunId, readRuns, readState, runDirectory, settledIssueRun, type RunRecord, type StateReading } from './runs-store.js';
import { deriveLiveness, pidExists, readProcesses, readTrace, traceDirectory, type ProcessReading, type TraceRecord } from './trace-store.js';
import { plainText } from './usage.js';
import type { PanelAgent, PanelEvent, PanelProject, PanelRun, PanelRunDetail } from './panel-types.js';

export type PanelProjectSource = Pick<PanelProject, 'id' | 'name' | 'path'>;
const roots = new WeakMap<PanelProjectSource, string>();
const MAX_PAGE = 1000;
const artifactFiles: Record<string, string> = { 'progress.html': 'progress.html', 'BAR.md': 'bar/BAR.md', 'bar.sha256': 'bar/bar.sha256' };
const sensitiveKey = /(?:token|secret|password|passwd|api[-_]?key|authorization|private[-_]?key|credential)/i;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Redaction also applies to old ledgers and traces written before the funnel. */
export function scrubPanelText(value: string, env: NodeJS.ProcessEnv = process.env, maxLength = 16_384): string {
  const fold = (text: string): string => text.normalize('NFKC').replace(/\r\n?/g, '\n').split('\n').map(plainText).join('\n').replace(/\p{Bidi_Control}/gu, '');
  let clean = fold(value);
  for (const [key, secret] of Object.entries(env)) {
    if (!sensitiveKey.test(key) || !secret || secret.length < 6) continue;
    const normalized = fold(secret);
    if (normalized.length >= 6) clean = clean.split(normalized).join('[redacted]');
  }
  clean = redactSecrets(clean)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[redacted]')
    .replace(/(\b(?:authorization\s*[:=]\s*)?bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[redacted]')
    .replace(/((?:api[-_]?key|password|passwd|access[-_]?token|secret)\s*[:=]\s*["']?)[^\s,"';]+/gi, '$1[redacted]');
  return clean.length > maxLength ? clean.slice(0, maxLength) + '…' : clean;
}

export function scrubPanelValue(value: unknown, env: NodeJS.ProcessEnv = process.env, depth = 0): unknown {
  if (typeof value === 'string') return scrubPanelText(value, env);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth > 10) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 1000).map((entry) => scrubPanelValue(entry, env, depth + 1));
  if (typeof value === 'object') {
    const clean: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value).slice(0, 1000)) {
      clean[scrubPanelText(key, env, 200)] = sensitiveKey.test(key) && !/^(?:inputTokens|outputTokens|tokens|input_tokens|output_tokens)$/i.test(key)
        ? '[redacted]' : scrubPanelValue(entry, env, depth + 1);
    }
    return clean;
  }
  return null;
}

export function panelProjectPath(project: PanelProjectSource): string { return roots.get(project) ?? resolve(project.path); }
const projectRoot = panelProjectPath;

function validateProjectMetadata(cwd: string): void {
  try {
    const expected = resolve(cwd), actual = realpathSync(expected);
    const equal = process.platform === 'win32' ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
    if (!equal || lstatSync(expected).isSymbolicLink() || !statSync(expected).isDirectory()) throw new Error('replaced root');
  } catch { throw new ConfigError('registered project directory is unavailable or now traverses a symbolic link'); }
  runDirectory(cwd, 'panel-read-check');
  for (const file of ['runs.json', 'state.json']) {
    const path = join(cwd, '.exolvra-genesis', file);
    if (existsSync(path) && safeFile(cwd, path) === undefined) throw new ConfigError('project metadata must be a regular file inside the project: ' + file);
  }
}

/** Reject every symlink component, including a directory containing the file. */
function safeFile(root: string, target: string): string | undefined {
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return undefined;
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) return undefined; } catch { return undefined; }
  }
  try {
    if (!statSync(target).isFile()) return undefined;
    const actual = relative(realpathSync(root), realpathSync(target));
    return actual !== '..' && !actual.startsWith('..' + sep) && !isAbsolute(actual) ? target : undefined;
  } catch { return undefined; }
}

export function safePanelArtifactPath(project: PanelProjectSource, runId: string, name: string): string | undefined {
  if (!isRunId(runId) || !Object.hasOwn(artifactFiles, name)) return undefined;
  const cwd = projectRoot(project);
  try { validateProjectMetadata(cwd); } catch { return undefined; }
  const relativeFile = artifactFiles[name]!;
  let root: string;
  try { root = runDirectory(cwd, runId); } catch { return undefined; }
  const current = safeFile(cwd, join(root, relativeFile));
  if (current) return current;
  // Legacy artifacts have one owner: the active state pointer.
  return readState(cwd).run === runId ? safeFile(cwd, join(cwd, '.exolvra-genesis', relativeFile)) : undefined;
}

function readableTrace(cwd: string, id: string): { present: boolean; safe: boolean } {
  try {
    const dir = traceDirectory(cwd, id);
    const candidates = [join(dir, id + '.db'), join(dir, id + '.ndjson')];
    const present = candidates.filter((path) => existsSync(path));
    return { present: present.length > 0, safe: present.every((path) => safeFile(cwd, path) !== undefined) };
  } catch { return { present: false, safe: false }; }
}

interface TraceSummary {
  present: boolean; degraded: boolean; cursor: number; firstSeq: number; rounds: number; latestAt: number; finishedAt: number | null;
  cost: number | null; input: number | null; output: number | null; phase: string | null;
  budget: Record<string, unknown> | undefined; tail: TraceRecord[];
  pieces: Map<string, { id: string; round: number; verdict: string | null; costUsd: number | null }>;
}
const summaries = new Map<string, { signature: string; summary: TraceSummary }>();

function traceSignature(cwd: string, id: string): string {
  const dir = traceDirectory(cwd, id);
  return ['.db', '.db-wal', '.ndjson'].map((suffix) => {
    try { const stat = statSync(join(dir, id + suffix)); return suffix + ':' + stat.size + ':' + stat.mtimeMs; }
    catch { return suffix + ':absent'; }
  }).join('|');
}

/** Scan every receipt, retaining only bounded output; finished totals are checkpoints, not extra bills. */
function summarizeTrace(cwd: string, id: string, tailLimit = 0, tailBefore = Infinity): TraceSummary {
  const safety = readableTrace(cwd, id);
  const cacheKey = cwd + '\0' + id + '\0' + tailBefore;
  const signature = safety.safe && safety.present ? traceSignature(cwd, id) : '';
  const cached = summaries.get(cacheKey);
  if (signature && cached?.signature === signature) return { ...cached.summary, tail: tailLimit > 0 ? cached.summary.tail.slice(-tailLimit) : [] };
  const result: TraceSummary = { present: safety.present, degraded: !safety.safe, cursor: 0, firstSeq: 0, rounds: 0, latestAt: 0, finishedAt: null,
    cost: null, input: null, output: null, phase: null, budget: undefined, tail: [], pieces: new Map() };
  if (!safety.safe || !safety.present) return result;
  let inputReceipts = 0, outputReceipts = 0;
  for (;;) {
    const previousCursor = result.cursor;
    const batch = readTrace(cwd, id, result.cursor, MAX_PAGE);
    result.degraded ||= batch.degraded;
    for (const event of batch.records) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= result.cursor || event.runId !== id) continue;
      result.cursor = event.seq;
      if (result.firstSeq === 0) result.firstSeq = event.seq;
      result.latestAt = Math.max(result.latestAt, number(event.at) ?? 0);
      const payload = object(event.payload) ?? {};
      if (event.kind === 'budget_spend') {
        const cost = number(payload['costUsd']);
        if (cost !== null) result.cost = (result.cost ?? 0) + cost;
        const input = number(payload['inputTokens']), output = number(payload['outputTokens']);
        if (input !== null) { inputReceipts += input; result.input = Math.max(result.input ?? 0, inputReceipts); }
        if (output !== null) { outputReceipts += output; result.output = Math.max(result.output ?? 0, outputReceipts); }
      }
      if (event.kind === 'run_finished') {
        result.finishedAt = number(event.at);
        const total = number(payload['costUsd']);
        if (total !== null) result.cost = Math.max(result.cost ?? 0, total);
      }
      if (event.kind === 'run_started') result.finishedAt = null;
      if (event.kind === 'verdict_recorded') result.rounds += 1;
      const budget = object(payload['budget']);
      if (budget) result.budget = budget;
      if (event.kind === 'activity') {
        if (typeof payload['phase'] === 'string') result.phase = payload['phase'];
        const tokens = object(payload['tokens']);
        const input = number(tokens?.['inputTokens']), output = number(tokens?.['outputTokens']);
        if (input !== null) result.input = Math.max(result.input ?? 0, input);
        if (output !== null) result.output = Math.max(result.output ?? 0, output);
      }
      const piece = typeof event.piece === 'string' ? event.piece : event.kind === 'piece_dispatched' && typeof payload['pieceId'] === 'string' ? payload['pieceId'] : null;
      if (piece !== null && piece !== 'preflight' && (result.pieces.has(piece) || result.pieces.size < 1000)) {
        const entry = result.pieces.get(piece) ?? { id: scrubPanelText(piece), round: 0, verdict: null, costUsd: null };
        if (number(event.round) !== null) entry.round = event.round!;
        if (event.kind === 'verdict_recorded' && typeof payload['verdict'] === 'string') entry.verdict = scrubPanelText(payload['verdict']);
        if (event.kind === 'budget_spend' && payload['attribution'] === 'round' && number(payload['costUsd']) !== null) entry.costUsd = (entry.costUsd ?? 0) + Number(payload['costUsd']);
        result.pieces.set(piece, entry);
      }
      if (event.seq < tailBefore) { result.tail.push(event); if (result.tail.length > MAX_PAGE + 1) result.tail.shift(); }
    }
    if (batch.degraded || batch.records.length < MAX_PAGE || batch.cursor <= previousCursor) break;
    // Malformed old records must not stall the cursor or make this reader loop forever.
    if (batch.cursor > result.cursor) result.cursor = batch.cursor;
    if (batch.records.length === 0) break;
  }
  // Shared by overview run rows, event feed and detail requests. A changed WAL
  // or NDJSON invalidates it; readers never persist this disposable cache.
  if (!result.degraded && signature === traceSignature(cwd, id)) {
    if (summaries.size >= 128) summaries.delete(summaries.keys().next().value!);
    summaries.set(cacheKey, { signature, summary: result });
  }
  return { ...result, tail: tailLimit > 0 ? result.tail.slice(-tailLimit) : [] };
}

function safeProcesses(cwd: string, id: string, summary: TraceSummary): ProcessReading {
  if (summary.degraded || !summary.present) return { processes: [], degraded: summary.degraded };
  const reading = readProcesses(cwd, id);
  const valid = reading.processes.filter((p) => p.runId === id && typeof p.taskId === 'string' && ['lead', 'builder', 'critic'].includes(p.role) && number(p.openedAt) !== null);
  return { degraded: reading.degraded || valid.length !== reading.processes.length, processes: valid.map((p) => ({ ...p,
    piece: typeof p.piece === 'string' ? p.piece : null, round: number(p.round), closedAt: number(p.closedAt),
    outcome: p.outcome === 'complete' || p.outcome === 'failed' || p.outcome === 'died' ? p.outcome : null,
    pid: Number.isSafeInteger(p.pid) && Number(p.pid) > 0 ? p.pid : null })) };
}

function ownerPid(cwd: string, run: RunRecord, state: StateReading): number | null {
  const file = safeFile(cwd, join(runDirectory(cwd, run.id), 'control.json'));
  if (file) {
    try {
      const owner = JSON.parse(readFileSync(file, 'utf8'));
      if (owner.run === run.id && Number.isSafeInteger(owner.pid) && owner.pid > 0) return owner.pid;
    } catch { /* The trace/state may still know the owner. */ }
  }
  return state.run === run.id && state.pid !== undefined ? state.pid : null;
}

function panelRun(project: PanelProjectSource, row: RunRecord, state: StateReading, summary: TraceSummary,
  liveRow?: ReturnType<typeof projectStatus>[number]): PanelRun {
  const cwd = projectRoot(project), processes = safeProcesses(cwd, row.id, summary);
  const status = state.run === row.id && state.status !== undefined ? state.status : row.status;
  let live = liveRow?.live ?? deriveLiveness(processes, status);
  const pid = ownerPid(cwd, row, state);
  if (status === 'running' && live === '?' && pid !== null) {
    if (!pidExists(pid)) live = 'died';
    // A live PID alone does not identify the old owner; preserve unknown without a matching trace.
  }
  const otherOwns = state.run !== undefined && state.run !== row.id && (state.status === 'running' || state.status === 'blocked') && !settledIssueRun(cwd, state.run);
  const resumableStatus = row.status !== 'complete' && status !== 'complete' && (status !== 'running' || ((live === 'died' || live === '-') && (pid === null || !pidExists(pid))));
  const latestClosed = Math.max(0, ...processes.processes.map((p) => p.closedAt ?? 0));
  const cost = Math.max(summary.cost ?? -1, row.costUsd ?? -1);
  return {
    id: scrubPanelText(row.id), projectId: scrubPanelText(project.id), projectName: scrubPanelText(project.name), input: scrubPanelText(row.input), status,
    phase: status === 'running' ? scrubPanelText(liveRow?.phase ?? summary.phase ?? 'unknown') : status,
    live, stalled: status === 'running' && live !== 'died' && (liveRow?.stalled === true || liveRow?.processes.some((p) => p.stalled) === true),
    startedAt: row.startedAt, finishedAt: status === 'running' ? null : summary.finishedAt ?? (latestClosed || null),
    updatedAt: summary.latestAt || Date.parse(row.startedAt), costUsd: cost < 0 ? null : cost,
    rounds: Math.max(row.rounds ?? 0, summary.rounds), lastVerdict: row.lastVerdict === undefined ? null : scrubPanelText(row.lastVerdict),
    models: { lead: scrubPanelText(row.models.lead), builder: scrubPanelText(row.models.builder), critic: scrubPanelText(row.models.critic) },
    tokens: summary.input === null && summary.output === null ? null : { input: summary.input ?? 0, output: summary.output ?? 0 },
    source: summary.present && !summary.degraded && (summary.cursor > 0 || processes.processes.length > 0) ? 'trace' : 'last written',
    canResume: Boolean(row.sessionId) && resumableStatus && !otherOwns,
    canStop: (row.status === 'running' || row.status === 'blocked') && !settledIssueRun(cwd, row.id) && ((status === 'running' && (pid !== null || processes.processes.some((p) => p.role === 'lead' && p.pid !== null))) || (status === 'blocked' && state.run === row.id)),
    maxCostUsd: number(summary.budget?.['maxCostUsd']), maxRounds: number(summary.budget?.['maxRounds']),
  };
}

export function readPanelProject(input: { id: string; name: string; path: string }): PanelProject {
  const cwd = resolve(input.path);
  try { if (!statSync(cwd).isDirectory()) throw new Error('not a directory'); } catch { throw new ConfigError('project directory is unavailable: ' + scrubPanelText(cwd)); }
  validateProjectMetadata(cwd);
  const goalsPath = goalsDir(cwd);
  if (existsSync(goalsPath)) {
    if (lstatSync(goalsPath).isSymbolicLink()) throw new ConfigError('project goals must not traverse a symbolic link');
    for (const entry of readdirSync(goalsPath)) {
      if (entry.endsWith('.md') && lstatSync(join(goalsPath, entry)).isSymbolicLink()) throw new ConfigError('project goal must not traverse a symbolic link');
    }
  }
  const rows = readRuns(cwd), state = readState(cwd);
  const project: PanelProject = { id: scrubPanelText(input.id), name: scrubPanelText(input.name), path: scrubPanelText(cwd), runCount: rows.length,
    activeCount: rows.filter((r) => (state.run === r.id ? state.status ?? r.status : r.status) === 'running').length,
    goals: listGoals(cwd).map((goal) => ({ name: scrubPanelText(goal.name), description: scrubPanelText(goal.description) })), error: null };
  roots.set(project, cwd);
  return project;
}

export function readPanelRuns(project: PanelProjectSource): PanelRun[] {
  const cwd = projectRoot(project);
  validateProjectMetadata(cwd);
  const state = readState(cwd), rows = readRuns(cwd);
  // Do not let the existing live reader follow a legacy trace symlink.
  const allSafe = rows.every((row) => readableTrace(cwd, row.id).safe);
  const live = allSafe ? projectStatus(cwd) : [];
  return rows.map((row) => panelRun(project, row, state, summarizeTrace(cwd, row.id), live.find((r) => r.id === row.id)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
}

function panelEvent(project: PanelProjectSource, event: TraceRecord): PanelEvent {
  const payload = scrubPanelValue(object(event.payload) ?? {}) as Record<string, unknown>;
  const detail = ['detail', 'gap', 'goal', 'title', 'fault', 'verdict', 'action'].map((key) => payload[key]).find((value) => typeof value === 'string');
  const kind = typeof event.kind === 'string' ? scrubPanelText(event.kind) : 'unknown';
  return { seq: event.seq, at: number(event.at) ?? 0, runId: scrubPanelText(event.runId), projectId: scrubPanelText(project.id), kind,
    piece: typeof event.piece === 'string' ? scrubPanelText(event.piece) : null, round: number(event.round), payload,
    summary: scrubPanelText(kind.replaceAll('_', ' ') + (detail ? ': ' + detail : ''), process.env, 320) };
}

function bounded(value: number, fallback: number): number { return Number.isFinite(value) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(value))) : fallback; }

export function readPanelRunDetail(project: PanelProjectSource, id: string, after?: number, limit = 200, before?: number): PanelRunDetail {
  const cwd = projectRoot(project);
  validateProjectMetadata(cwd);
  if (!isRunId(id)) throw new ConfigError('invalid run id');
  const row = readRuns(cwd).find((record) => record.id === id);
  if (!row) throw new ConfigError('no run is recorded as ' + scrubPanelText(id));
  const size = bounded(limit, 200), earlier = before !== undefined && Number.isSafeInteger(before) && before >= 0 ? before : undefined;
  const summary = summarizeTrace(cwd, id, after === undefined || earlier !== undefined ? size + 1 : 0, earlier), state = readState(cwd);
  const cursor = after !== undefined && Number.isSafeInteger(after) && after >= 0 ? after : 0;
  const tail = after === undefined || earlier !== undefined;
  const batch = summary.degraded || !summary.present ? { records: [], cursor, degraded: summary.degraded }
    : tail ? { records: summary.tail.slice(-size), cursor: summary.cursor, degraded: false } : readTrace(cwd, id, cursor, size + 1);
  const records = batch.records.filter((event) => event.runId === id && Number.isSafeInteger(event.seq) && event.seq > cursor);
  const events = records.slice(0, size).map((event) => panelEvent(project, event));
  const processes = safeProcesses(cwd, id, summary);
  const allSafe = readRuns(cwd).every((record) => readableTrace(cwd, record.id).safe);
  const live = allSafe ? projectStatus(cwd).find((entry) => entry.id === id) : undefined;
  const warnings: string[] = [];
  if (!summary.present) warnings.push('Trace unavailable; showing last written ledger data.');
  if (summary.degraded || batch.degraded || processes.degraded) warnings.push('Trace could not be read completely; some activity and usage are unavailable.');
  if ([...summary.pieces.values()].some((piece) => piece.costUsd === null)) warnings.push('Local nested agents have no separate provider bill; per-piece cost is unavailable.');
  const last = events.at(-1)?.seq ?? cursor, first = events[0]?.seq ?? 0;
  return { run: panelRun(project, row, state, summary, live), events, cursor: last, oldestCursor: first,
    hasEarlier: first > summary.firstSeq && summary.firstSeq > 0, hasMore: last < summary.cursor,
    degraded: summary.degraded || batch.degraded || processes.degraded || !summary.present,
    processes: processes.processes.slice(0, 1000).map((p) => ({ taskId: scrubPanelText(p.taskId), role: scrubPanelText(p.role), piece: p.piece === null ? null : scrubPanelText(p.piece),
      round: number(p.round), openedAt: p.openedAt, closedAt: p.closedAt, outcome: p.outcome, pid: p.pid })),
    pieces: [...summary.pieces.values()], artifacts: Object.keys(artifactFiles).filter((name) => safePanelArtifactPath(project, id, name)).map((name) => ({ name,
      kind: name.endsWith('.html') ? 'html' : name.endsWith('.md') ? 'markdown' : 'text', url: '/api/artifacts/' + encodeURIComponent(scrubPanelText(project.id)) + '/' + encodeURIComponent(scrubPanelText(id)) + '/' + encodeURIComponent(name) })), warnings };
}

export function readPanelEvents(projects: PanelProjectSource[], limit = 100): PanelEvent[] {
  const size = bounded(limit, 100);
  let events: PanelEvent[] = [];
  for (const project of projects) {
    try {
      validateProjectMetadata(projectRoot(project));
      for (const row of readRuns(projectRoot(project))) {
        events.push(...summarizeTrace(projectRoot(project), row.id, size).tail.map((event) => panelEvent(project, event)));
        events.sort((a, b) => b.at - a.at || b.seq - a.seq || a.projectId.localeCompare(b.projectId) || a.runId.localeCompare(b.runId));
        events = events.slice(0, size);
      }
    } catch { /* The overview reports this project's own read error separately. */ }
  }
  return events;
}

export function readPanelAgents(env: NodeJS.ProcessEnv): PanelAgent[] {
  const sources = loadPluginSources(env);
  const files = [{ role: 'lead', path: PLUGIN_FILES.runMd }, { role: 'builder', path: PLUGIN_FILES.builderMd }, { role: 'critic', path: PLUGIN_FILES.criticMd },
    { role: 'auditor', path: 'agents/usability-auditor.md' }];
  return files.flatMap(({ role, path }) => {
    const file = safeFile(sources.dir, join(sources.dir, path));
    if (!file) return [];
    const parsed = splitFrontmatter(readFileSync(file, 'utf8'));
    const tools = (parsed.fields['tools'] ?? parsed.fields['allowed-tools'] ?? '').replace(/^\[|\]$/g, '').split(',').map((tool) => tool.trim()).filter(Boolean);
    return [{ id: role, name: scrubPanelText(parsed.fields['name'] ?? (role === 'lead' ? 'Lead' : role), env), role,
      description: scrubPanelText(parsed.fields['description'] ?? '', env), model: scrubPanelText(parsed.fields['model'] ?? 'inherit', env), source: path,
      tools: tools.map((tool) => scrubPanelText(tool, env)), prompt: scrubPanelText(parsed.body, env, 100_000) }];
  });
}
