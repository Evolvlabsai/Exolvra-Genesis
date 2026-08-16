/**
 * The fleet page: every issue run, on one page, across every allowlisted
 * repository (R8).
 *
 * It is the per-run progress page's sibling and is written the same way the
 * plugin's own page is written: the template ships on disk, two HTML comments
 * mark off a JSON data block inside it, and filling the page replaces what is
 * between those markers and nothing else. The markup, the styles and the
 * renderer are never edited by the code that fills it — which is what keeps one
 * page one design for everybody, and what makes "the page changed" mean the
 * template changed.
 *
 * Everything that reaches the block is treated as untrusted, because most of it
 * is: an issue title is written by whoever opened the issue. Four things happen
 * to it on the way in, in this order:
 *
 * - it is flattened to one printable line and stripped of the characters that
 *   reorder one, so a title cannot be a page of its own or a row that turns the
 *   rows around it back to front;
 * - anything shaped like a credential is removed by {@link redactSecrets}, so a
 *   token somebody pasted into an issue is not republished by the page that
 *   reports on it (C12);
 * - it is cut to a width;
 * - every `<` in the encoded block becomes its JSON escape, so nothing inside a
 *   string value can close the script element it sits in;
 * - a link is only carried when it is an https GitHub URL, checked here and
 *   again by the page before it becomes an anchor.
 *
 * The redaction is deliberately applied to every field rather than to the ones
 * that look risky. This page is an artifact somebody screenshots and pastes into
 * a chat window, which is exactly how a secret travels; and "which fields came
 * from a stranger" is a judgement that has to be made again every time a field
 * is added, whereas "all of them" does not.
 *
 * The page is one write: a temporary file and a rename. The page refreshes
 * itself on a timer, so a reader can land on it at any instant, and half a page
 * is not what any of them should get.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { LIFECYCLE, type Lifecycle } from './allowlist.js';
import { ConfigError } from './exit.js';
import { redactSecrets } from './github.js';
import { loadPluginSources } from './plugin-dir.js';
import { RUN_DIR } from './runs-store.js';
import { plainText, truncate } from './usage.js';

/* -------------------------------------------------------------------------- */
/* Where it lives                                                              */
/* -------------------------------------------------------------------------- */

/** The page's name under the run directory. */
export const FLEET_PAGE = 'fleet.html';

/** Where the fleet page is written, under the directory a command runs in. */
export function fleetPath(cwd: string): string {
  return join(cwd, RUN_DIR, FLEET_PAGE);
}

/* -------------------------------------------------------------------------- */
/* The data block                                                              */
/* -------------------------------------------------------------------------- */

/** The comment that opens the region a fill may replace. */
export const DATA_BEGIN = '<!-- EXOLVRA-GENESIS-DATA-BEGIN -->';

/** The comment that closes it. */
export const DATA_END = '<!-- EXOLVRA-GENESIS-DATA-END -->';

/** The element the page reads its data out of. */
export const DATA_ELEMENT_ID = 'exolvra-genesis-data';

/** One issue run, as the page draws a row of it. */
export interface FleetRun {
  /** `owner/name`. */
  repo: string;
  issue: number;
  title: string;
  /** Which lifecycle state the issue carries. */
  status: Lifecycle;
  /** Rounds judged so far, or null when no run has started locally. */
  round: number | null;
  /** The last verdict reached, or null when none has been. */
  verdict: string | null;
  /** What the run has spent, in US dollars, or null when nothing is recorded. */
  costUsd: number | null;
  /** The pull request this issue's branch has open, or null. */
  pr: string | null;
  /** The issue page. */
  url: string | null;
  /** When the issue last moved, ISO 8601. */
  updated: string | null;
}

