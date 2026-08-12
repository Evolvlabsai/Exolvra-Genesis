import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { UsageError } from './exit.js';
import { type ResolvedInput, requireDirectory, resolveInput } from './input.js';
import { assertKnownModel } from './models.js';

/* -------------------------------------------------------------------------- */
/* The validation boundary                                                     */
/* -------------------------------------------------------------------------- */

/** Everything a command needs from the process it runs in. */
export interface Ctx {
  readonly program: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** True when output is laid out for a terminal rather than for a pipe. */
  readonly isTTY: boolean;
  /**
   * True when {@link stderr} is a terminal, so a command may draw on it while
   * it works. Separate from {@link isTTY} because the two streams are separate:
   * stdout is very often a pipe while stderr is still the user's terminal, and
   * progress belongs on the one somebody is watching.
   */
  readonly isErrTTY: boolean;
  /** Columns the output is laid out for. */
  readonly width: number;
}

/** Where a value came from, and what a rejection has to quote. */
export interface ValueContext {
  /** The input exactly as the user wrote it: `-C`, `--model`, an env var name. */
  readonly flag: string;
  /** Usage line echoed under a rejection. */
  readonly usage: string;
  /** Directory relative paths resolve against. */
  readonly cwd: string;
}

/**
 * A kind of value this CLI accepts, and the only route by which one becomes
 * something the rest of the program — or the SDK — is allowed to see.
 */
export interface ValueType<T> {
  /** Placeholder rendered in the flag table: `--model model`. */
  readonly arg: string;
  /** Closed set of accepted values, rendered `{a|b|c}` in help. */
  readonly choices?: readonly string[];
  /**
   * A value of this kind that must always be rejected. Every declared flag,
   * argument, and environment variable is probed with it by the gate suite, so
   * a value type that does not really validate cannot ship unnoticed.
   */
  readonly invalid: string;
  /** Returns the validated value, or throws a {@link UsageError}. */
  parse(raw: string, ctx: ValueContext): T;
}

/** A value that is never valid anywhere, used as the rejection probe. */
export const INVALID_VALUE_PROBE = 'exolvra-genesis-invalid-value-probe';

function requirePositiveInt(raw: string, flag: string, usage: string): number {
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || parsed < 1 || !Number.isSafeInteger(parsed)) {
    throw new UsageError(
      'invalid value "' + raw + '" for ' + flag + ': expected a positive integer',
      usage,
    );
  }
  return parsed;
}

/** A model id, checked against the exact allowlist this build offers. */
export const modelValue: ValueType<string> = {
  arg: 'model',
  invalid: 'octopus',
  parse: (raw, ctx) => assertKnownModel(raw, ctx.flag, ctx.usage),
};

/** A directory that has to exist before the command can run. */
export const directoryValue: ValueType<string> = {
  arg: 'dir',
  invalid: INVALID_VALUE_PROBE,
  parse: (raw, ctx) => requireDirectory(raw, ctx.flag, ctx.cwd, ctx.usage),
};

/** A count of one or more. */
export const countValue: ValueType<number> = {
  arg: 'int',
  invalid: '0',
  parse: (raw, ctx) => requirePositiveInt(raw, ctx.flag, ctx.usage),
};

/** One of a fixed set of words. */
export function choiceValue<T extends string>(
  arg: string,
  choices: readonly T[],
): ValueType<T> {
  if (choices.length === 0) {
    throw new Error('a choice value needs at least one choice');
  }
  if ((choices as readonly string[]).includes(INVALID_VALUE_PROBE)) {
    throw new Error('the rejection probe cannot also be an accepted choice');
  }
  return {
    arg,
    choices,
    invalid: INVALID_VALUE_PROBE,
    parse(raw, ctx) {
      const match = choices.find((choice) => choice === raw);
      if (match !== undefined) return match;
      throw new UsageError(
        'invalid value "' +
          raw +
          '" for ' +
          ctx.flag +
          ': must be one of ' +
          choices.join(', '),
        ctx.usage,
      );
    },
  };
}

/**
 * A goal, or a path to a spec file that exists.
 *
 * Almost every string is a valid one — a path that is not there is a goal, by
 * the rule the plugin itself follows — so the probe is the one thing that can
 * never be either: an argument with nothing in it.
 */
export const inputValue: ValueType<ResolvedInput> = {
  arg: 'goal-or-spec-path',
  invalid: '   ',
  parse: (raw, ctx) => resolveInput(raw, ctx.cwd, ctx.usage),
};

/* -------------------------------------------------------------------------- */
/* Declarations                                                                */
/* -------------------------------------------------------------------------- */

interface FlagBase {
  /** Long name without dashes, e.g. `builder-model`. */
  long: string;
  /** Single-character short name without its dash, e.g. `m`. */
  short?: string;
  /** One-line description, rendered in the flag table. */
  summary: string;
}

