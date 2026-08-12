import type { Command, FlagSpec } from './registry.js';
import { getCommands } from './registry.js';

export const PROGRAM = 'exolvra-genesis';

export const TAGLINE =
  'Run adversarial build loops against a concrete quality bar.';

export const MANUAL_URL = 'https://github.com/Evolvlabsai/Exolvra-Genesis';

export const ROOT_USAGE = `${PROGRAM} <command> [flags]`;

/** The width output is laid out for when stdout is not a terminal. */
export const DEFAULT_WIDTH = 80;

/**
 * Narrowest layout anything here is ever laid out for; a narrower terminal, or
 * a narrower width asked for by {@link FORCE_TTY_ENV}, is laid out at this.
 *
 * Named rather than left implicit because `exolvra-genesis help environment` states
 * it: a floor the user is only told about by watching output stop getting
 * narrower is a floor they have to discover. The gate suite measures the floor
 * a real process applies and holds it to this number.
 */
export const MIN_WIDTH = 40;

/** Forces terminal-style rendering when stdout is not a terminal. */
export const FORCE_TTY_ENV = 'EXOLVRA_GENESIS_FORCE_TTY';

/**
 * The one flag every command inherits. `-h` is accepted everywhere `--help` is,
 * so it is documented everywhere `--help` is.
 */
export const HELP_FLAG: FlagSpec = {
  long: 'help',
  short: 'h',
  summary: 'Show help for command',
};

/** Root-level flags, listed under FLAGS in the root help. */
export const ROOT_FLAGS: readonly FlagSpec[] = [
  HELP_FLAG,
  { long: 'version', summary: `Show ${PROGRAM} version` },
];

export const ROOT_EXAMPLES: readonly string[] = [
  `${PROGRAM} plan specs/checkout.md`,
  `${PROGRAM} plan "a settings page indistinguishable from linear.app"`,
  `${PROGRAM} help exit-codes`,
];

export interface HelpTopic {
  name: string;
  summary: string;
  /** Body of the topic, already wrapped by the author. */
  body: string;
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    name: 'environment',
    summary: `Environment variables that can be used with ${PROGRAM}`,
    body: [
      `The following environment variables can be used with ${PROGRAM}.`,
      '',
      'EXOLVRA_GENESIS_PLUGIN_DIR: the directory holding the plugin markdown that is loaded at',
      'runtime — commands/run.md, agents/builder.md, and agents/critic.md. When it is',
      'unset, the installed package root is tried first, then the repository root when',
      `running ${PROGRAM} from source, then the copy the package ships inside dist/. When`,
      'it is set, only that directory is tried, and a missing file there is a',
      'configuration error.',
      '',
      'ANTHROPIC_API_KEY: the credential the Claude Agent SDK authenticates with.',
      `${PROGRAM} never reads or transmits it; the SDK resolves it from the environment`,
      `${PROGRAM} was started in.`,
      '',
      `${FORCE_TTY_ENV}: when set, ${PROGRAM} lays its output out for a terminal even`,
      'when stdout is a pipe or a file — tables get aligned columns and a header row',
      'instead of the tab-delimited rows a pipe gets by default. Set it to a number to',
      `fix the width it lays out for; any other non-empty value means ${DEFAULT_WIDTH} columns, and`,
      'an empty value, 0, or false leave it off. A width under ' + MIN_WIDTH + ' is laid out at ' + MIN_WIDTH + ',',
      'which is the narrowest a table of a few columns still reads at; the same floor',
      'applies to a real terminal narrower than that.',
      '',
      'It also draws the progress indicator, which is otherwise drawn only when stderr',
      'is a terminal, so a transcript can be captured with it. The indicator is written',
      'to stderr and never to stdout: piped output stays byte for byte what it would be',
      'without a terminal attached.',
    ].join('\n'),
  },
  {
    name: 'exit-codes',
    summary: `Exit codes used by ${PROGRAM}`,
    body: [
      `${PROGRAM} follows normal conventions regarding exit codes.`,
      '',
      '- If a run met its win condition, the exit code will be 0',
      '',
      '- If a run lost, was blocked, or was stopped by a budget guard, the exit code',
      '  will be 1',
      '',
      '- If a command was called incorrectly or its environment is not configured, the',
      '  exit code will be 2',
      '',
      'A run blocked before it began — no credential, no interpreter, plugin markdown',
      'that cannot be read — exits 2 rather than 1, because what has to change is the',
      'environment and not the work. It is still recorded as blocked, and resume picks',
      'it up once the environment is fixed, if it reached a session at all. A run',
      'blocked after it started is a run that did not finish, and exits 1.',
      '',
      'NOTE: these three are the only codes ' + PROGRAM + ' exits with. Exit code 1 is the',
      'code CI should gate on: it means the work did not win, whether it was judged and',
      'lost, ran out of budget, or was blocked before a verdict was ever reached. Exit',
      'code 2 always means the invocation itself has to change before the command can',
      'run — it never reports on the work.',
      '',
      `An internal error in ${PROGRAM} blocks the run, so it exits 1 as any other blocked`,
      'run does. It is never silent and never disguised as a verdict: it prints what',
      'failed and where to report it, on stderr, above the exit.',
    ].join('\n'),
  },
];

