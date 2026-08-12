import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { ConfigError, UsageError, usageFor } from './exit.js';

/**
 * What the user handed the CLI: a path to an existing spec file, or a one-line
 * goal. Requirement R1 — resolution is shared so every command agrees.
 *
 * `given` is the argument exactly as it was typed, kept alongside the resolved
 * path because they are for different readers: the path is what the agent is
 * handed, and `given` is what the user gets echoed back to them.
 */
export type ResolvedInput =
  | { kind: 'spec'; path: string; given: string; text: string }
  | { kind: 'goal'; goal: string };

/** What a path on disk turned out to be. `missing` covers unreadable too. */
export type PathKind = 'file' | 'directory' | 'other' | 'missing';

/**
 * Classifies a path once, without throwing. Every filesystem input the CLI
 * accepts is checked through here before it reaches the SDK, so a bad path is
 * reported by this CLI naming what the user typed, never by a provider
 * further down.
 */
export function pathKind(path: string): PathKind {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch {
    return 'missing';
  }
}

/**
 * Expands a leading `~` to the user's home directory.
 *
 * A shell expands it before the CLI ever sees it; `cmd.exe` and PowerShell do
 * not, and neither does an argument that arrived quoted. Without this,
 * `~/notes.md` is looked for in a directory literally named `~` under the
 * current one — which is nobody's home directory. Only a bare `~` or a `~`
 * followed by a separator is expanded: `~notes` is a filename.
 */
export function expandHome(value: string, home = homedir()): string {
  if (value !== '~' && !/^~[/\\]/.test(value)) return value;
  const rest = value.slice(1).replace(/^[/\\]+/, '');
  return rest === '' ? home : resolve(home, rest);
}

/** Absolute form of a user-supplied path, resolved against `cwd`. */
function absolute(value: string, cwd: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Resolves the one argument every command takes (R1).
 *
 * The rule is the plugin's own, and it is the whole rule: a path to a file that
 * exists is read as a spec, and anything else is a one-line goal. Nothing here
 * guesses at intent from the shape of the text — `src/app.tsx` that does not
 * exist is a goal, exactly as it is when the plugin reads the same argument,
 * and exactly as `exolvra-genesis plan --help` says it is. A rule that is written down
 * in two places has to be one rule.
 */
export function resolveInput(
  arg: string,
  cwd: string,
  usage?: string,
): ResolvedInput {
  const trimmed = arg.trim();
  if (trimmed === '') {
    throw new UsageError(
      'invalid argument "' +
        arg +
        '": a goal, or a path to an existing spec file, is required',
      usage,
    );
  }

  const candidate = absolute(trimmed, cwd);

  if (pathKind(candidate) === 'file') {
    try {
      return {
        kind: 'spec',
        path: candidate,
        given: trimmed,
        text: readFileSync(candidate, 'utf8'),
      };
    } catch (error) {
      // The file is there and cannot be read: a fault in the environment, not
      // in what was typed, and never quietly demoted to a goal.
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(
        [
          'could not read the spec file ' + trimmed,
          '  ' + candidate,
          '  ' + reason,
        ].join('\n'),
      );
    }
  }

  return { kind: 'goal', goal: trimmed };
}

/**
 * Validates a flag whose value names a directory and returns its absolute path.
 *
 * A path that does not exist, or that names a file, is a configuration error the
 * user has to fix before the command can run — exit 2 — reported naming the flag
 * as it was typed and the path it resolved to.
 *
 * `flag` is a label, not necessarily a flag: the same directory check validates
 * `--plugin-dir` and `EXOLVRA_GENESIS_PLUGIN_DIR`, and {@link usageFor} is what keeps a
 * usage line off the one of those that does not appear in a usage line.
 */
export function requireDirectory(
  value: string,
  flag: string,
  cwd: string,
  usage?: string,
): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new UsageError(
      'flag needs a non-empty argument: ' + flag,
      usageFor(flag, usage),
    );
  }

  const dir = absolute(trimmed, cwd);
  const kind = pathKind(dir);
  if (kind === 'directory') return dir;

  const detail =
    kind === 'missing'
      ? '  looked in ' + dir
      : '  ' + dir + (kind === 'file' ? ' is a file' : ' is not a directory');
  throw new UsageError(
    [
      'invalid value "' +
        value +
        '" for ' +
        flag +
        ': ' +
        (kind === 'missing' ? 'no such directory' : 'not a directory'),
      detail,
    ].join('\n'),
    usageFor(flag, usage),
  );
}

/**
 * The text that stands in for the user's input inside the lead prompt. A spec
 * is referenced by path, exactly as the plugin's own argument hint expects.
 */
export function inputAsArgument(input: ResolvedInput): string {
  return input.kind === 'spec' ? input.path : input.goal;
}

/**
 * The input as the user typed it, which is how it is echoed back to them.
 *
 * Not the resolved path: an absolute path they never typed is longer, harder to
 * recognise, and — being one unbroken token — the thing most likely to be cut in
 * half by a narrow terminal.
 */
export function inputAsTyped(input: ResolvedInput): string {
  return input.kind === 'spec' ? input.given : input.goal;
}
