/**
 * The repo's own standing bar: `.exolvra-genesis/standards.md`.
 *
 * Exolvra Genesis owns the loop; the repo owns what "good" means in it. This
 * module is the whole of the CLI's relationship with that file — reading it,
 * saying in per-line terms why it is not one, and composing a new one from
 * answers a person typed.
 *
 * Three rules shape everything here:
 *
 * - **Absent is not a fault.** A repo with no standards file is the ordinary
 *   case, and {@link loadStandards} answers `null` for it without a word. A
 *   warning would make every repo that never asked for standards pay for the
 *   feature.
 * - **Present but broken is a fault.** Silently dropping a file that is there
 *   would drop the gates it declares, which is exactly the outcome standing
 *   gates exist to prevent. It raises instead, naming every line.
 * - **The file is untrusted input.** It is prose somebody wrote, and it reaches
 *   a terminal through the same flattening every other field does; nothing read
 *   out of it may repaint a screen or invent a column.
 *
 * What this module never does is decide what a run makes of what it read. The
 * merge of standing gates with run-level ones is the lead's judgement and lives
 * in the plugin markdown, and so does the pin a run holds the file by: the loop
 * re-verifies that hash every round, and the loop is not in here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { ConfigError } from './exit.js';
import { RUN_DIR } from './runs-store.js';
import { plainText, printable, truncate, wrapText } from './usage.js';

/* -------------------------------------------------------------------------- */
/* Where it lives                                                              */
/* -------------------------------------------------------------------------- */

/** The file a repo declares its standing bar in, under {@link RUN_DIR}. */
export const STANDARDS_FILE = 'standards.md';

/** How the file is named in prose: repo-relative, forward slashes, everywhere. */
export const STANDARDS_PATH = RUN_DIR + '/' + STANDARDS_FILE;

export function standardsPath(cwd: string): string {
  return join(cwd, RUN_DIR, STANDARDS_FILE);
}

export function gitignorePath(cwd: string): string {
  return join(cwd, '.gitignore');
}

/* -------------------------------------------------------------------------- */
/* What a standards file is                                                    */
/* -------------------------------------------------------------------------- */

/** One standing gate: a line a reader could check, numbered from G1. */
export interface Gate {
  /** `G1`, `G2`, … as the file numbers them. */
  id: string;
  number: number;
  text: string;
  /** 1-based line the gate starts on. */
  line: number;
}

/** An artifact resolves on disk; a value is a number somebody has to meet. */
export type StandingBarKind = 'path' | 'value';

/** One standing bar entry: what to compare against, and what it is. */
export interface StandingBarEntry {
  subject: string;
  kind: StandingBarKind;
  description: string;
  /** 1-based line the entry starts on. */
  line: number;
}

/** A parsed standards file. */
export interface Standards {
  title: string;
  purpose: string;
  gates: Gate[];
  standingBar: StandingBarEntry[];
  conventions: string;
}

/**
 * One thing wrong with a standards file, and the line it is wrong on.
 *
 * A plain record rather than a thrown error: a file with six problems has six
 * of these, and a reader fixing them wants all six at once. The command turns
 * the list into one raised fault at the end.
 */
export interface StandardsIssue {
  /** 1-based line in the file. */
  line: number;
  message: string;
}

/* -------------------------------------------------------------------------- */
/* Reading the bytes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The bytes as a parser and a hash both have to see them: no byte-order mark,
 * one kind of line ending.
 *
 * `.gitattributes` says `* text=auto`, so one commit is LF in a Linux checkout
 * and CRLF in a Windows one. A hash taken over the raw bytes would report the
 * file as edited by the act of checking it out, which is the single thing a pin
 * must never say by accident.
 */
