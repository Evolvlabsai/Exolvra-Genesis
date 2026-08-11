import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAgentDefinitions, renderLeadPrompt, splitFrontmatter } from '../dist/agents.js';
import { ConfigError, UsageError } from '../dist/exit.js';
import {
  AGENT_MODELS,
  DEFAULT_MODEL_CHOICE,
  MODEL_INHERIT,
  asAgentModel,
  assertAgentModel,
  assertKnownModel,
  canonicalModel,
  isKnownModel,
  listModels,
} from '../dist/models.js';
import { loadPluginSources } from '../dist/plugin-dir.js';

const REAL_SOURCES = loadPluginSources({});

test('listModels leads with inherit and offers current model ids', () => {
  const options = listModels();
  assert.equal(options[0].value, MODEL_INHERIT);
  const values = options.map((option) => option.value);
  for (const expected of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
    assert.ok(values.includes(expected), 'missing ' + expected);
  }
  for (const option of options) {
    assert.ok(option.label.length > 0, 'every option needs a label');
    assert.ok(!/-\d{8}$/.test(option.value), 'model ids must not carry a date suffix');
  }
});

test('the families are exactly what the SDK types a subagent model as', () => {
  // node_modules/@anthropic-ai/claude-agent-sdk .. coreTypes.d.ts types
  // AgentDefinition.model as 'sonnet' | 'opus' | 'haiku' | 'inherit'. This list
  // is that set and nothing else, so nothing offered here can fail to be
  // carried by the field it is written into.
  assert.deepEqual([...AGENT_MODELS].sort(), ['haiku', 'inherit', 'opus', 'sonnet']);
  for (const family of AGENT_MODELS) {
    assert.equal(asAgentModel(family), family);
  }
});

test('asAgentModel names a family and nothing else', () => {
  assert.equal(asAgentModel('inherit'), 'inherit');
  assert.equal(asAgentModel('opus'), 'opus');
  assert.equal(asAgentModel('  SONNET  '), 'sonnet');
  assert.equal(asAgentModel('haiku'), 'haiku');
});

test('a versioned model id is never quietly read as its family', () => {
  // The defect this exists to prevent: two different ids collapsing onto one
  // family would make two different invocations produce byte-identical input
  // to the provider, with nothing anywhere saying so.
  for (const id of listModels().map((model) => model.value)) {
    if (id === MODEL_INHERIT) continue;
    assert.equal(asAgentModel(id), undefined, id + ' was read as a family');
    assert.equal(isKnownModel(id), true, id + ' must still be a model id');
  }
});

test('the family list is exact, not a substring test', () => {
  // "octopus" contains "opus"; a substring test admits it, and the provider is
  // then the first thing to notice — as a lost run rather than a bad flag.
  for (const value of ['octopus', 'opusx', 'my-claude-opus-5', 'sonnet-5', '']) {
    assert.equal(asAgentModel(value), undefined, value + ' must not be accepted');
  }
});

test('a family is not a model id, and an id is not a family', () => {
  // The two vocabularies do not overlap except at "inherit", which means the
  // same thing in both. Help says so; this is the same statement as code.
  for (const family of AGENT_MODELS) {
    assert.equal(
      isKnownModel(family),
      family === MODEL_INHERIT,
      family + ' is on the wrong list',
    );
  }
});

test('assertAgentModel returns the family or raises a usage error', () => {
  assert.equal(assertAgentModel('opus', '--builder-model'), 'opus');
  let error;
  try {
    assertAgentModel('claude-opus-5', '--builder-model', 'usage line');
    assert.fail('expected a UsageError');
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof UsageError);
  assert.match(error.message, /invalid value "claude-opus-5" for --builder-model/);
  assert.equal(error.usage, 'usage line');
});

