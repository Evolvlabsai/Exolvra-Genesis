import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { ConfigError, UsageError, usageFor } from './exit.js';
import { GOALS_LABEL, GOAL_EXTENSION, findGoal } from './goals.js';
import { STANDARDS_PATH, loadStandards } from './standards.js';

/**
 * What the user handed the CLI: a path to an existing spec file, or a one-line
 * goal. Requirement R1 — resolution is shared so every command agrees.
 *
 * `given` is the argument exactly as it was typed, kept alongside the resolved
 * path because they are for different readers: the path is what the agent is
 * handed, and `given` is what the user gets echoed back to them.
 *
 * A named goal is a spec: `.exolvra-genesis/goals/<name>.md` holds the same
 * format a run already consumes, so it resolves to the same kind rather than to
 * a third one. `goalName` is what it was reached by, for anything that wants to
 * say so; nothing downstream has to know the difference to behave correctly.
 */
export type ResolvedInput =
  | {
      kind: 'spec';
      path: string;
      given: string;
      text: string;
      /** Set when the argument was a goal name rather than a path. */
      goalName?: string;
    }
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

/** Reads a spec file, or says why the file that is there could not be read. */
function readSpec(path: string, given: string): { path: string; given: string; text: string } {
  try {
    return { path, given, text: readFileSync(path, 'utf8') };
  } catch (error) {
    // The file is there and cannot be read: a fault in the environment, not
    // in what was typed, and never quietly demoted to a goal.
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      ['could not read the spec file ' + given, '  ' + path, '  ' + reason].join('\n'),
    );
  }
}

/**
 * The two ways to write a token that mean one thing each.
 *
 * A token that names both a file and a goal is refused, and a refusal is only
 * useful if it comes with the spelling for each. Both of these resolve by the
 * first clause of the rule — an existing path — so neither can be ambiguous in
 * its turn, whatever else is on disk.
 */
function asPath(token: string): string {
  return './' + token;
}

function asGoalPath(token: string): string {
  return GOALS_LABEL + '/' + token + GOAL_EXTENSION;
}

/**
 * Resolves the one argument every command takes (R1, R6).
 *
 * The order is fixed and documented, and it is the whole rule: a path to a file
 * that exists is read as a spec; otherwise a bare token naming a goal in
 * `.exolvra-genesis/goals/` is that goal; otherwise the argument is a one-line
 * goal. Nothing here guesses at intent from the shape of the text —
 * `src/app.tsx` that does not exist is a goal, exactly as it is when the plugin
 * reads the same argument.
 *
 * A token that is both — a file beside a goal of the same name — is refused
 * rather than resolved, because the two are different runs and the difference
 * would be invisible. The refusal names both and the spelling that picks each.
 */
export function resolveInput(
  arg: string,
  cwd: string,
  usage?: string,
): ResolvedInput {
  const trimmed = arg.trim();
  if (trimmed === '') {
    // Worded as `run` words the same refusal when it is reached from the other
    // side, and as `help exit-codes` quotes it: one sentence, in three places,
    // which stays one sentence. A goal name is a goal, so nothing here has
    // changed by there being a third way to write one.
    throw new UsageError(
      'invalid argument "' +
        arg +
        '": a goal, or a path to an existing spec file, is required',
      usage,
    );
  }

  const candidate = absolute(trimmed, cwd);
  const file = pathKind(candidate) === 'file' ? candidate : undefined;
  const goal = findGoal(cwd, trimmed);

  if (file !== undefined && goal !== undefined) {
    throw new UsageError(
      [
        'ambiguous argument "' + trimmed + '": it names both a file and a named goal',
        '  file  ' + file,
        '  goal  ' + goal,
        '  an existing path is read first, so this token alone would run the file',
        '  write ' + asPath(trimmed) + ' for the file, or ' + asGoalPath(trimmed) + ' for the goal',
      ].join('\n'),
      usage,
    );
  }

  const input: ResolvedInput =
    file !== undefined
      ? { kind: 'spec', ...readSpec(file, trimmed) }
      : goal !== undefined
        ? { kind: 'spec', ...readSpec(goal, trimmed), goalName: trimmed }
        : { kind: 'goal', goal: trimmed };

  assertStandingGatesKept(input, cwd, usage);
  return input;
}

/* -------------------------------------------------------------------------- */
/* C4: a run may add gates, and never drop or weaken one                       */
/* -------------------------------------------------------------------------- */

/**
 * A gate as a file declares it: an id, then one checkable line.
 *
 * The same shape in a run-level input as in the standards file, because they
 * are the same kind of statement — that is what makes the two comparable at
 * all. A bullet in front of it is layout; `G12` inside a sentence is prose, and
 * is not a declaration.
 */
const GATE_DECLARATION = /^\s*(?:[-*+]\s+)?(G\d{1,3})[.):]\s+(\S.*)$/;

/**
 * Every gate a text declares, by id, with a wrapped line joined back together.
 *
 * Mechanical throughout: an id and the words after it. Nothing here reads what
 * a gate means — that judgement, and the merge that goes with it, belongs to
 * the lead in the plugin markdown (C6), and this is the one thing about gates
 * the CLI is allowed to know.
 */
