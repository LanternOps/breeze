/**
 * Pure parsing/matching for `OAUTH_CIMD_ALLOWED_HOSTS` (B-W03 #6157). Kept
 * dependency-free so config/validate.ts can check the value at boot.
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

