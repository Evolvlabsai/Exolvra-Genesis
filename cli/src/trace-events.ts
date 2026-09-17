/**
 * The trace event vocabulary: the closed set of everything a run can record.
 *
 * Every event passes through one chokepoint before it reaches the store, which
 * redacts secrets and flattens control characters. A new kind cannot skip this
 * funnel by accident: toRecord is the only way to build a record, and it
 * processes every string in the payload before returning.
 *
 * This file is data and pure functions. It imports the TraceRecord and
 * TraceProcess types from trace-store.ts and nothing else from that module. It
 * opens no file, knows nothing about the SDK, and never decides anything — the
 * trace is a mirror, not a source of truth.
 */

import type { TraceRecord, TraceProcess } from './trace-store.js';
import { redactSecrets } from './github.js';
import { plainText } from './usage.js';

/* -------------------------------------------------------------------------- */
/* The closed vocabulary: twelve event kinds (bar number N2)                   */
/* -------------------------------------------------------------------------- */

/** The event kinds the trace can carry. */
export type TraceEventKind =
  | 'run_started'
  | 'run_finished'
  | 'piece_dispatched'
  | 'builder_round_started'
  | 'builder_round_ended'
  | 'critic_dispatched'
  | 'verdict_recorded'
  | 'gate_check'
  | 'pin_check'
  | 'budget_spend'
  | 'error_path'
  | 'process_event';
// Activity is observational and must never be counted as an integrity gate.
export type LiveEventKind = 'activity' | 'stalled' | 'budget_warning';

/**
 * The union's tags, as a value.
 *
 * `satisfies Record<TraceEventKind, true>` makes this exact in both directions:
 * a tag added to the union and not to this table fails to compile, and so does
 * a tag here that the union does not have.
 */
export const TRACE_EVENT_KINDS = {
  run_started: true,
  run_finished: true,
  piece_dispatched: true,
  builder_round_started: true,
  builder_round_ended: true,
  critic_dispatched: true,
  verdict_recorded: true,
  gate_check: true,
  pin_check: true,
  budget_spend: true,
  error_path: true,
  process_event: true,
  activity: true,
  stalled: true,
  budget_warning: true,
} as const satisfies Record<TraceEventKind | LiveEventKind, true>;

/* -------------------------------------------------------------------------- */
/* Typed payloads for each event kind                                          */
/* -------------------------------------------------------------------------- */

export interface RunStartedPayload {
  goal: string;
  source: 'goal' | 'spec';
}

export interface RunFinishedPayload {
  status: 'win' | 'loss' | 'blocked' | 'stopped';
  rounds: number;
  costUsd: number;
  sessionId?: string;
}

export interface PieceDispatchedPayload {
  pieceId: string;
  title: string;
}

export interface BuilderRoundStartedPayload {
  attempt: number;
}

export interface BuilderRoundEndedPayload {
  attempt: number;
  verbatimVerification: boolean;
  verificationOutput?: string;
  /** A producer report is a claim, never proof that the lead reran it. */
  source?: 'builder-report';
  reportedFiles?: string[];
  verificationCommands?: string[];
  truncated?: boolean;
}

/** Optional observations enrich existing event kinds without deciding the loop. */
export type RunObservation =
  | { type: 'file_changes'; source: 'ownership-snapshot'; files: string[]; restored: string[]; violations: string[] }
  | { type: 'verification'; source: 'sdk-tool-result'; purpose: 'command'; role: 'lead' | 'builder' | 'critic' | 'unknown'; tool: 'Bash'; toolUseId: string; command: string; output: string; isError?: boolean; truncated?: boolean }
  | { type: 'critic_report'; source: 'critic-report'; criticId: string; verdict?: 'WIN' | 'LOSS' | 'BLOCKED'; gap?: string; evidence?: string; isError?: boolean; truncated?: boolean };

export interface CriticDispatchedPayload {
  criticId: string;
}

export interface VerdictRecordedPayload {
  verdict: 'WIN' | 'LOSS' | 'BLOCKED';
  gap?: string;
}

export interface GateCheckPayload {
  gate: string;
  passed: boolean;
  detail?: string;
}

