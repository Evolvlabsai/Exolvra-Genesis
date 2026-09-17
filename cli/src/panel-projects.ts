import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { withLedgerLock, writeAtomic } from './runs-store.js';

export interface RegisteredProject { id: string; name: string; path: string }

/** State stays inside the selected project, including when a checkout uses links. */
export function panelStateDirectory(root: string): string {
  const base = realpathSync(root);
  if (lstatSync(root).isSymbolicLink() || base !== resolve(root)) throw new Error('Control panel root changed or became a symbolic link. Restart from its intended directory.');
  let current = base;
  for (const part of ['.exolvra-genesis', 'control-panel']) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current);
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory() || realpathSync(current) !== current) {
      throw new Error('Control panel state must be a directory inside the project, without symbolic links.');
    }
  }
  return current;
}

function identify(path: string): string {
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 16);
}

export class PanelProjects {
  private readonly file: string;
  private readonly root: string;
  private readonly projects: RegisteredProject[];

  constructor(root: string) {
    this.root = realpathSync(root);
    this.file = join(panelStateDirectory(this.root), 'projects.json');
    this.projects = [];
    this.load();
    this.add(this.root);
  }

  private load(): void {
    panelStateDirectory(this.root);
    const next: RegisteredProject[] = [];
    if (existsSync(this.file)) {
      if (lstatSync(this.file).isSymbolicLink() || lstatSync(this.file).size > 256 * 1024) throw new Error('Invalid control panel project registry.');
      const stored: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(stored) || stored.length > 50) throw new Error('Invalid control panel project registry.');
      for (const item of stored) {
        if (typeof item !== 'object' || item === null || typeof item.path !== 'string' || !isAbsolute(item.path) || typeof item.name !== 'string' || typeof item.id !== 'string' || identify(item.path) !== item.id || next.some((p) => p.id === item.id)) {
          throw new Error('Invalid control panel project registration.');
        }
        next.push({ id: item.id, name: item.name, path: item.path });
      }
    }
    this.projects.splice(0, this.projects.length, ...next);
  }

  list(): RegisteredProject[] { this.load(); return this.projects.map((project) => ({ ...project })); }
  get(id: string): RegisteredProject | undefined { return this.list().find((project) => project.id === id); }

  add(path: string, name?: string): RegisteredProject {
    if (typeof path !== 'string' || !path.trim() || path.length > 4096 || path.includes('\0')) throw new Error('Provide an existing project directory.');
    const canonical = realpathSync(resolve(this.root, path));
    if (!lstatSync(canonical).isDirectory()) throw new Error('Project path must be a directory.');
    return withLedgerLock(panelStateDirectory(this.root), () => {
      this.load();
      const id = identify(canonical);
      const existing = this.projects.find((project) => project.id === id);
      if (existing) return existing;
      if (this.projects.length >= 50) throw new Error('The panel supports up to 50 registered projects.');
      if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name))) throw new Error('Project name must contain 1–120 printable characters.');
      const project = { id, name: name?.trim() ?? basename(canonical), path: canonical };
      this.projects.push(project);
      try { this.save(); } catch (error) { this.projects.pop(); throw error; }
      return { ...project };
    });
  }

  remove(id: string): void {
    withLedgerLock(panelStateDirectory(this.root), () => {
      this.load();
      const index = this.projects.findIndex((project) => project.id === id);
      if (index === -1) throw new Error('Project registration not found.');
      const removed = this.projects.splice(index, 1)[0]!;
      try { this.save(); } catch (error) { this.projects.splice(index, 0, removed); throw error; }
    });
  }

  private save(): void {
    // Check again on every write so replacing the state directory cannot redirect it.
    panelStateDirectory(this.root);
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw new Error('Project registry may not be a symbolic link.');
    writeAtomic(this.file, JSON.stringify(this.projects, null, 2) + '\n');
  }
}
