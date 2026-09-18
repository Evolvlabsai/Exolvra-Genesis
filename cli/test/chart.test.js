import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { chartDirectory, chartFiles, frontier, mapCleared, newChartClaim, parseMap, readMap, staleChartClaim, validateChartUpdate, withClaim, writeMap, writeChartPrototype } from '../dist/chart.js';
import { parseChartHandoff, runChart, validateChartHandoff } from '../dist/commands/chart.js';
import { fakeTty, pipes, ENTER, CTRL_C } from './tty.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TEMP = [];
after(() => { for (const dir of TEMP) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'genesis-chart-')); TEMP.push(dir); return dir; };
const mapText = (fog = 'Which interfaces remain uncertain?') => '# Issue runner map\n\n## Destination\nA build-ready runner spec\n\n## Notes\nUse the existing loop.\n\n## Decisions so far\nnone\n\n## Not yet specified\n' + fog + '\n\n## Out of scope\n- Third-party trackers\n';
const ticket = (name = 'Find repository limits', type = 'research', extra = {}) => '# ' + name + '\n\nType: ' + type + '\nStatus: ' + (extra.status ?? 'open') + '\nMode: ' + (type === 'research' ? 'AFK' : 'HITL') + '\nBlocked by: ' + (extra.blockedBy ?? 'none') + '\nClaim: ' + (extra.claim ?? 'none') + '\n\n## Question\nWhich repository limits apply?\n\n## Answer\n' + (extra.answer ?? 'none') + '\n';
const files = () => ({ 'MAP.md': mapText(), 'tickets/research.md': ticket(), 'tickets/choose.md': ticket('Choose limits', 'grilling', { blockedBy: 'research' }) });
const indexed = (name, id) => mapText().replace('## Decisions so far\nnone', '## Decisions so far\n- [' + name + '](tickets/' + id + '.md): Verified answer.');
function context(cwd = temp(), io = pipes(), env = {}) { return { program: 'exolvra-genesis', cwd, env: { EXOLVRA_GENESIS_PLUGIN_DIR: ROOT, ...env }, stdout: io.output, stderr: io.output, isTTY: io.output.isTTY === true, isErrTTY: false, width: 80 }; }
const proposal = (value) => '```genesis-chart\n' + JSON.stringify(value) + '\n```';
function sdk(answers, calls = []) {
  return (params) => {
    calls.push(params);
    const answer = answers.shift();
    if (answer === undefined) throw new Error('No SDK response left');
    return { async interrupt() {}, async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', session_id: 'chart-session', num_turns: 1, total_cost_usd: 0.01, result: answer, errors: [] }; } };
  };
}
function answerWhen(io, phrase, answer) {
  const interval = setInterval(() => { if (io.raw().includes(phrase)) { clearInterval(interval); io.input.write(answer); } }, 5);
  interval.unref();
  return () => clearInterval(interval);
}

test('editable map parsing resolves frontier, dependencies and manual edits', () => {
  const cwd = temp(), original = writeMap(cwd, files());
  assert.deepEqual(frontier(original).map((t) => t.name), ['Find repository limits']);
  const edited = ticket('Find repository limits', 'research', { status: 'closed', answer: 'The limit is documented.' });
  writeFileSync(join(chartDirectory(cwd), 'tickets/research.md'), edited.replaceAll('\n', '\r\n'));
  assert.deepEqual(frontier(readMap(cwd)).map((t) => t.name), ['Choose limits']);
  assert.equal(mapCleared(readMap(cwd)), false);
  assert.throws(() => writeMap(cwd, { 'MAP.md': mapText('none') }, original), /changed during this session/);
});

test('untrusted shapes, escape paths and malformed markdown yield actionable configuration errors', () => {
  for (const value of [null, [], 2, 'bad', { 'MAP.md': null }, { '../escape.md': 'bad' }, { 'tickets/../escape.md': 'bad' }]) assert.throws(() => chartFiles(value));
  assert.throws(() => parseMap({ 'MAP.md': '# wrong' }), /MAP.md:1: missing ## Destination/);
  const invalid = files(); invalid['tickets/research.md'] = ticket().replace('Type: research', 'Type: unknown');
  assert.throws(() => parseMap(invalid), /tickets\/research.md:3: invalid ticket type/);
  invalid['tickets/research.md'] = ticket('Find repository limits', 'research', { blockedBy: 'choose' });
  assert.throws(() => parseMap(invalid), /blocking cycle/);
  invalid['tickets/research.md'] = ticket('Find repository limits', 'research', { blockedBy: 'absent' });
  assert.throws(() => parseMap(invalid), /unknown dependency absent/);
  invalid['tickets/research.md'] = ticket() + '\nClaim: hidden\n';
  assert.throws(() => parseMap(invalid), /expected one Claim field/);
});

test('map writes keep .gitignore and all outside files untouched and use a real exclusive lock', () => {
  const cwd = temp(); writeFileSync(join(cwd, '.gitignore'), '.exolvra-genesis/\n');
  writeMap(cwd, files());
  assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), '.exolvra-genesis/\n');
  mkdirSync(join(chartDirectory(cwd), '.write-lock'));
  assert.throws(() => writeMap(cwd, { 'MAP.md': mapText('none') }, readMap(cwd)), /locked by another writer/);
});

