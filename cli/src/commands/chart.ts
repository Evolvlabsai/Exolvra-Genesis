import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { renderLeadPrompt } from '../agents.js';
import { chartEmpty, chartFiles, readMap, writeMap, frontier, mapCleared, newChartClaim, sameMap, staleChartClaim, validateChartUpdate, withClaim, writeChartPrototype } from '../chart.js';
import { ConfigError, EXIT } from '../exit.js';
import { redactSecrets } from '../redact.js';
import { goalPath, newGoalNameFault, writeGoal } from '../goals.js';
import { assertStandingGatesKept } from '../input.js';
import { DEFAULT_MODEL_CHOICE } from '../models.js';
import { loadPluginSources } from '../plugin-dir.js';
import { type Command, type BooleanFlagSpec, type ValueFlagSpec, directoryValue, modelValue, parseInvocation, registerCommand } from '../registry.js';
import { createSession, type SessionTransport } from '../session.js';
import { loadStandards } from '../standards.js';
import { PROGRAM, plainText, renderCommandHelp, renderTable } from '../usage.js';
import { positionalTokens } from './resume.js';
import type { PromptStreams } from '../prompts.js';
import type { Ctx } from '../registry.js';

const directory: ValueFlagSpec<string> = { long: 'directory', short: 'C', value: directoryValue, summary: 'Use the map under dir' };
const model: ValueFlagSpec<string> = { long: 'model', value: modelValue, summary: 'Use this lead model for the decision session' };
const json: BooleanFlagSpec = { long: 'json', summary: 'Print chart status as JSON' };
const afk: BooleanFlagSpec = { long: 'afk', summary: 'Work an unattended research or AFK task ticket' };
const release: BooleanFlagSpec = { long: 'release-claim', summary: 'Release a named stale claim after confirmation' };
const argument = { name: 'idea-or-ticket', value: { arg: 'idea-or-ticket', invalid: '   ', parse(raw: string) { if (!raw.trim()) throw new ConfigError('a chart idea or ticket name cannot be empty'); return raw.trim(); } } };

export const chartCommand: Command = {
  name: 'chart', summary: 'Chart a destination or resolve one decision ticket', usage: PROGRAM + ' chart [idea-or-ticket | status] [flags]', flags: [directory, model, json, afk, release], cwdFlag: directory,
  description: ['Decisions live in .exolvra-genesis/map/ as editable markdown, versioned beside the code. chart status lists the frontier and remaining fog.', 'A session handles one ticket. Human decisions and handoff approvals require a live terminal. --release-claim releases a named abandoned claim after confirmation.', 'Independent research tickets run unattended and in parallel when a map is created; --afk works one such ticket.'],
  examples: [PROGRAM + ' chart "A build-ready issue runner"', PROGRAM + ' chart status --json', PROGRAM + ' chart "Find repository limits" --afk'],
  run: (argv, ctx) => runChart(argv, ctx),
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('the chart proposal must be an object');
  return value as Record<string, unknown>;
}
export type ChartHandoff = { kind: 'spec'; path: string; content: string } | { kind: 'goals'; goals: { name: string; content: string }[] } | { kind: 'issues'; issues: { title: string; body: string }[] };
export function parseChartHandoff(value: unknown): ChartHandoff {
  const item = object(value);
  const string = (value: unknown): string => { if (typeof value !== 'string' || !value.trim()) throw new ConfigError('handoff fields must be nonempty strings'); return value; };
  if (item.kind === 'goals') {
    if (!Array.isArray(item.goals) || !item.goals.length) throw new ConfigError('a goals handoff needs at least one goal');
    return { kind: 'goals', goals: item.goals.map((value) => { const goal = object(value); return { name: string(goal.name), content: string(goal.content) }; }) };
  }
  if (item.kind === 'issues') {
    if (!Array.isArray(item.issues) || !item.issues.length) throw new ConfigError('an issues handoff needs at least one issue');
    return { kind: 'issues', issues: item.issues.map((value) => { const issue = object(value); return { title: string(issue.title), body: string(issue.body) }; }) };
  }
  if (item.kind !== undefined && item.kind !== 'spec') throw new ConfigError('unknown chart handoff kind');
  return { kind: 'spec', path: string(item.path), content: string(item.content) };
}