export interface PinCheckPayload {
  pin: string;
  passed: boolean;
  detail?: string;
}

export interface BudgetSpendPayload {
  /** Provider totals are session-scoped unless the transport isolates a round. */
  attribution?: 'session' | 'round' | 'preflight';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ErrorPathPayload {
  fault: string;
  detail?: string;
}

export interface ProcessEventPayload {
  action: 'opened' | 'closed';
  taskId: string;
  role: 'lead' | 'builder' | 'critic';
  outcome?: 'complete' | 'failed' | 'died';
}

/* -------------------------------------------------------------------------- */
/* The closed union of all trace events                                        */
/* -------------------------------------------------------------------------- */

interface BaseTraceEvent<K extends TraceEventKind, P> {
  kind: K;
  piece?: string | null;
  round?: number;
  payload: P;
}

export type RunStartedEvent = BaseTraceEvent<'run_started', RunStartedPayload>;
export type RunFinishedEvent = BaseTraceEvent<'run_finished', RunFinishedPayload>;
export type PieceDispatchedEvent = BaseTraceEvent<'piece_dispatched', PieceDispatchedPayload>;
export type BuilderRoundStartedEvent = BaseTraceEvent<'builder_round_started', BuilderRoundStartedPayload>;
export type BuilderRoundEndedEvent = BaseTraceEvent<'builder_round_ended', BuilderRoundEndedPayload>;
export type CriticDispatchedEvent = BaseTraceEvent<'critic_dispatched', CriticDispatchedPayload>;
export type VerdictRecordedEvent = BaseTraceEvent<'verdict_recorded', VerdictRecordedPayload>;
export type GateCheckEvent = BaseTraceEvent<'gate_check', GateCheckPayload>;
export type PinCheckEvent = BaseTraceEvent<'pin_check', PinCheckPayload>;
export type BudgetSpendEvent = BaseTraceEvent<'budget_spend', BudgetSpendPayload>;
export type ErrorPathEvent = BaseTraceEvent<'error_path', ErrorPathPayload>;
export type ProcessEventType = BaseTraceEvent<'process_event', ProcessEventPayload>;

export type TraceEvent =
  | { kind: LiveEventKind; piece?: string | null; round?: number; payload: { detail: string; phase?: string; budget?: { spentUsd: number; maxCostUsd?: number; rounds: number; maxRounds?: number }; tokens?: { inputTokens: number; outputTokens: number }; evidence?: RunObservation } }
  | RunStartedEvent
  | RunFinishedEvent
  | PieceDispatchedEvent
  | BuilderRoundStartedEvent
  | BuilderRoundEndedEvent
  | CriticDispatchedEvent
  | VerdictRecordedEvent
  | GateCheckEvent
  | PinCheckEvent
  | BudgetSpendEvent
  | ErrorPathEvent
  | ProcessEventType;

/* -------------------------------------------------------------------------- */
/* Event context — what every event is stamped with                            */
/* -------------------------------------------------------------------------- */

export interface TraceContext {
  runId: string;
  at?: number;
}

/* -------------------------------------------------------------------------- */
/* The redaction funnel — C5: every payload passes through this                */
/* -------------------------------------------------------------------------- */

/**
 * Normalises fullwidth and other variant forms to their ASCII equivalents.
 * Applied BEFORE redaction so decorated tokens are caught.
 */
function normalizeVariants(text: string): string {
  // NFKC normalisation folds fullwidth ASCII (U+FF01..U+FF5E) to ASCII,
  // decomposes ligatures, and normalises many other variant forms.
  return text.normalize('NFKC');
}

/**
 * Bidi control characters: directional overrides and isolates.
 * These can hide or reorder text and must be stripped.
 * U+202A-U+202E (LRE, RLE, PDF, LRO, RLO) and U+2066-U+2069 (LRI, RLI, FSI, PDI).
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * Sanitises one string for persistence.
 *
 * **Redaction runs last, and that ordering is the invariant this function
 * exists to hold.** Every step before it either folds a character to another
 * (NFKC) or deletes it outright (ANSI escapes, lone surrogates, bidi controls);
 * a deletion is exactly what splices a secret back together, because the two
 * halves either side of the deleted character close up into one run. Redaction
 * placed anywhere but last therefore inspects a string that is not the string
 * being stored, and a token carrying one of those characters early enough
 * survives: the leading run is then too short to match a token shape, nothing
 * is replaced, and the later deletion fuses the halves into a live credential
 * on disk. Redaction is safe as the final step because it only ever *removes* —
 * it replaces a matched span with `[redacted]`, which is printable ASCII and
 * introduces nothing a later step would have had to clean up.
 *
 * The order, therefore:
 * 1. Normalise variant forms, so a fullwidth-decorated token reads as ASCII.
 * 2. Flatten to printable: ANSI escapes and lone surrogates are deleted,
 *    line/paragraph separators, newlines and tabs become spaces.
 * 3. Strip bidi controls, which `plainText` leaves alone.
 * 4. Redact secrets, over the exact bytes about to be written.
 *
 * `trace-adversarial.test.js` pins this by splicing an ANSI escape through
 * every position of a real token shape and driving it through the binary: an
 * ordering that redacts before step 2 or 3 fails there.
 */
function sanitizeString(value: string): string {
  const normalized = normalizeVariants(value);
  const flattened = plainText(normalized);
  // Strip bidi controls (not covered by plainText's CONTROL_CHARS range)
  const withoutBidi = flattened.replace(BIDI_CONTROLS, '');
  return redactSecrets(withoutBidi);
}

/**
 * Recursively sanitises every string in a value.
 *
 * Objects are cloned; arrays are mapped. Every string found anywhere in the
 * tree passes through sanitizeString. Non-string primitives pass through
 * unchanged.
 *
 * **Keys go through the funnel too.** A key is a string that reaches disk
 * exactly as a value does — `JSON.stringify` writes both — so a payload built
 * from model output or from a map keyed by something a user typed can carry a
 * secret in the key position just as easily as in the value position. Copying
 * keys verbatim while sanitising values would leave a hole in the one funnel
 * C5 says everything passes through.
 *
 * Two keys that sanitise to the same string collapse into one, last write
 * winning, exactly as two identical keys in a source object would. That is a
 * lossy answer and it is the right one: the alternative is writing a key this
 * module has decided is unsafe.
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      result[sanitizeString(key)] = sanitizeValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/**
 * Sanitises an entire payload. This is the one funnel that every payload
 * passes through — a new event kind cannot skip it by accident.
 */
function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(payload) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* toRecord: the only way to build a trace record from an event                */
/* -------------------------------------------------------------------------- */

/**
 * Stamps an event with run id, piece, round, and time, redacts and flattens
 * every string in the payload, and returns a record ready for the store.
 *
 * The returned record lacks `seq` — the store assigns that on append.
 */
export function toRecord(event: TraceEvent, ctx: TraceContext): Omit<TraceRecord, 'seq'> {
  const sanitizedPayload = sanitizePayload(event.payload as unknown as Record<string, unknown>);

  // The piece field may contain hostile content too — it passes through the same funnel.
  // Only strings go through the sanitiser; null and undefined both become null.
  const sanitizedPiece = typeof event.piece === 'string' ? sanitizeString(event.piece) : null;

  return {
    at: ctx.at ?? Date.now(),
    runId: ctx.runId,
    kind: event.kind,
    piece: sanitizedPiece,
    round: event.round ?? null,
    payload: sanitizedPayload,
  };
}

/* -------------------------------------------------------------------------- */
/* Process record constructors (R2)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Creates the fields for opening a process record.
 * Does not write — the caller passes this to store.openProcess().
 *
 * @param pid The OS process id opening this row, or null/undefined if not an OS process.
 */
export function openProcessRecord(
  runId: string,
  taskId: string,
  role: TraceProcess['role'],
  piece: string | null,
  round: number | null,
  pid?: number | null,
): Omit<TraceProcess, 'closedAt' | 'outcome'> {
  return {
    runId,
    taskId,
    role,
    piece,
    round,
    openedAt: Date.now(),
    pid: pid ?? null,
  };
}

/**
 * Creates the fields for a process that is being closed.
 * Does not write — the caller calls store.closeProcess().
 */
export function closeProcessOutcome(
  outcome: NonNullable<TraceProcess['outcome']>,
): NonNullable<TraceProcess['outcome']> {
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* Spend ledger (R5): accumulates cost and tokens per round and per piece      */
/* -------------------------------------------------------------------------- */

export interface RoundSpend {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface PieceSpend {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  rounds: Map<number, RoundSpend>;
}

export interface SpendLedger {
  /** Adds a spend record for a specific piece and round. */
  record(piece: string, round: number, spend: BudgetSpendPayload): void;
  /** Returns the total spend for a piece across all its rounds. */
  pieceTotal(piece: string): RoundSpend;
  /** Returns the spend for a specific round of a piece. */
  roundTotal(piece: string, round: number): RoundSpend;
  /** Returns the total spend for the entire run. */
  runTotal(): RoundSpend;
  /** Returns all pieces that have recorded spend. */
  pieces(): readonly string[];
}

const ZERO_SPEND: RoundSpend = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

/**
 * Creates a spend ledger that accumulates cost and tokens.
 *
 * Spend is added, not overwritten: a round attempted three times at 0.10, 0.20,
 * and 0.05 reports 0.35 for that round, not 0.05. The piece total is the sum of
 * its rounds; the run total is the sum of its pieces. Cost is what was
 * reported, not re-derived from a local price table.
 */
export function createSpendLedger(): SpendLedger {
  const byPiece = new Map<string, PieceSpend>();

  function ensurePiece(piece: string): PieceSpend {
    let ps = byPiece.get(piece);
    if (ps === undefined) {
      ps = { inputTokens: 0, outputTokens: 0, costUsd: 0, rounds: new Map() };
      byPiece.set(piece, ps);
    }
    return ps;
  }

  function ensureRound(ps: PieceSpend, round: number): RoundSpend {
    let rs = ps.rounds.get(round);
    if (rs === undefined) {
      rs = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      ps.rounds.set(round, rs);
    }
    return rs;
  }

  return {
    record(piece: string, round: number, spend: BudgetSpendPayload): void {
      const ps = ensurePiece(piece);
      const rs = ensureRound(ps, round);

      // Accumulate at the round level
      rs.inputTokens += spend.inputTokens;
      rs.outputTokens += spend.outputTokens;
      rs.costUsd += spend.costUsd;

      // Accumulate at the piece level
      ps.inputTokens += spend.inputTokens;
      ps.outputTokens += spend.outputTokens;
      ps.costUsd += spend.costUsd;
    },

    pieceTotal(piece: string): RoundSpend {
      const ps = byPiece.get(piece);
      if (ps === undefined) return { ...ZERO_SPEND };
      return {
        inputTokens: ps.inputTokens,
        outputTokens: ps.outputTokens,
        costUsd: ps.costUsd,
      };
    },

    roundTotal(piece: string, round: number): RoundSpend {
      const ps = byPiece.get(piece);
      if (ps === undefined) return { ...ZERO_SPEND };
      const rs = ps.rounds.get(round);
      if (rs === undefined) return { ...ZERO_SPEND };
      return { ...rs };
    },

    runTotal(): RoundSpend {
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      for (const ps of byPiece.values()) {
        inputTokens += ps.inputTokens;
        outputTokens += ps.outputTokens;
        costUsd += ps.costUsd;
      }
      return { inputTokens, outputTokens, costUsd };
    },

    pieces(): readonly string[] {
      return Array.from(byPiece.keys());
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Exports assertion — C1: nothing here reads a stored record to decide        */
/* -------------------------------------------------------------------------- */

// This file exports:
// - Type definitions (TraceEventKind, TraceEvent, etc.)
// - The TRACE_EVENT_KINDS table for exhaustiveness checking
// - toRecord: builds a record from an event (does not read)
// - openProcessRecord, closeProcessOutcome: build process records (do not read)
// - createSpendLedger: accumulates spend (does not read TraceRecord)
//
// No function in this file takes a TraceRecord and returns a decision.
// The trace is a mirror, never a source of truth.
