import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { loadConfig } from '../config.js';
import { EXIT } from '../exit.js';
import { redactSecrets } from '../redact.js';
import { loadPluginSources } from '../plugin-dir.js';
import { type Command, type BooleanFlagSpec, type ValueFlagSpec, directoryValue, parseInvocation, registerCommand } from '../registry.js';
import { readRuns, readState } from '../runs-store.js';
import { loadStandards } from '../standards.js';
import { PROGRAM, plainText, renderCommandHelp, renderTable } from '../usage.js';

const directory: ValueFlagSpec<string> = { long: 'directory', short: 'C', value: directoryValue, summary: 'Inspect this project directory' };
const readOnly: BooleanFlagSpec = { long: 'read-only', summary: 'Check local prerequisites without writing or calling a provider' };
const json: BooleanFlagSpec = { long: 'json', summary: 'Print the diagnostic checks as JSON' };

export interface DoctorCheck { check: string; status: 'ok' | 'error' | 'unknown'; detail: string }

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}
function find(program: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of path.split(delimiter).filter(Boolean)) for (const ext of extensions) {
    const candidate = join(dir, program + ext);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

/** Local observations only: does not spawn programs, query auth, or create run artifacts. */
export function inspectLocalEnvironment(cwd: string, env: NodeJS.ProcessEnv): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const safe = (text: string): string => plainText(redactSecrets(text, env.GITHUB_TOKEN));
  function check(name: string, inspect: () => string): void {
    try { checks.push({ check: name, status: 'ok', detail: safe(inspect()) }); }
    catch (error) { checks.push({ check: name, status: 'error', detail: safe(error instanceof Error ? error.message : String(error)) }); }
  }
  check('node', () => { if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node 18 or newer is required'); return process.versions.node; });
  check('sdk', () => { createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'); return 'SDK package is installed; no provider session was started'; });
  check('plugin', () => { const sources = loadPluginSources(env); return 'plugin markdown loads from ' + sources.dir; });
  check('standards', () => loadStandards(cwd) === null ? 'no repository standards declared' : 'repository standards parse successfully');
  check('config', () => {
    const warnings: string[] = [];
    loadConfig({ env, warn: (message) => warnings.push(message) });
    if (warnings.length) throw new Error(warnings.join('; '));
    return 'saved defaults are readable';
  });
  check('run state', () => { const state = readState(cwd), runs = readRuns(cwd); return (state.status ? 'last written state: ' + state.status : 'no active state') + '; ' + runs.length + ' recorded runs'; });
  const bash = env.CLAUDE_CODE_GIT_BASH_PATH;
  const shell = bash && executable(bash) ? bash : find('bash', env);
  checks.push({ check: 'command shell', status: bash && !executable(bash) ? 'error' : shell ? 'ok' : 'unknown', detail: safe(bash && !executable(bash) ? 'CLAUDE_CODE_GIT_BASH_PATH does not name an executable file' : shell ? 'Bash found at ' + shell + '; execution permission is not tested' : 'Bash was not found on PATH; the SDK may use its configured shell') });
  const git = find('git', env);
  checks.push({ check: 'git', status: git ? 'ok' : 'unknown', detail: safe(git ? 'Git found at ' + git : 'Git was not found on PATH; runner and distributed round operations need Git') });
  const credential = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'].some((key) => !!env[key]?.trim());
  checks.push({ check: 'provider authentication', status: 'unknown', detail: credential ? 'credential environment is present; validity was not checked' : 'no credential environment is present; an existing Claude Code login may supply authentication' });
  checks.push({ check: 'execution permission', status: 'unknown', detail: 'read-only diagnostics do not prove SDK execution; run/resume/work perform the bounded execution preflight' });
  // Looking for a repository is an observation, not a demand that every local task use Git.
  if (!existsSync(join(cwd, '.git'))) checks.push({ check: 'repository', status: 'unknown', detail: 'no .git entry in this directory; a parent directory may own the checkout' });
  return checks;
}

export const doctorCommand: Command = {
  name: 'doctor', summary: 'Inspect local prerequisites without changing project state', usage: PROGRAM + ' doctor [flags]', flags: [directory, readOnly, json], cwdFlag: directory,
  description: ['Doctor reads local SDK, plugin, standards, configuration and run-state inputs. It never starts a model session, calls GitHub, executes a shell command, writes files, or consumes model tokens.', 'Checks that need provider authentication or actual SDK execution are reported as unknown. The execution preflight on run, resume and work performs the separate bounded capability check.'],
  examples: [PROGRAM + ' doctor --read-only', PROGRAM + ' doctor --read-only --json'],
  async run(argv, ctx) {
    const args = parseInvocation(doctorCommand, argv, ctx);
    if (args.help) { ctx.stdout.write(renderCommandHelp(doctorCommand)); return EXIT.WIN; }
    const checks = inspectLocalEnvironment(args.cwd, ctx.env);
    if (args.bool(json)) ctx.stdout.write(JSON.stringify({ readOnly: true, checks }) + '\n');
    else ctx.stdout.write(renderTable(['check', 'status', 'detail'], checks.map((item) => [item.check, item.status, item.detail]), { tty: ctx.isTTY, width: ctx.width }).join('\n') + '\n');
    return checks.some((item) => item.status === 'error') ? EXIT.USAGE : EXIT.WIN;
  },
};
registerCommand(doctorCommand);
