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