test('two real processes cannot both commit against the same map snapshot', async () => {
  const cwd = temp(), snapshot = writeMap(cwd, files());
  const module = pathToFileURL(resolve(ROOT, 'cli/dist/chart.js')).href;
  const worker = `import {writeMap} from ${JSON.stringify(module)};try{writeMap(process.argv[1],{'MAP.md':process.argv[2]},JSON.parse(process.argv[3]));process.exitCode=0;}catch{process.exitCode=2;}`;
  const run = (fog) => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', worker, cwd, mapText(fog), JSON.stringify(snapshot)], { windowsHide: true }); child.on('error', reject); child.on('close', resolve); });
  assert.deepEqual((await Promise.all([run('First edit'), run('Second edit')])).sort(), [0, 2]);
});

test('claims distinguish live processes, dead local processes, and unknown hosts', () => {
  assert.equal(staleChartClaim(newChartClaim()), false);
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(staleChartClaim('session:' + hostname() + ':' + child.pid + ':nonce'), true);
  assert.equal(staleChartClaim('session:some-other-host:1:nonce'), false);
  assert.equal(staleChartClaim('a-human'), false);
});

test('working updates cannot resolve other tickets, change HITL mode, or remove exclusions', () => {
  const map = parseMap(files());
  assert.throws(() => validateChartUpdate(map, { 'tickets/choose.md': ticket('Choose limits', 'grilling', { status: 'closed', answer: 'done', blockedBy: 'research' }) }, 'research'), /only its selected ticket/);
  assert.throws(() => validateChartUpdate(map, { 'tickets/research.md': ticket('Find repository limits', 'task') }, 'research'), /cannot change its ticket type/);
  assert.throws(() => validateChartUpdate(map, { 'MAP.md': mapText().replace('- Third-party trackers', 'none') }, 'research'), /remain out of scope/);
  assert.throws(() => validateChartUpdate(undefined, { 'MAP.md': mapText(), 'tickets/a.md': ticket('Invented human answer', 'grilling', { status: 'closed', answer: 'The agent decided.' }) }), /only its selected ticket/);
});

test('status reads current local files offline, emitting TSV or JSON without the SDK', async () => {
  const cwd = temp(); writeMap(cwd, files());
  const out = pipes(); assert.equal(await runChart(['status'], context(cwd, out)), 0);
  assert.match(out.raw(), /Choose limits\tgrilling\tblocked\tFind repository limits/);
  const json = pipes(); assert.equal(await runChart(['status', '--json'], context(cwd, json)), 0);
  assert.equal(JSON.parse(json.raw()).frontier[0].name, 'Find repository limits');
});

