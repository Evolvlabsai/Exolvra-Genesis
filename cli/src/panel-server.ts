import { timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectLocalEnvironment } from './commands/doctor.js';
import { PanelAuth, PanelAuthError } from './panel-auth.js';
import { panelAccess, panelChildEnvironment, PANEL_TOKEN_ENV } from './panel-config.js';
import { AGENT_MODELS, listModels } from './models.js';
import { readPanelAgents, readPanelEvents, readPanelProject, readPanelRunDetail, readPanelRuns, safePanelArtifactPath, scrubPanelText } from './panel-data.js';
import { PanelJobManager } from './panel-jobs.js';
import { PanelProjects, type RegisteredProject } from './panel-projects.js';
import { readRuns } from './runs-store.js';
import type { PanelJobRequest, PanelOverview, PanelProject } from './panel-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
const STATIC_FILES: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'Send application/json.');
  if (Number(req.headers['content-length']) > 65536) throw new HttpError(413, 'Request body exceeds 64 KB.');
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 65536) throw new HttpError(413, 'Request body exceeds 64 KB.');
    buffers.push(buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON request.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request must be a JSON object.');
  return value as Record<string, unknown>;
}

function pageNumber(url: URL, name: string, maximum: number): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0 || number > maximum) throw new HttpError(400, 'Invalid ' + name + '.');
  return number;
}

export interface PanelServerOptions { root: string; port?: number; cliPath?: string; env?: NodeJS.ProcessEnv; host?: string; publicUrl?: string; token?: string }
export interface PanelServer { url: string; localUrl: string; close(): Promise<void> }

