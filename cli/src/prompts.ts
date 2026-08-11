/**
 * The interactive surface: the startup questions, and the frames the run draws.
 *
 * Everything that touches the prompt library lives here, so there is exactly one
 * place that knows which library that is (C2 allows precisely one) and exactly
 * one place that decides whether prompting is allowed at all.
 *
 * Two invariants hold across every export:
 *
 * - **Streams are arguments, never globals.** Each function is handed the
 *   terminal it draws on; nothing here reaches for the process's own. That is
 *   what keeps a command's output countable in one place, and it is what lets a
 *   test drive the real flow against a fake TTY and read back the frames a user
 *   would see, instead of asserting on a description of them.
 * - **A non-TTY is never prompted.** {@link promptStartup} throws rather than
 *   ask a question nothing can answer; a piped or CI run resolves its answers
 *   from flags and config alone ({@link startupFromDefaults}). A prompt written
 *   to a pipe is a hang, and a hung run in CI looks like a slow one.
 */
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts';

import type { BarArtifact, PlanPiece, RunEvent } from './events.js';
import { ConfigError, UsageError } from './exit.js';
import {
  AGENT_MODELS,
  DEFAULT_MODEL_CHOICE,
  MODEL_INHERIT,
  asAgentModel,
  isKnownModel,
  listModels,
} from './models.js';
import type { AgentModel, ModelChoice } from './models.js';
import type { Reporter } from './output.js';
import type { Progress } from './usage.js';
import { displayWidth, plainText, printable, truncate, wrapText } from './usage.js';

/** The terminal a prompt reads from and draws to. */
export interface PromptStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

/**
 * What startup already knows before it asks: flags on the command line, then the
 * saved config underneath them. Each one pre-selects its question rather than
 * skipping it — the answer shown is the answer that lands if you press Enter.
 */
export interface StartupDefaults {
  input?: string;
  models?: ModelChoice;
  auto?: boolean;
}

/** What startup settled on: everything a run needs to begin. */
export interface StartupChoices {
  /** The goal, or a path to a spec file. */
  input: string;
  models: ModelChoice;
  /** True when the loop starts without pausing to review the bar. */
  auto: boolean;
}

/** One aligned line of the run-plan note. */
export interface PlanRow {
  label: string;
  value: string;
}

/** How a round ended, for the one line it gets. */
export type Verdict = 'win' | 'loss' | 'blocked';

/**
 * Which questions to put, when some of the answers are already in.
 *
 * A field left undefined is asked. A run started with every answer on the
 * command line is a run that has already been told everything, and asking it
 * back would be a form to fill in before doing what was asked — so a question
 * whose answer is settled is not put at all.
 */
export interface StartupAsk {
  input?: boolean;
  lead?: boolean;
  builder?: boolean;
  critic?: boolean;
  mode?: boolean;
}

/** Every question, which is what a run with nothing supplied is asked. */
const ASK_EVERYTHING: Required<StartupAsk> = {
  input: true,
  lead: true,
  builder: true,
  critic: true,
  mode: true,
};

/**
 * Ctrl+C at a prompt.
 *
 * Not a fault: the user asked to stop before anything started, so the cancel
 * frame is already on screen and there is nothing left to report. The caller
 * exits 1 — the run was stopped (C5) — and prints nothing further. Use
 * {@link isPromptCancelled} to tell it apart from a real failure, which does
 * deserve a message.
 */
export class PromptCancelledError extends Error {
  constructor(message = 'cancelled at a prompt') {
    super(message);
    this.name = 'PromptCancelledError';
  }
}

export function isPromptCancelled(error: unknown): error is PromptCancelledError {
  return error instanceof PromptCancelledError;
}

/**
 * Whether a question can be asked here: both ends must be a terminal.
 *
 * Output alone is not enough — a run whose stdin is a pipe has no one to answer,
 * and one whose stdout is a pipe would render its frames into whatever is
 * reading them.
 */
export function isInteractive(streams: PromptStreams): boolean {
  return streams.input.isTTY === true && streams.output.isTTY === true;
}

/**
 * What is true when somebody stops at a question before anything has begun.
 *
 * True only there. A question put in the middle of a run is a question with a
 * run behind it — recorded, billed, and resumable — and saying "nothing saved"
 * over one of those is the CLI telling the user something about their money
 * that is not so. Every prompt that has a run behind it passes `false` and
 * closes the frame itself, with what actually exists.
 */
const NOTHING_STARTED = 'Cancelled — no run started, nothing saved.';

