import { EXIT } from '../exit.js';
import { projectStatus, stallThresholds } from '../live-status.js';
import { type Command, type BooleanFlagSpec, type ValueFlagSpec, directoryValue, countValue, parseInvocation, registerCommand } from '../registry.js';
import { PROGRAM, renderCommandHelp, renderTable } from '../usage.js';

const directory: ValueFlagSpec<string> = { long: 'directory', short: 'C', value: directoryValue, summary: 'Read run state under dir' };
const stall: ValueFlagSpec<number> = { long: 'stall-seconds', value: countValue, summary: 'Override inactivity threshold for all phases' };
const verificationStall: ValueFlagSpec<number> = { long: 'verification-stall-seconds', value: countValue, summary: 'Verification inactivity threshold (default: 60s; builder: 300s)' };
const json: BooleanFlagSpec = { long: 'json', summary: 'Print a fixed-shape JSON status snapshot' };
const watch: BooleanFlagSpec = { long: 'watch', short: 'w', summary: 'Refresh when observed state changes' };
export const statusCommand: Command = {
  name: 'status', summary: 'Show current activity, spend and stalled runs', usage: PROGRAM + ' status [flags]', flags: [directory, stall, verificationStall, json, watch], cwdFlag: directory,
  async run(argv, ctx) {
    const args = parseInvocation(statusCommand, argv, ctx);
    if (args.help) { ctx.stdout.write(renderCommandHelp(statusCommand)); return EXIT.WIN; }
    let stopped = false, previous = '';
    const stop = (): void => { stopped = true; };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
      do {
        const thresholds = stallThresholds(ctx.env);
        if (args.get(verificationStall) !== undefined) thresholds.verification = args.get(verificationStall)! * 1000;
        const rows = projectStatus(args.cwd, args.get(stall) === undefined ? thresholds : args.get(stall)! * 1000);
        const serialized = JSON.stringify({ runs: rows });
        const revision = JSON.stringify(rows.map((r) => ({ id: r.id, cursor: r.cursor, status: r.status, live: r.live, stalled: r.stalled, warning: r.budget_warning,
          cost: r.cost_usd, source: r.source, processes: r.processes.map((p) => ({ id: p.task_id, stalled: p.stalled })) })));
        if (revision !== previous) {
          previous = revision;
          if (args.bool(json)) ctx.stdout.write(serialized + '\n');
          else if (!rows.length) ctx.stdout.write('nothing is running\n');
          else {
            const view = { tty: ctx.isTTY, width: ctx.width };
            ctx.stdout.write(renderTable(['run', 'phase', 'round', 'spend / cap', 'activity age', 'health', 'source'], rows.map((r) => [r.id, r.phase,
              String(r.budget_rounds) + (r.max_rounds === null ? '' : '/' + r.max_rounds), '$' + r.budget_spent_usd.toFixed(2) + (r.max_cost_usd === null ? '' : '/$' + r.max_cost_usd.toFixed(2)),
              Math.floor(r.last_event_age_ms / 1000) + 's', r.stalled ? 'STALLED' : r.budget_warning ? 'BUDGET 80%' : r.live, r.source]), view, 0, ['run']).join('\n') + '\n');
            for (const row of rows) {
              if (row.pieces.length) ctx.stdout.write('\n' + row.id + ' pieces\n' + renderTable(['piece', 'phase', 'round', 'verdict', 'cost'], row.pieces.map((p) => [p.id, p.phase, String(p.round), String(p.verdict ?? '-'), p.cost_usd === null ? 'unavailable' : '$' + p.cost_usd.toFixed(2)]), view).join('\n') + '\n');
              if (row.processes.length) ctx.stdout.write('\n' + row.id + ' agents\n' + renderTable(['agent', 'role', 'piece', 'age', 'last event', 'health'], row.processes.map((p) => [p.task_id, p.role, p.piece ?? '-', Math.floor(p.age_ms / 1000) + 's', Math.floor(p.last_event_age_ms / 1000) + 's', p.stalled ? 'STALLED' : 'open']), view).join('\n') + '\n');
            }
          }
        }
        if (args.bool(watch) && !stopped) await new Promise((r) => setTimeout(r, 1000));
      } while (args.bool(watch) && !stopped);
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return EXIT.WIN;
  },
};
registerCommand(statusCommand);
