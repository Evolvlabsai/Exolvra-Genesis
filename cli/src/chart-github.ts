import { chartFiles, parseMap, sameMap, type DecisionMap, type DecisionTicket } from './chart.js';
import { randomUUID } from 'node:crypto';
import { ConfigError } from './exit.js';
import { type GitHubClient, type Issue, type IssueComment, type Repo } from './github.js';
import { DEFAULT_CLAIM_TTL_MS } from './issue-run.js';

const TICKET_MARKER = /<!-- genesis-chart-ticket: ([A-Za-z0-9][\w-]{0,63}) -->/;
export interface GitHubMap { map: DecisionMap; issue: Issue; tickets: Map<string, Issue>; lease?: GitHubChartClaim }
export interface GitHubChartClaim { issue: number; comment: number; login: string; token: string; ttlMs: number }
const CLAIM_MARKER = '<!-- genesis-chart-claim ';
interface ClaimReceipt { token: string; heartbeat: string; status: 'active' | 'released' }
function receipt(comment: IssueComment): ClaimReceipt | undefined {
  try {
    const value = JSON.parse(comment.body.match(/<!-- genesis-chart-claim (.*?) -->/)?.[1] ?? 'null') as ClaimReceipt | null;
    return value && typeof value.token === 'string' && /^[\w-]{36}$/.test(value.token) && typeof value.heartbeat === 'string' && Number.isFinite(Date.parse(value.heartbeat)) && ['active', 'released'].includes(value.status) ? value : undefined;
  } catch { return undefined; }
}
async function ownReceipt(client: GitHubClient, repo: Repo, issue: number, login: string): Promise<IssueComment | undefined> {
  return (await client.listIssueComments(repo, issue)).filter((c) => c.author.toLowerCase() === login.toLowerCase() && c.body.includes(CLAIM_MARKER)).sort((a, b) => b.id - a.id)[0];
}
function expired(comment: IssueComment | undefined, now: number, ttlMs: number): boolean {
  const value = comment && receipt(comment);
  // GitHub's own update clock prevents an old timestamp pasted into a new comment
  // from turning fresh authenticated evidence into an expired claim.
  return Boolean(value?.status === 'active' && now - Math.max(Date.parse(value.heartbeat), Date.parse(comment!.updatedAt)) > ttlMs);
}
function claimBody(token: string, now: number, status: 'active' | 'released', takeover = false): string {
  return 'Decision ticket claim ' + (takeover ? 'reclaimed after its heartbeat expired' : status) + '.\n\n' + CLAIM_MARKER + JSON.stringify({ token, heartbeat: new Date(now).toISOString(), status }) + ' -->';
}
export async function reclaimableGitHubTickets(client: GitHubClient, repo: Repo, map: GitHubMap, login: string, ttlMs = DEFAULT_CLAIM_TTL_MS, now = Date.now()): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const [id, issue] of map.tickets) {
    if (issue.state !== 'open' || issue.assignees?.length !== 1 || issue.assignees[0]!.toLowerCase() !== login.toLowerCase()) continue;
    if (expired(await ownReceipt(client, repo, issue.number, login), now, ttlMs)) ids.add(id);
  }
  return ids;
}
export async function assertGitHubChartClaim(client: GitHubClient, repo: Repo, claim: GitHubChartClaim): Promise<void> {
  const issue = await client.getIssue(repo, claim.issue), comment = await ownReceipt(client, repo, claim.issue, claim.login);
  const value = comment && receipt(comment);
  if (issue.assignees?.length !== 1 || issue.assignees[0]!.toLowerCase() !== claim.login.toLowerCase() || comment?.id !== claim.comment || value?.token !== claim.token || value.status !== 'active') throw new ConfigError('the decision ticket claim changed; discard this session and reload');
}
export async function heartbeatGitHubChartClaim(client: GitHubClient, repo: Repo, claim: GitHubChartClaim, now = Date.now()): Promise<void> {
  await assertGitHubChartClaim(client, repo, claim);
  await client.updateComment(repo, claim.comment, claimBody(claim.token, now, 'active'));
}
export async function releaseGitHubChartClaim(client: GitHubClient, repo: Repo, claim: GitHubChartClaim): Promise<void> {
  await assertGitHubChartClaim(client, repo, claim);
  await client.removeAssignees(repo, claim.issue, [claim.login]);
  await client.updateComment(repo, claim.comment, claimBody(claim.token, Date.now(), 'released'));
}
/** A failed heartbeat prevents later saves; close waits for an in-flight request. */
export function maintainGitHubChartClaim(client: GitHubClient, repo: Repo, claim: GitHubChartClaim): { check(): Promise<void>; close(): Promise<void> } {
  let pending: Promise<void> = Promise.resolve(), failed: unknown, busy = false;
  const timer = setInterval(() => {
    if (busy || failed) return;
    busy = true;
    pending = heartbeatGitHubChartClaim(client, repo, claim).catch((error: unknown) => { failed = error; }).finally(() => { busy = false; });
  }, Math.min(60_000, Math.floor(claim.ttlMs / 3)));
  timer.unref();
  return {
    async check() { await pending; if (failed) throw failed; await assertGitHubChartClaim(client, repo, claim); },
    async close() { clearInterval(timer); await pending; },
  };
}

