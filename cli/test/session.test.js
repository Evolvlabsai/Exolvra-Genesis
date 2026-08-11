import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError } from '../dist/exit.js';
import { DEFAULT_MODEL_CHOICE, MODEL_INHERIT } from '../dist/models.js';
import { loadPluginSources } from '../dist/plugin-dir.js';
import { assistantText, createSession, joinText } from '../dist/session.js';

const SOURCES = loadPluginSources({});

/**
 * A stand-in for the Claude Agent SDK. The bar allows exactly this substitution:
 * the SDK is an external provider, everything on the CLI side of it stays real.
 */
function fakeStream(messages) {
  let interrupted = false;
  return {
    async interrupt() {
      interrupted = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        if (interrupted) return;
        yield message;
      }
    },
  };
}

const assistant = (text, sessionId = 'sesn_1') => ({
  type: 'assistant',
  session_id: sessionId,
  message: { content: [{ type: 'text', text }] },
});

const result = (overrides = {}) => ({
  type: 'result',
  subtype: 'success',
  session_id: 'sesn_1',
  num_turns: 3,
  total_cost_usd: 0.42,
  result: 'the plan',
  errors: [],
  ...overrides,
});

function session(messages, extra = {}) {
  const calls = [];
  const options = {
    prompt: 'the lead prompt',
    sources: SOURCES,
    models: DEFAULT_MODEL_CHOICE,
    cwd: process.cwd(),
    transport(params) {
      calls.push(params);
      return fakeStream(messages);
    },
    ...extra,
  };
  return { session: createSession(options), calls };
}

test('the real SDK exports the query entry point the default transport calls', async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  assert.equal(typeof sdk.query, 'function', 'session.ts calls query({ prompt, options })');
});

test('assistantText extracts text blocks and ignores everything else', () => {
  assert.equal(assistantText(assistant('hello')), 'hello');
  assert.equal(assistantText({ type: 'result', subtype: 'success' }), '');
  assert.equal(assistantText({ type: 'assistant', message: {} }), '');
  assert.equal(
    assistantText({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: 'ok' }] },
    }),
    'ok',
  );
});

test('separate text blocks are kept apart instead of run together', () => {
  const message = {
    type: 'assistant',
    session_id: 'sesn_1',
    message: {
      content: [
        { type: 'text', text: 'Let me capture this bar.' },
        { type: 'text', text: 'Now generate the reference outputs' },
      ],
    },
  };
  assert.equal(
    assistantText(message),
    'Let me capture this bar.\n\nNow generate the reference outputs',
  );
});

test('joinText drops empties and separates the rest with a blank line', () => {
  assert.equal(joinText(['a', '', '  ', 'b']), 'a\n\nb');
  assert.equal(joinText([]), '');
  assert.equal(joinText(['  only  ']), 'only');
});

test('text from separate messages is kept apart too', async () => {
  const { session: s } = session([
    assistant('Let me capture this bar.'),
    assistant('Now generate the reference outputs'),
  ]);
  const outcome = await s.start();
  assert.equal(
    outcome.text,
    'Let me capture this bar.\n\nNow generate the reference outputs',
  );
});

test('start drains the stream and reports the final result', async () => {
  const { session: s } = session([assistant('thinking out loud'), result()]);
  const outcome = await s.start();
  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.text, 'the plan');
  assert.equal(outcome.sessionId, 'sesn_1');
  assert.equal(outcome.turns, 3);
  assert.equal(outcome.costUsd, 0.42);
  assert.equal(outcome.error, undefined);
  assert.equal(s.id, 'sesn_1');
});

test('every message is handed to the hooks in order', async () => {
  const seen = [];
  const { session: s } = session([assistant('one'), assistant('two'), result()], {
    hooks: { onMessage: (m) => seen.push(m.type) },
  });
  await s.start();
  assert.deepEqual(seen, ['assistant', 'assistant', 'result']);
});

