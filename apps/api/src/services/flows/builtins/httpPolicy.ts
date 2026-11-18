/**
 * Tool Catalog W05 (#5220), plan Decision 12 — the `http_request` egress
 * policy shared by save/enable validation (validateBuiltins.ts) and the run-
 * time executor (httpRequest.ts). Pure, leaf (config env only).
 *
 *  - The method and the URL ORIGIN (scheme + host + port) are literal. The
 *    origin is what is pinned: at run time the rendered URL's origin must equal
 *    the publication's literal origin, so a templated path can never move the
 *    request to another host.
 *  - HTTPS only; `http:` only when TOOL_SOURCES_ALLOW_PRIVATE_EGRESS is set
 *    (self-hosted; refused at boot under IS_HOSTED), and then only to a private
 *    address (safeFetch `requirePrivateForCleartext`).
 *  - Breeze's own origins are refused (a flow must not call its own webhook or
 *    MCP endpoint and loop outside chain-depth accounting). Compared by
 *    HOSTNAME, so another scheme or port on the same host is refused too.
 *  - Header names are literal and outside an unconditional, case-insensitive
 *    deny-list (transport, auth, cookies, proxy, forwarding, Breeze's own).
 *  - No credentials in documents (anonymous only in W5): a literal header or
 *    query value that looks like a credential is refused.
 */
import { toolSourcesAllowPrivateEgress } from '../../../config/env';

/** Header names never sent from a flow, whatever their value (compared lowercased). */
const DENIED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'expect',
  'cookie', 'cookie2', 'authorization', 'forwarded',
]);
const DENIED_HEADER_PREFIXES: readonly string[] = ['proxy-', 'x-forwarded-', 'x-breeze-'];

/** RFC 9110 field-name token. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;

export function isDeniedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_HEADER_NAMES.has(lower) || DENIED_HEADER_PREFIXES.some((p) => lower.startsWith(p));
}

/** A header name a flow may send: a literal RFC token outside the deny-list. */
export function isAllowedHeaderName(name: string): boolean {
  return !name.includes('{{') && HEADER_NAME_RE.test(name) && !isDeniedHeaderName(name);
}

export type LiteralOrigin =
  | { ok: true; origin: string; hostname: string; protocol: 'https:' | 'http:' }
  | { ok: false; reason: 'templated' | 'invalid' | 'scheme' | 'userinfo' };

const AUTHORITY_PREFIX_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)[/?#]/;

/**
 * The literal origin of a (possibly templated) URL. A template may start only
 * after the authority is closed by `/`, `?` or `#`; anything earlier (in the
 * scheme, userinfo, host or port) is `templated`.
 */
export function literalOriginOf(url: string): LiteralOrigin {
  const at = url.indexOf('{{');
  let literal = url;
  if (at !== -1) {
    const m = AUTHORITY_PREFIX_RE.exec(url.slice(0, at));
    if (!m) return { ok: false, reason: 'templated' };
    literal = `${m[1]}://${m[2]}/`;
  }
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(literal)?.[1];
  if (authority === undefined || authority.length === 0) return { ok: false, reason: 'invalid' };
  if (/[\\%\s]/.test(authority)) return { ok: false, reason: 'invalid' };
  let parsed: URL;
  try {
    parsed = new URL(literal);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (parsed.username || parsed.password || authority.includes('@')) return { ok: false, reason: 'userinfo' };
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'scheme' };
  if (!parsed.hostname) return { ok: false, reason: 'invalid' };
  return { ok: true, origin: parsed.origin, hostname: parsed.hostname.toLowerCase(), protocol: parsed.protocol };
}

/** `http:` is allowed only on a self-hosted deployment that opted into private egress. */
export function isAllowedHttpProtocol(protocol: 'https:' | 'http:'): boolean {
  return protocol === 'https:' || toolSourcesAllowPrivateEgress();
}

/**
 * Env vars whose origin serves Breeze itself: the API, the app that proxies
 * it, the portal, the MCP resource and consent pages, and the origins the app
 * already trusts (the same set config/tunnelOrigin.ts treats as Breeze's own).
 * The comma-list vars may hold several origins; `*` names none.
 */
const OWN_ORIGIN_ENV_VARS = [
  'PUBLIC_API_URL', 'API_URL', 'PUBLIC_APP_URL', 'DASHBOARD_URL', 'PUBLIC_URL', 'PUBLIC_PORTAL_URL', 'PUBLIC_WEB_URL',
  'OAUTH_RESOURCE_URL', 'OAUTH_CONSENT_URL_BASE', 'TUNNEL_FRAME_ANCESTOR',
] as const;
const OWN_ORIGIN_LIST_ENV_VARS = ['WEBAUTHN_ORIGIN', 'CORS_ALLOWED_ORIGINS'] as const;

/** A configured origin's hostname, also for a value written without a scheme (`host`, `host:port`). */
function hostnameOfConfiguredOrigin(raw: string): string | null {
  for (const candidate of /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) ? [raw] : [`https://${raw}`]) {
    try {
      const host = canonicalHostname(new URL(candidate).hostname);
      if (host && !/\s/.test(host)) return host;
    } catch {
      // not an origin
    }
  }
  return null;
}

