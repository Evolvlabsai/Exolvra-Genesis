/**
 * The user config file: the answers a run reuses next time (R13).
 *
 * Two rules shape this module.
 *
 * It stores **preferences, not the run** — the model per role and whether to
 * pause for review. The goal never persists: a goal is what one run was about,
 * and a stale one pre-filled into the next run is an invitation to launch the
 * wrong thing.
 *
 * What it stores per role is whatever that role's flag accepts, and the two are
 * not the same: `lead` is a versioned model id, `builder` and `critic` are
 * families, because the SDK pins a subagent to a family rather than to a
 * version. A file that says otherwise would be a file that starts a run and then
 * fails it, so the schema here is the flag vocabulary, exactly.
 *
 * It never fails a run. A config that cannot be read, cannot be parsed, or
 * names a model this build does not offer is a reason to say so once and carry
 * on with defaults — not a reason to stop. {@link loadConfig} therefore has one
 * failure mode, "you get the defaults", and it never writes anything: `--no-config`
 * is the caller skipping the call, which only works if calling it is free of
 * consequence.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix as posixPath, win32 as winPath } from 'node:path';

import { ConfigError } from './exit.js';
import {
  DEFAULT_MODEL_CHOICE,
  MODEL_INHERIT,
  agentModelFault,
  asAgentModel,
  isKnownModel,
  listModels,
} from './models.js';
import type { AgentModel, ModelChoice } from './models.js';

/** The directory this CLI owns inside the OS user-config location. */
export const CONFIG_DIR_NAME = 'exolvra-genesis';

/** The environment variable that bounds automatic session recovery. */
export const AUTO_RESUME_ENV = 'EXOLVRA_GENESIS_AUTO_RESUMES';

/**
 * How many times `run` and `resume` may re-drive a session that ended
 * abnormally — a stream fault, or a turn that finished while state.json still
 * said `running` — before giving the keyboard back to a person.
 *
 * A *deliberate* ending never counts: a lead that settled `blocked` made a
 * decision, a budget guard that tripped enforced one, and re-driving either
 * would spend money asking a question that was already answered. The bound
 * exists because an abnormal death can be systemic (a dead credential, a full
 * disk), and unbounded retries against a systemic fault are a bill, not a fix.
 *
 * Default 2. `0` disables recovery entirely — the pre-0.8.2 behavior, and what
 * tests that stage session faults set. Clamped to at most 5: past that, the
 * fault is not going away on its own.
 */
export function autoResumeLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AUTO_RESUME_ENV];
  if (raw === undefined || raw.trim() === '') return 2;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 2;
  return Math.min(parsed, 5);
}

/** The environment variable that scales recovery's wait, in milliseconds. */
export const AUTO_RESUME_DELAY_ENV = 'EXOLVRA_GENESIS_AUTO_RESUME_DELAY_MS';

/**
 * How long recovery waits before attempt N — N × the base, so a second try
 * gives a struggling provider twice the room the first did.
 *
 * The wait exists because the fault recovery most often meets is the API
 * saying "Overloaded" (a 529), and an instant retry asks the same overloaded
 * servers the same question in the same moment. Backing off is what turns two
 * attempts from a formality into a real second chance. The base defaults to
 * 15 seconds; tests set the variable to 0 and wait for nothing.
 */
export function autoResumeDelayMs(
  attempt: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[AUTO_RESUME_DELAY_ENV];
  const base =
    raw === undefined || raw.trim() === '' ? 15_000 : Number.parseInt(raw, 10);
  if (Number.isNaN(base) || base < 0) return attempt * 15_000;
  return attempt * Math.min(base, 120_000);
}

/** The file inside it. */
export const CONFIG_FILE_NAME = 'config.json';

/** What a saved config carries. Every field is optional; a missing one means "no preference". */
export interface ExolvraGenesisConfig {
  /** `lead` as a model id; `builder` and `critic` as families. */
  models?: ModelChoice;
  /** True when the loop starts without pausing for review (`--auto`). */
  auto?: boolean;
}

/**
 * Which machine's config this is. Both fields default to this process, and both
 * are injectable so a test can put a whole OS convention under a temp directory.
 */
