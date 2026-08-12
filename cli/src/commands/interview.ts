import { resolve } from 'node:path';

import { renderLeadPrompt } from '../agents.js';
import { ConfigError, EXIT } from '../exit.js';
import { type ResolvedInput, inputAsArgument } from '../input.js';
import { DEFAULT_MODEL_CHOICE, type ModelChoice, listModels } from '../models.js';
import { openPath } from '../open.js';
import { PLUGIN_DIR_ENV, loadPluginSources } from '../plugin-dir.js';
import type { PromptStreams } from '../prompts.js';
import {
  type ArgumentSpec,
  type BooleanFlagSpec,
  type Command,
  type Ctx,
  type EnvSpec,
  type FlagSpec,
  type ValueFlagSpec,
  choiceValue,
  countValue,
  directoryValue,
  inputValue,
  modelValue,
  parseInvocation,
  registerCommand,
} from '../registry.js';
import { type SdkMessage, type SessionResult, createSession } from '../session.js';
import {
  PROGRAM,
  type Progress,
  printable,
  progressStream,
  renderCommandHelp,
  startProgress,
  wrapList,
  wrapText,
} from '../usage.js';
import { positionalTokens } from './resume.js';

/**
 * Generous: an interview is a person typing, and the turn limit is there to
 * stop a runaway session rather than to ration a conversation.
 */
const DEFAULT_MAX_TURNS = 60;

/**
 * How many exchanges are taken before the CLI stops asking.
 *
 * Not a limit on the conversation so much as a floor under a bug: an agent that
 * never signals the handoff would otherwise ask forever, and a loop with no end
 * is worse than one that says why it stopped.
 */
const MAX_EXCHANGES = 100;

/** What the progress line says while a turn is running. */
const WORKING = 'Thinking';

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;

/* -------------------------------------------------------------------------- */
/* Flags                                                                       */
/* -------------------------------------------------------------------------- */

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Write the spec and the mockup under dir instead of here',
};

const pluginDirFlag: ValueFlagSpec<string> = {
  long: 'plugin-dir',
  value: directoryValue,
  summary: 'Read the plugin markdown from dir, overriding ' + PLUGIN_DIR_ENV,
};

const modelFlag: ValueFlagSpec<string> = {
  long: 'model',
  short: 'm',
  value: modelValue,
  summary: 'Model id for the interview',
  default: 'inherit',
};

const maxTurnsFlag: ValueFlagSpec<number> = {
  long: 'max-turns',
  value: countValue,
  summary: 'Stop after int agent turns',
  default: DEFAULT_MAX_TURNS,
};

const permissionModeFlag: ValueFlagSpec<(typeof PERMISSION_MODES)[number]> = {
  long: 'permission-mode',
  value: choiceValue('mode', PERMISSION_MODES),
  summary: 'How the interview may use tools',
  default: 'acceptEdits',
};

const openFlag: BooleanFlagSpec = {
  long: 'open',
  summary: 'Open the mockup with the default handler when it is ready',
};

const flags: FlagSpec[] = [
  directoryFlag,
  maxTurnsFlag,
  modelFlag,
  openFlag,
  permissionModeFlag,
  pluginDirFlag,
];

const interviewArgument: ArgumentSpec<ResolvedInput> = {
  name: 'spec-path-or-idea',
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

const interviewCommand: Command = {
  name: 'interview',
  summary: 'Talk your way to a spec and a mockup, ready to run',
  usage: PROGRAM + ' interview [<spec-path-or-idea>] [flags]',
  group: 'core',
  description: [
    'Talk your way to a spec and a mockup, ready to run.',
    'interview loads the commands/interview.md it finds on disk and holds the\nconversation it describes: one question at a time, your answer resuming the same\nsession, until it hands off. What it asks, what it writes, and when it stops are\nin that file — this command carries the questions to you and your answers back.',
    'A path to an existing spec starts a modification pass. Anything else is a\none-line idea to start from, and no argument at all starts from nothing.',
    'It is a conversation, so it needs a terminal on both ends and exits 2 without\none. There is no --json: a stream of questions nobody can answer is not machine\noutput. It writes the spec and the mockup and nothing else — no run is started,\nno ledger row is added, and .gauntlet/state.json is untouched, because an\ninterview is not a run.',
    'When both files are approved it prints the exact command to run next. Ctrl+C at\nany question ends it; the files written so far are yours to keep.',
  ],
  flags,
  argument: interviewArgument,
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
        ...wrapText(
          'One model, because an interview has one agent: it asks the questions ' +
            'and writes both files itself. The builder and critic families a run ' +
            'takes have nothing to pin here.',
          78,
          2,
        ),
      ],
    },
  ],
  examples: [
    PROGRAM + ' interview',
    PROGRAM + ' interview "a CLI that turns a changelog into release notes"',
    PROGRAM + ' interview specs/checkout.md',
  ],
  run: runInterview,
};