function issueId(issue: Issue): number {
  if (!Number.isSafeInteger(issue.id) || issue.id! <= 0) throw new ConfigError('GitHub did not return the global id for ' + issue.title);
  return issue.id!;
}
function ticketId(issue: Issue): string {
  return issue.body.match(TICKET_MARKER)?.[1] ?? 'issue-' + issue.number;
}
function nativeField(body: string, field: string, value: string): string {
  const pattern = new RegExp('^' + field + ':.*$', 'm');
  return pattern.test(body) ? body.replace(pattern, field + ': ' + value) : field + ': ' + value + '\n' + body;
}
function localTicket(issue: Issue, blockers: string[]): string {
  if (!issue.assignees) throw new ConfigError('GitHub did not return assignees for ' + issue.title + '; refusing to guess whether it is claimed');
  const types = ['research', 'prototype', 'grilling', 'task'].filter((type) => issue.labels.includes('exolvra:' + type));
  if (!issue.labels.includes('exolvra:decide') || types.length !== 1) throw new ConfigError(issue.title + ':1: a child ticket needs exolvra:decide and one decision type label');
  let body = issue.body.replace(TICKET_MARKER, '').trim();
  body = /^# .+$/m.test(body) ? body.replace(/^# .+$/m, '# ' + issue.title) : '# ' + issue.title + '\n\n' + body;
  body = nativeField(body, 'Type', types[0]!);
  body = nativeField(body, 'Status', issue.state);
  body = nativeField(body, 'Claim', issue.assignees.join(', ') || 'none');
  body = nativeField(body, 'Blocked by', blockers.join(', ') || 'none');
  return body + '\n';
}
function remoteTicket(id: string, text: string): string {
  // GitHub owns these fields; the portable working copy derives them each read.
  return '<!-- genesis-chart-ticket: ' + id + ' -->\n' + text.replace(/^(?:Status|Claim|Blocked by):.*\n?/gm, '').trim() + '\n';
}

export async function readGitHubMap(client: GitHubClient, repo: Repo, number?: number): Promise<GitHubMap | undefined> {
  const maps = number === undefined ? await client.listIssues(repo, { labels: ['exolvra:map'] }) : [await client.getIssue(repo, number)];
  if (!maps.length) return undefined;
  if (maps.length > 1) throw new ConfigError('this repository has multiple maps; select one with --map <number>');
  const issue = maps[0]!;
  if (!issue.labels.includes('exolvra:map') || issue.isPullRequest) throw new ConfigError('the selected issue is not an exolvra:map');
  const children = await client.listSubIssues(repo, issue.number), tickets = new Map<string, Issue>();
  for (const child of children) {
    const id = ticketId(child);
    if (tickets.has(id)) throw new ConfigError(child.title + ':1: duplicate decision ticket id');
    tickets.set(id, child);
  }
  const files: Record<string, string> = { 'MAP.md': issue.body };
  for (const [id, child] of tickets) {
    const blockers = await client.listBlockedBy(repo, child.number);
    const ids = blockers.map((blocker) => {
      const found = [...tickets].find(([, candidate]) => candidate.id === blocker.id && candidate.number === blocker.number);
      if (!found) throw new ConfigError(child.title + ':1: blocking issue ' + blocker.title + ' is outside this map; add it as a child decision ticket first');
      return found[0];
    });
    files['tickets/' + id + '.md'] = localTicket(child, ids);
  }
  return { map: parseMap(files), issue, tickets };
}

function mapLinks(body: string, tickets: Map<string, Issue>): string {
  return body.replace(/\]\(tickets\/([A-Za-z0-9][\w-]{0,63})\.md\)/g, (link, id: string) => {
    const issue = tickets.get(id);
    return issue ? '](' + issue.url + ')' : link;
  });
}

