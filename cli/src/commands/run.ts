import { join, resolve } from 'node:path';

import { renderLeadPrompt } from '../agents.js';
import {
  type Budget,
  type BudgetTrip,
  costValue,
  createBudget,
  formatUsd,
} from '../budget.js';
import { configFromChoices, loadConfig, saveConfig } from '../config.js';
import type { ExolvraGenesisConfig } from '../config.js';
import type {
  BarArtifact,
  PlanPiece,
  RunStatus as OutcomeStatus,
  Verdict,
} from '../events.js';
import { VERDICTS } from '../events.js';
import { EXIT, UsageError } from '../exit.js';
import {
  type ResolvedInput,
  inputAsArgument,
  inputAsTyped,
  resolveInput,
} from '../input.js';
import {
  AGENT_MODELS,
  DEFAULT_MODEL_CHOICE,
  type AgentModel,
  type ModelChoice,
  assertAgentModel,
  listModels,
} from '../models.js';
import { openPath } from '../open.js';
import { type Reporter, createReporter } from '../output.js';
import { PLUGIN_DIR_ENV, loadPluginSources } from '../plugin-dir.js';
import type {
  PromptStreams,
  RunFrame,
  StartupAsk,
  StartupChoices,
  StartupDefaults,
} from '../prompts.js';
import {
  type ArgumentSpec,
  type BooleanFlagSpec,
  type Command,
  type Ctx,
  type EnvSpec,
  type FlagSpec,
  type ValueFlagSpec,
  type ValueType,
  choiceValue,
  countValue,
  directoryValue,
  inputValue,
  modelValue,
  parseInvocation,
  registerCommand,
} from '../registry.js';
import {
  RUN_DIR,
  type RunStatus as LedgerStatus,
  appendRun,
  newRunId,
  readState,
  updateRun,
  writeState,
} from '../runs-store.js';
import {
  type SdkMessage,
  type Session,
  type SessionResult,
  assistantText,
  createSession,
} from '../session.js';
import {
  PROGRAM,
  type Progress,
  type Viewport,
  printable,
  progressStream,
  renderCommandHelp,
  startProgress,
  wrapList,
  wrapText,
} from '../usage.js';
import { positionalTokens } from './resume.js';

/**
 * Generous, because a run is the real thing rather than a preview: the loop
 * spawns builders and critics round after round, and a limit that ended it
 * early would only ever have to be raised by hand.
 */
const DEFAULT_MAX_TURNS = 400;

/** What the progress line says while the loop runs. */
const PROGRESS_MESSAGE = 'Running';

/** The page the loop keeps up to date, under the directory the run happens in. */
const PROGRESS_PAGE = 'progress.html';

/**
 * How the progress page is named to the reader.
 *
 * Relative to the directory the run happens in when that is also the directory
 * the command was typed in, and in full when it is not. A path is one token to
 * whoever reads it back, and the short form is the one that still is at eighty
 * columns; the long form is the only one that means anything once --directory
 * has pointed the run somewhere else.
 */
export function progressPage(cwd: string, from: string): string {
  return cwd === resolve(from) ? RUN_DIR + '/' + PROGRESS_PAGE : join(cwd, RUN_DIR, PROGRESS_PAGE);
}

/**
 * The word the loaded command markdown reads as "do not pause for approval",
 * and the reply it waits for when it does pause. Both are the markdown's own
 * vocabulary, quoted rather than reimplemented: this CLI decides *whether* to
 * pause, and the file it loads decides what pausing means.
 */
const AUTO_PREFIX = 'auto';
const GO = 'go';

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;

/* -------------------------------------------------------------------------- */
/* Flags — each one declares the value type that validates it                  */
/* -------------------------------------------------------------------------- */

/**
 * A model family, which is the only thing the Claude Agent SDK can pin a
 * subagent to. Its rejection probe is a real model id, because that is the one
 * value `--model` must take and these two must refuse.
 */
const familyValue: ValueType<AgentModel> = {
  arg: 'family',
  choices: AGENT_MODELS,
  invalid: 'claude-opus-5',
  parse: (raw, ctx) => assertAgentModel(raw, ctx.flag, ctx.usage),
};

const modelFlag: ValueFlagSpec<string> = {
  long: 'model',
  short: 'm',
  value: modelValue,
  summary: 'Model id for the lead agent',
  default: 'inherit',
};

const builderModelFlag: ValueFlagSpec<AgentModel> = {
  long: 'builder-model',
  value: familyValue,
  summary: 'Model family for builder subagents',
  default: 'inherit',
};

const criticModelFlag: ValueFlagSpec<AgentModel> = {
  long: 'critic-model',
  value: familyValue,
  summary: 'Model family for critic subagents',
  default: 'inherit',
};

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Run in dir instead of the current directory',
};

const pluginDirFlag: ValueFlagSpec<string> = {
  long: 'plugin-dir',
  value: directoryValue,
  summary: 'Read the plugin markdown from dir, overriding ' + PLUGIN_DIR_ENV,
};

const maxTurnsFlag: ValueFlagSpec<number> = {
  long: 'max-turns',
  value: countValue,
  summary: 'Stop the run after int agent turns',
  default: DEFAULT_MAX_TURNS,
};

const maxRoundsFlag: ValueFlagSpec<number> = {
  long: 'max-rounds',
  value: countValue,
  summary: 'Stop the run once int rounds have been judged',
};

const maxCostFlag: ValueFlagSpec<number> = {
  long: 'max-cost',
  value: costValue,
  summary: 'Stop the run once it has cost usd dollars',
};

const permissionModeFlag: ValueFlagSpec<(typeof PERMISSION_MODES)[number]> = {
  long: 'permission-mode',
  value: choiceValue('mode', PERMISSION_MODES),
  summary: 'How the run may use tools',
  default: 'acceptEdits',
};

const autoFlag: BooleanFlagSpec = {
  long: 'auto',
  summary: 'Start the loop without pausing to review the bar',
};

const verboseFlag: BooleanFlagSpec = {
  long: 'verbose',
  short: 'v',
  summary: 'Print what the agents wrote, in full',
};

