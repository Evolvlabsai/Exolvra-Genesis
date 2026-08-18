import { resolve } from 'node:path';

import {
  type Budget,
  type BudgetTrip,
  costValue,
  createBudget,
  formatUsd,
} from '../budget.js';
import { autoResumeLimit } from '../config.js';
import { ConfigError, EXIT, UsageError } from '../exit.js';
import { expandHome, pathKind } from '../input.js';
import {
  type ModelChoice,
  agentModelFault,
  asAgentModel,
  isKnownModel,
  listModels,
} from '../models.js';
import { type Reporter, createReporter } from '../output.js';
import { PLUGIN_DIR_ENV, loadPluginSources } from '../plugin-dir.js';
import type { PromptStreams, RunFrame } from '../prompts.js';
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
  parseInvocation,
  registerCommand,
} from '../registry.js';
import {
  type RunRecord,
  isRunId,
  isUnfinished,
  readRuns,
  readState,
  runsPath,
  statePath,
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
  renderMarkdown,
  renderSection,
  startProgress,
  truncate,
  wrapList,
  wrapText,
} from '../usage.js';
import {
  BLOCKED,
  STOPPED,
  WON,
  createMarkerWatcher,
  outcomeOf,
  progressPage,
  readMarkers,
} from './run.js';
import { cell, mostRecentFirst, relativeTime } from './runs.js';

/**
 * Generous, because a resumed run is real work rather than a preview: the point
 * of resuming is to let it keep going, and a limit that stops it again in a
 * minute would only have to be raised by hand.
 */
const DEFAULT_MAX_TURNS = 100;

/** What the progress line says while the session runs. */
const PROGRESS_MESSAGE = 'Resuming';

/**
 * The turn the resumed session is handed.
 *
 * One sentence, and deliberately only that: the session already holds
 * everything the run was told, and this CLI does not restate any of it. What
 * the agent does next is what it was already doing.
 */
const CONTINUE = 'Continue from where this session left off.';

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;

/* -------------------------------------------------------------------------- */
/* The argument, and the flags                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A run id, checked for shape here and for existence later.
 *
 * Shape first, and separately: an id with a space or an escape sequence in it is
 * malformed however the ledger reads, and saying so needs no file on disk.
 */
export const runIdValue: ValueType<string> = {
  arg: 'run-id',
  invalid: 'not a run id',
  parse(raw, ctx) {
    const trimmed = raw.trim();
    if (isRunId(trimmed)) return trimmed;
    throw new UsageError(
      [
        'invalid value "' + raw + '" for ' + ctx.flag + ': not the shape of a run id',
        '  a run id is one word: no spaces, and nothing a terminal would act on',
        '  run `' + PROGRAM + ' runs` to see the ids that are recorded',
      ].join('\n'),
      ctx.usage,
    );
  },
};

const runArgument: ArgumentSpec<string> = { name: 'run-id', value: runIdValue };

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Resume the run recorded in dir instead of the current directory',
};

const pluginDirFlag: ValueFlagSpec<string> = {
  long: 'plugin-dir',
  value: directoryValue,
  summary: 'Read the plugin markdown from dir, overriding ' + PLUGIN_DIR_ENV,
};

const maxTurnsFlag: ValueFlagSpec<number> = {
  long: 'max-turns',
  value: countValue,
  summary: 'Stop the resumed run after int agent turns',
  default: DEFAULT_MAX_TURNS,
};

const permissionModeFlag: ValueFlagSpec<(typeof PERMISSION_MODES)[number]> = {
  long: 'permission-mode',
  value: choiceValue('mode', PERMISSION_MODES),
  // The same default `run` carries, for the same reason: an unattended build
  // runs its verification commands, and the flag is the restriction.
  summary: 'How the resumed run may use tools (restrict with acceptEdits)',
  default: 'bypassPermissions',
};

const verboseFlag: BooleanFlagSpec = {
  long: 'verbose',
  short: 'v',
  summary: 'Stream the agent transcript instead of the result alone',
};

const maxRoundsFlag: ValueFlagSpec<number> = {
  long: 'max-rounds',
  value: countValue,
  summary: 'Stop once int further rounds have been judged',
};

