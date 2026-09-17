import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { splitFrontmatter } from './agents.js';
import { RoundCoordinator, type RoundJob, type RoundResult } from './distributed.js';
import { ConfigError } from './exit.js';
import { exportRoundBundle, importRoundBundle, redactSecrets } from './git.js';
import { enforceOwnership, snapshotOwnership, safePattern, candidateFingerprint } from './ownership.js';
import { reportChecks, verdictChecks } from './consistency.js';
import { loadPluginSources } from './plugin-dir.js';
import { createSession, type Session, type SessionTransport, type SessionResult } from './session.js';
import { DEFAULT_MODEL_CHOICE } from './models.js';

/** Match the issue runner's environment boundary, on every worker. */
export function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set(['github_token', 'gh_token', 'gh_enterprise_token', 'github_enterprise_token', 'exolvra_genesis_coordinator']);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !blocked.has(key.toLowerCase())));
}

export async function verification(command: string, cwd: string, env = process.env): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    // Only the lead-authored Task Spec supplies this verbatim command.
    const child = spawn(command, { cwd, env: workerEnvironment(env), shell: true, windowsHide: true });
    let output = '', bytes = 0;
    const add = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { child.kill(); reject(new ConfigError('verification output exceeded 16 MiB')); return; }
      output += chunk.toString();
    };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', reject);
    child.on('exit', code => resolve({ code: code ?? 1, output: redactSecrets(output) }));
  });
}

