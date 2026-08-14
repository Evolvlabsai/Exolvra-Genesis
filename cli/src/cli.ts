#!/usr/bin/env node
import { createRequire } from 'node:module';

import {
  EXIT,
  type ExitCode,
  UsageError,
  errorKind,
  exitCodeFor,
  exitCodeForOutput,
} from './exit.js';
import { type Ctx, findCommand, getCommands, loadCommands } from './registry.js';
import {
  DEFAULT_WIDTH,
  FORCE_TTY_ENV,
  HELP_TOPICS,
  MANUAL_URL,
  PROGRAM,
  ROOT_USAGE,
  type Viewport,
  findHelpTopic,
  printable,
  renderHelpTopic,
  renderInternalError,
  renderRootHelp,
  renderUnknownCommand,
  renderUsageError,
} from './usage.js';

function version(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version?: string };
  return pkg.version ?? '0.0.0';
}

function renderVersion(): string {
  const v = version();
  return PROGRAM + ' version ' + v + '\n' + MANUAL_URL + '/releases/tag/v' + v + '\n';
}

/** `exolvra-genesis help [<command> | <topic>]`. */
async function runHelp(rest: readonly string[], ctx: Ctx): Promise<ExitCode> {
  const name = rest[0];
  if (name === undefined) {
    ctx.stdout.write(renderRootHelp());
    return EXIT.WIN;
  }

  const command = findCommand(name);
  if (command !== undefined) {
    /*
     * The command prints its own page, rather than this path printing one for
     * it.
     *
     * `help x` and `x --help` are the same request, and they have to be the
     * same page — a reader who is shown two different pages for one command
     * has been told, by the CLI itself, that one of them is incomplete. A
     * command that lays its own page out is the case this exists for: a group
     * with subcommands has a section no generic renderer knows to draw, and
     * routing both spellings through the command is what makes the two agree
     * by construction rather than by two renderers being kept in step.
     *
     * Whatever followed the command name goes with it, so `help standards
     * check` asks the group for the leaf's page exactly as `standards check
     * --help` does. Dropping those tokens answered a question nobody asked and
     * called it the answer; handing them over also means a subcommand that
     * does not exist is refused here as it is refused there.
     */
    return settle(await command.run([...rest.slice(1), '--help'], ctx));
  }

  const topic = findHelpTopic(name);
  if (topic !== undefined) {
    ctx.stdout.write(renderHelpTopic(topic));
    return EXIT.WIN;
  }

  const known = [
    ...getCommands().map((c) => c.name),
    ...HELP_TOPICS.map((t) => t.name),
  ].join(', ');
  throw new UsageError(
    'unknown help topic "' + name + '" for "' + PROGRAM + '": expected one of ' + known,
    PROGRAM + ' help <command | topic>',
  );
}

/**
 * A command's answer as one of the three codes this CLI has.
 *
 * A command returns a number; the contract says three of them exist. Anything
 * else is a fault in this CLI rather than a verdict, and it lands on the code
 * for a run that did not finish.
 */
function settle(code: number): ExitCode {
  return code === EXIT.WIN || code === EXIT.LOSS || code === EXIT.USAGE
    ? code
    : EXIT.LOSS;
}

/* -------------------------------------------------------------------------- */
/* The far end of the pipe going away                                          */
/* -------------------------------------------------------------------------- */

/** True when a write failed because nothing is reading the other end. */
function isPipeClosed(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return (
    code === 'EPIPE' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_WRITE_AFTER_END'
  );
}

/** Reported once: the first closed pipe ends the process. */
let pipeReported = false;

/**
 * Ends the process on a closed pipe, having said so in one line.
 *
 * `exolvra-genesis ... | head -1` closes the reader while there is still output to
 * write, and that is a normal thing for a user to do. What it must not produce
 * is a Node stack trace about a stream the user never asked to know exists: one
 * line naming the stream and the reason, on stderr, and the exit that a run
 * which was cut off before finishing gets.
 */