const jsonFlag: BooleanFlagSpec = {
  long: 'json',
  summary: 'Print one JSON object per event, and a summary object last',
};

const openFlag: BooleanFlagSpec = {
  long: 'open',
  summary: 'Open the progress page with the default handler',
};

const noConfigFlag: BooleanFlagSpec = {
  long: 'no-config',
  summary: 'Ignore the saved config, and do not write one',
};

const flags: FlagSpec[] = [
  autoFlag,
  modelFlag,
  builderModelFlag,
  criticModelFlag,
  directoryFlag,
  jsonFlag,
  maxCostFlag,
  maxRoundsFlag,
  maxTurnsFlag,
  noConfigFlag,
  openFlag,
  permissionModeFlag,
  pluginDirFlag,
  verboseFlag,
];

const runArgument: ArgumentSpec<ResolvedInput> = {
  name: 'goal-or-spec-path',
  value: inputValue,
};

const pluginDirEnv: EnvSpec<string> = {
  name: PLUGIN_DIR_ENV,
  value: directoryValue,
  overriddenBy: pluginDirFlag,
};

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

const runCommand: Command = {
  name: 'run',
  // What the command does, and not a word about how the loop decides anything:
  // when a run ends is settled in commands/run.md, and a summary that repeated
  // the rule would be a second copy of it to keep in step.
  summary: 'Start an Exolvra Genesis run and report each round as it is judged',
  usage: PROGRAM + ' run [<goal-or-spec-path>] [flags]',
  group: 'core',
  description: [
    'Start an Exolvra Genesis run and report each round as it is judged.',
    'run loads the commands/run.md it finds on disk and hands it your goal, then reports\nwhat comes back: the bar once it is captured, the pieces once the goal is decomposed,\nand one line per judged round. The loop itself lives in that markdown and in the two\nagent files beside it, so what this CLI does and what the plugin does cannot drift.',
    'A path to an existing file is read as a spec and becomes the source of truth for the\nrun. Failing that, a bare name matching one of this repository\'s named goals runs\nthat goal. Anything else is treated as a one-line goal, including a path that does\nnot exist: nothing is inferred from the shape of the text. An argument that is both\na file and a goal is refused rather than picked between — `exolvra-genesis goals --help`\nsets the order out in full.',
    'On a terminal, run asks for what it has not already been told, and for nothing else:\na goal given on the command line is not asked for again, nor is a model set by a flag\nor already saved in the config, and --auto declines the questionnaire outright. A run\nwith every answer in hand asks nothing at all. A flag beats a saved answer, and\nanything still unset is inherited from the session that spawns the agent. Piped,\nredirected, or run under --json it never asks, whatever is missing.',
    'Review is the default when it can be offered. The bar and the piece list print and the\nrun waits for you before a builder is spawned; --auto skips that pause, and so does any\nrun with nothing at the keyboard to answer it.',
    '--max-rounds and --max-cost stop a run cleanly at the limit rather than at the end of\nit: the run is recorded as stopped, the line that stopped it says which guard did, and\n`exolvra-genesis resume` picks it up from the session it was in. Ctrl+C does the same thing and\nprints the command to resume with; a second Ctrl+C exits at once.',
    'It exits 0 only when the run reports in .exolvra-genesis/state.json that it is complete. A run\nthat lost, was blocked, was stopped by a guard, or was interrupted exits 1, so resuming\nis the next step rather than a surprise.',
  ],
  flags,
  argument: runArgument,
  env: [pluginDirEnv],
  cwdFlag: directoryFlag,
  sections: [
    {
      title: 'MODELS',
      lines: [
        '  --model takes a model id:',
        '',
        ...wrapList(
          listModels().map((model) => model.value),
          4,
        ),
        '',
        '  --builder-model and --critic-model take a model family:',
        '',
        ...wrapList([...AGENT_MODELS], 4),
        '',
        ...wrapText(
          'A family is all the Claude Agent SDK can pin a subagent to, and it runs ' +
            'on whichever version the session that spawns the subagent resolves it ' +
            'to. A versioned id is refused there rather than read as its family, so ' +
            'no two models ever reach the provider as one request.',
          78,
          2,
        ),
      ],
    },
    {
      title: 'BUDGET',
      lines: [
        ...wrapText(
          '--max-rounds counts judged rounds across every piece. --max-cost is ' +
            'measured against what the provider itself reports the run costing, ' +
            'never against a price table kept here, so the figure a guard trips on ' +
            'is the figure you are billed for. The limit is handed to the provider ' +
            'as well, which is what lets a run be stopped at it rather than found ' +
            'to have passed it; the check here catches the gap between turns.',
          78,
          2,
        ),
        '',
        ...wrapText(
          'Either guard stops the run rather than failing it: the exit code is 1, ' +
            'the session id is recorded, and `' +
            PROGRAM +
            ' resume` continues it with the limit raised or taken off.',
          78,
          2,
        ),
        '',
        ...wrapText(
          'Neither guard can turn a win into a loss. A run that met its win ' +
            'condition exits 0 and is recorded complete even if it went over — the ' +
            'overrun is reported as a warning, because it is worth knowing what a ' +
            'run cost, and a verdict is not what a spending limit is for.',
          78,
          2,
        ),
      ],
    },
  ],
  examples: [
    PROGRAM + ' run specs/checkout.md',
    PROGRAM + ' run "a CLI whose help output is indistinguishable from gh"',
    PROGRAM + ' run --auto --max-rounds 12 --max-cost 20 specs/api.md',
    PROGRAM + ' run --json --auto specs/api.md > run.ndjson',
  ],
  run: runRun,
};

registerCommand(runCommand);

export { runCommand };

/**
 * The same command with its argument taken off, for an invocation that gave
 * none. A goal is required — but on a terminal it can be answered rather than
 * typed on the command line, and the two invocations are parsed against what
 * each really takes so the argument is still validated at the same boundary.
 */
const withoutArgument: Command = { ...runCommand, argument: undefined };

