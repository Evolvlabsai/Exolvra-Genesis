import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigError, EXIT } from '../exit.js';
import { readRuns, readState, runDirectory, updateRun, writeAtomic, writeState, settledIssueRun } from '../runs-store.js';
import { pidExists, processStartTime } from '../trace-store.js';
import { type Command, type BooleanFlagSpec, type ValueFlagSpec, countValue, directoryValue, parseInvocation, registerCommand } from '../registry.js';
import { PROGRAM, renderCommandHelp } from '../usage.js';
import { positionalTokens, runIdValue } from './resume.js';

const directory: ValueFlagSpec<string> = { long: 'directory', short: 'C', value: directoryValue, summary: 'Stop the run under dir' };
const grace: ValueFlagSpec<number> = { long: 'grace-seconds', value: countValue, default: 15, summary: 'Allow int seconds for graceful settling' };
const force: BooleanFlagSpec = { long: 'force', summary: 'Escalate after grace expires and report unsettled aftermath' };
const argument = { name: 'run-id', value: runIdValue };

/** Only called after the recorded owner's process start time was verified. */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (result.error || result.status !== 0) throw new ConfigError('could not stop the owning process tree; run state was not changed');
    return;
  }
  const snapshot = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
  if (snapshot.error || snapshot.status !== 0) throw new ConfigError('could not identify the owning process tree; no process was killed');
  const parents = new Map<number, number[]>();
  for (const line of snapshot.stdout.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    parents.set(parent, [...parents.get(parent) ?? [], child]);
  }
  const targets: number[] = [];
  const collect = (parent: number): void => { for (const child of parents.get(parent) ?? []) { collect(child); targets.push(child); } };
  collect(pid);
  for (const target of [...targets, pid]) {
    try { process.kill(target, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}

export const stopCommand: Command = {
  name: 'stop', summary: 'Stop a run and verify its settled state', usage: PROGRAM + ' stop [run-id] [flags]', flags: [directory, grace, force], cwdFlag: directory,
  async run(argv, ctx) {
    const named = positionalTokens(stopCommand, argv).length > 0;
    const args = parseInvocation(named ? { ...stopCommand, argument } : stopCommand, argv, ctx);
    if (args.help) { ctx.stdout.write(renderCommandHelp(stopCommand)); return EXIT.WIN; }
    const runs = readRuns(args.cwd), state = readState(args.cwd);
    const active = runs.filter((r) => r.status === 'running' || (r.id === state.run && r.status === 'blocked' && !settledIssueRun(args.cwd, r.id)));
    if (!named && active.length > 1) throw new ConfigError('more than one run is active; name the run to stop\n  ' + active.map((r) => r.id).join(', '));
    const id = named ? args.argument(argument) : active[0]?.id;
    if (id === undefined) { ctx.stdout.write('nothing is running\n'); return EXIT.WIN; }
    const run = runs.find((r) => r.id === id);
    if (!run) throw new ConfigError('no run is recorded as ' + id);
    if (run.status === 'complete' || run.status === 'stopped') { ctx.stdout.write(id + ' is already ' + run.status + '\n'); return EXIT.WIN; }
    if (run.status === 'blocked' && settledIssueRun(args.cwd, id)) { ctx.stdout.write(id + ' is already settled; its blocked verdict remains in history\n'); return EXIT.WIN; }
    if (state.status === 'running' && state.run !== undefined && state.run !== id) throw new ConfigError('another run owns active state: ' + state.run);
    const root = runDirectory(args.cwd, id);
    const issueOwned = existsSync(join(root, 'issue.md')) || existsSync(join(root, 'issue-owner.json'));
    const issueSettlement = (): string | undefined => {
      try {
        const owner = JSON.parse(readFileSync(join(root, 'issue-owner.json'), 'utf8'));
        return settledIssueRun(args.cwd, id) ? owner.lifecycle : undefined;
      } catch { return undefined; }
    };
    let control: { run?: string; pid?: number; startedAt?: number } = {};
    try { control = JSON.parse(readFileSync(join(root, 'control.json'), 'utf8')); } catch { /* Legacy state. */ }
    if (control.run !== undefined && control.run !== id) throw new ConfigError('control record belongs to a different run');
    const pid = Number.isSafeInteger(control.pid) && Number(control.pid) > 0 ? control.pid : state.pid;
    if (pid !== undefined && pidExists(pid)) {
      if (control.startedAt !== undefined) {
        const started = processStartTime(pid);
        if (started !== null && Math.abs(started - control.startedAt) > 2000) throw new ConfigError('the recorded process id belongs to another process; no stop was sent');
      }
      writeAtomic(join(root, 'stop-request.json'), JSON.stringify({ run: id, requestedAt: Date.now(), ownerPid: pid, ownerStartedAt: control.startedAt }) + '\n');
      const deadline = Date.now() + (args.get(grace) ?? 15) * 1000;
      const settledStatus = (): string | undefined => {
        const current = readState(args.cwd), row = readRuns(args.cwd).find((r) => r.id === id);
        if (!row || row.status === 'running') return undefined;
        if (current.run === id && current.status !== row.status) return undefined;
        // The enclosing issue runner releases or settles its remote claim only
        // after the inner loop has written stopped state. Wait for that owner.
        if (issueOwned && pidExists(pid) && issueSettlement() === undefined) return undefined;
        return row.status;
      };
      while (Date.now() < deadline && settledStatus() === undefined && pidExists(pid)) {
        ctx.stderr.write('Waiting for ' + id + ' to settle: ' + Math.ceil((deadline - Date.now()) / 1000) + 's\n');
        await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(1, deadline - Date.now()))));
      }
      const settled = settledStatus();
      if (settled === undefined) {
        if (!pidExists(pid)) {
          const status = issueOwned ? 'blocked' : 'stopped';
          updateRun(args.cwd, id, { status }); writeState(args.cwd, status, id);
          ctx.stdout.write(id + ' owner exited before settlement; recorded ' + status + (issueOwned ? '; remote claim recovery is required' : '') + '\n');
          return issueOwned ? EXIT.LOSS : EXIT.WIN;
        }
        if (!args.bool(force)) throw new ConfigError('run did not settle within grace; retry stop ' + id + ' --force');
        const started = processStartTime(pid);
        if (started === null || Math.abs(started - (control.startedAt ?? Date.parse(run.startedAt))) > 2000) throw new ConfigError('cannot identify the owning process safely; no process was killed');
        killTree(pid);
        updateRun(args.cwd, id, { status: 'blocked' }); writeState(args.cwd, 'blocked', id);
        ctx.stdout.write('Forced stop of ' + id + ' and its process tree; state is blocked. Remote claims may require recovery.\n');
        return EXIT.LOSS;
      }
      const remote = issueOwned ? issueSettlement() : undefined;
      ctx.stdout.write(id + ' settled ' + settled + (issueOwned ? remote ? '; issue lifecycle verified as ' + remote : '; remote claim status remains unverified' : '') + '\n');
      return settled === 'blocked' || (issueOwned && remote === undefined) ? EXIT.LOSS : EXIT.WIN;
    }
    // No live owner can settle an interrupted local run. Keep issue recovery explicit.
    if (pid === undefined && run.status === 'running') throw new ConfigError('no owner process is recorded; stop this legacy run in its original terminal before starting another');
    const issue = issueOwned;
    updateRun(args.cwd, id, { status: issue ? 'blocked' : 'stopped' });
    writeState(args.cwd, issue ? 'blocked' : 'stopped', id);
    ctx.stdout.write(id + (issue ? ' is blocked; resume work to recover its remote claim\n' : ' stopped; no live owner was recorded\n'));
    return issue ? EXIT.LOSS : EXIT.WIN;
  },
};
registerCommand(stopCommand);
