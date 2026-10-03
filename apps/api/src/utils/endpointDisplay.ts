import { createHash } from 'node:crypto';

/**
 * How stored endpoint URLs (webhooks, HTTP checks) are shown in AI tool
 * results and in stored error text.
 *
 * For many endpoints the credential lives in the URL itself: userinfo, a
 * `?token=` query, or a path segment that authorizes the request (Slack
 * `/services/T/B/<x>`, Discord `/api/webhooks/<id>/<x>`, Teams). Only the
 * origin (scheme + host + non-default port) is shown, plus a short fingerprint
 * of the full URL so two endpoints on the same host can still be told apart.
 */

export interface EndpointUrlView {
  /** Scheme + host (+ non-default port) only, or a fixed placeholder. */
  url: string;
  /** Short stable hash of the full URL; null when no origin could be shown. */
  fingerprint: string | null;
}

export const INVALID_URL_PLACEHOLDER = '[invalid-url]';

function fingerprintOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(-6);
}

/** Origin of a URL, or null when it has no host-based origin. */
function originOf(raw: string): string | null {
  try {
    const origin = new URL(raw).origin;
    // Non-special schemes have an opaque origin ("null").
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export function describeEndpointUrl(raw: string): EndpointUrlView {
  const origin = originOf(raw);
  if (!origin) return { url: INVALID_URL_PLACEHOLDER, fingerprint: null };
  return { url: origin, fingerprint: fingerprintOf(raw) };
}

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface EndpointTargetView {
  target: string;
  /** Set only when something was removed from the stored target. */
  fingerprint: string | null;
}

/**
 * Monitor targets are either a bare host / IP / host:port (ping, TCP, DNS) or
 * a URL (HTTP checks). Bare hosts are returned unchanged; a URL is reduced to
 * its origin, and a scheme-less target that carries userinfo, a path or a
 * query is reduced to its host part.
 */
export function presentEndpointTarget(target: string): EndpointTargetView {
  if (SCHEME_PREFIX.test(target)) {
    const view = describeEndpointUrl(target);
    return { target: view.url, fingerprint: view.fingerprint };
  }
  if (!/[/?#@]/.test(target)) return { target, fingerprint: null };
  const withoutUserinfo = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target;
  const host = withoutUserinfo.split(/[/?#]/, 1)[0] ?? '';
  return { target: host || INVALID_URL_PLACEHOLDER, fingerprint: fingerprintOf(target) };
}

// A URL token inside free text: scheme://, then everything up to whitespace or
// a quote/bracket. Go's *url.Error renders as `Get "https://…": <cause>`, so a
// closing quote ends the token.
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/** Replace every URL in `text` with its origin (or a placeholder). */
export function scrubUrlsInText(text: string): string;
export function scrubUrlsInText<T extends string | null | undefined>(text: T): T;
export function scrubUrlsInText(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  return text.replace(URL_IN_TEXT, (match) => originOf(match) ?? '[url]');
}

/** scrubUrlsInText applied to every string inside a JSON-like value. */
export function scrubUrlsInValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubUrlsInText(value);
  if (Array.isArray(value)) return value.map(scrubUrlsInValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubUrlsInValue(v)]));
  }
  return value;
}
