import { checkSsrfSafe } from '../ssrfGuard';
import { safeFetch } from '../urlSafety';
import { EdrProviderRequestError, type GuardedFetch } from './types';

/**
 * Host matching for vendor allowlists. An entry starting with `.` is a suffix
 * (and the bare suffix itself is NOT a match); anything else is an exact host.
 * `ssrfGuard`'s own `hostnameAllowlist` is a bare `endsWith`, which would admit
 * `xid.sophos.com` for `id.sophos.com` — hence this matcher (index correction 8).
 */
export function hostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('.') ? h.endsWith(e) && h.length > e.length : h === e;
  });
}

export function validateVendorUrl(
  raw: string,
  allowlist: readonly string[],
  opts: { pathPrefix?: string } = {},
): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'must use https://' };
  if (url.username || url.password) return { ok: false, reason: 'must not embed credentials' };
  if (!hostAllowed(url.hostname, allowlist)) {
    return { ok: false, reason: `host must match ${allowlist.join(', ')}` };
  }
  if (opts.pathPrefix && !url.pathname.startsWith(opts.pathPrefix)) {
    return { ok: false, reason: `path must start with ${opts.pathPrefix}` };
  }
  // Literal-IP / loopback / metadata names. DNS-level private resolution is
  // refused again at connect time by safeFetch's pinned lookup.
  const ssrf = checkSsrfSafe(url.toString(), { mode: 'strict-https' });
  if (!ssrf.ok) return { ok: false, reason: ssrf.reason ?? 'refused' };
  return { ok: true, url };
}

export function createGuardedFetch(
  allowlist: readonly string[],
  opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof safeFetch } = {},
): GuardedFetch {
  // DNS-pinned, private ranges refused, redirects not followed, #1105 tripwire.
  const impl = opts.fetchImpl ?? safeFetch;
  return async (url, init) => {
    const v = validateVendorUrl(url, allowlist);
    if (!v.ok) {
      throw new EdrProviderRequestError(`EDR vendor URL not allowed: ${v.reason}`, {
        code: 'host_not_allowed',
        reauth: false,
        scope: 'connection',
      });
    }
    const res = await impl(v.url.toString(), {
      method: init.method,
      headers: init.headers,
      body: init.body,
      timeoutMs: init.timeoutMs ?? opts.timeoutMs ?? 30_000,
      maxBytes: opts.maxBytes ?? 20 * 1024 * 1024,
    });
    return { status: res.status, headers: res.headers, text: () => res.text() };
  };
}
