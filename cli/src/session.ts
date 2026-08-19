import type {
  Options,
  PermissionMode,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { buildAgentDefinitions } from './agents.js';
import { ConfigError } from './exit.js';
import type { ModelChoice } from './models.js';
import { MODEL_INHERIT, canonicalModel, modelFault } from './models.js';
import type { PluginSources } from './plugin-dir.js';

/** One message off the agent stream. */
export type SdkMessage = SDKMessage;

export interface SessionHooks {
  onMessage(m: SdkMessage): void;
}

/**
 * The live stream a transport hands back. The SDK's own `Query` satisfies this
 * structurally, so tests can substitute a fake without faking CLI behaviour.
 */
export interface SessionStream extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<void>;
}

export type SessionTransport = (params: {
  prompt: string;
  options: Options;
}) => SessionStream | Promise<SessionStream>;

export interface SessionOptions {
  /** The lead prompt, already rendered from the plugin markdown. */
  prompt: string;
  sources: PluginSources;
  models: ModelChoice;
  cwd: string;
  hooks?: SessionHooks;
  /**
   * Whether the session may spawn the builder and critic subagents.
   *
   * False for a conversation: an interview has one agent, which writes both
   * files itself, and offering it two roles it is never meant to delegate to is
   * offering it a way to do the wrong thing.
   */
  subagents?: boolean;
  maxTurns?: number;
  /**
   * A ceiling the provider itself enforces, in US dollars.
   *
   * Passed on so the run can be stopped *at* the limit rather than found to
   * have passed it once the turn is over: the CLI only learns what a turn cost
   * when the turn reports it, which is too late to have saved anything. The
   * provider ends the query with an `error_max_budget_usd` result, which
   * {@link toResult} already reads as a run that was stopped rather than one
   * that failed.
   */
  maxBudgetUsd?: number;
  permissionMode?: PermissionMode;
  env?: NodeJS.ProcessEnv;
  /** Overrides the Claude Agent SDK. Used by tests. */
  transport?: SessionTransport;
}

export type SessionStatus = 'complete' | 'stopped' | 'error';

/** Why a session ended, in this tool's terms rather than the provider's. */
export type SessionReason =
  | 'complete'
  | 'interrupted'
  | 'no-result'
  | 'max-turns'
  | 'max-budget'
  | 'failed';

export interface SessionResult {
  status: SessionStatus;
  reason: SessionReason;
  sessionId: string | undefined;
  turns: number;
  costUsd: number;
  /** The agent's final text, or the assistant text seen when there was none. */
  text: string;
  /** A sentence a caller can print, never a raw code from the provider. */
  error: string | undefined;
}

export interface Session {
  /** Session id, available once the first message arrives. */
  readonly id: string | undefined;
  start(): Promise<SessionResult>;
  resume(sessionId: string): Promise<SessionResult>;
  interrupt(): Promise<void>;
}

/** Loads the SDK lazily so `--help` never pays for it. */
const sdkTransport: SessionTransport = async (params) => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  return query(params);
};

/**
 * Joins agent text so nothing runs together. Concatenating text blocks with no
 * separator turns the end of one thought and the start of the next into a
 * single false sentence, so every join here is a blank line.
 */
export function joinText(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n\n');
}

/** Pulls plain text out of an assistant message without depending on SDK internals. */
export function assistantText(message: SdkMessage): string {
  if (message.type !== 'assistant') return '';
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return '';
  return joinText(
    content.map((block) => {
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    }),
  );
}

/** Signals that mean the user, or whatever supervises this process, said stop. */
const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * The signal named by a failure, when the failure names one.
 *
 * Being killed is not the same as failing to start, and the two have opposite
 * remedies: reporting a termination as a missing interpreter sends the user off
 * to fix an environment that was never broken.
 */
/**
 * Whether a failure is a bug rather than an environment.
 *
 * The distinction decides what the user is told to do about it, so it is drawn
 * on something real rather than on where the failure happened. A missing
 * interpreter, an unreadable credential, a directory that is not there — those
 * arrive as ordinary Errors carrying a system code, and each has a remedy the
 * user can apply. The language's own fault types do not: nothing the user sets
 * makes `query is not a function` or a property read on null go away, so
 * reporting either as a configuration problem sends them to fix an environment
 * that was never broken. Those leave here untouched, to be reported as what
 * they are — a run blocked by a fault in this integration, never a verdict.
 */
