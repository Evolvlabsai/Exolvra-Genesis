import { join } from 'node:path';

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import { ConfigError } from './exit.js';
import { type ModelChoice, agentModelFault, asAgentModel } from './models.js';
import { PLUGIN_FILES, type PluginSources } from './plugin-dir.js';

/** Programmatic subagent definitions, keyed by agent name. */
export type AgentDefinitions = Record<string, AgentDefinition>;

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

/**
 * Splits a plugin markdown file into its `---` frontmatter fields and its body.
 * Only top-level `key: value` scalars are read; that is all these files carry.
 */
export function splitFrontmatter(markdown: string): Frontmatter {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (match === null) return { fields: {}, body: normalized.trim() };

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z][\w-]*$/.test(key)) continue;
    fields[key] = line.slice(separator + 1).trim();
  }
  return { fields, body: normalized.slice(match[0].length).trim() };
}

/**
 * A fault in one of the loaded files, in the shape every other error here has:
 * the complaint on its own line, and what to do about it indented under it.
 *
 * The file is named twice on purpose — once as the plugin relative path the
 * documentation uses, once as the path on disk it was actually read from. Which
 * of the three candidate directories won is not something the reader can work
 * out from the relative path alone, and it is usually the whole answer.
 */
function malformed(file: string, dir: string, complaint: string, remedy: string): ConfigError {
  return new ConfigError(
    [
      file + ' ' + complaint,
      '  ' + remedy,
      '  read from ' + join(dir, file),
    ].join('\n'),
  );
}

function requireField(
  frontmatter: Frontmatter,
  key: string,
  file: string,
  dir: string,
): string {
  const value = frontmatter.fields[key];
  if (value === undefined || value === '') {
    throw malformed(
      file,
      dir,
      'is missing a "' + key + '" frontmatter field',
      'an agent file declares name and description above its prompt body',
    );
  }
  return value;
}

/**
 * Turns agents/builder.md and agents/critic.md into SDK agent definitions,
 * applying the per-role model family each was asked for.
 *
 * The prompt is the file's body, verbatim. Nothing about how the agents behave
 * is expressed here — only the family the CLI was asked to pin them to.
 */
export function buildAgentDefinitions(
  src: PluginSources,
  models: ModelChoice,
): AgentDefinitions {
  const roles = [
    {
      markdown: src.builderMd,
      file: PLUGIN_FILES.builderMd,
      model: models.builder,
    },
    {
      markdown: src.criticMd,
      file: PLUGIN_FILES.criticMd,
      model: models.critic,
    },
  ];

  const definitions: AgentDefinitions = {};
  for (const role of roles) {
    const parsed = splitFrontmatter(role.markdown);
    const name = requireField(parsed, 'name', role.file, src.dir);
    const description = requireField(parsed, 'description', role.file, src.dir);
    if (parsed.body === '') {
      throw malformed(
        role.file,
        src.dir,
        'has no prompt body below its frontmatter',
        'an agent runs on the prompt below its frontmatter, and this file has none',
      );
    }
    // A family, or nothing. Callers that did not come through the CLI's own
    // flag parsing are held to the same rule as those that did: an id is never
    // collapsed onto the family it belongs to on its way into a definition.
    const model = asAgentModel(role.model);
    if (model === undefined) {
      throw new ConfigError(
        [
          '"' + role.model + '" is not a model family, so ' + name + ' cannot be pinned to it',
          ...agentModelFault(role.model),
        ].join('\n'),
      );
    }
    definitions[name] = { description, prompt: parsed.body, model };
  }
  return definitions;
}

/**
 * Renders the run command's markdown into a prompt, substituting its
 * $ARGUMENTS placeholder with the user's goal or spec path.
 *
 * The replacement is a function, not a string: `String.replaceAll` reads `$&`,
 * `` $` ``, `$'` and `$$` in a replacement *string* as patterns, so a goal
 * containing one of them would reach the agent as something the user never
 * typed — `$&` as the placeholder itself, `` $` `` as the whole preceding body
 * of the file. A function replacement is taken literally, whatever is in it.
 */
export function renderLeadPrompt(runMd: string, args: string): string {
  const { body } = splitFrontmatter(runMd);
  if (body.includes('$ARGUMENTS')) return body.replaceAll('$ARGUMENTS', () => args);
  return body + '\n\n' + args;
}
