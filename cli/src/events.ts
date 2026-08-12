/**
 * What a run reports, as data.
 *
 * A run produces facts — a bar was captured, a piece was judged, the run ended
 * costing this much — and those facts are one thing; how they are shown on a
 * terminal or handed to CI is another. This file is the first thing only: a
 * closed union of plain values, with no renderer, no stream, and no SDK
 * anywhere in it.
 *
 * Keeping the two apart is what lets the human view and the `--json` view be
 * two readings of the same stream rather than two implementations that drift.
 * Nothing here decides anything about a run; every value is reported by the
 * caller that watched it happen.
 */

/** A critic's judgement on one round, in the vocabulary the critics report in. */
export type Verdict = 'WIN' | 'LOSS' | 'BLOCKED';

/**
 * How a run ended.
 *
 * The same four outcomes `exolvra-genesis help exit-codes` names: won, lost, blocked
 * before a verdict was reached, or stopped by a budget guard.
 */
export type RunStatus = 'win' | 'loss' | 'blocked' | 'stopped';

/** How loud a notice is, and the word it is labelled with. */
export type NoticeLevel = 'note' | 'warning' | 'error';

/** Whether the run was started from a written goal or from a spec file. */
export type GoalSource = 'goal' | 'spec';

/** One captured piece of the bar. */
export interface BarArtifact {
  /** Where the capture was written. */
  path: string;
  /** What it is the bar for, one line. */
  detail?: string;
}

/** One piece of the plan, as it will be referred to by every round. */
export interface PlanPiece {
  /** Short identifier a round line is keyed by, such as `P2`. */
  id: string;
  /** What the piece builds, one line. */
  title: string;
}

/** The run began, against this goal. */
export interface RunStartedEvent {
  type: 'run_started';
  /** The goal as written, or the path to the spec file it was read from. */
  goal: string;
  source: GoalSource;
}

/** The bar is on disk and is now fixed for the run. */
export interface BarCapturedEvent {
  type: 'bar_captured';
  /** The captured bar's root — the file or directory a critic loads first. */
  path: string;
  artifacts: readonly BarArtifact[];
}

/** The goal has been decomposed and the pieces are known. */
export interface PlanReadyEvent {
  type: 'plan_ready';
  pieces: readonly PlanPiece[];
}

/**
 * One piece was judged once.
 *
 * The event of the stream: everything else is preamble, detail, or the closing
 * total. It carries what was judged, which round of it this was, what the
 * verdict was, and — when the verdict was not a win — the one gap that decided
 * it, in the critic's own words.
 */
export interface RoundEvent {
  type: 'round';
  /** The {@link PlanPiece.id} this round was judged for. */
  piece: string;
  /** Which round of that piece this was, counting from 1. */
  round: number;
  verdict: Verdict;
  /** The single biggest gap, one sentence, as the critic wrote it. */
  gap?: string;
  /** How long the round took, milliseconds. */
  elapsedMs?: number;
}

/**
 * What an agent wrote, verbatim.
 *
 * Whole reports, many lines long. They are part of the stream so that a run can
 * be followed in full, and they are the one thing the human view holds back
 * unless it was asked for them.
 */
export interface AgentOutputEvent {
  type: 'agent_output';
  /** The agent's name, as the plugin markdown declares it. */
  agent: string;
  /** The piece it was working on, when it was working on one. */
  piece?: string;
  /** The round it was working on, when it was working on one. */
  round?: number;
  /** The text as the agent produced it. */
  text: string;
}

/** Something worth saying that is not a verdict. */
export interface NoticeEvent {
  type: 'notice';
  level: NoticeLevel;
  message: string;
  /**
   * True when this notice is a command, and so must not be folded.
   *
   * A line folded inside the interactive frame is folded with the rail drawn
   * down the middle of it, so a command copied off two rows arrives with a `│`
   * in it and does not run. Left whole, the terminal soft-wraps it, which costs
   * a ragged row and keeps the line one line to anything selecting it.
   *
   * It is a hint to the framed view and to nothing else: the piped and `--json`
   * views carry every message whole already, so neither reads this.
   */
  keepWhole?: boolean;
}

/**
 * The run is over.
 *
 * Its four fields are the summary contract: the last line of `--json` output is
 * this event and nothing else, so a CI job can read the outcome, the work done,
 * what it cost, and the session to resume from, off one line.
 */
export interface RunFinishedEvent {
  type: 'run_finished';
  status: RunStatus;
  /** Rounds judged across every piece. */
  rounds: number;
  /** What the run cost, US dollars. */
  costUsd: number;
  /** The session the run can be resumed from, when there is one. */
  sessionId?: string;
}

/** Everything a run reports. */
export type RunEvent =
  | RunStartedEvent
  | BarCapturedEvent
  | PlanReadyEvent
  | RoundEvent
  | AgentOutputEvent
  | NoticeEvent
  | RunFinishedEvent;

/** The discriminant of {@link RunEvent}. */
export type RunEventType = RunEvent['type'];

/**
 * The union's tags, as a value.
 *
 * `satisfies Record<RunEventType, true>` makes this exact in both directions:
 * a tag added to the union and not to this table fails to compile, and so does
 * a tag here that the union does not have. A renderer can therefore be checked
 * against every event that exists rather than against the ones its author
 * remembered.
 */
const EVENT_TYPES = {
  run_started: true,
  bar_captured: true,
  plan_ready: true,
  round: true,
  agent_output: true,
  notice: true,
  run_finished: true,
} as const satisfies Record<RunEventType, true>;

export const RUN_EVENT_TYPES = Object.keys(EVENT_TYPES) as readonly RunEventType[];

/** The verdicts a round can carry. */
export const VERDICTS: readonly Verdict[] = ['WIN', 'LOSS', 'BLOCKED'];

/** The statuses a run can end with. */
export const RUN_STATUSES: readonly RunStatus[] = ['win', 'loss', 'blocked', 'stopped'];