export interface ConfigLocation {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Reading also needs somewhere to put a notice.
 *
 * `warn` is required rather than defaulted: a module that reached for the
 * process's own stderr would be writing around the command's stream, and a
 * notice nobody chose a destination for is one nobody reads.
 */
export interface LoadOptions extends ConfigLocation {
  warn: (message: string) => void;
}

/** The two roles that run as subagents, and so are pinned to a family. */
const AGENT_ROLES = ['builder', 'critic'] as const;

type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * Which family each offered id belongs to — built from the same list the lead
 * picker offers, so it can never name an id this build does not have.
 *
 * Used only to read an older config forward: a file written when both roles took
 * ids still says something answerable, and answering it beats discarding it.
 */
const FAMILY_BY_ID = new Map<string, AgentModel>(
  listModels().map((model) => [model.value, model.family]),
);

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Drops a leading byte-order mark.
 *
 * `JSON.parse` rejects one, and on Windows nearly everything writes one:
 * PowerShell's `>` and `Out-File`, and Notepad's "UTF-8 with BOM" default. A
 * config a user edited by hand is exactly the config that must still load.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function notice(message: string): string {
  return 'exolvra-genesis: ' + message;
}

/** The `code` of a filesystem error, or its message when it carries none. */
function reason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return reason(error) === 'ENOENT';
}

/**
 * The directory the config lives in, per OS convention:
 * `%APPDATA%\exolvra-genesis` on Windows, `~/Library/Application Support/exolvra-genesis` on
 * macOS, `$XDG_CONFIG_HOME/exolvra-genesis` (else `~/.config/exolvra-genesis`) elsewhere.
 */
export function configDir(where: ConfigLocation = {}): string {
  const env = where.env ?? process.env;
  const platform = where.platform ?? process.platform;

  /*
   * Paths are joined and tested by the rules of the platform being asked
   * about, not of the one this process happens to be running on.
   *
   * `node:path`'s own exports follow the running platform, so asking about
   * Windows from Linux read `C:\Users\ada\AppData\Roaming` as a relative path —
   * it has no leading slash — and the answer fell through to a home directory
   * joined with `AppData/Roaming` under Linux separators. That is not a
   * location on either operating system.
   */
  const paths = platform === 'win32' ? winPath : posixPath;

  /*
   * A caller that supplies the environment supplies all of it.
   *
   * Reaching past an injected environment to this machine's real home is how
   * one OS's home ends up carrying another OS's convention. Left unset, the
   * answer is whatever an environment with no home says it is, which is at
   * least an answer about the environment that was handed over. The ordinary
   * call passes no environment at all and still gets the real one.
   */
  const home =
    env['HOME'] || env['USERPROFILE'] || (where.env === undefined ? homedir() : '');

  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base =
      appData && paths.isAbsolute(appData)
        ? appData
        : paths.join(home, 'AppData', 'Roaming');
    return paths.join(base, CONFIG_DIR_NAME);
  }
  if (platform === 'darwin') {
    return paths.join(home, 'Library', 'Application Support', CONFIG_DIR_NAME);
  }
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && paths.isAbsolute(xdg) ? xdg : paths.join(home, '.config');
  return paths.join(base, CONFIG_DIR_NAME);
}

/** The config file itself. Printing this is how a user finds what to edit or delete. */
export function configPath(where: ConfigLocation = {}): string {
  // Joined by the rules of the platform being asked about, like the directory.
  const paths = (where.platform ?? process.platform) === 'win32' ? winPath : posixPath;
  return paths.join(configDir(where), CONFIG_FILE_NAME);
}

/**
 * Reads the saved config, or returns the empty config when there is nothing
 * usable to read.
 *
 * A pure read: it creates nothing, repairs nothing, and rewrites nothing. Its
 * only outward effect is a one-line notice when a file exists but cannot be
 * used, so a user whose preferences silently stopped applying can see why.
 */
export function loadConfig(options: LoadOptions): ExolvraGenesisConfig {
  const path = configPath(options);
  const warn = options.warn;

  let raw: string;
  try {
    // A BOM is not corruption: PowerShell's `>`, `Out-File` and Notepad all put
    // one there, and a config a user hand-edited on Windows must still parse.
    raw = stripBom(readFileSync(path, 'utf8'));
  } catch (error) {
    // No config yet is the normal case on a first run, and says nothing.
    if (isNotFound(error)) return {};
    warn(
      notice(
        'the config at ' + path + ' could not be read (' + reason(error) + ') — using defaults',
      ),
    );
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(notice('the config at ' + path + ' is not valid JSON — using defaults'));
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn(notice('the config at ' + path + ' is not a JSON object — using defaults'));
    return {};
  }

  const record = parsed as Record<string, unknown>;
  const config: ExolvraGenesisConfig = {};

  const models = readModels(record['models'], path, warn);
  if (models) config.models = models;

  const auto = record['auto'];
  if (auto !== undefined) {
    if (typeof auto === 'boolean') {
      config.auto = auto;
    } else {
      warn(notice('the config at ' + path + ' has a non-boolean "auto" — ignoring it'));
    }
  }

  return config;
}

