import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionPreflight } from './preflight.js';
import { runDirectory } from './runs-store.js';
import { toRecord } from './trace-events.js';
import type { TraceStore } from './trace-store.js';

export function recordPreflight(cwd: string, runId: string, receipt: ExecutionPreflight, trace: TraceStore): void {
  for (const attempt of receipt.attempts) {
    const record = toRecord({ kind: 'gate_check', payload: { gate: 'execution-preflight', passed: attempt.outcome === 'allowed', detail: JSON.stringify(attempt) } }, { runId });
    appendFileSync(join(runDirectory(cwd, runId), 'round-log.ndjson'), JSON.stringify(record) + '\n');
    trace.append(toRecord({ kind: 'gate_check', payload: { gate: 'execution-preflight', passed: attempt.outcome === 'allowed', detail: JSON.stringify(attempt) } }, { runId, at: record.at }));
  }
  if (receipt.costUsd > 0 || receipt.inputTokens > 0 || receipt.outputTokens > 0) trace.append(toRecord({ kind: 'budget_spend', piece: 'preflight', payload: { attribution: 'preflight', costUsd: receipt.costUsd, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens } }, { runId }));
}
