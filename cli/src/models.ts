import { UsageError } from './exit.js';

/**
 * The model each role runs on. `inherit` means "whatever the caller uses".
 *
 * The two vocabularies are not interchangeable, and the fields say which is
 * which: `lead` is a model id, because the SDK's session options carry one;
 * `builder` and `critic` are {@link AgentModel} families, because that is the
 * only thing a subagent can be pinned to.
 */
export interface ModelChoice {
  lead: string;
  builder: string;
  critic: string;
}

/**
 * What a subagent can be pinned to — the whole vocabulary, not a shorthand for
 * the ids below.
 *
 * The Claude Agent SDK types an agent definition's `model` as
 * `'sonnet' | 'opus' | 'haiku' | 'inherit'`, so a versioned id is not something
 * this CLI declines to pass on: it is something the provider has no field to
 * carry. Which version a family runs is settled by the session that spawns the
 * subagent, not here — so `opus` today and `opus` next month are the same
 * request and need not be the same model.
 */
export type AgentModel = 'inherit' | 'opus' | 'sonnet' | 'haiku';

/** Every family, in the order help and rejections list them. */
export const AGENT_MODELS: readonly AgentModel[] = [
  'inherit',
  'opus',
  'sonnet',
  'haiku',
];

export interface ModelOption {
  value: string;
  label: string;
  hint?: string;
  /**
   * The family this id belongs to. Never substituted for the id: it is here so
   * that rejecting an id on a flag that takes a family can name the family the
   * user probably meant, instead of leaving them to guess.
   */
  family: AgentModel;
}

export const MODEL_INHERIT = 'inherit';

export const DEFAULT_MODEL_CHOICE: ModelChoice = {
  lead: MODEL_INHERIT,
  builder: MODEL_INHERIT,
  critic: MODEL_INHERIT,
};

/**
 * Every model id this build accepts for the lead agent, and nothing else.
 *
 * Ids are exact strings — never append a date suffix. Pricing is per million
 * tokens, input/output.
 */
