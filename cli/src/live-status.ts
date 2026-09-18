import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProcesses, readTrace, deriveLiveness, type TraceStore, type TraceRecord } from './trace-store.js';
import { readRuns, readState, runDirectory, writeAtomic, settledIssueRun } from './runs-store.js';
import { toRecord } from './trace-events.js';
import { redactSecrets } from './redact.js';
import { plainText } from './usage.js';

export type LivePhase = 'lead' | 'builder' | 'critic' | 'verification';
export interface LiveBudget { spentUsd: number; maxCostUsd?: number; rounds: number; maxRounds?: number }
export type StallThresholds = Record<LivePhase, number>;
export const DEFAULT_STALL_MS: StallThresholds = { lead: 180_000, builder: 300_000, critic: 180_000, verification: 60_000 };
export function stallThresholds(env: NodeJS.ProcessEnv = {}): StallThresholds {
  const result = { ...DEFAULT_STALL_MS };
  for (const phase of Object.keys(result) as LivePhase[]) {
    const seconds = Number(env['EXOLVRA_GENESIS_STALL_' + phase.toUpperCase() + '_SECONDS']);
    if (Number.isFinite(seconds) && seconds > 0) result[phase] = seconds * 1000;
  }
  return result;
}
const safeActivity = (value: string): string => plainText(redactSecrets(value)).replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, '[redacted]').slice(0, 240);
const isActivity = (kind: string): boolean => kind !== 'stalled' && kind !== 'budget_warning';

export function projectStatus(cwd: string, thresholds: number | StallThresholds = DEFAULT_STALL_MS, now = Date.now()) {
  const state = readState(cwd);
  return readRuns(cwd).filter((r) => r.status === 'running' || (r.status === 'blocked' && !settledIssueRun(cwd, r.id))).map((run) => {
    const events: TraceRecord[] = [];
    let cursor = 0, degraded = false;
    for (;;) {
      const batch = readTrace(cwd, run.id, cursor, 1000);
      events.push(...batch.records); degraded ||= batch.degraded;
      const previous = cursor;
      cursor = batch.cursor;
      if (batch.cursor === previous || batch.records.length < 1000) break;
    }
    const processes = readProcesses(cwd, run.id);
    const latest = events.at(-1), round = [...events].reverse().find((e) => e.round !== null);
    const lastActivity = [...events].reverse().find((e) => isActivity(e.kind));
    const lastAt = lastActivity?.at ?? Date.parse(run.startedAt);
    const live = deriveLiveness(processes, run.status);
    const spend = events.filter((e) => e.kind === 'budget_spend').reduce((n, e) => n + Number(e.payload['costUsd'] ?? 0), 0);
    const activityEvent = [...events].reverse().find((e) => e.kind === 'activity');
    const phaseValue = activityEvent?.payload['phase'];
    const phase: LivePhase = phaseValue === 'builder' || phaseValue === 'critic' || phaseValue === 'verification' ? phaseValue : 'lead';
    const stallMs = typeof thresholds === 'number' ? thresholds : thresholds[phase];
    const budgetEvent = [...events].reverse().find((e) => e.payload['budget'] !== undefined);
    const budget = budgetEvent?.payload['budget'] as LiveBudget | undefined;
    const tokenReceipt = activityEvent?.payload['tokens'] as { inputTokens: number; outputTokens: number } | undefined;
    const pieceIds = [...new Set(events.map((e) => e.piece ?? (e.kind === 'piece_dispatched' ? String(e.payload['pieceId'] ?? '') : null)).filter((p): p is string => p !== null && p !== '' && p !== 'preflight'))];
    const pieces = pieceIds.map((id) => {
      const own = events.filter((e) => e.piece === id || (e.kind === 'piece_dispatched' && e.payload['pieceId'] === id)), recent = own.at(-1);
      const verdict = [...own].reverse().find((e) => e.kind === 'verdict_recorded');
      const bills = own.filter((e) => e.kind === 'budget_spend' && e.payload['attribution'] === 'round');
      return { id: safeActivity(id), phase: safeActivity(recent?.kind ?? 'unknown'), round: recent?.round ?? 0,
        verdict: verdict?.payload['verdict'] ?? null, cost_usd: bills.length ? bills.reduce((n, e) => n + Number(e.payload['costUsd'] ?? 0), 0) : null,
        last_event_age_ms: Math.max(0, now - (recent?.at ?? Date.parse(run.startedAt))) };
    });
    const effectiveStatus = state.run === run.id ? state.status ?? run.status : run.status;
    return {
      id: run.id, status: effectiveStatus,
      source: latest === undefined || degraded ? 'last written' : 'trace',
      cursor, live, phase, piece: round?.piece ?? null, round: round?.round ?? run.rounds ?? 0,
      cost_usd: latest === undefined || degraded ? run.costUsd ?? 0 : spend,
      input_tokens: Math.max(tokenReceipt?.inputTokens ?? 0, events.filter((e) => e.kind === 'budget_spend').reduce((n, e) => n + Number(e.payload['inputTokens'] ?? 0), 0)),
      output_tokens: Math.max(tokenReceipt?.outputTokens ?? 0, events.filter((e) => e.kind === 'budget_spend').reduce((n, e) => n + Number(e.payload['outputTokens'] ?? 0), 0)),
      budget_spent_usd: budget?.spentUsd ?? (latest === undefined ? run.costUsd ?? 0 : spend),
      max_cost_usd: budget?.maxCostUsd ?? null, budget_rounds: budget?.rounds ?? run.rounds ?? 0, max_rounds: budget?.maxRounds ?? null,
      budget_warning: budget !== undefined && ((budget.maxCostUsd !== undefined && budget.spentUsd >= budget.maxCostUsd * .8) || (budget.maxRounds !== undefined && budget.rounds >= budget.maxRounds * .8)),
      last_event_age_ms: Math.max(0, now - lastAt), stalled: effectiveStatus === 'running' && now - lastAt > stallMs,
      activity: safeActivity(String(activityEvent?.payload['detail'] ?? lastActivity?.payload['gap'] ?? '')),
      pieces,
      processes: processes.processes.filter((p) => p.closedAt === null).map((p) => {
        const last = [...events].reverse().find((e) => e.at >= p.openedAt && isActivity(e.kind) && (p.role === 'lead' || e.piece === p.piece));
        const lastAge = Math.max(0, now - (last?.at ?? p.openedAt));
        const threshold = typeof thresholds === 'number' ? thresholds : thresholds[p.role];
        return { task_id: safeActivity(p.taskId), role: p.role, piece: p.piece, age_ms: Math.max(0, now - p.openedAt), last_event_age_ms: lastAge, stalled: lastAge > threshold };
      }),
      progress: join(runDirectory(cwd, run.id), 'progress.html'),
    };
  });
}

