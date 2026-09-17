import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { reportChecks, verdictChecks, reportFindings, fingerprintRound, findingSignals, type FindingRound, type GateCheck } from './consistency.js';
import { enforceOwnership, snapshotOwnership, assertDisjoint, candidateFingerprint, type OwnershipSnapshot } from './ownership.js';
import { runDirectory, writeAtomic } from './runs-store.js';
import type { TraceStore } from './trace-store.js';
import { toRecord } from './trace-events.js';
import { ConfigError } from './exit.js';

export interface Task { piece: string; files: string[]; verify: string; scratch?: string[] }
interface Builder { session: string | null; model: string; rounds: number; poisoned: boolean; sessionRounds?: number; lastPoisonRound?: number }
interface Active { task: Task; snapshot: OwnershipSnapshot; model: string; protected: Map<string, string | undefined> }
interface Critic { piece: string; round: number }
interface JudgedRound extends FindingRound { round: number }
const cleanups = new WeakMap<object, () => void>();
export function settleRoundGuards(hooks: Options['hooks']): void {
  if (hooks !== undefined) cleanups.get(hooks)?.();
}

/** Transport metadata lives in the Task prompt; the Task Spec remains the contract. */
function taskFrom(prompt: string): Task | undefined {
  const block = prompt.match(/```genesis-task\s*\n([\s\S]*?)\n```/);
  if (!block) return undefined;
  try {
    const value = JSON.parse(block[1]!) as Task;
    if (!/^[a-zA-Z0-9][\w.-]{0,63}$/.test(value.piece) || !Array.isArray(value.files) || value.files.length === 0 || !value.files.every((v) => typeof v === 'string') || typeof value.verify !== 'string' || !value.verify.trim()) return undefined;
    if (value.scratch !== undefined && (!Array.isArray(value.scratch) || !value.scratch.every((v) => typeof v === 'string'))) return undefined;
    return value;
  } catch { return undefined; }
}

function responseText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(responseText).join('\n');
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return responseText(object['content'] ?? object['text'] ?? object['output'] ?? '');
  }
  return '';
}

function criticFrom(prompt: string): Critic | undefined {
  try {
    const value = JSON.parse(prompt.match(/```genesis-critic\s*\n([\s\S]*?)\n```/)?.[1] ?? 'null') as Critic | null;
    return value && /^[a-zA-Z0-9][\w.-]{0,63}$/.test(value.piece) && Number.isSafeInteger(value.round) && value.round > 0 ? value : undefined;
  } catch { return undefined; }
}

export function readOwnershipPlan(cwd: string, runId: string): Task[] {
  const path = join(runDirectory(cwd, runId), 'ownership-plan.json');
  if (!existsSync(path)) throw new ConfigError('write ownership-plan.json with every piece\'s genesis-task metadata at decomposition, before the first builder dispatch');
  let rows: unknown;
  try { rows = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new ConfigError('ownership-plan.json is not readable JSON'); }
  if (!Array.isArray(rows) || rows.length === 0) throw new ConfigError('ownership-plan.json must be a nonempty list of task metadata');
  const plan = rows.map((row) => taskFrom('```genesis-task\n' + JSON.stringify(row) + '\n```'));
  if (plan.some((row) => row === undefined)) throw new ConfigError('ownership-plan.json contains invalid task metadata');
  const tasks = plan as Task[];
  if (new Set(tasks.map((t) => t.piece)).size !== tasks.length) throw new ConfigError('ownership-plan.json repeats a piece');
  assertDisjoint(tasks.map((t) => ({ id: t.piece, files: t.files })));
  return tasks;
}

export function assertPlannedTask(plan: readonly Task[], task: Task): void {
  const planned = plan.find((row) => row.piece === task.piece);
  if (!planned || JSON.stringify(planned.files) !== JSON.stringify(task.files) || planned.verify !== task.verify || JSON.stringify(planned.scratch ?? []) !== JSON.stringify(task.scratch ?? [])) throw new ConfigError('Task ownership or verification differs from the decomposition plan for ' + task.piece + '; no builder was dispatched.');
}

