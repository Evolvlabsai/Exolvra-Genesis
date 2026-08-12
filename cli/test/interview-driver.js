/**
 * Runs `gauntlet interview` with a terminal that is not one.
 *
 * An interview is TTY-only and a spawned process is given pipes, so the command
 * is driven here, inside a process whose `node_modules` holds the scripted
 * transport in place of the Claude Agent SDK. Everything between those two —
 * the flag boundary, the plugin loader, the prompt flow, the handoff and the
 * exit code — is the shipped `dist/`.
 *
 * Invoked as: node interview-driver.js <plan.json>, where the plan names the
 * argv, the answers to type, and where to write what the terminal was shown.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { stripVTControlCharacters } from 'node:util';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const chunks = [];
const output = new PassThrough();
output.isTTY = true;
output.columns = plan.columns ?? 80;
output.rows = 24;
output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));

const input = new PassThrough();
input.isTTY = true;
input.setRawMode = () => input;

const raw = () => chunks.join('');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the prompt to have drawn something before answering it. */
async function waitFor(needle, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    if (stripVTControlCharacters(raw()).includes(needle)) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for ' + JSON.stringify(needle));
    }
    await sleep(10);
  }
}

Object.defineProperty(process, 'stdin', { value: input, configurable: true });

// The driver sits at the sandbox root, beside the built dist/ it drives.
const { interviewCommand } = await import(
  new URL('./dist/commands/interview.js', import.meta.url).href
);

const errors = [];
const ctx = {
  program: 'gauntlet',
  cwd: plan.cwd,
  env: process.env,
  stdout: output,
  stderr: { write: (chunk) => errors.push(String(chunk)) },
  isTTY: true,
  isErrTTY: true,
  width: plan.columns ?? 80,
};

// Types each answer once the prompt asking for it is on screen.
const typing = (async () => {
  for (const answer of plan.answers ?? []) {
    await waitFor('Your answer');
    // A fresh prompt each time: wait for the previous answer to have been taken.
    await sleep(60);
    input.write(answer);
    await waitFor(answer);
    input.write('\r');
    await sleep(60);
  }
  if (plan.cancel === true) {
    await waitFor('Your answer');
    await sleep(60);
    input.write(String.fromCharCode(3));
  }
})();

let code;
let failure;
try {
  code = await interviewCommand.run(plan.argv, ctx);
} catch (error) {
  failure = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
  code = null;
}
await typing.catch(() => undefined);

writeFileSync(
  plan.out,
  JSON.stringify({ code, failure, raw: raw(), errors }, null, 2),
  'utf8',
);
process.exit(0);
