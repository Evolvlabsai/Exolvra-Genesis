/**
 * Process exit codes.
 *
 * Fixed by constraint C5 of `cli/cli-spec.md`. Every command resolves to one of
 * these three values; `gauntlet help exit-codes` is the user-facing statement of
 * the same contract.
 */
export const EXIT = { WIN: 0, LOSS: 1, USAGE: 2 } as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * The command was invoked incorrectly: a bad flag, a missing argument, an
 * unknown command. Always resolves to {@link EXIT.USAGE}.
 */
export class UsageError extends Error {
  /** One-line usage string echoed under the message, `gh` style. */
  readonly usage: string | undefined;

  constructor(message: string, usage?: string) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage;
  }
}

/**
 * The environment is not set up for the command to run: plugin markdown that
 * cannot be found, an unreadable file. Always resolves to {@link EXIT.USAGE}.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * The usage line a rejection should carry, given what the rejected value was
 * labelled as.
 *
 * A usage line is an instruction: this is how the command line is spelled. It
 * belongs under a fault in the command line and nowhere else. A flag (`-C`,
 * `--plugin-dir`) and the positional argument (`<goal-or-spec-path>`) both
 * appear in it, so both get it; an environment variable does not appear in it
 * at all, so echoing it under a bad `GAUNTLET_PLUGIN_DIR` would point the
 * reader at a line containing nothing they have to change.
 */
export function usageFor(label: string, usage?: string): string | undefined {
  return label.startsWith('-') || label.startsWith('<') ? usage : undefined;
}

/**
 * What kind of fault a thrown value is.
 *
 * `internal` is the deliberate catch-all: a fault this CLI never classified is
 * a bug in this CLI, and it is reported as one rather than passed off as a
 * verdict on the work. Which code it carries is {@link exitCodeFor}'s business;
 * that it is never silently mistaken for a judgement is this function's.
 */
export type ErrorKind = 'usage' | 'config' | 'internal';

export function errorKind(error: unknown): ErrorKind {
  if (error instanceof UsageError) return 'usage';
  if (error instanceof ConfigError) return 'config';
  return 'internal';
}

/**
 * Maps a thrown value to the exit code the process should carry.
 *
 * Three codes exist and no more (C5), so an internal fault has to be one of
 * them. It is {@link EXIT.LOSS}, the code for a run that did not win — a run
 * this CLI could not carry through is blocked, which is exactly what that code
 * covers. It is never {@link EXIT.WIN}, and never {@link EXIT.USAGE}: nothing
 * the user could retype would avoid it. `gauntlet help exit-codes` says so, and
 * every such exit prints what happened and where to report it, so a blocked run
 * is never mistaken on the terminal for a verdict that was actually reached.
 */
export function exitCodeFor(error: unknown): ExitCode {
  return errorKind(error) === 'internal' ? EXIT.LOSS : EXIT.USAGE;
}

/**
 * The code a command really carries, given whether it produced any output.
 *
 * {@link EXIT.WIN} is a claim: the command produced what it was asked for. A
 * command that resolves to it having written nothing to stdout produced
 * nothing, so it did not win — the run is reported as unfinished instead. The
 * rule is here, in front of the process exit, so no command can be silently
 * successful by forgetting to print.
 */
export function exitCodeForOutput(code: ExitCode, wroteOutput: boolean): ExitCode {
  return code === EXIT.WIN && !wroteOutput ? EXIT.LOSS : code;
}