export function createRoundGuards(cwd: string, runId: string, builderModel: string, trace?: TraceStore): NonNullable<Options['hooks']> {
  const root = runDirectory(cwd, runId), mapPath = join(root, 'builders.json');
  let builders: Record<string, Builder> = {};
  if (existsSync(mapPath)) {
    const value: unknown = JSON.parse(readFileSync(mapPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid builder map');
    for (const [piece, row] of Object.entries(value)) {
      const b = row as Builder;
      if (!b || (b.session !== null && typeof b.session !== 'string') || typeof b.model !== 'string' || !Number.isSafeInteger(b.rounds) || typeof b.poisoned !== 'boolean') throw new Error('invalid builder record: ' + piece);
      builders[piece] = b;
    }
  }
  const active = new Map<string, Active>();
  const critics = new Map<string, Critic>();
  const corrections = new Map<string, OwnershipSnapshot>();
  const ownershipPath = join(root, 'ownership.json'), findingsPath = join(root, 'findings.json');
  const ownership = new Map<string, Task>();
  if (existsSync(ownershipPath)) {
    for (const value of JSON.parse(readFileSync(ownershipPath, 'utf8')) as unknown[]) {
      const task = taskFrom('```genesis-task\n' + JSON.stringify(value) + '\n```');
      if (!task) throw new ConfigError('invalid persisted task ownership');
      ownership.set(task.piece, task);
    }
    assertDisjoint([...ownership.values()].map((task) => ({ id: task.piece, files: task.files })));
  }
  let planLoaded = ownership.size > 0;
  const loadPlan = (): void => {
    if (planLoaded) return;
    const tasks = readOwnershipPlan(cwd, runId);
    for (const task of tasks) ownership.set(task.piece, task);
    writeAtomic(ownershipPath, JSON.stringify(tasks, null, 2) + '\n');
    planLoaded = true;
  };
  let findings: Record<string, JudgedRound[]> = {};
  if (existsSync(findingsPath)) {
    findings = JSON.parse(readFileSync(findingsPath, 'utf8')) as Record<string, JudgedRound[]>;
    if (!findings || typeof findings !== 'object' || Array.isArray(findings) || Object.values(findings).some((rows) => !Array.isArray(rows) || rows.some((r) => !r || !Number.isSafeInteger(r.round) || typeof r.diff !== 'string' || !Array.isArray(r.fingerprints) || r.fingerprints.some((f) => typeof f !== 'string')))) throw new ConfigError('invalid persisted finding history');
  }
  const attempts = new Map<string, number>();
  const log = (event: unknown): void => {
    const fields = event as { kind: string; piece?: string; round?: number; checks?: GateCheck[]; violations?: string[] };
    const round = fields.round ?? (fields.piece ? builders[fields.piece]?.rounds : undefined);
    const recorded = { ...fields, round: round ?? null };
    // The same recursive sanitizer protects the durable round log and trace.
    const entry = toRecord({ kind: 'activity', piece: fields.piece, round, payload: { detail: JSON.stringify(recorded) } }, { runId });
    appendFileSync(join(root, 'round-log.ndjson'), JSON.stringify(entry) + '\n');
    if ((fields.kind === 'ownership' || fields.kind === 'ownership-on-session-end') && trace) {
      const observation = event as { touched: string[]; restored: string[]; violations: string[] };
      trace.append(toRecord({ kind: 'activity', piece: fields.piece, round, payload: {
        detail: 'File changes observed by ownership snapshot', evidence: {
          type: 'file_changes', source: 'ownership-snapshot', files: observation.touched,
          restored: observation.restored, violations: observation.violations,
        },
      } }, { runId }));
    }
    if (fields.checks) for (const check of fields.checks) trace?.append(toRecord({ kind: 'gate_check', piece: fields.piece, round, payload: { gate: check.name, passed: check.passed, detail: check.checked + (check.violation ? ': ' + check.violation : '') } }, { runId }));
    else if (fields.violations) trace?.append(toRecord({ kind: 'gate_check', piece: fields.piece, round, payload: { gate: 'ownership', passed: fields.violations.length === 0, detail: JSON.stringify(recorded) } }, { runId }));
    else trace?.append(toRecord({ kind: 'activity', piece: fields.piece, round, payload: { detail: JSON.stringify(recorded) } }, { runId }));
  };
  const persist = (): void => writeAtomic(mapPath, JSON.stringify(builders, null, 2) + '\n');
  const protectedPaths = [mapPath, ownershipPath, findingsPath, join(root, 'ownership-plan.json')];
  const repairProtected = (entry: Active): string[] => {
    const violations: string[] = [];
    for (const [path, before] of entry.protected) {
      let changed = existsSync(path) !== (before !== undefined);
      try { if (!changed && before !== undefined) changed = readFileSync(path, 'utf8') !== before; } catch { changed = true; }
      if (changed) {
        if (before === undefined) rmSync(path, { force: true });
        else writeAtomic(path, before);
        violations.push(path + ' (trusted run contract changed; restored from memory)');
      }
    }
    return violations;
  };
  const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } });
  const pre: HookCallback = async (input, toolId) => {
    if (input.hook_event_name !== 'PreToolUse' || !['Task', 'Agent'].includes(input.tool_name)) return {};
    const args = input.tool_input as Record<string, unknown>;
    const role = String(args['subagent_type'] ?? '');
    if (role.includes('critic')) {
      if (active.size) return deny('Wait for the active builder to finish before judging its fixed candidate.');
      if (args['resume']) return deny('Critics always start with a fresh context. Remove resume.');
      const critic = criticFrom(String(args['prompt'] ?? ''));
      if (!critic) return deny('Critic transport needs a genesis-critic block with piece and round. It carries identity only, never builder context.');
      if (corrections.has(critic.piece)) return deny('Correct the builder report for ' + critic.piece + ' before spending a critic round.');
      critics.set(toolId ?? input.tool_use_id, critic);
      return {};
    }
    if (!role.includes('builder')) return {};
    const task = taskFrom(String(args['prompt'] ?? ''));
    if (!task) return deny('The builder Task Spec needs a genesis-task block with piece, files and verify. No builder was dispatched.');
    if ([...attempts.keys()].some((key) => key.startsWith('critic:' + task.piece + ':'))) return deny('Correct the inconsistent critic verdict for ' + task.piece + ' before changing the candidate.');
    if (active.size > 0 || critics.size > 0) return deny('A guarded builder or critic still owns this candidate. Wait for its report before dispatching this builder.');
    try {
      loadPlan();
      assertPlannedTask([...ownership.values()], task);
    } catch (error) { return deny(error instanceof Error ? error.message : String(error)); }
    const history = findings[task.piece] ?? [];
    const signals = findingSignals(history);
    if (signals.includes('duplicate-round') && history.at(-1)?.diff === fingerprintRound([], candidateFingerprint(cwd, task.scratch)).diff) {
      log({ kind: 'duplicate-builder-suppressed', piece: task.piece });
      return deny('Duplicate findings over an unchanged candidate: do not dispatch another builder for this round. Reconcile the duplicate with the lead before proceeding.');
    }
    const incumbent = builders[task.piece];
    if (signals.includes('see-saw') && findingSignals(history.slice(0, -1)).includes('see-saw') && incumbent && (incumbent.sessionRounds ?? incumbent.rounds) >= 2 && incumbent.lastPoisonRound !== history.at(-1)?.round) {
      incumbent.poisoned = true; incumbent.lastPoisonRound = history.at(-1)!.round;
    }
    try {
      const proposed = new Map(ownership); proposed.set(task.piece, task);
      assertDisjoint([...proposed.values()].map((t) => ({ id: t.piece, files: t.files })));
      const snapshot = corrections.get(task.piece) ?? snapshotOwnership(cwd, task.scratch);
      active.set(toolId ?? input.tool_use_id, { task, snapshot, model: String(args['model'] ?? builderModel), protected: new Map() });
      ownership.set(task.piece, task);
      writeAtomic(ownershipPath, JSON.stringify([...ownership.values()], null, 2) + '\n');
    } catch (error) { return deny(error instanceof Error ? error.message : String(error)); }
    const model = String(args['model'] ?? builderModel), previous = builders[task.piece];
    const reason = previous === undefined ? 'first-round' : previous.poisoned ? 'poisoned-context' : previous.model !== model ? 'model-change' : previous.session === null ? 'dead-or-unavailable-session' : undefined;
    const session = reason === undefined ? previous?.session : undefined;
    builders[task.piece] = { session: session ?? null, model, rounds: (previous?.rounds ?? 0) + (corrections.has(task.piece) ? 0 : 1), poisoned: false, sessionRounds: session ? (previous?.sessionRounds ?? previous?.rounds ?? 0) + (corrections.has(task.piece) ? 0 : 1) : 1, ...(previous?.lastPoisonRound === undefined ? {} : { lastPoisonRound: previous.lastPoisonRound }) };
    persist();
    for (const path of protectedPaths) active.get(toolId ?? input.tool_use_id)!.protected.set(path, existsSync(path) ? readFileSync(path, 'utf8') : undefined);
    log({ kind: 'builder-start', piece: task.piece, continuation: Boolean(session), correction: corrections.has(task.piece), reason: reason ?? null, model, signals });
    const updated = { ...args };
    if (session) updated['resume'] = session;
    else delete updated['resume'];
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } };
  };
  const post: HookCallback = async (input, toolId) => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') return {};
    const id = toolId ?? input.tool_use_id, entry = active.get(id);
    const critic = critics.get(id); critics.delete(id);
    const args = input.tool_input as Record<string, unknown>;
    const text = input.hook_event_name === 'PostToolUse' ? responseText(input.tool_response) : input.error;
    let checks: GateCheck[] = [];
    if (entry !== undefined) {
      active.delete(id);
      const result = enforceOwnership(entry.snapshot, entry.task.files);
      result.violations.push(...repairProtected(entry));
      log({ kind: 'ownership', piece: entry.task.piece, ...result });
      const builder = builders[entry.task.piece]!;
      if (result.violations.length) {
        corrections.delete(entry.task.piece);
        builder.poisoned = true; builder.session = null; persist();
        return { continue: false, stopReason: 'Ownership breach aborted this round: ' + result.violations.join(', ') + '. ' + result.unrecoverable.join('; ') };
      }
      if (input.hook_event_name === 'PostToolUseFailure') {
        corrections.delete(entry.task.piece);
        builder.session = null; persist();
        log({ kind: 'cold-start-required', piece: entry.task.piece, reason: 'dead-session' });
        return {};
      }
      const response = input.tool_response as Record<string, unknown> | null;
      const session = response && typeof response === 'object' ? response['agentId'] ?? response['agent_id'] : undefined;
      builder.session = typeof session === 'string' ? session : text.match(/agentId:\s*([\w.-]+)/)?.[1] ?? null;
      persist();
      checks = reportChecks(cwd, text, entry.task.verify, result.touched);
    } else if (String(args['subagent_type'] ?? '').includes('critic') && input.hook_event_name === 'PostToolUse') {
      checks = verdictChecks(text);
    }
    if (checks.length === 0) return {};
    log({ kind: 'consistency', piece: entry?.task.piece ?? critic?.piece ?? null, round: critic?.round, checks });
    const violations = checks.filter((c) => !c.passed);
    const key = entry ? 'builder:' + entry.task.piece : 'critic:' + (critic?.piece ?? 'unknown') + ':' + (critic?.round ?? 0);
    if (!violations.length) {
      attempts.delete(key);
      if (entry) corrections.delete(entry.task.piece);
      if (critic) {
        const next = fingerprintRound(reportFindings(text), candidateFingerprint(cwd, ownership.get(critic.piece)?.scratch));
        const rows = findings[critic.piece] ?? [];
        const current = rows.find((row) => row.round === critic.round);
        if (current) {
          if (current.diff !== next.diff) return { continue: false, stopReason: 'Candidate changed during blind judging; discard these verdicts and verify one fixed candidate.' };
          current.fingerprints = [...new Set([...current.fingerprints, ...next.fingerprints])].sort();
        } else rows.push({ round: critic.round, ...next });
        rows.sort((a, b) => a.round - b.round);
        findings[critic.piece] = rows;
        writeAtomic(findingsPath, JSON.stringify(findings, null, 2) + '\n');
        const signals = findingSignals(rows);
        log({ kind: 'finding-fingerprints', piece: critic.piece, round: critic.round, fingerprints: next.fingerprints, diff: next.diff, signals });
        if (signals.length) return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'Mechanical finding signals for ' + critic.piece + ': ' + signals.join(', ') + '. Apply the loop judgment rules; these signals are not a verdict.' } };
      }
      return {};
    }
    if (entry) corrections.set(entry.task.piece, entry.snapshot);
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);
    const message = violations.map((c) => c.name + ': ' + c.violation).join('\n');
    return count >= 3 ? { continue: false, stopReason: 'Consistency correction attempts exhausted: ' + message } : { decision: 'block', reason: 'Correct the producer report in this same round before judging:\n' + message };
  };
  const hooks: NonNullable<Options['hooks']> = {
    PreToolUse: [{ matcher: 'Task|Agent', hooks: [pre] }],
    PostToolUse: [{ matcher: 'Task|Agent', hooks: [post] }],
    PostToolUseFailure: [{ matcher: 'Task|Agent', hooks: [post] }],
  };
  cleanups.set(hooks, () => {
    const breaches: string[] = [];
    for (const [id, entry] of active) {
      active.delete(id);
      const result = enforceOwnership(entry.snapshot, entry.task.files);
      result.violations.push(...repairProtected(entry));
      log({ kind: 'ownership-on-session-end', piece: entry.task.piece, ...result });
      if (result.violations.length) {
        const builder = builders[entry.task.piece];
        if (builder) { builder.poisoned = true; builder.session = null; }
        breaches.push(...result.violations, ...result.unrecoverable);
      }
    }
    persist();
    if (breaches.length) throw new ConfigError('ownership breach while session ended: ' + breaches.join(', '));
  });
  return hooks;
}
