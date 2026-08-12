import type {
  AgentOutputEvent,
  BarCapturedEvent,
  PlanReadyEvent,
  RoundEvent,
  RunEvent,
  RunFinishedEvent,
  RunStatus,
  Verdict,
} from './events.js';
import type { Viewport } from './usage.js';
import {
  DEFAULT_WIDTH,
  MIN_WIDTH,
  displayWidth,
  graphemes,
  plainText,
  printable,
  truncate,
  wrapText,
} from './usage.js';

/**
 * The run's output layer: events in, text out.
 *
 * A run is watched three ways. On a terminal a person wants one line per round,
 * so that twenty rounds across six pieces read down the screen as a table. Down
 * a pipe the same rounds are records to be cut, sorted and grepped, so they go
 * out tab-delimited with every field whole — the split `renderTable` already
 * makes everywhere else in this CLI, and the shape the bar's own `gh run list`
 * transcript has. And `--json` hands the whole stream to CI as one object per
 * line. None of the three is a summary of another: the machine view carries
 * every fact the human views show, and the piped view cuts no field the
 * terminal had to shorten to fit a column.
 *
 * The reporter is a sink and nothing else: it never reads the clock, the
 * environment, the filesystem, or the process, and it decides nothing about the
 * run. Every value it prints came in on an event. That is what makes it
 * testable by driving it directly, and it is why a captured transcript is
 * reproducible byte for byte.
 *
 * Two rules govern what it does to a value on the way out.
 *
 * The first is that nothing arriving on an event is promised. A gap sentence is
 * written by a critic, a report is written by an agent, a piece id came out of
 * a plan, and the whole stream can arrive a second time out of a file that this
 * reporter itself wrote. So a field may be missing, null, or not a string at
 * all, and it may carry a newline, a tab, an escape sequence, an ideograph, or
 * a paragraph where a sentence was expected. None of that may cost the stream
 * its shape, and none of it may throw: a reporter that fails takes the run with
 * it, and the run is the thing worth keeping.
 *
 * The second is that shortening is a layout decision and belongs only where
 * layout happens. A column on a terminal is a fixed number of columns and a gap
 * too long for it is cut there. Nowhere else: not in the piped records, not in
 * the JSON, and above all not in what an agent wrote, which is reproduced as it
 * was written.
 */

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/** Spaces between columns, the same gap the help pages and tables use. */
const COLUMN_GAP = '  ';

/** What separates the fields of a record when the output is not a terminal. */
const FIELD_SEPARATOR = '\t';

/**
 * The label column everything that is not a round sits in: `bar`, `plan`,
 * `warning`, `result`. Nine columns is the width the interactive frames give
 * the same labels, so the two renderings of a run line up.
 */
const LABEL_WIDTH = 9;

/** Columns for the round number: three digits of rounds, and it never cuts. */
const ROUND_WIDTH = 3;

/** Columns for the duration: `9s`, `3m20s`, `1h2m`, `999h59m`. */
const ELAPSED_WIDTH = 7;

/** Narrowest the piece column is ever fixed at, and widest it may be fixed at. */
const PIECE_MIN = 2;
const PIECE_MAX = 24;

/**
 * The verdict, as a mark and a word.
 *
 * The word is the information and carries the whole of it: the three verdicts
 * read apart on a monochrome terminal, in a pipe, and in a captured transcript,
 * which are the places this output is actually read. The mark is scanning help
 * on a terminal and the color is decoration on top of that; a record going down
 * a pipe is the bare word, the way `gh` writes `completed` either way.
 */
const VERDICT_WORDS: Record<Verdict, string> = {
  WIN: 'WIN',
  LOSS: 'LOSS',
  BLOCKED: 'BLOCKED',
};

const VERDICT_MARKS: Record<Verdict, string> = {
  WIN: '✓',
  LOSS: '✗',
  BLOCKED: '▲',
};

/** The same, for the outcome of the whole run. */
const STATUS_WORDS: Record<RunStatus, string> = {
  win: 'WIN',
  loss: 'LOSS',
  blocked: 'BLOCKED',
  stopped: 'STOPPED',
};