export function findHelpTopic(name: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.name === name);
}

/* -------------------------------------------------------------------------- */
/* Text measurement: display columns, character boundaries                     */
/* -------------------------------------------------------------------------- */

/**
 * Code points a terminal draws two columns wide: the East Asian Wide and
 * Fullwidth classes of Unicode's `EastAsianWidth.txt`, plus the code points
 * that default to emoji presentation. Sorted and disjoint, so a lookup is a
 * binary search.
 *
 * This table is here rather than in a dependency because the runtime
 * dependency list is a hard gate of this build; a width library would break it.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2630, 0x2637],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x268a, 0x268f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x2ffb],
  [0x3000, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x318e],
  [0x3190, 0x31e3],
  [0x31f0, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x4dbf],
  [0x4e00, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa89],
  [0x1fa8f, 0x1fac6],
  [0x1face, 0x1fadc],
  [0x1fadf, 0x1fae9],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isWide(cp: number): boolean {
  let low = 0;
  let high = WIDE.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = WIDE[mid] as readonly [number, number];
    if (cp < start) high = mid - 1;
    else if (cp > end) low = mid + 1;
    else return true;
  }
  return false;
}

/** A mark, joiner or selector drawn inside the character in front of it. */
const MARK = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
/** A character a terminal acts on rather than draws. */
const CONTROL = /^\p{Cc}$/u;
/** An emoji base, so a sequence joined out of them can be told from text. */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

const ZWJ = 0x200d;
const VARIATION_SELECTOR_16 = 0xfe0f;

function isMark(ch: string): boolean {
  const cp = ch.codePointAt(0) as number;
  // Hangul fillers are letters, but they are drawn inside their syllable.
  if (cp >= 0x1160 && cp <= 0x11ff) return true;
  return MARK.test(ch);
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/**
 * Splits text into the units a terminal draws as one character: a base plus
 * the marks, joiners and selectors bound to it, a flag's pair of regional
 * indicators, an emoji joined out of several.
 *
 * Truncation cuts between these and never inside one, so a surrogate pair, an
 * accent, or a joined emoji can never be halved.
 */
export function graphemes(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let previous = -1;
  let indicators = 0;

  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const mark = isMark(ch);
    const continues =
      current !== '' &&
      (mark ||
        previous === ZWJ ||
        (isRegionalIndicator(cp) && indicators === 1));

    if (continues) {
      current += ch;
    } else {
      if (current !== '') out.push(current);
      current = ch;
      indicators = 0;
    }
    indicators = isRegionalIndicator(cp) ? indicators + 1 : mark ? indicators : 0;
    previous = cp;
  }

  if (current !== '') out.push(current);
  return out;
}

/** Columns one drawn character occupies. */
function graphemeWidth(cluster: string): number {
  // However many code points it is spelled with, a joined emoji is drawn as
  // one emoji: two columns.
  if (cluster.includes('\u200d') && PICTOGRAPHIC.test(cluster)) return 2;

  let width = 0;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0) as number;
    if (isMark(ch) || CONTROL.test(ch)) {
      // A variation selector asks for the emoji form of the character in front
      // of it, which is drawn two columns wide rather than one.
      if (cp === VARIATION_SELECTOR_16 && width === 1) width = 2;
      continue;
    }
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Columns `text` occupies on a terminal.
 *
 * Not its length: a CJK ideograph and most emoji are drawn two columns wide, a
 * combining accent none at all, and an astral character is one character
 * spelled with two UTF-16 code units. Every width in this file is this one.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const cluster of graphemes(text)) width += graphemeWidth(cluster);
  return width;
}

/** Pads `text` on the right to exactly `width` display columns. */
function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Cuts `text` down to `width` display columns, on a character boundary.
 *
 * A cut that lands inside a surrogate pair, a combining sequence or a joined
 * emoji would put a broken character on the terminal, so the last character
 * that does not fit is dropped whole. A cell one column short of its budget is
 * padded back out by the caller, which is what a wide character straddling the
 * edge leaves behind.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;

  const ellipsis = width > 3 ? '...' : '';
  const room = width - ellipsis.length;
  let out = '';
  let used = 0;
  for (const cluster of graphemes(text)) {
    const columns = graphemeWidth(cluster);
    if (used + columns > room) break;
    out += cluster;
    used += columns;
  }
  return out + ellipsis;
}

/* -------------------------------------------------------------------------- */
/* Sanitizing: model output is untrusted input to this renderer                */
/* -------------------------------------------------------------------------- */