test('AFK resolves one research ticket through the SDK transport and releases its claim', async () => {
  const cwd = temp(); writeMap(cwd, files());
  const updated = ticket('Find repository limits', 'research', { status: 'closed', answer: 'Verified facts with a source.' });
  const calls = [], io = pipes();
  assert.equal(await runChart(['Find repository limits', '--afk'], context(cwd, io), { io, transport: sdk([proposal({ files: { 'MAP.md': indexed('Find repository limits', 'research'), 'tickets/research.md': updated } })], calls) }), 0);
  assert.equal(readMap(cwd).tickets.find((t) => t.id === 'research').status, 'closed');
  assert.equal(readMap(cwd).tickets.find((t) => t.id === 'research').claim, 'none');
  assert.equal(calls[0].options.permissionMode, 'plan');
  assert.equal(calls[0].options.agents, undefined);
  await assert.rejects(runChart(['Choose limits', '--afk'], context(cwd)), /open research or AFK task/);
});

test('malformed SDK proposals release claims and never write an outside file', async () => {
  const cwd = temp(); writeMap(cwd, files());
  await assert.rejects(runChart(['--afk'], context(cwd), { transport: sdk([proposal({ files: { '../escape.md': 'owned' } })]) }), /invalid map file path/);
  assert.equal(readMap(cwd).tickets[1].claim, 'none');
  assert.equal(existsSync(join(cwd, 'escape.md')), false);
});

test('HITL refuses self-answering until a real terminal reply is received', async () => {
  const cwd = temp(); writeMap(cwd, { 'MAP.md': mapText(), 'tickets/human.md': ticket('Choose a destination', 'grilling') });
  const io = fakeTty(), calls = [];
  const update = proposal({ files: { 'MAP.md': indexed('Choose a destination', 'human'), 'tickets/human.md': ticket('Choose a destination', 'grilling', { status: 'closed', answer: 'The human chose local.' }) } });
  const stop = answerWhen(io, 'Your answer', 'Use local' + ENTER);
  try {
    assert.equal(await runChart([], context(cwd, io), { io, transport: sdk([update, 'Which destination should we choose?', update], calls) }), 0);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].prompt, 'Use local');
    assert.equal(readMap(cwd).tickets[0].status, 'closed');
  } finally { stop(); }
});

test('handoff validation rejects path escapes and inherited gate weakening before writing', () => {
  const cwd = temp();
  for (const path of ['../outside.md', '.exolvra-genesis/standards.md', '.git/notes.md']) assert.throws(() => validateChartHandoff(cwd, { kind: 'spec', path, content: '# Spec' }), /invalid handoff path/);
  assert.throws(() => parseChartHandoff({ kind: 'issues', issues: [{ title: 'x', body: null }] }), /nonempty strings/);
  const outside = temp(); symlinkSync(outside, join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateChartHandoff(cwd, { kind: 'spec', path: 'linked/spec.md', content: '# Spec' }), /symbolic link/);
  mkdirSync(join(cwd, '.exolvra-genesis'));
  writeFileSync(join(cwd, '.exolvra-genesis/standards.md'), '# Repository standards\n\nA tested CLI.\n\n## Gates\n- G1. Never send secrets.\n- G2. Never replace human choices.\n\n## Standing bar\n- 100% — passing checks\n\n## Conventions\nUse plain language.\n');
  assert.throws(() => validateChartHandoff(cwd, { kind: 'spec', path: 'spec.md', content: '# Spec\n\nG1. Send secrets.\nG2. Never replace human choices.' }), /restates G1 in different words/);
  assert.equal(existsSync(join(cwd, 'spec.md')), false);
});

test('cleared-map spec handoff writes only after actual approval', async () => {
  const cwd = temp(); writeMap(cwd, { 'MAP.md': mapText('none') });
  const io = fakeTty();
  const stop = answerWhen(io, 'Write this handoff?', 'y' + ENTER);
  try {
    assert.equal(await runChart([], context(cwd, io), { io, transport: sdk([proposal({ handoff: { path: 'specs/runner.md', content: '# Runner\nApproved design.' } })]) }), 0);
    assert.equal(readFileSync(join(cwd, 'specs/runner.md'), 'utf8'), '# Runner\nApproved design.');
    assert.match(io.raw(), /exolvra-genesis run/);
  } finally { stop(); }
});

