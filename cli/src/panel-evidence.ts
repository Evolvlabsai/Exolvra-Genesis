import type { TraceRecord } from './trace-store.js';
import type {
  PanelEvidenceComparison, PanelEvidenceFact, PanelEvidenceFile, PanelEvidenceFinding,
  PanelEvidenceRound, PanelEvidenceSource, PanelEvidenceVerification, PanelRun, PanelRunEvidence,
} from './panel-types.js';

const MAX_ROUNDS = 100, MAX_FILES = 100, MAX_CHECKS = 20, MAX_FINDINGS = 12, MAX_TEXT = 4096;
// UTF-16 retained strings stay below roughly 768 KiB, plus bounded metadata.
const MAX_RETAINED_CHARS = 384_000;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const positive = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
const timestamp = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const verdict = (value: unknown): PanelEvidenceFinding['verdict'] | null => value === 'WIN' || value === 'LOSS' || value === 'BLOCKED' ? value : null;
const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const hasGap = (value: string): boolean => value.trim() !== '' && !/^(?:none|clean|n\/a|no (?:gaps|findings))[.!]?$/i.test(value.trim());

interface RoundState {
  piece: string | null;
  round: number | null;
  firstSeq: number;
  startedAt: number | null;
  endedAt: number | null;
  files: Map<string, PanelEvidenceFile>;
  verification: PanelEvidenceVerification[];
  findings: PanelEvidenceFinding[];
  fileListRecorded: boolean;
  fileAuthority: 'observed' | 'reported' | null;
  fingerprint: string | null;
  fingerprintSource: PanelEvidenceSource | null;
  retainedChars: number;
  truncated: boolean;
}
const fileChars = (file: PanelEvidenceFile): number => file.path.length + file.source.kind.length + 80;
const checkChars = (check: PanelEvidenceVerification): number => check.name.length + check.detail.length + (check.command?.length ?? 0) + check.source.kind.length + 100;
const findingChars = (finding: PanelEvidenceFinding): number => finding.gap.length + finding.evidence.length + finding.source.kind.length + 100;

/** The collector accepts every trace page while retaining a bounded projection. */
export interface PanelEvidenceCollector {
  record(event: TraceRecord): void;
  /** Produces a new snapshot; repeated calls never mutate the cached collector. */
  finish(run: PanelRun, options?: { degraded?: boolean }): PanelRunEvidence;
}

/**
 * Observational only: no SDK, filesystem, or worktree access. The supplied scrubber
 * is the same redaction policy used for the panel's legacy trace and ledger data.
 * Records must arrive in sequence order, for one run, across all pages.
 */