/** Escape sequences: CSI, OSC, and the shorter forms in front of them. */
const ANSI = /\u001b(?:\[[0-9;:<=>?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\|$)|[ -/]*[0-~])/g;
/** A surrogate that lost its partner is not a character at all. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Everything else a terminal would act on rather than draw. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Strips what a terminal would obey rather than draw.
 *
 * A prompt asks an agent for well-shaped values; a prompt is not a guarantee,
 * so nothing downstream may assume one arrived. An escape sequence in a field
 * would repaint the screen, a newline would split one record across two lines,
 * a tab would invent a column, and a lone surrogate is not a character: here
 * they become a space or nothing, before anything is measured or laid out.
 */
export function printable(value: string): string {
  return value
    .replace(ANSI, '')
    .replace(LONE_SURROGATE, '')
    .replace(CONTROL_CHARS, ' ');
}

/**
 * The same, for text that is laid out as more than one line.
 *
 * An error message written as a complaint and an indented detail under it is
 * two lines on purpose, so those breaks survive; everything else a terminal
 * would obey still does not.
 */
export function printableBlock(value: string): string {
  return value
    .split('\n')
    .map((line) => printable(line))
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                           */
/* -------------------------------------------------------------------------- */

interface Row {
  label: string;
  text: string;
}

/** Indented, column-aligned rows: `<indent><label><pad><text>`. */
function alignRows(rows: readonly Row[], indent: number, gap: number): string[] {
  const width = rows.reduce((max, row) => Math.max(max, displayWidth(row.label)), 0);
  const pad = ' '.repeat(indent);
  return rows.map((row) => `${pad}${padTo(row.label, width + gap)}${row.text}`);
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [title, ...lines, ''];
}

/* -------------------------------------------------------------------------- */
/* Presentation: text, tables, and markdown meant for a chat window            */
/* -------------------------------------------------------------------------- */

/**
 * How wide to lay out, and whether to lay out for a terminal at all.
 *
 * A pipe gets tab-delimited rows so the output stays machine-readable; a
 * terminal gets aligned columns. {@link FORCE_TTY_ENV} forces the terminal
 * form when there is no terminal, which is how a transcript of the aligned
 * output gets captured to a file.
 */
export interface Viewport {
  tty: boolean;
  width: number;
}

/**
 * Body indent under a section heading, matching the help pages above.
 *
 * Everything under a heading sits here — prose, list items, code, and tables
 * alike. A table left at the heading's own indent reads as the heading's
 * sibling rather than as its content, so there is one constant and not two.
 */
export const BODY_INDENT = 2;

/** Spaces between aligned table columns. */
const COLUMN_GAP = 2;

/** Narrowest a column is allowed to become before columns stop shrinking. */
const MIN_COLUMN = 6;

/**
 * The width a table is laid out for when nothing will draw it.
 *
 * A column budget exists because a terminal has a right edge. A file, a pager
 * and a pipe do not, so a table redirected into one keeps every column at its
 * natural width: wide enough here that {@link fitColumns} never has to cut one,
 * which is what stops a redirect from being the thing that loses a word.
 */
const UNBOUNDED_WIDTH = 1_000_000;

/**
 * What may sit in front of an opening emphasis marker, and behind a closing
 * one. Markers glued to the middle of a word are not emphasis — `cli/src/**`
 * is a glob, and stripping its stars would change what the line says.
 */
const QUOTES = '"\'\\u2018\\u2019\\u201c\\u201d';
// The hyphen stays last in each class, where it is a character and not a range.
const EMPHASIS_OPEN = '(^|[\\s(\\[{\\u2013\\u2014' + QUOTES + '-])';
const EMPHASIS_CLOSE = '($|[\\s.,;:!?)\\]}\\u2013\\u2014' + QUOTES + '-])';

function stripEmphasis(text: string, marker: string): string {
  const quoted = marker.replace(/[*]/g, '\\*');
  const inner = marker.startsWith('*') ? '[^*]' : marker.startsWith('_') ? '[^_]' : '[^~]';
  return text.replace(
    new RegExp(
      EMPHASIS_OPEN + quoted + '(\\S|\\S' + inner + '*?\\S)' + quoted + '(?=' + EMPHASIS_CLOSE + ')',
      'g',
    ),
    '$1$2',
  );
}

/**
 * Flattens a value to one printable line, and changes nothing else about it.
 *
 * This is the function every *field* goes through — a goal, a path, a run id, a
 * verification command, a critic's gap — and its whole contract is that what
 * comes out is what went in, minus the two things a field cannot carry: the
 * control characters a terminal would obey rather than draw, and the line
 * breaks and tabs that would turn one field into two.
 *
 * It deliberately does not read what it is given as markdown. A field is data,
 * and data that is "rendered" is data that has been changed: `C:\dir\.hidden`
 * has a backslash escape in it only to a markdown parser, and to everybody else
 * it is a directory that exists. A renderer that quietly drops that backslash
 * prints a path that is not the path, contradicts the same value in `--json`,
 * and does it most often to exactly the values a user is going to copy. Prose
 * written for a chat window does need reading as markdown — that is
 * {@link plainProse}, and it is applied where prose is, and nowhere else.
 */
export function plainText(value: string): string {
  return printable(value).replace(/\s+/g, ' ').trim();
}

/**
 * Strips inline markdown so chat syntax never reaches the terminal as syntax,
 * and flattens what is left to one printable line.
 *
 * For prose an agent wrote for a chat window, and only for that: emphasis,
 * inline code, links and backslash escapes are markup there, not content, so
 * the content survives and the markup does not.
 */
export function plainProse(value: string): string {
  let text = printable(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_match, label: string, url: string) =>
      /^https?:\/\//.test(url) ? `${label} (${url})` : label,
    )
    .replace(/`+([^`\n]*)`+/g, '$1');
  for (const marker of ['***', '**', '*', '___', '__', '~~']) {
    text = stripEmphasis(text, marker);
  }
  return text
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a word wider than any line into the pieces that do fit one. */
function breakWord(word: string, limit: number): string[] {
  if (displayWidth(word) <= limit) return [word];
  const pieces: string[] = [];
  let piece = '';
  let used = 0;
  for (const cluster of graphemes(word)) {
    const columns = graphemeWidth(cluster);
    if (piece !== '' && used + columns > limit) {
      pieces.push(piece);
      piece = '';
      used = 0;
    }
    piece += cluster;
    used += columns;
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}

/** How {@link wrapText} treats a word too long to fit one line. */
export interface WrapOptions {
  /**
   * When false, an over-long word is emitted whole on its own line and left to
   * the terminal to fold, rather than cut on a character boundary.
   *
   * Prose reads fine either way. A path, a URL, or a command does not: split
   * across two lines it can no longer be copied, clicked, or double-clicked as
   * one thing, and the reader has to guess whether the break is a character of
   * the path. Anything echoed back as a single token is wrapped with this off.
   */
  breakWords?: boolean;
}

/**
 * Hard-wraps `text` to `width` display columns, every line prefixed with
 * `indent`.
 *
 * A word too long to fit any line — an unbroken path, a URL, a sentence of CJK
 * written without spaces — is broken on a character boundary rather than left
 * to run past the edge, unless {@link WrapOptions.breakWords} says otherwise.
 */
export function wrapText(
  text: string,
  width: number,
  indent = 0,
  options: WrapOptions = {},
): string[] {
  const pad = ' '.repeat(indent);
  const limit = Math.max(MIN_COLUMN * 2, width - indent);
  const out: string[] = [];
  const pieces = (word: string): string[] =>
    options.breakWords === false ? [word] : breakWord(word, limit);

  for (const paragraph of text.split('\n')) {
    const words = printable(paragraph)
      .split(/\s+/)
      .filter((word) => word !== '');
    if (words.length === 0) continue;
    let line = '';
    let used = 0;
    for (const word of words) {
      for (const piece of pieces(word)) {
        const columns = displayWidth(piece);
        if (line === '') {
          line = piece;
          used = columns;
        } else if (used + 1 + columns <= limit) {
          line += ' ' + piece;
          used += 1 + columns;
        } else {
          out.push(pad + line);
          line = piece;
          used = columns;
        }
      }
    }
    if (line !== '') out.push(pad + line);
  }
  return out;
}

/**
 * How many columns each column of a table gets, given `budget` for all of them.
 *
 * A column narrow enough to fit an equal share of what is left keeps its full
 * width, and what that frees is re-shared with the columns that did not fit,
 * until only columns wider than their share remain; those split the remainder.
 * This is the budgeting a `gh` list does — a short id, status or duration stays
 * whole and the long elastic field absorbs the shortfall — rather than paying
 * for one over-wide field by truncating every other column to noise.
 */
function fitColumns(
  natural: readonly number[],
  budget: number,
  keep: readonly number[] = [],
): number[] {
  const out = natural.map(() => 0);
  let pending = natural.map((_width, column) => column);
  let remaining = budget;

  // A column somebody has to be able to copy is served before the share-out
  // starts, so long as every other column can still have a usable width. An id
  // is the case this exists for: half an id is not a shorter id, it is one that
  // cannot be typed back in, and the field it would have taken the space from
  // is prose that reads perfectly well with its tail cut off.
  for (const column of keep) {
    const width = natural[column];
    if (width === undefined || !pending.includes(column)) continue;
    // Every other column keeps a single column, and no more is promised them.
    // That is a deliberate trade rather than an oversight: at a width where not
    // everything can fit, the id is the field somebody has to be able to type
    // back in — half of one is not a shorter id — and the rest is context a
    // wider terminal, or `--json`, will give them in full.
    const floor = pending.length - 1;
    if (width > remaining - floor) continue;
    out[column] = width;
    remaining -= width;
    pending = pending.filter((candidate) => candidate !== column);
  }

  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    const fits = pending.filter((column) => (natural[column] as number) <= share);
    if (fits.length === 0) break;
    for (const column of fits) {
      out[column] = natural[column] as number;
      remaining -= natural[column] as number;
    }
    pending = pending.filter((column) => !fits.includes(column));
  }

  // Whatever is left over is split between the columns that have to be cut,
  // the odd columns going to the leftmost of them so the total is exact.
  if (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    let extra = remaining - share * pending.length;
    for (const column of pending) {
      out[column] = share + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
    }
  }
  return out;
}

/**
 * One table, with the same column discipline the help pages get.
 *
 * A terminal gets an uppercase header row and columns aligned to the widest
 * cell, measured and truncated in display columns. A pipe gets one
 * tab-delimited row per record and no header — the shape `gh` writes when its
 * output is redirected, so the rows stay cuttable.
 *
 * Every cell is flattened to one printable line before it is measured, so a
 * record is one line and has the field count its header promises no matter
 * what the model put in it.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  view: Viewport,
  indent = 0,
  /** Columns, by header name, that are not to be cut while anything else can be. */
  keep: readonly string[] = [],
): string[] {
  if (rows.length === 0) return [];
  const cells = rows.map((row) =>
    headers.map((_header, column) => plainText(row[column] ?? '')),
  );

  if (!view.tty) return cells.map((row) => row.join('\t'));

  const titles = headers.map((header) => plainText(header).toUpperCase());
  // Folded rather than spread: how many records arrive is the model's choice
  // too, and a spread of one argument per row has a limit.
  const natural = titles.map((title, column) =>
    cells.reduce(
      (widest, row) => Math.max(widest, displayWidth(row[column] as string)),
      displayWidth(title),
    ),
  );
  const budget = Math.max(
    MIN_COLUMN * headers.length,
    view.width - indent - COLUMN_GAP * (headers.length - 1),
  );
  const widths = fitColumns(
    natural,
    budget,
    keep
      .map((name) => headers.indexOf(name))
      .filter((column) => column !== -1),
  );
  const gap = ' '.repeat(COLUMN_GAP);
  const pad = ' '.repeat(indent);

  const line = (row: readonly string[]): string =>
    (
      pad +
      row
        .map((cell, column) => {
          const width = widths[column] as number;
          return padTo(truncate(cell, width), width);
        })
        .join(gap)
    ).trimEnd();

  return [line(titles), ...cells.map(line)];
}

/** A section heading and its body, laid out the way the help pages are. */
export function renderSection(title: string, body: readonly string[]): string[] {
  return section(title, body);
}

const FENCE = /^(```+|~~~+)/;
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
const SETEXT_RULE = /^(=+|-{3,})$/;
const HORIZONTAL_RULE = /^(-{3,}|\*{3,}|_{3,}|(?:[-*_] ){2,}[-*_])$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === '' ||
    FENCE.test(trimmed) ||
    ATX_HEADING.test(trimmed) ||
    HORIZONTAL_RULE.test(trimmed) ||
    LIST_ITEM.test(line) ||
    trimmed.startsWith('>') ||
    trimmed.includes('|')
  );
}