test('the agent definitions and cwd reach the transport', async () => {
  const { session: s, calls } = session([result()], {
    cwd: process.cwd(),
    models: { lead: 'claude-opus-5', builder: 'sonnet', critic: 'haiku' },
  });
  await s.start();
  assert.equal(calls.length, 1);
  const { prompt, options } = calls[0];
  assert.equal(prompt, 'the lead prompt');
  assert.equal(options.cwd, process.cwd());
  assert.equal(options.model, 'claude-opus-5');
  assert.equal(options.agents['gauntlet-builder'].model, 'sonnet');
  assert.equal(options.agents['gauntlet-critic'].model, 'haiku');
  assert.equal(options.resume, undefined);
});

test('the lead takes a versioned id where a subagent cannot', async () => {
  // The two flags carry different vocabularies because the SDK does: the
  // session option is a model id, and an agent definition's model is a family.
  // A caller that sends an id to a subagent is refused rather than served a
  // request that says something other than what it asked for.
  const { session: exact, calls } = session([result()], {
    models: { lead: 'claude-opus-4-8', builder: 'opus', critic: 'inherit' },
  });
  await exact.start();
  assert.equal(calls[0].options.model, 'claude-opus-4-8');
  assert.equal(calls[0].options.agents['gauntlet-builder'].model, 'opus');

  const { session: collapsed, calls: never } = session([result()], {
    models: { lead: 'inherit', builder: 'claude-opus-4-8', critic: 'inherit' },
  });
  await assert.rejects(() => collapsed.start(), ConfigError);
  assert.equal(never.length, 0, 'the refused value still reached the transport');
});

test('an inherited lead model is left unset rather than sent as a literal', async () => {
  const { session: s, calls } = session([result()]);
  await s.start();
  assert.equal(calls[0].options.model, undefined);
});

test('maxTurns and permissionMode are forwarded', async () => {
  const { session: s, calls } = session([result()], {
    maxTurns: 7,
    permissionMode: 'bypassPermissions',
  });
  await s.start();
  assert.equal(calls[0].options.maxTurns, 7);
  assert.equal(calls[0].options.permissionMode, 'bypassPermissions');
});

test('resume passes the session id through to the transport', async () => {
  const { session: s, calls } = session([result()]);
  const outcome = await s.resume('sesn_prior');
  assert.equal(calls[0].options.resume, 'sesn_prior');
  assert.equal(outcome.status, 'complete');
});

test('hitting the turn limit is a stop, not an error', async () => {
  const { session: s } = session([
    assistant('partial work'),
    result({ subtype: 'error_max_turns', result: undefined, errors: [] }),
  ]);
  const outcome = await s.start();
  assert.equal(outcome.status, 'stopped');
  assert.equal(outcome.reason, 'max-turns');
  assert.equal(outcome.text, 'partial work');
  assert.equal(outcome.error, 'it ran out of agent turns');
});

test('no SDK subtype is ever handed over as the reason a run ended', async () => {
  // Whatever the provider calls it, the user is told what happened in the
  // words this tool uses everywhere else.
  const subtypes = [
    'error_max_turns',
    'error_max_budget_usd',
    'error_during_execution',
    'error_max_structured_output_retries',
  ];
  for (const subtype of subtypes) {
    const { session: s } = session([result({ subtype, result: undefined, errors: [] })]);
    const outcome = await s.start();
    assert.ok(outcome.error.length > 0, subtype + ' produced no reason');
    assert.ok(
      !outcome.error.includes(subtype),
      subtype + ' leaked as the reason: ' + outcome.error,
    );
    assert.match(outcome.error, /^[a-z]/, subtype + ' reads as a code: ' + outcome.error);
  }
});

test('an unrecognised subtype is reported as one, not passed off as prose', async () => {
  const { session: s } = session([
    result({ subtype: 'error_from_a_later_sdk', result: undefined, errors: [] }),
  ]);
  const outcome = await s.start();
  assert.equal(outcome.reason, 'failed');
  assert.match(outcome.error, /^the agent run ended early \(the SDK reported it as /);
});

test('an execution error is reported as an error with its messages', async () => {
  const { session: s } = session([
    result({ subtype: 'error_during_execution', result: undefined, errors: ['boom'] }),
  ]);
  const outcome = await s.start();
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.reason, 'failed');
  assert.equal(outcome.error, 'boom');
});