/** Persist only prevalidated planning changes. HTTP partial failure is reported, never retried. */
export async function writeGitHubMap(client: GitHubClient, repo: Repo, input: unknown, expected?: GitHubMap): Promise<GitHubMap> {
  const changes = chartFiles(input), candidate = parseMap({ ...expected?.map.files, ...changes });
  const current = await readGitHubMap(client, repo, expected?.issue.number);
  if (!sameMap(current?.map, expected?.map)) throw new ConfigError('the GitHub map changed during this session; reload before saving');
  const created: string[] = [];
  let issue = current?.issue;
  const tickets = new Map(current?.tickets);
  try {
    if (!issue) {
      issue = await client.createIssue(repo, { title: candidate.destination.split('\n')[0]!, body: candidate.files['MAP.md']!, labels: ['exolvra:map'] });
      created.push(issue.url);
    }
    for (const ticket of candidate.tickets) {
      const path = 'tickets/' + ticket.id + '.md';
      if (tickets.has(ticket.id)) continue;
      const child = await client.createIssue(repo, { title: ticket.name, body: remoteTicket(ticket.id, candidate.files[path]!), labels: ['exolvra:decide', 'exolvra:' + ticket.type] });
      created.push(child.url);
      await client.addSubIssue(repo, issue.number, issueId(child));
      tickets.set(ticket.id, child);
    }
    for (const ticket of candidate.tickets) {
      const child = tickets.get(ticket.id)!, old = current?.map.tickets.find((t) => t.id === ticket.id);
      const path = 'tickets/' + ticket.id + '.md';
      if (!old || changes[path] !== undefined) {
        await client.updateIssue(repo, child.number, { title: ticket.name, body: remoteTicket(ticket.id, candidate.files[path]!), state: ticket.status });
        for (const id of ticket.blockedBy.filter((id) => !old?.blockedBy.includes(id))) await client.addBlockedBy(repo, child.number, issueId(tickets.get(id)!));
        for (const id of old?.blockedBy.filter((id) => !ticket.blockedBy.includes(id)) ?? []) await client.removeBlockedBy(repo, child.number, issueId(tickets.get(id)!));
      }
    }
    await client.updateIssue(repo, issue.number, { body: mapLinks(candidate.files['MAP.md']!, tickets) });
    return (await readGitHubMap(client, repo, issue.number))!;
  } catch (error) {
    throw new ConfigError((error instanceof Error ? error.message : String(error)) + '\nGitHub may have saved part of this update. Reload the map before continuing.' + (created.length ? '\nCreated: ' + created.join(', ') : ''));
  }
}

export async function claimGitHubTicket(client: GitHubClient, repo: Repo, expected: GitHubMap, ticket: DecisionTicket, login: string, ttlMs = DEFAULT_CLAIM_TTL_MS, now = Date.now()): Promise<GitHubMap> {
  const latest = await readGitHubMap(client, repo, expected.issue.number);
  if (!sameMap(latest?.map, expected.map)) throw new ConfigError('the GitHub map changed before the claim; reload');
  const issue = expected.tickets.get(ticket.id)!;
  const prior = await ownReceipt(client, repo, issue.number, login);
  const takeover = issue.assignees?.length === 1 && issue.assignees[0]!.toLowerCase() === login.toLowerCase() && expired(prior, now, ttlMs);
  if (issue.assignees?.length !== 0 && !takeover) throw new ConfigError('ticket is already claimed: ' + ticket.name);
  if (!takeover) await client.addAssignees(repo, issue.number, [login]);
  let lease: GitHubChartClaim | undefined;
  try {
    const held = await client.getIssue(repo, issue.number);
    if (held.assignees?.length !== 1 || held.assignees[0] !== login) throw new ConfigError('GitHub did not grant an exclusive claim on ' + ticket.name);
    const token = randomUUID(), body = claimBody(token, now, 'active', takeover);
    const comment = prior ? await client.updateComment(repo, prior.id, body) : await client.createComment(repo, issue.number, body);
    if (comment.author.toLowerCase() !== login.toLowerCase()) throw new ConfigError('GitHub claim comment does not belong to the configured runner account');
    lease = { issue: issue.number, comment: comment.id, login, token, ttlMs };
    await assertGitHubChartClaim(client, repo, lease);
    return { ...(await readGitHubMap(client, repo, expected.issue.number))!, lease };
  } catch (error) {
    // Assignment succeeded, but no session can begin until the read-back does.
    // Remove only our own login; another claimant's assignment remains intact.
    try { if (lease) await releaseGitHubChartClaim(client, repo, lease); else if (!takeover) await client.removeAssignees(repo, issue.number, [login]); }
    catch { throw new ConfigError((error instanceof Error ? error.message : String(error)) + '\nThe claim could not be released; inspect ' + ticket.name + ' before retrying.'); }
    throw error;
  }
}
