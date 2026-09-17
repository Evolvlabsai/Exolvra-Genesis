/** Authenticated shared-directory coordinator. Workers only poll outbound. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError } from './exit.js';
import { DEFAULT_CLAIM_TTL_MS, MIN_CLAIM_TTL_MS } from './issue-run.js';
import { redactSecrets, type RoundBundle } from './git.js';
import { withLedgerLock, writeAtomic } from './runs-store.js';
import { isKnownModel } from './models.js';

export const DISTRIBUTED_ENV = 'EXOLVRA_GENESIS_COORDINATOR';
export interface Worker {
  id: string; name: string; machine: string; capabilities: string[];
  seen: number; registered: boolean; current: string | null;
}
export interface BuildPayload {
  role: 'builder'; task: string; files: string[]; verify: string;
  bar: string; barAssets?: BarAsset[]; base: RoundBundle; model: string; criticModel?: string; criticRequirements?: string[]; maxBudgetUsd?: number;
  scratch?: string[]; feedback?: string; coldStart?: boolean;
}
export interface BarAsset { path: string; bytes: string; digest: string }
export interface CriticPayload { role: 'critic'; bar: string; barAssets?: BarAsset[]; base: RoundBundle; model: string; maxBudgetUsd?: number }
export type RoundPayload = BuildPayload | CriticPayload;
export interface RoundResult {
  text: string; pin?: RoundBundle; files?: string[];
  ownership?: { passed: boolean; violations: string[] };
  costUsd: number; sessionId?: string;
}
export interface RoundJob {
  id: string; run: string; piece: string; round: number; created: number;
  status: 'queued' | 'claimed' | 'complete' | 'failed' | 'blocked';
  requirements: string[]; excludeMachine?: string; payload: RoundPayload;
  payloadDigest: string;
  owner?: string; machine?: string; token?: string; heartbeat?: number;
  retiredToken?: string; cancellationAcknowledged?: boolean;
  retiredClaims?: { token: string; worker: string; acknowledged: boolean }[];
  attempt: number; result?: RoundResult; error?: string; verified?: boolean;
  candidate?: string;
  events: { at: number; kind: string; payload: Record<string, unknown> }[];
  traceCursor?: number;
}
interface QueueState { version: 1; ttl: number; workers: Worker[]; machines: string[]; jobs: RoundJob[]; budgets?: Record<string, number>; settledCosts?: Record<string, number> }
export const validIdentity = (s: string): boolean => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(s);
export const validCapability = (s: string): boolean => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,100}$/.test(s);
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const safe = (value: unknown): string => redactSecrets(JSON.stringify(value)).replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
const jobsCost = (jobs: RoundJob[]): number => jobs.reduce((sum, job) => sum + job.events.filter(e => e.kind === 'budget_spend').reduce((cost, event) => cost + (typeof event.payload['costUsd'] === 'number' && Number.isFinite(event.payload['costUsd']) && event.payload['costUsd'] >= 0 ? event.payload['costUsd'] : 0), 0), 0);
const settledCost = (state: QueueState, run: string): number => state.settledCosts && Object.hasOwn(state.settledCosts, run) ? state.settledCosts[run] ?? 0 : 0;
const pendingReceipt = (job: RoundJob): boolean => Boolean(job.retiredToken && !job.cancellationAcknowledged) || Boolean(job.retiredClaims?.some(claim => !claim.acknowledged));
/** Revocation fences all work immediately, while leaving final billing open. */
function retireClaim(job: RoundJob): void {
  if (!job.token || !job.owner) return;
  job.retiredClaims ??= [];
  job.retiredClaims.push({ token: job.token, worker: job.owner, acknowledged: false });
  delete job.token;
}

