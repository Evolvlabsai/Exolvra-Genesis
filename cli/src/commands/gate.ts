import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ConfigError, EXIT } from '../exit.js';
import { enforceOwnership, snapshotOwnership, safePattern, type FileState, type OwnershipSnapshot } from '../ownership.js';
import { type Command, type ValueFlagSpec, choiceValue, directoryValue, parseInvocation, registerCommand } from '../registry.js';
import { readState, runDirectory, writeAtomic } from '../runs-store.js';
import { PROGRAM, renderCommandHelp } from '../usage.js';

const directory: ValueFlagSpec<string> = { long: 'directory', short: 'C', value: directoryValue, summary: 'Check the project under dir' };
const phase: ValueFlagSpec<string> = { long: 'phase', value: choiceValue('phase', ['before', 'after', 'bar']), summary: 'Snapshot, compare, or verify bar pins' };

export function checkBar(cwd: string, runId: string): void {
  const root = join(runDirectory(cwd, runId), 'bar'), pins = join(root, 'bar.sha256');
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new ConfigError('bar directory is a symbolic link');
  if (!existsSync(pins)) throw new ConfigError('active run has no bar integrity pins: ' + pins);
  if (lstatSync(pins).isSymbolicLink()) throw new ConfigError('bar pins are a symbolic link');
  const lines = readFileSync(pins, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new ConfigError('bar integrity pins are empty');
  for (const row of lines) {
    const parsed = row.match(/^([a-fA-F0-9]{64})\s+[ *]?(.+)$/);
    if (!parsed) throw new ConfigError('invalid bar pin: ' + row);
    const path = resolve(root, parsed[2]!);
    if (path === root || isAbsolute(parsed[2]!) || relative(root, path).startsWith('..')) throw new ConfigError('bar pin escaped captured artifacts');
    let parent = dirname(path);
    while (parent !== root) {
      if (lstatSync(parent).isSymbolicLink()) throw new ConfigError('bar artifact parent is a symbolic link');
      parent = dirname(parent);
    }
    if (!lstatSync(path).isFile()) throw new ConfigError('bar artifact must be a regular file');
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== parsed[1]!.toLowerCase()) throw new ConfigError('bar integrity check failed: ' + parsed[2]);
  }
}

export const gateCommand: Command = {
  name: 'gate', summary: 'Run an opt-in plugin ownership or integrity hook', usage: PROGRAM + ' gate --phase phase [flags]', group: 'additional', flags: [directory, phase], cwdFlag: directory,
  description: ['The CLI loop enforces ownership in memory. This optional plugin hook stores hash snapshots on disk and is weaker against a builder that can alter those snapshots. No secret file contents are persisted.'],
  async run(argv, ctx) {
    const args = parseInvocation(gateCommand, argv, ctx);
    if (args.help) { ctx.stdout.write(renderCommandHelp(gateCommand)); return EXIT.WIN; }
    const operation = args.get(phase), state = readState(args.cwd);
    if (!operation) throw new ConfigError('--phase is required');
    if (state.status !== 'running') { ctx.stdout.write('no active run to check\n'); return EXIT.WIN; }
    if (!state.run) throw new ConfigError('active state needs a safe run id before enabling this hook');
    const path = join(runDirectory(args.cwd, state.run), 'ownership-snapshot.json');
    if (operation === 'bar') { checkBar(args.cwd, state.run); ctx.stdout.write('bar pins verified\n'); return EXIT.WIN; }
    if (operation === 'before') {
      let body = '';
      for await (const chunk of process.stdin) { body += String(chunk); if (body.length > 1024 * 1024) throw new ConfigError('hook input exceeds one megabyte'); }
      let input: { tool_input?: { subagent_type?: string; prompt?: string } };
      try { input = JSON.parse(body); } catch { throw new ConfigError('hook input is not readable JSON'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConfigError('hook input must be an object');
      if (!String(input.tool_input?.subagent_type).includes('builder')) { ctx.stdout.write('no builder dispatch to snapshot\n'); return EXIT.WIN; }
      if (existsSync(path)) throw new ConfigError('a builder snapshot is still pending; run gate --phase after before another dispatch');
      const block = input.tool_input?.prompt?.match(/```genesis-task\s*\n([\s\S]*?)\n```/);
      if (!block) throw new ConfigError('builder prompt has no genesis-task ownership metadata');
      let task: { files: string[]; scratch?: string[] };
      try { task = JSON.parse(block[1]!); } catch { throw new ConfigError('invalid ownership metadata'); }
      if (!task || !Array.isArray(task.files) || !task.files.length || !task.files.every((p) => typeof p === 'string')) throw new ConfigError('ownership files must be a nonempty list');
      task.files.forEach(safePattern);
      if (task.scratch !== undefined && (!Array.isArray(task.scratch) || !task.scratch.every((p) => typeof p === 'string'))) throw new ConfigError('scratch must be a list of dedicated directories');
      const snapshot = snapshotOwnership(args.cwd, task.scratch);
      const files = [...snapshot.files].map(([name, { hash, mode, link }]) => [name, { hash, mode, link }]);
      writeAtomic(path, JSON.stringify({ cwd: snapshot.cwd, files, dirty: [...snapshot.dirty], scratch: snapshot.scratch, owned: task.files }) + '\n');
      ctx.stdout.write('ownership snapshot recorded\n'); return EXIT.WIN;
    }
    if (!existsSync(path)) { ctx.stdout.write('no pending ownership snapshot\n'); return EXIT.WIN; }
    let value: { cwd: string; files: [string, FileState][]; dirty: string[]; scratch: string[]; owned: string[] };
    try {
      value = JSON.parse(readFileSync(path, 'utf8')) as typeof value;
      if (!value || typeof value.cwd !== 'string' || !Array.isArray(value.files) || !Array.isArray(value.dirty) || !Array.isArray(value.scratch) || !Array.isArray(value.owned) || ![...value.dirty, ...value.scratch, ...value.owned].every((p) => typeof p === 'string') || !value.files.every((row) => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && row[1] && typeof row[1].hash === 'string' && /^[a-f0-9]{64}$/.test(row[1].hash) && Number.isSafeInteger(row[1].mode) && typeof row[1].link === 'boolean' && row[1].data === undefined)) throw new Error('shape');
    } catch { throw new ConfigError('ownership snapshot is invalid; preserve it and inspect the interrupted round'); }
    if (resolve(value.cwd) !== resolve(args.cwd)) throw new ConfigError('snapshot belongs to another project');
    for (const [name] of value.files) {
      safePattern(name);
      if (isAbsolute(name) || relative(args.cwd, resolve(args.cwd, name)).startsWith('..')) throw new ConfigError('snapshot contains an unsafe path');
    }
    const snapshot: OwnershipSnapshot = { cwd: value.cwd, files: new Map(value.files), dirty: new Set(value.dirty), scratch: value.scratch };
    const result = enforceOwnership(snapshot, value.owned);
    renameSync(path, path.replace('.json', '-checked-' + Date.now() + '.json'));
    ctx.stdout.write(JSON.stringify(result) + '\n');
    if (result.violations.length) throw new ConfigError('ownership breach: ' + result.violations.join(', ') + '\n  ' + result.unrecoverable.join('; '));
    return EXIT.WIN;
  },
};
registerCommand(gateCommand);