/** An authenticated browser transport for the existing CLI. Page loads never run models. */
export async function startPanelServer(options: PanelServerOptions): Promise<PanelServer> {
  const env = options.env ?? process.env;
  const access = panelAccess({ host: options.host, publicUrl: options.publicUrl, token: options.token ?? env[PANEL_TOKEN_ENV] });
  const auth = new PanelAuth({ token: access.token, secure: access.secure });
  const projects = new PanelProjects(options.root);
  const jobEnv = panelChildEnvironment(env);
  const jobs = new PanelJobManager({ root: options.root, cliPath: options.cliPath ?? join(HERE, 'cli.js'), env: jobEnv });
  const startedAt = Date.now();
  let port = 0;
  let closing = false;
  let cached: PanelOverview | undefined;

  function project(id: string | null): RegisteredProject {
    const result = id === null ? undefined : projects.get(id);
    if (!result) throw new HttpError(404, 'Project registration not found.');
    return result;
  }

  function overview(): PanelOverview {
    if (cached && Date.now() - cached.now < 1000) return cached;
    const errors: string[] = [];
    const registered = projects.list();
    const rows: PanelProject[] = registered.map((p) => {
      try { return readPanelProject(p); } catch (error) {
        const message = scrubPanelText(error instanceof Error ? error.message : String(error), env);
        errors.push(scrubPanelText(p.name + ': ' + message, env));
        return { id: p.id, name: scrubPanelText(p.name, env), path: scrubPanelText(p.path, env), runCount: 0, activeCount: 0, goals: [], error: message };
      }
    });
    const runs = registered.flatMap((p) => {
      try { return readPanelRuns(p); } catch (error) { errors.push(scrubPanelText(p.name + ': ' + String(error), env)); return []; }
    }).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    let agents: PanelOverview['agents'] = [];
    let events: PanelOverview['events'] = [];
    try { agents = readPanelAgents(env); } catch (error) { errors.push(scrubPanelText(String(error))); }
    try { events = readPanelEvents(registered, 100); } catch (error) { errors.push(scrubPanelText(String(error))); }
    cached = {
      version: VERSION, startedAt, now: Date.now(), projects: rows, runs, agents, events, jobs: jobs.list(),
      models: listModels().map(({ value, label }) => ({ value, label })), agentModels: [...AGENT_MODELS],
      totals: {
        running: runs.filter((r) => r.status === 'running').length,
        blocked: runs.filter((r) => r.status === 'blocked').length,
        complete: runs.filter((r) => r.status === 'complete').length,
        stopped: runs.filter((r) => r.status === 'stopped').length,
        costUsd: runs.some((r) => r.costUsd !== null) ? runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) : null,
        inputTokens: runs.reduce((sum, r) => sum + (r.tokens?.input ?? 0), 0),
        outputTokens: runs.reduce((sum, r) => sum + (r.tokens?.output ?? 0), 0),
      }, errors,
    };
    return cached;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (closing) throw new HttpError(503, 'The control panel is shutting down.');
    const host = req.headers.host?.toLowerCase();
    const allowedHosts = ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port];
    if (access.publicUrl) allowedHosts.push(new URL(access.publicUrl).host);
    if (!host || !allowedHosts.includes(host)) throw new HttpError(403, 'Host is not permitted.');
    const allowedOrigins = access.publicUrl ? [access.publicUrl] : allowedHosts.map((h) => 'http://' + h);
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) throw new HttpError(403, 'Origin is not permitted.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not permitted.');
    const method = req.method ?? 'GET';
    if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(method)) throw new HttpError(405, 'Method is not supported.');
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1:' + port); } catch { throw new HttpError(400, 'Invalid URL.'); }
    const pathname = url.pathname;
    const session = auth.session(req.headers.cookie);
    const publicApi = ['/api/session', '/api/login', '/api/health'].includes(pathname);
    if (pathname.startsWith('/api/') && !publicApi && !session) throw new HttpError(401, 'Sign in to access this workspace.');
    if (method === 'POST' || method === 'DELETE') {
      const supplied = req.headers['x-genesis-csrf'];
      const csrfToken = session?.csrfToken ?? auth.anonymousCsrf;
      if (typeof supplied !== 'string' || supplied.length !== csrfToken.length || !/^[A-Za-z0-9_-]+$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))) throw new HttpError(403, 'Session token missing or expired. Refresh the panel.');
    }
    if (method === 'GET' && pathname === '/api/health') { json(res, 200, { status: 'ok', version: VERSION }); return; }
    if (method === 'GET' && pathname === '/api/session') { json(res, 200, { csrfToken: session?.csrfToken ?? auth.anonymousCsrf, authenticated: Boolean(session), requiresLogin: auth.requiresLogin }); return; }
    if (method === 'POST' && pathname === '/api/login') {
      const request = await body(req);
      if (typeof request.token !== 'string' || request.token.length > 4096) throw new HttpError(400, 'Enter your workspace access key.');
      const authenticated = auth.login(request.token, req.socket.remoteAddress ?? 'unknown');
      res.setHeader('Set-Cookie', authenticated.cookie);
      json(res, 200, { csrfToken: authenticated.csrfToken, authenticated: true, requiresLogin: auth.requiresLogin }); return;
    }
    if (method === 'POST' && pathname === '/api/logout') {
      res.setHeader('Set-Cookie', auth.logout(req.headers.cookie));
      json(res, 200, { ok: true }); return;
    }
    if (method === 'GET' && pathname === '/api/overview') { json(res, 200, overview()); return; }
    if (method === 'GET' && pathname === '/api/diagnostics') {
      const selected = project(url.searchParams.get('projectId'));
      json(res, 200, { checks: inspectLocalEnvironment(selected.path, env).map((c) => ({ ...c, detail: scrubPanelText(c.detail) })) }); return;
    }
    const runMatch = /^\/api\/runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})$/.exec(pathname);
    if (method === 'GET' && runMatch) {
      const selected = project(url.searchParams.get('projectId'));
      readPanelProject(selected);
      if (!readRuns(selected.path).some((r) => r.id === runMatch[1])) throw new HttpError(404, 'Run not found.');
      const after = pageNumber(url, 'after', Number.MAX_SAFE_INTEGER);
      const before = pageNumber(url, 'before', Number.MAX_SAFE_INTEGER);
      if (after !== undefined && before !== undefined) throw new HttpError(400, 'Use either after or before.');
      const limit = pageNumber(url, 'limit', 500) ?? 200;
      if (limit < 1) throw new HttpError(400, 'Limit must be at least 1.');
      json(res, 200, readPanelRunDetail(selected, runMatch[1]!, after, limit, before)); return;
    }
    const jobMatch = /^\/api\/jobs\/([a-zA-Z0-9_-]+)$/.exec(pathname);
    if (method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]!);
      if (!job) throw new HttpError(404, 'Command not found.');
      json(res, 200, { job }); return;
    }
    if (method === 'POST' && pathname === '/api/jobs') {
      const request = await body(req);
      if (typeof request.projectId !== 'string') throw new HttpError(400, 'Select a project.');
      const selected = project(request.projectId);
      const publicProject = readPanelProject(selected);
      const job = jobs.start({ ...publicProject, path: selected.path }, request as unknown as PanelJobRequest);
      cached = undefined;
      json(res, 202, { job }); return;
    }
    if (method === 'POST' && pathname === '/api/projects') {
      const request = await body(req);
      if (typeof request.path !== 'string') throw new HttpError(400, 'Provide a project directory.');
      if (request.name !== undefined && typeof request.name !== 'string') throw new HttpError(400, 'Project name must be text.');
      const directory = realpathSync(resolve(options.root, request.path));
      readPanelProject({ id: 'validation', name: 'Project', path: directory });
      const added = projects.add(directory, request.name as string | undefined);
      cached = undefined;
      json(res, 201, { project: readPanelProject(added) }); return;
    }
    const projectMatch = /^\/api\/projects\/([a-f0-9]{16})$/.exec(pathname);
    if (method === 'DELETE' && projectMatch) {
      const selected = project(projectMatch[1]!);
      if (jobs.list().some((j) => j.projectId === selected.id && ['running', 'starting'].includes(j.status))) throw new HttpError(409, 'Stop active work before removing this project.');
      // Unregistering an unreadable directory never touches its work or files.
      let active = false;
      try { active = readPanelRuns(selected).some((r) => r.canStop || r.status === 'running'); } catch { /* Keep broken registrations removable. */ }
      if (active) throw new HttpError(409, 'Stop active work before removing this project.');
      projects.remove(selected.id); cached = undefined;
      json(res, 200, { ok: true }); return;
    }
    const artifactMatch = /^\/api\/artifacts\/([a-f0-9]{16})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([^/]+)$/.exec(pathname);
    if ((method === 'GET' || method === 'HEAD') && artifactMatch) {
      const selected = project(artifactMatch[1]!);
      const name = artifactMatch[3]!;
      const path = safePanelArtifactPath(selected, artifactMatch[2]!, name);
      if (!path) throw new HttpError(404, 'Artifact not found.');
      // Model-authored HTML is a download, never a document with panel privileges.
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(method === 'HEAD' ? undefined : readFileSync(path)); return;
    }
    const asset = STATIC_FILES[pathname];
    if ((method === 'GET' || method === 'HEAD') && asset) {
      res.setHeader('Content-Type', asset[1]); res.setHeader('Cache-Control', 'no-cache');
      res.end(method === 'HEAD' ? undefined : readFileSync(join(HERE, 'panel', asset[0]))); return;
    }
    throw new HttpError(404, 'Not found.');
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent || res.destroyed) { res.end(); return; }
      const status = error instanceof HttpError || error instanceof PanelAuthError ? error.status : 400;
      if (error instanceof PanelAuthError && error.status === 429) res.setHeader('Retry-After', String(error.retryAfterSeconds ?? 300));
      json(res, status, { error: scrubPanelText(error instanceof Error ? error.message : String(error)) });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 4317, access.host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await jobs.close(); throw error; }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No local server address.');
  port = address.port;
  let closePromise: Promise<void> | undefined;
  return {
    url: access.publicUrl ?? 'http://' + (access.host.includes(':') ? '[::1]' : '127.0.0.1') + ':' + port,
    localUrl: 'http://' + (access.host.includes(':') ? '[::1]' : '127.0.0.1') + ':' + port,
    close() {
      closePromise ??= (async () => {
        closing = true;
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await Promise.all([jobs.close(), stopped]);
      })();
      return closePromise;
    },
  };
}
