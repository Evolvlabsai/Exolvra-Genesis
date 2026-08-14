// Renders real @clack/prompts frames into a transcript without a TTY, by
// swapping process.stdin/stdout for fake TTY streams and feeding keystrokes.
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';

const chunks = [];

const out = new PassThrough();
out.isTTY = true;
out.columns = 80;
out.rows = 24;
out.on('data', (c) => chunks.push(c.toString('utf8')));

const input = new PassThrough();
input.isTTY = true;
input.setRawMode = () => input;

Object.defineProperty(process, 'stdout', { value: out, configurable: true });
Object.defineProperty(process, 'stdin', { value: input, configurable: true });

const p = await import('@clack/prompts');

const DOWN = '[B';
const ENTER = '\r';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = async (k) => { await sleep(120); input.write(k); await sleep(120); };

const drive = async () => {
  // text prompt
  await key('specs/checkout-flow.md');
  await key(ENTER);
  // select: lead model
  await key(DOWN);
  await key(ENTER);
  // select: builder model
  await key(DOWN);
  await key(DOWN);
  await key(ENTER);
  // confirm: auto vs review
  await key(ENTER);
};

const main = async () => {
  p.intro('gauntlet run');

  const driver = drive();

  const goal = await p.text({
    message: 'What are we building?',
    placeholder: 'a goal, or a path to a spec file',
  });

  const lead = await p.select({
    message: 'Lead model',
    options: [
      { value: 'inherit', label: 'inherit', hint: 'use your session default' },
      { value: 'opus', label: 'claude-opus-4-8', hint: 'strongest orchestrator' },
      { value: 'sonnet', label: 'claude-sonnet-4-8' },
    ],
  });

  const builder = await p.select({
    message: 'Builder model',
    options: [
      { value: 'inherit', label: 'inherit' },
      { value: 'opus', label: 'claude-opus-4-8' },
      { value: 'sonnet', label: 'claude-sonnet-4-8', hint: 'where the tokens go' },
    ],
  });

  const auto = await p.confirm({ message: 'Review the bar before the loop starts?' });

  p.note(
    [
      'bar      .gauntlet/bar/ (4 screenshots)',
      'pieces   6 across 3 waves',
      'progress .gauntlet/progress.html',
    ].join('\n'),
    'Run plan',
  );

  const s = p.spinner();
  s.start('Capturing the bar');
  await sleep(300);
  s.stop('Bar captured');

  p.log.success('piece 1/6  round 1  WIN   no gap');
  p.log.warn('piece 2/6  round 1  LOSS  spacing is 4px tighter than the bar');

  p.outro(`Done — goal=${String(goal)} lead=${lead} builder=${builder} review=${auto}`);

  await driver;
};

const timeout = setTimeout(() => { flush('TIMEOUT'); process.exit(1); }, 15000);

const stripAnsi = (s) =>
  s.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/\][^]*/g, '');

function flush(status) {
  const raw = chunks.join('');
  writeFileSync('frames-raw.txt', raw);
  // Collapse the redraw stream into readable frames: clack rewrites lines with
  // cursor moves, so keep only lines that carry content.
  const plain = stripAnsi(raw)
    .split(/\r?\n/)
    .map((l) => l.replace(/\r/g, '').trimEnd())
    .filter((l, i, a) => l.trim() !== '' && l !== a[i - 1]);
  writeFileSync('frames-plain.txt', plain.join('\n') + '\n');
  process.stderr.write(`capture ${status}: ${raw.length} bytes raw, ${plain.length} lines plain\n`);
}

try {
  await main();
  clearTimeout(timeout);
  flush('OK');
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  flush('ERROR');
  process.stderr.write(String(err && err.stack) + '\n');
  process.exit(1);
}