export class RoundCoordinator {
  readonly root: string;
  readonly ttl: number;
  constructor(root: string, ttl?: number) {
    this.root = resolve(root);
    for (let path = this.root; ; path = dirname(path)) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ConfigError('coordinator path traverses a symbolic link: ' + path);
      if (dirname(path) === path) break;
    }
    const statePath = join(this.root, 'rounds.json');
    if (existsSync(statePath) && lstatSync(statePath).isSymbolicLink()) throw new ConfigError('coordinator state is a symbolic link');
    const persisted: number | undefined = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as QueueState).ttl : undefined;
    this.ttl = ttl ?? persisted ?? DEFAULT_CLAIM_TTL_MS;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < MIN_CLAIM_TTL_MS) throw new ConfigError('round claim TTL must be at least 60 seconds');
    if (persisted !== undefined && persisted !== this.ttl) throw new ConfigError('coordinator claim TTL differs from the registered fleet');
    const bundles = join(this.root, 'bundles');
    if (existsSync(bundles) && lstatSync(bundles).isSymbolicLink()) throw new ConfigError('coordinator bundles directory is a symbolic link');
    mkdirSync(bundles, { recursive: true });
  }
  private read(): QueueState {
    const path = join(this.root, 'rounds.json');
    if (!existsSync(path)) return { version: 1, ttl: this.ttl, workers: [], machines: [], jobs: [] };
    const state = JSON.parse(readFileSync(path, 'utf8')) as QueueState;
    if (state.version !== 1 || !Array.isArray(state.workers) || !Array.isArray(state.jobs) || !Array.isArray(state.machines)) throw new ConfigError('invalid coordinator state');
    if (state.settledCosts !== undefined && (!state.settledCosts || typeof state.settledCosts !== 'object' || Array.isArray(state.settledCosts) || Object.entries(state.settledCosts).some(([run, cost]) => !validIdentity(run) || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0))) throw new ConfigError('invalid coordinator spend state');
    if (!state.machines.every(m => typeof m === 'string' && validIdentity(m)) || state.workers.some(w => !w || !validIdentity(w.id) || !validIdentity(w.machine) || typeof w.name !== 'string' || !Array.isArray(w.capabilities) || !w.capabilities.every(c => typeof c === 'string' && validCapability(c)) || !Number.isFinite(w.seen) || typeof w.registered !== 'boolean' || (w.current !== null && typeof w.current !== 'string'))) throw new ConfigError('invalid coordinator worker state');
    if (state.jobs.some(j => !j || !/^[a-f0-9-]{36}$/.test(j.id) || !validIdentity(j.run) || !validIdentity(j.piece) || !Number.isSafeInteger(j.round) || j.round < 1 || !['queued','claimed','complete','failed','blocked'].includes(j.status) || !Array.isArray(j.requirements) || !j.requirements.every(c => typeof c === 'string' && validCapability(c)) || !j.payload || !['builder','critic'].includes(j.payload.role) || !isKnownModel(j.payload.model) || !j.payload.base || typeof j.payload.bar !== 'string' || !/^[a-f0-9]{64}$/.test(j.payloadDigest) || !Array.isArray(j.events))) throw new ConfigError('invalid coordinator round state');
    if (state.jobs.some(j => j.retiredClaims !== undefined && (!Array.isArray(j.retiredClaims) || j.retiredClaims.some(c => !c || !/^[a-f0-9-]{36}$/.test(c.token) || !validIdentity(c.worker) || typeof c.acknowledged !== 'boolean')))) throw new ConfigError('invalid coordinator retired claim state');
    return state;
  }
  private change<T>(fn: (state: QueueState) => T): T {
    return withLedgerLock(this.root, () => {
      const state = this.read(), result = fn(state);
      writeAtomic(join(this.root, 'rounds.json'), safe(state) + '\n');
      return result;
    });
  }
  workers(now = Date.now()): (Worker & { live: boolean })[] {
    return this.read().workers.map(w => ({ ...w, live: w.registered && now - w.seen < this.ttl }));
  }
  register(worker: Omit<Worker, 'seen' | 'registered' | 'current'>, now = Date.now()): void {
    if (!validIdentity(worker.id) || !validIdentity(worker.machine) || !worker.name.trim() || !worker.capabilities.every(validCapability)) throw new ConfigError('invalid worker registration');
    this.change(state => {
      const old = state.workers.find(w => w.id === worker.id);
      if (old?.registered && now - old.seen < this.ttl) throw new ConfigError('worker identity already has a live daemon: ' + worker.id);
      const next = { ...worker, seen: now, registered: true, current: null };
      state.workers = [...state.workers.filter(w => w.id !== worker.id), next];
      if (!state.machines.includes(worker.machine)) state.machines.push(worker.machine);
    });
  }
  heartbeat(worker: string, capabilities?: string[], now = Date.now()): boolean {
    return this.change(state => {
      const row = state.workers.find(w => w.id === worker && w.registered);
      if (!row) return false;
      if (capabilities !== undefined) {
        if (!capabilities.every(validCapability)) throw new ConfigError('invalid worker capabilities');
        row.capabilities = capabilities;
      }
      row.seen = now;
      const job = state.jobs.find(j => j.id === row.current && j.status === 'claimed' && j.owner === row.id);
      if (row.current && !job) { row.current = null; return false; }
      if (job) {
        const missing = job.requirements.filter(c => !row.capabilities.includes(c));
        if (missing.length) { retireClaim(job); job.status = 'blocked'; job.error = 'missing capability: ' + missing.join(', '); row.current = null; return false; }
        if (now - (job.heartbeat ?? 0) >= this.ttl) return false;
        job.heartbeat = now;
      }
      return true;
    });
  }
  deregister(worker: string): void {
    this.change(state => { const row = state.workers.find(w => w.id === worker); if (row) row.registered = false; });
  }
  private recover(state: QueueState, now: number): void {
    for (const job of state.jobs) if (job.status === 'claimed' && now - (job.heartbeat ?? 0) >= this.ttl) {
      retireClaim(job);
      job.status = job.attempt < 2 ? 'queued' : 'failed';
      job.error = 'worker heartbeat expired' + (job.attempt >= 2 ? '; retry limit reached' : '; redispatched');
      job.events.push({ at: now, kind: 'error_path', payload: { fault: 'worker-died', attempt: job.attempt } });
      const old = state.workers.find(w => w.id === job.owner);
      if (old?.current === job.id) old.current = null;
      delete job.owner; delete job.token; delete job.heartbeat;
    }
  }
  publish(input: Omit<RoundJob, 'id' | 'created' | 'status' | 'attempt' | 'events' | 'payloadDigest'>, now = Date.now(), bundleSource?: string): RoundJob {
    if (!validIdentity(input.run) || !validIdentity(input.piece) || !Number.isSafeInteger(input.round) || input.round < 1 || !input.requirements.every(validCapability)) throw new ConfigError('invalid distributed round');
    if (!isKnownModel(input.payload.model) || (input.payload.maxBudgetUsd !== undefined && (!Number.isFinite(input.payload.maxBudgetUsd) || input.payload.maxBudgetUsd <= 0))) throw new ConfigError('invalid distributed model or budget');
    let staged: string | undefined;
    if (bundleSource !== undefined) {
      const bytes = readFileSync(bundleSource);
      if (digest(bytes) !== input.payload.base.digest) throw new ConfigError('round bundle hash mismatch');
      staged = this.bundlePath(input.payload.base) + '.' + randomUUID() + '.tmp';
      // Copying bytes happens outside the ledger lock; only rename and queue
      // publication share the short transaction below.
      try { writeFileSync(staged, bytes); } catch (error) { rmSync(staged, { force: true }); throw error; }
    }
    try { return this.change(state => {
      if (input.payload.role === 'critic' && !state.jobs.some(j => j.run === input.run && j.piece === input.piece && j.round === input.round && j.payload.role === 'builder' && j.status === 'complete' && j.verified && j.result?.pin?.sha === input.payload.base.sha && j.result.pin.digest === input.payload.base.digest && j.machine === input.excludeMachine)) throw new ConfigError('critic dispatch requires a lead-verified builder sha and machine');
      const live = state.workers.filter(w => w.registered && now - w.seen < this.ttl);
      const candidates = live.filter(w => input.requirements.every(c => w.capabilities.includes(c)) && (state.machines.length === 1 || w.machine !== input.excludeMachine));
      const payload = JSON.parse(safe(input.payload)) as RoundPayload;
      const remaining = state.budgets?.[input.run];
      if (remaining !== undefined) {
        const reserved = state.jobs.filter(j => j.run === input.run && ['queued','claimed'].includes(j.status)).reduce((sum, j) => sum + (j.payload.maxBudgetUsd ?? 0), 0);
        const available = Math.max(0, remaining - reserved);
        if (available <= 0) throw new ConfigError('distributed run budget is exhausted or reserved by active rounds');
        payload.maxBudgetUsd = Math.min(payload.maxBudgetUsd ?? available, available);
      }
      const job: RoundJob = { ...input, payload, payloadDigest: digest(JSON.stringify(payload)), id: randomUUID(), created: now, status: candidates.length ? 'queued' : 'blocked', attempt: 0, events: [] };
      if (!candidates.length) job.error = 'missing capability or independent machine: ' + (input.requirements.join(', ') || 'registered worker') + (input.excludeMachine ? '; excluding ' + input.excludeMachine : '');
      if (staged !== undefined) renameSync(staged, this.bundlePath(input.payload.base));
      state.jobs.push(job); return job;
    }); } finally { if (staged !== undefined) rmSync(staged, { force: true }); }
  }
  claim(worker: string, now = Date.now()): RoundJob | undefined {
    return this.change(state => {
      this.recover(state, now);
      const row = state.workers.find(w => w.id === worker && w.registered && now - w.seen < this.ttl);
      if (!row || row.current) return undefined;
      const job = state.jobs.find(j => {
        if (j.status !== 'queued' || !j.requirements.every(c => row.capabilities.includes(c)) || (state.machines.length > 1 && j.excludeMachine === row.machine)) return false;
        if (j.payload.role === 'builder') {
          const prior = state.jobs.filter(p => p.run === j.run && p.piece === j.piece && p.payload.role === 'builder' && p.round < j.round && p.status === 'complete' && p.payload.model === j.payload.model).at(-1);
          const preferred = state.workers.find(w => w.id === prior?.owner && w.registered && now - w.seen < this.ttl && j.requirements.every(c => w.capabilities.includes(c)));
          if (preferred && preferred.id !== row.id) return false;
        }
        return true;
      });
      if (!job) return undefined;
      if (digest(JSON.stringify(job.payload)) !== job.payloadDigest) { job.status = 'failed'; job.error = 'round payload hash mismatch'; return undefined; }
      job.status = 'claimed'; job.owner = worker; job.machine = row.machine; job.token = randomUUID(); job.heartbeat = now; job.attempt++;
      delete job.error; row.current = job.id; row.seen = now;
      job.events.push({ at: now, kind: job.payload.role === 'builder' ? 'builder_round_started' : 'critic_dispatched', payload: { worker, machine: row.machine, attempt: job.attempt } });
      return job;
    });
  }
  private owned(state: QueueState, id: string, token: string, now: number): RoundJob {
    const job = state.jobs.find(j => j.id === id);
    if (!job || job.status !== 'claimed' || job.token !== token || now - (job.heartbeat ?? 0) >= this.ttl) throw new ConfigError('stale round claim; result rejected');
    const worker = state.workers.find(w => w.id === job.owner && w.registered);
    if (!worker || !job.requirements.every(c => worker.capabilities.includes(c))) throw new ConfigError('worker capability disappeared; result rejected');
    return job;
  }
  event(id: string, token: string, kind: string, payload: Record<string, unknown>, now = Date.now()): void {
    this.change(state => {
      this.recover(state, now);
      const cancelled = state.jobs.find(j => j.id === id && ((j.retiredToken === token && !j.cancellationAcknowledged) || j.retiredClaims?.some(c => c.token === token && !c.acknowledged)));
      const job = cancelled && kind === 'budget_spend' ? cancelled : this.owned(state, id, token, now);
      job.events.push({ at: now, kind, payload });
    });
  }
  finish(id: string, token: string, result: RoundResult | string, now = Date.now()): void {
    this.change(state => {
      const job = this.owned(state, id, token, now);
      if (typeof result === 'string') { job.status = 'failed'; job.error = result; }
      else {
        if (job.payload.role === 'builder' && (!result.pin || !result.ownership?.passed)) throw new ConfigError('builder report is missing pinned sha or ownership verdict');
        job.status = 'complete'; job.result = result;
      }
      const worker = state.workers.find(w => w.id === job.owner);
      if (worker) worker.current = null;
      job.events.push({ at: now, kind: typeof result === 'string' ? 'error_path' : job.payload.role === 'builder' ? 'builder_round_ended' : 'verdict_recorded', payload: typeof result === 'string' ? { fault: result } : { text: result.text, costUsd: result.costUsd } });
    });
  }
  verified(id: string, sha: string, candidate?: string): void {
    this.change(state => { const job = state.jobs.find(j => j.id === id); if (!job || job.status !== 'complete' || job.result?.pin?.sha !== sha) throw new ConfigError('cannot verify a different round sha'); job.verified = true; if (candidate !== undefined) job.candidate = candidate; });
  }
  rejectVerification(id: string, reason: string): void {
    this.change(state => {
      const job = state.jobs.find(j => j.id === id);
      if (!job || job.payload.role !== 'builder') throw new ConfigError('unknown builder round');
      job.status = 'failed'; job.verified = false; job.error = reason;
      job.events.push({ at: Date.now(), kind: 'pin_check', payload: { passed: false, detail: reason } });
    });
  }
  get(id: string, now = Date.now()): RoundJob {
    return this.change(state => {
      this.recover(state, now);
      const job = state.jobs.find(j => j.id === id); if (!job) throw new ConfigError('unknown round: ' + id);
      if (digest(JSON.stringify(job.payload)) !== job.payloadDigest) { retireClaim(job); job.status = 'failed'; job.error = 'round payload hash mismatch'; }
      if (job.status === 'queued' && !state.workers.some(w => w.registered && now - w.seen < this.ttl && job.requirements.every(c => w.capabilities.includes(c)) && (state.machines.length === 1 || w.machine !== job.excludeMachine))) {
        job.status = 'blocked'; job.error = 'missing capability or independent machine: ' + job.requirements.join(', ');
      }
      return job;
    });
  }
  bundlePath(pin: RoundBundle): string {
    if (!/^[a-f0-9]{64}$/.test(pin.digest)) throw new ConfigError('invalid bundle digest');
    return join(this.root, 'bundles', pin.digest + '.bundle');
  }
  putBundle(source: string, pin: RoundBundle, claim?: { id: string; token: string }): void {
    if (claim) { this.change(state => { this.owned(state, claim.id, claim.token, Date.now()); this.putBundle(source, pin); }); return; }
    const bytes = readFileSync(source);
    if (digest(bytes) !== pin.digest) throw new ConfigError('round bundle hash mismatch');
    const path = this.bundlePath(pin);
    if (existsSync(path)) { if (digest(readFileSync(path)) !== pin.digest) throw new ConfigError('stored round bundle hash mismatch'); return; }
    const temp = path + '.' + randomUUID() + '.tmp'; writeFileSync(temp, bytes); renameSync(temp, path);
  }
  /** Spend receipts include failed and reclaimed attempts, once per SDK result. */
  cost(run: string): number {
    if (!validIdentity(run)) throw new ConfigError('invalid distributed run id');
    const state = this.read();
    return settledCost(state, run) + jobsCost(state.jobs.filter(j => j.run === run));
  }
  drainEvents(run: string): { piece: string; round: number; at: number; kind: string; payload: Record<string, unknown> }[] {
    return this.change(state => state.jobs.filter(j => j.run === run).flatMap(job => {
      const next = job.events.slice(job.traceCursor ?? 0).map(event => ({ ...event, piece: job.piece, round: job.round }));
      job.traceCursor = job.events.length; return next;
    }));
  }
  setBudget(run: string, remaining: number | undefined): void {
    if (!validIdentity(run) || (remaining !== undefined && (!Number.isFinite(remaining) || remaining < 0))) throw new ConfigError('invalid distributed budget');
    this.change(state => { state.budgets ??= {}; if (remaining === undefined) delete state.budgets[run]; else state.budgets[run] = remaining; });
  }
  cancelRun(run: string, reason = 'lead settled the run'): void {
    if (!validIdentity(run)) throw new ConfigError('invalid distributed run id');
    this.change(state => {
      for (const job of state.jobs) if (job.run === run && ['queued', 'claimed'].includes(job.status)) {
        if (job.status === 'claimed') retireClaim(job);
        job.status = 'failed'; job.error = reason; delete job.token;
        job.events.push({ at: Date.now(), kind: 'error_path', payload: { fault: 'lead-cancelled', detail: reason } });
      }
    });
  }
  acknowledgeCancellation(id: string, token: string): void {
    this.change(state => {
      const job = state.jobs.find(j => j.id === id);
      if (!job) return;
      const claim = job.retiredClaims?.find(c => c.token === token);
      if (claim) claim.acknowledged = true;
      else if (job.retiredToken === token) job.cancellationAcknowledged = true;
      else return;
      // A late acknowledgment must never release a replacement generation,
      // even when a restarted daemon has reused the same worker identity.
      if (job.status === 'claimed' || (job.retiredClaims?.length && job.retiredClaims.at(-1)?.token !== token)) return;
      const worker = state.workers.find(w => w.id === (claim?.worker ?? job.owner));
      if (worker?.current === id) worker.current = null;
    });
  }
  pendingCancellations(run: string): string[] {
    return this.read().jobs.filter(j => j.run === run && pendingReceipt(j)).map(j => j.id);
  }
  cleanup(run: string): void {
    if (!validIdentity(run)) throw new ConfigError('invalid distributed run id');
    this.change(state => {
      const removed = state.jobs.filter(j => j.run === run);
      if (removed.some(j => j.status === 'claimed')) throw new ConfigError('cannot clean up a claimed distributed round');
      if (removed.some(pendingReceipt)) throw new ConfigError('worker cancellation and final spend remain unacknowledged; coordinator evidence retained');
      // Keep only the numeric receipt after artifact cleanup. A lead killed
      // before saving its ledger must still be able to recover this spend.
      state.settledCosts ??= {};
      state.settledCosts[run] = settledCost(state, run) + jobsCost(removed);
      state.jobs = state.jobs.filter(j => j.run !== run);
      if (state.budgets) delete state.budgets[run];
      const used = new Set(state.jobs.flatMap(j => [j.payload.base.digest, j.result?.pin?.digest]));
      for (const pin of removed.flatMap(j => [j.payload.base, ...(j.result?.pin ? [j.result.pin] : [])])) if (!used.has(pin.digest)) rmSync(this.bundlePath(pin), { force: true });
    });
  }
}