test('refusing an id says why, and names the family it belongs to', () => {
  const message = (value) => {
    try {
      assertAgentModel(value, '--critic-model');
      return assert.fail('expected a UsageError for ' + value);
    } catch (error) {
      return error.message;
    }
  };

  // An id gets the suggestion, because there is one to make.
  const id = message('claude-haiku-4-5');
  assert.match(id, /pins a subagent to a model family/);
  assert.match(id, /use "haiku"/);
  assert.match(id, /accepted: inherit, opus, sonnet, haiku/);

  // Something that is neither gets the rule without a false suggestion.
  const other = message('gpt-4');
  assert.match(other, /pins a subagent to a model family/);
  assert.ok(!/use "/.test(other), 'no family to suggest, so none is named: ' + other);
});

test('the family rejection names every family and only families', () => {
  let message = '';
  try {
    assertAgentModel('octopus', '--builder-model');
  } catch (error) {
    message = error.message;
  }
  const named = message
    .slice(message.indexOf('accepted:') + 'accepted:'.length)
    .split(/[\s,]+/)
    .filter((word) => word !== '');
  assert.deepEqual(named.sort(), [...AGENT_MODELS].sort());
  for (const value of named) {
    assert.notEqual(asAgentModel(value), undefined, message + ' names ' + value + ' falsely');
  }
});

test('a plausible id this build does not offer is rejected', () => {
  for (const value of ['claude-sonnet-6', 'claude-opus-6', 'claude-opus-5-20260101']) {
    assert.equal(isKnownModel(value), false, value + ' must not be accepted');
  }
});

test('values from other providers are rejected by both vocabularies', () => {
  for (const value of ['gpt-4', 'gemini-pro', '']) {
    assert.equal(asAgentModel(value), undefined, value + ' passed as a family');
    assert.equal(isKnownModel(value), false, value + ' passed as a model id');
  }
  assert.equal(isKnownModel('claude-opus-5'), true);
});

test('a model id is matched loosely and returned in exactly one spelling', () => {
  // The reported defect: the allowlist folded case and trimmed space to decide
  // whether to accept, and then handed on whatever was typed. `INHERIT` passed
  // the check and left as `INHERIT` — a literal request for a model no provider
  // has, and a sentinel this CLI reads as "send nothing" arriving as a name.
  const offered = listModels().map((model) => model.value);
  for (const id of offered) {
    for (const spelling of [id, id.toUpperCase(), '  ' + id + '  ', ' ' + id.toUpperCase()]) {
      assert.equal(canonicalModel(spelling), id, spelling + ' did not canonicalize');
      assert.equal(assertKnownModel(spelling, '--model'), id, spelling + ' left as typed');
    }
  }
  assert.equal(canonicalModel('octopus'), undefined);
  assert.equal(canonicalModel(''), undefined);

  // Whatever comes back is one of the values the help page publishes, always.
  for (const id of offered) {
    assert.ok(offered.includes(canonicalModel(id.toUpperCase())));
  }
});

test('assertKnownModel returns the value or raises a usage error', () => {
  assert.equal(assertKnownModel('claude-opus-5', '--model'), 'claude-opus-5');
  let error;
  try {
    assertKnownModel('gpt-4', '--builder-model', 'usage line');
    assert.fail('expected a UsageError');
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof UsageError);
  assert.match(error.message, /invalid value "gpt-4" for --builder-model/);
  assert.equal(error.usage, 'usage line');
});

test('the rejection message is truthful about what is accepted', () => {
  let message = '';
  try {
    assertKnownModel('octopus', '--model');
  } catch (error) {
    message = error.message;
  }
  // Every value it names is accepted, and every accepted value is named.
  const named = message
    .slice(message.indexOf('accepted:') + 'accepted:'.length)
    .split(/[\s,]+/)
    .filter((word) => word !== '');
  assert.deepEqual(
    named.sort(),
    listModels()
      .map((model) => model.value)
      .sort(),
  );
  for (const value of named) {
    assert.equal(isKnownModel(value), true, message + ' names ' + value + ' falsely');
  }
});

test('splitFrontmatter separates scalar fields from the body', () => {
  const parsed = splitFrontmatter('---\nname: demo\ndescription: a: colon\n---\n\nBody line.\n');
  assert.equal(parsed.fields.name, 'demo');
  assert.equal(parsed.fields.description, 'a: colon');
  assert.equal(parsed.body, 'Body line.');
});

test('splitFrontmatter passes through markdown that has none', () => {
  const parsed = splitFrontmatter('Just a body.\n');
  assert.deepEqual(parsed.fields, {});
  assert.equal(parsed.body, 'Just a body.');
});

test('buildAgentDefinitions applies the per-role family', () => {
  const definitions = buildAgentDefinitions(REAL_SOURCES, {
    lead: 'claude-opus-5',
    builder: 'sonnet',
    critic: 'haiku',
  });
  assert.deepEqual(Object.keys(definitions).sort(), ['gauntlet-builder', 'gauntlet-critic']);
  assert.equal(definitions['gauntlet-builder'].model, 'sonnet');
  assert.equal(definitions['gauntlet-critic'].model, 'haiku');
});

test('buildAgentDefinitions defaults both roles to inherit', () => {
  const definitions = buildAgentDefinitions(REAL_SOURCES, DEFAULT_MODEL_CHOICE);
  assert.equal(definitions['gauntlet-builder'].model, 'inherit');
  assert.equal(definitions['gauntlet-critic'].model, 'inherit');
});

test('the lead model never leaks into the subagent definitions', () => {
  const definitions = buildAgentDefinitions(REAL_SOURCES, {
    lead: 'claude-opus-5',
    builder: MODEL_INHERIT,
    critic: MODEL_INHERIT,
  });
  assert.equal(definitions['gauntlet-builder'].model, 'inherit');
  assert.equal(definitions['gauntlet-critic'].model, 'inherit');
});

test('agent prompts come from the markdown, not from the CLI', () => {
  const definitions = buildAgentDefinitions(REAL_SOURCES, DEFAULT_MODEL_CHOICE);
  const builderBody = splitFrontmatter(REAL_SOURCES.builderMd).body;
  const criticBody = splitFrontmatter(REAL_SOURCES.criticMd).body;
  assert.equal(definitions['gauntlet-builder'].prompt, builderBody);
  assert.equal(definitions['gauntlet-critic'].prompt, criticBody);
  assert.ok(definitions['gauntlet-builder'].description.length > 0);
  assert.ok(definitions['gauntlet-critic'].description.length > 0);
});

test('malformed plugin markdown is a ConfigError', () => {
  assert.throws(
    () =>
      buildAgentDefinitions(
        { ...REAL_SOURCES, builderMd: 'no frontmatter here' },
        DEFAULT_MODEL_CHOICE,
      ),
    ConfigError,
  );
  assert.throws(
    () =>
      buildAgentDefinitions(
        { ...REAL_SOURCES, criticMd: '---\nname: x\ndescription: y\n---\n' },
        DEFAULT_MODEL_CHOICE,
      ),
    ConfigError,
  );
});

test('a value that is not a family reaching the agent builder is a ConfigError', () => {
  assert.throws(
    () => buildAgentDefinitions(REAL_SOURCES, { ...DEFAULT_MODEL_CHOICE, critic: 'gpt-4' }),
    ConfigError,
  );
});

test('a versioned id reaching the agent builder is refused, not collapsed', () => {
  // The same rule as the flag boundary, for callers that never went through it:
  // an id is not silently downgraded on its way into an agent definition.
  for (const id of ['claude-opus-5', 'claude-sonnet-4-6']) {
    let error;
    try {
      buildAgentDefinitions(REAL_SOURCES, { ...DEFAULT_MODEL_CHOICE, builder: id });
      assert.fail(id + ' was accepted for a subagent');
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error instanceof ConfigError, id + ' raised ' + error);
    assert.ok(error.message.includes(id), 'the refusal must quote the value: ' + error.message);
    assert.match(error.message, /pins a subagent to a model family/);
  }
});

test('no two subagent values ever produce the same SDK input', () => {
  // The defect, stated as the property that rules it out: distinct accepted
  // values give distinct definitions, and nothing else is accepted at all.
  const seen = new Map();
  for (const family of AGENT_MODELS) {
    const definitions = buildAgentDefinitions(REAL_SOURCES, {
      ...DEFAULT_MODEL_CHOICE,
      builder: family,
    });
    const sent = definitions['gauntlet-builder'].model;
    assert.equal(seen.has(sent), false, family + ' collapses onto ' + seen.get(sent));
    seen.set(sent, family);
  }
  assert.equal(seen.size, AGENT_MODELS.length);
});

test('renderLeadPrompt substitutes the arguments placeholder', () => {
  const prompt = renderLeadPrompt(REAL_SOURCES.runMd, 'specs/demo.md');
  assert.ok(!prompt.includes('$ARGUMENTS'), 'the placeholder must be substituted');
  assert.ok(prompt.includes('specs/demo.md'));
  assert.ok(!prompt.startsWith('---'), 'frontmatter must be stripped');
});

test('renderLeadPrompt appends the arguments when there is no placeholder', () => {
  assert.equal(renderLeadPrompt('Do the thing.\n', 'a goal'), 'Do the thing.\n\na goal');
});

test('renderLeadPrompt treats the argument as text, not as a replacement pattern', () => {
  // The characters a replacement *string* is read for: $& is the match, $` is
  // everything before it, $' everything after, $$ a single dollar. Substituted
  // as a string, a goal containing any of them arrives as something the user
  // never wrote — and the worst of them, $`, pastes the whole preceding file
  // into the goal.
  const body = 'before\n\n$ARGUMENTS\n\nafter';
  for (const goal of ['[$&]', '[$`]', "[$']", '[$$]', 'a $& b $` c']) {
    assert.equal(
      renderLeadPrompt(body, goal),
      'before\n\n' + goal + '\n\nafter',
      goal + ' was rewritten by the substitution',
    );
  }

  // The same, through the file the CLI really loads.
  const real = renderLeadPrompt(REAL_SOURCES.runMd, '[$&]');
  assert.ok(real.includes('[$&]'), 'the goal did not survive');
  assert.ok(!real.includes('$ARGUMENTS'), '$& put the placeholder back');
});
