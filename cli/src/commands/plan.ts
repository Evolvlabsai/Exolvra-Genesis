import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { renderLeadPrompt } from '../agents.js';
import { ConfigError, EXIT } from '../exit.js';
import {
  inputAsArgument,
  inputAsTyped,
  pathKind,
  type ResolvedInput,
} from '../input.js';
import {
  AGENT_MODELS,
  DEFAULT_MODEL_CHOICE,
  type AgentModel,
  type ModelChoice,
  assertAgentModel,
  listModels,
} from '../models.js';
import { PLUGIN_DIR_ENV, loadPluginSources } from '../plugin-dir.js';
import {
  type ArgumentSpec,
  type BooleanFlagSpec,
  type Command,
  type Ctx,
  type EnvSpec,
  type FlagSpec,
  type ValueFlagSpec,
  type ValueType,
  choiceValue,
  countValue,
  directoryValue,
  inputValue,
  modelValue,
  parseInvocation,
  registerCommand,
} from '../registry.js';
import {
  type SdkMessage,
  assistantText,
  createSession,
  joinText,
} from '../session.js';
import {
  BODY_INDENT,
  PROGRAM,
  type Viewport,
  printable,
  printableBlock,
  renderCommandHelp,
  renderMarkdown,
  renderSection,
  renderTable,
  plainProse,
  startProgress,
  truncate,
  wrapList,
  wrapText,
} from '../usage.js';

const DEFAULT_MAX_TURNS = 40;

/** What the progress line says while the agent works. */
const PROGRESS_MESSAGE = 'Previewing the plan';

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;

/* -------------------------------------------------------------------------- */
/* Flags — each one declares the value type that validates it                  */
/* -------------------------------------------------------------------------- */

/**
 * A model family, which is the only thing the Claude Agent SDK can pin a
 * subagent to.
 *
 * Its rejection probe is a real model id this build offers for `--model`: the
 * one value that has to be accepted there and refused here. The gate suite
 * drives every declared probe through a real process, so the two vocabularies
 * are proven to be different rather than merely named differently.
 */
const familyValue: ValueType<AgentModel> = {
  arg: 'family',
  choices: AGENT_MODELS,
  invalid: 'claude-opus-5',
  parse: (raw, ctx) => assertAgentModel(raw, ctx.flag, ctx.usage),
};

const modelFlag: ValueFlagSpec<string> = {
  long: 'model',
  short: 'm',
  value: modelValue,
  summary: 'Model id for the lead agent',
  default: 'inherit',
};

const builderModelFlag: ValueFlagSpec<AgentModel> = {
  long: 'builder-model',
  value: familyValue,
  summary: 'Model family for builder subagents',
  default: 'inherit',
};

const criticModelFlag: ValueFlagSpec<AgentModel> = {
  long: 'critic-model',
  value: familyValue,
  summary: 'Model family for critic subagents',
  default: 'inherit',
};

const directoryFlag: ValueFlagSpec<string> = {
  long: 'directory',
  short: 'C',
  value: directoryValue,
  summary: 'Run in dir instead of the current directory',
};

const pluginDirFlag: ValueFlagSpec<string> = {
  long: 'plugin-dir',
  value: directoryValue,
  summary: 'Read the plugin markdown from dir, overriding ' + PLUGIN_DIR_ENV,
};

const maxTurnsFlag: ValueFlagSpec<number> = {
  long: 'max-turns',
  value: countValue,
  summary: 'Stop the preview after int agent turns',
  default: DEFAULT_MAX_TURNS,
};

const permissionModeFlag: ValueFlagSpec<(typeof PERMISSION_MODES)[number]> = {
  long: 'permission-mode',
  value: choiceValue('mode', PERMISSION_MODES),
  summary: 'How the preview may use tools',
  default: 'acceptEdits',
};

const verboseFlag: BooleanFlagSpec = {
  long: 'verbose',
  short: 'v',
  summary: 'Stream the agent transcript instead of the final plan alone',
};

const forceFlag: BooleanFlagSpec = {
  long: 'force',
  summary: 'Capture over a bar an earlier run left in the directory',
};

const flags: FlagSpec[] = [
  modelFlag,
  builderModelFlag,
  criticModelFlag,
  directoryFlag,
  forceFlag,
  pluginDirFlag,
  maxTurnsFlag,
  permissionModeFlag,
  verboseFlag,
];

const planArgument: ArgumentSpec<ResolvedInput> = {
  name: 'goal-or-spec-path',
  value: inputValue,
};

const pluginDirEnv: EnvSpec<string> = {
  name: PLUGIN_DIR_ENV,
  value: directoryValue,
  overriddenBy: pluginDirFlag,
};

/** The fence tag the preview payload is carried in. */
const PAYLOAD_TAG = 'exolvra-genesis-plan';

/**
 * Scopes the loaded command markdown down to a preview, and says what shape
 * the answer has to arrive in.
 *
 * Two separate things, deliberately: the steps to run are named by number and
 * stay in the plugin markdown, where they are the single source of truth; the
 * rest is about output shape only, because this CLI owns the frame and the
 * agent supplies only the content that goes inside it.
 */
