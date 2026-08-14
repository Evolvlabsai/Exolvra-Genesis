import { renderLeadPrompt } from '../agents.js';
import { ConfigError, EXIT, UsageError } from '../exit.js';
import {
  GOALS_LABEL,
  type Goal,
  findGoal,
  goalNameFault,
  goalPath,
  goalsDir,
  listGoals,
  newGoalNameFault,
  readGoalFile,
  readProposal,
  writeGoal,
  PROPOSAL_BEGIN,
  PROPOSAL_END,
} from '../goals.js';
import { DEFAULT_MODEL_CHOICE, type ModelChoice, listModels } from '../models.js';
import { PLUGIN_DIR_ENV, loadPluginSources } from '../plugin-dir.js';
import type { PromptStreams } from '../prompts.js';
import {
  type ArgumentSpec,
  type BooleanFlagSpec,
  type Command,
  type Ctx,
  type EnvSpec,
  type FlagSpec,
  type Invocation,
  type ValueFlagSpec,
  type ValueType,
  countValue,
  directoryValue,
  modelValue,
  parseInvocation,
  registerCommand,
} from '../registry.js';
import { type SdkMessage, type SessionResult, createSession } from '../session.js';
import { type Gate, STANDARDS_PATH, loadStandards } from '../standards.js';
import {
  PROGRAM,
  type Progress,
  type Viewport,
  printableBlock,
  progressStream,
  renderCommandHelp,
  renderTable,
  startProgress,
  wrapList,
  wrapText,
} from '../usage.js';
import { runLine } from './interview.js';
import { positionalTokens } from './resume.js';
import { cell } from './runs.js';

/** Generous: writing a goal is a person typing, and the limit is a runaway guard. */
const DEFAULT_MAX_TURNS = 60;

/** How many exchanges are taken before the CLI stops asking. */
const MAX_EXCHANGES = 100;

/** What the progress line says while a turn is running. */
const WORKING = 'Thinking';

/* -------------------------------------------------------------------------- */
/* The value a name is                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A goal name, checked as a name before it is ever joined to a path.
 *
 * The probe is a name that is really a path: it is the one thing this value
 * type exists to refuse, so it is the one the gate suite drives it with.
 */
export const goalNameValue: ValueType<string> = {
  arg: 'name',
  invalid: '../not-a-goal-name',
  parse(raw, ctx) {
    const name = raw.trim();
    const fault = goalNameFault(name);
    if (fault !== undefined) {
      throw new UsageError('invalid value "' + raw + '" for ' + ctx.flag + ': ' + fault, ctx.usage);
    }
    return name;
  },
};

/* -------------------------------------------------------------------------- */
/* Flags                                                                       */
/* -------------------------------------------------------------------------- */

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Read and write the goals under dir instead of here',
};

const jsonFlag: BooleanFlagSpec = {
  long: 'json',
  summary: 'Output the listing as JSON',
};

const modelFlag: ValueFlagSpec<string> = {
  long: 'model',
  short: 'm',
  value: modelValue,
  summary: 'Model id for goals new',
  default: 'inherit',
};

const maxTurnsFlag: ValueFlagSpec<number> = {
  long: 'max-turns',
  value: countValue,
  summary: 'Stop goals new after int agent turns',
  default: DEFAULT_MAX_TURNS,
};

const pluginDirFlag: ValueFlagSpec<string> = {
  long: 'plugin-dir',
  value: directoryValue,
  summary: 'Read the plugin markdown from dir, overriding ' + PLUGIN_DIR_ENV,
};

const flags: FlagSpec[] = [
  directoryFlag,
  jsonFlag,
  maxTurnsFlag,
  modelFlag,
  pluginDirFlag,
];

const nameArgument: ArgumentSpec<string> = {
  name: 'name',
  value: goalNameValue,
};

const pluginDirEnv: EnvSpec<string> = {
  name: PLUGIN_DIR_ENV,
  value: directoryValue,
  overriddenBy: pluginDirFlag,
};

/** Every field of a listing record, as `--json` writes them. */
const JSON_FIELDS: readonly string[] = ['description', 'name', 'path'];