function readModels(
  value: unknown,
  path: string,
  warn: (message: string) => void,
): ModelChoice | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warn(notice('the config at ' + path + ' has a "models" that is not an object — ignoring it'));
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const models: ModelChoice = { ...DEFAULT_MODEL_CHOICE };
  let kept = false;

  const lead = record['lead'];
  if (lead !== undefined) {
    if (typeof lead === 'string' && isKnownModel(lead)) {
      models.lead = normalize(lead);
      kept = true;
    } else {
      // A model this build dropped, or a typo hand-edited in. Either way the run
      // proceeds — on the one value that is always valid.
      warn(
        notice(
          'the config at ' +
            path +
            ' names ' +
            JSON.stringify(lead) +
            ' as the lead model, which this build does not offer — using ' +
            MODEL_INHERIT,
        ),
      );
    }
  }

  for (const role of AGENT_ROLES) {
    const saved = record[role];
    if (saved === undefined) continue;
    const family = readFamily(saved, role, path, warn);
    if (family !== undefined) {
      models[role] = family;
      kept = true;
    }
  }

  return kept ? models : undefined;
}

/**
 * Reads one subagent role, carrying an older file forward where it can.
 *
 * A config written when both roles took ids is not wrong about what the user
 * wanted — it is only wrong about what the provider can be told. Reading
 * `claude-sonnet-5` as `sonnet` keeps the preference and says so in one line;
 * discarding it would silently demote a chosen model to `inherit`.
 */
function readFamily(
  saved: unknown,
  role: AgentRole,
  path: string,
  warn: (message: string) => void,
): string | undefined {
  if (typeof saved === 'string') {
    const family = asAgentModel(saved);
    if (family !== undefined) return family;

    const belongsTo = FAMILY_BY_ID.get(normalize(saved));
    if (belongsTo !== undefined) {
      warn(
        notice(
          'the config at ' +
            path +
            ' names "' +
            normalize(saved) +
            '" as the ' +
            role +
            ' model, and a subagent is pinned to a family rather than a version — reading it as "' +
            belongsTo +
            '"',
        ),
      );
      return belongsTo;
    }
  }

  warn(
    notice(
      'the config at ' +
        path +
        ' names ' +
        JSON.stringify(saved) +
        ' as the ' +
        role +
        ' model, which is not a model family — using ' +
        MODEL_INHERIT,
    ),
  );
  return undefined;
}

function acceptId(value: unknown): string {
  if (typeof value === 'string' && isKnownModel(value)) return normalize(value);
  throw new ConfigError(
    'refusing to save ' +
      JSON.stringify(value) +
      ' as the lead model: not a model this build offers',
  );
}

/**
 * Writing is strict where reading is forgiving.
 *
 * An id arriving here is not an old file being carried forward — it is this
 * build about to persist a value its own flags reject, and the run after next
 * would be the one to find out. The refusal borrows the flag boundary's words so
 * both say the same thing about the same mistake.
 */
function acceptFamily(value: unknown, role: AgentRole): string {
  if (typeof value === 'string') {
    const family = asAgentModel(value);
    if (family !== undefined) return family;
  }
  throw new ConfigError(
    [
      'refusing to save ' + JSON.stringify(value) + ' as the ' + role + ' model: not a model family',
      ...agentModelFault(typeof value === 'string' ? value : ''),
    ].join('\n'),
  );
}

/** The exact object written to disk — built field by field so key order is fixed. */
function serialize(config: ExolvraGenesisConfig): ExolvraGenesisConfig {
  const out: ExolvraGenesisConfig = {};
  if (config.models) {
    out.models = {
      lead: acceptId(config.models.lead),
      builder: acceptFamily(config.models.builder, 'builder'),
      critic: acceptFamily(config.models.critic, 'critic'),
    };
  }
  if (config.auto !== undefined) out.auto = config.auto;
  return out;
}

/**
 * Writes the config, creating the directory on first save, and returns the path.
 *
 * The write is a temp file plus a rename: a config is read at the start of every
 * run, and a run interrupted mid-write must not leave behind a file that the
 * next run can only report as unreadable.
 */
export function saveConfig(config: ExolvraGenesisConfig, where: ConfigLocation = {}): string {
  // Validate before touching the filesystem, so a rejected config creates nothing.
  const body = JSON.stringify(serialize(config), null, 2) + '\n';
  const path = configPath(where);
  const temp = path + '.' + process.pid + '.tmp';

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new ConfigError('could not write the config at ' + path + ': ' + reason(error));
  }

  return path;
}

/**
 * The reusable half of a run's answers.
 *
 * Takes the choices startup produced and keeps what the *next* run should
 * default to — which is everything except the goal.
 */
export function configFromChoices(choices: { models: ModelChoice; auto: boolean }): ExolvraGenesisConfig {
  return { models: { ...choices.models }, auto: choices.auto };
}
