import type {
  Options,
  PermissionMode,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { buildAgentDefinitions } from './agents.js';
import { ConfigError } from './exit.js';
import type { ModelChoice, ModelSource } from './models.js';
import { DEFAULT_MODEL_CHOICE, MODEL_INHERIT, canonicalModel, modelFault, modelResolutionError, providerDetail } from './models.js';
import type { PluginSources } from './plugin-dir.js';
import { createRoundGuards, settleRoundGuards } from './round-guards.js';
import { watchRunStop } from './run-control.js';
import type { TraceStore } from './trace-store.js';
import { createLiveMonitor, stallThresholds, type LiveBudget, type LivePhase } from './live-status.js';
import { randomUUID } from 'node:crypto';
import { EXECUTION_PROBE_MAX_COST_USD, EXECUTION_PROBE_PREFIX, executionPreflightError, preflightSpendDetail, type ExecutionPreflight, type ExecutionProbeResult } from './preflight.js';

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
  runId?: string;
  trace?: TraceStore;
  /** Current invocation budget, including preflight and previous SDK turns. */
  budget?: () => LiveBudget;
  /** The lead prompt, already rendered from the plugin markdown. */
  prompt: string;
  sources: PluginSources;
  models: ModelChoice;
  modelSource?: ModelSource;
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
  /** Restrict the tool surface for bounded capability probes. */
  tools?: Options['tools'];
  /** The sole command a capability probe may execute, at most once. */
  probeCommand?: string;
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
  let resolvedModel: string | undefined;
  const modelRequest = () => ({ lead: opts.models.lead, source: opts.modelSource, env: opts.env, resolvedModel });

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
    if (options.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    if (opts.tools !== undefined) options.tools = opts.tools;
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
    if (opts.runId !== undefined) options.hooks = createRoundGuards(opts.cwd, opts.runId, opts.models.builder, opts.trace);
    if (opts.probeCommand !== undefined) {
      let used = false;
      options.hooks = { PreToolUse: [{ hooks: [async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const args = input.tool_input as { command?: unknown; dangerouslyDisableSandbox?: unknown; run_in_background?: unknown };
        if (!used && input.tool_name === 'Bash' && args.command === opts.probeCommand &&
            args.dangerouslyDisableSandbox !== true && args.run_in_background !== true) {
          used = true;
          // No "allow" decision: the real session permission policy still applies.
          return {};
        }
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'A permission probe may execute only its one exact no-op command.' } };
      }] }] };
    }
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
    const usageIds = new Set<string>();
    const monitor = opts.runId !== undefined && opts.trace !== undefined
      ? createLiveMonitor(opts.cwd, opts.runId, opts.trace, opts.maxBudgetUsd, stallThresholds(opts.env), opts.budget) : undefined;
    const releaseControl = opts.runId === undefined ? undefined : watchRunStop(opts.cwd, opts.runId);

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
        if (message.type === 'system' && message.subtype === 'init') resolvedModel = message.model;
        // The SDK sometimes reports a 404 as assistant text and ends with a
        // successful result. Classify it before hooks can print an ANSWER block.
        const prose = assistantText(message);
        const diagnostics = message.type === 'result'
          ? message.subtype === 'success' ? (/^\s*API Error:/i.test(message.result) ? [message.result] : []) : message.errors
          : message.type === 'assistant' && (message.error !== undefined || /^\s*API Error:/i.test(prose)) ? [prose] : [];
        for (const diagnostic of diagnostics) {
          const fault = modelResolutionError(diagnostic, modelRequest());
          if (fault !== undefined) {
            if (message.type === 'result') Object.assign(fault, { sessionUsage: {
              costUsd: message.total_cost_usd,
              inputTokens: message.usage?.input_tokens ?? 0,
              outputTokens: message.usage?.output_tokens ?? 0,
            } });
            if (message.type === 'result') {
              // Keep the provider's accounting observable while withholding
              // its raw API text from every renderer and transcript hook.
              opts.hooks?.onMessage(message.subtype === 'success' ? { ...message, result: '' } : { ...message, errors: [] });
              monitor?.spend(message.total_cost_usd);
            }
            throw fault;
          }
        }
        opts.hooks?.onMessage(message);
        let phase: LivePhase | undefined;
        let activityPiece: string | undefined, activityRound: number | undefined;
        const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
        if (parent) {
          const agent = opts.trace?.processes().find((p) => p.taskId === parent);
          if (agent) { phase = agent.role; activityPiece = agent.piece ?? undefined; activityRound = agent.round ?? undefined; }
        }
        if (message.type === 'assistant' && Array.isArray(message.message.content)) {
          const usage = message.message.usage;
          const id = message.message.id;
          if (usage && id && !usageIds.has(id)) {
            usageIds.add(id); monitor?.tokens(usage.input_tokens, usage.output_tokens);
          }
          for (const block of message.message.content) {
            if (block.type !== 'tool_use') continue;
            if (block.name === 'Bash') phase = 'verification';
            if (block.name === 'Task' || block.name === 'Agent') {
              const role = String((block.input as { subagent_type?: unknown }).subagent_type ?? '');
              phase = role.includes('builder') ? 'builder' : role.includes('critic') ? 'critic' : 'lead';
            }
          }
        } else if (message.type === 'user') phase = 'lead';
        monitor?.activity(assistantText(message) || message.type, phase, activityPiece, activityRound);
        if (message.type === 'result') monitor?.spend(message.total_cost_usd);
        if (message.type === 'assistant') assistant.push(assistantText(message));
        if (message.type === 'result') final = message;
      }
    } catch (error) {
      const text = joinText(assistant);
      if (interrupted) return toResult(undefined, text, sessionId, true);
      if (error instanceof ConfigError) throw error;
      const modelError = modelResolutionError(error, modelRequest());
      if (modelError !== undefined) throw modelError;
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
      try {
        settleRoundGuards(options.hooks);
      } finally {
        releaseControl?.();
        monitor?.close();
        for (const signal of STOP_SIGNALS) process.removeListener(signal, stop);
        stream = undefined;
      }
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

export interface ExecutionPreflightOptions {
  cwd: string;
  sources: PluginSources;
  models?: ModelChoice;
  modelSource?: ModelSource;
  permissionMode: PermissionMode;
  env?: NodeJS.ProcessEnv;
  isTTY: boolean;
  /** Called at most once, and never in a headless invocation. */
  confirmBypass?: () => Promise<boolean>;
  /** Requested provider budget across attempts, capped at ten cents; actual spend is recorded. */
  maxBudgetUsd?: number;
  transport?: SessionTransport;
}

/**
 * Execute one harmless Bash command through the same SDK permission machinery
 * as the lead. The user authorised this small model-backed query because SDK
 * 0.1.x has no public zero-token execute-tool endpoint. Only a matched tool
 * result proves capability; settings, model prose, and local shells do not.
 */
export async function preflightExecution(opts: ExecutionPreflightOptions): Promise<ExecutionPreflight> {
  const receipt: ExecutionPreflight = { permissionMode: opts.permissionMode, attempts: [], costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const ceiling = Math.min(opts.maxBudgetUsd ?? EXECUTION_PROBE_MAX_COST_USD, EXECUTION_PROBE_MAX_COST_USD);
  const probe = async (mode: PermissionMode): Promise<ExecutionProbeResult> => {
    const marker = 'genesis-preflight-' + randomUUID();
    const command = "printf '%s\\n' '" + marker + "'";
    const attempt: ExecutionProbeResult = { mode, capability: 'command-execution', command, outcome: 'unavailable', detail: 'the SDK returned no successful command result; execution is unverified', costUsd: 0, inputTokens: 0, outputTokens: 0, usageReported: false };
    if (!Number.isFinite(ceiling) || ceiling <= receipt.costUsd) {
      attempt.detail = 'the permission probe has no remaining cost budget';
      attempt.usageReported = true; // No query was made, so zero is known.
      return attempt;
    }
    const toolIds = new Set<string>();
    let verified = false;
    let denied = false;
    const session = createSession({
      cwd: opts.cwd, sources: opts.sources, models: opts.models ?? DEFAULT_MODEL_CHOICE,
      modelSource: opts.modelSource, env: opts.env, transport: opts.transport,
      permissionMode: mode, subagents: false, tools: ['Bash'], probeCommand: command, maxTurns: 2,
      maxBudgetUsd: ceiling - receipt.costUsd,
      prompt: EXECUTION_PROBE_PREFIX +
        'Execute exactly this harmless Bash command once, then stop. Do not inspect or change any files. ' +
        'If execution is denied, stop without attempting alternatives. This is a capability check, not a build.\n' + command,
      hooks: { onMessage(message): void {
        if (message.type === 'result') {
          attempt.usageReported = true;
          attempt.costUsd = message.total_cost_usd;
          attempt.inputTokens = message.usage?.input_tokens ?? 0;
          attempt.outputTokens = message.usage?.output_tokens ?? 0;
          if (message.permission_denials?.some((entry) => entry.tool_name === 'Bash')) denied = true;
        }
        if (message.type !== 'assistant' && message.type !== 'user') return;
        const content = message.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Bash' && (block.input as { command?: unknown }).command === command) toolIds.add(block.id);
          if (block.type !== 'tool_result' || !toolIds.has(block.tool_use_id)) continue;
          const output = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
            ? block.content.map((item: { type: string; text?: string }) => item.type === 'text' ? item.text ?? '' : '').join('\n') : '';
          if (block.is_error === true) {
            denied = /permission|denied|not allowed|not permitted/i.test(output);
            attempt.detail = providerDetail(output, opts.env);
          } else if (output.trim() === marker) verified = true;
        }
      } },
    });
    let result: SessionResult;
    try {
      result = await session.start();
    } catch (error) {
      // A model or startup refusal still owns every cost already reported by
      // its SDK query. Preserve the original house-shaped invocation error.
      const usage = (error as { sessionUsage?: { costUsd: number; inputTokens: number; outputTokens: number } }).sessionUsage;
      if (usage) {
        attempt.usageReported = true;
        attempt.costUsd = Math.max(attempt.costUsd, usage.costUsd);
        attempt.inputTokens = Math.max(attempt.inputTokens, usage.inputTokens);
        attempt.outputTokens = Math.max(attempt.outputTokens, usage.outputTokens);
      }
      attempt.detail = providerDetail(error instanceof Error ? error.message : String(error), opts.env);
      receipt.attempts.push(attempt);
      receipt.costUsd += attempt.costUsd;
      receipt.inputTokens += attempt.inputTokens;
      receipt.outputTokens += attempt.outputTokens;
      if (error instanceof Error) {
        Object.assign(error, { preflight: receipt });
        const spend = preflightSpendDetail(receipt);
        error.message = error.message.includes('\n  usage:')
          ? error.message.replace('\n  usage:', '\n' + spend + '\n  usage:')
          : error.message + '\n' + spend;
      }
      throw error;
    }
    attempt.costUsd = Math.max(attempt.costUsd, result.costUsd);
    if (result.reason === 'interrupted') {
      attempt.interrupted = true;
      attempt.detail = 'the permission probe was interrupted; no build was started';
    } else if (verified && result.status === 'complete') {
      attempt.outcome = 'allowed';
      attempt.detail = 'the SDK Bash tool executed the no-op and returned its expected marker';
    } else if (denied) {
      attempt.outcome = 'denied';
      attempt.detail = 'the SDK denied the Bash command under the effective session permissions';
    } else if (result.error) attempt.detail = providerDetail(result.error, opts.env);
    return attempt;
  };
  for (let pass = 0; pass < 2; pass += 1) {
    const attempt = await probe(receipt.permissionMode);
    receipt.attempts.push(attempt);
    receipt.costUsd += attempt.costUsd;
    receipt.inputTokens += attempt.inputTokens;
    receipt.outputTokens += attempt.outputTokens;
    if (attempt.outcome === 'allowed') return receipt;
    if (pass === 0 && !attempt.interrupted && attempt.usageReported && receipt.permissionMode !== 'bypassPermissions' && opts.isTTY) {
      let consent = false;
      try {
        consent = await opts.confirmBypass?.() ?? false;
      } catch (error) {
        if (error instanceof Error) Object.assign(error, { preflight: receipt });
        throw error;
      }
      if (consent) {
        receipt.permissionMode = 'bypassPermissions';
        continue;
      }
    }
    throw executionPreflightError(attempt, receipt);
  }
  throw executionPreflightError(receipt.attempts[receipt.attempts.length - 1]!, receipt);
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