/* -------------------------------------------------------------------------- */
/* What the run reports back, and how this CLI reads it                        */
/* -------------------------------------------------------------------------- */

/**
 * The prefix that marks a line as being addressed to this CLI rather than to
 * the person reading along.
 */
const MARKER = '@exolvra-genesis';

/**
 * What the CLI asks to be told, and in what shape.
 *
 * Output shape only. Which steps run, what a round is, and when one is won are
 * settled in the markdown this text is appended to and are not restated here —
 * this says how to say that a thing happened, so a terminal can show a column
 * and a CI job can read a record, and nothing more.
 */
const REPORT_DIRECTIVE = [
  '---',
  '',
  'Reporting shape. Your progress is piped to a terminal or to a CI job, and this',
  'CLI lays it out. Alongside whatever you write for the reader, put these marker',
  'lines on lines of their own, with " | " between the fields:',
  '',
  '  ' + MARKER + ' bar <path to the captured bar>',
  '  ' + MARKER + ' artifact <path> | <one line on what it is the bar for>',
  '  ' + MARKER + ' piece <id> | <one line on what it builds>',
  '  ' + MARKER + ' round <piece id> | <number> | <WIN|LOSS|BLOCKED> | <gap>',
  '',
  'Emit the bar and artifact lines once the bar is pinned, one piece line per',
  'piece once they are known, and one round line the moment a judgement lands —',
  'never in advance of one, and never twice for the same round. The gap is the',
  'single sentence the critic gave, on one line, and is left empty on a WIN.',
  'Write nothing else on a marker line: everything else you have to say goes in',
  'the prose around them, as usual.',
].join('\n');

/** One thing the run said had happened, already checked for shape. */
type Marker =
  | { kind: 'bar'; path: string }
  | { kind: 'artifact'; path: string; detail: string }
  | { kind: 'piece'; id: string; title: string }
  | {
      kind: 'round';
      piece: string;
      round: number;
      verdict: Verdict;
      gap: string;
    };

/**
 * One piece of a message, in the order it was written.
 *
 * Order is the point. A message carries prose and markers interleaved, and a
 * reader watching a run needs the report that produced a verdict to appear
 * above the verdict — which is only true if the two are reported in the order
 * the agent wrote them, rather than all the markers and then all the prose.
 */
export type Segment =
  | { kind: 'prose'; text: string }
  | { kind: 'marker'; marker: Marker }
  | { kind: 'unreadable'; line: string };

export interface MarkerReading {
  markers: Marker[];
  /** The text with every marker line taken out, which is what a reader sees. */
  rest: string;
  segments: Segment[];
}

function asVerdict(value: string): Verdict | undefined {
  const word = value.trim().toUpperCase();
  return (VERDICTS as readonly string[]).includes(word)
    ? (word as Verdict)
    : undefined;
}

/**
 * Reads one marker line, or answers with nothing when it is not one this CLI
 * knows how to act on.
 *
 * The same rule the flag boundary follows, applied to the other end: what an
 * agent writes is a claim until it has been checked. A round with no piece, no
 * number, or a word that is not a verdict is not a round — it stays in the
 * prose, where a reader can see it, rather than becoming a line in a table that
 * says a judgement happened.
 */
/**
 * Splits a marker's fields, keeping the last one whole.
 *
 * The delimiter separates a marker's *fields*, and the last field is prose a
 * critic wrote — one sentence, in their own words, about work that failed. A
 * sentence is entitled to contain a pipe, and splitting on every one of them
 * would hand the reader the first clause of the gap and silently drop the rest
 * of the reason their round was lost, in the human view and in `--json` alike.
 * So a marker has exactly as many fields as it declares, and everything after
 * the last separator belongs to the last one.
 */
function splitFields(text: string, count: number): string[] {
  const parts = text.split('|');
  const fields =
    parts.length <= count
      ? parts
      : [...parts.slice(0, count - 1), parts.slice(count - 1).join('|')];
  return fields.map((field) => field.trim());
}

/** How many fields each kind of marker has. */
const MARKER_FIELDS: Record<string, number> = {
  bar: 1,
  artifact: 2,
  piece: 2,
  round: 4,
};

function readMarker(kind: string, body: string): Marker | undefined {
  const count = MARKER_FIELDS[kind];
  if (count === undefined) return undefined;
  const fields = splitFields(body, count);
  const at = (index: number): string => fields[index] ?? '';

  if (kind === 'bar') {
    return at(0) === '' ? undefined : { kind: 'bar', path: at(0) };
  }
  if (kind === 'artifact') {
    return at(0) === ''
      ? undefined
      : { kind: 'artifact', path: at(0), detail: at(1) };
  }
  if (kind === 'piece') {
    return at(0) === '' ? undefined : { kind: 'piece', id: at(0), title: at(1) };
  }
  if (kind === 'round') {
    const piece = at(0);
    const number = at(1);
    const verdict = asVerdict(at(2));
    if (piece === '' || !/^\d+$/.test(number) || verdict === undefined) {
      return undefined;
    }
    const round = Number(number);
    if (round < 1 || !Number.isSafeInteger(round)) return undefined;
    return { kind: 'round', piece, round, verdict, gap: at(3) };
  }
  return undefined;
}

/** Splits agent text into the markers it carries and the prose around them. */
export function readMarkers(text: string): MarkerReading {
  const markers: Marker[] = [];
  const rest: string[] = [];
  const segments: Segment[] = [];
  let prose: string[] = [];

  const closeProse = (): void => {
    const block = prose.join('\n').trim();
    prose = [];
    if (block !== '') segments.push({ kind: 'prose', text: block });
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(MARKER)) {
      rest.push(line);
      prose.push(line);
      continue;
    }
    const body = trimmed.slice(MARKER.length).trim();
    const space = body.indexOf(' ');
    const kind = space === -1 ? body : body.slice(0, space);
    const marker = readMarker(kind, space === -1 ? '' : body.slice(space + 1));
    // Whatever came before this line was written before it, and is reported
    // before it: a verdict printed above the report that produced it reads as
    // though the work happened afterwards.
    closeProse();
    if (marker === undefined) {
      // A line that opens with the marker and says nothing this CLI can act on.
      // It stays in the prose, and it is also reported in its own right —
      // "kept in the prose" is no use at all in the view that shows no prose,
      // which is the default one.
      rest.push(line);
      segments.push({ kind: 'unreadable', line: trimmed });
    } else {
      markers.push(marker);
      segments.push({ kind: 'marker', marker });
    }
  }
  closeProse();

  return { markers, rest: rest.join('\n').trim(), segments };
}

