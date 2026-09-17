import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDirectory } from './runs-store.js';

const watchers = new Map<string, { references: number; timer: ReturnType<typeof setInterval> }>();

/** One interrupt per owning invocation, including the gaps between SDK turns. */
export function watchRunStop(cwd: string, runId: string): () => void {
  const root = runDirectory(cwd, runId);
  const existing = watchers.get(root);
  if (existing) existing.references += 1;
  else {
    const began = Date.now();
    let ownerStartedAt: number | undefined;
    try { ownerStartedAt = JSON.parse(readFileSync(join(root, 'control.json'), 'utf8')).startedAt; } catch { /* Legacy owner. */ }
    let delivered = false;
    const timer = setInterval(() => {
      if (delivered) return;
      try {
        const request = JSON.parse(readFileSync(join(root, 'stop-request.json'), 'utf8'));
        const belongsToOwner = request.ownerPid === process.pid && request.ownerStartedAt === ownerStartedAt;
        if (request.run === runId && (belongsToOwner || (request.ownerPid === undefined && request.requestedAt >= began))) {
          delivered = true;
          process.emit('SIGINT');
        }
      } catch { /* No valid stop request. */ }
    }, 250);
    timer.unref();
    watchers.set(root, { references: 1, timer });
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const entry = watchers.get(root);
    if (entry && --entry.references === 0) {
      clearInterval(entry.timer);
      watchers.delete(root);
    }
  };
}

/** A stop cancels the timer as well as the wait, so backoff cannot hold the CLI. */
export async function waitForRetry(delayMs: number, stopped: Promise<void>): Promise<void> {
  if (delayMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, delayMs); }), stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