/** Validate every artifact before asking for approval, without writing it. */
export function validateChartHandoff(cwd: string, handoff: ChartHandoff): void {
  if (handoff.kind === 'issues') {
    for (const issue of handoff.issues) assertStandingGatesKept({ kind: 'goal', goal: issue.body }, cwd);
    return;
  }
  const artifacts = handoff.kind === 'spec' ? [{ path: handoff.path, content: handoff.content }] : handoff.goals.map((goal) => {
    const fault = newGoalNameFault(goal.name);
    if (fault) throw new ConfigError('invalid handoff goal name: ' + fault);
    return { path: relative(cwd, goalPath(cwd, goal.name)), content: goal.content };
  });
  const names = new Set<string>();
  for (const item of artifacts) {
    const path = resolve(cwd, item.path), rel = relative(cwd, path).replaceAll('\\', '/');
    if (isAbsolute(item.path) || rel === '..' || rel.startsWith('../') || !rel.endsWith('.md') || (handoff.kind === 'spec' && (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.exolvra-genesis/')))) throw new ConfigError('invalid handoff path: ' + item.path);
    if (names.has(path.toLowerCase())) throw new ConfigError('duplicate handoff destination: ' + item.path);
    names.add(path.toLowerCase());
    if (existsSync(path)) throw new ConfigError('handoff destination already exists: ' + item.path);
    for (let cursor = dirname(path); cursor !== resolve(cwd); cursor = dirname(cursor)) {
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new ConfigError('handoff parent cannot be a symbolic link: ' + item.path);
    }
    assertStandingGatesKept({ kind: 'goal', goal: item.content }, cwd);
  }
}

/** Streams and SDK transport are explicit to exercise the real conversation in tests. */
export async function runChart(argv: string[], ctx: Ctx, options: { io?: PromptStreams; transport?: SessionTransport } = {}): Promise<number> {
  const named = positionalTokens(chartCommand, argv).length > 0;
  const args = parseInvocation(named ? { ...chartCommand, argument } : chartCommand, argv, ctx);
  if (args.help) { ctx.stdout.write(renderCommandHelp(chartCommand)); return EXIT.WIN; }
  const input = named ? args.argument(argument) : '';
  const mode = 'local';
  let map = readMap(args.cwd);
  const safe = (value: string): string => redactSecrets(value);
  if (input === 'status') {
    const front = map ? frontier(map) : [];
    const result = { tracker: mode, destination: map?.destination ?? null, frontier: front, blocked: map?.tickets.filter((t) => t.status === 'open' && !front.includes(t)) ?? [], fog: map?.fog ?? '' };
    if (args.bool(json)) ctx.stdout.write(safe(JSON.stringify(result)) + '\n');
    else if (!map) ctx.stdout.write('no decision map yet\n');
    else {
      ctx.stdout.write(plainText(safe(map.destination)) + '\n');
      ctx.stdout.write(renderTable(['ticket', 'type', 'state', 'blocked by'], map.tickets.filter((t) => t.status === 'open').map((t) => [safe(t.name), t.type, front.includes(t) ? 'frontier' : !chartEmpty(t.claim) ? staleChartClaim(t.claim) ? 'stale claim' : 'claimed' : 'blocked', t.blockedBy.map((id) => safe(map!.tickets.find((p) => p.id === id)!.name)).join(', ')]), { tty: ctx.isTTY, width: ctx.width }).join('\n') + '\n');
      ctx.stdout.write('Not yet specified: ' + plainText(safe(map.fog || 'none')) + '\n');
    }
    return EXIT.WIN;
  }
  if (args.bool(json)) throw new ConfigError('--json is available with chart status');
  const prompts = await import('../prompts.js');
  const io = options.io ?? { input: process.stdin, output: ctx.stdout as NodeJS.WriteStream };
  const interactive = prompts.isInteractive(io);
  const available = map?.tickets.filter((t) => t.status === 'open' && chartEmpty(t.claim) && t.blockedBy.every((id) => map!.tickets.find((b) => b.id === id)?.status === 'closed')) ?? [];
  const ticket = map === undefined ? undefined : input ? map.tickets.find((t) => t.name === input || t.id === input) : available[0];
  if (map && input && !ticket) throw new ConfigError('no decision ticket named ' + input);
  if (args.bool(release)) {
    if (!interactive || !input || !ticket || chartEmpty(ticket.claim)) throw new ConfigError('--release-claim requires a named claimed ticket and a live terminal');
    if (!staleChartClaim(ticket.claim)) throw new ConfigError('this claim is live or belongs to another host; its owner must release it, or edit the ticket after verifying it is abandoned');
    if (!(await prompts.askConfirm('Release the abandoned claim on ' + safe(ticket.name) + '?', io, { initial: false }))) return EXIT.LOSS;
    writeMap(args.cwd, { ['tickets/' + ticket.id + '.md']: withClaim(map!.files['tickets/' + ticket.id + '.md']!, 'none') }, map);
    ctx.stdout.write('Claim released.\n'); return EXIT.WIN;
  }
  if (ticket && !available.includes(ticket)) throw new ConfigError('ticket is blocked, closed, or claimed: ' + safe(ticket.name));
  if (args.bool(afk) && (!ticket || (ticket.type !== 'research' && !(ticket.type === 'task' && ticket.mode === 'AFK')))) throw new ConfigError('--afk requires an open research or AFK task ticket');
  if (!args.bool(afk) && !interactive) throw new ConfigError('charting requires a live exchange on a terminal; chart status works headlessly');
  if (map && !ticket && !mapCleared(map) && map.tickets.some((t) => t.status === 'open')) throw new ConfigError('no unclaimed frontier ticket is available; inspect chart status');
  const sources = loadPluginSources(ctx.env), standards = loadStandards(args.cwd);
  const readTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
  const leadModel = { ...DEFAULT_MODEL_CHOICE, lead: args.get(model) ?? 'inherit' };

  // The markdown gives each researcher its brief. The transport owns claims,
  // parallel provider sessions, and serialization of their disjoint answers.
  async function researchFanout(): Promise<void> {
    if (!map) return;
    const pending = frontier(map).filter((t) => t.type === 'research');
    if (!pending.length) return;
    const jobs: { id: string; name: string; claim: string }[] = [];
    try {
      for (const research of pending) {
        const owner = newChartClaim(), path = 'tickets/' + research.id + '.md';
        map = writeMap(args.cwd, { [path]: withClaim(map!.files[path]!, owner) }, map);
        jobs.push({ id: research.id, name: research.name, claim: owner });
      }
      const baseline = map!;
      // Cap simultaneous sessions; there is no background work after this command exits.
      for (let offset = 0; offset < jobs.length; offset += 4) {
        const batch = jobs.slice(offset, offset + 4);
        const answers = await Promise.allSettled(batch.map(async (job) => {
          const brief = { input, tracker: mode, ticket: job.name, map: baseline.files, standards, afk: true, researchFanout: true };
          const session = createSession({ prompt: safe(renderLeadPrompt(sources.chartMd, JSON.stringify(brief))), sources, models: leadModel, cwd: args.cwd, env: ctx.env, subagents: false, permissionMode: 'plan', tools: readTools, maxTurns: 30, transport: options.transport });
          const result = await session.start();
          if (result.status !== 'complete') throw new ConfigError(result.error ?? 'research session did not finish');
          const block = result.text.match(/```genesis-chart\s*\n([\s\S]*?)\n```/);
          if (!block) throw new ConfigError('research produced no decision proposal');
          const proposed = object(JSON.parse(block[1]!)), changes = chartFiles(proposed.files);
          const path = 'tickets/' + job.id + '.md';
          if (Object.keys(changes).length !== 1 || changes[path] === undefined || proposed.handoff !== undefined || typeof proposed.gist !== 'string' || !proposed.gist.trim() || /[\r\n]/.test(proposed.gist)) throw new ConfigError('parallel research must propose its ticket alone and one gist line');
          const label = job.name.replace(/[\[\]\\]/g, '\\$&');
          const entry = '- [' + label + '](tickets/' + job.id + '.md): ' + proposed.gist;
          const indexed = baseline.files['MAP.md']!.replace('## Decisions so far', '## Decisions so far\n' + entry);
          const candidate = validateChartUpdate(baseline, { ...changes, 'MAP.md': indexed }, job.id);
          if (candidate.tickets.find((t) => t.id === job.id)?.status !== 'closed') throw new ConfigError('research did not resolve its ticket');
          return { text: safe(changes[path]), gist: plainText(safe(proposed.gist)) };
        }));
        for (let index = 0; index < batch.length; index++) {
          const job = batch[index]!, result = answers[index]!;
          if (result.status === 'rejected') { ctx.stderr.write('Research remains open (' + safe(job.name) + '): ' + safe(result.reason instanceof Error ? result.reason.message : String(result.reason)) + '\n'); continue; }
          map = readMap(args.cwd);
          const path = 'tickets/' + job.id + '.md';
          if (!map || map.files[path] !== baseline.files[path]) throw new ConfigError('research ticket changed before its answer could be saved: ' + job.name);
          const label = job.name.replace(/[\[\]\\]/g, '\\$&');
          const entry = '- [' + label + '](tickets/' + job.id + '.md): ' + result.value.gist;
          const mapBody = map.files['MAP.md']!.replace(/(## Decisions so far\s*\n)([\s\S]*?)(?=\n## |$)/, (_match, heading: string, content: string) => heading + (chartEmpty(content) ? '' : content.trim() + '\n') + entry + '\n');
          const changes = { 'MAP.md': mapBody, [path]: withClaim(result.value.text, 'none') };
          map = writeMap(args.cwd, changes, map);
          ctx.stdout.write('Research resolved: ' + safe(job.name) + '\n');
        }
      }
    } finally {
      for (const job of jobs) {
        try {
          const current = readMap(args.cwd), path = 'tickets/' + job.id + '.md';
          if (current?.tickets.find((t) => t.id === job.id)?.claim === job.claim) writeMap(args.cwd, { [path]: withClaim(current.files[path]!, 'none') }, current);
        } catch (error) { ctx.stderr.write('Research claim needs attention (' + safe(job.name) + '): ' + safe(error instanceof Error ? error.message : String(error)) + '\n'); }
      }
    }
  }
  const selected = ticket?.id, claim = newChartClaim();
  let claimed = false;
  let sessionId: string | undefined, exchanges = 0;
  let prototypeReviewed = false, pendingPrototype: string | undefined;
  if (interactive) prompts.beginRun(PROGRAM + ' chart', io);
  try {
    if (selected !== undefined && map !== undefined) {
      const path = 'tickets/' + selected + '.md';
      map = writeMap(args.cwd, { [path]: withClaim(map.files[path]!, claim) }, map);
      claimed = true;
    }
    let prompt = renderLeadPrompt(sources.chartMd, JSON.stringify({ input, tracker: mode, ticket: ticket?.name ?? null, map: map?.files ?? null, standards, afk: args.bool(afk) })) + '\n\nInterview machinery:\n' + sources.interviewMd;
    for (let turn = 0; turn < 50; turn++) {
      const session = createSession({ prompt: safe(prompt), sources, models: leadModel, cwd: args.cwd, env: ctx.env, subagents: false, permissionMode: 'plan', tools: readTools, maxTurns: 30, transport: options.transport });
      const result = await (sessionId === undefined ? session.start() : session.resume(sessionId));
      sessionId = result.sessionId;
      if (result.status !== 'complete') { ctx.stderr.write(safe(result.error ?? 'decision session did not finish') + '\n'); return EXIT.LOSS; }
      const block = result.text.match(/```genesis-chart\s*\n([\s\S]*?)\n```/);
      const prose = safe(result.text.replace(/```genesis-chart\s*\n[\s\S]*?\n```/, '').trim());
      if (prose) { if (interactive) prompts.logReport(prose, io); else ctx.stdout.write(prose + '\n'); }
      if (block) {
        let proposal: Record<string, unknown>;
        try { proposal = object(JSON.parse(block[1]!)); } catch { throw new ConfigError('the decision proposal is not a readable JSON object'); }
        if (['files', 'handoff', 'clear', 'prototype'].filter((key) => proposal[key] !== undefined).length !== 1) throw new ConfigError('a chart proposal must contain exactly one of files, handoff, clear, or prototype');
        if (proposal.prototype !== undefined) {
          if (!interactive || ticket?.type !== 'prototype' || !selected) throw new ConfigError('a prototype artifact requires the selected prototype ticket and a live human');
          const latest = readMap(args.cwd);
          if (!sameMap(latest, map)) throw new ConfigError('the map changed before the prototype could be saved; reload');
          const prototype = object(proposal.prototype);
          if (typeof prototype.html !== 'string') throw new ConfigError('prototype.html must contain the complete self-contained HTML mockup');
          pendingPrototype = writeChartPrototype(args.cwd, selected, safe(prototype.html));
          prototypeReviewed = false;
          ctx.stdout.write('Open this prototype and try it before answering:\n' + pendingPrototype + '\n');
        }
        if (proposal.files !== undefined || proposal.clear !== undefined) {
          if (!args.bool(afk) && exchanges === 0) { prompt = 'Ask the human your first question and wait for the answer before proposing a resolution.'; continue; }
          if (proposal.clear !== undefined) {
            if (proposal.clear !== true || map) throw new ConfigError('only a new chart can report a clear path without creating a map');
            ctx.stdout.write('The path is clear. Continue with exolvra-genesis interview or exolvra-genesis run.\n'); return EXIT.WIN;
          }
          const changes = chartFiles(proposal.files);
          if (ticket?.type === 'prototype' && !prototypeReviewed) throw new ConfigError('a prototype ticket requires human feedback after a saved runnable mockup before it can close');
          const candidate = validateChartUpdate(map, changes, selected), creating = map === undefined;
          if (creating && chartEmpty(candidate.fog)) throw new ConfigError('a destination with no fog should use interview or run directly; no map was written');
          for (const [name, text] of Object.entries(changes)) changes[name] = safe(text);
          if (selected !== undefined) {
            const path = 'tickets/' + selected + '.md';
            changes[path] = withClaim(changes[path] ?? map!.files[path]!, 'none');
          }
          map = writeMap(args.cwd, changes, map);
          ctx.stdout.write('Decision map saved.\n');
          if (creating) await researchFanout();
          return EXIT.WIN;
        }
        if (proposal.handoff !== undefined) {
          if (!map || !mapCleared(map)) throw new ConfigError('handoff requires all tickets closed and no remaining fog');
          if (!interactive) throw new ConfigError('handoff requires approval on a terminal');
          const handoff = parseChartHandoff(JSON.parse(safe(JSON.stringify(proposal.handoff))));
          validateChartHandoff(args.cwd, handoff);
          if (handoff.kind === 'issues') throw new ConfigError('a ready-issue handoff needs the GitHub tracker, which this package does not include; hand off a spec or goals instead');
          prompts.logReport(handoff.kind === 'spec' ? handoff.path + '\n\n' + handoff.content : handoff.goals.map((g) => g.name + '\n\n' + g.content).join('\n\n'), io, { wrap: false });
          if (await prompts.askConfirm('Write this handoff?', io, { initial: false, closeWith: 'Handoff cancelled.' })) {
            const latest = readMap(args.cwd);
            if (!sameMap(latest, map)) throw new ConfigError('the map changed while the handoff was being reviewed; reload before writing');
            validateChartHandoff(args.cwd, handoff);
            if (handoff.kind === 'spec') {
              const path = resolve(args.cwd, handoff.path);
              mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, handoff.content, { encoding: 'utf8', flag: 'wx' });
              ctx.stdout.write('Run it with: exolvra-genesis run ' + JSON.stringify(handoff.path) + ' --directory ' + JSON.stringify(args.cwd) + '\n');
            } else for (const goal of handoff.goals) {
              writeGoal(args.cwd, goal.name, goal.content);
              ctx.stdout.write('Run it with: exolvra-genesis run ' + JSON.stringify(goal.name) + ' --directory ' + JSON.stringify(args.cwd) + '\n');
            }
            return EXIT.WIN;
          }
        }
      }
      if (!interactive || !sessionId) return EXIT.LOSS;
      if (pendingPrototype && !(await prompts.askConfirm('Have you opened and tried this prototype?', io, { initial: false, closeWith: 'Prototype review stopped.' }))) {
        prompt = 'The human has not yet tried the prototype at ' + pendingPrototype + '. Help them review it; do not close the ticket.';
        pendingPrototype = undefined;
        continue;
      }
      prompt = await prompts.askText(pendingPrototype ? 'After trying the prototype, what should change?' : 'Your answer', io, { placeholder: 'Resolve this decision', closeWith: 'Decision session stopped.' });
      if (pendingPrototype) {
        prompt = 'The human confirmed trying the prototype at ' + pendingPrototype + '\nTheir observations: ' + prompt;
        prototypeReviewed = true; pendingPrototype = undefined;
      }
      exchanges++;
    }
    throw new ConfigError('decision session reached its exchange limit; the map is preserved');
  } catch (error) {
    if (prompts.isPromptCancelled(error)) return EXIT.LOSS;
    throw error;
  } finally {
    if (claimed && selected !== undefined) {
      try {
        const current = readMap(args.cwd), path = 'tickets/' + selected + '.md';
        if (current?.tickets.find((t) => t.id === selected)?.claim === claim) writeMap(args.cwd, { [path]: withClaim(current.files[path]!, 'none') }, current);
      } catch (error) { ctx.stderr.write('Claim release failed; inspect chart status before retrying: ' + safe(error instanceof Error ? error.message : String(error)) + '\n'); }
    }
    if (interactive) prompts.endRun('Decision session ended', io);
  }
}
registerCommand(chartCommand);