const STATUS_MARKS: Record<RunStatus, string> = {
  win: '✓',
  loss: '✗',
  blocked: '▲',
  stopped: '▲',
};

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

const VERDICT_COLOR: Record<Verdict, string> = {
  WIN: GREEN,
  LOSS: RED,
  BLOCKED: YELLOW,
};

const STATUS_COLOR: Record<RunStatus, string> = {
  win: GREEN,
  loss: RED,
  blocked: YELLOW,
  stopped: YELLOW,
};

/** Widest verdict token, so the column can never be off by a character. */
const VERDICT_WIDTH = Object.keys(VERDICT_WORDS).reduce(
  (widest, verdict) => Math.max(widest, displayWidth(marked(verdict as Verdict))),
  0,
);

function marked(verdict: Verdict): string {
  return `${VERDICT_MARKS[verdict]} ${VERDICT_WORDS[verdict]}`;
}

/* -------------------------------------------------------------------------- */
/* Reading a field nobody promised anything about                              */
/* -------------------------------------------------------------------------- */

/**
 * A field as text.
 *
 * The events are typed, and a typed caller cannot put anything else here. A
 * caller replaying this reporter's own NDJSON back through it can: every
 * optional field comes back out of that file as `null` rather than absent. So
 * absent, null, and a number are all read as what they are rather than as a
 * reason to stop reporting a run.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return String(value);
  return '';
}

/** A field as a list, for the two events that carry one. */
function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A field of an object in a list, for the same two. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * A count as a whole number, or zero.
 *
 * `NaN` and `Infinity` are the two values that would quietly break both
 * renderings at once — a round numbered `NaN` on the terminal, and
 * `JSON.stringify` turning either into `null` in a field CI was promised a
 * number in. They are counted as none, in both views, so the two never
 * disagree.
 */
