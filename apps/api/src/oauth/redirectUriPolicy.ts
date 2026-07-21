/**
 * DCR redirect-URI transport policy (MCP-OAUTH-09).
 *
 * Pure, dependency-free validator applied to Dynamic Client Registration
 * `redirect_uris` at BOTH registration creation (POST /oauth/reg) and
 * registration-management update (PUT /oauth/reg/:id). PKCE authenticates the
 * token exchange but provides neither transport confidentiality nor authentic
 * callback routing, so an attacker-controlled `http://` remote callback can
 * still exfiltrate an authorization code. We therefore constrain redirect URIs
 * to confidential or provably-local transports.
 *
 * Policy (RFC 8252 §7.3 native-app loopback guidance):
 *   - HTTPS is accepted for any host, provided it carries no userinfo
 *     credentials and no fragment.
 *   - HTTP is accepted ONLY for the loopback hosts `127.0.0.1`, `[::1]`, and
 *     `localhost`, with any (or no) port. Ephemeral ports are expected —
 *     native apps bind a random port at runtime.
 *   - Everything else is rejected: private-network addresses, public HTTP
 *     hosts, protocol-relative URLs, malformed URLs, credentials, fragments,
 *     and custom/app schemes.
 *
 * A single invalid URI rejects the ENTIRE registration (fail closed) — we never
 * silently drop the bad entry and register the rest.
 *
 * WHY `localhost` IS ALLOWED (reversed 2026-07-21, see below): RFC 8252 §7.3
 * *recommends* IP literals over the `localhost` hostname because `localhost`
 * can in principle resolve to a non-loopback interface via a doctored
 * hosts/DNS entry. That is a SHOULD, not a MUST, and the attack presupposes an
 * already-compromised client host — at which point the authorization code is
 * readable anyway. Meanwhile every client that hardcodes `http://localhost`
 * simply cannot register. Stock `oidc-provider` (our own dependency) treats all
 * three spellings as loopback (`LOOPBACKS` in lib/consts/client_attributes.js),
 * so rejecting `localhost` made this policy stricter than the library it wraps.
 *
 * The bypass hardening is unaffected: exact host equality still rejects
 * hostname-prefix tricks (`127.0.0.1.evil.com`, `localhost.evil.com`), and
 * userinfo/fragment/scheme checks are unchanged.
 *
 * CLIENT COMPATIBILITY IS A TEST, NOT A CHECKLIST: `redirectUriPolicy.test.ts`
 * carries a `REAL_CLIENT_CALLBACKS` fixture naming the exact callback shape each
 * MCP client emits. Tightening this policy such that a named client no longer
 * registers must be a deliberate edit to that fixture. Prose "verify on staging
 * before deploy" notes have failed twice: #2193 (the `OAUTH_DCR_REQUIRE_IAT`
 * gate blocked Claude Desktop's anonymous DCR) and this rule, which blocked
 * Claude Code's CLI auth for 9 days because "Claude" was assumed to be a single
 * client with an HTTPS hosted callback.
 */

export type RedirectUriValidation = { ok: true } | { ok: false; reason: string };

// Loopback hosts trusted for plain HTTP. Matched by EXACT equality — a
// substring/suffix test would admit `127.0.0.1.evil.com` and `localhost.evil.com`,
// which are ordinary DNS names that merely start with a loopback label.
// Node's WHATWG URL parser reports the IPv6 loopback host as the bracketed form
// `[::1]`; accept the un-bracketed spelling too for defense in depth.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function validateOne(uri: unknown): RedirectUriValidation {
  if (typeof uri !== 'string' || uri.length === 0) {
    return { ok: false, reason: 'redirect_uri must be a non-empty string' };
  }

  // Protocol-relative (`//host/path`) and otherwise-unparseable inputs throw
  // here because there is no base URL — reject as malformed.
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false, reason: `malformed redirect_uri: ${uri}` };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'redirect_uri must not contain userinfo credentials' };
  }
  if (url.hash !== '') {
    return { ok: false, reason: 'redirect_uri must not contain a fragment' };
  }

  if (url.protocol === 'https:') {
    return { ok: true };
  }

  if (url.protocol === 'http:') {
    if (isLoopbackHost(url.hostname)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `http redirect_uri is permitted only for the loopback hosts 127.0.0.1, [::1] or localhost (got host "${url.hostname}")`,
    };
  }

  return {
    ok: false,
    reason: `unsupported redirect_uri scheme "${url.protocol.replace(/:$/, '')}"; only https and loopback http are allowed`,
  };
}

/**
 * Validate a DCR `redirect_uris` value. Returns `{ ok: true }` only when the
 * input is a non-empty array of strings that ALL satisfy the transport policy;
 * otherwise `{ ok: false, reason }` with the first failure's reason.
 */
export function validateRedirectUris(uris: unknown): RedirectUriValidation {
  if (!Array.isArray(uris)) {
    return { ok: false, reason: 'redirect_uris must be an array' };
  }
  if (uris.length === 0) {
    return { ok: false, reason: 'redirect_uris must contain at least one callback URL' };
  }
  for (const uri of uris) {
    const result = validateOne(uri);
    if (!result.ok) return result;
  }
  return { ok: true };
}
