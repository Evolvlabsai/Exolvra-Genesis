import { hostname } from 'node:os';
import { join } from 'node:path';
import { type Command, type ValueType, type ValueFlagSpec, type BooleanFlagSpec, directoryValue, countValue, parseInvocation, registerCommand } from '../registry.js';
import { ConfigError, EXIT, UsageError } from '../exit.js';
import { PROGRAM, renderCommandHelp } from '../usage.js';
import { RoundCoordinator, validCapability, validIdentity } from '../distributed.js';
import { executeRound } from '../distributed-worker.js';
import type { Session } from '../session.js';
import { loadFleetTemplate, writeFleetPage } from '../fleet.js';
import { redactSecrets } from '../git.js';

export const identityValue: ValueType<string> = { arg: 'name', invalid: '../bad', parse(raw, ctx) {
  if (!validIdentity(raw)) throw new UsageError('invalid value "' + raw + '" for ' + ctx.flag + ': expected an identity', ctx.usage); return raw;
} };
export const capabilitiesValue: ValueType<string[]> = { arg: 'capabilities', invalid: '../bad', parse(raw, ctx) {
  const values = raw.split(','); if (!values.length || !values.every(validCapability)) throw new UsageError('invalid value "' + raw + '" for ' + ctx.flag + ': expected capabilities', ctx.usage); return [...new Set(values)];
} };
const coordinator: ValueFlagSpec<string> = { long: 'coordinator', value: directoryValue, summary: 'Existing authenticated shared coordinator directory' };
const directory: ValueFlagSpec<string> = { long: 'directory', short: 'C', value: directoryValue, summary: 'Local worker storage directory' };
const name: ValueFlagSpec<string> = { long: 'name', value: identityValue, summary: 'Unique worker identity' };
const machine: ValueFlagSpec<string> = { long: 'machine', value: identityValue, summary: 'Physical machine identity (defaults to hostname)' };
const capabilities: ValueFlagSpec<string[]> = { long: 'capabilities', value: capabilitiesValue, summary: 'Signed-in models and perception, comma separated' };
const ttl: ValueFlagSpec<number> = { long: 'ttl-seconds', value: countValue, summary: 'Heartbeat expiry, minimum 60 seconds', default: 86400 };
const poll: ValueFlagSpec<number> = { long: 'poll-seconds', value: countValue, summary: 'Seconds between polls', default: 5 };
const once: BooleanFlagSpec = { long: 'once', summary: 'Poll once, execute at most one round, then deregister' };
export const daemonCommand: Command = {
  name: 'daemon', summary: 'Poll and execute distributed rounds with local model logins', group: 'additional',
  usage: PROGRAM + ' daemon --coordinator dir --name name [flags]',
  flags: [coordinator, directory, name, machine, capabilities, ttl, poll, once], cwdFlag: directory,
  description: ['The shared directory must support atomic mkdir and rename across machines. Restrict its filesystem ACLs to trusted leads and workers. No inbound ports or credentials are published. Declare models as model:inherit or model:<exact-id>, and perception as browser or platform:<name>.'],
  async run(argv, ctx) {
    const args = parseInvocation(daemonCommand, argv, ctx);
    if (args.help) { ctx.stdout.write(renderCommandHelp(daemonCommand)); return EXIT.WIN; }
    const root = args.get(coordinator), id = args.get(name);
    if (!root || !id) throw new UsageError('--coordinator and --name are required', daemonCommand.usage);
    const configuredTtl = args.get(ttl);
    const queue = new RoundCoordinator(root, configuredTtl === undefined ? undefined : configuredTtl * 1000);
    const machineId = args.get(machine) ?? hostname().replace(/[^a-zA-Z0-9_-]/g, '-');
    const caps = args.get(capabilities) ?? ['model:inherit', 'platform:' + process.platform];
    let stopped = false, active: Session | undefined, leaseLost = false;
    const template = loadFleetTemplate(ctx.env);
    const refresh = (): void => { writeFleetPage(queue.root, template, { generated: new Date().toISOString(), repos: [], runs: [], workers: queue.workers(), note: 'Distributed worker fleet' }); };
    const stop = (): void => { stopped = true; void active?.interrupt(); };
    queue.register({ id, name: id, machine: machineId, capabilities: caps });
    refresh();
    ctx.stdout.write('Worker ' + id + ' registered on ' + machineId + '\n');
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const heartbeat = setInterval(() => {
      try { if (!queue.heartbeat(id)) { leaseLost = true; void active?.interrupt(); } refresh(); }
      catch { leaseLost = true; void active?.interrupt(); }
    }, Math.min(10000, queue.ttl / 3));
    let failed = false;
    try {
      do {
        queue.heartbeat(id);
        const job = queue.claim(id);
        if (job) {
          leaseLost = false;
          ctx.stdout.write(job.payload.role + ' ' + job.run + '/' + job.piece + '/' + job.round + '\n');
          try {
            const result = await executeRound({ coordinator: queue, job, workRoot: join(args.cwd, '.exolvra-genesis', 'worker', id), env: ctx.env, onSession: value => { active = value; } });
            if (leaseLost) throw new ConfigError('worker lease expired while executing');
            queue.finish(job.id, job.token!, result);
          } catch (error) {
            failed = true;
            const detail = redactSecrets(error instanceof Error ? error.message : String(error));
            try { queue.finish(job.id, job.token!, detail); } catch { /* Fenced stale claims cannot change the new attempt. */ }
            ctx.stderr.write(detail + '\n');
          } finally { queue.acknowledgeCancellation(job.id, job.token!); }
        }
        if (args.bool(once) || stopped) break;
        const until = Date.now() + (args.get(poll) ?? 5) * 1000;
        while (!stopped && Date.now() < until) await new Promise(r => setTimeout(r, Math.min(250, until - Date.now())));
      } while (!stopped);
    } finally {
      clearInterval(heartbeat); process.off('SIGINT', stop); process.off('SIGTERM', stop);
      queue.deregister(id); refresh(); ctx.stdout.write('Worker ' + id + ' deregistered\n');
    }
    return failed ? EXIT.LOSS : EXIT.WIN;
  },
};
registerCommand(daemonCommand);
