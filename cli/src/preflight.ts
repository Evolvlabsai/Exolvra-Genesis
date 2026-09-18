import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { ConfigError } from './exit.js';

/** Identifies a bounded SDK query; prose from the model is never proof. */
export const EXECUTION_PROBE_PREFIX = 'GENESIS_EXECUTION_PREFLIGHT\n';
export const EXECUTION_PROBE_MAX_COST_USD = 0.50;

export interface ExecutionProbeResult {
  mode: PermissionMode;
  capability: 'command-execution';
  command: string;
  outcome: 'allowed' | 'denied' | 'unavailable';
  detail: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** False when the SDK ended before providing a final usage receipt. */
  usageReported: boolean;
  interrupted?: boolean;
}

export interface ExecutionPreflight {
  permissionMode: PermissionMode;
  attempts: ExecutionProbeResult[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The full receipt is retained when the invocation is refused, so a caller can
 * account for the probe even though the build itself never started.
 */
export class ExecutionPreflightError extends ConfigError {
  constructor(message: string, readonly preflight: ExecutionPreflight) {
    super(message);
    this.name = 'ExecutionPreflightError';
  }
}

export function preflightSpendDetail(preflight: ExecutionPreflight): string {
  const known = preflight.attempts.every((attempt) => attempt.usageReported);
  return '  reported probe spend: $' + preflight.costUsd.toFixed(6) +
    (known ? '; tokens: ' + preflight.inputTokens + ' input, ' + preflight.outputTokens + ' output'
      : '; final usage unavailable');
}

export function preflightReceipt(error: unknown): ExecutionPreflight | undefined {
  if (!(error instanceof Error) || !('preflight' in error)) return undefined;
  const receipt = error.preflight as ExecutionPreflight | undefined;
  return receipt && Array.isArray(receipt.attempts) && Number.isFinite(receipt.costUsd) ? receipt : undefined;
}

export function executionPreflightError(result: ExecutionProbeResult, preflight: ExecutionPreflight): ConfigError {
  return new ExecutionPreflightError([
    result.outcome === 'denied'
      ? 'the session denied command execution in ' + result.mode + ' mode'
      : 'command execution could not be verified in ' + result.mode + ' mode',
    '  ' + result.detail,
    preflightSpendDetail(preflight),
    '  an unattended build must execute its verification commands',
    result.mode === 'bypassPermissions'
      ? '  bypassPermissions is already selected; check project rules and the command environment'
      : '  retry with --permission-mode bypassPermissions',
    '  usage: exolvra-genesis <run | resume | work> [arguments] --permission-mode bypassPermissions',
  ].join('\n'), preflight);
}