function tableCells(row: string): string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => plainProse(cell));
}

/**
 * Renders markdown written for a chat window as terminal output.
 *
 * Headings become the same uppercase section headings the help pages use,
 * pipe tables become real columns, and fences, rules and emphasis markers are
 * markup rather than content, so they are dropped. Nothing that arrives as
 * markdown leaves as markdown.
 */
export function renderMarkdown(
  markdown: string,
  view: Viewport,
  indent = 0,
): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const pad = ' '.repeat(indent);
  const out: string[] = [];

  // A heading is followed by its body, never by a blank line — the same rule
  // the help pages above follow.
  let underHeading = false;
  const push = (line: string): void => {
    out.push(line === '' ? '' : (pad + line).trimEnd());
    underHeading = false;
  };
  const heading = (text: string): void => {
    // A section that turned out to be empty still gets its blank line, so two
    // headings in a row do not read as one two-line heading.
    if (underHeading) out.push('');
    push(text);
    underHeading = true;
  };
  const blank = (): void => {
    if (underHeading) return;
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  };
  const at = (index: number): string => lines[index] ?? '';

  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    const trimmed = line.trim();

    if (trimmed === '') {
      blank();
      i += 1;
      continue;
    }

    // A fenced block is content wearing markup: the fence goes, the code stays.
    const fence = trimmed.match(FENCE);
    if (fence !== null) {
      const marker = (fence[1] as string).slice(0, 3);
      i += 1;
      const code: string[] = [];
      while (i < lines.length && !at(i).trim().startsWith(marker)) {
        // Indentation is content in a code block, so spacing survives here
        // where a cell would have had it collapsed; escape sequences do not.
        code.push(printable(at(i).replace(/\t/g, '    ')));
        i += 1;
      }
      i += 1;
      blank();
      for (const entry of code) push(' '.repeat(BODY_INDENT) + entry);
      blank();
      continue;
    }

    // A rule divides a chat window; a terminal has blank lines for that.
    if (HORIZONTAL_RULE.test(trimmed)) {
      blank();
      i += 1;
      continue;
    }

    const atx = trimmed.match(ATX_HEADING);
    if (atx !== null) {
      blank();
      heading(plainProse(atx[2] as string).toUpperCase());
      i += 1;
      continue;
    }

    // A pipe table, but only when the row under the header really divides it.
    if (trimmed.includes('|') && TABLE_DIVIDER.test(at(i + 1).trim())) {
      const headers = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && at(i).includes('|') && at(i).trim() !== '') {
        if (!TABLE_DIVIDER.test(at(i).trim())) rows.push(tableCells(at(i)));
        i += 1;
      }
      blank();
      // Aligned columns and a header row, at the body indent, whether or not
      // there is a terminal on the other end.
      //
      // This is prose an agent wrote, laid out as prose: a heading, paragraphs,
      // a table among them. The machine-readable form belongs to the sections
      // this CLI composes itself, where a caller knows the columns in advance
      // and asked for records. Dropping the header and the indent here would
      // put half a human page and half a data feed in one block — a run of
      // `1<tab>2` at column zero in the middle of text indented under a
      // heading, with nothing left to say what either column was.
      const rendered = renderTable(
        headers,
        rows,
        { tty: true, width: view.tty ? view.width : UNBOUNDED_WIDTH },
        indent + BODY_INDENT,
      );
      for (const row of rendered) out.push(row);
      underHeading = false;
      blank();
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item !== null) {
      const depth = Math.floor((item[1] as string).length / 2);
      const marker = /^\d/.test(item[2] as string) ? (item[2] as string) : '-';
      let text = item[3] as string;
      while (i + 1 < lines.length && !isBlockStart(at(i + 1))) {
        text += ' ' + at(i + 1).trim();
        i += 1;
      }
      i += 1;
      const bullet = BODY_INDENT + depth * 2;
      const hang = bullet + marker.length + 1;
      const wrapped = wrapText(plainProse(text), view.width - indent - hang);
      push(' '.repeat(bullet) + marker + ' ' + (wrapped[0] ?? ''));
      for (const rest of wrapped.slice(1)) push(' '.repeat(hang) + rest);
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && at(i).trim().startsWith('>')) {
        quote.push(at(i).trim().replace(/^>\s?/, ''));
        i += 1;
      }
      for (const wrapped of wrapText(
        plainProse(quote.join(' ')),
        view.width - indent,
        BODY_INDENT + 2,
      )) {
        push(wrapped);
      }
      continue;
    }

    // A line underscored with = or - is a heading written the other way round.
    if (SETEXT_RULE.test(at(i + 1).trim())) {
      blank();
      heading(plainProse(trimmed).toUpperCase());
      i += 2;
      continue;
    }

    const paragraph: string[] = [trimmed];
    i += 1;
    while (i < lines.length && !isBlockStart(at(i)) && !SETEXT_RULE.test(at(i + 1).trim())) {
      paragraph.push(at(i).trim());
      i += 1;
    }
    for (const wrapped of wrapText(
      plainProse(paragraph.join(' ')),
      view.width - indent,
      BODY_INDENT,
    )) {
      push(wrapped);
    }
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Wraps a comma-separated list to `width` columns at a fixed indent. */
export function wrapList(
  items: readonly string[],
  indent: number,
  width = 78,
): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let current = '';
  items.forEach((item, index) => {
    const piece = index === items.length - 1 ? item : `${item},`;
    if (current === '') {
      current = piece;
    } else if (indent + displayWidth(current) + 1 + displayWidth(piece) <= width) {
      current = `${current} ${piece}`;
    } else {
      lines.push(pad + current);
      current = piece;
    }
  });
  if (current !== '') lines.push(pad + current);
  return lines;
}