function reportClosedPipe(name: string): never {
  if (!pipeReported) {
    pipeReported = true;
    try {
      process.stderr.write('write /dev/' + name + ': the pipe is being closed\n');
    } catch {
      // The reader of stderr is gone as well; there is nowhere left to say it.
    }
  }
  process.exit(EXIT.LOSS);
}

/**
 * Wraps a stream so what goes through it can be counted, and so a closed pipe
 * ends the process as one line rather than as a stack.
 *
 * A proxy rather than a stand-in object: commands are handed the real stream,
 * with every method it has, and the count is a side effect of writing to it.
 * Nothing has to remember to report that it printed something — and nothing has
 * to remember to survive its reader going away either, because every command
 * writes through the context and so through here.
 */
function metered(
  stream: NodeJS.WritableStream,
  name: string,
): {
  stream: NodeJS.WritableStream;
  wrote(): boolean;
} {
  let bytes = 0;
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  const proxy = new Proxy(stream, {
    get(target, property): unknown {
      if (property === 'write') {
        return (...args: unknown[]): boolean => {
          const chunk = args[0];
          if (typeof chunk === 'string') bytes += Buffer.byteLength(chunk);
          else if (chunk instanceof Uint8Array) bytes += chunk.byteLength;
          try {
            return write(...args);
          } catch (error) {
            if (isPipeClosed(error)) reportClosedPipe(name);
            throw error;
          }
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { stream: proxy, wrote: () => bytes > 0 };
}

/** What is said when a command claims success and printed nothing. */
function renderSilentSuccess(command: string): string {
  return (
    [
      PROGRAM + ': ' + command + ' produced no output',
      '  a command that produced nothing has not won, so the run is reported',
      '  as unfinished; this is a bug in ' + PROGRAM + ', please report it at',
      '  ' + MANUAL_URL + '/issues',
    ].join('\n') + '\n'
  );
}

async function dispatch(
  argv: readonly string[],
  ctx: Ctx,
): Promise<ExitCode> {
  const [first, ...rest] = argv;

  if (first === undefined || first === '--help' || first === '-h') {
    ctx.stdout.write(renderRootHelp());
    return EXIT.WIN;
  }
  if (first === '--version') {
    ctx.stdout.write(renderVersion());
    return EXIT.WIN;
  }
  if (first === 'help') {
    return runHelp(rest, ctx);
  }
  // A flag in the command slot is a bad flag, not a command with a strange name.
  if (first.startsWith('-') && first !== '-') {
    ctx.stderr.write(renderUsageError('unknown flag: ' + first, ROOT_USAGE));
    return EXIT.USAGE;
  }

  const command = findCommand(first);
  if (command === undefined) {
    ctx.stderr.write(renderUnknownCommand(first));
    return EXIT.USAGE;
  }

  return settle(await command.run([...rest], ctx));
}

export async function main(argv: readonly string[], ctx: Ctx): Promise<ExitCode> {
  await loadCommands();

  // Every command writes through the meter, so the success contract is checked
  // once, here, rather than trusted separately in each command.
  const stdout = metered(ctx.stdout, 'stdout');
  const code = await dispatch(argv, { ...ctx, stdout: stdout.stream });

  // The contract is that a command claiming success has produced what it was
  // asked for, and a command that printed nothing has not. A command that says
  // otherwise is taken at its word — see `Command.emptyIsSuccess`: a listing of
  // nothing is a complete listing, and reporting it as an unfinished run would
  // hand CI a failing code for an empty directory. Which commands are exempt is
  // declared by the commands themselves, so this stays one rule with a named
  // exception rather than a list of special cases kept here.
  const name = argv[0];
  const command = name === undefined ? undefined : findCommand(name);
  if (command?.emptyIsSuccess === true) return code;

  const settled = exitCodeForOutput(code, stdout.wrote());
  if (settled !== code) {
    ctx.stderr.write(
      renderSilentSuccess(name === undefined ? 'the command' : printable(name)),
    );
  }
  return settled;
}

/** Narrowest layout that still leaves room for a table of a few columns. */
const MIN_WIDTH = 40;

/**
 * Whether to lay the output out for a terminal, and how wide.
 *
 * A pipe gets the machine-readable form. `EXOLVRA_GENESIS_FORCE_TTY` asks for the
 * terminal form anyway, optionally at a fixed width, so the aligned output can
 * be captured to a file exactly as a terminal would show it.
 */
export function viewportFor(
  env: NodeJS.ProcessEnv,
  stdout: { isTTY?: boolean; columns?: number },
): Viewport {
  const forced = env[FORCE_TTY_ENV]?.trim();
  if (forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false') {
    const width = /^\d+$/.test(forced) ? Number(forced) : DEFAULT_WIDTH;
    return { tty: true, width: Math.max(MIN_WIDTH, width) };
  }
  if (stdout.isTTY !== true) return { tty: false, width: DEFAULT_WIDTH };
  return { tty: true, width: Math.max(MIN_WIDTH, stdout.columns ?? DEFAULT_WIDTH) };
}

const view = viewportFor(process.env, process.stdout);

/**
 * Whether a command may draw a progress line on stderr.
 *
 * A terminal, or a forced one — the same override that captures the terminal
 * layout of stdout, so a transcript can be taken of what a terminal is shown.
 * A plain pipe or file gets nothing.
 */
export function progressAllowed(
  env: NodeJS.ProcessEnv,
  stderr: { isTTY?: boolean },
): boolean {
  const forced = env[FORCE_TTY_ENV]?.trim();
  if (forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false') {
    return true;
  }
  return stderr.isTTY === true;
}

const ctx: Ctx = {
  program: PROGRAM,
  cwd: process.cwd(),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  isTTY: view.tty,
  isErrTTY: progressAllowed(process.env, process.stderr),
  width: view.width,
};

/**
 * Prints one thrown value, in the shape its kind gets, and settles the exit
 * code.
 *
 * The one place a fault becomes terminal output, so every route out of this
 * process converges here: the command that rejected, a stream that failed after
 * the command returned, a promise nobody awaited. A fault reaching the terminal
 * as a language stack trace would be this CLI declining to classify its own
 * failure in front of the user.
 */
function report(error: unknown): void {
  if (isPipeClosed(error)) reportClosedPipe('stdout');

  const code = exitCodeFor(error);
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    ctx.stderr.write(renderUsageError(message, error.usage));
  } else if (errorKind(error) !== 'internal') {
    ctx.stderr.write(renderUsageError(message));
  } else {
    // Nothing classified this, so it is a fault in this CLI. It is reported as
    // one — named, indented, and pointed at the issue tracker — rather than
    // handed to the user as a bare line that reads like a verdict.
    const first = process.argv[2];
    const command =
      first === undefined || first.startsWith('-')
        ? undefined
        : '"' + printable(first) + '"';
    ctx.stderr.write(
      renderInternalError(message === '' ? String(error) : message, command),
    );
  }
  process.exitCode = code;
}

/**
 * A stream error arrives as an event, not as a rejection, so it would otherwise
 * reach the terminal as an uncaught exception — a stack trace, at whatever
 * moment the write was flushed.
 */
for (const [name, stream] of [
  ['stdout', process.stdout],
  ['stderr', process.stderr],
] as const) {
  stream.on('error', (error: unknown) => {
    if (isPipeClosed(error)) reportClosedPipe(name);
    report(error);
    process.exit(process.exitCode === undefined ? EXIT.LOSS : Number(process.exitCode));
  });
}

process.on('uncaughtException', (error: unknown) => {
  report(error);
  process.exit(process.exitCode === undefined ? EXIT.LOSS : Number(process.exitCode));
});
process.on('unhandledRejection', (error: unknown) => {
  report(error);
  process.exit(process.exitCode === undefined ? EXIT.LOSS : Number(process.exitCode));
});

main(process.argv.slice(2), ctx)
  .then((code) => {
    process.exitCode = code;
  })
  .catch(report);
