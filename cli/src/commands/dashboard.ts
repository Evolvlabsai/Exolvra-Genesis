import { ConfigError, EXIT, UsageError } from '../exit.js';
import { openPath } from '../open.js';
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from '../panel-jobs.js';
import { startPanelServer } from '../panel-server.js';
import { panelPublicUrl, panelToken, PANEL_HOSTS, PANEL_TOKEN_ENV } from '../panel-config.js';
import { type Command, type ValueFlagSpec, type BooleanFlagSpec, type EnvSpec, choiceValue, directoryValue, parseInvocation, registerCommand } from '../registry.js';
import { PROGRAM, renderCommandHelp } from '../usage.js';

const directory: ValueFlagSpec<string> = { long: 'directory', short: 'C', value: directoryValue, summary: 'Initial project and panel registry directory' };
const port: ValueFlagSpec<number> = {
  long: 'port', summary: 'HTTP listen port (default: 4317; 0 picks a free port)',
  value: { arg: 'port', invalid: '65536', parse(raw, ctx) {
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 0 || value > 65535) throw new UsageError('Invalid value "' + raw + '" for ' + ctx.flag + ': expected a port from 0 to 65535.', ctx.usage);
    return value;
  } },
};
const open: BooleanFlagSpec = { long: 'open', summary: 'Open the panel in your default browser' };
const concurrency: ValueFlagSpec<number> = {
  long: 'concurrency', summary: 'Paid commands that may run at once across projects (default: ' + String(DEFAULT_CONCURRENCY) + '); the rest wait in a persistent queue',
  value: { arg: 'count', invalid: '0', parse(raw, ctx) {
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENCY) throw new UsageError('Invalid value "' + raw + '" for ' + ctx.flag + ': expected a count from 1 to ' + String(MAX_CONCURRENCY) + '.', ctx.usage);
    return value;
  } },
};
const host: ValueFlagSpec<string> = { long: 'host', value: choiceValue('address', PANEL_HOSTS), summary: 'Listen address (default: 127.0.0.1); shared listeners require an access key' };
const publicUrl: ValueFlagSpec<string> = { long: 'public-url', summary: 'Exact browser origin behind an HTTPS reverse proxy', value: {
  arg: 'url', invalid: 'not-a-url', parse(raw, ctx) {
    try { return panelPublicUrl(raw); } catch (error) { throw new UsageError('Invalid value "' + raw + '" for ' + ctx.flag + ': ' + (error as Error).message, ctx.usage); }
  },
} };
const token: EnvSpec<string> = { name: PANEL_TOKEN_ENV, sensitive: true, value: {
  arg: 'key', invalid: 'too-short', parse(raw) { try { return panelToken(raw); } catch (error) { throw new UsageError((error as Error).message); } },
} };
export const dashboardCommand: Command = {
  name: 'dashboard', summary: 'Serve a control panel for projects and agent runs',
  usage: PROGRAM + ' dashboard [flags]', flags: [directory, port, host, publicUrl, concurrency, open], cwdFlag: directory, env: [token],
  description: ['For shared access set EXOLVRA_GENESIS_PANEL_TOKEN and --public-url https://your-host. Put an HTTPS reverse proxy in front of the listener. Authenticated members can operate registered server projects.', 'Commands the panel starts are detached: they continue when the panel stops, and a restarted panel adopts them. Use `stop` to end a run.'],
  async run(argv, ctx) {
    const args = parseInvocation(dashboardCommand, argv, ctx);
    if (args.help) { ctx.stdout.write(renderCommandHelp(dashboardCommand)); return EXIT.WIN; }
    let panel;
    try { panel = await startPanelServer({ root: args.cwd, port: args.get(port), host: args.get(host), publicUrl: args.get(publicUrl), token: args.env(token), env: ctx.env, concurrency: args.get(concurrency) }); }
    catch (error) { throw new ConfigError('Cannot start control panel: ' + (error instanceof Error ? error.message : String(error))); }
    ctx.stdout.write('Genesis control panel: ' + panel.url + '\nProject: ' + args.cwd + '\nPress Ctrl+C to stop the panel; commands it started continue in the background.\n');
    const done = new Promise<void>((resolve) => {
      const stop = (): void => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
    if (args.bool(open)) {
      const result = await openPath(panel.url, { env: ctx.env });
      if (!result.opened) ctx.stderr.write('Could not open browser: ' + result.reason + '. Open ' + panel.url + ' manually.\n');
    }
    await done;
    const continuing = await panel.close();
    if (continuing.length) {
      const rows = continuing.map((job) => '  ' + job.action + '  ' + job.projectName + (job.runId ? '  ' + job.runId : '') + '  pid ' + String(job.pid ?? '?'));
      ctx.stdout.write(String(continuing.length) + (continuing.length === 1 ? ' command continues' : ' commands continue') + ' in the background:\n' + rows.join('\n') + '\nRestart the panel to observe them, or run `' + PROGRAM + ' stop -C <project>` to end a run.\n');
    }
    return EXIT.WIN;
  },
};
registerCommand(dashboardCommand);