test('a lead model the CLI never validated is a ConfigError, not an SDK call', async () => {
  let reached = false;
  const s = createSession({
    prompt: 'p',
    sources: SOURCES,
    models: { lead: 'octopus', builder: MODEL_INHERIT, critic: MODEL_INHERIT },
    cwd: process.cwd(),
    transport() {
      reached = true;
      return fakeStream([result()]);
    },
  });
  await assert.rejects(() => s.start(), ConfigError);
  assert.equal(reached, false, 'an unvalidated model reached the transport');
});

test('the lead model reaches the transport canonicalized, or not at all', async () => {
  const sentFor = async (lead) => {
    const { session: s, calls } = session([result()], {
      models: { lead, builder: MODEL_INHERIT, critic: MODEL_INHERIT },
    });
    await s.start();
    return calls[0].options.model;
  };

  assert.equal(await sentFor('CLAUDE-OPUS-5'), 'claude-opus-5');
  assert.equal(await sentFor('  Claude-Sonnet-5  '), 'claude-sonnet-5');
  // The sentinel is this CLI's word, not a provider's: it is never forwarded.
  assert.equal(await sentFor('INHERIT'), undefined);
  assert.equal(await sentFor(MODEL_INHERIT), undefined);
});

test('a fault in the provider itself is not dressed up as an environment', async () => {
  // A missing interpreter is something the user fixes and runs again, so it is
  // a ConfigError. A TypeError out of the entry point is not: no PATH and no
  // credential makes `query is not a function` go away, and answering it with
  // "check that node is on PATH" sends the user to fix what was never broken.
  const withTransport = (transport) =>
    createSession({
      prompt: 'p',
      sources: SOURCES,
      models: DEFAULT_MODEL_CHOICE,
      cwd: process.cwd(),
      transport,
    });

  await assert.rejects(
    () =>
      withTransport(() => {
        throw new Error('Failed to spawn Claude Code process: spawn node ENOENT');
      }).start(),
    ConfigError,
  );

  for (const thrown of [
    new TypeError('query is not a function'),
    new ReferenceError('query is not defined'),
  ]) {
    await assert.rejects(
      () =>
        withTransport(() => {
          throw thrown;
        }).start(),
      (error) => {
        assert.equal(error, thrown, 'the fault was rewritten on its way out');
        assert.ok(!(error instanceof ConfigError), 'a bug was reported as a setup fault');
        return true;
      },
    );
  }
});

test('a fault while consuming the stream leaves as itself, not as a result', async () => {
  // A run that ended is a result; a property read that faulted mid-stream is
  // not one, and reporting it as `the preview did not finish: Cannot read
  // properties of null` hands the user a raw TypeError wearing a verdict.
  const nulls = {
    async interrupt() {},
    async *[Symbol.asyncIterator]() {
      yield null;
    },
  };
  await assert.rejects(
    () =>
      createSession({
        prompt: 'p',
        sources: SOURCES,
        models: DEFAULT_MODEL_CHOICE,
        cwd: process.cwd(),
        transport: () => nulls,
      }).start(),
    TypeError,
  );
});

test('a stream that ends without a result is an error', async () => {
  const { session: s } = session([assistant('half a thought')]);
  const outcome = await s.start();
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.text, 'half a thought');
  assert.equal(outcome.reason, 'no-result');
  assert.match(outcome.error, /ended without a result/);
});

test('a transport that throws before starting is a ConfigError, not a lost run', async () => {
  const s = createSession({
    prompt: 'p',
    sources: SOURCES,
    models: DEFAULT_MODEL_CHOICE,
    cwd: process.cwd(),
    transport() {
      throw new Error('Failed to spawn Claude Code process: spawn node ENOENT');
    },
  });
  await assert.rejects(() => s.start(), (error) => {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError, got ' + error.name);
    assert.match(error.message, /could not start a Claude Agent SDK session/);
    assert.match(error.message, /spawn node ENOENT/);
    return true;
  });
});