export interface WorkerExecution {
  coordinator: RoundCoordinator; job: RoundJob; workRoot: string;
  env?: NodeJS.ProcessEnv; transport?: SessionTransport;
  onSession?: (session: Session | undefined) => void;
}
export async function executeRound(options: WorkerExecution): Promise<RoundResult> {
  const { coordinator, job, workRoot } = options;
  if (!job.token) throw new ConfigError('worker has no round claim');
  const env = workerEnvironment(options.env ?? process.env), sources = loadPluginSources(env);
  mkdirSync(workRoot, { recursive: true });
  const workspace = mkdtempSync(join(workRoot, 'round-'));
  const payload = job.payload, role = payload.role;
  try {
    importRoundBundle(coordinator.bundlePath(payload.base), workspace, payload.base);
    const barPath = join(workspace, '.exolvra-genesis', 'bar');
    for (const asset of payload.barAssets ?? []) {
      const relative = safePattern(asset.path);
      if (/[?*]/.test(relative)) throw new ConfigError('invalid bar asset path');
      const bytes = Buffer.from(asset.bytes, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== asset.digest) throw new ConfigError('bar asset hash mismatch: ' + relative);
      const path = join(barPath, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    }
    const before = snapshotOwnership(workspace, role === 'builder' ? payload.scratch : undefined);
    const prompt = splitFrontmatter(role === 'builder' ? sources.builderMd : sources.criticMd).body + '\n\n' +
      (role === 'builder' ? payload.task : 'BAR\n' + payload.bar + '\n\nPINNED SHA\n' + payload.base.sha) +
      ((payload.barAssets?.length ?? 0) ? '\n\nPinned bar files are available at ' + barPath : '');
    const continuity = join(workRoot, 'runs', job.run, 'builders', job.piece + '.json');
    mkdirSync(dirname(continuity), { recursive: true });
    let previous: { model: string; session: string; task?: string; rounds?: number; sessionRounds?: number } | undefined;
    if (role === 'builder' && existsSync(continuity)) {
      try { previous = JSON.parse(readFileSync(continuity, 'utf8')); } catch { /* Broken contexts start cold. */ }
    }
    let spent = 0;
    const query = async (text: string, resume?: string): Promise<SessionResult> => {
      const remaining = payload.maxBudgetUsd === undefined ? undefined : payload.maxBudgetUsd - spent;
      if (remaining !== undefined && remaining <= 0) throw new ConfigError('distributed round budget exhausted');
      const session = createSession({ prompt: text, sources, models: { ...DEFAULT_MODEL_CHOICE, lead: payload.model }, cwd: workspace,
        env, subagents: false, maxBudgetUsd: remaining, transport: options.transport,
        hooks: { onMessage(message) {
          if (message.type === 'result') {
            const usage = (message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
            coordinator.event(job.id, job.token!, 'budget_spend', { costUsd: message.total_cost_usd, attribution: 'round', inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 });
          }
        } },
      });
      options.onSession?.(session);
      const result = resume ? await session.resume(resume) : await session.start(); spent += result.costUsd; return result;
    };
    const poisoned = role === 'builder' && payload.coldStart && (previous?.sessionRounds ?? 0) >= 2;
    const resume = role === 'builder' && !poisoned && previous?.model === payload.model ? previous.session : undefined;
    const delta = role === 'builder' && previous?.task !== undefined ? payload.task.split('\n').filter(line => !previous.task!.split('\n').includes(line)).join('\n') : '';
    const continuation = role === 'builder' ? 'Continue the same piece in the pinned checkout ' + workspace + ' at ' + payload.base.sha + '.\nTask Spec additions or changes:\n' + (delta || 'unchanged') + '\nLatest batched feedback:\n' + (payload.feedback ?? 'Apply the current round request.') : prompt;
    coordinator.event(job.id, job.token, 'process_event', { action: 'opened', role, continuation: Boolean(resume), reason: resume ? null : poisoned ? 'poisoned-context' : previous ? 'model-change' : 'first-or-unavailable-session' });
    let result: SessionResult;
    let cold = !resume;
    try {
      result = await query(resume ? continuation : prompt, resume);
      if (resume && result.status === 'error') throw new ConfigError(result.error ?? 'builder session unavailable');
    }
    catch (error) {
      if (!resume) throw error;
      cold = true;
      coordinator.event(job.id, job.token, 'process_event', { action: 'opened', role, continuation: false, reason: 'dead-session' });
      result = await query(prompt);
    }
    let ownership = enforceOwnership(before, role === 'builder' ? payload.files : []);
    for (let correction = 0; ; correction++) {
      if (result.status !== 'complete') {
        if (role === 'builder') rmSync(continuity, { force: true });
        throw new ConfigError(result.error ?? 'round session ' + result.reason);
      }
      if (ownership.violations.length) {
        if (role === 'builder') rmSync(continuity, { force: true });
        throw new ConfigError('ownership breach: ' + ownership.violations.join(', ') + '; ' + ownership.unrecoverable.join('; '));
      }
      const checks = role === 'critic' ? verdictChecks(result.text) : reportChecks(workspace, result.text, payload.verify, ownership!.touched);
      coordinator.event(job.id, job.token, 'gate_check', { gate: 'report-consistency', passed: checks.every(c => c.passed), checks });
      const errors = checks.filter(c => !c.passed);
      if (!errors.length) break;
      if (correction >= 3) throw new ConfigError('consistency corrections exhausted: ' + errors.map(c => c.violation).join('; '));
      result = await query((role === 'builder' && result.sessionId ? '' : prompt) + '\n\nCorrect these report consistency violations in this same round: ' + errors.map(c => c.violation).join('; ') + '\nPrevious report:\n' + result.text, role === 'builder' ? result.sessionId : undefined);
      ownership = enforceOwnership(before, role === 'builder' ? payload.files : []);
    }
    if (role === 'critic') return { text: result.text, costUsd: spent };
    const bundle = join(workspace, '.git', 'output.bundle');
    const pin = exportRoundBundle(workspace, bundle, job.run, job.piece, job.round);
    coordinator.putBundle(bundle, pin, { id: job.id, token: job.token });
    if (result.sessionId) writeFileSync(continuity, JSON.stringify({ model: payload.model, session: result.sessionId, task: payload.task, rounds: (previous?.rounds ?? 0) + 1, sessionRounds: cold ? 1 : (previous?.sessionRounds ?? 0) + 1 }));
    return { text: result.text + '\n\nBUILT SHA: ' + pin.sha, pin, files: ownership!.touched,
      ownership: { passed: true, violations: [] }, costUsd: spent, sessionId: result.sessionId };
  } finally {
    options.onSession?.(undefined);
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Lead verification runs against the exact received tree before any judging. */
export async function verifyBuiltRound(coordinator: RoundCoordinator, id: string, workRoot = tmpdir(), env = process.env): Promise<{ cwd: string; output: string; job: RoundJob }> {
  const job = coordinator.get(id);
  if (job.status !== 'complete' || job.payload.role !== 'builder' || !job.result?.pin || !job.result.ownership?.passed) throw new ConfigError('round has no successful pinned builder report');
  const cwd = mkdtempSync(join(workRoot, 'genesis-verify-'));
  try {
    importRoundBundle(coordinator.bundlePath(job.result.pin), cwd, job.result.pin);
    const before = snapshotOwnership(cwd, job.payload.scratch);
    const check = await verification(job.payload.verify, cwd, env);
    const mutation = enforceOwnership(before, []);
    if (mutation.violations.length) throw new ConfigError('verification mutated the pinned tree: ' + mutation.violations.join(', '));
    if (check.code !== 0) throw new ConfigError('lead verification exited ' + check.code + '\n' + check.output);
    coordinator.verified(id, job.result.pin.sha, candidateFingerprint(cwd, job.payload.scratch));
    return { cwd, output: check.output, job: coordinator.get(id) };
  } catch (error) {
    rmSync(cwd, { recursive: true, force: true });
    coordinator.rejectVerification(id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