function isProgrammerFault(error: unknown): boolean {
  // A SyntaxError from JSON.parse is not a programmer fault — it is torn
  // DATA: the SDK parses the provider process's stdout line by line, and a
  // process dying mid-write hands it half a JSON object. That is a stream
  // fault to recover from, not a bug to report. (Found live: "Unterminated
  // string in JSON at position 167" killed a run, skipped recovery, and hid
  // its own origin behind the internal-error banner.)
  if (error instanceof SyntaxError && /JSON/.test(error.message)) return false;
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  );
}

/** A parse fault in the provider's own stream: torn output, not our code. */
function isTornStream(error: unknown): boolean {
  return error instanceof SyntaxError && /JSON/.test(error.message);
}

function terminationSignal(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const carried = (error as { signal?: unknown }).signal;
    if (typeof carried === 'string' && carried !== '') return carried;
  }
  const message = error instanceof Error ? error.message : String(error);
  const named = message.match(/\bSIG[A-Z]{2,}[0-9]*\b/);
  return named === null ? undefined : named[0];
}

export function createSession(opts: SessionOptions): Session {
  const transport = opts.transport ?? sdkTransport;
  let sessionId: string | undefined;
  let stream: SessionStream | undefined;
  let interrupted = false;

  const stop = (): void => {
    interrupted = true;
    void stream?.interrupt();
  };

  const buildOptions = (resumeId?: string): Options => {
    const options: Options = {
      cwd: opts.cwd,
      ...(opts.subagents === false
        ? {}
        : { agents: buildAgentDefinitions(opts.sources, opts.models) }),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project'],
      permissionMode: opts.permissionMode ?? 'acceptEdits',
    };
    // Canonical, or nothing. Nothing unvalidated reaches the SDK, including
    // from callers that did not come through the CLI's own flag parsing — and
    // what does reach it is the spelling this build publishes, not the one the
    // caller happened to type. `inherit` is this CLI's own word for "send no
    // model", so it is the one accepted value that is never forwarded.
    const lead = canonicalModel(opts.models.lead);
    if (lead === undefined) {
      throw new ConfigError(
        [
          '"' + opts.models.lead + '" is not a model this build offers, so the lead agent cannot run on it',
          ...modelFault(),
        ].join('\n'),
      );
    }
    if (lead !== MODEL_INHERIT) options.model = lead;
    if (opts.maxTurns !== undefined) options.maxTurns = opts.maxTurns;
    if (opts.maxBudgetUsd !== undefined) options.maxBudgetUsd = opts.maxBudgetUsd;
    if (opts.env !== undefined) options.env = opts.env;
    if (resumeId !== undefined) options.resume = resumeId;
    return options;
  };

  const drain = async (resumeId?: string): Promise<SessionResult> => {
    interrupted = false;
    // Built before the try: a configuration fault here is a fault in what the
    // caller asked for, not a provider that failed to start.
    const options = buildOptions(resumeId);
    const assistant: string[] = [];
    let final: SdkMessage | undefined;
    // The boundary between the two failure classes: a provider that never
    // produced a message never started, which is an environment the user has to
    // fix (exit 2). A provider that failed after it started produced a run that
    // did not finish (exit 1). Nothing else can tell the two apart from here.
    let started = false;

    // While a session is draining, a stop signal belongs to the run: it ends
    // the run rather than the process, so the exit code still says what
    // happened. Outside a drain the default handling stands.
    for (const signal of STOP_SIGNALS) process.on(signal, stop);

    try {
      stream = await transport({ prompt: opts.prompt, options });
      for await (const message of stream) {
        started = true;
        const id = (message as { session_id?: unknown }).session_id;
        if (typeof id === 'string' && id !== '') sessionId = id;
        opts.hooks?.onMessage(message);
        if (message.type === 'assistant') assistant.push(assistantText(message));
        if (message.type === 'result') final = message;
      }
    } catch (error) {
      const text = joinText(assistant);
      if (interrupted) return toResult(undefined, text, sessionId, true);
      // Before either classification below: a fault of this kind is neither a
      // run that ended nor an environment to fix, and it is the one thing here
      // that must not be dressed up as either. It leaves unwrapped, and the
      // entry point reports it in the frame an unclassified fault gets.
      if (isProgrammerFault(error)) throw error;
      if (isTornStream(error)) {
        // Whether or not a whole message ever arrived: a torn line means the
        // provider WAS writing, so this is a run that did not finish — the
        // recoverable kind — never a configuration to fix.
        return {
          status: 'error',
          reason: 'failed',
          sessionId,
          turns: 0,
          costUsd: 0,
          text,
          error:
            "the provider's stream was cut mid-message: " +
            (error instanceof Error ? error.message : String(error)),
        };
      }
      if (started) {
        // The provider produced messages and then failed. That is a run that
        // did not finish — a result, in this tool's terms — and it is reported
        // as one rather than thrown on as a fault nothing classified. The
        // difference is what the user is told: a run that ended, not a bug.
        return {
          status: 'error',
          reason: 'failed',
          sessionId,
          turns: 0,
          costUsd: 0,
          text,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      const signal = terminationSignal(error);
      if (signal !== undefined) {
        return {
          status: 'stopped',
          reason: 'interrupted',
          sessionId,
          turns: 0,
          costUsd: 0,
          text,
          error: 'it was stopped by ' + signal + ' before it produced anything',
        };
      }
      throw new ConfigError(
        [
          'could not start a Claude Agent SDK session',
          '  ' + (error instanceof Error ? error.message : String(error)),
          '  the SDK spawns Claude Code with node and authenticates from this',
          '  environment: check that node is on PATH and that a credential is',
          '  available (see `exolvra-genesis help environment`)',
        ].join('\n'),
      );
    } finally {
      for (const signal of STOP_SIGNALS) process.removeListener(signal, stop);
      stream = undefined;
    }

    return toResult(final, joinText(assistant), sessionId, interrupted);
  };

  return {
    get id(): string | undefined {
      return sessionId;
    },
    start: () => drain(),
    resume: (id: string) => drain(id),
    async interrupt(): Promise<void> {
      interrupted = true;
      await stream?.interrupt();
    },
  };
}

/**
 * What the run's outcome is called here. The provider's own subtype codes are
 * diagnostics, not user-facing prose, so each one this SDK defines gets a
 * sentence; a code from a future version is reported as one, and named as such.
 */
function explain(
  reason: SessionReason,
  subtype: string,
  errors: readonly string[],
): string {
  if (errors.length > 0) return errors.join('; ');
  if (reason === 'max-turns') return 'it ran out of agent turns';
  if (reason === 'max-budget') return 'it reached its cost limit';
  if (subtype === 'error_during_execution') return 'the agent run failed';
  if (subtype === 'error_max_structured_output_retries') {
    return 'the agent could not produce the output shape that was asked for';
  }
  return 'the agent run ended early (the SDK reported it as "' + subtype + '")';
}

function toResult(
  final: SdkMessage | undefined,
  assistant: string,
  sessionId: string | undefined,
  interrupted: boolean,
): SessionResult {
  if (final === undefined || final.type !== 'result') {
    return {
      status: interrupted ? 'stopped' : 'error',
      reason: interrupted ? 'interrupted' : 'no-result',
      sessionId,
      turns: 0,
      costUsd: 0,
      text: assistant,
      error: interrupted
        ? 'it was interrupted before it produced a result'
        : 'the agent stream ended without a result',
    };
  }

  const base = {
    sessionId: final.session_id,
    turns: final.num_turns,
    costUsd: final.total_cost_usd,
  };

  if (final.subtype === 'success') {
    return {
      ...base,
      status: interrupted ? 'stopped' : 'complete',
      reason: interrupted ? 'interrupted' : 'complete',
      text: final.result,
      error: undefined,
    };
  }

  const reason: SessionReason =
    final.subtype === 'error_max_turns'
      ? 'max-turns'
      : final.subtype === 'error_max_budget_usd'
        ? 'max-budget'
        : 'failed';
  const stopped = interrupted || reason === 'max-turns' || reason === 'max-budget';

  return {
    ...base,
    status: stopped ? 'stopped' : 'error',
    reason: interrupted ? 'interrupted' : reason,
    text: assistant,
    error: explain(reason, final.subtype, final.errors),
  };
}