test('a stream that throws before its first message is a ConfigError', async () => {
  const s = createSession({
    prompt: 'p',
    sources: SOURCES,
    models: DEFAULT_MODEL_CHOICE,
    cwd: process.cwd(),
    transport() {
      return {
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          throw new Error('spawn node ENOENT');
        },
      };
    },
  });
  await assert.rejects(() => s.start(), ConfigError);
});

test('a stream that throws after its first message is a run that did not finish', async () => {
  // A provider that produced messages and then broke is a result, not a fault
  // nobody classified: the run ended without finishing. Reporting it any other
  // way would put a provider's failure in front of the user as a bug in this
  // CLI, and would leave the text it did produce unaccounted for.
  const s = createSession({
    prompt: 'p',
    sources: SOURCES,
    models: DEFAULT_MODEL_CHOICE,
    cwd: process.cwd(),
    transport() {
      return {
        async interrupt() {},
        async *[Symbol.asyncIterator]() {
          yield assistant('started');
          throw new Error('the provider dropped the stream');
        },
      };
    },
  });

  const result = await s.start();
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'failed');
  assert.match(result.error, /dropped the stream/);
  assert.match(result.text, /started/, 'what the run did produce was thrown away');
});

test('a session killed by a signal is a stopped run, not a broken environment', async () => {
  // The provider's child was terminated. Reporting that as "could not start …
  // check that node is on PATH" sends the user to fix an environment that was
  // never broken, so a named signal is reported as what it is.
  for (const shape of [
    new Error('Claude Code process exited with signal SIGTERM'),
    Object.assign(new Error('process exited'), { signal: 'SIGKILL' }),
  ]) {
    const s = createSession({
      prompt: 'p',
      sources: SOURCES,
      models: DEFAULT_MODEL_CHOICE,
      cwd: process.cwd(),
      transport() {
        throw shape;
      },
    });
    const outcome = await s.start();
    assert.equal(outcome.status, 'stopped', shape.message + ' was not a stop');
    assert.equal(outcome.reason, 'interrupted');
    assert.match(outcome.error, /^it was stopped by SIG/);
    assert.ok(
      !outcome.error.includes('node is on PATH'),
      'a kill was reported as a configuration fault: ' + outcome.error,
    );
  }
});

test('a start failure that names no signal is still a configuration error', async () => {
  const s = createSession({
    prompt: 'p',
    sources: SOURCES,
    models: DEFAULT_MODEL_CHOICE,
    cwd: process.cwd(),
    transport() {
      throw new Error('Failed to spawn Claude Code process: spawn node ENOENT');
    },
  });
  await assert.rejects(() => s.start(), ConfigError);
});

test('a stop signal during a run ends the run rather than the process', async () => {
  // The listener is the real one the session installs; emitting the signal in
  // process is how it gets exercised on every platform.
  let s;
  const built = session([assistant('starting'), assistant('more'), result()], {
    hooks: {
      onMessage(message) {
        if (message.type === 'assistant') process.emit('SIGTERM');
      },
    },
  });
  s = built.session;
  const before = process.listenerCount('SIGTERM');
  const outcome = await s.start();
  assert.equal(outcome.status, 'stopped', 'SIGTERM did not stop the run');
  assert.equal(outcome.reason, 'interrupted');
  assert.equal(
    process.listenerCount('SIGTERM'),
    before,
    'the session left its signal listener behind',
  );
});

test('interrupting mid-stream stops the run', async () => {
  let s;
  const built = session([assistant('starting'), assistant('more'), result()], {
    hooks: {
      onMessage(message) {
        if (message.type === 'assistant') void s.interrupt();
      },
    },
  });
  s = built.session;
  const outcome = await s.start();
  assert.equal(outcome.status, 'stopped');
  assert.match(outcome.error, /interrupted/);
});