/** A disposable view; neither malformed HTML nor an unavailable disk can stop a run. */
export function writeLivePage(cwd: string, runId: string, live: Record<string, unknown>): void {
  try {
    const path = join(runDirectory(cwd, runId), 'progress.html');
    const text = readFileSync(path, 'utf8');
    const begin = '<!-- EXOLVRA-GENESIS-DATA-BEGIN -->', end = '<!-- EXOLVRA-GENESIS-DATA-END -->';
    const start = text.indexOf(begin), finish = text.indexOf(end);
    if (start < 0 || finish <= start || text.indexOf(begin, start + 1) >= 0 || text.indexOf(end, finish + 1) >= 0) return;
    const block = text.slice(start + begin.length, finish).match(/(<script[^>]*>)([\s\S]*?)(<\/script>)/);
    if (!block) return;
    const data = JSON.parse(block[2]!);
    data.live = live;
    const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
    writeAtomic(path, text.slice(0, start + begin.length) + '\n' + block[1] + '\n' + json + '\n' + block[3] + '\n' + text.slice(finish));
  } catch { /* Observability cannot fail the run. */ }
}

export function createLiveMonitor(cwd: string, runId: string, trace: TraceStore, maxCost?: number,
  thresholds: number | StallThresholds = DEFAULT_STALL_MS, budgetNow?: () => LiveBudget) {
  let last = Date.now(), activity = 'Starting', cost = budgetNow?.().spentUsd ?? 0, stalled = false;
  let phase: LivePhase = 'lead';
  let currentPiece: string | undefined, currentRound: number | undefined;
  let inputTokens = 0, outputTokens = 0;
  let previousCursor = 0;
  for (;;) {
    const batch = trace.read(previousCursor, 1000);
    for (const event of batch.records) {
      if (event.kind === 'budget_spend') { inputTokens += Number(event.payload['inputTokens'] ?? 0); outputTokens += Number(event.payload['outputTokens'] ?? 0); }
    }
    if (batch.cursor === previousCursor || batch.records.length < 1000) break;
    previousCursor = batch.cursor;
  }
  const agentStalls = new Set<string>();
  const warnings = new Set<string>();
  const currentBudget = (): LiveBudget => budgetNow?.() ?? { spentUsd: cost, maxCostUsd: maxCost, rounds: 0 };
  const emit = (kind: 'activity' | 'stalled' | 'budget_warning', detail: string): void => trace.append(toRecord({ kind, piece: currentPiece, round: currentRound, payload: { detail, phase, budget: currentBudget(), tokens: { inputTokens, outputTokens } } }, { runId }));
  const refresh = (): void => {
    const now = Date.now();
    const budget = currentBudget();
    cost = budget.spentUsd;
    for (const [name, value, cap] of [['cost', cost, budget.maxCostUsd], ['round', budget.rounds, budget.maxRounds]] as const) {
      if (cap !== undefined && value >= cap * .8 && !warnings.has(name)) {
        warnings.add(name); emit('budget_warning', '80% of ' + name + ' cap reached');
      }
    }
    const stallMs = typeof thresholds === 'number' ? thresholds : thresholds[phase];
    if (!stalled && now - last > stallMs) { stalled = true; emit('stalled', 'No activity for ' + Math.floor((now - last) / 1000) + ' seconds; the watchdog does not kill.'); }
    const events: TraceRecord[] = [];
    let cursor = 0;
    for (;;) {
      const batch = trace.read(cursor, 1000); events.push(...batch.records);
      if (batch.cursor === cursor || batch.records.length < 1000) break;
      cursor = batch.cursor;
    }
    const agents = trace.processes().filter((p) => p.closedAt === null && p.role !== 'lead').map((p) => {
      const recent = [...events].reverse().find((e) => e.piece === p.piece && e.at >= p.openedAt && isActivity(e.kind));
      const age = Math.max(0, now - (recent?.at ?? p.openedAt));
      const threshold = typeof thresholds === 'number' ? thresholds : thresholds[p.role];
      const isStalled = age > threshold;
      if (isStalled && !agentStalls.has(p.taskId)) {
        agentStalls.add(p.taskId);
        trace.append(toRecord({ kind: 'stalled', piece: p.piece, round: p.round ?? undefined,
          payload: { detail: safeActivity(p.role + ' ' + p.taskId + ' has no activity for ' + Math.floor(age / 1000) + ' seconds'), phase: p.role } }, { runId }));
      } else if (!isStalled) agentStalls.delete(p.taskId);
      return { task_id: safeActivity(p.taskId), role: p.role, piece: p.piece, age_ms: now - p.openedAt, last_event_age_ms: age, stalled: isStalled };
    });
    writeLivePage(cwd, runId, { at: now, last_event_at: last, activity, phase, stalled, cost_usd: cost, max_cost_usd: budget.maxCostUsd ?? null,
      input_tokens: inputTokens, output_tokens: outputTokens, agents,
      rounds: budget.rounds, max_rounds: budget.maxRounds ?? null, budget_warning: warnings.size > 0 });
  };
  const timer = setInterval(refresh, 2000); timer.unref();
  emit('activity', activity);
  return {
    refresh,
    activity(text: string, nextPhase?: LivePhase, piece?: string, round?: number): void {
      last = Date.now(); stalled = false;
      if (nextPhase) phase = nextPhase;
      currentPiece = piece; currentRound = round;
      activity = safeActivity(text);
      emit('activity', activity);
    },
    spend(usd: number): void {
      if (!budgetNow) cost += usd;
      refresh();
    },
    tokens(input: number, output: number): void { inputTokens += input; outputTokens += output; },
    close(): void { clearInterval(timer); refresh(); },
  };
}