const maxCostFlag: ValueFlagSpec<number> = {
  long: 'max-cost',
  value: costValue,
  summary: 'Stop once this resumed turn has cost usd dollars',
};

const jsonFlag: BooleanFlagSpec = {
  long: 'json',
  summary: 'Print one JSON object per event, and a summary object last',
};

const flags: FlagSpec[] = [
  directoryFlag,
  jsonFlag,
  maxCostFlag,
  maxRoundsFlag,
  maxTurnsFlag,
  permissionModeFlag,
  pluginDirFlag,
  verboseFlag,
];

const pluginDirEnv: EnvSpec<string> = {
  name: PLUGIN_DIR_ENV,
  value: directoryValue,
  overriddenBy: pluginDirFlag,
};

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

const resumeCommand: Command = {
  name: 'resume',
  summary: 'Continue a recorded run in the session it started in',
  usage: PROGRAM + ' resume [<run-id>] [flags]',
  group: 'core',
  description: [
    'Continue a recorded run in the session it started in.',
    'Every run records the id of the Claude Agent SDK session it ran in, and resume\nhands that id back to the SDK. The agent picks the run up holding everything it\nalready worked out, rather than starting the whole thing again.',
    'With no run id, resume offers every run that has not finished — running, stopped,\nor blocked — that still has a session to go back to. That is a question, so it is\nonly asked when stdin is a terminal. Anywhere else — a pipe, a script, CI — resume\nnames the candidates and exits 2 rather than block on an answer that cannot come.',
    'A run that is already complete is not resumed by either route, and neither is one\nthat stopped before the agent produced anything, because it has no session to go\nback to. Both are exit 2, naming the run.',
    'It exits 0 only when the run reports in .exolvra-genesis/state.json that it is complete.\nA session that ends with the run still unfinished has not won anything, and exits 1,\nso resuming again is the next step rather than a surprise.',
    'Everything a run reports, a resumed run reports the same way: one line per judged\nround, the rounds and the last verdict written back to the ledger as they land, and\n--json for the same NDJSON stream ending in the same four-field summary object.',
    '--max-rounds and --max-cost are the guards a run was stopped by, raised or taken\noff. They count this turn rather than the whole run: --max-rounds 5 allows five more\nrounds, and --max-cost is handed to the provider as this turn\'s ceiling and measured\nagainst what it reports the turn costing, which is added to the run total. Neither\nguard can turn a win into a loss: a turn that finishes the run exits 0 either way.',
  ],
  flags,
  argument: runArgument,
  env: [pluginDirEnv],
  cwdFlag: directoryFlag,
  examples: [
    PROGRAM + ' resume',
    PROGRAM + ' resume r-20260810-1712-a3f9c1',
    PROGRAM + ' resume --max-turns 200 r-20260810-1712-a3f9c1',
  ],
  run: runResume,
};

registerCommand(resumeCommand);

export { resumeCommand };

/**
 * The same command with its argument taken off, for an invocation that did not
 * give one.
 *
 * The registry's rule is that a declared argument is required, which is the
 * right rule: a command that quietly accepts a missing argument cannot report a
 * missing one. Optional here means exactly two invocations — one with an id,
 * one without — and each is parsed against what it really takes, so the id is
 * still validated at the same boundary every other value is.
 */
const withoutArgument: Command = { ...resumeCommand, argument: undefined };

/**
 * The positional tokens in `argv`, read the way the parser reads them.
 *
 * Shape only: which tokens are flags, and which of those take the token after
 * them. Nothing is validated here and nothing is acted on — the answer picks
 * which of the two invocations above to parse, and the parser then does all of
 * the work, including rejecting the flags this pass deliberately does not know
 * anything about.
 */
export function positionalTokens(
  command: Command,
  argv: readonly string[],
): string[] {
  const byLong = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const flag of command.flags) {
    byLong.set(flag.long, flag);
    if (flag.short !== undefined) byShort.set(flag.short, flag);
  }

  const out: string[] = [];
  let terminated = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (terminated || token === '-' || !token.startsWith('-')) {
      out.push(token);
      continue;
    }
    if (token === '--') {
      terminated = true;
      continue;
    }
    const isLong = token.startsWith('--');
    const body = isLong ? token.slice(2) : token.slice(1);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    const flag = isLong ? byLong.get(name) : byShort.get(name);
    // A flag that takes a value and was not given one inline takes the next
    // token, exactly as the parser does; an unknown flag is left for the parser
    // to reject, and takes nothing in the meantime.
    if (eq === -1 && flag?.value !== undefined) i += 1;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Resolving which run to resume                                               */
