export const PANEL_TOKEN_ENV = 'EXOLVRA_GENESIS_PANEL_TOKEN';
export const PANEL_HOSTS = ['127.0.0.1', '0.0.0.0', '::1', '::'] as const;

/** Windows environment names are case-insensitive; never inherit a panel key. */
export function panelChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== PANEL_TOKEN_ENV));
}

export function panelToken(raw: string): string {
  if (raw.length < 24 || raw.length > 4096 || !/^[\x21-\x7e]+$/.test(raw)) throw new Error(PANEL_TOKEN_ENV + ' must contain 24–4096 printable characters without spaces.');
  return raw;
}

/** A configured origin is an authority, not a redirect or arbitrary URL path. */
export function panelPublicUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('Expected an absolute public URL, for example https://genesis.example.com.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Public URL must be an HTTP(S) origin without credentials, a path, query or fragment.');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (!loopback && parsed.protocol !== 'https:') throw new Error('A shared public URL requires HTTPS; terminate TLS at a reverse proxy.');
  return parsed.origin;
}

export function panelAccess(options: { host?: string; publicUrl?: string; token?: string }): { host: string; publicUrl?: string; token?: string; secure: boolean } {
  const host = options.host ?? '127.0.0.1';
  if (!(PANEL_HOSTS as readonly string[]).includes(host)) throw new Error('Unsupported panel listen address.');
  const publicUrl = options.publicUrl === undefined ? undefined : panelPublicUrl(options.publicUrl);
  const token = options.token === undefined ? undefined : panelToken(options.token);
  const networkListener = host === '0.0.0.0' || host === '::';
  const sharedOrigin = publicUrl !== undefined && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(publicUrl).hostname);
  if ((networkListener || sharedOrigin) && !token) throw new Error('Shared access requires ' + PANEL_TOKEN_ENV + '.');
  if (networkListener && !publicUrl) throw new Error('A network listener requires --public-url for the browser origin.');
  return { host, publicUrl, token, secure: publicUrl?.startsWith('https:') ?? false };
}