const PREVIEW_DIRECTIVE = [
  '---',
  '',
  'Preview mode. Execute only Steps 0, 1, and 2 above, then stop and end your',
  'turn. Do not execute any later step, and do not write .exolvra-genesis/state.json.',
  '',
  'Output shape. Your answer is piped to a terminal, not to a chat window, and',
  'this CLI lays it out. End your turn with exactly one fenced block tagged',
  PAYLOAD_TAG + ', containing nothing but JSON in this shape:',
  '',
  '```' + PAYLOAD_TAG,
  '{',
  '  "bar": "<one sentence>",',
  '  "comparison": "<one sentence>",',
  '  "artifacts": [{ "path": "<path>", "detail": "<one line>" }],',
  '  "specs": [{',
  '    "id": "<short id>", "title": "<one line>", "covers": "<or empty>",',
  '    "files": "<comma separated>", "verify": "<one command>"',
  '  }]',
  '}',
  '```',
  '',
  'Every value is plain text on one line: no markdown, no emphasis, no',
  'headings, no tables, no bullet characters. Write nothing after the closing',
  'fence, and nothing the reader of a piped transcript could not act on.',
  '',
  'The block is the answer, not a summary of it: "bar" and at least one entry',
  'of "specs" are required, and every entry needs an id, a title, the files it',
  'owns, and the command that verifies it. Only "covers" may be empty. An',
  'answer without the block is reported as a run that produced no plan, so if',
  'you cannot produce one, say why in one short paragraph and end your turn.',
].join('\n');

const planCommand: Command = {
  name: 'plan',
  summary: 'Preview how a run would be decomposed, without building anything',
  usage: PROGRAM + ' plan <goal-or-spec-path> [flags]',
  group: 'core',
  description: [
    'Preview how a run would be decomposed, without building anything.',
    'plan executes Steps 0 through 2 of the commands/run.md it loads from disk and then\nstops, so it costs a fraction of a full run and edits none of your files.',
    'It is not read-only, though: picking a bar means capturing it, so a preview writes\nunder .exolvra-genesis/ in the directory it runs in, exactly where a full run would. If a\nbar from an earlier run is already there, plan stops instead of writing over it —\nrun elsewhere with --directory, or pass --force to capture over it.',
    'A path to an existing file is read as a spec and becomes the source of truth for\nthe preview; failing that, a bare name matching one of this repository\'s named\ngoals previews that goal; failing both, the argument is a one-line goal, including\na path that does not exist. Nothing is inferred from the shape of the text, and an\nargument that is both a file and a goal is refused rather than picked between. The\norder is set out in full by `exolvra-genesis goals --help`.',
    '--model sets the lead agent, by model id. --builder-model and --critic-model\nset the family the subagents run on: the Claude Agent SDK pins a subagent to a\nmodel family rather than to a version, so those two take a family and refuse an\nid rather than reading it as the family it belongs to. A role left unset inherits\nthe model of the session that spawns it; both lists are under MODELS below.',
    'The plugin markdown is read from disk at runtime and never restated by this CLI,\nso the two can never drift. See `exolvra-genesis help environment` for how its location\nis resolved.',
  ],
  flags,
  argument: planArgument,
  env: [pluginDirEnv],
  cwdFlag: directoryFlag,
  sections: [
    {
      title: 'MODELS',
      lines: [
        '  --model takes a model id:',
        '',
        ...wrapList(
          listModels().map((model) => model.value),
          4,
        ),
        '',
        '  --builder-model and --critic-model take a model family:',
        '',
        ...wrapList([...AGENT_MODELS], 4),
        '',
        ...wrapText(
          'A family is all the Claude Agent SDK can pin a subagent to, and it runs ' +
            'on whichever version the session that spawns the subagent resolves it ' +
            'to. A versioned id is refused there rather than read as its family, so ' +
            'no two models ever reach the provider as one request.',
          78,
          2,
        ),
        '',
        ...wrapText(
          'Every value above is matched without regard to case or surrounding ' +
            'space and is forwarded in the spelling shown here, so what the ' +
            'provider is asked for is always one of these words and never the one ' +
            'that happened to be typed.',
          78,
          2,
        ),
      ],
    },
  ],
  examples: [
    PROGRAM + ' plan specs/checkout.md',
    PROGRAM + ' plan "a CLI whose help output is indistinguishable from gh"',
    PROGRAM + ' plan --model claude-opus-5 --critic-model sonnet specs/api.md',
  ],
  run: runPlan,
};

registerCommand(planCommand);

export { planCommand };

/* -------------------------------------------------------------------------- */
/* The preview payload, and the frame this CLI puts around it                  */
/* -------------------------------------------------------------------------- */

/** One entry of the captured bar, as the preview reports it. */
export interface PlanArtifact {
  path: string;
  detail: string;
}

/** One piece of the decomposition, as the preview reports it. */
export interface PlanSpec {
  id: string;
  title: string;
  covers: string;
  files: string;
  verify: string;
}