/* -------------------------------------------------------------------------- */

/** Longest list of ids worth printing before it stops being a list. */
const IDS_SHOWN = 10;

function idList(runs: readonly RunRecord[], indent: number): string[] {
  const shown = runs.slice(0, IDS_SHOWN).map((record) => record.id);
  const rest = runs.length - shown.length;
  const lines = wrapList(shown, indent);
  if (rest > 0) {
    lines.push(' '.repeat(indent) + 'and ' + rest + ' more');
  }
  return lines;
}

/** A run that can be resumed: one that never finished and has a session. */
function resumable(record: RunRecord): boolean {
  return isUnfinished(record) && record.sessionId !== null && record.sessionId !== '';
}

function unknownId(id: string, runs: readonly RunRecord[], cwd: string): UsageError {
  const detail =
    runs.length === 0
      ? ['  no runs are recorded in ' + runsPath(cwd)]
      : ['  recorded ids:', ...idList(runs, 4)];
  return new UsageError(
    ['no run is recorded as "' + id + '"', ...detail].join('\n'),
    resumeCommand.usage,
  );
}

/**
 * A run that is over is not resumed.
 *
 * The picker never offers one, and naming one on the command line is the same
 * request; it stops here rather than starting a session on a run whose work is
 * done, which would spend a model's time and then record a second ending over
 * the first.
 */
function alreadyFinished(record: RunRecord, cwd: string): ConfigError {
  return new ConfigError(
    [
      'the run "' + record.id + '" has already finished',
      '  ' + runsPath(cwd) + ' records it as complete',
      '  there is nothing left of it to continue; start a new run instead',
    ].join('\n'),
  );
}

function withoutSession(record: RunRecord, cwd: string): ConfigError {
  return new ConfigError(
    [
      'the run "' + record.id + '" never started a session',
      '  ' + runsPath(cwd) + ' records no session id for it',
      '  a session id is recorded as soon as the agent produces anything, so this',
      '  run stopped before it began; start it again rather than resuming it',
    ].join('\n'),
  );
}

function nothingToResume(cwd: string, recorded: number): UsageError {
  return new UsageError(
    [
      'no run in ' + runsPath(cwd) + ' can be resumed',
      recorded === 0
        ? '  no runs are recorded there yet'
        : '  every run recorded there has finished, or never started a session',
      '  run `' + PROGRAM + ' runs` to see them',
    ].join('\n'),
    resumeCommand.usage,
  );
}

/**
 * What is said when there is no id and no terminal to ask for one.
 *
 * The candidates and the exact line to type: a script, a CI job, or a pipe
 * cannot answer a question, so the answer it would have been asked for is
 * printed instead, and the command exits rather than waiting for one.
 */
function needsAnId(
  candidates: readonly RunRecord[],
  cwd: string,
  json: boolean,
): UsageError {
  const example = candidates[0] as RunRecord;
  return new UsageError(
    [
      // --json puts no questions even with a terminal on both ends, so it
      // is the reason, and blaming the terminal would point the reader at
      // the one thing that is not wrong.
      json
        ? 'resume needs a run id under --json, which puts no questions'
        : 'resume needs a run id when stdin is not a terminal',
      '  unfinished runs in ' + runsPath(cwd) + ':',
      ...idList(candidates, 4),
      '  run one of them again by name, for example:',
      '    ' + PROGRAM + ' resume ' + example.id,
    ].join('\n'),
    resumeCommand.usage,
  );
}

/* -------------------------------------------------------------------------- */
/* The picker                                                                  */
/* -------------------------------------------------------------------------- */

/** Longest a goal may read in a picker row before it stops being one line. */
const CHOICE_WIDTH = 48;

/**
 * Asks which of `runs` to resume, and resolves to the one chosen, or to
 * undefined when the answer was to quit.
 *
 * Asked in the one language every other question this CLI puts is asked in.
 * Two questions in one product, in two visual languages, is two products as far
 * as anyone reading the screen is concerned — so the list is a picker with the
 * same rails, the same marks and the same keys as the pickers a run starts
 * with, rather than a number typed at a bare prompt.
 */