/* -------------------------------------------------------------------------- */
/* Reading a live run off the stream                                           */
/* -------------------------------------------------------------------------- */

export interface MarkerWatcherOptions {
  reporter: Reporter;
  /** Whether the agent's own prose is reported as well as its markers. */
  verbose: boolean;
  /** Called for each judged round, after it has been reported. */
  onRound(verdict: Verdict): void;
  /**
   * Called once every message has been read, before the next one.
   *
   * A message can carry more than one judgement, and a guard that trips on the
   * first of them has still not seen the rest. Announcing the stop from inside
   * the loop would print the reason a run ended above a round that ended after
   * it; announcing it here puts it where it belongs, under the last line the
   * turn produced.
   */
  onMessageEnd?(): void;
}

export interface MarkerWatcher {
  /** Reads one message's text, reporting whatever it turned out to carry. */
  read(text: string): void;
  /** Reports the bar and the plan now, if they have not been reported yet. */
  flushPlan(): void;
  readonly barPath: string | undefined;
  readonly pieces: readonly PlanPiece[];
}

/**
 * Turns the marker lines a run writes into the events it is reported by.
 *
 * Shared by every command that watches a live run, because there is one
 * protocol and it can only mean one thing: a round read differently by two
 * commands would be a round counted differently in the same ledger.
 *
 * The bar and the plan are held until there is a whole one to report — the
 * artifacts arrive a line at a time, and a capture reported once per artifact is
 * four bar lines for one bar — and then flushed at the first transition that
 * proves them complete: a piece for the bar, a verdict for the plan.
 */