/**
 * One spelling per host: lowercased, without the trailing dot(s) of an
 * absolute FQDN (`breeze.example.test.` is the same host as
 * `breeze.example.test` to DNS and to the server, so it must be to the guard).
 */
function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

/** Hostnames of Breeze's own configured origins, canonicalized. Read at call time. */
export function breezeOwnHostnames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>();
  const values: string[] = [];
  for (const key of OWN_ORIGIN_ENV_VARS) values.push(env[key] ?? '');
  for (const key of OWN_ORIGIN_LIST_ENV_VARS) values.push(...(env[key] ?? '').split(','));
  for (const value of values) {
    const raw = value.trim();
    if (!raw || raw === '*') continue;
    const host = hostnameOfConfiguredOrigin(raw);
    if (host) out.add(host);
  }
  return out;
}

/**
 * Whether `hostname` is one of Breeze's own. By name: another name that
 * resolves to Breeze's address (a CNAME, a raw IP) is not caught here — the
 * per-flow rate limit and monthly caps bound such a loop (plan Decision 17).
 */
export function isBreezeOwnHostname(hostname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return breezeOwnHostnames(env).has(canonicalHostname(hostname));
}

// ── credentials in documents ────────────────────────────────────────────────

/** Header or query names that carry a credential. */
const CREDENTIAL_NAME_RE =
  /(?:^|[-_.])(?:api[-_]?key|apikey|access[-_]?key|private[-_]?key|secret|client[-_]?secret|token|access[-_]?token|password|passwd|pwd|credentials?|auth|session[-_]?id)(?:$|[-_.])/i;
/** Values that are a credential by their prefix. */
const CREDENTIAL_VALUE_RE =
  /^(?:(?:bearer|basic|digest|token|negotiate)\s+\S|bwh_|brz_|sk-|sk_(?:live|test)_|rk_(?:live|test)_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abporsu]-|AKIA[0-9A-Z]{8}|ASIA[0-9A-Z]{8}|AIza[0-9A-Za-z_-]{8}|eyJ[A-Za-z0-9_-]{8,}\.)/i;

function shannonBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** ≥ 32 chars of token alphabet, mixed character classes and high entropy: a key, not a word. */
function looksHighEntropyToken(value: string): boolean {
  if (value.length < 32 || !/^[A-Za-z0-9+/=_\-.~]+$/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(value)).length;
  return classes >= 2 && shannonBitsPerChar(value) >= 3.5;
}

/**
 * Whether a LITERAL header/query value (with its name, when it has one) looks
 * like a credential. Templated values are not in the document and are not
 * judged here.
 */
export function looksLikeCredential(name: string | null, value: string): boolean {
  if (value.includes('{{')) return false;
  if (name !== null && CREDENTIAL_NAME_RE.test(name) && value.trim().length > 0) return true;
  const v = value.trim();
  return CREDENTIAL_VALUE_RE.test(v) || looksHighEntropyToken(v);
}

/** The literal query pairs written into the URL string itself (before any template). */
export function literalUrlQueryPairs(url: string): Array<[string, string]> {
  const literal = url.split('{{')[0] ?? '';
  const q = literal.indexOf('?');
  if (q === -1) return [];
  const query = literal.slice(q + 1).split('#')[0] ?? '';
  return [...new URLSearchParams(query).entries()];
}