function flagLabel(flag: FlagSpec): string {
  const slot = flag.short === undefined ? '    ' : `-${flag.short}, `;
  const arg = flag.value === undefined ? '' : ` ${flag.value.arg}`;
  return `${slot}--${flag.long}${arg}`;
}

function flagText(flag: FlagSpec): string {
  let text = flag.summary;
  const choices = flag.value?.choices;
  if (choices !== undefined) {
    text += `: {${choices.join('|')}}`;
  }
  if (flag.default !== undefined) {
    const rendered =
      typeof flag.default === 'number' ? `${flag.default}` : `"${flag.default}"`;
    text += ` (default ${rendered})`;
  }
  return text;
}

/**
 * Renders one flag table, sorted by long name.
 *
 * A four-column gutter is kept for `-x, ` so long-only flags line up under the
 * flags that have a short form, and every flag the CLI accepts appears here —
 * including `-h`, which every command takes.
 */
export function renderFlagTable(flags: readonly FlagSpec[]): string[] {
  if (flags.length === 0) return [];
  const sorted = [...flags].sort((a, b) => a.long.localeCompare(b.long));
  return alignRows(
    sorted.map((flag) => ({ label: flagLabel(flag), text: flagText(flag) })),
    2,
    3,
  );
}

function renderLearnMore(): string[] {
  return [
    'LEARN MORE',
    `  Use \`${PROGRAM} <command> --help\` for more information about a command.`,
    `  Read the manual at ${MANUAL_URL}`,
    `  Learn about exit codes using \`${PROGRAM} help exit-codes\``,
    `  Learn about environment variables using \`${PROGRAM} help environment\``,
    '',
  ];
}

