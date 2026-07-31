import type { Context } from 'hono';
import { trustsForwardedHeadersFrom } from './clientIp';

/**
 * Security remediation Wave 5, Task 8 (TRANSPORT-001) — make the effective
 * request scheme and the canonical HTTPS redirect Location authoritative.
 *
 * Two raw-header footguns this replaces:
 *  - Reading `X-Forwarded-Proto` without first checking that the immediate
 *    TCP peer is a trusted proxy (`trustsForwardedHeadersFrom` —
 *    `services/clientIp.ts`, the ONLY proxy-source authority). Without the
 *    gate, any client that can reach the API directly (bypassing the reverse
 *    proxy) can claim `X-Forwarded-Proto: https` and defeat a force-HTTPS
 *    redirect, or claim `http` and strip `Secure` from its own cookies.
 *  - Building a redirect `Location` from the inbound `Host` header. An
 *    attacker who reaches the origin directly (or a shared IP) controls
 *    `Host`; reflecting it back verbatim in a `Location` is a textbook
 *    header-injection / cache-deception primitive. The redirect target must
 *    come ONLY from the operator-configured `PUBLIC_API_URL`.
 *
 * `effectiveRequestScheme` is the single source of truth for "what scheme did
 * this request effectively arrive over" and is safe to call unconditionally
 * (no FORCE_HTTPS gate — that's a caller concern). `canonicalHttpsRedirect`
 * (plus `isCanonicalRequestHost`, which callers use to distinguish "already
 * secure, pass through" from "insecure but unrecognized Host, reject") is
 * intended for FORCE_HTTPS-gated callers only.
 */

/**
 * The scheme this request effectively arrived over.
 *
 * `X-Forwarded-Proto` is honored ONLY when `trustsForwardedHeadersFrom(c)` is
 * true (the immediate TCP peer is a configured trusted proxy — see
 * `services/clientIp.ts`). Only the FIRST comma-separated value is
 * considered (a proxy chain may append hops; the first is client-facing) and
 * it must normalize to exactly `http` or `https` — anything else (empty,
 * garbled, an unrecognized token) is treated as insecure (`http`) rather than
 * falling through to a different signal, so a malformed header from a
 * trusted proxy can never be interpreted as a positive HTTPS signal.
 *
 * When the header isn't trusted (or isn't present), the direct request URL's
 * scheme is used instead. Note this URL reflects whatever hop actually
 * terminated the socket to this process — in the standard Caddy-fronted
 * topology that's the internal plain-HTTP Caddy→API hop, NOT the browser's
 * transport, so it is only ever a same-process signal, never a stand-in for
 * "the browser used HTTPS." Callers that need the browser's real transport
 * (e.g. auth-cookie `Secure` semantics) must combine this with their own
 * ambiguity handling — see `isRequestConnectionSecure` in
 * `routes/auth/helpers.ts`.
 */
export function effectiveRequestScheme(c: Context): 'http' | 'https' {
  if (trustsForwardedHeadersFrom(c)) {
    const forwardedProto = c.req.header('x-forwarded-proto');
    if (forwardedProto) {
      const first = forwardedProto.split(',')[0]?.trim().toLowerCase();
      if (first === 'https') return 'https';
      if (first === 'http') return 'http';
      // Malformed or unrecognized first value (e.g. empty, "quic", garbage) —
      // insecure by default rather than guessing.
      return 'http';
    }
  }

  try {
    return new URL(c.req.url).protocol === 'https:' ? 'https' : 'http';
  } catch {
    return 'http';
  }
}

/**
 * Whether the inbound `Host` header matches the canonical host derived from
 * `publicApiUrl` (case-insensitive, port-aware — default ports are
 * normalized away by the `URL` parser, and IPv6 hosts compare in their
 * bracketed form). A missing or unparsable `Host` header is NOT canonical
 * (fail closed).
 *
 * This is the only Host check the redirect path performs: `Host` is never
 * used to build the redirect `Location` (that always comes from
 * `publicApiUrl`), so this function exists purely to let a FORCE_HTTPS-gated
 * caller distinguish "insecure request for a Host we don't recognize —
 * reject" from "insecure request for our own canonical Host — redirect".
 */
export function isCanonicalRequestHost(c: Context, publicApiUrl: URL): boolean {
  const hostHeader = c.req.header('host');
  if (!hostHeader) return false;
  try {
    // Route the raw Host header through the WHATWG URL parser (via a
    // throwaway https:// base) to get the same host normalization
    // (lowercasing, IPv6 bracketing, default-port stripping) that
    // `publicApiUrl.host` already went through — this keeps the comparison
    // trivial and correct instead of hand-rolling host/port/IPv6 parsing.
    return new URL(`https://${hostHeader}`).host === publicApiUrl.host;
  } catch {
    return false;
  }
}

/**
 * The canonical HTTPS redirect target for this request, or `null` when there
 * is nothing to redirect.
 *
 * Returns `null` in three distinct situations a caller must not conflate:
 *  1. The request is already effectively HTTPS (`effectiveRequestScheme(c)`)
 *     — pass through, nothing to do.
 *  2. The inbound `Host` is not the canonical host (`isCanonicalRequestHost`
 *     is false) — the caller MUST reject with 400 rather than treating this
 *     as pass-through; call `isCanonicalRequestHost` directly to detect this
 *     case (this function intentionally cannot signal it via its return type
 *     alone, since both "pass" and "reject" collapse to `null` here).
 *  3. The request URL itself is unparsable — pass through (nothing safe to
 *     build).
 *
 * When a redirect IS produced, its origin comes ONLY from `publicApiUrl`
 * (operator-configured, never client-controlled); only the path and query
 * string are carried over from the inbound request.
 */
export function canonicalHttpsRedirect(c: Context, publicApiUrl: URL): URL | null {
  if (effectiveRequestScheme(c) !== 'http') {
    return null;
  }
  if (!isCanonicalRequestHost(c, publicApiUrl)) {
    return null;
  }

  let requestUrl: URL;
  try {
    requestUrl = new URL(c.req.url);
  } catch {
    return null;
  }

  const location = new URL(publicApiUrl.origin);
  location.pathname = requestUrl.pathname;
  location.search = requestUrl.search;
  return location;
}