/** The content of a preview. The frame around it is this file's business. */
export interface PlanPayload {
  bar: string;
  comparison: string;
  artifacts: PlanArtifact[];
  specs: PlanSpec[];
}

/* -------------------------------------------------------------------------- */
/* The answer boundary: what comes back from an agent is untrusted input too   */
/* -------------------------------------------------------------------------- */

/**
 * Every way an answer can fail to be a plan. Each one is reported by name, so
 * a preview that produced nothing says which nothing it produced.
 */
export type PlanFaultCode =
  | 'no-answer'
  | 'no-plan'
  | 'cut-off'
  | 'unreadable'
  | 'not-an-object'
  | 'wrong-type'
  | 'no-specs'
  | 'missing-fields';

export interface PlanFault {
  code: PlanFaultCode;
  /** One line, in this tool's own words: what was missing. */
  message: string;
  /** Lines printed indented under it, the way every other error here is. */
  detail: string[];
}

/**
 * What one answer turned out to be.
 *
 * `rest` is the answer with the blocks that were read for a plan taken out, so
 * a caller can show what the agent said without ever showing raw JSON.
 * `repairs` names each recovery that was applied, so nothing is repaired
 * silently.
 */
export type PlanReading =
  | { ok: true; payload: PlanPayload; rest: string; repairs: string[] }
  | { ok: false; fault: PlanFault; rest: string; repairs: string[] };

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)/;
const FENCE_CLOSE = /^(`+|~+)$/;

interface Fence {
  /** The info string on the opening fence, lowercased. */
  tag: string;
  body: string;
  /** Line range the block covers, both fences included. */
  from: number;
  to: number;
  /** False when the answer ended before the closing fence arrived. */
  closed: boolean;
}

function fences(lines: readonly string[]): Fence[] {
  const out: Fence[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = (lines[i] as string).match(FENCE_OPEN);
    if (open === null) {
      i += 1;
      continue;
    }
    const marker = open[1] as string;
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j += 1) {
      const line = (lines[j] as string).trim();
      if (FENCE_CLOSE.test(line) && line.startsWith(marker)) {
        closed = true;
        break;
      }
      body.push(lines[j] as string);
    }
    out.push({
      tag: (open[2] ?? '').toLowerCase(),
      body: body.join('\n'),
      from: i,
      to: closed ? j : lines.length - 1,
      closed,
    });
    i = j + 1;
  }
  return out;
}

/** Where a payload was found, which is also how far it was from being asked for. */
type CandidateKind = 'tagged' | 'mislabeled' | 'unfenced';

interface Candidate extends Fence {
  kind: CandidateKind;
}

/**
 * The first balanced `{...}` in `source`, or undefined when none closes.
 *
 * Quote-aware, so a brace inside a string is content. Used both to cut a
 * payload out of the text an agent wrapped around it and to tell a block that
 * was cut off mid-object from one that merely holds something else.
 */
function firstObject(source: string): string | undefined {
  const start = source.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return undefined;
}

/** A payload written with no fence around it at all. */
function unfenced(lines: readonly string[], blocks: readonly Fence[]): Candidate | undefined {
  const fenced = (index: number): boolean =>
    blocks.some((block) => index >= block.from && index <= block.to);

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced(i)) continue;
    if ((lines[i] as string).trim().startsWith('{')) {
      start = i;
      break;
    }
  }
  if (start === -1) return undefined;

  const body = lines.slice(start).join('\n');
  const object = firstObject(body);
  const to =
    object === undefined
      ? lines.length - 1
      : start + object.split('\n').length - 1;
  return {
    kind: 'unfenced',
    tag: '',
    body: object ?? body,
    from: start,
    to,
    closed: object !== undefined,
  };
}

/**
 * Every block in an answer that could be carrying the plan.
 *
 * The tag that was asked for is one of them, not the only one: a block tagged
 * `json`, tagged nothing, or no block at all are the ways a model spells the
 * same intent, and each is read rather than dropped on the floor.
 */
function candidates(lines: readonly string[]): Candidate[] {
  const blocks = fences(lines);
  const found: Candidate[] = [];
  for (const block of blocks) {
    if (block.tag === PAYLOAD_TAG) found.push({ ...block, kind: 'tagged' });
    else if (block.body.trim().startsWith('{')) {
      found.push({ ...block, kind: 'mislabeled' });
    }
  }
  if (found.length > 0) return found;
  const bare = unfenced(lines, blocks);
  return bare === undefined ? [] : [bare];
}

/**
 * Line endings, as one kind.
 *
 * What an agent sends is not this CLI's to choose: the provider may deliver
 * CRLF, and a reader that only knows LF sees a file with no line breaks in the
 * places it counts them. Every function here that splits on lines or on blank
 * lines goes through this first, so a report reads the same whichever the agent
 * happened to write.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Removes every block that was read for a plan, so no raw JSON is ever shown. */
export function withoutPlanBlocks(text: string): string {
  const lines = normalizeEol(text).split('\n');
  const drop = new Set<number>();
  for (const candidate of candidates(lines)) {
    for (let i = candidate.from; i <= candidate.to; i += 1) drop.add(i);
  }
  return lines
    .filter((_line, index) => !drop.has(index))
    .join('\n')
    .trim();
}

const REPAIR_COMMENTS = 'comments in the plan block were dropped before it was read';
const REPAIR_TRAILING = 'trailing commas in the plan block were dropped before it was read';
const REPAIR_SURROUNDING = 'text around the plan inside the block was ignored';

/** The next character that is neither whitespace nor a comment. */
function nextMeaningful(source: string, from: number): number {
  let i = from;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Drops the two things a model writes into JSON that JSON does not have:
 * comments, and a comma before the bracket that closes the list it was in.
 *
 * String-aware, so a `//` inside a URL and a comma inside a sentence are
 * content and survive. Each change is named, because a repair nobody can see
 * is indistinguishable from a parser that quietly accepts anything.
 */
function relax(source: string): { text: string; repairs: string[] } {
  const repairs = new Set<string>();
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      repairs.add(REPAIR_COMMENTS);
      out += ' ';
      i = nextMeaningful(source, i) - 1;
      continue;
    }
    if (ch === ',') {
      const next = source[nextMeaningful(source, i + 1)];
      if (next === '}' || next === ']') {
        repairs.add(REPAIR_TRAILING);
        continue;
      }
    }
    out += ch;
  }
  return { text: out, repairs: [...repairs] };
}

