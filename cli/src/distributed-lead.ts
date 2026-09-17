import { existsSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigError } from './exit.js';
import { type EnvSpec, type ValueFlagSpec, directoryValue } from './registry.js';
import { DISTRIBUTED_ENV, RoundCoordinator } from './distributed.js';
import { type Budget, type BudgetTrip } from './budget.js';
import { runDirectory, withLedgerLock, writeAtomic } from './runs-store.js';
import type { TraceStore } from './trace-store.js';
import { toRecord, TRACE_EVENT_KINDS, type TraceEvent } from './trace-events.js';

export const coordinatorFlag: ValueFlagSpec<string> = { long: 'coordinator', value: directoryValue, summary: 'Dispatch rounds through an authenticated shared worker directory' };
export const coordinatorEnv: EnvSpec<string> = { name: DISTRIBUTED_ENV, value: directoryValue, overriddenBy: coordinatorFlag };
export function recordedCoordinator(cwd: string, run: string): string | undefined {
  const path = join(runDirectory(cwd, run), 'distributed.json');
  if (!existsSync(path)) return undefined;
  const value = JSON.parse(readFileSync(path, 'utf8')) as { coordinator?: unknown };
  return typeof value.coordinator === 'string' ? value.coordinator : undefined;
}
export interface DistributedLead {
  readonly costUsd: number;
  directive(markdown: string): string;
  poll(): void;
  settle(reason: string): Promise<boolean>;
}
export function trackVerificationCheckout(cwd: string, run: string, checkout: string): void {
  const path = join(runDirectory(cwd, run), 'distributed-checkouts.json');
  withLedgerLock(cwd, () => { const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as string[] : []; writeAtomic(path, JSON.stringify([...new Set([...prior, checkout])]) + '\n'); });
}
function cleanVerificationCheckouts(cwd: string, run: string): void {
  const path = join(runDirectory(cwd, run), 'distributed-checkouts.json');
  if (!existsSync(path)) return;
  for (const checkout of JSON.parse(readFileSync(path, 'utf8')) as string[]) {
    if (!isAbsolute(checkout) || dirname(resolve(checkout)) !== resolve(tmpdir()) || !basename(checkout).startsWith('genesis-verify-') || (existsSync(checkout) && lstatSync(checkout).isSymbolicLink())) throw new ConfigError('refusing unsafe verification checkout cleanup');
    rmSync(checkout, { recursive: true, force: true });
  }
  writeAtomic(path, '[]\n');
}
/** Only transport metadata and bookkeeping; the plugin owns every loop rule. */
export function createDistributedLead(options: {
  root?: string; cwd: string; run: string; trace: TraceStore; budget: Budget;
  accountedCostUsd?: number;
  maxCostUsd?: number; onTrip(trip: BudgetTrip | undefined): void; onFault(reason: string): void;
}): DistributedLead | undefined {
  if (options.root === undefined) return undefined;
  const previousRoot = recordedCoordinator(options.cwd, options.run);
  if (previousRoot !== undefined && resolve(previousRoot) !== resolve(options.root)) throw new ConfigError('a distributed run keeps its recorded coordinator; resume with ' + previousRoot);
  const queue = new RoundCoordinator(options.root);
  writeAtomic(join(runDirectory(options.cwd, options.run), 'distributed.json'), JSON.stringify({ coordinator: queue.root }) + '\n');
  let billed = options.accountedCostUsd ?? 0;
  let closed = false, faulted = false, settled = true;
  let settlement: Promise<boolean> | undefined;
  const poll = (): void => {
    if (closed) return;
    try {
      for (const event of queue.drainEvents(options.run)) {
        if (!(event.kind in TRACE_EVENT_KINDS)) throw new ConfigError('unknown worker trace event kind');
        options.trace.append(toRecord({ kind: event.kind, piece: event.piece, round: event.round, payload: event.payload } as TraceEvent, { runId: options.run, at: event.at }));
      }
      const cost = queue.cost(options.run);
      if (cost < billed) throw new ConfigError('distributed spend ledger regressed; coordinator receipt evidence is missing');
      const delta = cost - billed;
      billed = Math.max(billed, cost);
      if (delta > 0) options.onTrip(options.budget.addCost(delta));
      queue.setBudget(options.run, options.maxCostUsd === undefined ? undefined : Math.max(0, options.maxCostUsd - options.budget.costUsd));
    } catch (error) {
      if (!faulted) { faulted = true; options.onFault(error instanceof Error ? error.message : String(error)); }
    }
  };
  queue.setBudget(options.run, options.maxCostUsd === undefined ? undefined : Math.max(0, options.maxCostUsd - options.budget.costUsd));
  const timer = setInterval(poll, 250); timer.unref();
  return {
    get costUsd() { return billed; },
    directive: markdown => '\n\n' + (markdown.match(/## Distributed-round transport\r?\n([\s\S]*?)(?=\r?\n## |$)/)?.[0] ?? '') + '\nDistributed transport is enabled. Runtime metadata: ' + JSON.stringify({ coordinator: queue.root, run: options.run, ...(options.maxCostUsd === undefined ? {} : { maxBudgetUsd: Math.max(0, options.maxCostUsd - options.budget.costUsd) }) }),
    poll,
    settle(reason) {
      if (settlement) return settlement;
      settlement = (async () => {
      if (closed) return settled;
      clearInterval(timer); poll();
      try {
        queue.cancelRun(options.run, reason);
        const deadline = Date.now() + 15000;
        while (queue.pendingCancellations(options.run).length > 0 && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 100)); poll();
        }
        const cost = queue.cost(options.run);
        if (cost > billed) { options.onTrip(options.budget.addCost(cost - billed)); billed = cost; }
        poll();
        if (queue.pendingCancellations(options.run).length > 0) throw new ConfigError('worker cancellation/final spend remains unacknowledged; run blocked and coordinator evidence retained');
        if (faulted) throw new ConfigError('distributed transport fault; coordinator evidence retained');
        options.trace.append(toRecord({ kind: 'process_event', payload: { action: 'closed', taskId: 'distributed-' + options.run, role: 'lead', outcome: 'complete' } }, { runId: options.run }));
        cleanVerificationCheckouts(options.cwd, options.run);
        queue.cleanup(options.run);
      } catch (error) { settled = false; options.onFault(error instanceof Error ? error.message : String(error)); }
      closed = true;
      return settled;
      })();
      return settlement;
    },
  };
}
