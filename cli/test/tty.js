/**
 * A terminal that is not one.
 *
 * Everything interactive in this CLI is driven through here rather than
 * described: a pair of streams that claim to be a TTY, keep every byte written
 * to them, and take real keystrokes. What is under test is the real prompt
 * flow, the real spinner, and the real frame — only the terminal is a stand-in,
 * because a test runner has no terminal to give.
 */
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

const ESC = '';

export const ENTER = '\r';
export const DOWN = ESC + '[B';
export const UP = ESC + '[A';
export const CTRL_C = '';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeTty({ columns = 80, rows = 24 } = {}) {
  const chunks = [];

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));

  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;

  return { input, output, raw: () => chunks.join('') };
}

/** A pair that is honest about not being a terminal. */
export function pipes() {
  const chunks = [];
  const output = new PassThrough();
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  const input = new PassThrough();
  return { input, output, raw: () => chunks.join('') };
}

/**
 * The redraw stream as a reader sees it: escape sequences removed, blank and
 * repeated lines collapsed. The same reduction the bar transcript was captured
 * with.
 */
export function frames(raw) {
  return stripVTControlCharacters(raw)
    .split(/\r?\n/)
    .map((line) => line.replace(/\r/g, '').trimEnd())
    .filter((line, index, all) => line.trim() !== '' && line !== all[index - 1]);
}

/**
 * The last thing a terminal would be showing, given every byte it was sent.
 *
 * A carriage return puts the cursor back at the start of the line and an erase
 * sequence blanks it, so a line written, wiped and written again is one line on
 * screen and three in the byte stream. Replaying that is the only way to ask
 * what a person would actually be looking at — which is the whole question
 * behind a spinner drawn over the top of something being asked.
 */
export function screen(raw) {
  const rows = [];
  let row = '';
  let index = 0;

  while (index < raw.length) {
    const char = raw[index];

    if (char === ESC) {
      const match = /^\[[0-9;?]*[A-Za-z]/.exec(raw.slice(index));
      if (match !== null) {
        // Erase in line: whatever was drawn on this row is gone.
        if (/\[[0-2]?K$/.test(match[0])) row = '';
        index += match[0].length;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === '\r') {
      row = '';
      index += 1;
      continue;
    }
    if (char === '\n') {
      rows.push(row);
      row = '';
      index += 1;
      continue;
    }
    row += char;
    index += 1;
  }
  rows.push(row);

  return rows.map((line) => line.trimEnd());
}

/** True when the byte stream leaves the cursor visible at the end of it. */
export function cursorVisible(raw) {
  const shown = raw.lastIndexOf(ESC + '[?25h');
  const hidden = raw.lastIndexOf(ESC + '[?25l');
  // Never hidden at all counts as visible: nothing took it away.
  return hidden === -1 || shown > hidden;
}

/**
 * Waits for the prompt to have drawn something before answering it.
 *
 * Keystrokes are only meaningful once the question they answer is on screen, so
 * a driver watches the output rather than guessing with sleeps.
 */
export async function waitFor(io, needle, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    if (stripVTControlCharacters(io.raw()).includes(needle)) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        'timed out waiting for ' + JSON.stringify(needle) + '\n' + frames(io.raw()).join('\n'),
      );
    }
    await sleep(10);
  }
}

/** One keystroke, and a moment for the prompt to redraw after it. */
export async function press(io, key) {
  io.input.write(key);
  await sleep(20);
}
