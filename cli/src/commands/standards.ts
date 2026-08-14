import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { ConfigError, EXIT, UsageError } from '../exit.js';
import type { PromptStreams } from '../prompts.js';
import {
  type ArgumentSpec,
  type Command,
  type Ctx,
  type FlagSpec,
  type ValueFlagSpec,
  choiceValue,
  directoryValue,
  parseInvocation,
  registerCommand,
} from '../registry.js';
import { RUN_DIR } from '../runs-store.js';
import {
  IGNORE_PATTERN,
  type IgnoreEdit,
  type IgnoreLineRef,
  STANDARDS_PATH,
  countOf,
  describeStandardsIssues,
  gateProblem,
  needsIgnorePattern,
  normalizeSubject,
  parseStandards,
  planIgnorePattern,
  readGitignore,
  readStandardsText,
  renderStandards,
  standardsPath,
  standingBarProblem,
  subjectKind,
  validateStandards,
  writeGitignore,
  writeStandards,
} from '../standards.js';
import {
  HELP_FLAG,
  MANUAL_URL,
  PROGRAM,
  renderCommandHelp,
  renderFlagTable,
  renderSection,
  truncate,
} from '../usage.js';
import { positionalTokens } from './resume.js';

/** Everything `prompts.ts` exports, loaded only when there is a terminal. */
type Prompts = typeof import('../prompts.js');

/* -------------------------------------------------------------------------- */
/* The shared surface                                                          */
/* -------------------------------------------------------------------------- */

const SUBCOMMANDS = ['check', 'init'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Read and write the standards of the repo in dir',
};

const flags: FlagSpec[] = [directoryFlag];

/**
 * The subcommand, validated like every other value the CLI accepts.
 *
 * Both leaves parse the whole command line, this token included, so `check` and
 * `init` are checked by the same value type the group declares rather than by a
 * comparison somewhere inside a dispatcher.
 */
const subcommandArgument: ArgumentSpec<Subcommand> = {
  name: 'command',
  value: choiceValue('command', SUBCOMMANDS),
};

/* -------------------------------------------------------------------------- */
/* standards check                                                             */
/* -------------------------------------------------------------------------- */

const checkCommand: Command = {
  name: 'check',
  summary: 'Validate the standards file this repo declares',
  usage: PROGRAM + ' standards check [flags]',
  description: [
    'Validate the standards file this repo declares.',
    'Reads .exolvra-genesis/standards.md and says, line by line, what is not a\nstandards file: a section missing, duplicated or out of order, a gate numbered\nout of sequence, a gate written out of adjectives rather than out of something\na reader could check, a standing bar artifact that does not resolve.',
    'A file with nothing wrong prints one line and exits 0. A file with problems\nprints every one of them and exits 2, so a hook or a CI step can gate on it.',
    'A repo with no standards file exits 2 as well, naming the path. Nothing was\nchecked, and reporting a check that never happened as a pass is the one answer\nthis must not give. Having no standards file is still perfectly fine: runs in a\nrepo without one behave exactly as they do now, and nothing else asks for it.',
  ],
  flags,
  argument: subcommandArgument,
  cwdFlag: directoryFlag,
  examples: [
    PROGRAM + ' standards check',
    PROGRAM + ' standards check -C ../other-repo',
  ],
  run: runCheck,
};

async function runCheck(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseInvocation(checkCommand, argv, ctx);
  if (args.help) {
    ctx.stdout.write(renderCommandHelp(checkCommand));
    return EXIT.WIN;
  }

  const cwd = args.cwd;
  const path = standardsPath(cwd);
  const text = readStandardsText(cwd);

  if (text === null) {
    throw new ConfigError(
      [
        'no standards file at ' + path,
        '  a repo without one is not a fault: every run here works exactly as it',
        '  does now, and nothing else will ask for it',
        '  write one with `' + PROGRAM + ' standards init`',
      ].join('\n'),
    );
  }

  const issues = validateStandards(text, { cwd });
  if (issues.length > 0) throw new ConfigError(describeStandardsIssues(path, issues));

  // One line, on stdout, because a command that exits 0 having printed nothing
  // has not said that it checked anything — the same contract every other
  // command here is held to. What it counts is what a reader would want to
  // confirm: that the file it read is the file they think they wrote.
  const { standards } = parseStandards(text);
  ctx.stdout.write(
    path +
      ': ' +
      countOf(standards.gates.length, 'gate', 'gates') +
      ', ' +
      countOf(standards.standingBar.length, 'standing bar entry', 'standing bar entries') +
      ', nothing wrong\n',
  );
  return EXIT.WIN;
}

