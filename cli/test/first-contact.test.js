import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, exitCodeFor } from '../dist/exit.js';
import { DEFAULT_MODEL_CHOICE, modelResolutionError } from '../dist/models.js';
import { loadPluginSources } from '../dist/plugin-dir.js';
import { ExecutionPreflightError } from '../dist/preflight.js';
import { createSession, preflightExecution } from '../dist/session.js';
import { createSandbox, PACKAGE_ROOT } from './run-cli.js';
import { PREFLIGHT_FAKE } from './preflight-fake.js';
import { askConfirm } from '../dist/prompts.js';
import { fakeTty, press, waitFor, ENTER } from './tty.js';

const sources = loadPluginSources({});
const done = (extra = {}) => ({ type: 'result', subtype: 'success', session_id: 'probe', num_turns: 1, total_cost_usd: 0.012,
  usage: { input_tokens: 51, output_tokens: 12 }, permission_denials: [], errors: [], result: 'done', ...extra });
const stream = (messages) => ({ async interrupt() {}, async *[Symbol.asyncIterator]() { yield* messages; } });

function probeTransport(outcomes = ['allowed'], calls = []) {
  return ({ prompt, options }) => {
    calls.push({ prompt, options });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    const command = prompt.split('\n').at(-1);
    const marker = command.match(/'(genesis-preflight-[^']+)'$/)[1];
    const use = { type: 'assistant', session_id: 'probe', message: { content: [
      { type: 'tool_use', name: 'Bash', id: 'command-1', input: { command } },
    ] } };
    const response = { type: 'user', session_id: 'probe', message: { content: [
      { type: 'tool_result', tool_use_id: outcome === 'unmatched' ? 'different' : 'command-1',
        is_error: outcome === 'denied', content: outcome === 'denied' ? 'Permission denied' : marker + '\n' },
    ] } };
    if (outcome === 'prose') return stream([{ type: 'assistant', message: { content: [{ type: 'text', text: 'Bash works: ' + marker }] } }, done()]);
    if (outcome === 'truncated') return stream([use, response]);
    if (outcome === 'interrupted') return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() { yield use; yield response; process.emit('SIGINT'); yield done(); },
    };
    return stream([use, response, done(outcome === 'stopped' ? { subtype: 'error_max_turns', result: undefined } : {})]);
  };
}

const options = (extra = {}) => ({ cwd: process.cwd(), sources, models: DEFAULT_MODEL_CHOICE,
  permissionMode: 'bypassPermissions', isTTY: false, env: {}, ...extra });

function installedSandbox() {
  const sandbox = createSandbox();
  for (const entry of readdirSync(join(PACKAGE_ROOT, 'node_modules'))) {
    if (entry === '@anthropic-ai' || entry.startsWith('.')) continue;
    symlinkSync(join(PACKAGE_ROOT, 'node_modules', entry), join(sandbox.root, 'node_modules', entry), 'junction');
  }
  return sandbox;
}

test('the execution probe requires actual matching Bash results and accounts for its cost', async () => {
  const calls = [];
  const receipt = await preflightExecution(options({ transport: probeTransport(['allowed'], calls) }));
  assert.equal(receipt.attempts[0].outcome, 'allowed');
  assert.equal(receipt.costUsd, 0.012);
  assert.equal(receipt.inputTokens, 51);
  assert.equal(receipt.outputTokens, 12);
  assert.deepEqual(calls[0].options.tools, ['Bash']);
  assert.deepEqual(calls[0].options.settingSources, ['project']);
  assert.equal(calls[0].options.permissionMode, 'bypassPermissions');
  assert.equal(calls[0].options.maxTurns, 2);
  assert.equal(calls[0].options.maxBudgetUsd, 0.1);
  assert.equal(calls[0].options.agents, undefined);
  assert.equal(calls[0].options.allowDangerouslySkipPermissions, true);
});

test('the probe hook denies mutations and repeats without granting the no-op extra permission', async () => {
  const calls = [];
  await preflightExecution(options({ permissionMode: 'default', transport: probeTransport(['allowed'], calls) }));
  const hook = calls[0].options.hooks.PreToolUse[0].hooks[0];
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: calls[0].prompt.split('\n').at(-1) } };
  assert.equal((await hook({ ...input, tool_input: { ...input.tool_input, dangerouslyDisableSandbox: true } })).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await hook({ ...input, tool_input: { command: 'touch unwanted' } })).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await hook(input), {});
  assert.equal((await hook(input)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await hook({ ...input, tool_input: { command: 'touch unwanted' } })).hookSpecificOutput.permissionDecision, 'deny');
});