type JsonReading =
  | { ok: true; value: unknown; repairs: string[] }
  | { ok: false; complaint: string };

/**
 * Reads one block as JSON, repairing what can be repaired deliberately and
 * reporting the parser's own complaint when nothing can.
 */
function readJson(body: string): JsonReading {
  const text = body.trim();
  const object = firstObject(text);
  const relaxed = relax(text);

  const attempts: { text: string; repairs: string[] }[] = [{ text, repairs: [] }];
  if (object !== undefined && object !== text) {
    attempts.push({ text: object, repairs: [REPAIR_SURROUNDING] });
  }
  if (relaxed.repairs.length > 0) attempts.push(relaxed);
  if (object !== undefined) {
    const relaxedObject = relax(object);
    if (relaxedObject.repairs.length > 0) {
      attempts.push({
        text: relaxedObject.text,
        repairs: [
          ...(object === text ? [] : [REPAIR_SURROUNDING]),
          ...relaxedObject.repairs,
        ],
      });
    }
  }

  let complaint = '';
  for (const attempt of attempts) {
    try {
      return { ok: true, value: JSON.parse(attempt.text), repairs: attempt.repairs };
    } catch (error) {
      if (complaint === '') {
        complaint = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return { ok: false, complaint };
}

/**
 * A field, as it was written.
 *
 * Data, not prose: a path, a glob, an id, or a command to run. Nothing here is
 * read as markdown, because `cli/src/**` and `cd cli && npm test -- --grep
 * "a\.b"` mean what they say, and a renderer that reads them as markup prints
 * something the user cannot run.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return plainProse(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => asText(entry))
      .filter((entry) => entry !== '')
      .join(', ');
  }
  return '';
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

/** The keys a task spec has to carry to be one. `covers` may be empty. */
const REQUIRED_SPEC_FIELDS = ['id', 'title', 'files', 'verify'] as const;

/** Longest list of missing fields worth printing before it stops informing. */
const MISSING_SHOWN = 6;

/**
 * Turns a parsed object into a plan, or names the fields that stop it being
 * one.
 *
 * The required set is the one the directive asks for: a bar, and at least one
 * task spec that says what it owns and how it is verified. Anything softer
 * would let a plan with nothing in it render as though it were a plan.
 */
/** A field that arrived as the wrong kind of JSON, named with what it was. */
interface WrongType {
  field: string;
  saw: unknown;
  expected: string;
}

/** What a value is, in the words the JSON spec uses for it. */
function jsonKind(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a JSON array';
  if (typeof value === 'object') return 'a JSON object';
  return 'a JSON ' + typeof value;
}

interface Shaping {
  payload?: PlanPayload;
  missing: string[];
  wrong?: WrongType;
}

function toPayload(record: Record<string, unknown>): Shaping {
  const missing: string[] = [];
  let wrong: WrongType | undefined;
  const mistyped = (field: string, saw: unknown, expected: string): void => {
    wrong ??= { field, saw, expected };
  };

  const rawBar = record['bar'];
  const bar = asText(rawBar);
  if (bar === '') {
    if (rawBar !== undefined && rawBar !== null && typeof rawBar === 'object') {
      mistyped('bar', rawBar, 'one line of text');
    }
    missing.push('bar');
  }

  const rawArtifacts = record['artifacts'];
  const artifacts: PlanArtifact[] = [];
  if (rawArtifacts !== undefined && rawArtifacts !== null) {
    if (!Array.isArray(rawArtifacts)) {
      mistyped('artifacts', rawArtifacts, 'a list of bar artifacts');
      missing.push('artifacts');
    } else {
      rawArtifacts.forEach((entry, index) => {
        const at = 'artifacts[' + index + ']';
        const fields = asRecords([entry])[0];
        if (fields === undefined) {
          mistyped(at, entry, 'a bar artifact object');
          missing.push(at);
          return;
        }
        const artifact = {
          path: asText(fields['path']),
          detail: asText(fields['detail']),
        };
        if (artifact.path === '') missing.push(at + '.path');
        artifacts.push(artifact);
      });
    }
  }

  const rawSpecs = record['specs'];
  const specs: PlanSpec[] = [];
  if (!Array.isArray(rawSpecs)) {
    if (rawSpecs !== undefined && rawSpecs !== null) {
      mistyped('specs', rawSpecs, 'a list of task specs');
    }
    missing.push('specs');
  } else if (rawSpecs.length === 0) {
    missing.push('specs');
  } else {
    rawSpecs.forEach((entry, index) => {
      const at = 'specs[' + index + ']';
      const fields = asRecords([entry])[0];
      if (fields === undefined) {
        mistyped(at, entry, 'a task spec object');
        missing.push(at);
        return;
      }
      const spec: PlanSpec = {
        id: asText(fields['id']),
        title: asText(fields['title']),
        covers: asText(fields['covers']),
        files: asText(fields['files']),
        verify: asText(fields['verify']),
      };
      for (const field of REQUIRED_SPEC_FIELDS) {
        if (spec[field] === '') missing.push(at + '.' + field);
      }
      specs.push(spec);
    });
  }

  if (wrong !== undefined) return { missing, wrong };
  if (missing.length > 0) return { missing };
  return {
    payload: { bar, comparison: asText(record['comparison']), artifacts, specs },
    missing,
  };
}

const NO_PLAN = 'the preview produced no plan: ';

/** The parser's complaint, and the text it was looking at when it gave up. */
function nearby(body: string, complaint: string): string | undefined {
  const at = complaint.match(/position (\d+)/);
  if (at === null) return undefined;
  const index = Number(at[1]);
  const from = Math.max(0, index - 24);
  const snippet = printable(body.slice(from, from + 56))
    .replace(/\s+/g, ' ')
    .trim();
  return snippet === '' ? undefined : truncate(snippet, 56);
}

/** What to call the block a fault is about, so the reader can find it. */
function blockName(candidate: Candidate): string {
  if (candidate.kind === 'unfenced') return 'the plan JSON in the answer';
  if (candidate.tag === '') return 'the block';
  return 'the ' + printable(candidate.tag) + ' block';
}

/** The fault when the answer carried no block that could hold a plan. */
function noPlan(rest: string): PlanFault {
  return {
    code: 'no-plan',
    message: NO_PLAN + 'the answer carried no ' + PAYLOAD_TAG + ' block',
    detail: [
      rest === ''
        ? 'the agent produced neither a plan nor anything to show'
        : 'the agent answered in prose; what it said is above',
      'run it again with a goal, or a spec file, it can decompose',
    ],
  };
}

function unreadable(candidate: Candidate, complaint: string): PlanFault {
  const body = candidate.body.trim();
  // A block that opened an object and never closed it was cut off, whatever
  // the parser called it; one that never opened an object holds something else.
  if (body.includes('{') && firstObject(body) === undefined) {
    return {
      code: 'cut-off',
      message: NO_PLAN + blockName(candidate) + ' was cut off before it ended',
      detail: [
        'the answer stops inside the block, so the turn ended in the middle of it',
        'raise the limit with --max-turns and run it again',
      ],
    };
  }
  const near = nearby(body, complaint);
  return {
    code: 'unreadable',
    message: NO_PLAN + blockName(candidate) + ' was not readable JSON',
    detail: [
      printable(complaint),
      ...(near === undefined ? [] : ['near: ' + near]),
      'comments and trailing commas are repaired first; this was neither',
    ],
  };
}

function notAnObject(where: string, value: unknown): PlanFault {
  return {
    code: 'not-an-object',
    message: NO_PLAN + where + ' held ' + jsonKind(value) + ', not an object',
    detail: ['a plan is one object: the bar, and the specs it was decomposed into'],
  };
}

function wrongType(where: string, wrong: WrongType): PlanFault {
  return {
    code: 'wrong-type',
    message:
      NO_PLAN +
      '"' +
      printable(wrong.field) +
      '" is ' +
      jsonKind(wrong.saw) +
      ', not ' +
      wrong.expected,
    detail: [where + ' has the field, but not in a shape this CLI can lay out'],
  };
}

function missingFields(where: string, missing: readonly string[]): PlanFault {
  if (missing.length === 1 && missing[0] === 'specs') {
    return {
      code: 'no-specs',
      message: NO_PLAN + where + ' named no task specs',
      detail: ['a preview is a decomposition; with no specs there is nothing to build'],
    };
  }
  const shown = missing.slice(0, MISSING_SHOWN).join(', ');
  const rest = missing.length - MISSING_SHOWN;
  return {
    code: 'missing-fields',
    message: NO_PLAN + where + ' is missing required fields',
    detail: [
      'missing: ' + shown + (rest > 0 ? ', and ' + rest + ' more' : ''),
      'every spec needs an id, a title, the files it owns, and a command to verify it',
    ],
  };
}

/** What was recovered rather than rejected, said one phrase at a time. */
function repairsFor(candidate: Candidate): string[] {
  const out: string[] = [];
  if (candidate.kind === 'mislabeled') {
    out.push(
      candidate.tag === ''
        ? 'the plan arrived in an untagged block'
        : 'the plan arrived in a "' + printable(candidate.tag) + '" block',
    );
  }
  if (candidate.kind === 'unfenced') out.push('the plan arrived with no block around it');
  if (!candidate.closed) {
    out.push('the block was never closed, so it was read to the end of the answer');
  }
  return out;
}

/**
 * Reads an agent's answer as a plan, or says exactly why it is not one.
 *
 * This is the only route by which anything an agent wrote becomes something
 * this CLI will render — the mirror of the flag boundary in `registry.ts`, and
 * held to the same rule: what arrives is a claim until it has been checked, and
 * a claim that fails the check is reported by name rather than passed on or
 * dropped in silence.
 *
 * The last block wins, and a correctly tagged one beats a mislabeled one: an
 * agent that shows the shape before filling it in has still finished with the
 * real one.
 */
export function readPlan(answer: string): PlanReading {
  const text = normalizeEol(answer);
  const rest = withoutPlanBlocks(text);
  const found = candidates(text.split('\n'));

  if (text.trim() === '') {
    return {
      ok: false,
      rest,
      repairs: [],
      fault: {
        code: 'no-answer',
        message: NO_PLAN + 'the agent ended its turn without answering',
        detail: [
          'nothing came back to lay out',
          'run it again, with --verbose to watch the session',
        ],
      },
    };
  }

  const ordered = [
    ...found.filter((candidate) => candidate.kind === 'tagged').reverse(),
    ...found.filter((candidate) => candidate.kind !== 'tagged').reverse(),
  ];

  let fault: PlanFault | undefined;
  for (const candidate of ordered) {
    const where = blockName(candidate);
    const reading = readJson(candidate.body);
    if (!reading.ok) {
      fault ??= unreadable(candidate, reading.complaint);
      continue;
    }
    const value = reading.value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fault ??= notAnObject(where, value);
      continue;
    }
    const shaped = toPayload(value as Record<string, unknown>);
    if (shaped.payload === undefined) {
      fault ??=
        shaped.wrong === undefined
          ? missingFields(where, shaped.missing)
          : wrongType(where, shaped.wrong);
      continue;
    }
    return {
      ok: true,
      payload: shaped.payload,
      rest,
      repairs: [...repairsFor(candidate), ...reading.repairs],
    };
  }

  // No candidate at all, or none that held a plan: either way the answer
  // carried none, and the first fault found says which way.
  return { ok: false, fault: fault ?? noPlan(rest), rest, repairs: [] };
}

/** The fault, laid out the way every other error this CLI prints is. */
export function renderPlanFault(fault: PlanFault): string {
  return (
    printableBlock(
      [fault.message, ...fault.detail.map((line) => '  ' + line)].join('\n'),
    ) + '\n'
  );
}

/**
 * A closing instruction to answer, addressed to a reader who cannot.
 *
 * An agent writing for a chat window ends by inviting a reply. A preview has
 * already exited by the time a line of it is read, and the transcript may be a
 * file, so that invitation is an instruction nobody can follow.
 *
 * Cosmetic, and only that: whether a preview produced a plan is decided by
 * {@link readPlan} from the plan itself, never from how the prose around it
 * reads.
 */
const REPLY_INSTRUCTION = /^(please\s+)?(reply|respond|answer|confirm)\b/i;

/** Longest a closing line can be and still be read as that invitation. */
const INSTRUCTION_LIMIT = 120;

/** Drops trailing content a reader of a finished preview could not act on. */
export function dropUnactionable(text: string): string {
  // Line endings are normalised first, because paragraphs are what this splits
  // on and a CRLF answer has none by that reckoning: `\r\n\r\n` holds no two
  // consecutive newlines, so the whole answer arrives as a single block and
  // nothing is ever recognised as the closing line. What an agent sends is not
  // this CLI's to choose — the provider may deliver either — so every function
  // here that reasons about lines reads both the same way.
  const blocks = normalizeEol(text).trim().split(/\n{2,}/);
  while (blocks.length > 0) {
    const last = plainProse(blocks[blocks.length - 1] as string);
    if (last.length > INSTRUCTION_LIMIT || !REPLY_INSTRUCTION.test(last)) break;
    blocks.pop();
  }
  return blocks.join('\n\n').trim();
}

/**
 * The columns of the task-spec table, in order, always.
 *
 * Fixed rather than fitted to the content: a record whose field count depends
 * on what happened to be in it cannot be read by anything but a human. `covers`
 * is empty on a run made from a goal rather than a spec, and it is still the
 * third field — so `cut -f4` is the files column of every run of this command,
 * not of some of them.
 */
const SPEC_COLUMNS: readonly (keyof PlanSpec)[] = [
  'id',
  'title',
  'covers',
  'files',
  'verify',
];

/**
 * The GOAL section: what the user typed, echoed back to them.
 *
 * Their own words, not a resolved absolute path they never wrote — and never
 * cut in half, because a path or a goal is one token to whoever has to read it
 * back. A token wider than the terminal is left for the terminal to fold.
 */
function renderInput(input: ResolvedInput, view: Viewport): string[] {
  return wrapText(inputAsTyped(input), view.width, 2, { breakWords: false });
}

/**
 * The preview, framed by this CLI.
 *
 * Which sections exist, what they are called, what order they come in, and
 * which columns a table has are decided here and are the same on every run.
 * The agent supplies the words that go in them and nothing else, so two runs
 * of the same preview differ only where the content differs.
 */
export function renderPlan(
  payload: PlanPayload,
  input: ResolvedInput,
  view: Viewport,
): string {
  // Agent prose is stripped here as well as where it was read, so a payload
  // built by any caller still cannot put chat markup on the terminal. What the
  // user typed is echoed as they typed it: it is theirs, not the agent's.
  const prose = (value: string): string[] =>
    wrapText(plainProse(value), view.width, 2);

  const lines: string[] = [
    // Named for what it is, the way a run names it: a path to a file that
    // exists is a spec, and calling it a goal in one command and a spec in the
    // next makes one input read as two things.
    ...renderSection(input.kind === 'spec' ? 'SPEC' : 'GOAL', renderInput(input, view)),
    ...renderSection('BAR', prose(payload.bar)),
    ...renderSection('COMPARISON', prose(payload.comparison)),
    // Tables sit at the body indent, the same as the prose above them: at the
    // heading's own indent a table reads as another heading's peer rather than
    // as what that heading introduces. A pipe gets tab-delimited rows with no
    // indent at all, here as everywhere.
    ...renderSection(
      'BAR ARTIFACTS',
      renderTable(
        ['path', 'detail'],
        payload.artifacts.map((artifact) => [artifact.path, artifact.detail].map(plainProse)),
        view,
        BODY_INDENT,
      ),
    ),
    ...renderSection(
      'TASK SPECS',
      renderTable(
        SPEC_COLUMNS,
        payload.specs.map((spec) => SPEC_COLUMNS.map((column) => plainProse(spec[column]))),
        view,
        BODY_INDENT,
      ),
    ),
  ];

  return lines.join('\n') + '\n';
}

/**
 * What is shown when the answer was not a plan: the answer itself.
 *
 * It is headed ANSWER rather than PREVIEW because that is what it is — the
 * exit code and the message on stderr say it is not a preview, and the frame
 * must not say otherwise. The markdown an agent wrote for a chat window is
 * still laid out rather than piped through as syntax, and the block that was
 * read for a plan is not here at all, so raw JSON never reaches a heading.
 */
export function renderAnswer(
  body: string,
  input: ResolvedInput,
  view: Viewport,
): string {
  const lines: string[] = [
    ...renderSection(input.kind === 'spec' ? 'SPEC' : 'GOAL', renderInput(input, view)),
    ...renderSection('ANSWER', renderMarkdown(body, view, 2)),
  ];
  return lines.join('\n') + '\n';
}

/**
 * Where a run keeps what it captures, under the directory it runs in. Named
 * here only to be able to look before writing; what goes in it is the plugin
 * markdown's business, not this file's.
 */
const RUN_DIR = '.exolvra-genesis';
const BAR_DIR = 'bar';

/**
 * Refuses to start when an earlier capture is sitting where this one would go.
 *
 * A preview captures a bar, and a capture is files on disk. Running a second
 * preview in the same directory would put a second run's files among the first
 * run's, under one name, with no way afterwards to tell which is which — so it
 * stops here, before anything is spawned, and says what to do instead. `--force`
 * is the way to say it anyway; there is no way to do it by accident.
 */
function assertBarNotInTheWay(cwd: string, force: boolean): void {
  if (force) return;
  const bar = join(cwd, RUN_DIR, BAR_DIR);
  if (pathKind(bar) !== 'directory') return;

  let entries: string[];
  try {
    entries = readdirSync(bar);
  } catch {
    // Unreadable is not the same as occupied, and this check is not the place
    // to decide what an unreadable directory means.
    return;
  }
  if (entries.length === 0) return;

  const count = entries.length === 1 ? '1 entry' : entries.length + ' entries';
  throw new ConfigError(
    [
      'a bar captured by an earlier run is already here',
      '  ' + bar + ' holds ' + count,
      '  a preview captures the bar into that directory, so this one would be',
      '  written in among them',
      '  move them aside, run somewhere else with --directory, or pass --force',
      '  to capture over them',
    ].join('\n'),
  );
}

async function runPlan(argv: string[], ctx: Ctx): Promise<number> {
  // Everything the user typed is validated here, in one call, before anything
  // is spawned: a bad value is this CLI's usage error naming the flag and the
  // value, never an unreadable failure from somewhere inside the provider.
  const args = parseInvocation(planCommand, argv, ctx);

  if (args.help) {
    ctx.stdout.write(renderCommandHelp(planCommand));
    return EXIT.WIN;
  }

  const models: ModelChoice = {
    lead: args.get(modelFlag) ?? DEFAULT_MODEL_CHOICE.lead,
    builder: args.get(builderModelFlag) ?? DEFAULT_MODEL_CHOICE.builder,
    critic: args.get(criticModelFlag) ?? DEFAULT_MODEL_CHOICE.critic,
  };

  const cwd = args.cwd;
  const pluginDir = args.get(pluginDirFlag) ?? args.env(pluginDirEnv);
  const env =
    pluginDir === undefined
      ? ctx.env
      : { ...ctx.env, [PLUGIN_DIR_ENV]: pluginDir };

  const sources = loadPluginSources(env);
  assertBarNotInTheWay(cwd, args.bool(forceFlag));

  const input = args.argument(planArgument);
  const prompt =
    renderLeadPrompt(sources.runMd, inputAsArgument(input)) +
    '\n\n' +
    PREVIEW_DIRECTIVE +
    '\n';

  const view: Viewport = { tty: ctx.isTTY, width: ctx.width };
  const verbose = args.bool(verboseFlag);
  const streamed: string[] = [];

  // A preview is a minute or two of an agent working with nothing to show yet.
  // On a terminal that is a line that keeps moving; anywhere else — a pipe, a
  // file, a CI log — it is nothing at all, and stdout is untouched either way.
  const progress = startProgress(ctx.stderr, PROGRESS_MESSAGE, ctx.isErrTTY);
  let messages = 0;

  const session = createSession({
    prompt,
    sources,
    models,
    cwd,
    env,
    maxTurns: args.get(maxTurnsFlag) ?? DEFAULT_MAX_TURNS,
    permissionMode: args.get(permissionModeFlag) ?? 'acceptEdits',
    hooks: {
      onMessage(message: SdkMessage): void {
        // Every message, not only the ones with prose in them: a stretch spent
        // reading files is exactly the stretch that looks like a hang, and the
        // count is what says it is not one.
        messages += 1;
        progress.update(
          PROGRESS_MESSAGE +
            ' · ' +
            messages +
            (messages === 1 ? ' message' : ' messages'),
        );

        if (!verbose) return;
        const text = assistantText(message).trim();
        if (text === '') return;
        streamed.push(text);
        // Rendered, not echoed: a transcript is still terminal output, so the
        // markdown an agent writes for a chat window is laid out here too. The
        // payload is the frame's input, not transcript, so it is held back.
        const rendered = renderMarkdown(dropUnactionable(withoutPlanBlocks(text)), view);
        // A blank line between messages: without one, the tail of a thought and
        // the head of the next one run together into a single false sentence.
        if (rendered.length > 0) {
          // The transcript and the progress line share a terminal: the line is
          // taken down before the transcript is written, and the next frame
          // draws it again underneath.
          progress.clear();
          ctx.stdout.write(rendered.join('\n') + '\n\n');
        }
      },
    },
  });

  let result;
  try {
    result = await session.start();
  } catch (error) {
    progress.fail('The preview stopped');
    throw error;
  }

  // A session that finished is not a preview that produced one: what came back
  // is checked here, and only a plan that survives the check is printed as one.
  const answer = result.text.trim();
  const reading = readPlan(answer);

  // The line closes on what actually happened, before a word of the plan or of
  // the failure is printed under it.
  if (result.status === 'complete' && reading.ok) progress.done('Plan ready');
  else if (reading.ok) progress.fail('Plan incomplete');
  else progress.fail('No plan');

  if (verbose) {
    for (const repair of reading.repairs) ctx.stderr.write('note: ' + repair + '\n');
  }

  if (reading.ok) {
    ctx.stdout.write(renderPlan(reading.payload, input, view));
  } else {
    // No plan: what the agent did say is all there is to show. It is the same
    // text --verbose has already streamed, so it is printed once.
    const body = dropUnactionable(reading.rest);
    if (body !== '' && answer !== joinText(streamed)) {
      ctx.stdout.write(renderAnswer(body, input, view));
    }
  }

  if (result.status !== 'complete') {
    ctx.stderr.write(
      'the preview did not finish: ' +
        printable(result.error ?? 'no reason was reported') +
        '\n',
    );
    if (reading.ok) {
      ctx.stderr.write('  the plan above is what it produced before it stopped\n');
    }
    if (result.reason === 'max-turns') {
      ctx.stderr.write('  raise the limit with --max-turns and run it again\n');
    }
    return EXIT.LOSS;
  }

  if (!reading.ok) {
    ctx.stderr.write(renderPlanFault(reading.fault));
    return EXIT.LOSS;
  }

  // The only path that returns a win, and it has just written the plan.
  return EXIT.WIN;
}