function renderExamples(examples: readonly string[]): string[] {
  return section(
    'EXAMPLES',
    examples.map((example) => `  $ ${example}`),
  );
}

/* -------------------------------------------------------------------------- */
/* Help pages                                                                  */
/* -------------------------------------------------------------------------- */

export function renderRootHelp(): string {
  const commands = getCommands();
  const core = commands.filter((c) => (c.group ?? 'core') === 'core');
  const additional = commands.filter((c) => c.group === 'additional');

  // `gh` aligns every command and help-topic description to a single column,
  // computed across all of the tables at once.
  const nameRows: Row[] = [
    ...core.map((c) => ({ label: `${c.name}:`, text: c.summary })),
    ...additional.map((c) => ({ label: `${c.name}:`, text: c.summary })),
    ...HELP_TOPICS.map((t) => ({ label: `${t.name}:`, text: t.summary })),
  ];
  const aligned = alignRows(nameRows, 2, 1);
  let cursor = 0;
  const take = (count: number): string[] => aligned.slice(cursor, (cursor += count));

  const lines: string[] = [
    TAGLINE,
    '',
    'USAGE',
    `  ${ROOT_USAGE}`,
    '',
    ...section('CORE COMMANDS', take(core.length)),
    ...section('ADDITIONAL COMMANDS', take(additional.length)),
    ...section('HELP TOPICS', take(HELP_TOPICS.length)),
    ...section('FLAGS', renderFlagTable(ROOT_FLAGS)),
    ...renderExamples(ROOT_EXAMPLES),
    ...renderLearnMore(),
  ];

  return `${lines.join('\n')}\n`;
}