export function createPanelEvidence(runId: string, scrubText: (value: string, maxLength?: number) => string): PanelEvidenceCollector {
  const rounds = new Map<string, RoundState>();
  const issues = new Map<string, PanelEvidenceFact>();
  let lastSeq = 0, retainedChars = 0, truncated = false, finishEvent: { status: string; source: PanelEvidenceSource } | null = null;
  let activity: PanelEvidenceFact | null = null;
  const text = (value: unknown, limit = MAX_TEXT): string => {
    if (typeof value !== 'string') return '';
    const clean = scrubText(value, limit);
    if (clean.length <= limit) return clean;
    truncated = true;
    return clean.slice(0, limit - 1) + '\u2026';
  };
  const source = (event: TraceRecord): PanelEvidenceSource => ({ seq: event.seq, at: timestamp(event.at) ?? 0, kind: text(event.kind, 100) });
  const fact = (value: string, event: TraceRecord): PanelEvidenceFact => ({ text: text(value, 2048), source: source(event) });
  const removeGroup = (key: string): void => {
    const entry = rounds.get(key);
    if (entry) retainedChars -= entry.retainedChars;
    rounds.delete(key);
  };
  const retain = (entry: RoundState, delta: number): void => {
    entry.retainedChars += delta;
    retainedChars += delta;
    // One group's independent field caps fit inside the whole collector budget.
    // Discard older groups instead of allowing a long run to grow every cache.
    while (retainedChars > MAX_RETAINED_CHARS && rounds.size > 1) {
      const oldest = [...rounds].find(([, candidate]) => candidate !== entry);
      if (!oldest) break;
      removeGroup(oldest[0]);
      truncated = true;
    }
  };
  const list = (value: unknown, limit: number): string[] | null => {
    if (!Array.isArray(value)) return null;
    if (value.length > limit) truncated = true;
    return value.slice(0, limit).filter((item): item is string => typeof item === 'string').map((item) => text(item, 1024)).filter(Boolean);
  };
  const group = (event: TraceRecord): RoundState => {
    const piece = typeof event.piece === 'string' ? text(event.piece, 200) : null;
    const round = positive(event.round);
    const key = JSON.stringify([piece, round]);
    let current = rounds.get(key);
    if (!current) {
      if (rounds.size >= MAX_ROUNDS) {
        removeGroup(rounds.keys().next().value!);
        truncated = true;
      }
      current = { piece, round, firstSeq: event.seq, startedAt: null, endedAt: null, files: new Map(), verification: [], findings: [],
        fileListRecorded: false, fileAuthority: null, fingerprint: null, fingerprintSource: null, retainedChars: 0, truncated: false };
      rounds.set(key, current);
      retain(current, (piece?.length ?? 0) + 200);
    }
    return current;
  };
  const addCheck = (entry: RoundState, check: PanelEvidenceVerification): void => {
    if (check.detail.endsWith('\u2026') || check.command?.endsWith('\u2026')) entry.truncated = true;
    if (entry.verification.length >= MAX_CHECKS) { retain(entry, -checkChars(entry.verification.shift()!)); entry.truncated = true; truncated = true; }
    entry.verification.push(check);
    retain(entry, checkChars(check));
  };
  const setIssue = (key: string, value: PanelEvidenceFact | null): void => {
    if (value === null) { issues.delete(key); return; }
    if (issues.size >= 32 && !issues.has(key)) { issues.delete(issues.keys().next().value!); truncated = true; }
    issues.set(key, value);
  };
  const addFiles = (event: TraceRecord, files: unknown, kind: PanelEvidenceFile['kind'], restored: unknown = []): void => {
    const paths = list(files, MAX_FILES);
    if (paths === null) return;
    const entry = group(event), restoredPaths = new Set(list(restored, MAX_FILES) ?? []);
    if (Array.isArray(files) && (files.length > MAX_FILES || files.some((path) => typeof path !== 'string' || !path.trim()))) { entry.truncated = true; truncated = true; }
    if (Array.isArray(restored) && (restored.length > MAX_FILES || restored.some((path) => typeof path !== 'string'))) { entry.truncated = true; truncated = true; }
    entry.fileListRecorded = true;
    if (entry.fileAuthority === null || kind === 'observed') entry.fileAuthority = kind;
    for (const path of paths) {
      if (path.endsWith('\u2026')) entry.truncated = true;
      const key = JSON.stringify([kind, path]);
      if (entry.files.size >= MAX_FILES && !entry.files.has(key)) { entry.truncated = true; truncated = true; continue; }
      const prior = entry.files.get(key);
      const file = { path, kind, restored: kind === 'observed' ? restoredPaths.has(path) : null, source: source(event) };
      entry.files.set(key, file);
      retain(entry, fileChars(file) - (prior ? fileChars(prior) : 0));
    }
  };
  const addFinding = (event: TraceRecord, payload: Record<string, unknown>): void => {
    if (payload['isError'] === true) return;
    const value = verdict(payload['verdict']);
    if (value === null) return;
    const entry = group(event), gap = text(payload['gap']), evidence = text(payload['evidence']);
    if (payload['truncated'] === true || gap.endsWith('\u2026') || evidence.endsWith('\u2026')) { entry.truncated = true; truncated = true; }
    const existing = entry.findings.findIndex((item) => item.verdict === value && normalize(item.gap) === normalize(gap));
    const finding = { verdict: value, gap, evidence, source: source(event) };
    if (existing >= 0) {
      // Prefer the actual critic report with its evidence over a later lead marker.
      if (evidence || !entry.findings[existing]!.evidence) {
        retain(entry, findingChars(finding) - findingChars(entry.findings[existing]!));
        entry.findings[existing] = finding;
      }
    } else {
      if (entry.findings.length >= MAX_FINDINGS) { retain(entry, -findingChars(entry.findings.shift()!)); entry.truncated = true; truncated = true; }
      entry.findings.push(finding);
      retain(entry, findingChars(finding));
    }
    entry.endedAt = timestamp(event.at);
    const key = 'verdict:' + JSON.stringify(entry.piece);
    if (value !== 'WIN') setIssue(key, fact(value + (gap ? ': ' + gap : ' (no gap recorded)'), event));
    else if (event.kind === 'verdict_recorded') setIssue(key, null);
  };
  const activityDetail = (event: TraceRecord, payload: Record<string, unknown>): void => {
    const detail = text(payload['detail']);
    if (detail && !detail.startsWith('{') && !/^(?:assistant|user|system|result|stream_event)$/i.test(detail.trim())) activity = fact(detail, event);
  };

  return {
    record(event): void {
      if (event.runId !== runId || positive(event.seq) === null || event.seq <= lastSeq) return;
      lastSeq = event.seq;
      const payload = object(event.payload) ?? {};
      const pieceKey = JSON.stringify(typeof event.piece === 'string' ? text(event.piece, 200) : null);
      const clearRecoveredError = (): void => { issues.delete('error:' + pieceKey); issues.delete('error:null'); };
      switch (event.kind) {
        case 'run_started':
          finishEvent = null;
          issues.clear();
          activity = fact('Run started', event);
          break;
        case 'run_finished':
          if (typeof payload['status'] === 'string') finishEvent = { status: text(payload['status'], 100), source: source(event) };
          break;
        case 'builder_round_started': {
          clearRecoveredError();
          issues.delete('verdict:' + pieceKey);
          issues.delete('command:' + pieceKey);
          for (const key of issues.keys()) if (key.startsWith('gate:' + pieceKey + ':')) issues.delete(key);
          const entry = group(event);
          entry.startedAt ??= timestamp(event.at);
          activity = fact('Builder working' + (entry.piece ? ' on ' + entry.piece : ''), event);
          break;
        }
        case 'builder_round_ended': {
          clearRecoveredError();
          const entry = group(event);
          entry.endedAt = timestamp(event.at);
          if (payload['truncated'] === true) { entry.truncated = true; truncated = true; }
          addFiles(event, payload['reportedFiles'], 'reported');
          const legacy = legacySections(payload['text']);
          // Distributed transports historically persisted a flattened whole report.
          // Keep its section as a report; do not invent paths from flattened prose.
          const output = text(payload['verificationOutput'] ?? legacy['VERIFICATION']);
          if (output) addCheck(entry, { name: 'Builder verification output', status: 'reported', detail: output,
            command: text((list(payload['verificationCommands'], 20) ?? []).join('\n'), 2048) || null, authority: 'builder', source: source(event) });
          activity = fact('Builder report received' + (entry.piece ? ' for ' + entry.piece : ''), event);
          break;
        }
        case 'critic_dispatched': {
          clearRecoveredError();
          const entry = group(event);
          activity = fact('Critic reviewing' + (entry.piece ? ' ' + entry.piece : ''), event);
          break;
        }
        case 'verdict_recorded':
          {
            const legacy = legacySections(payload['text']);
            const fields = { ...payload, verdict: payload['verdict'] ?? legacy['VERDICT']?.match(/^(WIN|LOSS|BLOCKED)\b/)?.[1],
              gap: payload['gap'] ?? legacy['GAP'], evidence: payload['evidence'] ?? legacy['EVIDENCE'] };
            if (verdict(fields.verdict) && payload['isError'] !== true) clearRecoveredError();
            addFinding(event, fields);
            if (verdict(fields.verdict)) activity = fact('Verdict recorded: ' + text(fields.verdict), event);
          }
          break;
        case 'gate_check':
        case 'pin_check': {
          const entry = group(event), name = text(payload[event.kind === 'gate_check' ? 'gate' : 'pin'], 200) || event.kind;
          const status = payload['passed'] === true ? 'passed' : payload['passed'] === false ? 'failed' : 'recorded';
          const detail = text(payload['detail']);
          addCheck(entry, { name, status, detail, command: null, authority: 'guard', source: source(event) });
          if (status === 'passed') clearRecoveredError();
          if (status !== 'recorded') setIssue('gate:' + pieceKey + ':' + name, status === 'passed' ? null : fact(name + (detail ? ': ' + detail : ' failed'), event));
          // Older ownership guards kept the snapshot result in gate detail JSON.
          if (event.kind === 'gate_check' && name === 'ownership' && typeof payload['detail'] === 'string' && payload['detail'].length <= 131072) {
            try {
              const ownership = object(JSON.parse(payload['detail']));
              if (ownership?.['kind'] === 'ownership') addFiles(event, ownership['touched'], 'observed', ownership['restored']);
            } catch { /* Ordinary gate detail is prose, not JSON. */ }
          }
          break;
        }
        case 'error_path': {
          const fault = text(payload['fault']), detail = text(payload['detail']);
          setIssue('error:' + pieceKey, fact([fault, detail].filter(Boolean).join(': ') || 'An error was recorded without detail.', event));
          activity = fact(detail || fault || 'Run reported an error', event);
          break;
        }
        case 'stalled':
        case 'budget_warning':
          activityDetail(event, payload);
          break;
        case 'activity': {
          activityDetail(event, payload);
          const evidence = object(payload['evidence']);
          if (evidence?.['type'] === 'file_changes' && evidence['source'] === 'ownership-snapshot') {
            addFiles(event, evidence['files'], 'observed', evidence['restored']);
          } else if (evidence?.['type'] === 'critic_report' && evidence['source'] === 'critic-report') {
            if (verdict(evidence['verdict']) && evidence['isError'] !== true) clearRecoveredError();
            addFinding(event, evidence);
          } else if (evidence?.['type'] === 'verification' && evidence['source'] === 'sdk-tool-result') {
            const role = evidence['role'], authority: PanelEvidenceVerification['authority'] = role === 'lead' || role === 'builder' || role === 'critic' ? role : 'unknown';
            const code = Number.isSafeInteger(evidence['exitCode']) ? Number(evidence['exitCode']) : null;
            const status = evidence['isError'] === true || (code !== null && code !== 0) ? 'failed' : code === 0 && evidence['purpose'] === 'verification' ? 'passed' : 'recorded';
            const tool = text(evidence['tool'], 80) || 'Tool', command = text(evidence['command'], 2048) || null;
            const entry = group(event);
            if (evidence['truncated'] === true) { truncated = true; entry.truncated = true; }
            addCheck(entry, { name: tool + (evidence['purpose'] === 'verification' ? ' verification' : ' command'), status,
              detail: text(evidence['output']), command, authority, source: source(event) });
            if (status === 'failed') setIssue('command:' + pieceKey, fact((command || tool) + ': ' + (text(evidence['output']) || 'tool reported failure'), event));
            else if (code === 0 || evidence['isError'] === false) { clearRecoveredError(); setIssue('command:' + pieceKey, null); }
            activity = fact(authority[0]!.toUpperCase() + authority.slice(1) + ' command: ' + (command || tool), event);
          }
          // Fingerprints are recorded by the guard, never recomputed from today's worktree.
          if (typeof payload['detail'] === 'string' && payload['detail'].length <= 131072) {
            try {
              const detail = object(JSON.parse(payload['detail']));
              if (detail?.['kind'] === 'finding-fingerprints' && typeof detail['diff'] === 'string' && /^[a-f0-9]{64}$/i.test(detail['diff'])) {
                const entry = group(event), fingerprint = text(detail['diff'], 200);
                retain(entry, fingerprint.length - (entry.fingerprint?.length ?? 0));
                entry.fingerprint = fingerprint; entry.fingerprintSource = source(event);
              }
              if (detail?.['kind'] === 'ownership') addFiles(event, detail['touched'], 'observed', detail['restored']);
            } catch { /* Human activity text needs no parsing. */ }
          }
          break;
        }
      }
    },
    finish(run, options = {}): PanelRunEvidence {
      const entries = [...rounds.values()].sort((a, b) => a.firstSeq - b.firstSeq);
      const projected = entries.map((entry): PanelEvidenceRound => {
        const missing: string[] = [];
        if (!entry.fileListRecorded) missing.push('No changed-file list was recorded for this round.');
        if (!entry.verification.some((item) => item.authority !== 'guard')) missing.push('No command output was recorded for this round.');
        if (!entry.verification.some((item) => item.authority === 'lead')) missing.push('No lead command result was recorded for this round.');
        if (entry.findings.length === 0) missing.push('No critic verdict or findings were recorded for this round.');
        if (entry.round === null) missing.push('These records did not identify a round; they are not used in round comparisons.');
        if (entry.truncated) missing.push('Some round evidence is incomplete or exceeds display limits; open its trace sources for detail.');
        let comparison: PanelEvidenceComparison | null = null;
        if (entry.piece !== null && entry.round !== null) {
          const prior = entries.find((candidate) => candidate.piece === entry.piece && candidate.round === entry.round! - 1);
          if (prior) comparison = compareRounds(prior, entry);
        }
        return { piece: entry.piece, round: entry.round, startedAt: entry.startedAt, endedAt: entry.endedAt,
          files: [...entry.files.values()].map((item) => ({ ...item, source: { ...item.source } })),
          verification: entry.verification.map((item) => ({ ...item, source: { ...item.source } })),
          findings: entry.findings.map((item) => ({ ...item, source: { ...item.source } })), comparison, missing };
      });
      // A past finding is not proof that it stopped a later invocation. Only an
      // unrecovered error, or a recorded final LOSS, can explain a stopped run.
      const candidates = run.status === 'stopped' && finishEvent?.status !== 'loss'
        ? [...issues.entries()].filter(([key]) => key.startsWith('error:')).map(([, value]) => value) : [...issues.values()];
      const issue = candidates.sort((a, b) => (b.source?.seq ?? 0) - (a.source?.seq ?? 0))[0];
      const ended = run.status !== 'running';
      const matchesFinish = finishEvent && ((run.status === 'complete' && finishEvent.status === 'win')
        || (run.status === 'blocked' && finishEvent.status === 'blocked')
        || (run.status === 'stopped' && ['loss', 'stopped'].includes(finishEvent.status)));
      const outcome = run.status === 'complete' ? 'Completed' : run.status === 'blocked' ? 'Blocked' : run.status === 'stopped' ? 'Stopped' : run.live === 'died' ? 'Owner process ended; run is unsettled' : 'Running';
      const blockingReason: PanelEvidenceFact | null = run.status === 'complete' ? null : issue
        ? { text: 'Last recorded issue: ' + issue.text, source: issue.source ? { ...issue.source } : null }
        : run.status === 'blocked' || run.status === 'stopped' ? { text: run.status === 'stopped' ? 'No stop reason was recorded.' : 'No blocking reason was recorded.', source: null } : null;
      let nextAction: PanelRunEvidence['summary']['nextAction'];
      if (run.canResume) nextAction = { action: 'resume', text: blockingReason && issue ? 'Review the recorded issue, then resume with the saved session.' : 'Resume with the saved session to continue this run.', source: blockingReason?.source ?? null };
      else if (run.status === 'complete') nextAction = { action: 'review', text: 'Review the recorded results and artifacts.', source: null };
      else if (!ended && run.live !== 'died' && !run.stalled) nextAction = { action: 'wait', text: 'Follow the current activity while this run continues.', source: activity?.source ?? null };
      else nextAction = { action: 'review', text: run.stalled ? 'Inspect the last activity and process state; stop the run if it needs intervention.' : 'Review the evidence and process state before starting another run.', source: blockingReason?.source ?? activity?.source ?? null };
      const warnings: string[] = [];
      if (options.degraded) warnings.push('The trace is incomplete or unavailable; missing evidence does not establish success or failure.');
      if (truncated) warnings.push('Evidence display is limited by a shared text budget, at most 100 recorded groups, and per-group limits. Open the trace for additional records.');
      if (entries.length === 0) warnings.push('This run has no recorded round evidence. Older runs may contain only their status and cost.');
      return { summary: {
        outcome: { text: outcome, source: matchesFinish && finishEvent ? { ...finishEvent.source } : null },
        currentActivity: ended ? { text: activity ? 'Last activity: ' + activity.text : 'No activity detail was recorded.', source: activity?.source ? { ...activity.source } : null }
          : activity ? { text: activity.text, source: activity.source ? { ...activity.source } : null } : { text: 'No activity detail was recorded.', source: null },
        blockingReason, nextAction: { ...nextAction, source: nextAction.source ? { ...nextAction.source } : null },
      }, rounds: projected, warnings, truncated };
    },
  };
}