/**
 * Awaits one prompt, turning the library's cancel sentinel into a thrown
 * {@link PromptCancelledError} after closing the frame.
 *
 * The close matters: a cancelled prompt that is not closed leaves the rail
 * dangling and the cursor hidden. `closeWith` is `false` for a prompt whose
 * caller has something to say first — a run to record and a line to print —
 * and that caller closes the frame instead.
 */
async function put<T>(
  pending: Promise<T | symbol>,
  output: NodeJS.WriteStream,
  closeWith: string | false = NOTHING_STARTED,
): Promise<T> {
  const answer = await pending;
  if (isCancel(answer)) {
    if (closeWith !== false) cancel(closeWith, { output });
    throw new PromptCancelledError();
  }
  // `isCancel` is a `value is symbol` guard, which cannot narrow an unresolved
  // generic; the guard above is what makes this cast sound.
  return answer as T;
}

interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A hint as a picker draws one: a phrase under a row, not a sentence.
 *
 * Lowercased at the front, because that is what it is — the tail of the row it
 * hangs off, in the casing every other hint on the screen is written in. Only
 * the first character, so a name that starts one keeps its own capital.
 */
function asHint(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** The versioned ids, for the one role whose model is chosen by version. */
function idOptions(): PickerOption[] {
  return listModels().map((model) => ({
    value: model.value,
    label: model.label,
    ...(model.hint === undefined ? {} : { hint: asHint(model.hint) }),
  }));
}

/**
 * How each family reads on screen.
 *
 * The families themselves come from `models.ts`; only the wording is here, and
 * it is written so a row never implies a version. This map is exhaustive over
 * {@link AgentModel} on purpose: a family added there stops compiling here until
 * it has been given something to say for itself.
 */
const FAMILY_COPY: Record<AgentModel, { label: string; hint: string }> = {
  inherit: { label: 'Inherit', hint: 'Whatever the calling session runs on' },
  opus: { label: 'Opus', hint: 'The strongest family; the session settles the version' },
  sonnet: { label: 'Sonnet', hint: 'Balanced, and where most of a run\'s tokens go' },
  haiku: { label: 'Haiku', hint: 'The fastest and cheapest family' },
};

/** The families, for the two roles the SDK can only pin to one. */
function familyOptions(): PickerOption[] {
  return AGENT_MODELS.map((family) => ({
    value: family,
    label: FAMILY_COPY[family].label,
    hint: asHint(FAMILY_COPY[family].hint),
  }));
}

/**
 * The interactive startup flow: goal, three model pickers, then the mode.
 *
 * The pickers do not all offer the same thing, because the CLI does not accept
 * the same thing for all three roles. The lead runs a session, which carries a
 * versioned model id; a builder and a critic are subagents, which the SDK can
 * only pin to a family. Offering ids for those two would be offering answers the
 * next command rejects — so each picker lists exactly what its role's flag takes.
 *
 * Throws {@link ConfigError} rather than prompt when the terminal cannot answer,
 * and {@link PromptCancelledError} when the user stops partway. It returns
 * choices and nothing else — persisting them is the caller's call, because
 * `--no-config` has to be able to skip it.
 */
export async function promptStartup(
  defaults: StartupDefaults,
  io: PromptStreams,
  ask: StartupAsk = ASK_EVERYTHING,
): Promise<StartupChoices> {
  if (!isInteractive(io)) {
    throw new ConfigError(
      'refusing to prompt: standard input is not a terminal. ' +
        'Pass the goal or spec path as an argument, and the models as flags.',
    );
  }

  const on = { input: io.input, output: io.output };
  const ids = idOptions();
  const families = familyOptions();
  const saved = defaults.models ?? DEFAULT_MODEL_CHOICE;
  // A default that names nothing this picker offers selects nothing, rather than
  // pre-selecting the first row as though the saved answer had been honoured.
  const savedId = isKnownModel(saved.lead) ? saved.lead : MODEL_INHERIT;
  const savedFamily = (value: string): string => asAgentModel(value) ?? MODEL_INHERIT;

  const input =
    ask.input === false
      ? (defaults.input ?? '')
      : await put(
          text({
            message: 'What are we building?',
            placeholder: 'a goal, or a path to a spec file',
            ...(defaults.input === undefined ? {} : { initialValue: defaults.input }),
            validate: (value: string | undefined) =>
              (value ?? '').trim() === ''
                ? 'A goal or a path to a spec file is required.'
                : undefined,
            ...on,
          }),
          io.output,
        );

  const lead =
    ask.lead === false
      ? savedId
      : await put(
          select({ message: 'Lead model', options: ids, initialValue: savedId, ...on }),
          io.output,
        );
  const builder =
    ask.builder === false
      ? savedFamily(saved.builder)
      : await put(
          select({
            message: 'Builder model family',
            options: families,
            initialValue: savedFamily(saved.builder),
            ...on,
          }),
          io.output,
        );
  const critic =
    ask.critic === false
      ? savedFamily(saved.critic)
      : await put(
          select({
            message: 'Critic model family',
            options: families,
            initialValue: savedFamily(saved.critic),
            ...on,
          }),
          io.output,
        );

  const review =
    ask.mode === false
      ? defaults.auto !== true
      : await put(
          confirm({
            message: 'Review the bar before the loop starts?',
            initialValue: defaults.auto === undefined ? true : !defaults.auto,
            ...on,
          }),
          io.output,
        );

  return { input: input.trim(), models: { lead, builder, critic }, auto: !review };
}

/**
 * Opens the frame every interactive run is drawn inside.
 *
 * The frame belongs to the run rather than to the questionnaire: a run that had
 * every answer on the command line asks nothing and still has a beginning, and
 * a `┌` that only appears when a question happens to be asked is a frame that
 * closes on runs it never opened for.
 */
export function beginRun(title: string, io: PromptStreams): void {
  intro(title, { output: io.output });
}

/**
 * Puts one yes/no question, inside the frame, in the same language every other
 * question here is asked in.
 *
 * `progress` is not optional and not a convenience: a spinner redrawing on a
 * timer erases the question several times a second, and the person answering is
 * left typing into a line that keeps being wiped. Suspending it is part of
 * asking, so it is done here rather than remembered at each call site.
 */
export async function askConfirm(
  message: string,
  io: PromptStreams,
  options: { initial?: boolean; progress?: Progress; closeWith?: string | false } = {},
): Promise<boolean> {
  options.progress?.suspend();
  try {
    return await put(
      confirm({
        message,
        initialValue: options.initial ?? true,
        input: io.input,
        output: io.output,
      }),
      io.output,
      options.closeWith,
    );
  } finally {
    options.progress?.resume();
  }
}

/** One row of a picker: the value, what it reads as, and the detail under it. */
export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

/** Puts one list question, inside the frame, and answers with what was picked. */
export async function askChoice(
  message: string,
  choices: readonly Choice[],
  io: PromptStreams,
  options: { initial?: string; progress?: Progress } = {},
): Promise<string> {
  options.progress?.suspend();
  try {
    return await put(
      select({
        message,
        options: [...choices],
        ...(options.initial === undefined ? {} : { initialValue: options.initial }),
        input: io.input,
        output: io.output,
      }),
      io.output,
    );
  } finally {
    options.progress?.resume();
  }
}

/**
 * The same answers, resolved without asking — the non-TTY path.
 *
 * Review mode is not among them. It is a pause for a confirmation that only a
 * terminal can give, so a piped run is always `auto`, whatever the config says
 * (R4). A saved preference must not be able to wedge a CI run.
 */
export function startupFromDefaults(defaults: StartupDefaults = {}): StartupChoices {
  const input = (defaults.input ?? '').trim();
  if (input === '') {
    throw new UsageError(
      'nothing to run: pass a goal or a path to a spec file (there is no terminal here to ask)',
    );
  }
  const models = defaults.models ?? DEFAULT_MODEL_CHOICE;
  return {
    input,
    models: {
      lead: models.lead || MODEL_INHERIT,
      builder: models.builder || MODEL_INHERIT,
      critic: models.critic || MODEL_INHERIT,
    },
    auto: true,
  };
}

/** Asks when there is someone to ask, and resolves from what it has when there is not. */
export async function resolveStartup(
  defaults: StartupDefaults,
  io: PromptStreams,
): Promise<StartupChoices> {
  return isInteractive(io) ? promptStartup(defaults, io) : startupFromDefaults(defaults);
}

/**
 * The boxed summary drawn once startup settles: what is about to run, under a
 * titled rule. Labels are padded to a common width so the values read as a
 * column rather than as a list of sentences.
 */
export function noteRunPlan(rows: readonly PlanRow[], title: string, io: PromptStreams): void {
  const label = rows.reduce((widest, row) => Math.max(widest, row.label.length), 0);
  /*
   * One discipline for a value too long for the box, not two.
   *
   * Left to itself the box folds a long value onto a second line and then cuts
   * that line as well, so the reader gets neither the whole value nor a clean
   * end to it — a path arrives in two pieces, both wrong. A row is one line: it
   * is cut once, on a character boundary, and the ellipsis says it was cut.
   * Anything that has to be whole is in the report, in `--json`, and on disk.
   */
  const columns = (io.output as Partial<NodeJS.WriteStream>).columns;
  const box = typeof columns === 'number' && columns > 0 ? columns : 80;
  const room = Math.max(8, box - 6 - label - 2);
  const body = rows
    .map((row) => row.label.padEnd(label) + '  ' + truncate(plainText(row.value), room))
    .join('\n');
  note(body, title, { output: io.output });
}

/**
 * Runs one step under a spinner, replacing it with `done` when the work resolves
 * and marking it failed when it throws. The step's value passes straight
 * through, so wrapping a call in it changes what the terminal shows and nothing
 * about what the caller gets.
 */
export async function trackStep<T>(
  label: string,
  done: string,
  work: () => Promise<T>,
  io: PromptStreams,
): Promise<T> {
  const step = spinner({ input: io.input, output: io.output });
  step.start(label);
  try {
    const result = await work();
    step.stop(done);
    return result;
  } catch (error) {
    // Leave the failure on screen: a spinner that simply stops reads as success.
    step.error(label + ' — failed');
    throw error;
  }
}

/** One round, one line: green for a win, amber for a loss, red for a block. */
export function logVerdict(line: string, verdict: Verdict, io: PromptStreams): void {
  const on = { output: io.output };
  if (verdict === 'win') log.success(line, on);
  else if (verdict === 'blocked') log.error(line, on);
  else log.warn(line, on);
}

/** Closes the frame. */
export function endRun(message: string, io: PromptStreams): void {
  outro(message, { output: io.output });
}

/* -------------------------------------------------------------------------- */
/* The run, drawn inside the frame                                             */
/* -------------------------------------------------------------------------- */

/** Narrowest and widest the piece column is allowed to be. */
const PIECE_MIN = 4;
const PIECE_MAX = 16;

/** Widest verdict word, so the gaps after them line up. */
const VERDICT_COLUMN = 7;

/**
 * The interactive surface a run is reported on.
 *
 * A {@link Reporter}, so a run reports the same events whoever is reading them,
 * plus the two things a frame has that a stream does not: a beginning it can be
 * asked a question inside, and an end.
 */
export interface RunFrame extends Reporter {
  /** Draws the run-plan box, once, as soon as there is a plan to draw. */
  showPlan(): void;
  /** Puts a question inside the frame, with the progress line suspended. */
  confirm(message: string, initial?: boolean): Promise<boolean>;
  /** Closes the frame with `└`, whatever the run turned out to be. */
  close(message: string): void;
}

export interface RunFrameOptions {
  verbose: boolean;
  /** Suspended around every question this frame puts. */
  progress?: Progress;
}

function plural(count: number, noun: string): string {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

/** A tab, kept: a report aligned with them stays aligned. */
const TAB = '\t';

/**
 * What an agent wrote, split into the lines it wrote.
 *
 * The same rule the piped and JSON views already follow, applied to the frame:
 * a report is many lines, its structure is carried by its indentation, and a
 * command in it is meant to be copied off the screen. Flattening it to one
 * line — which is what reading it as a *field* does — destroys all three, and
 * hands the prompt library a single line so long that every row it wraps loses
 * the rail it should have been drawn against. Clack splits on the newline and
 * rails each line itself, so it is given the lines.
 *
 * Per line, the least that keeps a terminal safe and nothing more: escape
 * sequences and the control characters a terminal acts on are taken out,
 * because a report may not repaint the screen; tabs survive; every other byte
 * is the byte the agent wrote, spacing included.
 */
function verbatimLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A trailing newline ends the last line; it does not start another one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) =>
    line
      .split(TAB)
      .map((piece) => printable(piece))
      .join(TAB),
  );
}

