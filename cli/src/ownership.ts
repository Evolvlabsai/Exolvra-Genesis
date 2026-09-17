import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ConfigError } from './exit.js';

export interface FileState { hash: string; mode: number; data?: Buffer; link: boolean }
export interface OwnershipSnapshot { cwd: string; files: Map<string, FileState>; dirty: Set<string>; scratch: string[] }
export interface OwnershipResult { touched: string[]; violations: string[]; restored: string[]; unrecoverable: string[] }

export function safePattern(pattern: string): string {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || isAbsolute(normalized) || normalized.split('/').some((part) => part === '..' || part === '') || /[\x00-\x1f:]/.test(normalized)) {
    throw new ConfigError('invalid ownership pattern: ' + pattern);
  }
  return normalized;
}

/** Single wildcards never cross a slash; globstar includes zero directories. */
export function owns(pattern: string, path: string): boolean {
  const text = safePattern(pattern);
  let source = '^';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '*' && text[i + 1] === '*') {
      i++;
      if (text[i + 1] === '/') { i++; source += '(?:.*/)?'; }
      else source += '.*';
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source + '$').test(path);
}

/** Conservative overlap check: uncertain wildcard intersections are refused. */
export function assertDisjoint(pieces: readonly { id: string; files: readonly string[] }[]): void {
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
    for (const rawA of pieces[i]!.files) for (const rawB of pieces[j]!.files) {
      const a = safePattern(rawA), b = safePattern(rawB);
      const prefixA = a.split(/[?*]/)[0]!, prefixB = b.split(/[?*]/)[0]!;
      const possible = owns(a, b) || owns(b, a) || (/[?*]/.test(a) && /[?*]/.test(b) && (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)));
      if (possible) throw new ConfigError('overlapping ownership: ' + pieces[i]!.id + ' (' + a + ') and ' + pieces[j]!.id + ' (' + b + '); use disjoint paths');
    }
  }
}

function filesAt(cwd: string, scratch: readonly string[]): Map<string, FileState> {
  const files = new Map<string, FileState>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name), path = relative(cwd, full).replaceAll('\\', '/');
      // Git's administrative directory is not a deliverable. Ignore rules do not apply.
      if (path === '.git' || path === '.exolvra-genesis' || scratch.some((p) => path === p || path.startsWith(p + '/'))) continue;
      const stat = lstatSync(full);
      if (stat.isDirectory()) { walk(full); continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new ConfigError('cannot fingerprint special file: ' + path);
      const link = stat.isSymbolicLink();
      const data = link ? Buffer.from(readlinkSync(full)) : readFileSync(full);
      const mode = stat.mode & 0o777;
      files.set(path, { hash: createHash('sha256').update(data).update(String(mode)).update(String(link)).digest('hex'), mode, data, link });
    }
  };
  walk(cwd);
  return files;
}

export function snapshotOwnership(cwd: string, scratch: readonly string[] = []): OwnershipSnapshot {
  const root = resolve(cwd);
  const spaces = scratch.map(safePattern);
  if (spaces.some((s) => /[?*]/.test(s) || s === '.git' || s === '.exolvra-genesis')) throw new ConfigError('scratch must name a dedicated directory');
  let dirtyText: string;
  try { dirtyText = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new ConfigError('ownership snapshot could not read git status; the builder was not dispatched'); }
  const dirty = new Set<string>();
  const entries = dirtyText.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i]!;
    if (row.length < 4) continue;
    dirty.add(row.slice(3));
    if (/[RC]/.test(row.slice(0, 2)) && entries[i + 1]) dirty.add(entries[++i]!);
  }
  return { cwd: root, files: filesAt(root, spaces), dirty, scratch: spaces };
}

/** Content identity includes binary and untracked/ignored deliverables. */
export function candidateFingerprint(cwd: string, scratch: readonly string[] = []): string {
  return createHash('sha256').update(JSON.stringify([...filesAt(resolve(cwd), scratch)].map(([path, file]) => [path, file.hash]).sort((a, b) => a[0]!.localeCompare(b[0]!)))).digest('hex');
}

function protectedDirty(snapshot: OwnershipSnapshot, path: string): boolean {
  return [...snapshot.dirty].some((p) => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));
}

function safeParent(root: string, path: string): void {
  let parent = dirname(join(root, path));
  while (parent !== root) {
    if (!parent.startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) throw new ConfigError('ownership rollback escaped the repository');
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new ConfigError('rollback parent is a symbolic link: ' + path);
    parent = dirname(parent);
  }
}

export function enforceOwnership(snapshot: OwnershipSnapshot, patterns: readonly string[]): OwnershipResult {
  patterns.forEach(safePattern);
  const after = filesAt(snapshot.cwd, snapshot.scratch);
  const touched = [...new Set([...snapshot.files.keys(), ...after.keys()])].filter((p) => snapshot.files.get(p)?.hash !== after.get(p)?.hash).sort();
  const violations = touched.filter((path) => !patterns.some((p) => owns(p, path)));
  const restored: string[] = [], unrecoverable: string[] = [];
  for (const path of violations) {
    if (protectedDirty(snapshot, path)) { unrecoverable.push(path + ' (operator work was already dirty; left untouched)'); continue; }
    try {
      safeParent(snapshot.cwd, path);
      const target = join(snapshot.cwd, path), before = snapshot.files.get(path);
      if (after.has(path)) unlinkSync(target);
      if (before !== undefined) {
        const data = before.data ?? execFileSync('git', ['show', 'HEAD:' + path], { cwd: snapshot.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        mkdirSync(dirname(target), { recursive: true });
        if (before.link) symlinkSync(data.toString(), target);
        else { writeFileSync(target, data); chmodSync(target, before.mode); }
      }
      restored.push(path);
    } catch { unrecoverable.push(path + ' (rollback failed; inspect this path)'); }
  }
  return { touched, violations, restored, unrecoverable };
}