export async function pickRun(
  runs: readonly RunRecord[],
  io: PromptStreams,
  now: Date = new Date(),
): Promise<RunRecord | undefined> {
  const prompts = await import('../prompts.js');
  const QUIT = '';
  const choices = [
    ...runs.map((record) => ({
      value: record.id,
      label: cell(record.id),
      hint:
        cell(relativeTime(record.startedAt, now)) +
        ' · ' +
        record.status +
        ' · ' +
        truncate(cell(record.input), CHOICE_WIDTH),
    })),
    { value: QUIT, label: 'Quit', hint: 'resume nothing' },
  ];

  const chosen = await prompts.askChoice('Resume which run?', choices, io);
  return chosen === QUIT ? undefined : runs.find((record) => record.id === chosen);
}

/* -------------------------------------------------------------------------- */
/* What is printed when it is over                                             */
/* -------------------------------------------------------------------------- */

/**
 * The resumed run, framed by this CLI: which run it was, what it was asked for,
 * and what came back. The agent supplies only the last of those.
 */
export function renderResumed(
  record: RunRecord,
  result: SessionResult,
  view: Viewport,
  now: Date,
): string {
  const started = cell(record.startedAt);
  const lines: string[] = [
    ...renderSection('RUN', [
      '  ' + cell(record.id),
      '  started ' + started + ' (' + relativeTime(started, now) + ')',
      '  session ' + cell(record.sessionId ?? ''),
    ]),
    ...renderSection(
      'INPUT',
      wrapText(cell(record.input), view.width, 2, { breakWords: false }),
    ),
    // The marker lines are addressed to this CLI, not to the reader: they have
    // already been turned into the round lines above, and printing the protocol
    // as well would be showing somebody the envelope after reading them the
    // letter.
    ...renderSection('RESULT', renderMarkdown(readMarkers(result.text).rest, view, 2)),
  ];
  return lines.join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/* Running it                                                                  */
/* -------------------------------------------------------------------------- */

function unusableModel(
  record: RunRecord,
  cwd: string,
  role: string,
  value: string,
  detail: readonly string[],
): ConfigError {
  return new ConfigError(
    [
      'the run "' + record.id + '" was recorded with a model this build cannot use',
      '  ' + runsPath(cwd),
      '  "' + value + '" for the ' + role,
      ...detail,
    ].join('\n'),
  );
}

/**
 * The models the run was started with, checked before any of them can reach the
 * SDK — each against its own vocabulary, because the two are not the same one:
 * the lead runs on a model id, and a subagent is pinned to a family. The ledger
 * is a file on disk, and a file is not a promise.
 */
function modelsOf(record: RunRecord, cwd: string): ModelChoice {
  const { lead, builder, critic } = record.models;
  if (!isKnownModel(lead)) {
    throw unusableModel(record, cwd, 'lead', lead, [
      '  it is not a model id this build offers',
      ...wrapList(
        listModels().map((model) => model.value),
        4,
      ),
    ]);
  }
  for (const [role, value] of [
    ['builder', builder],
    ['critic', critic],
  ] as const) {
    if (asAgentModel(value) === undefined) {
      throw unusableModel(record, cwd, role, value, agentModelFault(value));
    }
  }
  return { lead, builder, critic };
}

async function runResume(argv: string[], ctx: Ctx): Promise<number> {
  const named = positionalTokens(resumeCommand, argv).length > 0;
  const args = parseInvocation(named ? resumeCommand : withoutArgument, argv, ctx);

  if (args.help) {
    ctx.stdout.write(renderCommandHelp(resumeCommand));
    return EXIT.WIN;
  }

  const cwd = args.cwd;
  const runs = readRuns(cwd);
  const now = new Date();
  const json = args.bool(jsonFlag);

  const io: PromptStreams = {
    input: process.stdin,
    output: ctx.stdout as NodeJS.WriteStream,
  };
  // Loaded only when there could be somebody to ask. Both ends being a terminal
  // is what prompts.ts decides; that stdin is one at all is a cheaper necessary
  // condition, and checking it here keeps a run with no terminal from paying for
  // a prompt library it will never draw with.
  const mayAsk =
    !json &&
    process.stdin.isTTY === true &&
    (ctx.stdout as Partial<NodeJS.WriteStream>).isTTY === true;
  const prompts = mayAsk ? await import('../prompts.js') : undefined;
  const interactive = prompts !== undefined && prompts.isInteractive(io);

  let record: RunRecord | undefined;
  let framed = false;
  if (named) {
    const id = args.argument(runArgument);
    record = runs.find((candidate) => candidate.id === id);
    if (record === undefined) throw unknownId(id, runs, cwd);
    if (interactive) {
      prompts.beginRun(PROGRAM + ' resume', io);
      framed = true;
    }
  } else {
    const candidates = mostRecentFirst(runs).filter(resumable);
    if (candidates.length === 0) throw nothingToResume(cwd, runs.length);
    // The one place a prompt is possible, and the only condition under which it
    // is: stdin is a terminal, so there is somebody there to answer.
    if (!interactive) throw needsAnId(candidates, cwd, json);
    // The pick and the run it leads to are one frame: the question opens it,
    // and the run that follows carries on inside it rather than falling out of
    // it into flat text.
    prompts.beginRun(PROGRAM + ' resume', io);
    framed = true;
    try {
      record = await pickRun(candidates, io, now);
    } catch (error) {
      // Ctrl+C at the picker: the user said stop before anything started, the
      // prompt has already drawn the cancel and closed the frame, and there is
      // nothing left to say. Reporting it as a fault in this CLI — which is
      // what letting it escape does — accuses the tool of crashing over
      // somebody choosing not to resume anything.
      if (!prompts.isPromptCancelled(error)) throw error;
      return EXIT.LOSS;
    }
    if (record === undefined) {
      prompts.endRun('Nothing resumed', io);
      return EXIT.LOSS;
    }
  }

  // Settled: one run, and the session it left behind. Neither a run that is
  // over nor a run that never started one is resumed, however it was chosen.
  const run = record;
  // A refusal from here on happens with the frame already open, so it is closed
  // before the fault is reported rather than left hanging above it.
  const closing = <T>(check: () => T): T => {
    try {
      return check();
    } catch (error) {
      if (framed) prompts?.endRun('Nothing resumed', io);
      throw error;
    }
  };
  const sessionId = closing(() => {
    if (run.status === 'complete') throw alreadyFinished(run, cwd);
    const id = run.sessionId;
    if (id === null || id === '') throw withoutSession(run, cwd);
    return id;
  });
  const models = closing(() => modelsOf(run, cwd));

  const pluginDir = args.get(pluginDirFlag) ?? args.env(pluginDirEnv);
  const env =
    pluginDir === undefined ? ctx.env : { ...ctx.env, [PLUGIN_DIR_ENV]: pluginDir };
  const sources = closing(() => loadPluginSources(env));

  const view: Viewport = { tty: ctx.isTTY, width: ctx.width };
  const verbose = args.bool(verboseFlag);

  const progress: Progress = startProgress(
    framed ? ctx.stdout : ctx.stderr,
    PROGRESS_MESSAGE + ' ' + printable(run.id),
    framed || ctx.isErrTTY,
  );
  // Both streams know about the progress line, so nothing written to either can
  // land with half a spinner frame in front of it.
  const out = progressStream(ctx.stdout, progress);
  const err = progressStream(ctx.stderr, progress);
  const frameIo: PromptStreams = { input: io.input, output: out as NodeJS.WriteStream };

  // The same two surfaces a run reports on, chosen the same way: one frame on a
  // terminal, records everywhere else. A resumed run is the same run.
  const frame: RunFrame | undefined =
    framed && prompts !== undefined
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

  let messages = 0;
  let lastVerdict: string | undefined = run.lastVerdict;
  let stopped: BudgetTrip | undefined;
  let finished = false;

  /** The rounds this run has been judged over, across every turn of it. */
  const totalRounds = (): number => (run.rounds ?? 0) + budget.rounds;

  let pending: BudgetTrip | undefined;
  const tripped = (trip: BudgetTrip | undefined): void => {
    if (trip === undefined || stopped !== undefined) return;
    stopped = trip;
    pending = trip;
    void session.interrupt();
  };

  /** Says which guard stopped the run, under the last line the turn produced. */
  const announce = (): void => {
    if (pending === undefined) return;
    reporter.emit({ type: 'notice', level: 'warning', message: pending.message });
    pending = undefined;
  };

  // The same reader a run watches its own stream with: one protocol, read once,
  // so a round means the same thing to both commands and to the ledger.
  const watcher = createMarkerWatcher({
    reporter,
    verbose,
    onRound(verdict): void {
      lastVerdict = verdict;
      const trip = budget.countRound();
      try {
        updateRun(cwd, run.id, { rounds: totalRounds(), lastVerdict });
      } catch {
        // Bookkeeping about work that has already happened; written again at
        // the end of the turn.
      }
      tripped(trip);
    },
    onMessageEnd: announce,
  });

  const makeSession = (): Session => createSession({
    prompt: CONTINUE,
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
    permissionMode: args.get(permissionModeFlag) ?? 'bypassPermissions',
    hooks: {
      onMessage(message: SdkMessage): void {
        if (finished) return;
        messages += 1;
        progress.update(
          PROGRESS_MESSAGE +
            ' ' +
            printable(run.id) +
            ' · ' +
            messages +
            (messages === 1 ? ' message' : ' messages') +
            (budget.rounds === 0
              ? ''
              : ' · ' + budget.rounds + (budget.rounds === 1 ? ' round' : ' rounds')),
        );
        if (message.type === 'result') tripped(budget.addCost(message.total_cost_usd));
        const text = assistantText(message).trim();
        if (text !== '') watcher.read(text);
        else announce();
      },
    },
  });
  let session = makeSession();

  // What the run was started with, echoed as it was recorded. Whether it was a
  // spec is asked of the filesystem rather than remembered, by the same rule
  // that decided it in the first place: a path to a file that is there.
  reporter.emit({
    type: 'run_started',
    goal: run.input,
    source: pathKind(resolve(cwd, expandHome(run.input))) === 'file' ? 'spec' : 'goal',
  });
  // The page the run has been keeping up to date, named the same way a run
  // names it: a resumed run carries on writing the same one.
  reporter.emit({
    type: 'notice',
    level: 'note',
    message: progressPage(cwd, ctx.cwd),
  });

  // Written before the turn starts, and settled however it ends — the same
  // contract a run keeps. It also closes a hole: without it, a `complete` left
  // in the file by an earlier run in this directory would be read as this
  // turn's own verdict.
  writeState(cwd, 'running');

  /*
   * The drive, with in-place recovery from an ABNORMAL end: a stream fault, or
   * a turn that finished while state.json still said `running` — the one clean
   * ending that is not a decision. Verdicts stand: a lead that settled
   * `blocked`, a guard that tripped (`stopped`), an interrupt. Bounded by
   * EXOLVRA_GENESIS_AUTO_RESUMES (default 2, 0 disables), because an abnormal
   * death can be systemic and unbounded retries against a dead credential are
   * a bill, not a fix. A thrown fault below is different in kind — the turn
   * could not start at all — and is not retried.
   */
  const autoResumeMax = autoResumeLimit();
  let autoResumes = 0;
  let driveFrom = sessionId;
  let result: SessionResult;
  try {
    for (;;) {
      result = await session.resume(driveFrom);
      const abnormal =
        stopped === undefined &&
        readState(cwd).status === 'running' &&
        (result.status === 'error' || result.status === 'complete');
      if (!abnormal || autoResumes >= autoResumeMax) break;
      autoResumes += 1;
      reporter.emit({
        type: 'notice',
        level: 'warning',
        message:
          (result.status === 'error'
            ? 'the session ended with a fault'
            : 'the session ended with the run unfinished') +
          ' — resuming automatically (attempt ' +
          autoResumes +
          ' of ' +
          autoResumeMax +
          ')',
      });
      driveFrom = result.sessionId ?? driveFrom;
      session = makeSession();
    }
  } catch (error) {
    /*
     * A fault, and the turn is over however it is about to be reported.
     *
     * Both files are settled here for the reason they are settled everywhere
     * else: a turn that could not start leaves the ledger and the Stop hook's
     * tripwire saying the run is still going, and no later command repairs
     * either. `blocked` keeps the session it already had, so the run stays
     * resumable once whatever stopped it is fixed.
     */
    finished = true;
    if (frame !== undefined) progress.suspend();
    else progress.fail('The run stopped');
    try {
      updateRun(cwd, run.id, {
        status: BLOCKED.ledger,
        rounds: totalRounds(),
        costUsd: (run.costUsd ?? 0) + budget.costUsd,
        ...(lastVerdict === undefined ? {} : { lastVerdict }),
      });
    } catch {
      // Bookkeeping about a turn that already failed; the fault below is what
      // the user has to act on.
    }
    writeState(cwd, BLOCKED.ledger);
    frame?.close('Blocked — ' + totalRounds() + ' rounds');
    throw error;
  }
  finished = true;

  // Inside a frame the closing rail is the last word; on its own the progress
  // line is, and says so.
  if (frame !== undefined) progress.suspend();
  else if (result.status === 'complete' && stopped === undefined) {
    progress.done('Session finished');
  } else progress.fail('Session stopped');

  watcher.flushPlan();
  // The plan before the closing notices, so those are news on their own lines
  // rather than rows squeezed into a box that would have to cut them.
  frame?.showPlan();

  /*
   * What this turn came to — settled by the mapping a run uses, not by a second
   * one that happens to live here.
   *
   * A session that returns normally has ended its *turn*; whether the *run* is
   * finished is what `.exolvra-genesis/state.json` says, and only that. Reading the
   * turn's own status as the run's would record a resumed run that still has
   * work left as `complete` — and a complete run is one nothing will ever pick
   * up again, so the same command that printed "resume it with…" would refuse
   * that exact command a moment later.
   */
  const settled = stopped === undefined
    ? outcomeOf(result, readState(cwd).status === 'complete')
    : STOPPED;
  const won = settled === WON;
  const costUsd = (run.costUsd ?? 0) + budget.costUsd;

  if (stopped !== undefined) {
    reporter.emit({
      type: 'notice',
      level: 'note',
      message: 'resume it again with the limit raised, or without it',
    });
  } else if (result.status !== 'complete') {
    reporter.emit({
      type: 'notice',
      level: 'error',
      message:
        'the resumed run did not finish: ' +
        printable(result.error ?? 'no reason was reported') +
        (result.reason === 'max-turns'
          ? ' — raise the limit with --max-turns and resume it again'
          : ''),
    });
  } else if (!won) {
    reporter.emit({
      type: 'notice',
      level: 'error',
      message:
        'the session ended with the run still unfinished (' +
        statePath(cwd) +
        ': ' +
        readState(cwd).detail +
        ')',
    });
  }
  if (!won) {
    reporter.emit({
      type: 'notice',
      level: 'note',
      message: 'resume it with: ' + PROGRAM + ' resume ' + run.id,
      // A command: never folded, so it copies clean.
      keepWhole: true,
    });
  }

  reporter.emit({
    type: 'run_finished',
    status: settled.reported,
    rounds: totalRounds(),
    costUsd,
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
  });

  // The ledger is bookkeeping about work that has already happened, so a ledger
  // that cannot be written is said out loud and does not become the verdict on
  // the work itself.
  try {
    updateRun(cwd, run.id, {
      status: settled.ledger,
      sessionId: result.sessionId ?? run.sessionId,
      costUsd,
      rounds: totalRounds(),
      ...(lastVerdict === undefined ? {} : { lastVerdict }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    err.write('note: the ledger was not updated\n');
    for (const line of reason.split('\n')) err.write('  ' + line + '\n');
  }
  if (settled.ledger !== 'complete') writeState(cwd, settled.ledger);

  // One closing rail, on every ending there is.
  frame?.close(
    [
      won
        ? 'Won'
        : settled.reported === 'blocked'
          ? 'Blocked'
          : settled.reported === 'loss'
            ? 'Lost'
            : 'Stopped',
      '—',
      totalRounds() + (totalRounds() === 1 ? ' round' : ' rounds'),
      'for ' + formatUsd(costUsd),
    ].join(' '),
  );

  // A session that ended is not a run that won. What the run says about itself
  // is what decides that, and it says it in the file it has always said it in.
  return settled.exit;
}