export function listModels(): ModelOption[] {
  return [
    {
      value: MODEL_INHERIT,
      label: 'Inherit',
      hint: 'Use whatever model the calling session runs on',
      family: 'inherit',
    },
    {
      value: 'claude-opus-5',
      label: 'Claude Opus 5',
      hint: 'Strongest on agentic coding and long-horizon work · $5/$25',
      family: 'opus',
    },
    {
      value: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      hint: 'Near-Opus quality, faster and cheaper · $3/$15',
      family: 'sonnet',
    },
    {
      value: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      hint: 'Fastest and most cost-effective · $1/$5',
      family: 'haiku',
    },
    {
      value: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      hint: 'Previous-generation Opus · $5/$25',
      family: 'opus',
    },
    {
      value: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      hint: 'Previous-generation Sonnet · $3/$15',
      family: 'sonnet',
    },
  ];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The id allowlist, as an exact lookup onto the family each id belongs to.
 *
 * A membership test, never a substring test: "octopus" contains "opus" and a
 * plausible-looking id like "claude-sonnet-6" reads like one this build offers.
 * Neither is a model that exists here, so neither is accepted.
 */
const FAMILY_BY_ID = new Map<string, AgentModel>(
  listModels().map((model) => [normalize(model.value), model.family]),
);

/** Normalized spelling → the spelling {@link listModels} publishes. */
const CANONICAL_BY_ID = new Map<string, string>(
  listModels().map((model) => [normalize(model.value), model.value]),
);

/**
 * The id `value` names, spelled the way this build spells it, or undefined when
 * it names none.
 *
 * Matching is done on the normalized form and the *canonical* form is what
 * comes back, never the caller's. Accepting `INHERIT` and then forwarding
 * `INHERIT` would hand the provider a model id no provider has — the sentinel
 * this CLI reads as "send no model at all" would arrive as a literal request
 * for a model named INHERIT, and the run would fail somewhere the user cannot
 * connect to what they typed. Whatever is accepted here leaves here in the one
 * spelling {@link listModels} publishes.
 */
export function canonicalModel(value: string): string | undefined {
  return CANONICAL_BY_ID.get(normalize(value));
}

/** True when `value` names a model id this build offers for the lead agent. */
export function isKnownModel(value: string): boolean {
  return canonicalModel(value) !== undefined;
}

const FAMILIES = new Set<string>(AGENT_MODELS);

/**
 * The family `value` names, or undefined when it names none.
 *
 * Exact, and deliberately not forgiving: an id is not quietly read as the
 * family it belongs to, because `claude-opus-4-8` and `claude-opus-5` would
 * then both arrive at the provider as the same request while the flag that
 * carried them said otherwise.
 */
export function asAgentModel(value: string): AgentModel | undefined {
  const name = normalize(value);
  return FAMILIES.has(name) ? (name as AgentModel) : undefined;
}

/** Wraps a list of accepted values under an `accepted:` label, hanging-indented. */
function wrapAccepted(values: readonly string[], width = 78): string[] {
  const label = '  accepted: ';
  const hang = ' '.repeat(label.length);
  const lines: string[] = [];
  let current = '';
  values.forEach((value, index) => {
    const piece = index === values.length - 1 ? value : value + ',';
    if (current === '') {
      current = label + piece;
    } else if (current.length + 1 + piece.length <= width) {
      current += ' ' + piece;
    } else {
      lines.push(current);
      current = hang + piece;
    }
  });
  if (current !== '') lines.push(current);
  return lines;
}

/** Why a value is not a model id, in the words every refusal of one uses. */
export function modelFault(): string[] {
  return wrapAccepted(listModels().map((model) => model.value));
}

/**
 * Validates a model id and returns it in canonical spelling, or throws the
 * usage error the CLI exits 2 on.
 *
 * The return value is the point as much as the exception is: everything past
 * this boundary sees a spelling from {@link listModels} and never the one that
 * was typed, so what the CLI accepted and what the provider is asked for cannot
 * be two different strings. The message lists exactly what is accepted, because
 * exactly that list is.
 */
export function assertKnownModel(
  value: string,
  flag: string,
  usage?: string,
): string {
  const canonical = canonicalModel(value);
  if (canonical !== undefined) return canonical;
  throw new UsageError(
    [
      'invalid value "' + value + '" for ' + flag + ': not a model this build offers',
      ...modelFault(),
    ].join('\n'),
    usage,
  );
}

/**
 * Why a value is not a family, in the words every refusal of one uses.
 *
 * Shared so the flag boundary and the agent builder cannot drift into saying
 * different things about the same refusal, and so the reason is stated wherever
 * the refusal is: a rejection that only said "not a family" would leave the id
 * looking like an oversight rather than something the provider cannot carry.
 */
export function agentModelFault(value: string): string[] {
  const family = FAMILY_BY_ID.get(normalize(value));
  return [
    '  the Claude Agent SDK pins a subagent to a model family rather than to a',
    '  version, so only a family is accepted here; --model takes the model ids',
    ...(family === undefined || family === MODEL_INHERIT
      ? []
      : ['  use "' + family + '", the family ' + normalize(value) + ' belongs to']),
    ...wrapAccepted(AGENT_MODELS),
  ];
}

/**
 * Validates a model family, or throws the usage error the CLI exits 2 on.
 *
 * The refusal is the point: an id that reached the provider as its family would
 * have made two different flag values produce byte-identical input, with
 * nothing on the terminal to say so.
 */
export function assertAgentModel(
  value: string,
  flag: string,
  usage?: string,
): AgentModel {
  const family = asAgentModel(value);
  if (family !== undefined) return family;
  throw new UsageError(
    [
      'invalid value "' + value + '" for ' + flag + ': not a model family',
      ...agentModelFault(value),
    ].join('\n'),
    usage,
  );
}
