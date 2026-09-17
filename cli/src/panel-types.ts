/** The control panel presents existing Genesis records and command results. */
export interface PanelProject {
  id: string;
  name: string;
  path: string;
  runCount: number;
  activeCount: number;
  goals: { name: string; description: string }[];
  error: string | null;
}

export interface PanelRun {
  id: string;
  projectId: string;
  projectName: string;
  input: string;
  status: 'running' | 'complete' | 'stopped' | 'blocked';
  phase: string;
  live: string;
  stalled: boolean;
  startedAt: string;
  finishedAt: number | null;
  updatedAt: number;
  costUsd: number | null;
  rounds: number;
  lastVerdict: string | null;
  models: { lead: string; builder: string; critic: string };
  tokens: { input: number; output: number } | null;
  source: 'trace' | 'last written';
  canResume: boolean;
  canStop: boolean;
  maxCostUsd: number | null;
  maxRounds: number | null;
}

export interface PanelEvent {
  seq: number;
  at: number;
  runId: string;
  projectId: string;
  kind: string;
  piece: string | null;
  round: number | null;
  payload: Record<string, unknown>;
  summary: string;
}

export interface PanelAgent {
  id: string;
  name: string;
  role: string;
  description: string;
  model: string;
  source: string;
  tools: string[];
  prompt: string;
}

export type PanelAction = 'run' | 'plan' | 'resume' | 'stop' | 'doctor' | 'chart';
export interface PanelJobRequest {
  action: PanelAction;
  projectId: string;
  input?: string;
  runId?: string;
  model?: string;
  builderModel?: string;
  criticModel?: string;
  maxCostUsd?: number;
  maxRounds?: number;
  maxTurns?: number;
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'default';
  force?: boolean;
}

export interface PanelJob {
  id: string;
  projectId: string;
  projectName: string;
  action: PanelAction;
  status: 'starting' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  createdAt: number;
  finishedAt: number | null;
  runId: string | null;
  exitCode: number | null;
  pid: number | null;
  output: { seq: number; at: number; stream: 'stdout' | 'stderr'; text: string }[];
  error: string | null;
}

export interface PanelOverview {
  version: string;
  startedAt: number;
  now: number;
  projects: PanelProject[];
  runs: PanelRun[];
  agents: PanelAgent[];
  events: PanelEvent[];
  jobs: PanelJob[];
  models: { value: string; label: string }[];
  agentModels: string[];
  totals: { running: number; blocked: number; complete: number; stopped: number; costUsd: number | null; inputTokens: number; outputTokens: number };
  errors: string[];
}

export interface PanelRunDetail {
  run: PanelRun;
  evidence: PanelRunEvidence;
  events: PanelEvent[];
  cursor: number;
  hasMore: boolean;
  oldestCursor: number;
  hasEarlier: boolean;
  degraded: boolean;
  processes: { taskId: string; role: string; piece: string | null; round: number | null; openedAt: number; closedAt: number | null; outcome: string | null; pid: number | null }[];
  pieces: { id: string; round: number; verdict: string | null; costUsd: number | null }[];
  artifacts: { name: string; kind: string; url: string }[];
  warnings: string[];
}

/** Every observed statement can be opened at its exact position in the run trace. */
export interface PanelEvidenceSource { seq: number; at: number; kind: string }
export interface PanelEvidenceFact { text: string; source: PanelEvidenceSource | null }
export interface PanelEvidenceFile {
  path: string;
  kind: 'observed' | 'reported';
  /** True when the ownership guard restored this change; null for a report. */
  restored: boolean | null;
  source: PanelEvidenceSource;
}
export interface PanelEvidenceVerification {
  name: string;
  status: 'passed' | 'failed' | 'reported' | 'recorded';
  detail: string;
  command: string | null;
  authority: 'guard' | 'builder' | 'lead' | 'critic' | 'unknown';
  source: PanelEvidenceSource;
}
export interface PanelEvidenceFinding {
  verdict: 'WIN' | 'LOSS' | 'BLOCKED';
  gap: string;
  evidence: string;
  source: PanelEvidenceSource;
}
export interface PanelEvidenceComparison {
  previousRound: number;
  /** Set differences in recorded file lists, never a claim of deletion from disk. */
  addedFiles: string[];
  removedFiles: string[];
  repeatedFindings: string[];
  newFindings: string[];
  /** Absence from a later report does not establish that a finding was fixed. */
  noLongerReported: string[];
  candidateChanged: boolean | null;
  candidateSources: { previous: PanelEvidenceSource; current: PanelEvidenceSource } | null;
  filesComparable: boolean;
  findingsComparable: boolean;
}
export interface PanelEvidenceRound {
  piece: string | null;
  /** Null means the original record did not identify a round. */
  round: number | null;
  startedAt: number | null;
  endedAt: number | null;
  files: PanelEvidenceFile[];
  verification: PanelEvidenceVerification[];
  findings: PanelEvidenceFinding[];
  comparison: PanelEvidenceComparison | null;
  missing: string[];
}
export interface PanelRunEvidence {
  summary: {
    outcome: PanelEvidenceFact;
    currentActivity: PanelEvidenceFact;
    blockingReason: PanelEvidenceFact | null;
    nextAction: PanelEvidenceFact & { action: 'resume' | 'stop' | 'review' | 'wait' | 'new-run' };
  };
  rounds: PanelEvidenceRound[];
  warnings: string[];
  truncated: boolean;
}