/* -------------------------------------------------------------------------- */
/* The command                                                                 */
/* -------------------------------------------------------------------------- */

const LIST_USAGE = PROGRAM + ' goals [flags]';
const SHOW_USAGE = PROGRAM + ' goals show <name> [flags]';
const NEW_USAGE = PROGRAM + ' goals new <name> [flags]';

const goalsCommand: Command = {
  name: 'goals',
  summary: 'List the named goals this repository keeps, and write new ones',
  usage: PROGRAM + ' goals [show <name> | new <name>] [flags]',
  group: 'core',
  description: [
    'List the named goals this repository keeps, and write new ones.',
    'A goal is one reusable job, kept as ' +
      GOALS_LABEL +
      '/<name>.md in the same format a\nrun already consumes as a spec. A job worth doing twice is then written down once\nand versioned beside the code it is about, and any run can name it instead of\nrestating it.',
    'With no subcommand this lists what is there. On a terminal the listing is laid out\nin aligned columns; piped, it is one tab-delimited record per line with no header\nrow, so the output stays something cut and sort can read. --json writes the\nrecords themselves.',
    'A repository with no goals prints nothing to stdout and says so on stderr. That is\nstill a success and exits 0: listing no goals is a complete answer to the question,\nand a code CI gates on must not turn on an empty directory.',
    'goals new is a conversation, so it needs a terminal on both ends and exits 2\nwithout one. It reads the repository but writes nothing itself: the file is shown\nto you whole, and this command writes it only once you have approved it.',
  ],
  flags,
  argument: nameArgument,
  env: [pluginDirEnv],
  cwdFlag: directoryFlag,
  // A listing of nothing is a listing, so this one is allowed to succeed with an
  // empty stdout, exactly as the run ledger's listing is.
  emptyIsSuccess: true,
  sections: [
    {
      title: 'SUBCOMMANDS',
      lines: [
        '  goals              list every goal with its description',
        '  goals show <name>  print one goal file',
        '  goals new <name>   interview for one, and write it once approved',
        '',
        ...wrapText(
          '--json applies to the listing, and --model, --max-turns and ' +
            '--plugin-dir to goals new. -C applies to all three. A flag given to ' +
            'a form that does not take it is refused rather than ignored.',
          78,
          2,
        ),
      ],
    },
    {
      title: 'RESOLUTION ORDER',
      lines: [
        '  run and plan read their one argument in this order:',
        '',
        '  1. a path to a file that exists   read as a spec',
        '  2. a bare token naming a goal     that goal',
        '  3. anything else                  a one-line goal',
        '',
        ...wrapText(
          'A token that is both — a file beside a goal of the same name — is ' +
            'refused instead of resolved, naming both and the spelling that ' +
            'picks each. The two are different runs, and the difference would ' +
            'otherwise be invisible.',
          78,
          2,
        ),
      ],
    },
    {
      title: 'JSON FIELDS',
      lines: [
        ...wrapList(JSON_FIELDS, 2),
        '',
        ...wrapText(
          'A goal that carries no heading and no prose has no description, and ' +
            'the field is null rather than missing: the shape of a record never ' +
            'depends on what is in it.',
          78,
          2,
        ),
      ],
    },
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
        ...wrapText(
          'One model, because writing a goal has one agent: it asks the ' +
            'questions and proposes the file. The builder and critic families a ' +
            'run takes have nothing to pin here.',
          78,
          2,
        ),
      ],
    },
  ],
  examples: [
    PROGRAM + ' goals',
    PROGRAM + ' goals show release-notes',
    PROGRAM + ' goals new release-notes',
    PROGRAM + ' run release-notes',
    PROGRAM + " goals --json | jq -r '.[].name'",
  ],
  run: runGoals,
};

registerCommand(goalsCommand);

export { goalsCommand };

/** The three forms, each with the usage line that belongs to it. */
const listForm: Command = { ...goalsCommand, usage: LIST_USAGE, argument: undefined };
const showForm: Command = { ...goalsCommand, usage: SHOW_USAGE };
const newForm: Command = { ...goalsCommand, usage: NEW_USAGE };

