import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './exit.js';
import { candidateFingerprint } from './ownership.js';
import { fingerprintRound, findingSignals, reportFindings, type FindingRound } from './consistency.js';
import { readOwnershipPlan, assertPlannedTask, type Task } from './round-guards.js';
import { runDirectory, writeAtomic } from './runs-store.js';
import { redactSecrets } from './git.js';

interface JudgedRound extends FindingRound { round: number }
function history(cwd: string, run: string): Record<string, JudgedRound[]> {
  const path = join(runDirectory(cwd, run), 'findings.json');
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, JudgedRound[]>;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(rows => !Array.isArray(rows) || rows.some(row => !row || !Number.isSafeInteger(row.round) || typeof row.diff !== 'string' || !Array.isArray(row.fingerprints) || !row.fingerprints.every(f => typeof f === 'string')))) throw new ConfigError('invalid persisted finding history');
  return value;
}
export function guardDistributedBuilder(cwd: string, run: string, task: Task): { coldStart: boolean; signals: string[] } {
  assertPlannedTask(readOwnershipPlan(cwd, run), task);
  const rows = history(cwd, run)[task.piece] ?? [], signals = findingSignals(rows);
  if (signals.includes('duplicate-round') && rows.at(-1)?.diff === fingerprintRound([], candidateFingerprint(cwd, task.scratch)).diff) throw new ConfigError('Duplicate findings over an unchanged candidate: no builder dispatched; reconcile the duplicate with the lead.');
  return { coldStart: signals.includes('see-saw') && findingSignals(rows.slice(0, -1)).includes('see-saw'), signals };
}
/** Shares normalization, candidate hashing, history schema and signals with local guards. */
export function recordDistributedFindings(cwd: string, run: string, piece: string, round: number, text: string, candidate: string): string[] {
  const all = history(cwd, run), rows = all[piece] ?? [], next = fingerprintRound(reportFindings(text), candidate);
  const current = rows.find(row => row.round === round);
  if (current) {
    if (current.diff !== next.diff) throw new ConfigError('Candidate changed during blind judging; discard these verdicts and verify one fixed candidate.');
    current.fingerprints = [...new Set([...current.fingerprints, ...next.fingerprints])].sort();
  } else rows.push({ round, ...next });
  rows.sort((a, b) => a.round - b.round); all[piece] = rows;
  const root = runDirectory(cwd, run), signals = findingSignals(rows);
  writeAtomic(join(root, 'findings.json'), JSON.stringify(all, null, 2) + '\n');
  appendFileSync(join(root, 'round-log.ndjson'), redactSecrets(JSON.stringify({ at: new Date().toISOString(), event: { kind: 'finding-fingerprints', piece, round, ...next, signals } })) + '\n');
  return signals;
}