export function declaredGates(text: string): Map<string, string> {
  const gates = new Map<string, string>();
  let id: string | undefined;
  let parts: string[] = [];

  const flush = (): void => {
    // The first declaration of an id wins, so a text that says G1 twice is
    // compared on the one a reader meets first.
    if (id !== undefined && !gates.has(id)) gates.set(id, normalize(parts.join(' ')));
    id = undefined;
    parts = [];
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const declared = line.match(GATE_DECLARATION);
    if (declared !== null) {
      flush();
      id = declared[1] as string;
      parts = [declared[2] as string];
      continue;
    }
    if (id === undefined) continue;
    // A gate is one line, wrapped. An indented continuation belongs to it;
    // a blank line, a heading, or anything back at the margin ends it.
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || /^\S/.test(line)) {
      flush();
      continue;
    }
    parts.push(trimmed);
  }
  flush();
  return gates;
}

/** Whitespace is layout, so two gates that differ only in it are one gate. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A gate's words, without the id in front of them.
 *
 * Whether a parsed gate carries its own id in its text is a detail of how it
 * was parsed, and it is not a difference between two gates. Taking it off both
 * sides is what makes the comparison about what the gate says.
 */
function gateText(text: string): string {
  return normalize(text).replace(/^G\d{1,3}[.):]\s*/, '');
}

/** The text a comparison reads: the file for a spec, the words for a goal. */
function textOf(input: ResolvedInput): string {
  return input.kind === 'spec' ? input.text : input.goal;
}

/** What an error calls the thing the user passed. */
function labelOf(input: ResolvedInput): string {
  if (input.kind === 'goal') return 'the goal you gave';
  return input.goalName === undefined
    ? input.given
    : 'the goal "' + input.goalName + '"';
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

/**
 * Refuses a run-level input that would leave the repository standing on fewer
 * gates than it declares (C4).
 *
 * The comparison is mechanical, and it fires on one thing only: the input using
 * the standards' own gate ids.
 *
 * Everything else belongs to the lead. A run inherits the standing gates
 * automatically (R2) and may add gates of its own (C4), and the merge of the
 * two — standing first, run-level after — is written in `commands/run.md`,
 * where it is done with judgement (C6). So an input that declares constraints
 * under its own numbering, or in prose, or under no heading at all, has added
 * to that merge and is nothing for this function to have an opinion about:
 * deciding that such a list *replaces* the standing one would be precedence
 * logic, and precedence is exactly what the CLI must not implement.
 *
 * What is left is the one case a machine can settle without reading anything.
 * An input that writes `G2` is writing about the repo's G2, because that id
 * means one thing here. Then two rules, both string comparisons: an id that
 * comes back in different words has replaced a standing gate, and reusing some
 * standing ids while leaving others out has dropped the ones left out. Either
 * is exit 2 naming the gate, because whether new words are weaker is a
 * judgement, and a judgement about gates is the lead's rather than this CLI's.
 */
function assertStandingGatesKept(
  input: ResolvedInput,
  cwd: string,
  usage?: string,
): void {
  const standards = loadStandards(cwd);
  // No standards file is the ordinary case and says nothing: C2.
  if (standards === null) return;

  const standing = standards.gates;
  if (standing.length === 0) return;

  const declared = declaredGates(textOf(input));
  const reused = standing.filter((gate) => declared.has(gate.id));
  // Nothing of the standards' own numbering appears here, so nothing here is
  // about the standing gates. Whatever it does declare is an addition, and
  // additions are the lead's to merge.
  if (reused.length === 0) return;

  const label = labelOf(input);
  const dropped = standing.filter((gate) => !declared.has(gate.id));
  if (dropped.length > 0) {
    throw new UsageError(
      [
        label +
          ' drops ' +
          listed(dropped.map((gate) => gate.id)) +
          ', declared in ' +
          STANDARDS_PATH,
        ...dropped.map((gate) => '  ' + gate.id + '. ' + gateText(gate.text)),
        '  it restates ' +
          listed(reused.map((gate) => gate.id)) +
          " under the standards' own numbering, so the",
        '  list it gives is the one the run would stand on, and a run may add',
        '  gates and never drop one',
        '  restate ' +
          listed(dropped.map((gate) => gate.id)) +
          ' as well, or take the restatements out and let',
        '  the run inherit every standing gate',
      ].join('\n'),
      usage,
    );
  }

  for (const gate of standing) {
    const restated = declared.get(gate.id) as string;
    if (restated === gateText(gate.text)) continue;
    throw new UsageError(
      [
        label + ' restates ' + gate.id + ' in different words from ' + STANDARDS_PATH,
        '  standards   ' + gate.id + '. ' + gateText(gate.text),
        '  this input  ' + gate.id + '. ' + restated,
        '  a restated gate is the standing one, or it is a new gate: quote ' +
          gate.id +
          ' as it',
        '  stands, or give the new rule an id of its own',
      ].join('\n'),
      usage,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Directories                                                                 */
/* -------------------------------------------------------------------------- */

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
 * is referenced by path, exactly as the plugin's own argument hint expects — and
 * a named goal is a spec, so it is handed over as the file it is.
 */
export function inputAsArgument(input: ResolvedInput): string {
  return input.kind === 'spec' ? input.path : input.goal;
}

/**
 * The input as the user typed it, which is how it is echoed back to them.
 *
 * Not the resolved path: an absolute path they never typed is longer, harder to
 * recognise, and — being one unbroken token — the thing most likely to be cut in
 * half by a narrow terminal. A goal reached by name echoes as its name, which is
 * both what was typed and the shortest true answer.
 */
export function inputAsTyped(input: ResolvedInput): string {
  return input.kind === 'spec' ? input.given : input.goal;
}
