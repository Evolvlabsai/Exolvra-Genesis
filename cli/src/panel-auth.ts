import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigError } from './exit.js';

const COOKIE = 'genesis_panel_session';
const SESSION_SECONDS = 8 * 60 * 60;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;
const randomToken = (): string => randomBytes(32).toString('base64url');
interface Session { id: string; csrfToken: string; expiresAt: number }
interface Failures { count: number; resetAt: number }

export class PanelAuthError extends Error {
  readonly status: 401 | 429;
  readonly retryAfterSeconds?: number;
  constructor(status: 401 | 429, message: string, retryAfterSeconds?: number) {
    super(message); this.name = 'PanelAuthError'; this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Shared-key login exchanges a transient key for an opaque, bounded session. */
export class PanelAuth {
  readonly requiresLogin: boolean;
  readonly anonymousCsrf = randomToken();
  readonly #digest: Buffer | undefined;
  readonly #secure: boolean;
  readonly #sessionTtlMs: number;
  readonly #local = { id: randomToken(), csrfToken: this.anonymousCsrf };
  readonly #sessions = new Map<string, Session>();
  readonly #failures = new Map<string, Failures>();

  constructor(options: { token?: string; secure?: boolean; sessionTtlMs?: number } = {}) {
    if (options.token !== undefined && (typeof options.token !== 'string' || options.token.length < 24 || options.token.length > 4096 || /[\u0000-\u001f\u007f]/.test(options.token) || !options.token.trim())) throw new ConfigError('EXOLVRA_GENESIS_PANEL_TOKEN must contain 24–4096 characters without control characters');
    this.requiresLogin = options.token !== undefined;
    this.#digest = options.token === undefined ? undefined : createHash('sha256').update(options.token, 'utf8').digest();
    this.#secure = options.secure === true;
    this.#sessionTtlMs = options.sessionTtlMs ?? SESSION_SECONDS * 1000;
    if (!Number.isSafeInteger(this.#sessionTtlMs) || this.#sessionTtlMs <= 0 || this.#sessionTtlMs > SESSION_SECONDS * 1000) throw new ConfigError('Panel session lifetime must be a positive integer no greater than eight hours.');
  }
  private cookie(id: string, maxAge = Math.ceil(this.#sessionTtlMs / 1000)): string {
    return COOKIE + '=' + id + '; Path=/; Max-Age=' + maxAge + '; HttpOnly; SameSite=Strict' + (this.#secure ? '; Secure' : '');
  }
  private identifier(header?: string): string | undefined {
    if (typeof header !== 'string' || header.length > 8192) return undefined;
    let found: string | undefined;
    for (const field of header.split(';')) {
      const separator = field.indexOf('=');
      if (separator < 0 || field.slice(0, separator).trim() !== COOKIE) continue;
      if (found !== undefined) return undefined; // Refuse ambiguous cookie scope.
      const value = field.slice(separator + 1).trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
      found = value;
    }
    return found;
  }
  private prune(now: number): void {
    for (const [id, session] of this.#sessions) if (session.expiresAt <= now) this.#sessions.delete(id);
    for (const [address, failed] of this.#failures) if (failed.resetAt <= now) this.#failures.delete(address);
  }
  session(cookieHeader?: string): { id: string; csrfToken: string } | undefined {
    if (!this.requiresLogin) return { ...this.#local };
    this.prune(Date.now());
    const id = this.identifier(cookieHeader), session = id === undefined ? undefined : this.#sessions.get(id);
    return session === undefined ? undefined : { id: session.id, csrfToken: session.csrfToken };
  }
  login(candidate: string, remoteAddress: string): { csrfToken: string; cookie: string } {
    if (!this.requiresLogin) return { csrfToken: this.#local.csrfToken, cookie: this.cookie(this.#local.id) };
    const now = Date.now(); this.prune(now);
    const address = typeof remoteAddress === 'string' ? remoteAddress.trim().slice(0, 128) || 'unknown' : 'unknown';
    const failed = this.#failures.get(address);
    const valid = typeof candidate === 'string' && candidate.length <= 4096;
    const proposed = createHash('sha256').update(valid ? candidate : '', 'utf8').digest();
    if (!timingSafeEqual(this.#digest!, proposed) || !valid) {
      // A reverse proxy may give every teammate the same peer address. Only
      // reject failed candidates; a valid key must still recover that address.
      if (failed && failed.count >= 5) throw new PanelAuthError(429, 'Too many failed sign-in attempts; try again after the cooldown.', Math.max(1, Math.ceil((failed.resetAt - now) / 1000)));
      if (!failed && this.#failures.size >= MAX_ENTRIES) this.#failures.delete(this.#failures.keys().next().value!);
      this.#failures.set(address, { count: (failed?.count ?? 0) + 1, resetAt: failed?.resetAt ?? now + FAILURE_WINDOW_MS });
      throw new PanelAuthError(401, 'The access key was not accepted.');
    }
    this.#failures.delete(address);
    if (this.#sessions.size >= MAX_ENTRIES) this.#sessions.delete(this.#sessions.keys().next().value!);
    const id = randomToken(), csrfToken = randomToken();
    this.#sessions.set(id, { id, csrfToken, expiresAt: now + this.#sessionTtlMs });
    return { csrfToken, cookie: this.cookie(id) };
  }
  logout(cookieHeader?: string): string {
    const id = this.identifier(cookieHeader);
    if (id !== undefined) this.#sessions.delete(id);
    return this.cookie('', 0);
  }
}