/* -------------------------------------------------------------------------- */
/* The listing                                                                 */
/* -------------------------------------------------------------------------- */

/** The columns, in order, always. */
const COLUMNS: readonly string[] = ['name', 'description'];

/** Stands in for a file that says nothing about itself. */
const NO_DESCRIPTION = '-';

/**
 * The goals as a table.
 *
 * A terminal gets aligned columns under an uppercase header; a pipe gets one
 * tab-delimited record per line. The name keeps its width while the description
 * still has any to give: it is the cell somebody has to be able to type back in
 * at `run`, and half a name is not a shorter name.
 */
export function renderGoals(goals: readonly Goal[], view: Viewport): string {
  const rows = goals.map((goal) => [
    cell(goal.name),
    goal.description === '' ? NO_DESCRIPTION : cell(goal.description),
  ]);
  return renderTable(COLUMNS, rows, view, 0, ['name']).join('\n') + '\n';
}

/** One record as `--json` writes it: every documented field, on every record. */
export interface GoalJson {
  description: string | null;
  name: string;
  path: string;
}

export function asJson(goals: readonly Goal[]): GoalJson[] {
  return goals.map((goal) => ({
    description: goal.description === '' ? null : goal.description,
    name: goal.name,
    path: goal.path,
  }));
}

/* -------------------------------------------------------------------------- */
/* Which form was asked for                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where in `argv` the first positional token sits.
 *
 * Derived from the parser's own reading of the command line rather than from a
 * second copy of it: a prefix is a positional's prefix exactly when reading one
 * token more turns up the first positional. That keeps the subcommand word and
 * the flag arity in step by construction — `--model show` is a model called
 * show, here and in `parseInvocation` alike.
 */
export function firstPositionalIndex(command: Command, argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    if (positionalTokens(command, argv.slice(0, index + 1)).length === 1) return index;
  }
  return -1;
}

/** The command line with the subcommand word taken out of it. */
function withoutSubcommand(argv: readonly string[]): string[] {
  const at = firstPositionalIndex(goalsCommand, argv);
  return at === -1 ? [...argv] : [...argv.slice(0, at), ...argv.slice(at + 1)];
}

/** True when this invocation wrote `flag`, whatever kind of flag it is. */
function wasGiven(args: Invocation, flag: FlagSpec): boolean {
  return flag.value === undefined
    ? args.bool(flag as BooleanFlagSpec)
    : args.get(flag as ValueFlagSpec<unknown>) !== undefined;
}

/** Which form each flag belongs to, for a rejection that says where to put it. */
const FLAG_HOME = new Map<FlagSpec, string>([
  [jsonFlag, LIST_USAGE],
  [modelFlag, NEW_USAGE],
  [maxTurnsFlag, NEW_USAGE],
  [pluginDirFlag, NEW_USAGE],
]);

/**
 * Refuses a flag that belongs to another form.
 *
 * Ignoring it would be worse than refusing it: `goals show x --json` that
 * quietly prints markdown has answered a question nobody asked, and the reader
 * finds out from the output rather than from the CLI.
 */