function integer(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** The same guard for money, which keeps its fractions. */
function money(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A duration in milliseconds, or nothing.
 *
 * A missing, negative, or non-finite duration is not a duration: it is a round
 * whose length was never measured. Every view asks this one question, so no two
 * of them can end up disagreeing about whether a round was timed.
 */
function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/* -------------------------------------------------------------------------- */
/* Small conversions                                                           */
/* -------------------------------------------------------------------------- */

/** Pads to `width` display columns, given what the text really occupies. */
function padTo(text: string, width: number, visible: number = displayWidth(text)): string {
  return text + ' '.repeat(Math.max(0, width - visible));
}

/**
 * Text cut to `width` columns, marked as cut, in a column too narrow to say
 * `...` in.
 *
 * The piece column is as wide as the identifiers a plan named, which is often
 * two columns — narrower than the three `truncate` needs before it will mark a
 * cut at all. An identifier quietly shortened is not a shorter identifier, it
 * is a different one, so the mark here is the one character that fits any
 * column wide enough to hold anything.
 */
function ellipsize(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const cluster of graphemes(text)) {
    const columns = displayWidth(cluster);
    if (used + columns > width - 1) break;
    out += cluster;
    used += columns;
  }
  return `${out}…`;
}

/**
 * A duration the way a `gh` list writes one: `9s`, `3m20s`, `1h2m`.
 *
 * Two units, largest first, which is what makes it a column: seconds matter
 * when a round took eleven of them and are noise when it took an hour, and the
 * exact milliseconds are on the same event in the machine view for anyone
 * counting them. A round that was never timed leaves the field empty rather
 * than printing something that was never measured.
 */
function elapsed(value: unknown): string {
  const measured = duration(value);
  if (measured === null) return '';
  const total = Math.round(measured / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** `1 round` / `9 rounds`, and the same for pieces and artifacts. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Money, to four places, and never rounded down to nothing.
 *
 * Four places rather than two because a run can cost fractions of a cent and
 * `$0.00` is not what it cost. A run that cost less than the smallest number
 * four places can write is reported as less than it, which is true, rather than
 * as zero, which is the one thing it certainly was not.
 */
function dollars(value: unknown): string {
  const amount = money(value);
  const fixed = amount.toFixed(4);
  return amount > 0 && Number(fixed) === 0 ? '<$0.0001' : `$${fixed}`;
}

/**
 * The lines of a block of text, as they were written.
 *
 * This is the one thing in the file that is reproduced rather than laid out.
 * What an agent wrote is read as a report: its columns are aligned with runs of
 * spaces, its structure is carried by its indentation, and a command in it is
 * meant to be copied off the screen and run. Re-wrapping it, re-indenting it,
 * or squeezing its runs of spaces would each destroy one of those, so none of
 * them happens — a line too wide for the terminal is left for the terminal to
 * fold, exactly as `cat` would leave it.
 *
 * What does happen is the least that keeps a terminal safe: escape sequences
 * and the control characters a terminal acts on are taken out, because a report
 * may not repaint the screen or move the cursor, and an unpaired surrogate is
 * not a character. Tabs survive that, so a report aligned with them stays
 * aligned. Every other byte is the byte the agent wrote.
 */
function verbatim(value: unknown): string[] {
  const text = asText(value);
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A trailing newline ends the last line; it does not start another one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) =>
    line
      .split(FIELD_SEPARATOR)
      .map((piece) => printable(piece))
      .join(FIELD_SEPARATOR),
  );
}

/* -------------------------------------------------------------------------- */
/* The reporter                                                                */
/* -------------------------------------------------------------------------- */

export interface ReporterOptions {
  /** Emit one NDJSON line per event and no human text at all. */
  json: boolean;
  /** Print what the agents wrote, in full. */
  verbose: boolean;
  /** Where the text goes. Also where color is decided: only a terminal gets it. */
  stream: NodeJS.WritableStream;
  /**
   * How to lay the human views out, when the stream is not the whole story.
   *
   * Left off, it is read from the stream: a terminal gets aligned columns at
   * its own width, anything else gets records. It is passed in by a caller that
   * knows better than the stream does — which is what `EXOLVRA_GENESIS_FORCE_TTY`
   * means everywhere else in this CLI, and how an aligned transcript is
   * captured to a file. Color is never part of it: that follows the stream, so
   * a captured transcript never carries an escape sequence.
   */
  view?: Viewport;
}

export interface Reporter {
  /**
   * Renders one event.
   *
   * Never throws, never buffers, never reorders, and never holds a line back.
   */
  emit(event: RunEvent): void;
}

/**
 * Which run of lines the last write belonged to.
 *
 * Rounds are a table and are written without gaps between them; everything else
 * is a paragraph and gets a blank line between it and the table. Tracking only
 * this much is enough to group the stream without ever holding a line back,
 * which a live run cannot afford.
 */
type Group = 'none' | 'label' | 'round' | 'block';

/**
 * A reporter writing to `stream`.
 *
 * `json` chooses the machine view over the human ones; `verbose` promotes the
 * agents' own output into the human ones. In the machine view `verbose` changes
 * nothing at all: the stream a CI job parses is the same stream whatever the
 * person who started the run wanted to watch.
 */
export function createReporter(options: ReporterOptions): Reporter {
  const { json, verbose, stream } = options;
  const terminal = stream as Partial<NodeJS.WriteStream>;

  /**
   * Color is drawn only on a terminal.
   *
   * A pipe, a file, and a CI log get none: an escape sequence nobody interprets
   * is corruption of the transcript it lands in, and the transcript is what a
   * run is read back from. This asks the stream and not the viewport, so
   * laying out for a terminal in order to capture the result to a file gets the
   * columns without the escape sequences.
   */
  const colored = !json && terminal.isTTY === true;

  /**
   * How to lay out, asked again on every write.
   *
   * A terminal reports its own width and can be resized while a run is going.
   * Anything else is laid out for {@link DEFAULT_WIDTH} columns, which is what
   * makes a captured transcript the same on every machine, and no width is ever
   * below {@link MIN_WIDTH} — the floor the rest of the CLI lays out to, and
   * the one `exolvra-genesis help environment` documents.
   */
  const viewport = (): Viewport => {
    const given = options.view;
    if (given !== undefined) {
      return { tty: given.tty, width: Math.max(MIN_WIDTH, Math.trunc(given.width)) };
    }
    const reported = terminal.columns;
    const width =
      typeof reported === 'number' && Number.isFinite(reported) && reported > 0
        ? Math.trunc(reported)
        : DEFAULT_WIDTH;
    return { tty: terminal.isTTY === true, width: Math.max(MIN_WIDTH, width) };
  };

  /**
   * The width of the piece column, once something has named a piece.
   *
   * A table measures every row before it draws the first one. A run cannot: the
   * fortieth round is hours away when the first one is printed, and holding the
   * first one back until then is not reporting. So the column is fixed once, by
   * the plan — which names every piece before any of them is judged — or, if no
   * plan was announced, by the first round to arrive. It is never widened
   * afterwards, because widening it would leave every line already printed
   * misaligned against every line still to come. An identifier too wide for it
   * is cut with an ellipsis, which says that it was cut.
   */
  let pieceWidth: number | null = null;

  const fixPieceWidth = (widest: number): number => {
    if (pieceWidth === null) {
      pieceWidth = Math.min(PIECE_MAX, Math.max(PIECE_MIN, widest));
    }
    return pieceWidth;
  };

  let previous: Group = 'none';

  /**
   * Whether the sink is still taking output.
   *
   * A reader that goes away — a pager quit, a `head -5`, a closed pipe — is not
   * a fault in the run and is not something the run can do anything about. The
   * write fails, the sink is closed, and everything after it is dropped rather
   * than thrown at a caller who was only asking for a line to be printed. This
   * reporter's contract is that reporting cannot be what ends a run.
   */
  let closed = false;

  const send = (chunk: string): void => {
    if (closed) return;
    try {
      // Fire and forget: `write` returning false means the buffer is filling,
      // and a run reports far too little, far too slowly, for that to matter.
      // Waiting for drain would mean holding a verdict back to save memory
      // that is not at risk, so the return value is deliberately not read.
      stream.write(chunk);
    } catch {
      closed = true;
    }
  };

  // A stream that fails asynchronously — which is how a broken pipe usually
  // arrives — emits rather than throws, and an unheard 'error' event would take
  // the process down over output nobody is reading any more.
  if (typeof (stream as Partial<NodeJS.WritableStream>).on === 'function') {
    stream.on('error', () => {
      closed = true;
    });
  }

  /**
   * A cell of exactly `width` columns, colored if anyone is there to see it.
   *
   * The color goes on after the text is cut and the padding is measured, so a
   * colored line and an uncolored one are the same line: an escape sequence is
   * zero columns wide and is never allowed to be counted as anything else.
   */
  const paint = (text: string, color: string, width: number): string => {
    const fitted = truncate(text, width);
    return padTo(colored ? color + fitted + RESET : fitted, width, displayWidth(fitted));
  };

  const write = (lines: readonly string[], group: Group): void => {
    if (lines.length === 0) return;
    // A blank line between groups is white space, and white space is for a
    // reader. Piped output has none: every line there is a record, and a stream
    // that is records with occasional empty lines in it is a stream every
    // consumer has to be told about.
    const separated =
      viewport().tty && previous !== 'none' && (previous !== group || group === 'block');
    send((separated ? '\n' : '') + lines.join('\n') + '\n');
    previous = group;
  };

  /**
   * A label and its text, the text wrapped into the column the label opens.
   *
   * The label keeps its own column even when the text runs to several lines, so
   * a long goal or a wrapped warning still reads as one record.
   */
  const labelled = (label: string, text: string, breakWords = true): string[] => {
    const body = wrapText(text, viewport().width, LABEL_WIDTH, { breakWords });
    const head =
      displayWidth(label) + COLUMN_GAP.length <= LABEL_WIDTH
        ? padTo(label, LABEL_WIDTH)
        : label + COLUMN_GAP;
    const first = body[0];
    if (first === undefined) return [label];
    return [(head + first.slice(LABEL_WIDTH)).trimEnd(), ...body.slice(1)];
  };

  const barSummary = (event: BarCapturedEvent): string => {
    const path = plainText(asText(event.path));
    const count = asList(event.artifacts).length;
    return count === 0 ? path : `${path} (${plural(count, 'artifact')})`;
  };

  /**
   * The plan, and the width every round line after it is laid out to.
   *
   * The plan names every piece before the first of them is judged, so this is
   * where the piece column gets the one measurement it will ever take.
   */
  const planSummary = (event: PlanReadyEvent): string => {
    const pieces = asList(event.pieces);
    const ids = pieces
      .map((piece) => plainText(asText(field(piece, 'id'))))
      .filter((id) => id !== '');
    if (ids.length > 0) {
      fixPieceWidth(ids.reduce((widest, id) => Math.max(widest, displayWidth(id)), 0));
    }
    if (pieces.length === 0) return 'no pieces';
    const heading = plural(pieces.length, 'piece');
    return ids.length === 0 ? heading : `${heading}: ${ids.join(', ')}`;
  };

  /** The five fields of a round, in the order both human views print them. */
  const roundFields = (event: RoundEvent): [string, string, string, string, string] => [
    plainText(asText(event.piece)),
    String(integer(event.round)),
    VERDICT_WORDS[event.verdict] ?? plainText(asText(event.verdict)),
    elapsed(event.elapsedMs),
    plainText(asText(event.gap)),
  ];

  /**
   * One round as a record, for output that is not a terminal.
   *
   * The shape `gh` writes when its list is redirected, and the shape
   * `renderTable` writes everywhere else in this CLI: one tab-delimited record
   * per round, always five fields, no header, and — the point of it — every
   * field whole. A column is a terminal's constraint and there is no terminal
   * here, so nothing is cut to fit one. Each field has already been flattened
   * to one printable line, so no tab or newline inside a value can invent a
   * field or split a record.
   */
  const roundRecord = (event: RoundEvent): string =>
    roundFields(event).join(FIELD_SEPARATOR);

  /**
   * One round, one line, for a terminal.
   *
   * Four columns of a width fixed before the first round was judged, then the
   * gap. A verdict is found by running an eye down the line rather than by
   * reading the lines, which is what the columns are for. The gap takes what is
   * left of the terminal and is cut to fit: it is last, so cutting it costs no
   * other field a character, and it is the field a reader can go to the piped
   * or JSON view for in full. A verdict that came with no gap is left blank
   * rather than given something to say.
   *
   * The two numbers are never cut. A round number or a duration with its end
   * taken off is not a shorter number, it is a wrong one, so a value too wide
   * for its column pushes that one line out of true instead — a crooked line
   * being the smaller lie.
   */
  const roundLine = (event: RoundEvent, width: number): string => {
    const [piece, round, word, took, gap] = roundFields(event);
    const columns = fixPieceWidth(displayWidth(piece));
    const mark = VERDICT_MARKS[event.verdict];
    const verdict = mark === undefined ? word : `${mark} ${word}`;

    const fixed =
      columns +
      Math.max(ROUND_WIDTH, displayWidth(round)) +
      VERDICT_WIDTH +
      Math.max(ELAPSED_WIDTH, displayWidth(took)) +
      COLUMN_GAP.length * 4;

    return [
      padTo(ellipsize(piece, columns), columns),
      padTo(round, ROUND_WIDTH),
      paint(verdict, VERDICT_COLOR[event.verdict] ?? YELLOW, VERDICT_WIDTH),
      padTo(took, ELAPSED_WIDTH),
      truncate(gap, Math.max(0, width - fixed)),
    ]
      .join(COLUMN_GAP)
      .trimEnd();
  };

  /**
   * What an agent wrote, under a line saying who wrote it and about what.
   *
   * The heading is this reporter's; everything under it is the agent's, line
   * for line and space for space. See {@link verbatim}.
   */
  const agentBlock = (event: AgentOutputEvent): string[] => {
    const agent = plainText(asText(event.agent));
    const piece = plainText(asText(event.piece));
    const round = event.round === undefined || event.round === null
      ? ''
      : `round ${integer(event.round)}`;
    const where = [piece, round].filter((part) => part !== '').join(' ');
    const who = where === '' ? agent : `${agent} on ${where}`;
    return [...labelled('output', who === '' ? 'agent' : who), ...verbatim(event.text)];
  };

  /**
   * The closing lines: the outcome, and the session it can be resumed from.
   *
   * The session id gets its own line so it is never wrapped or cut — it is a
   * value to be copied, and half of one is worse than none.
   */
  const resultLines = (event: RunFinishedEvent): string[] => {
    const word = STATUS_WORDS[event.status] ?? plainText(asText(event.status));
    const mark = STATUS_MARKS[event.status];
    const line = [
      paint(
        mark === undefined ? word : `${mark} ${word}`,
        STATUS_COLOR[event.status] ?? YELLOW,
        VERDICT_WIDTH,
      ),
      plural(integer(event.rounds), 'round'),
      dollars(event.costUsd),
    ].join(COLUMN_GAP);
    const lines = [(padTo('result', LABEL_WIDTH) + line).trimEnd()];
    const session = plainText(asText(event.sessionId));
    if (session !== '') lines.push(...labelled('session', session, false));
    return lines;
  };

  /**
   * One event as one record, for output that is not a terminal.
   *
   * The same discipline the round records already keep, applied to every other
   * event: one line per record whatever its length, tab between the fields, no
   * glyph, and nothing wrapped. A column and a mark are a terminal's language,
   * and there is no terminal here — a path folded across three lines with a
   * hanging indent is not a path any more, and a tick in front of a status is a
   * character the reader has to strip before the status can be compared to
   * anything. Rounds keep their five fields; every other record is its label and
   * its values, so the two are told apart by the shape they have always had.
   */
  const record = (label: string, ...fields: readonly string[]): string[] => [
    [label, ...fields].map((field) => plainText(field)).join(FIELD_SEPARATOR),
  ];

  const machineLines = (event: RunEvent): { lines: string[]; group: Group } => {
    switch (event.type) {
      case 'run_started':
        return {
          lines: record(event.source === 'spec' ? 'spec' : 'goal', asText(event.goal)),
          group: 'label',
        };
      case 'bar_captured':
        return {
          lines: record(
            'bar',
            asText(event.path),
            String(asList(event.artifacts).length),
          ),
          group: 'label',
        };
      case 'plan_ready': {
        const pieces = asList(event.pieces);
        return {
          lines: record(
            'plan',
            String(pieces.length),
            pieces
              .map((piece) => plainText(asText(field(piece, 'id'))))
              .filter((id) => id !== '')
              .join(','),
          ),
          group: 'label',
        };
      }
      case 'round':
        return { lines: [roundRecord(event)], group: 'round' };
      case 'agent_output': {
        if (!verbose) return { lines: [], group: 'block' };
        // Records here too, one per line the agent wrote, each tagged with who
        // wrote it. A block of prose dropped into a stream of records is a
        // stream nothing can read: `cut -f1` starts returning fragments of
        // sentences, and the reader has no way to tell which lines were data.
        const who = [plainText(asText(event.agent)), plainText(asText(event.piece))]
          .filter((part) => part !== '')
          .join('/');
        const text = verbatim(event.text);
        return {
          lines: (text.length === 0 ? [''] : text).map((line) =>
            ['output', who === '' ? 'agent' : who, line].join(FIELD_SEPARATOR),
          ),
          group: 'round',
        };
      }
      case 'notice':
        return {
          lines: record(NOTICE_LABELS[event.level] ?? 'note', asText(event.message)),
          group: 'label',
        };
      case 'run_finished': {
        const lines = record(
          'result',
          STATUS_WORDS[event.status] ?? asText(event.status),
          String(integer(event.rounds)),
          dollars(event.costUsd),
        );
        const session = plainText(asText(event.sessionId));
        if (session !== '') lines.push(...record('session', session));
        return { lines, group: 'label' };
      }
      default:
        return { lines: [], group: 'none' };
    }
  };

  const terminalLines = (event: RunEvent): { lines: string[]; group: Group } => {
    switch (event.type) {
      case 'run_started':
        return {
          lines: labelled(
            event.source === 'spec' ? 'spec' : 'goal',
            plainText(asText(event.goal)),
            event.source !== 'spec',
          ),
          group: 'label',
        };
      case 'bar_captured':
        return { lines: labelled('bar', barSummary(event), false), group: 'label' };
      case 'plan_ready':
        return { lines: labelled('plan', planSummary(event)), group: 'label' };
      case 'round':
        return { lines: [roundLine(event, viewport().width)], group: 'round' };
      case 'agent_output':
        return { lines: verbose ? agentBlock(event) : [], group: 'block' };
      case 'notice':
        return {
          lines: labelled(NOTICE_LABELS[event.level] ?? 'note', asText(event.message)),
          group: 'label',
        };
      case 'run_finished':
        return { lines: resultLines(event), group: 'label' };
      default:
        return { lines: [], group: 'none' };
    }
  };

  const human = (event: RunEvent): void => {
    const { lines, group } = viewport().tty ? terminalLines(event) : machineLines(event);
    write(lines, group);
  };

  return {
    emit(event: RunEvent): void {
      if (event === null || typeof event !== 'object') return;
      if (!json) {
        human(event);
        return;
      }
      const payload = payloadFor(event);
      if (payload !== null) send(jsonLine(payload) + '\n');
    },
  };
}

/** The word a notice is labelled with, which is also its level. */
const NOTICE_LABELS: Record<string, string> = {
  note: 'note',
  warning: 'warning',
  error: 'error',
};

/* -------------------------------------------------------------------------- */
/* The machine view                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One event as one line of JSON.
 *
 * `JSON.stringify` escapes every character that could end a line early — a
 * newline in a gap, a tab in a path, an escape sequence in an agent's report,
 * an unpaired surrogate — so no field can split one record into two or leave a
 * line that will not parse. The two it leaves alone are U+2028 and U+2029,
 * legal inside a JSON string but line terminators to some readers of one;
 * escaping them costs nothing and makes every line of this stream a line by
 * everyone's reckoning. What comes back out of `JSON.parse` is unchanged.
 */
function jsonLine(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The fields an event carries in the machine view.
 *
 * Snake case throughout, every key always present, and an absent optional value
 * written as `null` rather than left out, so a consumer can read a field
 * without first testing whether it exists. Nothing is flattened, shortened, or
 * cut here: the gap the terminal had to fit into a column is whole in this one,
 * which is the point of having both.
 *
 * `run_finished` is the exception and is the summary itself — exactly `status`,
 * `rounds`, `cost_usd` and `session_id`, the four fields a CI job reads off the
 * last line of the stream.
 */
function payloadFor(event: RunEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'run_started':
      return { type: event.type, goal: event.goal, source: event.source };
    case 'bar_captured':
      return {
        type: event.type,
        path: event.path,
        artifacts: asList(event.artifacts).map((artifact) => ({
          path: field(artifact, 'path') ?? null,
          detail: field(artifact, 'detail') ?? null,
        })),
      };
    case 'plan_ready':
      return {
        type: event.type,
        pieces: asList(event.pieces).map((piece) => ({
          id: field(piece, 'id') ?? null,
          title: field(piece, 'title') ?? null,
        })),
      };
    case 'round':
      return {
        type: event.type,
        piece: event.piece,
        round: integer(event.round),
        verdict: event.verdict,
        gap: event.gap ?? null,
        elapsed_ms: duration(event.elapsedMs),
      };
    case 'agent_output':
      return {
        type: event.type,
        agent: event.agent,
        piece: event.piece ?? null,
        round: event.round === undefined || event.round === null ? null : integer(event.round),
        text: event.text,
      };
    case 'notice':
      return { type: event.type, level: event.level, message: event.message };
    case 'run_finished':
      return {
        status: event.status,
        rounds: integer(event.rounds),
        cost_usd: money(event.costUsd),
        session_id: event.sessionId ?? null,
      };
    default:
      // Unreachable from typed code: the union is closed and every tag above is
      // one of its members. A value that reached here came from outside the
      // type system, and a stream promised one JSON object per line is better
      // short a line it never contracted to carry than carrying guesswork.
      return null;
  }
}
