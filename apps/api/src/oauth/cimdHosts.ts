/**
 * Pure CIMD helpers (B-W03 #6157): the client-id shape and the
 * `OAUTH_CIMD_ALLOWED_HOSTS` parser/matcher. Dependency-free so
 * config/validate.ts and the OIDC adapter can import them cheaply.
 */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  return value.split('.').every((label) => HOST_LABEL.test(label));
}

/**
 * Parse `OAUTH_CIMD_ALLOWED_HOSTS`: comma-separated hostnames, or `.suffix`
 * entries meaning "any subdomain of". Unset/empty = any public https host.
 */
export function parseCimdAllowedHosts(raw: string | undefined):
  | { ok: true; hosts: string[] }
  | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, hosts: [] };
  const hosts: string[] = [];
  for (const item of raw.split(',')) {
    const entry = item.trim().toLowerCase();
    if (entry === '') return { ok: false, reason: 'empty entry' };
    const name = entry.startsWith('.') ? entry.slice(1) : entry;
    if (!isHostname(name)) return { ok: false, reason: `"${entry}" is not a hostname or .suffix` };
    hosts.push(entry);
  }
  return { ok: true, hosts };
}

/** Same `.suffix` semantics as edrProviders/guardedFetch.ts `hostAllowed`; empty list = any host. */
export function cimdHostAllowed(host: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('.') ? h.endsWith(e) && h.length > e.length : h === e;
  });
}

function hasForbiddenCodePoint(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code <= 0x20 || code === 0x5c || code === 0x7f) return true;
  }
  return false;
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * A CIMD client id: https, a hostname (never an IP literal), a real path
 * (not `/`), no userinfo, query, fragment or dot segments. oidc-provider
 * 9.12.2 dropped its own path check. A DCR-issued id is never an https URL,
 * so this shape alone tells the two kinds apart.
 */
export function isCimdClientId(id: unknown): id is string {
  if (typeof id !== 'string' || !/^https:\/\//i.test(id)) return false;
  if (hasForbiddenCodePoint(id) || id.includes('#') || id.includes('?')) return false;
  const afterScheme = id.slice('https://'.length);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority === '' || authority.includes('@')) return false;
  const rawPath = authorityEnd === -1 ? '' : afterScheme.slice(authorityEnd);
  if (rawPath.split('/').some((seg) => {
    const normalized = seg.replace(/%2e/gi, '.');
    return normalized === '.' || normalized === '..';
  })) return false;
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (url.hostname.startsWith('[') || IPV4_LITERAL.test(url.hostname)) return false;
  if (url.pathname === '' || url.pathname === '/') return false;
  return true;
}