export function renderCommandHelp(command: Command): string {
  const inherited: FlagSpec[] = [HELP_FLAG];

  const description: string[] = [];
  for (const paragraph of command.description ?? [command.summary]) {
    description.push(paragraph, '');
  }

  const extras: string[] = [];
  for (const extra of command.sections ?? []) {
    extras.push(...section(extra.title, extra.lines));
  }

  const lines: string[] = [
    ...description,
    'USAGE',
    `  ${command.usage}`,
    '',
    ...section('FLAGS', renderFlagTable(command.flags)),
    ...section('INHERITED FLAGS', renderFlagTable(inherited)),
    ...extras,
    ...renderExamples(command.examples ?? []),
    ...renderLearnMore(),
  ];

  return `${lines.join('\n')}\n`;
}

export function renderHelpTopic(topic: HelpTopic): string {
  return `${topic.body}\n`;
}

/**
 * A fault this CLI never classified: the complaint, and the detail indented
 * under it.
 *
 * A bare errno on a line of its own, next to exit code 1, reads like a verdict
 * on the user's work. This one says the opposite in as many words — the run was
 * blocked before anything was judged — and says where to report it, because an
 * error nothing in this CLI expected is the kind worth hearing about.
 *
 * No usage line follows it, unlike every other error here. A usage line is an
 * instruction: retype the command this way. Having just said that nothing the
 * user typed caused this and that the fault belongs in an issue, printing one
 * would send them to correct an invocation that was never wrong.
 */