function refuseUnrelatedFlags(
  args: Invocation,
  allowed: readonly FlagSpec[],
  form: string,
  usage: string,
): void {
  for (const flag of flags) {
    if (allowed.includes(flag) || !wasGiven(args, flag)) continue;
    throw new UsageError(
      [
        'flag ' + args.as(flag) + ' is not available for "' + form + '"',
        '  it applies to: ' + (FLAG_HOME.get(flag) ?? goalsCommand.usage),
      ].join('\n'),
      usage,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Running it                                                                  */
/* -------------------------------------------------------------------------- */

async function runGoals(argv: string[], ctx: Ctx): Promise<number> {
  const tokens = positionalTokens(goalsCommand, argv);
  const subcommand = tokens[0];

  // Help wins over everything, including a subcommand that does not exist.
  const wantsHelp = argv.some((token) => token === '--help' || token === '-h');

  if (!wantsHelp && subcommand !== undefined && subcommand !== 'show' && subcommand !== 'new') {
    throw new UsageError(
      'unknown subcommand "' +
        subcommand +
        '" for "' +
        PROGRAM +
        ' goals": expected show or new',
      goalsCommand.usage,
    );
  }

  const form = wantsHelp ? listForm : subcommand === 'show' ? showForm : subcommand === 'new' ? newForm : listForm;
  const rest = subcommand === undefined ? argv : withoutSubcommand(argv);
  const args = parseInvocation(form, rest, ctx);

  if (args.help) {
    ctx.stdout.write(renderCommandHelp(goalsCommand));
    return EXIT.WIN;
  }

  if (subcommand === 'show') {
    refuseUnrelatedFlags(args, [directoryFlag], PROGRAM + ' goals show', SHOW_USAGE);
    return showGoal(args.cwd, args.argument(nameArgument), ctx);
  }
  if (subcommand === 'new') {
    refuseUnrelatedFlags(
      args,
      [directoryFlag, modelFlag, maxTurnsFlag, pluginDirFlag],
      PROGRAM + ' goals new',
      NEW_USAGE,
    );
    return newGoal(args, ctx, args.argument(nameArgument));
  }

  refuseUnrelatedFlags(args, [directoryFlag, jsonFlag], PROGRAM + ' goals', LIST_USAGE);
  return listing(args.cwd, args.bool(jsonFlag), ctx);
}

/* -------------------------------------------------------------------------- */
/* goals                                                                       */
/* -------------------------------------------------------------------------- */

function listing(cwd: string, json: boolean, ctx: Ctx): number {
  const view: Viewport = { tty: ctx.isTTY, width: ctx.width };
  const goals = listGoals(cwd);

  if (json) {
    const records = asJson(goals);
    // Indented for a terminal, one line for a pipe: the same output either way,
    // laid out for whoever is reading it.
    ctx.stdout.write(
      (view.tty ? JSON.stringify(records, null, 2) : JSON.stringify(records)) + '\n',
    );
    return EXIT.WIN;
  }

  // A repository with no goals is not a table with no rows: an empty table is a
  // header row over nothing, which reads as though something was lost. It is
  // said on the error stream, so a listing piped into something else is a
  // listing or is empty, and never a sentence about the absence of one.
  if (goals.length === 0) {
    ctx.stderr.write('no goals found in ' + goalsDir(cwd) + '\n');
    return EXIT.WIN;
  }

  ctx.stdout.write(renderGoals(goals, view));
  return EXIT.WIN;
}

/* -------------------------------------------------------------------------- */
/* goals show                                                                  */
/* -------------------------------------------------------------------------- */

/** What to say when the name is not one of the names there are. */
function unknownGoal(name: string, cwd: string): UsageError {
  const names = listGoals(cwd).map((goal) => goal.name);
  const detail =
    names.length === 0
      ? [
          '  there are no goals here yet',
          '  write one with `' + PROGRAM + ' goals new <name>`',
        ]
      : ['  available goals:', ...wrapText(names.join(', '), 78, 4)];
  return new UsageError(
    ['unknown goal "' + name + '" in ' + goalsDir(cwd), ...detail].join('\n'),
    SHOW_USAGE,
  );
}

function showGoal(cwd: string, name: string, ctx: Ctx): number {
  const path = findGoal(cwd, name);
  if (path === undefined) throw unknownGoal(name, cwd);

  const text = readGoalFile(path);
  /*
   * The file as it was written, minus what a terminal would obey rather than
   * draw — and only when there is a terminal to obey it. A goal file arrives
   * with a repository somebody cloned, so on screen it is neutralised like
   * every other surface here; down a pipe there is no cursor to hijack and no
   * reason for the bytes to be anything but the bytes.
   */
  const body = ctx.isTTY ? printableBlock(text) : text;
  ctx.stdout.write(body.endsWith('\n') ? body : body + '\n');
  return EXIT.WIN;
}

/* -------------------------------------------------------------------------- */
/* goals new                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What this conversation is for, handed to the loaded interview markdown in
 * place of its own argument.
 *
 * Scope only. What to ask, how to ask it, and when to stop are that file's
 * business; what this says is which one file is wanted, and that the file is
 * proposed rather than written.
 */
function brief(name: string, path: string, standing: readonly Gate[]): string {
  const lines = [
    'Scope: one named goal for this repository, called "' + name + '", and nothing else.',
    'There is no mockup and no second file. Interview for a single reusable job —',
    'what it is, what finished means as something checkable, the constraints that',
    'make it a loss, and what the result is measured against — then propose the',
    'whole file, in the spec format, as ' + path + '.',
  ];

  /*
   * A goal written here has to be a goal that runs here.
   *
   * The repo's standing gates are inherited by every run whether or not this
   * file repeats them, and a file that sets out gates of its own is read as
   * setting out the run's whole list — so a paraphrase of a standing gate is a
   * standing gate weakened, and the input boundary refuses it. Saying so here
   * is what stops this command from authoring files its own guard rejects.
   */
  if (standing.length > 0) {
    lines.push(
      '',
      'This repository declares standing gates in ' + STANDARDS_PATH + ', and every run',
      'here inherits them whether or not this file repeats them. Do not paraphrase',
      'them. Either give the goal no gate or constraint list at all, and let it',
      'inherit these, or copy them into it word for word as they read below and put',
      'any new ones under their own numbers after them:',
      '',
      ...standing.map((gate) => '  ' + gate.id + '. ' + gate.text),
    );
  }
  return lines.join('\n');
}

/**
 * What the CLI needs back, and nothing about what to say.
 *
 * Output shape only: a program cannot read "show the user the whole file" and
 * know which part of a turn the file was. The delimiters say so, and they are
 * two whole lines because the file being delimited is markdown and carries
 * fences of its own.
 */
const REPORTING_SHAPE = [
  '---',
  '',
  'Reporting shape. This CLI is carrying the conversation and owns the file, so it',
  'needs the proposal marked off. When the file is ready, put it between these two',
  'lines, each on a line of its own:',
  '',
  '  ' + PROPOSAL_BEGIN,
  '  <the whole file>',
  '  ' + PROPOSAL_END,
  '',
  'The whole file every time, never a fragment and never a diff. Write nothing to',
  'disk yourself and propose no plan: this session is read-only, and the file is',
  'written by this CLI once the user has approved what you showed them. Everything',
  'else you would write for the reader, write as usual around the block.',
].join('\n');

async function newGoal(args: Invocation, ctx: Ctx, name: string): Promise<number> {
  const cwd = args.cwd;
  const fault = newGoalNameFault(name);
  if (fault !== undefined) {
    throw new UsageError('invalid value "' + name + '" for <name>: ' + fault, NEW_USAGE);
  }

  const existing = findGoal(cwd, name);
  if (existing !== undefined) {
    throw new UsageError(
      [
        'the goal "' + name + '" is already there',
        '  ' + existing,
        '  read it with `' + PROGRAM + ' goals show ' + name + '`, or pick another name',
      ].join('\n'),
      NEW_USAGE,
    );
  }

  const prompts = await import('../prompts.js');
  const io: PromptStreams = {
    input: process.stdin,
    output: ctx.stdout as NodeJS.WriteStream,
  };
  if (!prompts.isInteractive(io)) {
    throw new ConfigError(
      [
        'writing a goal is a conversation, so it needs a terminal on both ends',
        '  stdin and stdout are not both terminals here, so there is nobody to ask',
        '  write ' + GOALS_LABEL + '/' + name + '.md yourself, in the same format',
        '  `' + PROGRAM + ' run` reads a spec in',
      ].join('\n'),
    );
  }

  const pluginDir = args.get(pluginDirFlag) ?? args.env(pluginDirEnv);
  const env =
    pluginDir === undefined ? ctx.env : { ...ctx.env, [PLUGIN_DIR_ENV]: pluginDir };
  const sources = loadPluginSources(env);
  const models: ModelChoice = {
    ...DEFAULT_MODEL_CHOICE,
    lead: args.get(modelFlag) ?? DEFAULT_MODEL_CHOICE.lead,
  };
  const maxTurns = args.get(maxTurnsFlag) ?? DEFAULT_MAX_TURNS;
  const path = goalPath(cwd, name);
  // Null in a repo that declares none, which is the ordinary case and changes
  // nothing about the conversation (C2).
  const standards = loadStandards(cwd);

  prompts.beginRun(PROGRAM + ' goals new ' + name, io);

  const progress: Progress = startProgress(ctx.stdout, WORKING, true);
  const out = progressStream(ctx.stdout, progress);
  const frame: PromptStreams = { input: io.input, output: out as NodeJS.WriteStream };

  /** One turn of the conversation, resuming the session when there is one. */
  const turn = async (prompt: string, resumeFrom?: string): Promise<SessionResult> => {
    let messages = 0;
    const session = createSession({
      prompt,
      sources,
      models,
      cwd,
      env,
      // One agent, which proposes the file itself.
      subagents: false,
      maxTurns,
      // Read-only, because C5 is not a matter of the agent's good manners: this
      // command is the only thing that may write a goal, and only after the
      // user has approved the file it is about to write.
      permissionMode: 'plan',
      hooks: {
        onMessage(_message: SdkMessage): void {
          messages += 1;
          progress.update(
            WORKING + ' · ' + messages + (messages === 1 ? ' message' : ' messages'),
          );
        },
      },
    });
    progress.resume();
    try {
      return await (resumeFrom === undefined ? session.start() : session.resume(resumeFrom));
    } finally {
      progress.suspend();
    }
  };

  let result = await turn(
    renderLeadPrompt(sources.interviewMd, brief(name, path, standards?.gates ?? [])) +
      '\n\n' +
      REPORTING_SHAPE +
      '\n',
  );

  try {
    for (let exchange = 0; ; exchange += 1) {
      if (result.status !== 'complete') {
        prompts.endRun(
          'Stopped — ' + (result.error ?? 'the conversation did not finish'),
          frame,
        );
        return EXIT.LOSS;
      }

      const said = readProposal(result.text);
      prompts.logReport(said.rest, frame);

      const sessionId = result.sessionId;
      if (said.proposal !== undefined) {
        // Shown whole and unwrapped: this is the file, and a paragraph refolded
        // to the width of the frame is not the thing being approved. The path
        // goes on the line above the question rather than inside it, because a
        // question long enough to fold has the rail drawn down the middle of
        // it — and a path folded mid-token is a path nobody can read back.
        prompts.logReport('This is ' + path + ':\n\n' + said.proposal.trimEnd(), frame, {
          wrap: false,
        });
        const approved = await prompts.askConfirm('Write it?', frame, {
          initial: true,
          closeWith: 'Cancelled — nothing was written.',
        });
        if (approved) {
          writeGoal(cwd, name, said.proposal);
          prompts.logReport(
            ['Run it with:', '', '  ' + runLine(name, cwd, ctx.cwd)].join('\n'),
            frame,
            { wrap: false },
          );
          prompts.endRun('Goal written — ' + path, frame);
          return EXIT.WIN;
        }
      }

      if (sessionId === undefined) {
        prompts.endRun('Stopped — the conversation reported no session to carry on in', frame);
        return EXIT.LOSS;
      }
      if (exchange >= MAX_EXCHANGES) {
        prompts.endRun(
          'Stopped — ' + MAX_EXCHANGES + ' exchanges without a goal to write',
          frame,
        );
        return EXIT.LOSS;
      }

      const answer = await prompts.askText(
        said.proposal === undefined ? 'Your answer' : 'What should change?',
        frame,
        {
          placeholder: 'type your answer, or Ctrl+C to stop',
          closeWith: 'Cancelled — nothing was written.',
        },
      );
      result = await turn(answer, sessionId);
    }
  } catch (error) {
    // Ctrl+C at a question. The prompt has drawn the cancel and closed the
    // frame, and no file has been written, so there is nothing else to do.
    if (prompts.isPromptCancelled(error)) return EXIT.LOSS;
    throw error;
  }
}