/* -------------------------------------------------------------------------- */
/* standards init                                                              */
/* -------------------------------------------------------------------------- */

const initCommand: Command = {
  name: 'init',
  summary: 'Write one, one question at a time',
  usage: PROGRAM + ' standards init [flags]',
  description: [
    'Write .exolvra-genesis/standards.md, one question at a time.',
    'Asks what this repo is and what it ships, then the gates every change has to\nclear, then the artifacts and numbers a critic holds the work against, then the\nconventions a builder here should follow. An answer that is not something a\nreader could check comes back with the reason and the question again, so the\nfile that lands is one `' +
      PROGRAM +
      ' standards check` accepts.',
    'Nothing is written until the whole file is on screen and you have said yes to\nit. If .gitignore still ignores the whole of .exolvra-genesis/, the three lines\nthat keep run state ignored and standards and goals tracked are offered too,\nand applied only if you say yes to those as well.',
    'It is a conversation, so it needs a terminal on both ends and exits 2 without\none. Ctrl+C at any question ends it; nothing is written on the way out that was\nnot already written on the way in.',
  ],
  flags,
  argument: subcommandArgument,
  cwdFlag: directoryFlag,
  examples: [PROGRAM + ' standards init', PROGRAM + ' standards init -C ../other-repo'],
  run: runInit,
};

/** What the frame closes with when somebody stops before anything was written. */
const NOTHING_WRITTEN = 'Cancelled — nothing was written.';

/**
 * The heading the composed file carries.
 *
 * Derived rather than asked for, and derived rather than fixed. The directory a
 * repo sits in is what the repo is called nearly every time, so the heading
 * says which repo's standards these are without a sixth question at the top of
 * an interview that already asks five — and the whole file, heading included,
 * is on screen before anything is written, so a wrong guess is one somebody
 * sees and can decline. A directory with no name to give — a drive root — falls
 * back to the plain heading the composer defaults to.
 */
export function titleFor(cwd: string): string | undefined {
  const name = basename(resolve(cwd)).trim();
  return name === '' || /^\.+$/.test(name) ? undefined : 'Standards for ' + name;
}

/* -------------------------------------------------------------------------- */
/* Saying what an edit to somebody's .gitignore would do                       */
/* -------------------------------------------------------------------------- */

/** The sentence above the lines: what happens to them, and to nothing else. */
export function describeIgnoreEdit(edit: IgnoreEdit): string {
  const rest = edit.replaced.length - 1;
  if (edit.replaced.length <= 1) {
    return 'They go in place of this line, and nothing else in the file changes:';
  }
  return (
    'They go in place of the first of these ' +
    edit.replaced.length +
    ' lines. The other ' +
    (rest === 1 ? 'one is' : rest + ' are') +
    ' removed, because each would ignore the directory all over again. Nothing ' +
    'else in the file changes:'
  );
}

/** The lines themselves, numbered as the file numbers them. */
export function renderIgnoreLines(lines: readonly IgnoreLineRef[]): string {
  const column = lines.reduce(
    (widest, line) => Math.max(widest, String(line.number).length),
    0,
  );
  return lines
    .map((line) => '  ' + String(line.number).padStart(column) + '  ' + line.text.trim())
    .join('\n');
}

/**
 * What was done, line by line, once it was.
 *
 * The numbers are the ones the file had when the question was asked, which are
 * the numbers the reader just looked at — renumbering them to where they landed
 * would report the edit against a file nobody has seen yet.
 */
export function summariseIgnoreEdit(edit: IgnoreEdit): string[] {
  return edit.replaced.map((line, index) =>
    index === 0
      ? '  line ' + line.number + ' replaced by the three lines above'
      : '  line ' + line.number + ' removed',
  );
}

/**
 * Puts one question until the answer is one this CLI could act on, showing why
 * each rejected answer was rejected.
 *
 * No attempt limit, and that is deliberate: nothing here advances without a
 * keystroke, so the loop belongs to the person typing rather than to a machine
 * that could spin in it, and Ctrl+C is always the way out.
 */
async function askUntil(
  question: string,
  placeholder: string,
  problem: (answer: string) => string | undefined,
  prompts: Prompts,
  io: PromptStreams,
  closeWith: string,
): Promise<string> {
  for (;;) {
    const answer = await prompts.askText(question, io, { placeholder, closeWith });
    const reason = problem(answer);
    if (reason === undefined) return answer;
    prompts.logReport(reason, io);
  }
}

