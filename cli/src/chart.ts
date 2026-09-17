import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigError } from './exit.js';
import { writeAtomic } from './runs-store.js';

export interface DecisionTicket { id: string; name: string; type: 'research' | 'prototype' | 'grilling' | 'task'; mode: 'HITL' | 'AFK'; status: 'open' | 'closed'; blockedBy: string[]; claim: string; question: string; answer: string }
export interface DecisionMap { destination: string; notes: string; decisions: string; fog: string; outOfScope: string; tickets: DecisionTicket[]; files: Record<string, string> }
export const MAP_SECTIONS = ['Destination', 'Notes', 'Decisions so far', 'Not yet specified', 'Out of scope'];
const ID = /^[a-zA-Z0-9][\w-]{0,63}$/;

export function chartDirectory(cwd: string): string {
  const root = resolve(cwd, '.exolvra-genesis', 'map');
  for (const path of [resolve(cwd, '.exolvra-genesis'), root, join(root, 'tickets'), join(root, 'artifacts'), join(root, 'MAP.md')]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new ConfigError('map paths cannot be symbolic links: ' + path);
  }
  return root;
}
export function chartSection(text: string, heading: string): string {
  const lines = text.split(/\r?\n/), begin = lines.findIndex((l) => l.trim() === '## ' + heading);
  if (begin < 0) return '';
  const end = lines.findIndex((l, i) => i > begin && /^##\s/.test(l));
  return lines.slice(begin + 1, end < 0 ? undefined : end).join('\n').trim();
}
export function chartEmpty(text: string): boolean { return !text.trim() || /^(?:[-*]\s+)?(?:none|nothing|empty|—|-)[.!]?$/i.test(text.trim()); }

/** Check untrusted proposal shapes before reading markdown or paths. */
export function chartFiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('map files must be an object of markdown strings');
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    if (name !== 'MAP.md' && !/^tickets\/[A-Za-z0-9][\w-]{0,63}\.md$/.test(name)) throw new ConfigError(name + ':1: invalid map file path');
    if (typeof text !== 'string') throw new ConfigError(name + ':1: expected markdown text');
    files[name] = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  }
  return files;
}
export function parseMap(input: unknown): DecisionMap {
  const files = chartFiles(input), errors: string[] = [], map = files['MAP.md'] ?? '';
  function headings(path: string, text: string, expected: string[]): void {
    const lines = text.split('\n');
    for (const title of expected) {
      const found = lines.flatMap((l, i) => l.trim() === '## ' + title ? [i + 1] : []);
      if (!found.length) errors.push(path + ':1: missing ## ' + title);
      if (found.length > 1) errors.push(path + ':' + found[1] + ': duplicate ## ' + title);
    }
  }
  headings('MAP.md', map, MAP_SECTIONS);
  if (chartEmpty(chartSection(map, 'Destination'))) errors.push('MAP.md:1: Destination must name what done looks like');
  const tickets: DecisionTicket[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (path === 'MAP.md') continue;
    const id = path.slice('tickets/'.length, -3), lines = text.split('\n');
    const field = (name: string): string => {
      const found = lines.flatMap((l, i) => l.startsWith(name + ':') ? [i] : []);
      if (found.length !== 1) errors.push(path + ':' + ((found[1] ?? 0) + 1) + ': expected one ' + name + ' field');
      return found.length ? lines[found[0]!]!.slice(name.length + 1).trim() : '';
    };
    const type = field('Type'), status = field('Status'), mode = field('Mode'), claim = field('Claim');
    const complain = (name: string, message: string): void => { errors.push(path + ':' + Math.max(1, lines.findIndex((l) => l.startsWith(name + ':')) + 1) + ': ' + message); };
    if (!['research', 'prototype', 'grilling', 'task'].includes(type)) complain('Type', 'invalid ticket type');
    if (!['open', 'closed'].includes(status)) complain('Status', 'Status must be open or closed');
    if (!['HITL', 'AFK'].includes(mode)) complain('Mode', 'Mode must be HITL or AFK');
    if (['prototype', 'grilling'].includes(type) && mode !== 'HITL') complain('Mode', 'this ticket requires a live human exchange');
    if (type === 'research' && mode !== 'AFK') complain('Mode', 'research tickets use AFK mode');
    if (!claim) complain('Claim', 'Claim must name an owner or none');
    headings(path, text, ['Question', 'Answer']);
    const question = chartSection(text, 'Question'), answer = chartSection(text, 'Answer');
    if (chartEmpty(question)) errors.push(path + ':1: missing Question');
    if (status === 'closed' && chartEmpty(answer)) errors.push(path + ':1: a closed ticket needs an Answer');
    const blocks = field('Blocked by');
    const blockedBy = chartEmpty(blocks) ? [] : blocks.split(',').map((s) => s.trim());
    if (blockedBy.some((b) => !ID.test(b))) complain('Blocked by', 'expected comma-separated ticket ids or none');
    const name = lines.find((l) => l.startsWith('# '))?.slice(2).trim();
    if (!name) errors.push(path + ':1: a ticket needs a name in its # heading');
    tickets.push({ id, name: name ?? id, type: type as DecisionTicket['type'], mode: mode as DecisionTicket['mode'], status: status as DecisionTicket['status'], claim, blockedBy, question, answer });
  }
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const names = new Set<string>();
  for (const ticket of tickets) {
    if (names.has(ticket.name)) errors.push('tickets/' + ticket.id + '.md:1: duplicate ticket name');
    names.add(ticket.name);
    for (const id of ticket.blockedBy) if (!byId.has(id)) errors.push('tickets/' + ticket.id + '.md:1: unknown dependency ' + id);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { errors.push('tickets/' + id + '.md:1: blocking cycle'); return; }
    if (visited.has(id)) return;
    visiting.add(id); byId.get(id)?.blockedBy.forEach(visit); visiting.delete(id); visited.add(id);
  };
  tickets.forEach((t) => visit(t.id));
  if (errors.length) throw new ConfigError('could not read the decision map\n  ' + errors.join('\n  '));
  return { destination: chartSection(map, 'Destination'), notes: chartSection(map, 'Notes'), decisions: chartSection(map, 'Decisions so far'), fog: chartSection(map, 'Not yet specified'), outOfScope: chartSection(map, 'Out of scope'), tickets, files };
}
export function readMap(cwd: string): DecisionMap | undefined {
  const root = chartDirectory(cwd);
  if (!existsSync(join(root, 'MAP.md'))) return undefined;
  const files: Record<string, string> = { 'MAP.md': readFileSync(join(root, 'MAP.md'), 'utf8') };
  if (existsSync(join(root, 'tickets'))) for (const name of readdirSync(join(root, 'tickets')).sort()) {
    if (!name.endsWith('.md')) continue;
    const path = join(root, 'tickets', name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new ConfigError('ticket must be a regular file: ' + name);
    files['tickets/' + name] = readFileSync(path, 'utf8');
  }
  return parseMap(files);
}
export function frontier(map: DecisionMap): DecisionTicket[] {
  return map.tickets.filter((t) => t.status === 'open' && chartEmpty(t.claim) && t.blockedBy.every((id) => map.tickets.find((b) => b.id === id)?.status === 'closed'));
}
export function mapCleared(map: DecisionMap): boolean { return map.tickets.every((t) => t.status === 'closed') && chartEmpty(map.fog); }
export function sameMap(a: DecisionMap | undefined, b: DecisionMap | undefined): boolean {
  return a === undefined || b === undefined ? a === b : Object.keys(a.files).length === Object.keys(b.files).length && Object.entries(a.files).every(([name, text]) => b.files[name] === text);
}
export function writeMap(cwd: string, input: unknown, expected?: DecisionMap): DecisionMap {
  const changes = chartFiles(input), root = chartDirectory(cwd);
  mkdirSync(root, { recursive: true });
  const lock = join(root, '.write-lock');
  try { mkdirSync(lock); } catch { throw new ConfigError('the decision map is locked by another writer; retry, or remove map/.write-lock after confirming no chart process is running'); }
  try {
    const current = readMap(cwd);
    if (!sameMap(current, expected)) throw new ConfigError('the map changed during this session; reload before saving');
    const parsed = parseMap({ ...current?.files, ...changes });
    mkdirSync(join(root, 'tickets'), { recursive: true });
    for (const [name, text] of Object.entries(changes)) {
      if (existsSync(join(root, name)) && lstatSync(join(root, name)).isSymbolicLink()) throw new ConfigError('map file cannot be a symbolic link: ' + name);
      writeAtomic(join(root, name), text);
    }
    return parsed;
  } finally { rmdirSync(lock); }
}
export const newChartClaim = (): string => 'session:' + hostname() + ':' + process.pid + ':' + randomUUID();
export function staleChartClaim(claim: string): boolean {
  const parts = claim.split(':');
  if (parts.length !== 4 || parts[0] !== 'session' || parts[1] !== hostname() || !/^\d+$/.test(parts[2]!)) return false;
  try { process.kill(Number(parts[2]), 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
export function withClaim(text: string, claim: string): string { return text.replace(/^Claim:.*$/m, 'Claim: ' + claim); }
/** Prototype artifacts stay inside the map and never replace an earlier artifact. */
export function writeChartPrototype(cwd: string, ticketId: string, html: unknown): string {
  if (!ID.test(ticketId) || typeof html !== 'string' || !html.trim() || Buffer.byteLength(html) > 4 * 1024 * 1024) throw new ConfigError('a prototype needs a selected ticket and nonempty HTML of at most 4 MiB');
  const directory = join(chartDirectory(cwd), 'artifacts');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ticketId + '-' + randomUUID() + '.html');
  writeFileSync(path, html, { encoding: 'utf8', flag: 'wx' });
  return path;
}
export function validateChartUpdate(previous: DecisionMap | undefined, changes: unknown, selected?: string): DecisionMap {
  const files = chartFiles(changes), candidate = parseMap({ ...previous?.files, ...files });
  for (const ticket of candidate.tickets) {
    const old = previous?.tickets.find((t) => t.id === ticket.id);
    if (old && old.id !== selected && files['tickets/' + old.id + '.md'] !== undefined && files['tickets/' + old.id + '.md'] !== previous!.files['tickets/' + old.id + '.md']) throw new ConfigError('a chart session may change only its selected ticket and create new tickets');
    if (ticket.status === 'closed' && old?.status !== 'closed' && ticket.id !== selected) throw new ConfigError('a chart session may resolve only its selected ticket');
    if (ticket.status === 'closed' && old?.status !== 'closed') {
      const escapedName = ticket.name.replace(/[\[\]\\]/g, '\\$&');
      if (!candidate.decisions.split('\n').some((line) => line.includes('[' + escapedName + '](') && /^\s*[-*]\s/.test(line))) throw new ConfigError('a resolved ticket needs a name-linked gist in Decisions so far: ' + ticket.name);
    }
    if (!old && !chartEmpty(ticket.claim)) throw new ConfigError('new tickets must be unclaimed');
    if (old && old.id === selected && (ticket.type !== old.type || ticket.mode !== old.mode)) throw new ConfigError('a session cannot change its ticket type or human-exchange requirement');
  }
  if (previous && !chartEmpty(previous.outOfScope)) for (const line of previous.outOfScope.split('\n').filter((s) => s.trim())) {
    if (!candidate.outOfScope.split('\n').includes(line)) throw new ConfigError('previously excluded work must remain out of scope');
  }
  if (selected !== undefined && candidate.tickets.find((t) => t.id === selected)?.status !== 'closed') throw new ConfigError('the selected decision ticket is still open; ask the human or report incomplete research instead of claiming completion');
  return candidate;
}