test('new chart fans out actual research sessions and merges only their disjoint tickets', async () => {
  const cwd = temp(), io = fakeTty();
  const draft = { 'MAP.md': mapText(), 'tickets/a.md': ticket('Research A'), 'tickets/b.md': ticket('Research B') };
  let leadTurns = 0, active = 0, peak = 0;
  const transport = (params) => {
    assert.deepEqual(params.options.tools, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
    const research = params.prompt.includes('"researchFanout":true');
    const id = params.prompt.includes('"ticket":"Research A"') ? 'a' : 'b';
    const result = research ? proposal({ files: { ['tickets/' + id + '.md']: ticket('Research ' + id.toUpperCase(), 'research', { status: 'closed', answer: 'Verified fact ' + id }) }, gist: 'Verified fact ' + id }) : ++leadTurns === 1 ? 'What should the destination include?' : proposal({ files: draft });
    return { async interrupt() {}, async *[Symbol.asyncIterator]() {
      if (research) { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 20)); active--; }
      yield { type: 'result', subtype: 'success', session_id: 'chart-session', num_turns: 1, total_cost_usd: 0.01, result, errors: [] };
    } };
  };
  const stop = answerWhen(io, 'Your answer', 'Build-ready inputs' + ENTER);
  try {
    assert.equal(await runChart(['A runner'], context(cwd, io), { io, transport }), 0);
    assert.equal(peak, 2);
    const map = readMap(cwd);
    assert.ok(map.tickets.every((t) => t.status === 'closed' && t.claim === 'none'));
    assert.ok(map.decisions.includes('[Research A](tickets/a.md)'));
    assert.ok(map.decisions.includes('[Research B](tickets/b.md)'));
    assert.equal(map.fog, 'Which interfaces remain uncertain?');
  } finally { stop(); }
});

test('parallel researcher cannot rewrite fog or resolve another ticket', async () => {
  const cwd = temp(), io = fakeTty();
  const draft = { 'MAP.md': mapText(), 'tickets/a.md': ticket('Research A') };
  const stop = answerWhen(io, 'Your answer', 'A narrow destination' + ENTER);
  try {
    assert.equal(await runChart(['A runner'], context(cwd, io), { io, transport: sdk(['What is the destination?', proposal({ files: draft }), proposal({ files: { 'MAP.md': mapText('none'), 'tickets/a.md': ticket('Research A', 'research', { status: 'closed', answer: 'Untrusted fact' }) }, gist: 'done' })]) }), 0);
    assert.equal(readMap(cwd).tickets[0].status, 'open');
    assert.equal(readMap(cwd).tickets[0].claim, 'none');
    assert.equal(readMap(cwd).fog, 'Which interfaces remain uncertain?');
    assert.match(io.raw(), /Research remains open/);
  } finally { stop(); }
});

test('cancelling a handoff leaves all outside files untouched', async () => {
  const cwd = temp(); writeMap(cwd, { 'MAP.md': mapText('none') });
  const io = fakeTty(), stop = answerWhen(io, 'Write this handoff?', CTRL_C);
  try {
    assert.equal(await runChart([], context(cwd, io), { io, transport: sdk([proposal({ handoff: { path: 'spec.md', content: '# Proposed spec' } })]) }), 1);
    assert.equal(existsSync(join(cwd, 'spec.md')), false);
  } finally { stop(); }
});