registerCommand(interviewCommand);

export { interviewCommand };

/** The same command with its argument taken off, for an invocation with none. */
const withoutArgument: Command = { ...interviewCommand, argument: undefined };

/* -------------------------------------------------------------------------- */
/* The one thing the CLI asks to be told                                       */
/* -------------------------------------------------------------------------- */

const MARKER = '@gauntlet';

/**
 * What the CLI needs back, and nothing about what to say.
 *
 * Output shape only: the conversation, the questions, the files and when it is
 * over are the loaded markdown's business. This says how to tell a program that
 * the handoff has happened, because a program cannot read "print exactly what to
 * run next" and know that the moment has arrived.
 */
const HANDOFF_DIRECTIVE = [
  '---',
  '',
  'Reporting shape. This CLI is carrying the conversation, so it needs one line',
  'it can act on. When the handoff is reached, put this on a line of its own:',
  '',
  '  ' + MARKER + ' handoff <path to the spec> | <path to the mockup>',
  '',
  'Once, at the handoff and never before it, with the mockup field left empty if',
  'there is no mockup. Everything else you would write for the reader, write as',
  'usual — the line is in addition to it, not instead of it.',
].join('\n');

export interface Handoff {
  spec: string;
  mockup: string;
}

/** A path as it can be typed back: quoted only when it has to be. */
function typeable(path: string): string {
  return /[\s"']/.test(path) ? JSON.stringify(path) : path;
}

/**
 * The command to run the spec, as it can be typed from where the reader is.
 *
 * `-C` is carried over when the interview wrote somewhere other than the
 * directory the command was typed in. Without it the line names a path
 * relative to a directory the reader is not in — and `run` reads a path it
 * cannot find as a goal, so the line this CLI printed would start a run
 * against its own filename rather than against the spec.
 */
export function runLine(spec: string, wroteIn: string, typedIn: string): string {
  const redirected = resolve(wroteIn) !== resolve(typedIn);
  return (
    PROGRAM +
    ' run ' +
    (redirected ? '-C ' + typeable(wroteIn) + ' ' : '') +
    typeable(spec)
  );
}

/**
 * Reads a turn: the handoff line if it carried one, and the prose without it.
 *
 * The marker is addressed to this CLI, so it never reaches the reader — they
 * are shown the command to run, which is what the line is for.
 */
export function readHandoff(text: string): { handoff?: Handoff; rest: string } {
  const rest: string[] = [];
  let handoff: Handoff | undefined;

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(MARKER + ' handoff')) {
      rest.push(line);
      continue;
    }
    const body = trimmed.slice((MARKER + ' handoff').length).trim();
    // Two fields, and the first is the one that has to be there.
    const cut = body.indexOf('|');
    const spec = (cut === -1 ? body : body.slice(0, cut)).trim();
    const mockup = cut === -1 ? '' : body.slice(cut + 1).trim();
    if (spec === '') {
      rest.push(line);
      continue;
    }
    handoff ??= { spec, mockup };
  }

  return {
    ...(handoff === undefined ? {} : { handoff }),
    rest: rest.join('\n').trim(),
  };
}

/* -------------------------------------------------------------------------- */
/* Running it                                                                  */
/* -------------------------------------------------------------------------- */