/**
 * Renders a run as the clack frame the interactive surface is drawn in.
 *
 * What a person watching a run wants is the shape of it — what it is chasing,
 * what it broke the work into, and then one line per judgement — so the
 * preamble is collected and drawn once as a box rather than dribbled out a
 * label at a time, and every round after it is a single line with its verdict
 * in the left margin where an eye can run down it. Everything is written to the
 * frame's own stream, so the rails join up.
 */
export function createRunFrame(
  io: PromptStreams,
  options: RunFrameOptions,
): RunFrame {
  const on = { output: io.output };
  const rows: PlanRow[] = [];
  const pieces: PlanPiece[] = [];
  let planShown = false;
  let pieceWidth: number | null = null;

  const add = (label: string, value: string): void => {
    rows.push({ label, value: plainText(value) });
  };

  const fixPieceWidth = (widest: number): number => {
    pieceWidth ??= Math.min(PIECE_MAX, Math.max(PIECE_MIN, widest));
    return pieceWidth;
  };

  const showPlan = (): void => {
    if (planShown) return;
    planShown = true;
    if (rows.length > 0) noteRunPlan(rows, 'Run plan', io);
  };

  /**
   * How wide a line may be before it runs off the edge.
   *
   * Three columns of it belong to the mark and the gutter clack draws in front
   * of every line, so what is left is what a line has. Asked on each write,
   * because a terminal can be resized while a run is going.
   */
  const budget = (): number => {
    const columns = (io.output as Partial<NodeJS.WriteStream>).columns;
    const width = typeof columns === 'number' && columns > 0 ? columns : 80;
    return Math.max(20, width - 3);
  };

  /**
   * One round, one line: the piece, which round of it this was, the verdict,
   * and the gap.
   *
   * The gap is last and is the only part cut to fit, exactly as it is in the
   * column view — it is last so cutting it costs no other field a character,
   * and it is the field a reader can go to the piped or JSON view for in full.
   */
  const roundLine = (event: Extract<RunEvent, { type: 'round' }>): string => {
    const piece = plainText(event.piece);
    const width = fixPieceWidth(displayWidth(piece));
    const verdict = event.verdict;
    const head = [
      piece + ' '.repeat(Math.max(0, width - displayWidth(piece))),
      'round ' + event.round,
      verdict + ' '.repeat(Math.max(0, VERDICT_COLUMN - verdict.length)),
    ].join('  ');
    const gap = plainText(event.gap ?? '');
    if (gap === '') return head.trimEnd();
    return (head + '  ' + truncate(gap, Math.max(0, budget() - displayWidth(head) - 2))).trimEnd();
  };

  return {
    emit(event: RunEvent): void {
      switch (event.type) {
        case 'run_started':
          add(event.source === 'spec' ? 'spec' : 'goal', event.goal);
          return;
        case 'bar_captured': {
          const artifacts = (event.artifacts ?? []) as readonly BarArtifact[];
          add(
            'bar',
            artifacts.length === 0
              ? event.path
              : event.path + ' (' + plural(artifacts.length, 'artifact') + ')',
          );
          return;
        }
        case 'plan_ready': {
          pieces.push(...event.pieces);
          const ids = pieces.map((piece) => plainText(piece.id)).filter((id) => id !== '');
          if (ids.length > 0) {
            fixPieceWidth(ids.reduce((widest, id) => Math.max(widest, displayWidth(id)), 0));
          }
          add('pieces', ids.length === 0 ? plural(pieces.length, 'piece') : ids.join(', '));
          return;
        }
        case 'round':
          // The plan is settled by the time anything is judged, so the box is
          // drawn before the first verdict rather than after the last one.
          showPlan();
          logVerdict(
            roundLine(event),
            event.verdict === 'WIN' ? 'win' : event.verdict === 'BLOCKED' ? 'blocked' : 'loss',
            io,
          );
          return;
        case 'agent_output': {
          if (!options.verbose) return;
          showPlan();
          const lines = verbatimLines(event.text);
          if (lines.length === 0) return;
          // Handed over as lines, so the library rails every one of them.
          log.message(lines.join('\n'), on);
          return;
        }
        case 'notice': {
          /*
           * Wrapped, never cut.
           *
           * A notice is where the command to resume with is printed, and an id
           * with its end taken off is not a shorter id — it is one that cannot
           * be typed back in. So a notice too wide for the terminal is folded
           * onto the next line at a space, with a token longer than the line
           * left whole rather than split, and clack rails each line it is
           * handed. The gap on a round line is the one field that is still cut
           * to fit, because it is prose and the whole of it is a `--json` away.
           */
          const message = wrapText(plainText(event.message), budget(), 0, {
            breakWords: false,
          }).join('\n');
          // Before the plan is drawn, a note belongs in the box with the rest of
          // the preamble; after it, it is news and gets its own line.
          if (!planShown && event.level === 'note') {
            add('note', message);
            return;
          }
          if (event.level === 'error') log.error(message, on);
          else if (event.level === 'warning') log.warn(message, on);
          else log.info(message, on);
          return;
        }
        case 'run_finished':
          // The closing line is the caller's: it says what the run was, and the
          // caller is what knows that.
          showPlan();
          return;
        default:
          return;
      }
    },
    showPlan,
    confirm: (message: string, initial = true) =>
      askConfirm(message, io, {
        initial,
        // A question inside a running frame: the caller has a run to record and
        // a line to print before the rail closes, so it does the closing.
        closeWith: false,
        ...(options.progress === undefined ? {} : { progress: options.progress }),
      }),
    close(message: string): void {
      showPlan();
      endRun(truncate(plainText(message), budget()), io);
    },
  };
}
