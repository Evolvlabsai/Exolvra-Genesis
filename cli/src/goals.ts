import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ConfigError } from './exit.js';
import { RUN_DIR } from './runs-store.js';

/**
 * Named goals: one reusable job per file, in the repository that owns it.
 *
 * A goal is a spec by another name — the same format a run already consumes —
 * kept under a name short enough to type. This module is the model: where the
 * files live, what a name may be, and what one line of a file says about it.
 * Nothing here renders, prompts, or writes; a goal is only ever created by the
 * authoring command, and only after the user has approved the whole file.
 */

/** Where named goals live, under the directory a command runs in. */
export const GOALS_SUBDIR = 'goals';

/** The one extension a goal file has. */
export const GOAL_EXTENSION = '.md';

/**
 * The goals directory as it is written in prose: forward slashes, no machine's
 * home directory in front of it. It is the same string on every platform, which
 * is what makes it quotable in a help page and in an error.
 */
export const GOALS_LABEL = RUN_DIR + '/' + GOALS_SUBDIR;

export function goalsDir(cwd: string): string {
  return join(cwd, RUN_DIR, GOALS_SUBDIR);
}

/**
 * Where the file for `name` is, or would be.
 *
 * The name has already been through {@link goalNameFault} by the time this is
 * called, which is what rules out a separator; the check that the joined path
 * really did stay in the directory is the second lock on the same door, and it
 * is here rather than at each call site because there is one join to guard.
 */
export function goalPath(cwd: string, name: string): string {
  const dir = goalsDir(cwd);
  const path = join(dir, name + GOAL_EXTENSION);
  if (dirname(path) !== dir) {
    throw new ConfigError(
      [
        'refusing to resolve the goal name "' + name + '"',
        '  it resolves to ' + path + ', which is outside ' + dir,
      ].join('\n'),
    );
  }
  return path;
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

/** Longest a goal name may be. It is a file name, not a sentence. */
const MAX_NAME_LENGTH = 64;

/**
 * What a goal name may be: one file name, made only of characters that mean the
 * same thing on every filesystem this runs on.
 *
 * No separator, no colon, no leading or trailing dot — so a name can never be
 * built into a path that leaves the goals directory, and never into a hidden
 * file or one whose extension is not the one this module appends.
 */
const GOAL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** The shape `goals new` writes: a slug, which is what a name is meant to read as. */
const GOAL_SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** Names Windows refuses whatever extension follows them. */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Why `name` cannot name a goal, or undefined when it can.
 *
 * This is the lookup rule, and it is deliberately wider than the rule for
 * creating one: a goal file written by hand, or by another editor, is still a
 * goal, and a listing that shows a name its own `show` refuses would be a
 * listing that lies. What it will never accept is a name that is really a path.
 */
export function goalNameFault(name: string): string | undefined {
  if (name === '') return 'a goal name is required';
  if (name.length > MAX_NAME_LENGTH) {
    return 'a goal name is at most ' + MAX_NAME_LENGTH + ' characters';
  }
  if (!GOAL_NAME.test(name)) {
    return (
      'a goal name is a file name, not a path: letters and digits, with . _ - ' +
      'between them'
    );
  }
  return undefined;
}

/**
 * The same, for a name being created rather than looked up.
 *
 * Stricter on purpose: the file is about to be written, committed, and typed
 * back at a shell. A slug survives all three on every platform.
 */
export function newGoalNameFault(name: string): string | undefined {
  const fault = goalNameFault(name);
  if (fault !== undefined) return fault;
  if (RESERVED_NAME.test(name)) {
    return '"' + name + '" is a reserved device name on Windows, so no file can carry it';
  }
  if (!GOAL_SLUG.test(name)) {
    return (
      'a new goal is named as a slug: lowercase letters and digits, separated ' +
      'by - or _ (for example release-notes)'
    );
  }
  return undefined;
}

/** True when `token` could name a goal at all, whatever is on disk. */
export function isGoalName(token: string): boolean {
  return goalNameFault(token) === undefined;
}

/* -------------------------------------------------------------------------- */
/* Reading what is there                                                       */
/* -------------------------------------------------------------------------- */

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The path of the goal called `name`, when a file for it is really there.
 *
 * Undefined covers both "not a name" and "no such file", because the caller
 * asking this question — the input resolver — has somewhere else to go in
 * either case. Nothing here reports a fault: a token that is not a goal is
 * usually not meant to be one.
 */
export function findGoal(cwd: string, name: string): string | undefined {
  if (!isGoalName(name)) return undefined;
  const path = goalPath(cwd, name);
  return isFile(path) ? path : undefined;
}

/** One goal on disk, as a listing shows it. */
export interface Goal {
  /** The name as it is typed: the file name without its extension. */
  name: string;
  /** Absolute path of the file. */
  path: string;
  /** Its first heading, or its first line of prose; empty when it has neither. */
  description: string;
}

/**
 * Reads a goal file, or says which file could not be read and why.
 *
 * A file that is listed and then cannot be read is a fault in the environment,
 * not in what was typed, and it is reported as one rather than shown as a goal
 * with nothing to say for itself.
 */
export function readGoalFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(
      ['could not read the goal file', '  ' + path, '  ' + reasonFor(error)].join('\n'),
    );
  }
}

/**
 * Every goal in `cwd`, by name.
 *
 * A directory that is not there is not a fault and never a warning: a
 * repository that keeps no goals is the ordinary case, and it answers with an
 * empty list. A directory that is there and cannot be read is the other thing
 * entirely, and it says so.
 */