async function runInterview(argv: string[], ctx: Ctx): Promise<number> {
  const named = positionalTokens(interviewCommand, argv).length > 0;
  const args = parseInvocation(named ? interviewCommand : withoutArgument, argv, ctx);

  if (args.help) {
    ctx.stdout.write(renderCommandHelp(interviewCommand));
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
        'an interview is a conversation, so it needs a terminal on both ends',
        '  stdin and stdout are not both terminals here, so there is nobody to ask',
        '  use `' + PROGRAM + ' run` for a run that needs no answers, or write the',
        '  spec by hand and pass it to `' + PROGRAM + ' run`',
      ].join('\n'),
    );
  }

  const cwd = args.cwd;
  const pluginDir = args.get(pluginDirFlag) ?? args.env(pluginDirEnv);
  const env =
    pluginDir === undefined ? ctx.env : { ...ctx.env, [PLUGIN_DIR_ENV]: pluginDir };
  const sources = loadPluginSources(env);

  const models: ModelChoice = {
    ...DEFAULT_MODEL_CHOICE,
    lead: args.get(modelFlag) ?? DEFAULT_MODEL_CHOICE.lead,
  };
  const maxTurns = args.get(maxTurnsFlag) ?? DEFAULT_MAX_TURNS;
  const permissionMode = args.get(permissionModeFlag) ?? 'acceptEdits';
  const argument = named ? inputAsArgument(args.argument(interviewArgument)) : '';

  prompts.beginRun(PROGRAM + ' interview', io);

  /*
   * A turn is a minute of an agent working with nothing to show yet — and on
   * the turns that write the spec or the mockup, rather more than a minute. On
   * a terminal that is a line that keeps moving; without one the screen simply
   * stops between the answer and the next question, which is the shape a hang
   * has. The stream knows about the line, so nothing is drawn over it.
   */
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
      // One agent, which writes both files itself.
      subagents: false,
      maxTurns,
      permissionMode,
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
    renderLeadPrompt(sources.interviewMd, argument) + '\n\n' + HANDOFF_DIRECTIVE + '\n',
  );

  try {
    for (let exchange = 0; ; exchange += 1) {
      if (result.status !== 'complete') {
        prompts.endRun(
          'Stopped — ' + printable(result.error ?? 'the interview did not finish'),
          frame,
        );
        return EXIT.LOSS;
      }

      const said = readHandoff(result.text);
      prompts.logReport(said.rest, frame);

      if (said.handoff !== undefined) {
        const { spec, mockup } = said.handoff;
        // The CLI-native translation of the markdown's own handoff line, and it
        // has to be runnable from the shell the reader is sitting in: a spec
        // path relative to a directory they are not in is not a path `run`
        // would find, and `run` reads what it cannot find as a goal — a run
        // against a sentence, started by a line this CLI told them to type.
        // Unwrapped, alone among everything this command draws: a command
        // folded inside the frame is folded with the rail down the middle of
        // it, so copying it off two rows picks the rail up too and the paste
        // does not run. Left long, the terminal soft-wraps it and it stays one
        // line to anything selecting it.
        prompts.logReport(
          ['Run it with:', '', '  ' + runLine(spec, cwd, ctx.cwd)].join('\n'),
          frame,
          { wrap: false },
        );
        if (mockup !== '' && args.bool(openFlag)) {
          const opened = await openPath(mockup);
          if (!opened.opened) {
            prompts.logReport(
              'The mockup could not be opened with ' +
                opened.command +
                ' (' +
                opened.reason +
                '); open it yourself at ' +
                mockup,
              frame,
            );
          }
        }
        prompts.endRun('Spec ready — ' + spec, frame);
        return EXIT.WIN;
      }

      const sessionId = result.sessionId;
      if (sessionId === undefined) {
        prompts.endRun('Stopped — the interview reported no session to carry on in', frame);
        return EXIT.LOSS;
      }
      if (exchange >= MAX_EXCHANGES) {
        prompts.endRun(
          'Stopped — ' + MAX_EXCHANGES + ' exchanges without a handoff',
          frame,
        );
        return EXIT.LOSS;
      }

      /*
       * Stopping here is not stopping before anything happened.
       *
       * The agent has taken at least one turn by now, and it writes the spec
       * and the mockup itself — so "no run started, nothing saved" would be
       * this CLI telling the user their files are not there. What is true is
       * what the help already promises them.
       */
      const answer = await prompts.askText('Your answer', frame, {
        placeholder: 'type your answer, or Ctrl+C to stop',
        closeWith: 'Cancelled — the files written so far are yours to keep.',
      });
      result = await turn(answer, sessionId);
    }
  } catch (error) {
    // Ctrl+C at a question. The prompt has drawn the cancel and closed the
    // frame; the files written so far are the user's, and there is no run to
    // settle, so there is nothing else to do.
    if (prompts.isPromptCancelled(error)) return EXIT.LOSS;
    throw error;
  }
}