export function renderInternalError(message: string, command?: string): string {
  const where = command === undefined ? '' : ' while running ' + printable(command);
  const lines: string[] = [
    PROGRAM + ': unexpected error' + where,
    ...printableBlock(message)
      .split('\n')
      .map((line) => '  ' + line),
    '  the run was blocked before any verdict, so this is not a judgement of',
    '  the work',
    '  if this looks like a bug, report it at ' + MANUAL_URL + '/issues',
    '',
  ];
  return lines.join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/* Progress: the one thing drawn while nothing else can be                     */
/* -------------------------------------------------------------------------- */

/**
 * Frames of the spinner, and how it signs off.
 *
 * A rotating quarter-filled circle while the work runs — the same one the
 * interactive frames use, because it means the same thing there.
 *
 * The line it leaves behind carries no glyph at all, and that is the point. A
 * frame glyph is a claim about a frame: `◇` is what a clack frame writes on the
 * rail it owns, and a lone one sitting outside any frame — which is where this
 * line is, on stderr, above piped output — is a corner of a box that was never
 * drawn. Inside a frame the progress line is suspended and the frame closes
 * itself; out here the words are the whole of it.
 */
const SPINNER_FRAMES = ['◒', '◐', '◓', '◑'];
const SPINNER_DONE = '';
const SPINNER_FAILED = '';

/** How often the frame advances. Fast enough to read as motion, not as noise. */
const FRAME_MS = 120;

/** Erases the line and returns to its start, so a frame overwrites the last. */
const ERASE_LINE = '\r\u001b[2K';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

/**
 * A live line that says the command is still working.
 *
 * Only ever a line: it is written to stderr, one line at a time, erased before
 * each redraw and erased for good when it stops. Whatever the command prints
 * goes to stdout and is untouched by it.
 */
export interface Progress {
  /** Changes the message shown beside the spinner. */
  update(message: string): void;
  /**
   * Takes the line down without ending it, so something else can be printed
   * where it was. The next frame draws it again underneath.
   */
  clear(): void;
  /**
   * Stops the frames, takes the line down, and gives the cursor back.
   *
   * The difference from {@link clear} is the whole of it: clear takes the line
   * down and the next frame puts it straight back, which is right for a line of
   * output and catastrophic for a question. A prompt waits on the user, and a
   * timer that keeps firing while it waits erases what they are being asked
   * several times a second and leaves them typing into a line that is not
   * there. Nothing may be asked of anybody while this line is drawing.
   */
  suspend(): void;
  /** Draws again after a {@link suspend}. Does nothing once the line is closed. */
  resume(): void;
  /** Clears the line and closes it as finished. */
  done(message: string): void;
  /** Clears the line and closes it as not finished. */
  fail(message: string): void;
}

/** A progress line that draws nothing, for output nobody is watching. */
const SILENT: Progress = {
  update: () => {},
  clear: () => {},
  suspend: () => {},
  resume: () => {},
  done: () => {},
  fail: () => {},
};

/**
 * Starts a progress line on `stream`, or returns one that draws nothing when
 * `enabled` is false.
 *
 * Nothing about it is optional to check: a pipe, a file, and a CI log get the
 * silent one, because a redraw sequence in a captured transcript is corruption
 * of that transcript. A terminal gets the frames.
 */
export function startProgress(
  stream: NodeJS.WritableStream,
  message: string,
  enabled: boolean,
): Progress {
  if (!enabled) return SILENT;

  let text = message;
  let frame = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const started = Date.now();

  const elapsed = (): string => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    return seconds < 1 ? '' : ' (' + seconds + 's)';
  };
  const draw = (): void => {
    if (stopped || timer === undefined) return;
    const symbol = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] as string;
    stream.write(ERASE_LINE + symbol + '  ' + printable(text) + elapsed());
    frame += 1;
  };

  const start = (): void => {
    if (stopped || timer !== undefined) return;
    // Unreferenced: a redraw timer is not a reason for the process to stay alive.
    timer = setInterval(draw, FRAME_MS);
    timer.unref?.();
    stream.write(HIDE_CURSOR);
    draw();
  };

  const halt = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  start();

  const close = (symbol: string, final: string): void => {
    if (stopped) return;
    const drawing = timer !== undefined;
    halt();
    stopped = true;
    // The cursor is only given back if it was taken: a line closed while it was
    // suspended has already restored it, and a second SHOW_CURSOR is a stray
    // escape sequence in whatever the terminal shows next.
    stream.write(
      ERASE_LINE +
        (symbol === '' ? '' : symbol + '  ') +
        printable(final) +
        '\n' +
        (drawing ? SHOW_CURSOR : ''),
    );
  };

  return {
    update(next: string): void {
      text = next;
      draw();
    },
    clear(): void {
      if (!stopped && timer !== undefined) stream.write(ERASE_LINE);
    },
    suspend(): void {
      if (stopped || timer === undefined) return;
      halt();
      stream.write(ERASE_LINE + SHOW_CURSOR);
    },
    resume: start,
    done: (final: string) => close(SPINNER_DONE, final),
    fail: (final: string) => close(SPINNER_FAILED, final),
  };
}

/**
 * Wraps a stream so that whatever is written to it takes the progress line down
 * first.
 *
 * A spinner and a line of output share one terminal, and the spinner is the one
 * of the two that is redrawn on a timer — so unless the line is taken down
 * immediately before every write, a frame ends up glued to the front of a
 * report line, or worse, left behind in the scrollback where it can never be
 * erased again. Doing that at each call site is a convention, and a convention
 * is one forgotten call away from being false; doing it here makes it a
 * property of the stream, so a caller cannot write around it.
 *
 * A proxy rather than a stand-in: callers are handed the real stream, with
 * `isTTY`, `columns`, and every method it has, because the things that lay
 * output out ask the stream about itself.
 */
export function progressStream(
  stream: NodeJS.WritableStream,
  progress: Progress,
): NodeJS.WritableStream {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  return new Proxy(stream, {
    get(target, property): unknown {
      if (property === 'write') {
        return (...args: unknown[]): boolean => {
          progress.clear();
          return write(...args);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * The unknown-command error, shaped like `gh`: the complaint, the root usage
 * line, then the commands that do exist.
 *
 * What the user typed is quoted back to them, so it is quoted back printable:
 * an escape sequence in argv does not get to repaint the screen on its way
 * through an error message.
 */
export function renderUnknownCommand(name: string): string {
  const lines: string[] = [
    `unknown command "${printable(name)}" for "${PROGRAM}"`,
    '',
    `Usage:  ${ROOT_USAGE}`,
    '',
    'Available commands:',
    ...getCommands().map((command) => `  ${command.name}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The malformed-usage error: the complaint, then the usage line it violated.
 *
 * A complaint is often two lines — what is wrong, and an indented detail — so
 * the message keeps its own line breaks and loses only what a terminal would
 * have obeyed rather than drawn.
 */
export function renderUsageError(message: string, usage?: string): string {
  const lines = [printableBlock(message)];
  if (usage !== undefined) lines.push('', `Usage:  ${usage}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}
