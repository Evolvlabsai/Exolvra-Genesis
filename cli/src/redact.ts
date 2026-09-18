/**
 * Keeping secrets out of everything the loop writes: trace events, status
 * lines, model errors, job output. Tokens are matched by shape and, when the
 * caller knows one, by value, after folding the text the way a reader sees it.
 */

/**
 * The shortest string that will be accepted as a token.
 *
 * Not a guess at GitHub's format — it is what makes {@link redactSecrets}
 * total. A one-character "token" would turn redaction into a search and replace
 * over every message this module writes, so a value too short to redact safely
 * is refused at the door instead. Real GitHub tokens are forty characters and
 * longer.
 */
const MIN_TOKEN_LENGTH = 8;

/**
 * The shapes GitHub issues its tokens in, as a last line of defence.
 *
 * The run's own token is redacted by value; this catches the *other* secrets —
 * a token belonging to some other account echoed back in a response body, one
 * pasted into an issue by a person who should not have. Neither this module nor
 * the run using it can tell those from noise, so they are removed on sight.
 */
const TOKEN_SHAPES =
  /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{22,}|v[0-9]\.[0-9a-f]{40}/g;

/** What stands in place of a secret. */
export const REDACTED = '[redacted]';

/**
 * A character that is not there when a reader looks at the text.
 *
 * Unicode's format class, which is every one of them: the zero-width space, the
 * zero-width joiner and non-joiner, the word joiner, the soft hyphen, the
 * byte-order mark, and the bidirectional marks and isolates. Named as a class
 * rather than as a list because a list of invisible characters is a list that
 * will be missing one, and the one it is missing is the one somebody uses.
 */
const INVISIBLE = /\p{Cf}/u;

/** The text as it was seen, alongside where each character of it came from. */
interface Folded {
  /** Canonical, with the invisibles gone. Never returned to a caller. */
  text: string;
  /** Where each code unit of {@link text} starts in the original. */
  startAt: number[];
  /** …and where it ends. */
  endAt: number[];
}

/**
 * The text as a reader sees it, with a way back to the text as it was written.
 *
 * Two transformations, both of them things a person reading the string would do
 * without noticing:
 *
 * - **NFKC, one character at a time.** `ｇｈｐ＿` is four fullwidth code points
 *   that a terminal draws as `ghp_` and that any normalising round trip turns
 *   into `ghp_`. A pattern written in ASCII does not match it, and a token
 *   compared by value is not equal to it, so a token typed this way was
 *   invisible to both of the checks below.
 * - **Format characters removed.** A zero-width space in the middle of a token
 *   splits it into two strings, neither of which is the token and only one of
 *   which is long enough to match a pattern — which is how half a secret
 *   reached a published title beside the marker for the other half.
 *
 * The mapping is the point of the whole exercise. Scanning happens over this
 * text; *replacing* happens over the original, at the offsets a match maps back
 * to. Returning the folded text would be a different bug: it would rewrite
 * every legitimate fullwidth title, ligature and soft hyphen in the repository
 * on the way past, and a redactor that edits text containing no secrets is not
 * a redactor.
 */
function fold(text: string): Folded {
  let folded = '';
  const startAt: number[] = [];
  const endAt: number[] = [];
  let at = 0;
  for (const character of text) {
    const next = at + character.length;
    if (!INVISIBLE.test(character)) {
      const canonical = character.normalize('NFKC');
      folded += canonical;
      for (let i = 0; i < canonical.length; i += 1) {
        startAt.push(at);
        endAt.push(next);
      }
    }
    at = next;
  }
  return { text: folded, startAt, endAt };
}

/** One stretch of the original text that a secret was found in. */
type Span = [start: number, end: number];

/** Overlapping and touching spans joined, so nothing is marked twice. */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Span[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Removes secrets from text about to be shown, stored, or thrown.
 *
 * Exported because C12 is wider than this module: anything that shows, stores
 * or sends on text that came out of a repository — a listing, a page, a
 * comment, a run record — has to remove secrets the same way rather than each
 * surface inventing a rule. Every one of those surfaces is cured or broken
 * together, which is the reason there is one of these and not seven.
 *
 * Two ways a secret is recognised, and both of them look at the text as a
 * reader sees it (see {@link fold}) rather than as it was typed. The known
 * secret is matched by value rather than by pattern — a token is not a regular
 * expression, and treating one as a pattern would either miss it or match half
 * the message — and the shapes above catch the ones this run was never told
 * about. What comes back is the text exactly as it arrived, with only the
 * stretches a secret was found in replaced.
 */
export function redactSecrets(text: string, secret?: string): string {
  const seen = fold(text);
  const spans: Span[] = [];

  /** A match in the folded text, as the stretch of original it came from. */
  const found = (start: number, end: number): void => {
    const from = seen.startAt[start];
    const to = seen.endAt[end - 1];
    if (end > start && from !== undefined && to !== undefined) spans.push([from, to]);
  };

  if (secret !== undefined && secret.length >= MIN_TOKEN_LENGTH) {
    // Folded the same way, so a secret that itself arrived decorated still
    // matches the decorated copy of it in the text.
    const needle = fold(secret).text;
    // A "secret" that folds away to nothing is not one, and searching for the
    // empty string finds it everywhere and never advances.
    for (let at = needle === '' ? -1 : seen.text.indexOf(needle); at !== -1; ) {
      found(at, at + needle.length);
      at = seen.text.indexOf(needle, at + needle.length);
    }
  }
  for (const match of seen.text.matchAll(TOKEN_SHAPES)) {
    if (match.index !== undefined) found(match.index, match.index + match[0].length);
  }
  if (spans.length === 0) return text;

  let out = '';
  let at = 0;
  for (const [start, end] of merge(spans)) {
    out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return out + text.slice(at);
}
