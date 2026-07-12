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
 *   - HTTP is accepted ONLY for the literal loopback IP hosts `127.0.0.1` and
 *     `[::1]`, with any (or no) port. Ephemeral ports are expected — native
 *     apps bind a random port at runtime.
 *   - Everything else is rejected: `localhost` as a *hostname* (RFC 8252 warns
 *     it can resolve to a non-loopback interface and is DNS-spoofable),
 *     private-network addresses, public HTTP hosts, protocol-relative URLs,
 *     malformed URLs, credentials, fragments, and custom/app schemes.
 *
 * A single invalid URI rejects the ENTIRE registration (fail closed) — we never
 * silently drop the bad entry and register the rest.
 *
 * ROLLOUT NOTE (RFC 8252): rejecting `localhost` while allowing loopback IPs is
 * RFC-correct but has broken real MCP clients before (issue #2193). Claude's
 * hosted callback is HTTPS and mcp-remote uses a `127.0.0.1` loopback IP, so
 * both pass — but verify against a staging registration before deploy.
 */

export type RedirectUriValidation = { ok: true } | { ok: false; reason: string };

// RFC 8252 §7.3: only the literal loopback IP addresses are trusted for HTTP.
// Node's WHATWG URL parser reports the IPv6 loopback host as the bracketed
// form `[::1]`; accept the un-bracketed spelling too for defense in depth.
function isLoopbackIpHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
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
    if (isLoopbackIpHost(url.hostname)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `http redirect_uri is permitted only for the loopback IPs 127.0.0.1 or [::1] (got host "${url.hostname}")`,
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