async function runInit(argv: string[], ctx: Ctx): Promise<number> {
  const args = parseInvocation(initCommand, argv, ctx);
  if (args.help) {
    ctx.stdout.write(renderCommandHelp(initCommand));
    return EXIT.WIN;
  }

  const prompts = await import('../prompts.js');
  const io: PromptStreams = {
    input: process.stdin,
    output: ctx.stdout as NodeJS.WriteStream,
  };
  if (!prompts.isInteractive(io)) {
    throw new ConfigError(
      [
        'writing standards is a conversation, so it needs a terminal on both ends',
        '  stdin and stdout are not both terminals here, so there is nobody to ask',
        '  write ' + STANDARDS_PATH + ' by hand instead, and check it with',
        '  `' + PROGRAM + ' standards check`',
      ].join('\n'),
    );
  }

  const cwd = args.cwd;
  const path = standardsPath(cwd);

  prompts.beginRun(PROGRAM + ' standards init', io);
  try {
    if (existsSync(path)) {
      // Standards are only ever written after somebody approves the content, and
      // that holds for replacing content as much as for creating it.
      prompts.logReport('There is already a standards file at ' + path + '.', io, {
        wrap: false,
      });
      const replace = await prompts.askConfirm('Write a new one over it?', io, {
        initial: false,
        closeWith: NOTHING_WRITTEN,
      });
      if (!replace) {
        prompts.endRun('Nothing written — ' + path + ' is as it was', io);
        return EXIT.LOSS;
      }
    }

    const purpose = await prompts.askText(
      'What does this repo build, and on what stack?',
      io,
      {
        placeholder: 'a sentence or two — the lead reads this first',
        closeWith: NOTHING_WRITTEN,
      },
    );

    /*
     * The lists end on an explicit yes rather than on an explicit no: Enter
     * finishes, adding another is something you ask for. A file that is short
     * is a file somebody will actually keep current, and everything here can be
     * added to later by editing it.
     */
    const gates: string[] = [];
    for (;;) {
      const gate = await askUntil(
        'Gate G' + (gates.length + 1) + ' — what has to be true of every change?',
        'a command, a file, or a number a reader could check',
        (answer) => {
          const problem = gateProblem(answer);
          return problem === undefined ? undefined : 'That gate is ' + problem;
        },
        prompts,
        io,
        NOTHING_WRITTEN,
      );
      gates.push(gate);
      const more = await prompts.askConfirm(
        'Add gate G' + (gates.length + 1) + '?',
        io,
        { initial: false, closeWith: NOTHING_WRITTEN },
      );
      if (!more) break;
    }

    const standingBar: { subject: string; description: string }[] = [];
    for (;;) {
      const position = standingBar.length + 1;
      const subject = normalizeSubject(
        await askUntil(
          'Standing bar ' + position + ' — a path to an artifact, or a number',
          'a path in this repo, or a figure like 200ms',
          (answer) => {
            const clean = normalizeSubject(answer);
            return standingBarProblem(clean, subjectKind(clean), cwd);
          },
          prompts,
          io,
          NOTHING_WRITTEN,
        ),
      );
      const description = await prompts.askText('What is ' + truncate(subject, 40) + '?', io, {
        placeholder: 'one line — what a critic compares against, and why',
        closeWith: NOTHING_WRITTEN,
      });
      standingBar.push({ subject, description });
      const more = await prompts.askConfirm('Add another standing bar entry?', io, {
        initial: false,
        closeWith: NOTHING_WRITTEN,
      });
      if (!more) break;
    }

    // Prose, and prose is not one line. R1 calls this section free prose and the
    // parser reads a multi-paragraph one back unchanged, so the only thing that
    // ever held it to a sentence was the question — which now takes paragraphs
    // until there are no more. The purpose above stays a single line, because
    // what it asks for is a sentence or two.
    const conventions = await prompts.askProse(
      'What should a builder here know before they start?',
      io,
      {
        placeholder: 'a paragraph — this is handed to every builder; Enter alone finishes',
        closeWith: NOTHING_WRITTEN,
      },
    );

    const title = titleFor(cwd);
    const text = renderStandards({
      ...(title === undefined ? {} : { title }),
      purpose,
      gates,
      standingBar,
      conventions,
    });

    const problems = validateStandards(text, { cwd });
    if (problems.length > 0) {
      // Unreachable while composing and checking agree: every answer above was
      // checked as it was given. Reported as the defect it would be rather than
      // written out as a file this CLI would then refuse to read.
      prompts.endRun('Stopped — the composed file did not check out', io);
      throw new Error(describeStandardsIssues(path, problems));
    }

    // Shown whole and unwrapped: this is the file, and a paragraph refolded to
    // the width of the frame is not the thing being approved. The path is on
    // the line above it rather than inside the question, because a question
    // long enough to fold has the rail drawn down the middle of the answer.
    prompts.logReport('This is ' + path + ':\n\n' + text.trimEnd(), io, { wrap: false });
    const write = await prompts.askConfirm('Write it?', io, {
      initial: true,
      closeWith: NOTHING_WRITTEN,
    });
    if (!write) {
      prompts.endRun('Nothing written — ' + path + ' was not created', io);
      return EXIT.LOSS;
    }
    writeStandards(cwd, text);
    prompts.logReport('Written: ' + path, io, { wrap: false });

    const ignore = readGitignore(cwd);
    if (ignore !== null && needsIgnorePattern(ignore)) {
      /*
       * The whole edit, before the question about it.
       *
       * A `.gitignore` is somebody's file, and what is being asked for here is
       * permission to change it. So the question has to be about everything
       * that would change: every blanket rule the edit touches, named and
       * numbered, not "the rule" while a second one further down quietly goes.
       * What it does not say, it does not do — nothing else in the file moves.
       */
      const edit = planIgnorePattern(ignore);
      // Three blocks, because they are three kinds of thing: prose, which folds
      // to the frame, and two sets of lines somebody is going to read against
      // their own file, which must not.
      prompts.logReport(
        '.gitignore ignores the whole of ' +
          RUN_DIR +
          '/, so the file just written would never be committed. These three ' +
          'lines keep run state ignored and standards and goals tracked:',
        io,
      );
      prompts.logReport(IGNORE_PATTERN.map((line) => '  ' + line).join('\n'), io, {
        wrap: false,
      });
      prompts.logReport(describeIgnoreEdit(edit), io);
      prompts.logReport(renderIgnoreLines(edit.replaced), io, { wrap: false });
      const apply = await prompts.askConfirm('Make that change?', io, {
        initial: true,
        closeWith: 'Cancelled — ' + path + ' is written; .gitignore is as it was.',
      });
      if (apply) {
        const written = writeGitignore(cwd, edit.text);
        prompts.logReport(
          ['Updated: ' + written, ...summariseIgnoreEdit(edit)].join('\n'),
          io,
          { wrap: false },
        );
      } else {
        prompts.logReport(
          '.gitignore left as it was — the three lines above are the ones to add.',
          io,
        );
      }
    }

    prompts.endRun('Standards written — ' + path, io);
    return EXIT.WIN;
  } catch (error) {
    // Ctrl+C at a question. The prompt has drawn the cancel and closed the
    // frame, and what is on disk is what the frame just said is on disk.
    if (prompts.isPromptCancelled(error)) return EXIT.LOSS;
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* The group                                                                   */
/* -------------------------------------------------------------------------- */

const LEAVES: readonly Command[] = [checkCommand, initCommand];

const standardsCommand: Command = {
  name: 'standards',
  summary: "Declare and check this repo's standing bar",
  usage: PROGRAM + ' standards <command> [flags]',
  group: 'core',
  description: [
    "Declare and check this repo's standing bar.",
    'Exolvra Genesis owns the loop; a repo owns what good means inside it.\n.exolvra-genesis/standards.md holds that: a purpose paragraph, the gates every\nchange has to clear, the artifacts and numbers a critic compares against, and\nthe conventions a builder here is handed. Every run in the repo inherits them,\nso the standard lives and versions beside the code it governs.',
    'None of it is required. A repo with no standards file is the ordinary case:\nit runs exactly as it does now, with no warning and no prompt.',
  ],
  flags,
  argument: subcommandArgument,
  cwdFlag: directoryFlag,
  examples: [
    PROGRAM + ' standards init',
    PROGRAM + ' standards check',
    PROGRAM + ' standards check -C ../other-repo',
  ],
  run: runStandards,
};

registerCommand(standardsCommand);

export { standardsCommand, checkCommand, initCommand };

/**
 * LEARN MORE, which is the same block on every page this CLI prints.
 *
 * The page renderer builds it privately, and a group page is laid out here
 * rather than by that renderer — commands before flags, the way both `gh` and
 * this CLI's own root help order them. So it is written once more, and the
 * suite holds the two copies against each other, which is what stops the
 * duplicate from being the thing that drifts.
 */
const LEARN_MORE: readonly string[] = [
  'LEARN MORE',
  '  Use `' + PROGRAM + ' <command> --help` for more information about a command.',
  '  Read the manual at ' + MANUAL_URL,
  '  Learn about exit codes using `' + PROGRAM + ' help exit-codes`',
  '  Learn about environment variables using `' + PROGRAM + ' help environment`',
  '',
];

/** The group page: what the subcommands are, before the flags they share. */
export function renderStandardsHelp(): string {
  const labels = LEAVES.map((leaf) => leaf.name + ':');
  const column = labels.reduce((widest, label) => Math.max(widest, label.length), 0);

  const description: string[] = [];
  for (const paragraph of standardsCommand.description ?? []) {
    description.push(paragraph, '');
  }

  const lines: string[] = [
    ...description,
    'USAGE',
    '  ' + standardsCommand.usage,
    '',
    ...renderSection(
      'AVAILABLE COMMANDS',
      LEAVES.map(
        (leaf, index) =>
          '  ' + (labels[index] ?? '').padEnd(column + 1) + leaf.summary,
      ),
    ),
    ...renderSection('FLAGS', renderFlagTable(standardsCommand.flags)),
    ...renderSection('INHERITED FLAGS', renderFlagTable([HELP_FLAG])),
    ...renderSection(
      'EXAMPLES',
      (standardsCommand.examples ?? []).map((example) => '  $ ' + example),
    ),
    ...LEARN_MORE,
  ];

  return lines.join('\n') + '\n';
}

/**
 * Whether the line asks for help.
 *
 * The flag boundary settles this for itself, and it has to be settled once more
 * out here, because which page to print and whether a stray argument is worth
 * complaining about are both decided before a leaf is chosen. Asking for help
 * wins over every other fault on the line, here exactly as it does there.
 */
function asksForHelp(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === '--') return false;
    if (token === '--help' || token === '-h') return true;
  }
  return false;
}