for (const outcome of ['prose', 'unmatched', 'stopped']) {
  test('the probe refuses ' + outcome + ' evidence before a lead can start', async () => {
    await assert.rejects(preflightExecution(options({ transport: probeTransport([outcome]) })), (error) => {
      assert.ok(error instanceof ExecutionPreflightError);
      assert.equal(exitCodeFor(error), 2);
      assert.equal(error.preflight.costUsd, 0.012);
      assert.equal(error.preflight.attempts[0].outcome, 'unavailable');
      return true;
    });
  });
}

test('headless denial never prompts and retains the probe receipt', async () => {
  let questions = 0;
  await assert.rejects(preflightExecution(options({ permissionMode: 'acceptEdits', transport: probeTransport(['denied']),
    confirmBypass: async () => { questions += 1; return true; },
  })), (error) => {
    assert.equal(error.message, [
      'the session denied command execution in acceptEdits mode',
      '  the SDK denied the Bash command under the effective session permissions',
      '  reported probe spend: $0.012000; tokens: 51 input, 12 output',
      '  an unattended build must execute its verification commands',
      '  retry with --permission-mode bypassPermissions',
      '  usage: exolvra-genesis <run | resume | work> [arguments] --permission-mode bypassPermissions',
    ].join('\n'));
    assert.equal(error.preflight.costUsd, 0.012);
    return true;
  });
  assert.equal(questions, 0);
});

test('TTY consent retries exactly once with the remaining budget and records both modes', async () => {
  let questions = 0;
  const calls = [];
  const receipt = await preflightExecution(options({ permissionMode: 'default', isTTY: true,
    transport: probeTransport(['denied', 'allowed'], calls),
    confirmBypass: async () => { questions += 1; return true; }, maxBudgetUsd: 0.04,
  }));
  assert.equal(questions, 1);
  assert.deepEqual(receipt.attempts.map((a) => a.mode), ['default', 'bypassPermissions']);
  assert.equal(calls[1].options.maxBudgetUsd, 0.04 - 0.012);
  assert.equal(receipt.costUsd, 0.024);
});

test('TTY refusal never retries and does not persist a permission choice', async () => {
  const calls = [];
  await assert.rejects(preflightExecution(options({ permissionMode: 'default', isTTY: true,
    transport: probeTransport(['denied'], calls), confirmBypass: async () => false,
  })), ExecutionPreflightError);
  assert.equal(calls.length, 1);
});

for (const answer of [false, true]) {
  test('the real TTY confirmation accepts a ' + (answer ? 'yes' : 'no') + ' keystroke', async () => {
    const io = fakeTty();
    const calls = [];
    const pending = preflightExecution(options({ permissionMode: 'default', isTTY: true,
      transport: probeTransport(['denied', 'allowed'], calls),
      confirmBypass: () => askConfirm('Continue this run with bypassPermissions?', io, { initial: false }),
    })).then((value) => ({ value }), (error) => ({ error }));
    await waitFor(io, 'Continue this run with bypassPermissions?');
    await press(io, answer ? 'y' : 'n');
    await press(io, ENTER);
    const settled = await pending;
    assert.equal(calls.length, answer ? 2 : 1);
    if (answer) assert.equal(settled.value.permissionMode, 'bypassPermissions');
    else assert.ok(settled.error instanceof ExecutionPreflightError);
    io.input.destroy();
    io.output.destroy();
  });
}

test('an exhausted probe budget makes no SDK request', async () => {
  const calls = [];
  await assert.rejects(preflightExecution(options({ maxBudgetUsd: 0, transport: probeTransport(['allowed'], calls) })), /no remaining cost budget/);
  assert.equal(calls.length, 0);
});