export function listGoals(cwd: string): Goal[] {
  const dir = goalsDir(cwd);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw new ConfigError(
      [
        'could not read the goals directory',
        '  ' + dir,
        '  ' + reasonFor(error),
      ].join('\n'),
    );
  }

  const goals: Goal[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(GOAL_EXTENSION)) continue;
    const name = entry.slice(0, -GOAL_EXTENSION.length);
    if (!isGoalName(name)) continue;
    const path = join(dir, entry);
    if (!isFile(path)) continue;
    const description = goalDescription(readGoalFile(path));
    goals.push({
      name,
      path,
      description: restatesName(name, description) ? '' : description,
    });
  }
  return goals.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a heading says anything the file name has not already said.
 *
 * `release-notes.md` under a `# Release notes` heading listed as
 * `release-notes  Release notes` is a column of nothing: the reader has already
 * read the name, and the space would be better spent saying so. A file like
 * that has no description, and is shown the way a file with none is.
 *
 * Compared on letters and digits alone, because the two spellings of one name
 * differ only in the punctuation between the words and in their capitals.
 */
export function restatesName(name: string, description: string): boolean {
  const key = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return key(description) === key(name);
}

/**
 * The one line a listing shows beside a name.
 *
 * The file's own first heading when it has one, because a spec's title is the
 * sentence somebody already wrote to say what the file is for; its first line
 * of prose otherwise. Frontmatter is skipped: those are fields, not a summary.
 * Nothing is invented — a file with neither has no description, and the listing
 * says so rather than making one up.
 */
export function goalDescription(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;

  if (lines[0]?.trim() === '---') {
    index = 1;
    while (index < lines.length && lines[index]?.trim() !== '---') index += 1;
    index += 1;
  }

  for (; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim();
    if (line === '') continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const body = (heading === null ? line : (heading[1] as string))
      .replace(/\s+#+$/, '')
      .trim();
    if (body !== '') return body;
  }
  return '';
}

/* -------------------------------------------------------------------------- */
/* The scaffold's reporting shape                                              */
/* -------------------------------------------------------------------------- */

/** The prefix every line addressed to this CLI, rather than to the reader, carries. */
export const MARKER = '@exolvra-genesis';

/** The two lines a proposed file arrives between. */
export const PROPOSAL_BEGIN = MARKER + ' goal-begin';
export const PROPOSAL_END = MARKER + ' goal-end';

export interface ProposedGoal {
  /** The whole file, when this turn carried one. */
  proposal?: string;
  /** What the turn said to the reader, with the delimiters taken out. */
  rest: string;
}

/**
 * Splits a turn into the file it proposed and the prose around it.
 *
 * The delimiters are two whole lines rather than a fence, because the file
 * being proposed is markdown and may hold fences of its own — a nested fence is
 * exactly the case a fence cannot delimit. An opening line with no closing one
 * is not a proposal: the turn is still talking, and half a file is not
 * something to put in front of somebody for approval.
 */
export function readProposal(text: string): ProposedGoal {
  const rest: string[] = [];
  const body: string[] = [];
  let open = false;
  let proposal: string | undefined;

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!open && trimmed === PROPOSAL_BEGIN) {
      open = true;
      body.length = 0;
      continue;
    }
    if (open && trimmed === PROPOSAL_END) {
      open = false;
      // The first whole proposal wins: a turn that sent two has sent one the
      // user was never shown, and the one on screen is the one being approved.
      proposal ??= stripFence(body.join('\n'));
      continue;
    }
    (open ? body : rest).push(line);
  }
  // An unterminated block was prose after all, so it is given back as prose.
  if (open) rest.push(...body);

  return {
    ...(proposal === undefined ? {} : { proposal }),
    rest: rest.join('\n').trim(),
  };
}

/**
 * Takes off a code fence wrapped around the whole proposal.
 *
 * The delimiters already say where the file starts and stops, so a fence inside
 * them is habit rather than content — and a file written to disk with a fence
 * on its first line is not the file that was approved.
 */
function stripFence(text: string): string {
  const lines = text.replace(/^\n+|\n+$/g, '').split('\n');
  const first = lines[0]?.trim() ?? '';
  const last = lines[lines.length - 1]?.trim() ?? '';
  if (
    lines.length >= 2 &&
    /^(?:`{3,}|~{3,})\w*$/.test(first) &&
    /^(?:`{3,}|~{3,})$/.test(last)
  ) {
    return lines.slice(1, -1).join('\n').replace(/^\n+|\n+$/g, '');
  }
  return lines.join('\n');
}

/**
 * The file as it is written: one trailing newline, and no carriage returns
 * carried over from however the text arrived.
 */
export function goalFileText(proposal: string): string {
  return proposal.replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n';
}

/**
 * Writes an approved goal, and answers with the path it went to.
 *
 * The one function in this codebase that creates a file under
 * `.exolvra-genesis/goals/`, and the only caller is the authoring command,
 * after the user has approved the whole file (C5). It refuses to write over a
 * goal that is already there: replacing a file the repository has committed is
 * a different act from writing a new one, and nobody approved that one.
 */
export function writeGoal(cwd: string, name: string, proposal: string): string {
  const fault = newGoalNameFault(name);
  if (fault !== undefined) {
    throw new ConfigError('refusing to write a goal called "' + name + '"\n  ' + fault);
  }
  const path = goalPath(cwd, name);
  try {
    mkdirSync(goalsDir(cwd), { recursive: true });
    writeFileSync(path, goalFileText(proposal), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw new ConfigError(
      ['could not write the goal file', '  ' + path, '  ' + reasonFor(error)].join('\n'),
    );
  }
  return path;
}