function normalize(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

function unreadable(path: string, detail: string): ConfigError {
  return new ConfigError(
    [
      'could not read the standards file',
      '  ' + path,
      '  ' + detail,
      '  it is a markdown file this repo owns; repair it in place, or move it',
      '  aside and write a new one with `exolvra-genesis standards init`',
    ].join('\n'),
  );
}

/**
 * The file's text, or `null` when there is no file there.
 *
 * `ENOENT` and `ENOTDIR` both mean nothing is at that path, which is the
 * ordinary case and answers `null`. Anything else — a directory where the file
 * should be, a permission that forbids reading it — is a real fault about a
 * file that does exist, and is raised rather than mistaken for absence.
 */
export function readStandardsText(cwd: string): string | null {
  const path = standardsPath(cwd);
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw unreadable(path, error instanceof Error ? error.message : String(error));
  }
}

/* -------------------------------------------------------------------------- */
/* Parsing the fixed shape                                                     */
/* -------------------------------------------------------------------------- */

type SectionKey = 'gates' | 'standingBar' | 'conventions';

/** The three sections, in the order a standards file carries them. */
const ORDER: readonly SectionKey[] = ['gates', 'standingBar', 'conventions'];

const LABEL: Record<SectionKey, string> = {
  gates: '## Gates',
  standingBar: '## Standing bar',
  conventions: '## Conventions',
};

const TITLE_LINE = /^#\s+(.+?)\s*$/;
const SECTION_LINE = /^##\s+(.+?)\s*$/;
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^[-*]\s+(.*)$/;
const CONTINUATION = /^\s{2,}\S/;
const GATE_ITEM = /^G(\d+)[.):]?\s+(.+)$/;
/** What divides a standing bar entry's subject from its description. */
const SEPARATOR = /\s+(?:—|–|-{1,2})\s+/;

interface SourceLine {
  text: string;
  number: number;
}

interface RawSection {
  key: SectionKey | 'unknown';
  heading: string;
  line: number;
  body: SourceLine[];
}

/** A capture group, as a string, whatever the regex engine says about it. */
function group(match: RegExpMatchArray, index: number): string {
  return match[index] ?? '';
}

/**
 * The characters that reorder a line rather than draw on it.
 *
 * A right-to-left override quoted back into an error turns the rest of that
 * line around on the terminal — the line number, the reason, everything after
 * it — so a message about line 9 can be made to read as a message about
 * something else without a character of it being false.
 */
const BIDI = /\p{Bidi_Control}/gu;

/** File text quoted back into a message: one line, flattened, never too long. */
function quote(text: string): string {
  return '"' + truncate(plainText(text).replace(BIDI, ''), 60) + '"';
}

function sectionKey(heading: string): SectionKey | 'unknown' {
  const key = heading.toLowerCase().replace(/\s+/g, ' ').trim();
  if (key === 'gates') return 'gates';
  if (key === 'standing bar') return 'standingBar';
  if (key === 'conventions') return 'conventions';
  return 'unknown';
}

interface SplitFile {
  title: string;
  preamble: SourceLine[];
  sections: RawSection[];
  lastLine: number;
}

/**
 * The file cut into its title, its purpose paragraph, and its `##` sections.
 *
 * Fenced blocks are carried whole: a `## Gates` inside a code fence in the
 * conventions prose is an example somebody is showing, not a section starting.
 */