test('goal handoff goes through named-goal storage after terminal approval', async () => {
  const cwd = temp(); writeMap(cwd, { 'MAP.md': mapText('none') });
  const io = fakeTty(), stop = answerWhen(io, 'Write this handoff?', 'y' + ENTER);
  try {
    assert.equal(await runChart([], context(cwd, io), { io, transport: sdk([proposal({ handoff: { kind: 'goals', goals: [{ name: 'runner-build', content: '# Build runner\nUse approved inputs.' }] } })]) }), 0);
    assert.equal(readFileSync(join(cwd, '.exolvra-genesis/goals/runner-build.md'), 'utf8'), '# Build runner\nUse approved inputs.\n');
  } finally { stop(); }
});

test('a working proposal cannot report success while its selected ticket stays open', async () => {
  const cwd = temp(); writeMap(cwd, files());
  await assert.rejects(runChart(['--afk'], context(cwd), { transport: sdk([proposal({ files: {} })]) }), /selected decision ticket is still open/);
  assert.equal(readMap(cwd).tickets.find((t) => t.id === 'research').status, 'open');
  assert.equal(readMap(cwd).tickets.find((t) => t.id === 'research').claim, 'none');
});

test('prototype closure requires a saved runnable artifact and actual human confirmation and feedback', async () => {
  const cwd = temp(); writeMap(cwd, { 'MAP.md': mapText(), 'tickets/prototype.md': ticket('Try the control', 'prototype') });
  const io = fakeTty(), calls = [], html = '<!doctype html><title>Control test</title><button onclick="this.textContent=\'On\'">Off</button>';
  const stops = [answerWhen(io, 'Have you opened and tried this prototype?', 'y' + ENTER), answerWhen(io, 'After trying the prototype, what should change?', 'It toggles. Keep the button.' + ENTER)];
  try {
    assert.equal(await runChart([], context(cwd, io), { io, transport: sdk([proposal({ prototype: { html } }), proposal({ files: { 'MAP.md': indexed('Try the control', 'prototype'), 'tickets/prototype.md': ticket('Try the control', 'prototype', { status: 'closed', answer: 'The human tried the toggle and chose to keep it.' }) } })], calls) }), 0);
    const artifacts = readdirSync(join(chartDirectory(cwd), 'artifacts'));
    assert.equal(artifacts.length, 1);
    assert.equal(readFileSync(join(chartDirectory(cwd), 'artifacts', artifacts[0]), 'utf8'), html);
    assert.match(calls[1].prompt, /human confirmed trying[\s\S]*It toggles/);
    assert.equal(readMap(cwd).tickets[0].status, 'closed');
  } finally { stops.forEach((stop) => stop()); }
});

test('a prototype cannot close after an ordinary answer without a reviewed artifact', async () => {
  const cwd = temp(); writeMap(cwd, { 'MAP.md': mapText(), 'tickets/prototype.md': ticket('Try the control', 'prototype') });
  const io = fakeTty(), stop = answerWhen(io, 'Your answer', 'A simple button' + ENTER);
  try {
    await assert.rejects(runChart([], context(cwd, io), { io, transport: sdk(['What shape should it be?', proposal({ files: { 'MAP.md': indexed('Try the control', 'prototype'), 'tickets/prototype.md': ticket('Try the control', 'prototype', { status: 'closed', answer: 'Imagined feedback.' }) } })]) }), /requires human feedback after a saved runnable mockup/);
    assert.equal(readMap(cwd).tickets[0].status, 'open');
  } finally { stop(); }
});

test('prototype writes are scoped, cannot follow an artifact-directory junction, and never overwrite', () => {
  const cwd = temp(), first = writeChartPrototype(cwd, 'choice', '<h1>First</h1>'), second = writeChartPrototype(cwd, 'choice', '<h1>Second</h1>');
  assert.notEqual(first, second);
  assert.equal(readFileSync(first, 'utf8'), '<h1>First</h1>');
  assert.throws(() => writeChartPrototype(cwd, '../escape', '<h1>No</h1>'));
  const linked = temp(), outside = temp(); mkdirSync(chartDirectory(linked), { recursive: true });
  symlinkSync(outside, join(chartDirectory(linked), 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeChartPrototype(linked, 'choice', '<h1>No</h1>'), /symbolic links/);
  assert.deepEqual(readdirSync(outside), []);
});
