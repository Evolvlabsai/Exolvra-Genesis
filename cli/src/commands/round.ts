import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { type Command, type ValueFlagSpec, type ValueType, directoryValue, countValue, choiceValue, parseInvocation, registerCommand } from '../registry.js';
import { ConfigError, EXIT, UsageError } from '../exit.js';
import { PROGRAM, renderCommandHelp } from '../usage.js';
import { RoundCoordinator, validIdentity, validCapability, type RoundJob, type BarAsset } from '../distributed.js';
import { exportRoundBundle } from '../git.js';
import { isKnownModel } from '../models.js';
import { verifyBuiltRound } from '../distributed-worker.js';
import { identityValue } from './daemon.js';
import { openTrace } from '../trace-store.js';
import { toRecord, TRACE_EVENT_KINDS, type TraceEvent } from '../trace-events.js';
import { reportSections } from '../consistency.js';
import { guardDistributedBuilder, recordDistributedFindings } from '../distributed-guards.js';
import { trackVerificationCheckout } from '../distributed-lead.js';

const fileValue: ValueType<string> = { arg: 'file', invalid: 'exolvra-genesis-invalid-value-probe', parse(raw, ctx) {
  const path = resolve(ctx.cwd, raw); if (!existsSync(path)) throw new UsageError('invalid value "' + raw + '" for ' + ctx.flag + ': file does not exist', ctx.usage); return path;
} };
const jobValue: ValueType<string> = { arg: 'id', invalid: '../bad', parse(raw, ctx) { if (!/^[a-f0-9-]{36}$/.test(raw)) throw new UsageError('invalid value "' + raw + '" for ' + ctx.flag + ': expected a round id', ctx.usage); return raw; } };
const action: ValueFlagSpec<string> = { long: 'action', value: choiceValue('action', ['build', 'verify', 'judge', 'status', 'cleanup']), summary: 'Round transport operation' };
const coordinator: ValueFlagSpec<string> = { long: 'coordinator', value: directoryValue, summary: 'Existing authenticated shared coordinator directory' };
const directory: ValueFlagSpec<string> = { long: 'directory', short: 'C', value: directoryValue, summary: 'Lead project directory' };
const request: ValueFlagSpec<string> = { long: 'request', value: fileValue, summary: 'Lead-authored Task Spec transport JSON' };
const jobFlag: ValueFlagSpec<string> = { long: 'job', value: jobValue, summary: 'Previously dispatched builder or critic round' };
const run: ValueFlagSpec<string> = { long: 'run', value: identityValue, summary: 'Run to clean up after settling' };
const wait: ValueFlagSpec<number> = { long: 'wait-seconds', value: countValue, default: 3600, summary: 'Maximum time to wait for execution' };
interface BuildRequest { run: string; piece: string; round: number; task: string; files: string[]; verify: string; bar: string; barDirectory?: string; requirements: string[]; model: string; criticModel?: string; criticRequirements?: string[]; maxBudgetUsd?: number; scratch?: string[]; feedback?: string }
function barAssets(path: string): BarAsset[] {
  const result: BarAsset[] = []; let total = 0;
  const visit = (root: string, prefix: string): void => {
    if (lstatSync(root).isSymbolicLink()) throw new ConfigError('bar capture cannot traverse symbolic links');
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const name = prefix + entry.name, full = join(root, entry.name);
      if (entry.isSymbolicLink()) throw new ConfigError('bar capture cannot include symbolic links');
      if (entry.isDirectory()) visit(full, name + '/');
      else if (entry.isFile()) {
        const bytes = readFileSync(full); total += bytes.length;
        if (total > 64 * 1024 * 1024) throw new ConfigError('bar capture exceeds 64 MiB');
        result.push({ path: name, bytes: bytes.toString('base64'), digest: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  };
  visit(path, ''); return result;
}
function readRequest(path: string): BuildRequest {
  const value = JSON.parse(readFileSync(path, 'utf8')) as BuildRequest;
  if (!value || !validIdentity(value.run) || !validIdentity(value.piece) || !Number.isSafeInteger(value.round) || value.round < 1 || typeof value.task !== 'string' || !value.task.trim() || typeof value.verify !== 'string' || !value.verify.trim() || typeof value.bar !== 'string' || !value.bar.trim() || !Array.isArray(value.files) || !value.files.length || !value.files.every(p => typeof p === 'string' && p.length > 0) || !Array.isArray(value.requirements) || !value.requirements.every(validCapability) || !isKnownModel(value.model)) throw new ConfigError('invalid distributed Task Spec request');
  if (value.criticModel !== undefined && !isKnownModel(value.criticModel)) throw new ConfigError('invalid critic model');
  if (value.criticRequirements !== undefined && (!Array.isArray(value.criticRequirements) || !value.criticRequirements.every(validCapability))) throw new ConfigError('invalid critic capabilities');
  if (value.maxBudgetUsd !== undefined && (typeof value.maxBudgetUsd !== 'number' || !Number.isFinite(value.maxBudgetUsd) || value.maxBudgetUsd <= 0)) throw new ConfigError('invalid distributed round maxBudgetUsd');
  if (value.scratch !== undefined && (!Array.isArray(value.scratch) || !value.scratch.every(s => typeof s === 'string'))) throw new ConfigError('invalid task scratch paths');
  if (value.feedback !== undefined && typeof value.feedback !== 'string') throw new ConfigError('invalid builder feedback');
  return value;
}
async function waitFor(queue: RoundCoordinator, initial: RoundJob, seconds: number, cwd: string, warn: (message: string) => void): Promise<RoundJob> {
  const trace = openTrace(cwd, initial.run, warn);
  try {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const job = queue.get(initial.id);
      for (const event of queue.drainEvents(initial.run)) {
        if (!(event.kind in TRACE_EVENT_KINDS)) throw new ConfigError('unknown worker trace event kind');
        trace.append(toRecord({ kind: event.kind, piece: event.piece, round: event.round, payload: event.payload } as TraceEvent, { runId: job.run, at: event.at }));
      }
      if (!['claimed', 'queued'].includes(job.status)) return job;
      if (Date.now() >= deadline) { warn('Distributed round wait expired; round remains ' + job.status + ': ' + job.id); return job; }
      await new Promise(r => setTimeout(r, 500));
    }
  } finally { trace.close(); }
}
export const roundCommand: Command = {
  name: 'round', summary: 'Dispatch, verify, or judge a pinned distributed round', group: 'additional',
  usage: PROGRAM + ' round --coordinator dir --action action [flags]', flags: [action, coordinator, directory, request, jobFlag, run, wait], cwdFlag: directory,
  description: ['Transport only: the lead still follows commands/run.md. Build publishes a content-addressed base, waits for the worker report, and independently verifies its pinned tree. Judge accepts only a previously verified builder round and sends the bar and sha to a fresh critic on another machine.'],
  async run(argv, ctx) {
    const args = parseInvocation(roundCommand, argv, ctx);
    if (args.help) { ctx.stdout.write(renderCommandHelp(roundCommand)); return EXIT.WIN; }
    const root = args.get(coordinator), operation = args.get(action);
    if (!root || !operation) throw new UsageError('--coordinator and --action are required', roundCommand.usage);
    const queue = new RoundCoordinator(root);
    if (operation === 'cleanup') {
      const id = args.get(run); if (!id) throw new UsageError('--run is required', roundCommand.usage);
      queue.cleanup(id); ctx.stdout.write('Cleaned distributed run ' + id + '\n'); return EXIT.WIN;
    }
    let job: RoundJob;
    if (operation === 'build') {
      const path = args.get(request); if (!path) throw new UsageError('--request is required', roundCommand.usage);
      const value = readRequest(path), gate = guardDistributedBuilder(args.cwd, value.run, value), scratch = mkdtempSync(join(tmpdir(), 'genesis-publish-'));
      try {
        const bundle = join(scratch, 'base.bundle'), base = exportRoundBundle(args.cwd, bundle, value.run, value.piece, value.round);
        job = queue.publish({ run: value.run, piece: value.piece, round: value.round,
          requirements: [...new Set([...value.requirements, 'model:' + value.model])],
          payload: { role: 'builder', task: value.task, files: value.files, verify: value.verify, bar: value.bar, ...(value.barDirectory ? { barAssets: barAssets(resolve(args.cwd, value.barDirectory)) } : {}), base, model: value.model, criticModel: value.criticModel, criticRequirements: value.criticRequirements, maxBudgetUsd: value.maxBudgetUsd, scratch: value.scratch, feedback: value.feedback, coldStart: gate.coldStart } }, Date.now(), bundle);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    } else {
      const id = args.get(jobFlag); if (!id) throw new UsageError('--job is required', roundCommand.usage);
      job = queue.get(id);
      if (operation === 'judge') {
        if (!job.verified || !job.result?.pin || job.payload.role !== 'builder') throw new ConfigError('builder round must pass lead verification before judging');
        const model = job.payload.criticModel ?? job.payload.model;
        job = queue.publish({ run: job.run, piece: job.piece, round: job.round, candidate: job.candidate, requirements: [...new Set([...(job.payload.criticRequirements ?? job.requirements.filter(c => !c.startsWith('model:'))), 'model:' + model])], excludeMachine: job.machine,
          payload: { role: 'critic', bar: job.payload.bar, barAssets: job.payload.barAssets, base: job.result.pin, model, maxBudgetUsd: job.payload.maxBudgetUsd } });
      }
    }
    if (operation !== 'status' && operation !== 'verify') {
      ctx.stderr.write('Distributed round ' + job.id + '\n');
      job = await waitFor(queue, job, args.get(wait) ?? 3600, args.cwd, message => { ctx.stderr.write(message + '\n'); });
    }
    if ((operation === 'build' || operation === 'verify') && job.status === 'complete') {
      try {
        const verified = await verifyBuiltRound(queue, job.id, tmpdir(), ctx.env);
        trackVerificationCheckout(args.cwd, job.run, verified.cwd);
        ctx.stdout.write(JSON.stringify({ id: job.id, status: 'verified', sha: job.result?.pin?.sha, cwd: verified.cwd, files: job.result?.files, report: job.result?.text, verification: verified.output }) + '\n');
        return EXIT.WIN;
      } catch (error) {
        ctx.stdout.write(JSON.stringify({ id: job.id, status: 'failed', error: error instanceof Error ? error.message : String(error) }) + '\n');
        return EXIT.LOSS;
      }
    }
    const signals = job.payload.role === 'critic' && job.status === 'complete' && job.candidate && job.result ? recordDistributedFindings(args.cwd, job.run, job.piece, job.round, job.result.text, job.candidate) : [];
    ctx.stdout.write(JSON.stringify({ id: job.id, status: job.status, error: job.error, result: job.result, signals }) + '\n');
    const criticWin = job.payload.role !== 'critic' || reportSections(job.result?.text ?? '')['VERDICT']?.trim().startsWith('WIN');
    return job.status === 'complete' && criticWin ? EXIT.WIN : EXIT.LOSS;
  },
};
registerCommand(roundCommand);