function splitFile(text: string): SplitFile {
  const lines = normalize(text).split('\n');
  const preamble: SourceLine[] = [];
  const sections: RawSection[] = [];
  let current: RawSection | undefined;
  let fence: string | undefined;
  let title = '';

  lines.forEach((raw, index) => {
    const number = index + 1;
    const fenced = raw.match(FENCE_LINE);
    if (fenced !== null) {
      const marker = group(fenced, 1);
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (fence === undefined) {
      const heading = raw.match(SECTION_LINE);
      if (heading !== null) {
        const found = group(heading, 1);
        current = { key: sectionKey(found), heading: found, line: number, body: [] };
        sections.push(current);
        return;
      }
      if (current === undefined && title === '') {
        const named = raw.match(TITLE_LINE);
        if (named !== null) {
          title = group(named, 1);
          return;
        }
      }
    }
    if (current === undefined) preamble.push({ text: raw, number });
    else current.body.push({ text: raw, number });
  });

  return { title, preamble, sections, lastLine: Math.max(1, lines.length) };
}

interface RawItem {
  text: string;
  line: number;
}

/**
 * The list items in one section, and a complaint for every line that is not
 * one.
 *
 * A line indented under an item continues it, so a wrapped gate is one gate. A
 * line that is neither an item nor a continuation is content nobody will read
 * as anything, and is reported rather than dropped.
 */
function readItems(section: RawSection, issues: StandardsIssue[]): RawItem[] {
  const items: RawItem[] = [];
  const heading = section.key === 'unknown' ? 'this section' : LABEL[section.key];
  for (const line of section.body) {
    if (line.text.trim() === '') continue;
    const item = line.text.match(LIST_ITEM);
    if (item !== null) {
      items.push({ text: group(item, 1).trim(), line: line.number });
      continue;
    }
    const last = items[items.length - 1];
    if (last !== undefined && CONTINUATION.test(line.text)) {
      last.text = (last.text + ' ' + line.text.trim()).trim();
      continue;
    }
    issues.push({
      line: line.number,
      message:
        'stray line under ' +
        heading +
        ' — a list item, or an indented continuation of one',
    });
  }
  return items;
}

/** The prose in a section, as one string with its paragraph breaks kept. */
function readProse(body: readonly SourceLine[]): string {
  return body
    .map((line) => line.text.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Where a section that is not in the file should have been. */
function whereItBelongs(
  key: SectionKey,
  seen: Map<SectionKey, RawSection>,
  lastLine: number,
): number {
  for (let rank = ORDER.indexOf(key) + 1; rank < ORDER.length; rank += 1) {
    const next = seen.get(ORDER[rank] as SectionKey);
    if (next !== undefined) return next.line;
  }
  return lastLine;
}

/** What a standards file looks like, said once, for the messages that need it. */
const SHAPE: readonly string[] = [
  'a standards file is a purpose paragraph, then ' + LABEL.gates + ' (G1, G2, … one',
  'checkable line each), then ' + LABEL.standingBar + ' (a path or a number and one',
  'line saying what it is), then ' + LABEL.conventions + ' (prose the lead hands on)',
];

export interface ParsedStandards {
  /** Best effort: the sections that were there, however few. */
  standards: Standards;
  /** Everything wrong with the file's shape, in line order. */
  issues: StandardsIssue[];
}

function stripTicks(text: string): string {
  return text.replace(/^`+/, '').replace(/`+$/, '').trim();
}

/**
 * A subject as the file will carry it: flattened, and without the backticks a
 * person may well type around a path.
 */
export function normalizeSubject(text: string): string {
  return stripTicks(plainText(text));
}

/**
 * Whether a standing bar entry names something on disk or a number to meet.
 *
 * Decided by shape rather than by asking the filesystem, so the same line means
 * the same thing on a machine where the artifact is missing — which is the case
 * where the answer matters, because there the entry is a fault to report rather
 * than a number nobody has to resolve.
 */
export function subjectKind(subject: string): StandingBarKind {
  // A separator settles it, and so does a dotfile. Otherwise it is a filename
  // only when the extension begins with a letter: `0.5s` and `v1.2.3` are
  // figures somebody has to meet, and `.png` is a file somebody has to open.
  if (/[\\/]/.test(subject)) return 'path';
  if (/^\.[A-Za-z][\w.-]*$/.test(subject)) return 'path';
  if (/^\S+\.[A-Za-z][A-Za-z0-9]{0,11}$/.test(subject)) return 'path';
  return 'value';
}

/**
 * Reads the fixed shape, and says what is not in it.
 *
 * Shape only — whether a gate is really checkable and whether a standing bar
 * artifact really resolves are questions about the world, and they belong to
 * {@link validateStandards}.
 */
export function parseStandards(text: string): ParsedStandards {
  const issues: StandardsIssue[] = [];
  const { title, preamble, sections, lastLine } = splitFile(text);

  const seen = new Map<SectionKey, RawSection>();
  let highest = -1;
  for (const section of sections) {
    if (section.key === 'unknown') {
      issues.push({
        line: section.line,
        message:
          'unknown section ' +
          quote('## ' + section.heading) +
          ' — the three are Gates, Standing bar, Conventions',
      });
      continue;
    }
    if (seen.has(section.key)) {
      issues.push({
        line: section.line,
        message: 'a second ' + LABEL[section.key] + ' section — there is one of each',
      });
      continue;
    }
    seen.set(section.key, section);
    const rank = ORDER.indexOf(section.key);
    const behind = ORDER[highest];
    if (rank < highest && behind !== undefined) {
      issues.push({
        line: section.line,
        // What this file does, and then what a standards file does. Stating the
        // rule alone — "## Standing bar comes before ## Conventions" — reads as
        // a claim about the file in front of the reader, and it is the one
        // thing that is not true of it.
        message:
          LABEL[section.key] +
          ' is after ' +
          LABEL[behind] +
          ' here — the sections come in the order ' +
          ORDER.map((key) => LABEL[key]).join(', '),
      });
    } else {
      highest = rank;
    }
  }

  for (const key of ORDER) {
    if (seen.has(key)) continue;
    issues.push({
      line: whereItBelongs(key, seen, lastLine),
      message: 'no ' + LABEL[key] + ' section — it belongs here',
    });
  }

  const purpose = readProse(preamble);
  if (purpose === '') {
    issues.push({
      line: 1,
      message: 'no purpose paragraph — the file opens by saying what this repo ships',
    });
  }

  const gates: Gate[] = [];
  const gatesSection = seen.get('gates');
  if (gatesSection !== undefined) {
    const items = readItems(gatesSection, issues);
    if (items.length === 0) {
      issues.push({
        line: gatesSection.line,
        message:
          'no gates — declare at least one, and every run in this repo inherits it',
      });
    }
    for (const item of items) {
      const parsed = item.text.match(GATE_ITEM);
      if (parsed === null) {
        issues.push({
          line: item.line,
          message: 'not a gate — each one is written "- G1. <what must be true>"',
        });
        continue;
      }
      const number = Number(group(parsed, 1));
      const expected = gates.length + 1;
      if (number !== expected) {
        issues.push({
          line: item.line,
          message:
            'numbered G' +
            number +
            ', but this is gate ' +
            expected +
            ' — gates run G1, G2, … in order',
        });
      }
      gates.push({
        id: 'G' + expected,
        number: expected,
        text: group(parsed, 2).trim(),
        line: item.line,
      });
    }
  }

  const standingBar: StandingBarEntry[] = [];
  const barSection = seen.get('standingBar');
  if (barSection !== undefined) {
    const items = readItems(barSection, issues);
    if (items.length === 0) {
      issues.push({
        line: barSection.line,
        message:
          'no standing bar — name at least one artifact or number to hold work to',
      });
    }
    for (const item of items) {
      const cut = item.text.match(SEPARATOR);
      const at = cut?.index;
      const subject =
        cut === null || at === undefined ? '' : stripTicks(item.text.slice(0, at).trim());
      const description =
        cut === null || at === undefined
          ? ''
          : item.text.slice(at + group(cut, 0).length).trim();
      if (subject === '' || description === '') {
        issues.push({
          line: item.line,
          message:
            'not a standing bar entry — it is written "- <path or number> — <what it is>"',
        });
        continue;
      }
      standingBar.push({
        subject,
        kind: subjectKind(subject),
        description,
        line: item.line,
      });
    }
  }

  const conventionsSection = seen.get('conventions');
  const conventions =
    conventionsSection === undefined ? '' : readProse(conventionsSection.body);
  if (conventionsSection !== undefined && conventions === '') {
    issues.push({
      line: conventionsSection.line,
      message:
        'no conventions — the prose every builder is handed; write it, or "none"',
    });
  }

  issues.sort((a, b) => a.line - b.line);

  return {
    standards: { title, purpose, gates, standingBar, conventions },
    issues,
  };
}

/* -------------------------------------------------------------------------- */
/* Validation: is this a bar, and does it resolve                              */
/* -------------------------------------------------------------------------- */

/**
 * Words that describe a feeling about the work rather than a fact about it.
 *
 * A bar is an artifact or a number, never an adjective — a gate written out of
 * these is a gate two readers score differently, which is the same as no gate
 * at all. They are refused only when the line carries nothing checkable
 * alongside them: "finishes in under 2s, and reads cleanly" is a real gate with
 * a preference attached, and it passes.
 */
const VAGUE: readonly string[] = [
  'appropriate',
  'beautiful',
  'best practice',
  'best practices',
  'clean',
  'delightful',
  'elegant',
  'fast',
  'good',
  'high quality',
  'high-quality',
  'idiomatic',
  'intuitive',
  'maintainable',
  'modern',
  'nice',
  'performant',
  'polished',
  'pretty',
  'professional',
  'proper',
  'quality',
  'readable',
  'reasonable',
  'robust',
  'seamless',
  'sensible',
  'simple',
  'solid',
  'well designed',
  'well written',
  'well-designed',
  'well-written',
];

/** A command, a path, or a count: something a reader can run, open, or measure. */
const HARD_ANCHOR = /`[^`]+`|\d|[\\/]/;

/** Words that state an obligation rather than an aspiration. */
const RULE_WORD =
  /\b(?:must|never|always|every|no|none|only|exactly|at least|at most|under|over|within|before|after|fails?|failing|passes?|passing|exits?|returns?|matches?|contains?|equals?)\b/i;

function mentions(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp('\\b' + escaped + '\\b', 'i').test(text);
}

/**
 * Why this gate is not something a reader could check, or `undefined` when it
 * is.
 *
 * Two ways to fail, told apart because the fixes differ: a line built out of
 * adjectives needs replacing, and a line that never says what has to hold needs
 * finishing.
 */
/**
 * The line with the parts that are not prose taken out of it.
 *
 * A command in backticks and a token with a path separator in it are the
 * checkable half of a gate, and the words inside them are names rather than
 * claims: `npm run clean` is a script somebody can run, and the word in it says
 * nothing about how the work should feel. Masking them first is what lets the
 * adjectives be looked for in what is left.
 */
function maskAnchors(text: string): string {
  return text.replace(/`[^`]*`/g, ' ').replace(/\S*[\\/]\S*/g, ' ');
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

export function gateProblem(text: string): string | undefined {
  /*
   * The adjectives first, and on their own terms.
   *
   * A number in the line used to settle the whole question, which let "the UI
   * must be beautiful, with 2 accent colours" through: the figure was real and
   * the gate was still a feeling. What a figure settles is whether the line
   * says anything measurable, and that was never the same question as whether
   * it also asks for something no two readers would score alike.
   */
  const vague = VAGUE.filter((word) => mentions(maskAnchors(text), word));
  if (vague.length > 0) {
    const one = vague.length === 1;
    return (
      'not checkable: ' +
      andList(vague.map((word) => '"' + word + '"')) +
      (one ? ' is an adjective' : ' are adjectives') +
      '; phrase the checkable core without ' +
      (one ? 'it' : 'them')
    );
  }

  if (HARD_ANCHOR.test(text)) return undefined;
  if (!RULE_WORD.test(text)) {
    return 'not checkable: name a command, a path, a number, or a rule ("must", "never")';
  }
  return undefined;
}

/**
 * Why this standing bar subject does not resolve, or `undefined` when it does.
 *
 * `cwd` is the repo the entry was declared in. Without one the entry is checked
 * for shape alone, which is what a caller validating text that is not on disk
 * yet — the draft an interview has just composed — is asking for.
 */
export function standingBarProblem(
  subject: string,
  kind: StandingBarKind,
  cwd?: string,
): string | undefined {
  if (kind === 'value') {
    if (!/\d/.test(subject)) {
      return quote(subject) + ' is neither a path in this repo nor a number';
    }
    return undefined;
  }
  if (isAbsolute(subject) || /^[A-Za-z]:[\\/]/.test(subject)) {
    return quote(subject) + ' is an absolute path — make it relative to the repo root';
  }
  if (cwd === undefined) return undefined;
  const target = resolve(cwd, subject);
  if (relative(cwd, target).startsWith('..')) {
    return quote(subject) + ' points outside the repo it is declared in';
  }
  if (!existsSync(target)) {
    return quote(subject) + ' does not resolve — no such file in this repo';
  }
  return undefined;
}

/** How the file may be validated: with a repo to resolve artifacts in, or without. */
export interface ValidateOptions {
  /**
   * The repo the file belongs to. Given, every standing bar artifact is
   * resolved against it; left out, the check is shape and phrasing only.
   */
  cwd?: string;
}

/**
 * Everything wrong with a standards file: its shape, its phrasing, and whether
 * what it points at is there.
 *
 * In line order, so the list reads as a walk down the file rather than as a
 * walk through this function.
 */
export function validateStandards(
  text: string,
  options: ValidateOptions = {},
): StandardsIssue[] {
  const { standards, issues } = parseStandards(text);

  for (const gate of standards.gates) {
    const problem = gateProblem(gate.text);
    if (problem !== undefined) {
      issues.push({ line: gate.line, message: 'gate ' + gate.id + ' is ' + problem });
    }
  }
  for (const entry of standards.standingBar) {
    const problem = standingBarProblem(entry.subject, entry.kind, options.cwd);
    if (problem !== undefined) {
      issues.push({ line: entry.line, message: 'standing bar: ' + problem });
    }
  }

  issues.sort((a, b) => a.line - b.line);
  return issues;
}

/** One thing, or several, counted the way a sentence counts them. */
export function countOf(count: number, one: string, many: string): string {
  return count + ' ' + (count === 1 ? one : many);
}

/**
 * The problems as one raised complaint: what is wrong, every line, then the
 * shape the file was measured against.
 *
 * The shape is repeated at the end on purpose. A list of eleven line faults on
 * a file somebody wrote by hand is a list they cannot act on without knowing
 * what was expected, and sending them to a manual for it is sending them away.
 */
export function describeStandardsIssues(
  path: string,
  issues: readonly StandardsIssue[],
): string {
  return [
    countOf(issues.length, 'problem', 'problems') + ' in ' + path,
    ...issues.map((issue) => '  line ' + issue.line + ': ' + printable(issue.message)),
    ...SHAPE.map((line) => '  ' + line),
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The repo's standards, `null` when it declares none.
 *
 * `null` is silent and is meant to be: a repo with no standards file is the
 * ordinary case and behaves exactly as it did before this file existed. A file
 * that is there and does not parse is the opposite case and raises, because
 * quietly ignoring it would quietly drop the gates it declares.
 */
export function loadStandards(cwd: string): Standards | null {
  const text = readStandardsText(cwd);
  if (text === null) return null;
  const issues = validateStandards(text, { cwd });
  if (issues.length > 0) {
    throw new ConfigError(describeStandardsIssues(standardsPath(cwd), issues));
  }
  return parseStandards(text).standards;
}

/* -------------------------------------------------------------------------- */
/* Composing one                                                               */
/* -------------------------------------------------------------------------- */

/** The answers a standards file is written out of. */
export interface StandardsDraft {
  /** Heading at the top of the file. Left out, it is `Standards`. */
  title?: string;
  purpose: string;
  gates: readonly string[];
  standingBar: readonly { subject: string; description: string }[];
  conventions: string;
}

const DEFAULT_TITLE = 'Standards';

/** Columns the file is wrapped to, so it reads in a diff and in a narrow window. */
const FILE_WIDTH = 76;

function wrapParagraphs(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of normalize(text).split(/\n{2,}/)) {
    const wrapped = wrapText(paragraph, width, 0, { breakWords: false });
    if (wrapped.length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(...wrapped);
  }
  return out;
}

/**
 * One list item, wrapped with its continuations hanging under the marker.
 *
 * The parser joins an indented continuation back onto its item, so a wrapped
 * gate is still one gate when the file is read back — which is what makes the
 * file this composes and the file the checker accepts the same file.
 */
function bullet(text: string, width: number): string[] {
  return wrapText(text, width - 2, 0, { breakWords: false }).map((line, index) =>
    index === 0 ? line : '  ' + line,
  );
}

/** A subject as the file spells it: a path in backticks, a number bare. */
function formatSubject(subject: string): string {
  const clean = normalizeSubject(subject);
  return subjectKind(clean) === 'path' ? '`' + clean + '`' : clean;
}

/**
 * The draft as the file it becomes.
 *
 * Everything a person typed is flattened to one printable line on the way in —
 * a gate is one line by definition, and a control character in one would be a
 * control character in every terminal that ever prints this file back.
 */
export function renderStandards(draft: StandardsDraft): string {
  const title = plainText(draft.title ?? '');
  const lines: string[] = ['# ' + (title === '' ? DEFAULT_TITLE : title), ''];

  lines.push(...wrapParagraphs(draft.purpose, FILE_WIDTH), '');

  lines.push(LABEL.gates, '');
  draft.gates.forEach((gate, index) => {
    lines.push(...bullet('- G' + (index + 1) + '. ' + plainText(gate), FILE_WIDTH));
  });
  lines.push('');

  lines.push(LABEL.standingBar, '');
  for (const entry of draft.standingBar) {
    lines.push(
      ...bullet(
        '- ' + formatSubject(entry.subject) + ' — ' + plainText(entry.description),
        FILE_WIDTH,
      ),
    );
  }
  lines.push('');

  lines.push(LABEL.conventions, '');
  lines.push(...wrapParagraphs(draft.conventions, FILE_WIDTH));

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Writes the file, creating the state directory when it is not there yet. */
export function writeStandards(cwd: string, text: string): string {
  const path = standardsPath(cwd);
  mkdirSync(join(cwd, RUN_DIR), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

/* -------------------------------------------------------------------------- */
/* Keeping intent tracked and run state ignored                                */
/* -------------------------------------------------------------------------- */

/**
 * The ignore rules that let committed intent and ignored run state share one
 * directory: everything a run writes stays out of the repo, standards and goals
 * stay in it.
 */
export const IGNORE_PATTERN: readonly string[] = [
  '/' + RUN_DIR + '/*',
  '!/' + RUN_DIR + '/' + STANDARDS_FILE,
  '!/' + RUN_DIR + '/goals/',
];

/** A rule that ignores the state directory, or everything inside it. */
const WHOLE_DIRECTORY = new RegExp(
  '^(?:\\*\\*/)?/?' + RUN_DIR.replace(/\./g, '\\.') + '/?(?:\\*{1,2})?$',
);

/** A rule that puts the standards file back. */
const KEEPS_STANDARDS = new RegExp('^!.*' + STANDARDS_FILE.replace(/\./g, '\\.') + '$');

interface IgnoreLine {
  text: string;
  /** The line's own terminator — empty on a last line that carries none. */
  eol: string;
  number: number;
}

/**
 * The file split into lines that each remember how they ended.
 *
 * Byte-preserving on purpose. An edit to somebody's `.gitignore` has to be an
 * edit to the lines they were asked about and to nothing else, and a file
 * rejoined with one chosen line ending is a file in which every line changed.
 * A checkout with mixed endings — one file touched on Windows, the rest on
 * Linux — is exactly where that shows up as a diff nobody approved.
 */
function ignoreLines(gitignore: string): IgnoreLine[] {
  const out: IgnoreLine[] = [];
  let rest = gitignore;
  let number = 1;

  for (;;) {
    const end = rest.match(/\r\n|\n|\r/);
    if (end === null || end.index === undefined) {
      // A last line with no terminator is still a line; a file that ended on
      // one has no line after it. An empty file is one empty line.
      if (rest !== '' || number === 1) out.push({ text: rest, eol: '', number });
      return out;
    }
    out.push({ text: rest.slice(0, end.index), eol: end[0], number });
    rest = rest.slice(end.index + end[0].length);
    number += 1;
  }
}

/**
 * A line as a rule, for matching only: a byte-order mark and the surrounding
 * space are not part of what the rule says, and are not taken off the line
 * itself either.
 */
function ignoreRule(text: string): string {
  return text.replace(/^﻿/, '').trim();
}

/**
 * The lines that ignore the whole state directory, 1-based.
 *
 * A comment is not a rule and neither is a blank line, so neither is looked at.
 */
export function wholeDirectoryIgnores(gitignore: string): number[] {
  return ignoreLines(gitignore)
    .filter((line) => {
      const rule = ignoreRule(line.text);
      return rule !== '' && !rule.startsWith('#') && WHOLE_DIRECTORY.test(rule);
    })
    .map((line) => line.number);
}

/**
 * Whether this `.gitignore` would keep the standards file out of the repo.
 *
 * True only when something ignores the whole directory *and* nothing puts the
 * standards file back — so a repo already carrying the pattern is left alone
 * rather than offered it a second time.
 */
export function needsIgnorePattern(gitignore: string): boolean {
  if (wholeDirectoryIgnores(gitignore).length === 0) return false;
  return !ignoreLines(gitignore).some((line) => KEEPS_STANDARDS.test(ignoreRule(line.text)));
}

/** One line an edit would replace or remove, numbered as the file numbers it. */
export interface IgnoreLineRef {
  number: number;
  text: string;
}

/** Exactly what applying the pattern to a `.gitignore` would do to it. */
export interface IgnoreEdit {
  /**
   * Every blanket rule the edit touches, in file order. The first is replaced
   * by the pattern; the rest are removed.
   */
  replaced: IgnoreLineRef[];
  /** The file afterwards, byte for byte. */
  text: string;
}

/**
 * The whole edit, so the whole edit can be approved.
 *
 * Two properties, and both of them are the point. The lines it touches are
 * handed back so the question put to the user can name every one of them —
 * approval given to "the rule" is not approval to delete a second rule
 * somewhere further down. And nothing outside those lines is touched: not the
 * line endings of the lines around them, not the blank line at the end, not a
 * comment. What the user says yes to is what happens to their file.
 *
 * The pattern replaces the first blanket rule where it stands rather than being
 * appended: the last matching rule wins in a `.gitignore`, so a pattern added
 * underneath the rule it corrects would work while an identical-looking one
 * added above it would not. A second blanket rule would ignore the directory
 * all over again, so it goes — which is why the question has to say so.
 */
export function planIgnorePattern(gitignore: string): IgnoreEdit {
  const lines = ignoreLines(gitignore);
  const targets = new Set(wholeDirectoryIgnores(gitignore));
  const replaced: IgnoreLineRef[] = lines
    .filter((line) => targets.has(line.number))
    .map((line) => ({ number: line.number, text: line.text }));

  // Only ever used for a line that has no ending of its own to copy.
  const fallback = /\r\n/.test(gitignore) ? '\r\n' : '\n';
  const out: string[] = [];
  let done = false;

  for (const line of lines) {
    if (!targets.has(line.number)) {
      out.push(line.text + line.eol);
      continue;
    }
    if (done) continue;
    done = true;
    // The replacement inherits the line it replaces: its ending between the
    // three rules, and its ending — or the absence of one — after the last, so
    // a file that did not end in a newline still does not.
    const between = line.eol === '' ? fallback : line.eol;
    IGNORE_PATTERN.forEach((rule, index) => {
      out.push(rule + (index === IGNORE_PATTERN.length - 1 ? line.eol : between));
    });
  }

  if (!done) {
    // Nothing to replace, so the pattern goes on the end — finishing the last
    // line first if it was left unfinished.
    const last = out.length - 1;
    const tail = out[last];
    if (tail !== undefined && !/\r\n$|\n$|\r$/.test(tail)) out[last] = tail + fallback;
    for (const rule of IGNORE_PATTERN) out.push(rule + fallback);
  }

  return { replaced, text: out.join('') };
}

/** The file after {@link planIgnorePattern}, for a caller that wants only that. */
export function withIgnorePattern(gitignore: string): string {
  return planIgnorePattern(gitignore).text;
}

/** The repo's `.gitignore`, or `null` when it has none. */
export function readGitignore(cwd: string): string | null {
  const path = gitignorePath(cwd);
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw new ConfigError(
      [
        'could not read .gitignore',
        '  ' + path,
        '  ' + (error instanceof Error ? error.message : String(error)),
      ].join('\n'),
    );
  }
}

export function writeGitignore(cwd: string, text: string): string {
  const path = gitignorePath(cwd);
  writeFileSync(path, text, 'utf8');
  return path;
}