for (const outcome of ['truncated', 'interrupted']) {
  test('an ' + outcome + ' probe never retries or offers to continue', async () => {
    let questions = 0;
    const calls = [];
    await assert.rejects(preflightExecution(options({ permissionMode: 'default', isTTY: true,
      transport: probeTransport([outcome], calls), confirmBypass: async () => { questions += 1; return true; },
    })), (error) => {
      assert.ok(error instanceof ExecutionPreflightError);
      if (outcome === 'truncated') assert.match(error.message, /final usage unavailable/);
      else assert.equal(error.preflight.attempts[0].interrupted, true);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(questions, 0);
  });
}

const stale = 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: stale-model"}}';

test('a probe model error preserves reported spend in its house-shaped error', async () => {
  await assert.rejects(preflightExecution(options({ transport: () => stream([done({ result: stale })]) })), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.preflight.costUsd, 0.012);
    assert.match(error.message, /reported probe spend: \$0\.012000; tokens: 51 input, 12 output/);
    assert.doesNotMatch(error.message, /not_found_error/);
    return true;
  });
});

test('model failures name inherited, flag and environment sources with no JSON or secrets', () => {
  for (const [request, origin] of [
    [{ lead: 'inherit', env: {} }, 'your saved Claude default'],
    [{ lead: 'claude-opus-5', env: {} }, '--model'],
    [{ lead: 'inherit', env: { ANTHROPIC_MODEL: 'stale-model' } }, 'ANTHROPIC_MODEL environment variable'],
  ]) {
    const fault = modelResolutionError(stale, request);
    assert.ok(fault instanceof ConfigError);
    assert.ok(fault.message.includes(origin));
    assert.match(fault.message, /\n  provider: model: stale-model\n/);
    assert.doesNotMatch(fault.message, /\{|not_found_error/);
    assert.match(fault.message, /--model <id>/);
  }
  assert.equal(modelResolutionError('API Error: 503 overloaded', { lead: 'inherit' }), undefined);
});

test('model errors never expose API text to hooks, while result billing remains observable', async () => {
  for (const message of [
    { type: 'assistant', error: 'invalid_request', message: { content: [{ type: 'text', text: stale }] } },
    done({ result: stale }),
    done({ subtype: 'error_during_execution', result: undefined, errors: [stale] }),
  ]) {
    const seen = [];
    const session = createSession({ ...options(), prompt: 'plan', transport: () => stream([message]), hooks: { onMessage: (m) => seen.push(m) } });
    await assert.rejects(session.start(), ConfigError);
    if (message.type === 'assistant') assert.deepEqual(seen, []);
    else {
      assert.equal(seen.length, 1);
      assert.equal(seen[0].total_cost_usd, message.total_cost_usd);
      assert.doesNotMatch(JSON.stringify(seen), /API Error|not_found_error|stale-model/);
    }
  }
});

test('a packaged binary refuses headless denied execution before writing any run artifacts', () => {
  const sandbox = installedSandbox();
  try {
    const cwd = join(sandbox.root, 'work');
    mkdirSync(cwd);
    const result = sandbox.run(['run', 'make a verified script', '--auto', '--permission-mode', 'acceptEdits', '--no-config'],
      { cwd, env: { GENESIS_TEST_PREFLIGHT_OUTCOME: 'denied', ANTHROPIC_MODEL: undefined } });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^the session denied command execution in acceptEdits mode\n/);
    assert.deepEqual(readdirSync(cwd), []);
  } finally { sandbox.cleanup(); }
});

test('a packaged plan process renders a stale inherited model as an invocation error', () => {
  const sandbox = installedSandbox();
  try {
    const cwd = join(sandbox.root, 'work');
    mkdirSync(cwd);
    const sdk = `export function query({prompt, options}) { ${PREFLIGHT_FAKE}
      return {async interrupt(){}, async *[Symbol.asyncIterator](){
        yield {type:'assistant', error:'invalid_request', message:{content:[{type:'text',text:${JSON.stringify(stale)}}]}};
      }};
    }`;
    writeFileSync(join(sandbox.root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'index.js'), sdk);
    const result = sandbox.run(['plan', 'make a verified script', '--verbose'], { cwd, env: { ANTHROPIC_MODEL: undefined } });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, modelResolutionError(stale, { lead: 'inherit', env: {} }).message + '\n\n');
    assert.equal(existsSync(join(cwd, '.exolvra-genesis')), false);
  } finally { sandbox.cleanup(); }
});