async function runStandards(argv: string[], ctx: Ctx): Promise<number> {
  // Which leaf, read off the command line by the same rules the parser uses, so
  // `standards -C dir check` finds `check` where the parser will find it too.
  const positionals = positionalTokens(standardsCommand, argv);
  const leaf = LEAVES.find((candidate) => candidate.name === positionals[0]);
  if (leaf !== undefined) {
    // A leaf takes no argument of its own. Left to the parser this arrives as
    // "accepts 1 arg, received 2" — the subcommand counted back at a reader
    // under a usage line that shows no argument at all.
    if (positionals.length > 1 && !asksForHelp(argv)) {
      throw new UsageError(
        'accepts no arguments, received ' + (positionals.length - 1),
        leaf.usage,
      );
    }
    return leaf.run(argv, ctx);
  }

  /*
   * A token in the subcommand slot that is not one, checked before help is
   * answered.
   *
   * Help wins over every other fault on the line, and this is not another
   * fault on the line: it is the line naming a command that does not exist.
   * `standards bogus --help` and `help standards bogus` are the same mistake as
   * `standards bogus`, and answering any of them with a page is telling the
   * reader the name they typed was fine. Rejected through the value type that
   * declares which subcommands there are, so there is one list and not two.
   */
  const named = positionals[0];
  if (named !== undefined) {
    subcommandArgument.value.parse(named, {
      flag: '<' + subcommandArgument.name + '>',
      usage: standardsCommand.usage,
      cwd: ctx.cwd,
    });
  }

  // No leaf named on the line. Everything left is the group's own boundary:
  // `--help` is the group page, a token that is not a subcommand is rejected by
  // the value type that declares which ones there are, and no token at all is
  // rejected as the missing argument it is.
  const args = parseInvocation(standardsCommand, argv, ctx);
  if (args.help) {
    ctx.stdout.write(renderStandardsHelp());
    return EXIT.WIN;
  }
  // Unreachable: the boundary above rejects a missing subcommand and one that
  // is not `check` or `init`, and anything it accepts was dispatched already. A
  // throw rather than a return, so a change that stopped rejecting could never
  // become a silent exit 0.
  throw new UsageError(
    'accepts 1 arg, received ' + positionals.length,
    standardsCommand.usage,
  );
}