export function createMarkerWatcher(options: MarkerWatcherOptions): MarkerWatcher {
  const { reporter } = options;
  const artifacts: BarArtifact[] = [];
  const pieces: PlanPiece[] = [];
  let barPath: string | undefined;
  let barReported = false;
  let planReported = false;
  let roundStartedAt = Date.now();
  let warnedUnreadable = false;

  const flushBar = (): void => {
    if (barReported) return;
    if (barPath === undefined && artifacts.length === 0) return;
    barReported = true;
    reporter.emit({
      type: 'bar_captured',
      path: barPath ?? (artifacts[0] as BarArtifact).path,
      artifacts: [...artifacts],
    });
  };

  const flushPlan = (): void => {
    flushBar();
    if (planReported || pieces.length === 0) return;
    planReported = true;
    reporter.emit({ type: 'plan_ready', pieces: [...pieces] });
  };

  return {
    get barPath(): string | undefined {
      return barPath;
    },
    get pieces(): readonly PlanPiece[] {
      return pieces;
    },
    flushPlan,
    read(text: string): void {
      for (const segment of readMarkers(text).segments) {
        if (segment.kind === 'prose') {
          if (options.verbose) {
            reporter.emit({ type: 'agent_output', agent: 'lead', text: segment.text });
          }
          continue;
        }
        if (segment.kind === 'unreadable') {
          // Said once. A run whose agent is writing marker lines this CLI
          // cannot read is worth knowing about; a run that says so forty times
          // has buried the verdicts it was supposed to be reporting.
          if (!warnedUnreadable) {
            warnedUnreadable = true;
            reporter.emit({
              type: 'notice',
              level: 'warning',
              message: 'ignoring a report line this build cannot read: ' + segment.line,
            });
          }
          continue;
        }

        const marker = segment.marker;
        if (marker.kind === 'bar') {
          barPath = marker.path;
          continue;
        }
        if (marker.kind === 'artifact') {
          artifacts.push({ path: marker.path, detail: marker.detail });
          continue;
        }
        if (marker.kind === 'piece') {
          flushBar();
          pieces.push({ id: marker.id, title: marker.title });
          continue;
        }
        flushPlan();
        const now = Date.now();
        reporter.emit({
          type: 'round',
          piece: marker.piece,
          round: marker.round,
          verdict: marker.verdict,
          elapsedMs: now - roundStartedAt,
          ...(marker.gap === '' ? {} : { gap: marker.gap }),
        });
        roundStartedAt = now;
        options.onRound(marker.verdict);
      }
      // The pieces arrive together, in one message, so the end of that
      // message is when the plan is known. Holding it back until the first
      // verdict printed the work done against a plan nobody had been shown.
      if (pieces.length > 0) flushPlan();
      options.onMessageEnd?.();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Startup                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The interactive surface, loaded only when a run is really about to start.
 *
 * Deferred on purpose. Registering this command is what the parser does before
 * it has read a word of the command line, and pulling a terminal-prompt library
 * in at that moment would make every other command — and every rejected flag —
 * pay for a question none of them will ever ask.
 */
type Prompts = typeof import('../prompts.js');

/**
 * Which questions are worth putting, given what the run was already told.
 *
 * Everything a run needs can arrive three ways — on the command line, from the
 * saved config, or by being asked — and a run that was told something and then
 * asks it anyway is a form standing between the user and what they typed.
 * `--auto` is an answer too: it declines the questionnaire, because that is
 * what firing and forgetting means. Only the goal survives it, since a run with
 * nothing to run is not a run at all.
 */
export function questionsFor(known: {
  given: string | undefined;
  flagged: Partial<ModelChoice>;
  config: ExolvraGenesisConfig;
  wantsAuto: boolean;
}): StartupAsk {
  const { given, flagged, config, wantsAuto } = known;
  // A saved config always carries all three roles, because that is how one is
  // written; a file with one of them is a file somebody edited, and the two
  // that are left are the defaults it was read against either way.
  const savedModels = config.models !== undefined;
  return {
    input: given === undefined || given.trim() === '',
    lead: !wantsAuto && flagged.lead === undefined && !savedModels,
    builder: !wantsAuto && flagged.builder === undefined && !savedModels,
    critic: !wantsAuto && flagged.critic === undefined && !savedModels,
    mode: !wantsAuto && config.auto === undefined,
  };
}

/** The answer a run starts from, once flags, pickers and config have settled. */
interface Startup {
  choices: StartupChoices;
  models: ModelChoice;
  auto: boolean;
  /** True when the pickers ran, which is also when an answer is worth saving. */
  asked: boolean;
}

/**
 * Nothing to run, and no way to ask for it — naming the reason there was no
 * way, which is not always the same reason.
 *
 * A run under `--json` is reporting to a machine, so it puts no questions even
 * with a terminal on both ends. Telling somebody sitting at a terminal that
 * they need a terminal is telling them to fix the one thing that is not wrong.
 */
function missingGoal(json: boolean): UsageError {
  return new UsageError(
    [
      'accepts 1 arg, received 0',
      '  a goal, or a path to an existing spec file, is required',
      json
        ? '  --json is a stream for a machine to read, so nothing was asked for'
        : '  it can be answered instead of typed only when both ends are a terminal',
    ].join('\n'),
    runCommand.usage,
  );
}

/**
 * Asks the questions when there is somebody to answer them, and settles from
 * flags and config when there is not.
 *
 * The precedence is the whole of it: a flag beats a picked answer, a picked
 * answer beats the saved config, and anything still unset is inherited. Each
 * saved value is offered back as the pre-selected row rather than applied
 * behind the picker, so what lands when you press Enter is what you were shown.
 */
async function settleStartup(
  prompts: Prompts,
  given: string | undefined,
  flagged: Partial<ModelChoice>,
  config: ExolvraGenesisConfig,
  wantsAuto: boolean,
  interactive: boolean,
  json: boolean,
  io: PromptStreams,
): Promise<Startup> {
  const saved = config.models ?? DEFAULT_MODEL_CHOICE;
  const defaults: StartupDefaults = {
    ...(given === undefined ? {} : { input: given }),
    models: {
      lead: flagged.lead ?? saved.lead,
      builder: flagged.builder ?? saved.builder,
      critic: flagged.critic ?? saved.critic,
    },
    auto: wantsAuto || config.auto === true,
  };

  if (!interactive && (given === undefined || given.trim() === '')) {
    throw missingGoal(json);
  }

  const ask = questionsFor({ given, flagged, config, wantsAuto });
  const asked = interactive && Object.values(ask).some((wanted) => wanted);

  const choices = interactive
    ? await prompts.promptStartup(defaults, io, ask)
    : prompts.startupFromDefaults(defaults);

  return {
    choices,
    models: {
      lead: flagged.lead ?? choices.models.lead,
      builder: flagged.builder ?? choices.models.builder,
      critic: flagged.critic ?? choices.models.critic,
    },
    // A pause is a question, so a run with nobody to ask never has one, whatever
    // was picked or saved.
    auto: wantsAuto || choices.auto || !interactive,
    asked,
  };
}

/* -------------------------------------------------------------------------- */
/* Running it                                                                  */
/* -------------------------------------------------------------------------- */

/** What the run turned out to be, in the two vocabularies that record it. */
export interface Outcome {
  reported: OutcomeStatus;
  ledger: LedgerStatus;
  exit: number;
}

export const WON: Outcome = { reported: 'win', ledger: 'complete', exit: EXIT.WIN };
export const LOST: Outcome = { reported: 'loss', ledger: 'stopped', exit: EXIT.LOSS };
export const BLOCKED: Outcome = { reported: 'blocked', ledger: 'blocked', exit: EXIT.LOSS };
export const STOPPED: Outcome = { reported: 'stopped', ledger: 'stopped', exit: EXIT.LOSS };

/**
 * What a finished turn comes to, given what the run says about itself.
 *
 * The one mapping, shared by every command that ends a run, because the five
 * things that have to agree about it are downstream of exactly this: the exit
 * code, the summary, the ledger row, `state.json`, and whether `resume` will
 * pick the run up again.
 *
 * The distinction it exists to keep is between a *turn* that ended and a *run*
 * that finished. A session that returns normally has ended its turn and says
 * nothing about the work; only `.exolvra-genesis/state.json` says whether the run is
 * done. Reading the turn's own status as the run's is what makes a ledger say
 * `complete` about a run that lost — and a run recorded as complete is a run
 * that can never be resumed, so the loss is permanent.
 */
export function outcomeOf(result: SessionResult | undefined, won: boolean): Outcome {
  /*
   * One precedence outranks every other: a run that met its win condition won.
   *
   * A budget guard, a Ctrl+C, or a turn that failed after the work was done are
   * all facts about how the *turn* ended, and none of them un-wins a run that
   * has already met the condition it was started for. Reading them as a verdict
   * costs the user twice: the exit code says the work failed when it did not,
   * and the run is left recorded as unfinished — so `resume` offers it, and
   * spends real money re-running work that was already good enough.
   *
   * Going over budget on a winning run is still worth saying, and it is said:
   * the guard's own warning is on the stream either way. What it is not is a
   * verdict.
   */
  if (won) return WON;
  if (result === undefined) return STOPPED;
  if (result.status === 'error') return BLOCKED;
  if (result.status === 'stopped') return STOPPED;
  return LOST;
}

async function runRun(argv: string[], ctx: Ctx): Promise<number> {
  const named = positionalTokens(runCommand, argv).length > 0;
  const args = parseInvocation(named ? runCommand : withoutArgument, argv, ctx);

  if (args.help) {
    ctx.stdout.write(renderCommandHelp(runCommand));
    return EXIT.WIN;
  }

  const cwd = args.cwd;
  const json = args.bool(jsonFlag);
  const verbose = args.bool(verboseFlag);
  const noConfig = args.bool(noConfigFlag);
  const view: Viewport = { tty: ctx.isTTY, width: ctx.width };
  const prompts: Prompts = await import('../prompts.js');

  /*
   * The run's own surface, when it has one.
   *
   * A terminal on both ends gets one frame with everything inside it: the
   * questions, the plan, every verdict, and the line that closes it. That frame
   * is drawn on stdout, because stdout is what the run reports on and a frame
   * split across two streams is two half-frames. Anything else — a pipe, a
   * redirect, --json — is a reader that cannot answer a question, so none is
   * put and the report goes out in the machine's shape instead.
   */
  const io: PromptStreams = {
    input: process.stdin,
    output: ctx.stdout as NodeJS.WriteStream,
  };
  const interactive = !json && prompts.isInteractive(io);
  if (interactive) prompts.beginRun(PROGRAM + ' run', io);

  const config = noConfig
    ? {}
    : loadConfig({
        env: ctx.env,
        platform: process.platform,
        warn: (message: string) => ctx.stderr.write(message + '\n'),
      });

  const given = named ? inputAsTyped(args.argument(runArgument)) : undefined;
  const flagged: Partial<ModelChoice> = {};
  const lead = args.get(modelFlag);
  const builder = args.get(builderModelFlag);
  const critic = args.get(criticModelFlag);
  if (lead !== undefined) flagged.lead = lead;
  if (builder !== undefined) flagged.builder = builder;
  if (critic !== undefined) flagged.critic = critic;

  let startup: Startup;
  try {
    startup = await settleStartup(
      prompts,
      given,
      flagged,
      config,
      args.bool(autoFlag),
      interactive,
      json,
      io,
    );
  } catch (error) {
    // Ctrl+C at a question: the cancel frame is already drawn and nothing has
    // started, so there is nothing left to say and nothing to record.
    if (prompts.isPromptCancelled(error)) return EXIT.LOSS;
    throw error;
  }

  const { models, auto } = startup;
  // Resolved after the questions, not before: the answer may be a path, and the
  // same rule has to apply to it as to one typed on the command line.
  const input = resolveInput(startup.choices.input, cwd, runCommand.usage);

  const pluginDir = args.get(pluginDirFlag) ?? args.env(pluginDirEnv);
  const env =
    pluginDir === undefined ? ctx.env : { ...ctx.env, [PLUGIN_DIR_ENV]: pluginDir };
  const sources = loadPluginSources(env);

  if (startup.asked && !noConfig) {
    // Preferences, not the run: what is worth defaulting to next time is every
    // answer except the goal, and config.ts is what decides that.
    saveConfig(configFromChoices({ models, auto }), {
      env: ctx.env,
      platform: process.platform,
    });
  }

  /* ---- the run is now settled; from here everything is recorded ---------- */

  /*
   * The progress line, and the streams that know about it.
   *
   * It is drawn on whichever stream the run is being watched on, and both
   * streams are then wrapped so that anything written to either takes it down
   * first. That is the only thing standing between a spinner redrawn eight
   * times a second and a report line with half a frame glued to its front, and
   * it is a property of the stream rather than a rule each call site has to
   * remember.
   */
  const progress: Progress = startProgress(
    interactive ? ctx.stdout : ctx.stderr,
    PROGRESS_MESSAGE,
    interactive || ctx.isErrTTY,
  );
  const out = progressStream(ctx.stdout, progress);
  const err = progressStream(ctx.stderr, progress);
  const frameIo: PromptStreams = { input: io.input, output: out as NodeJS.WriteStream };

  const frame: RunFrame | undefined = interactive
    ? prompts.createRunFrame(frameIo, { verbose, progress })
    : undefined;
  const reporter: Reporter =
    frame ?? createReporter({ json, verbose, stream: out, view });
  const budget: Budget = createBudget({
    ...(args.get(maxRoundsFlag) === undefined
      ? {}
      : { maxRounds: args.get(maxRoundsFlag) as number }),
    ...(args.get(maxCostFlag) === undefined
      ? {}
      : { maxCostUsd: args.get(maxCostFlag) as number }),
  });

  const runId = newRunId();
  appendRun(cwd, {
    id: runId,
    sessionId: null,
    input: inputAsTyped(input),
    models: { ...models },
    startedAt: new Date().toISOString(),
    status: 'running',
  });
  // Written before a turn is taken, so the Stop hook that greps this file sees a
  // run in progress from the first moment there is one.
  writeState(cwd, 'running');

  reporter.emit({
    type: 'run_started',
    goal: inputAsTyped(input),
    source: input.kind === 'spec' ? 'spec' : 'goal',
  });

  const page = join(cwd, RUN_DIR, PROGRESS_PAGE);
  reporter.emit({ type: 'notice', level: 'note', message: progressPage(cwd, ctx.cwd) });
  if (args.bool(openFlag)) {
    const outcome = await openPath(page);
    if (!outcome.opened) {
      // A page that would not open is a page the reader opens themselves. It is
      // never the end of a run that has not started yet.
      reporter.emit({
        type: 'notice',
        level: 'warning',
        message:
          'the progress page could not be opened with ' +
          outcome.command +
          ' (' +
          outcome.reason +
          '); open it yourself at ' +
          page,
      });
    }
  }

  /* ---- state the report and the ledger are both built from --------------- */

  let sessionId: string | undefined;
  let lastVerdict: string | undefined;
  let finished = false;
  let stopped: BudgetTrip | undefined;
  let interruptions = 0;
  let session: Session | undefined;
  let releaseStop: (() => void) | undefined;
  const stopWaiter = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });

  /**
   * Stops the run at the first guard to trip.
   *
   * The stream is asked to stop straight away, because every moment after this
   * costs money the user said not to spend. What the reader is told waits for
   * {@link announce}, which runs once the message that tripped it has been read
   * out in full — so the reason a run ended is never printed above a round that
   * ended before it.
   */
  let pending: BudgetTrip | undefined;
  const tripped = (trip: BudgetTrip | undefined): void => {
    if (trip === undefined || stopped !== undefined) return;
    stopped = trip;
    pending = trip;
    void session?.interrupt();
  };

  /** Says which guard stopped the run, under the last line the turn produced. */
  const announce = (): void => {
    if (pending === undefined) return;
    reporter.emit({ type: 'notice', level: 'warning', message: pending.message });
    pending = undefined;
    releaseStop?.();
  };

  let messages = 0;

  const watcher = createMarkerWatcher({
    reporter,
    verbose,
    onRound(verdict): void {
      lastVerdict = verdict;
      const trip = budget.countRound();
      try {
        updateRun(cwd, runId, { rounds: budget.rounds, lastVerdict });
      } catch {
        // A round that happened is not un-happened by a ledger write that did
        // not; it is recorded again when the run ends.
      }
      tripped(trip);
    },
    onMessageEnd: announce,
  });
  const flushPlan = watcher.flushPlan;

  const onMessage = (message: SdkMessage): void => {
    // Once the run has been reported as finished, its stream is closed: a line
    // after the summary would break the one promise --json makes about it.
    if (finished) return;

    messages += 1;
    progress.update(
      PROGRESS_MESSAGE +
        ' · ' +
        messages +
        (messages === 1 ? ' message' : ' messages') +
        (budget.rounds === 0
          ? ''
          : ' · ' + budget.rounds + (budget.rounds === 1 ? ' round' : ' rounds')),
    );

    const id = (message as { session_id?: unknown }).session_id;
    if (typeof id === 'string' && id !== '' && id !== sessionId) {
      sessionId = id;
      // Recorded as soon as it exists rather than at the end, so a run killed
      // outright still leaves behind the one value resuming it needs.
      try {
        updateRun(cwd, runId, { sessionId });
      } catch {
        // Bookkeeping about work in progress. The run is what matters, and the
        // ledger is written again when it ends.
      }
    }

    // The provider's own figure, taken where the provider reports it. Nothing
    // here estimates a cost from token counts.
    if (message.type === 'result') tripped(budget.addCost(message.total_cost_usd));

    const text = assistantText(message).trim();
    if (text !== '') watcher.read(text);
    // A message with nothing to read still has to say what it stopped.
    else announce();
  };

  /* ---- Ctrl+C ------------------------------------------------------------ */

  /**
   * The first interrupt stops the run and lets it finish reporting; a second one
   * is somebody saying they meant it, and takes the exit immediately.
   *
   * The session is asked to stop as well as raced, because those are different
   * things: the race is what makes the exit prompt, and the interrupt is what
   * lets the provider's stream unwind instead of being abandoned.
   */
  const onInterrupt = (): void => {
    interruptions += 1;
    if (interruptions > 1) {
      process.exit(EXIT.LOSS);
      return;
    }
    void session?.interrupt();
    releaseStop?.();
  };
  process.on('SIGINT', onInterrupt);

  const interrupted = (): boolean => interruptions > 0;

  /**
   * Runs one turn of the session, and comes back the moment either the turn ends
   * or the run is stopped from outside it.
   */
  const drain = async (
    prompt: string,
    resumeFrom?: string,
  ): Promise<SessionResult | undefined> => {
    const current = createSession({
      prompt,
      sources,
      models,
      cwd,
      env,
      maxTurns: args.get(maxTurnsFlag) ?? DEFAULT_MAX_TURNS,
      // The limit the provider enforces itself, so a run stops at it rather than
      // being found to have passed it once the turn is over.
      ...(args.get(maxCostFlag) === undefined
        ? {}
        : { maxBudgetUsd: args.get(maxCostFlag) as number }),
      permissionMode: args.get(permissionModeFlag) ?? 'acceptEdits',
      hooks: { onMessage },
    });
    session = current;

    const turn =
      resumeFrom === undefined ? current.start() : current.resume(resumeFrom);
    // The turn may be abandoned by a stop; a rejection nobody is waiting for any
    // more must not reach the process as an unhandled one.
    turn.catch(() => undefined);

    const ended = await Promise.race([
      turn.then((result) => ({ result }) as { result: SessionResult }),
      stopWaiter.then(() => undefined),
    ]);
    return ended?.result;
  };

  /* ---- the run ----------------------------------------------------------- */

  const argument = inputAsArgument(input);
  const prompt = (text: string): string =>
    renderLeadPrompt(sources.runMd, text) + '\n\n' + REPORT_DIRECTIVE + '\n';

  /**
   * The line the frame closes on: what the run was, in one sentence.
   *
   * Short on purpose. The closing line is the last thing on the screen and has
   * one line to say it in, and the run id is the one value on it somebody has
   * to be able to copy — so the command to resume with is not put here, where
   * eighty columns would cut an id in half, but on the note above, where it is
   * whole. A summary that has to be trimmed is a summary that fits.
   */
  const closingLine = (outcome: Outcome): string =>
    [
      outcome.reported === 'win'
        ? 'Won'
        : outcome.reported === 'loss'
          ? 'Lost'
          : outcome.reported === 'blocked'
            ? 'Blocked'
            : 'Stopped',
      '—',
      budget.rounds + (budget.rounds === 1 ? ' round' : ' rounds'),
      'for ' + formatUsd(budget.costUsd),
    ].join(' ');

  /**
   * What the run leaves behind: the ledger, and the file the Stop hook greps.
   *
   * Separated from the reporting because the two have different audiences and
   * one path needs only this one — a run cancelled at a question has already
   * been closed on screen by the prompt itself, and still has to be recorded.
   */
  const record = (outcome: Outcome): void => {
    try {
      updateRun(cwd, runId, {
        status: outcome.ledger,
        rounds: budget.rounds,
        costUsd: budget.costUsd,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(lastVerdict === undefined ? {} : { lastVerdict }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      err.write('note: the ledger was not updated\n');
      for (const line of reason.split('\n')) err.write('  ' + line + '\n');
    }
    if (outcome.ledger !== 'complete') writeState(cwd, outcome.ledger);
  };

  const finish = (outcome: Outcome, detail?: string): number => {
    finished = true;
    // Inside a frame the closing rail is what says how it went, so the progress
    // line only has to get out of the way; on its own it is the last word, and
    // says so.
    if (frame !== undefined) progress.suspend();
    else if (outcome.exit === EXIT.WIN) progress.done('Run complete');
    else progress.fail('Run stopped');

    // Whatever the run did manage to report is reported, however it ended: a
    // bar it captured before the stream dropped is a fact about the run, and a
    // run that is only ever told about on the paths that went well is a run
    // whose worst endings say the least.
    flushPlan();
    // The plan is drawn before the closing notices, so those are news on their
    // own lines rather than rows squeezed into a box — which is where the
    // command to resume with would have to be cut to fit.
    frame?.showPlan();

    if (detail !== undefined) {
      reporter.emit({ type: 'notice', level: 'error', message: detail });
    }
    if (outcome.ledger !== 'complete' && sessionId !== undefined) {
      reporter.emit({
        type: 'notice',
        level: 'note',
        message: 'resume it with: ' + PROGRAM + ' resume ' + runId,
        // A command: never folded, so it copies clean.
        keepWhole: true,
      });
    }

    reporter.emit({
      type: 'run_finished',
      status: outcome.reported,
      rounds: budget.rounds,
      costUsd: budget.costUsd,
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    // Both files, every path: the ledger is how a run is found again, and
    // state.json is what the Stop hook the plugin ships reads. A run that ended
    // must not leave either of them saying it is still going.
    record(outcome);

    // The frame is closed on every ending there is — won, lost, blocked,
    // stopped — because a frame that is only closed when things went well is a
    // frame left hanging open exactly when the reader is looking hardest.
    frame?.close(closingLine(outcome));

    return outcome.exit;
  };

  try {
    // Review is a pause the loaded markdown already knows how to take: without
    // the word that skips it, the run stops once the bar is picked and waits.
    let result = await drain(prompt(auto ? AUTO_PREFIX + ' ' + argument : argument));

    // What the run says about itself, asked once and asked first: it outranks
    // how the turn ended, because a run that met its win condition has won
    // whether or not a guard or a Ctrl+C cut the turn short.
    const finishedWell = (): boolean => readState(cwd).status === 'complete';

    if (interrupted()) {
      return finishedWell()
        ? finish(WON)
        : finish(STOPPED, 'the run was interrupted');
    }
    if (stopped !== undefined) return finish(outcomeOf(result, finishedWell()));
    if (result === undefined) {
      return finishedWell() ? finish(WON) : finish(STOPPED, 'the run was stopped');
    }

    if (result.status === 'error' && !finishedWell()) {
      return finish(
        BLOCKED,
        'the run did not finish: ' +
          printable(result.error ?? 'no reason was reported'),
      );
    }
    if (result.status === 'stopped' && !finishedWell()) {
      return finish(
        STOPPED,
        'the run was stopped: ' +
          printable(result.error ?? 'no reason was reported'),
      );
    }
    if (result.status !== 'complete') return finish(WON);

    flushPlan();

    // A run that came back having judged nothing, in a mode that pauses, is a
    // run waiting to be approved. One that already judged rounds is past the
    // point of approving anything, whatever mode it started in.
    if (!auto && budget.rounds === 0 && sessionId !== undefined && frame !== undefined) {
      // The bar and the pieces, drawn as the box they belong in, and then the
      // question — inside the same frame, with the progress line suspended so
      // that what is being asked stays on the screen while it is answered.
      frame.showPlan();
      let approved: boolean;
      try {
        approved = await frame.confirm('Start the loop?');
      } catch (error) {
        if (!prompts.isPromptCancelled(error)) throw error;
        /*
         * Stopped at the question, with a run behind it.
         *
         * By this point a session has run, been billed, and been recorded, so
         * this is not "nothing started, nothing saved" — it is a run that
         * stopped, and it is treated as one: settled in both files, and given
         * the same line every other stop path gives, because the user is owed
         * the same way back in.
         */
        return finish(STOPPED, 'the loop was not started');
      }
      if (!approved) return finish(STOPPED, 'the loop was not started');

      result = await drain(GO, sessionId);
      if (interrupted() && !finishedWell()) {
        return finish(STOPPED, 'the run was interrupted');
      }
      if (stopped !== undefined) return finish(outcomeOf(result, finishedWell()));
      if (result === undefined) {
        return finishedWell() ? finish(WON) : finish(STOPPED, 'the run was stopped');
      }
      if (result.status !== 'complete' && !finishedWell()) {
        return finish(
          result.status === 'stopped' ? STOPPED : BLOCKED,
          'the run did not finish: ' +
            printable(result.error ?? 'no reason was reported'),
        );
      }
      flushPlan();
    }

    // A session that ended is not a run that won. What the run says about itself
    // is what decides that, and it says it in the file it has always said it in.
    const state = readState(cwd);
    if (state.status === 'complete') return finish(WON);
    return finish(
      outcomeOf(result, false),
      'the session ended with the run unfinished (' + state.detail + ')',
    );
  } catch (error) {
    /*
     * A fault, and the run is over however it is about to be reported.
     *
     * Both files are settled here for the same reason they are settled
     * everywhere else: the ledger is how a run is found again, and state.json
     * is what the Stop hook the plugin ships greps. A run that could not start
     * a session at all — no credential, no interpreter — would otherwise leave
     * `running` in both of them for good: the hook stays armed for a run that
     * never began, `exolvra-genesis runs` shows a row that is still going, and no
     * later run repairs either, because no later run knows about them.
     *
     * The status is `blocked`, which is what it is: a run stopped before any
     * verdict. Where it never reached a session there is no session id to
     * record, and a row with none is one the picker will not offer and
     * `resume` refuses by name — which is the truthful answer, because there
     * is nothing to go back to. A blocked run that did reach a session keeps
     * it, and stays resumable.
     */
    if (!finished) {
      finished = true;
      progress.suspend();
      record(BLOCKED);
      // The frame is closed before the fault is printed under it, rather than
      // left hanging open above it.
      frame?.close(closingLine(BLOCKED));
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    if (!finished) progress.fail('Run stopped');
  }
}