/** Heading boundaries also survive the historical trace sanitizer's newline flattening. */
function legacySections(value: unknown): Record<string, string> {
  if (typeof value !== 'string' || value.length > 131072) return {};
  const sections: Record<string, string> = Object.create(null);
  const headings = [...value.matchAll(/(?:^|\s)(?:#{1,6}\s*)?(?:\*\*)?(FILES CHANGED|COMMANDS RUN|VERIFICATION|VERDICT|GAP|EVIDENCE|BUILT SHA)(?:\*\*)?\s*:/g)];
  const names = headings.map((heading) => heading[1]!);
  const expected = names[0] === 'FILES CHANGED' ? ['FILES CHANGED', 'COMMANDS RUN', 'VERIFICATION'] : ['VERDICT', 'GAP', 'EVIDENCE'];
  if (expected.some((name) => names.filter((candidate) => candidate === name).length !== 1)
    || expected.some((name, index) => names[index] !== name)) return {};
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    sections[heading[1]!] = value.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? value.length).trim();
  }
  return sections;
}

function compareRounds(previous: RoundState, current: RoundState): PanelEvidenceComparison {
  const filesComparable = previous.fileListRecorded && current.fileListRecorded && previous.fileAuthority === current.fileAuthority && !previous.truncated && !current.truncated;
  const paths = (entry: RoundState): string[] => [...new Set([...entry.files.values()].filter((file) => file.kind === entry.fileAuthority && file.restored !== true).map((file) => file.path))];
  const before = new Set(paths(previous)), after = new Set(paths(current));
  const findingsComparable = previous.findings.length > 0 && current.findings.length > 0 && !previous.truncated && !current.truncated;
  const gaps = (entry: RoundState): Map<string, string> => new Map(entry.findings.filter((finding) => hasGap(finding.gap)).map((finding) => [normalize(finding.gap), finding.gap]));
  const oldGaps = gaps(previous), newGaps = gaps(current);
  return {
    previousRound: previous.round!, filesComparable, findingsComparable,
    addedFiles: filesComparable ? [...after].filter((path) => !before.has(path)) : [],
    removedFiles: filesComparable ? [...before].filter((path) => !after.has(path)) : [],
    repeatedFindings: findingsComparable ? [...newGaps].filter(([key]) => oldGaps.has(key)).map(([, value]) => value) : [],
    newFindings: findingsComparable ? [...newGaps].filter(([key]) => !oldGaps.has(key)).map(([, value]) => value) : [],
    noLongerReported: findingsComparable ? [...oldGaps].filter(([key]) => !newGaps.has(key)).map(([, value]) => value) : [],
    candidateChanged: previous.fingerprint && current.fingerprint ? previous.fingerprint !== current.fingerprint : null,
    candidateSources: previous.fingerprintSource && current.fingerprintSource ? { previous: { ...previous.fingerprintSource }, current: { ...current.fingerprintSource } } : null,
  };
}