/** A flag that takes no value. */
export interface BooleanFlagSpec extends FlagBase {
  value?: undefined;
  default?: undefined;
}

/** A flag that takes a value, which its {@link ValueType} validates. */
export interface ValueFlagSpec<T = unknown> extends FlagBase {
  value: ValueType<T>;
  /** Default value, rendered `gh` style: numbers bare, strings quoted. */
  default?: string | number;
}

export type FlagSpec = BooleanFlagSpec | ValueFlagSpec<unknown>;

/** The single positional argument a command accepts. */
export interface ArgumentSpec<T = unknown> {
  /** Name shown in the usage line, without angle brackets. */
  name: string;
  value: ValueType<T>;
}

/** An environment variable a command reads, validated before it runs. */
export interface EnvSpec<T = unknown> {
  name: string;
  value: ValueType<T>;
  /** When this flag is given the variable goes unused, so it is not checked. */
  overriddenBy?: ValueFlagSpec<unknown>;
}

/** An extra help section, rendered between the flag tables and EXAMPLES. */
export interface HelpSection {
  title: string;
  lines: string[];
}

/** Which root-help heading a command is listed under. */
export type CommandGroup = 'core' | 'additional';

export interface Command {
  /** Name as typed on the command line. */
  name: string;
  /** One line, shown in the root help command table. */
  summary: string;
  /** Full usage line, e.g. `exolvra-genesis plan <goal-or-spec-path> [flags]`. */
  usage: string;
  flags: FlagSpec[];
  /** The positional argument, validated at the same boundary as the flags. */
  argument?: ArgumentSpec<unknown>;
  /** Environment variables read by this command, validated before it runs. */
  env?: EnvSpec<unknown>[];
  /** The flag that redirects the directory every other path resolves against. */
  cwdFlag?: ValueFlagSpec<string>;
  examples?: string[];
  /** Paragraphs printed above USAGE in the command's own help. */
  description?: string[];
  /** Extra help sections, e.g. a table of accepted model ids. */
  sections?: HelpSection[];
  /** Root-help grouping. Defaults to `core`. */
  group?: CommandGroup;
  /**
   * True when this command may legitimately succeed having printed nothing.
   *
   * The rule it opts out of is that a command claiming success with an empty
   * stdout has not produced what it was asked for — which is the right rule for
   * a command whose job is to produce something, and the wrong one for a
   * command whose job is to list what is there. A listing of nothing is a
   * complete, correct listing; reporting it as a run that did not finish would
   * make "there is nothing here" indistinguishable from "something went wrong",
   * and would put a code CI gates on behind an empty directory.
   *
   * Declared per command rather than decided at the exit, so what is exempt is
   * visible in the command that is exempt, and so no other command can become
   * silently successful by forgetting to print.
   */
  emptyIsSuccess?: boolean;
  /** Runs the command and resolves to its exit code. */
  run(argv: string[], ctx: Ctx): Promise<number>;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

const commands = new Map<string, Command>();

export function registerCommand(c: Command): void {
  const existing = commands.get(c.name);
  if (existing !== undefined && existing !== c) {
    throw new Error(`a different command is already registered as "${c.name}"`);
  }
  commands.set(c.name, c);
}

/** Every registered command, sorted by name. */
export function getCommands(): Command[] {
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findCommand(name: string): Command | undefined {
  return commands.get(name);
}

let commandsLoaded = false;

/**
 * Imports every module in the sibling `commands/` directory. Each one registers
 * itself, so adding a command is adding a file — no central list to edit.
 */
export async function loadCommands(): Promise<void> {
  if (commandsLoaded) return;
  commandsLoaded = true;
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'commands');
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .sort();
  for (const entry of entries) {
    await import(pathToFileURL(join(dir, entry)).href);
  }
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** One fully validated invocation of one command. */
export interface Invocation {
  /** True when `--help` or `-h` was passed; nothing else was validated. */
  readonly help: boolean;
  /** The directory this invocation runs in, absolute. */
  readonly cwd: string;
  /** The validated positional argument. */
  argument<T>(spec: ArgumentSpec<T>): T;
  /** The validated value of a flag, or undefined when it was not given. */
  get<T>(flag: ValueFlagSpec<T>): T | undefined;
  bool(flag: BooleanFlagSpec): boolean;
  /** The validated value of an environment variable, when one was set. */
  env<T>(spec: EnvSpec<T>): T | undefined;
  /**
   * The flag exactly as the user typed it — `-C` when they wrote `-C`,
   * `--directory` when they wrote that or left it unset. Rejections quote this
   * so they name the user's own input.
   */
  as(flag: FlagSpec): string;
}

interface RawFlag {
  written: string;
  /** The text the user gave, or undefined for a flag that takes no value. */
  text: string | undefined;
}

function helpInvocation(cwd: string): Invocation {
  return {
    help: true,
    cwd,
    argument(): never {
      throw new Error('help was requested; no argument was parsed');
    },
    get: () => undefined,
    bool: () => false,
    env: () => undefined,
    as: (flag) => '--' + flag.long,
  };
}

/**
 * Turns `argv` into a validated invocation of `command`.
 *
 * This is the only place a user-supplied value becomes a value the program will
 * act on: the positional argument, every flag, and every declared environment
 * variable are put through their {@link ValueType} here, before any session
 * starts. Anything rejected raises a {@link UsageError}, which the CLI turns
 * into exit code 2.
 */
export function parseInvocation(
  command: Command,
  argv: readonly string[],
  ctx: Ctx,
): Invocation {
  const usage = command.usage;
  const byLong = new Map<string, FlagSpec>();
  const byShort = new Map<string, FlagSpec>();
  for (const flag of command.flags) {
    byLong.set(flag.long, flag);
    if (flag.short !== undefined) byShort.set(flag.short, flag);
  }

  // Asking for help always wins, even alongside arguments that would not parse.
  for (const token of argv) {
    if (token === '--') break;
    if (token === '--help' || token === '-h') return helpInvocation(resolve(ctx.cwd));
  }

  // Pass one: shape only. Which flags were written, and with what text.
  const raw = new Map<FlagSpec, RawFlag>();
  const positional: string[] = [];
  let terminated = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

    if (terminated || token === '-' || !token.startsWith('-')) {
      positional.push(token);
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
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    const written = (isLong ? '--' : '-') + name;

    const flag = isLong ? byLong.get(name) : byShort.get(name);
    if (flag === undefined) {
      throw new UsageError('unknown flag: ' + written, usage);
    }

    if (flag.value === undefined) {
      if (inline !== undefined) {
        throw new UsageError('flag --' + flag.long + ' takes no value', usage);
      }
      raw.set(flag, { written, text: undefined });
      continue;
    }

    let text = inline;
    if (text === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new UsageError('flag needs an argument: --' + flag.long, usage);
      }
      text = next;
      i += 1;
    }
    // An empty value is never meaningful for a flag that takes one, and left
    // alone it becomes a silent default further down: `-C ""` would resolve to
    // the current directory rather than to the directory the user meant.
    if (text.trim() === '') {
      throw new UsageError('flag needs a non-empty argument: ' + written, usage);
    }
    raw.set(flag, { written, text });
  }

  // Pass two: values. The directory redirect goes first, because every other
  // path in the invocation resolves against whatever it settles on.
  const values = new Map<FlagSpec, unknown>();
  let cwd = resolve(ctx.cwd);

  const validate = (flag: ValueFlagSpec<unknown>): unknown => {
    const entry = raw.get(flag);
    if (entry === undefined || entry.text === undefined) return undefined;
    const parsed = flag.value.parse(entry.text, {
      flag: entry.written,
      usage,
      cwd,
    });
    values.set(flag, parsed);
    return parsed;
  };

  const cwdFlag = command.cwdFlag;
  if (cwdFlag !== undefined) {
    const redirected = validate(cwdFlag);
    if (typeof redirected === 'string') cwd = redirected;
  }
  for (const flag of command.flags) {
    if (flag === cwdFlag || flag.value === undefined) continue;
    validate(flag);
  }

  // Pass three: the environment this command reads. Ahead of the argument
  // because no invocation of the command can run until it is fixed, so it is
  // the fault to report however the rest of the command line was written.
  const envValues = new Map<EnvSpec<unknown>, unknown>();
  for (const spec of command.env ?? []) {
    if (spec.overriddenBy !== undefined && raw.has(spec.overriddenBy)) continue;
    const written = ctx.env[spec.name];
    if (written === undefined || written.trim() === '') continue;
    envValues.set(spec, spec.value.parse(written, { flag: spec.name, usage, cwd }));
  }

  // Pass four: arity, then the positional argument itself.
  const argSpec = command.argument;
  let argument: unknown;
  if (argSpec === undefined) {
    if (positional.length > 0) {
      throw new UsageError(
        'accepts no arguments, received ' + positional.length,
        usage,
      );
    }
  } else {
    if (positional.length !== 1) {
      throw new UsageError('accepts 1 arg, received ' + positional.length, usage);
    }
    argument = argSpec.value.parse(positional[0] as string, {
      flag: '<' + argSpec.name + '>',
      usage,
      cwd,
    });
  }

  return {
    help: false,
    cwd,
    argument<T>(spec: ArgumentSpec<T>): T {
      if (spec !== argSpec) {
        throw new Error('"' + spec.name + '" is not this command\'s argument');
      }
      return argument as T;
    },
    get<T>(flag: ValueFlagSpec<T>): T | undefined {
      return values.get(flag) as T | undefined;
    },
    bool(flag) {
      return raw.has(flag);
    },
    env<T>(spec: EnvSpec<T>): T | undefined {
      return envValues.get(spec) as T | undefined;
    },
    as(flag) {
      return raw.get(flag)?.written ?? '--' + flag.long;
    },
  };
}