/** Everything one rendering of the page is drawn from. */
export interface FleetData {
  /** When the page was written, ISO 8601 UTC to the second. */
  generated: string;
  /** The allowlist the pass ran against, as `owner/name`. */
  repos: readonly string[];
  runs: readonly FleetRun[];
  /** One line under the table. */
  note?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* Fields, on the way in                                                       */
/* -------------------------------------------------------------------------- */

/** How much of a title reaches a row. Long enough to read, short enough to sit. */
const TITLE_WIDTH = 200;

/** How much of any other field does. */
const FIELD_WIDTH = 80;

/**
 * How much of a verdict does.
 *
 * Wider than the rest, because a verdict is the one field on this page a reader
 * is there for: "LOSS" alone says a round happened, and the sentence after it
 * says what has to change. Cutting that at forty characters hides the half that
 * is worth reading.
 */
const VERDICT_WIDTH = 160;

/**
 * The characters that reorder a line rather than draw on it.
 *
 * The same removal the terminal tables make, for the same reason: a
 * right-to-left override inside a title turns the cells after it around, so one
 * row can be made to read as another without a character of it being false.
 */
const BIDI = /\p{Bidi_Control}/gu;

/**
 * One field: flattened to a line, stripped of what reorders it, stripped of
 * anything shaped like a credential, and cut to a width.
 *
 * The redaction runs twice, once on the way in and once after the flattening,
 * and both are load-bearing. A token split by an escape sequence or by a
 * right-to-left override is not a token any pattern can see — until those are
 * removed, at which point the two halves are adjacent and it is one again. The
 * second pass is the one that catches it; the first is what keeps a credential
 * from surviving as a *shorter* recognisable fragment when the flattening
 * changes nothing. Neither pass can create a secret, so running both is only
 * ever stricter.
 */
function field(value: unknown, width = FIELD_WIDTH): string {
  const flat = plainText(redactSecrets(String(value ?? ''))).replace(BIDI, '');
  return truncate(redactSecrets(flat), width);
}

/** The same, or null when there is nothing to say. */
function optional(value: unknown, width = FIELD_WIDTH): string | null {
  if (value === undefined || value === null) return null;
  const text = field(value, width);
  return text === '' ? null : text;
}

/** A whole count of zero or more, or null. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** An amount of money, or null. A negative cost is not one. */
function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * A link the page may hand to a browser, or null.
 *
 * https, and github.com, and nothing else. A URL arrives in a record like any
 * other field, and a page that turns whatever it finds there into an anchor is a
 * page that will one day link somewhere nobody chose.
 */
const GITHUB_URL = /^https:\/\/([a-z0-9-]+\.)*github\.com\/[^\s]*$/i;

function url(value: unknown): string | null {
  const text = optional(value, 300);
  return text !== null && GITHUB_URL.test(text) ? text : null;
}

/** A lifecycle state, or the one an issue has when nothing says otherwise. */
function status(value: unknown): Lifecycle {
  return LIFECYCLE.find((state) => state === value) ?? 'ready';
}

function normalizeRun(run: FleetRun): FleetRun {
  return {
    repo: field(run.repo, 120),
    issue: Number.isInteger(run.issue) && run.issue > 0 ? run.issue : 0,
    title: field(run.title, TITLE_WIDTH),
    status: status(run.status),
    round: count(run.round),
    verdict: optional(run.verdict, VERDICT_WIDTH),
    costUsd: amount(run.costUsd),
    pr: url(run.pr),
    url: url(run.url),
    updated: optional(run.updated, 40),
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function brokenTemplate(reason: string): ConfigError {
  return new ConfigError(
    [
      'the fleet template is not one this can fill',
      '  ' + reason,
      '  the data block is the region between ' + DATA_BEGIN + ' and',
      '  ' + DATA_END + ', each of which appears exactly once',
    ].join('\n'),
  );
}

/** Where `marker` is, having checked that it is there exactly once. */
function once(template: string, marker: string): number {
  const at = template.indexOf(marker);
  if (at === -1) throw brokenTemplate('it carries no ' + marker);
  if (template.indexOf(marker, at + marker.length) !== -1) {
    throw brokenTemplate('it carries more than one ' + marker);
  }
  return at;
}

/**
 * The data as JSON that is safe inside a script element.
 *
 * Every `<` becomes its escape, which is a different spelling of the same JSON
 * string and cannot be anything else: `</script>` inside a value would otherwise
 * end the element early, and `<!--` would start a comment inside it. Doing it to
 * the encoded text rather than to each value is deliberate — JSON syntax has no
 * `<` of its own, so there is nothing else for the replacement to touch, and no
 * value can be forgotten.
 */
function encode(data: FleetData): string {
  const payload = {
    generated: field(data.generated, 40),
    repos: data.repos.map((repo) => field(repo, 120)).filter((repo) => repo !== ''),
    ...(data.note === undefined ? {} : { note: field(data.note, 300) }),
    runs: data.runs.map(normalizeRun),
  };
  return JSON.stringify(payload, null, 2).replace(/</g, '\\u003c');
}

/**
 * `template` with its data block replaced by `data`.
 *
 * Everything outside the two markers comes back byte for byte, including the
 * markers themselves. That is the whole contract: a fill can change the data and
 * can change nothing else, so the page a reader sees is the template that was
 * reviewed plus the numbers of one pass.
 */
export function renderFleetPage(template: string, data: FleetData): string {
  const begin = once(template, DATA_BEGIN);
  const end = once(template, DATA_END);
  const after = begin + DATA_BEGIN.length;
  if (end < after) {
    throw brokenTemplate('the closing marker comes before the opening one');
  }

  const block = [
    '',
    '<script id="' + DATA_ELEMENT_ID + '" type="application/json">',
    encode(data),
    '</script>',
    '',
  ].join('\n');

  return template.slice(0, after) + block + template.slice(end);
}

/* -------------------------------------------------------------------------- */
/* Writing it                                                                  */
/* -------------------------------------------------------------------------- */

/** The shipped fleet template, read from the plugin directory at runtime. */
export function loadFleetTemplate(env: NodeJS.ProcessEnv = process.env): string {
  return loadPluginSources(env).fleetHtml;
}

/**
 * Writes the page under `cwd` and answers where it went.
 *
 * A temporary file and a rename, because the page reloads itself every twenty
 * seconds: a reader can arrive at any instant, and the instant halfway through a
 * write is one of them.
 */
export function writeFleetPage(cwd: string, template: string, data: FleetData): string {
  const path = fleetPath(cwd);
  const page = renderFleetPage(template, data);
  const temp = join(
    dirname(path),
    '.' + basename(path) + '.' + process.pid + '.tmp',
  );
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, page, 'utf8');
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new ConfigError(
      [
        'could not write the fleet page',
        '  ' + path,
        '  ' + (error instanceof Error ? error.message : String(error)),
        '  check that the directory is writable, and that nothing else is holding',
        '  the file open',
      ].join('\n'),
    );
  }
  return path;
}
