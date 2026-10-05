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

// A URL token inside free text: scheme://, then everything up to whitespace,
// a double quote, angle bracket or backtick. Go's *url.Error renders as
// `Get "https://…": <cause>` (with any `"` in the URL escaped), so the closing
// double quote ends the token. A single quote is legal inside userinfo and
// paths, so it does not end the token; trailing punctuation is peeled off
// after matching instead.
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"<>`]+/gi;
const TRAILING_PUNCTUATION = /[)\]'.,;:!?]+$/;

/** Replace every URL in `text` with its origin (or a placeholder). */
export function scrubUrlsInText(text: string): string;
export function scrubUrlsInText<T extends string | null | undefined>(text: T): T;
export function scrubUrlsInText(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  return text.replace(URL_IN_TEXT, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return (originOf(url) ?? '[url]') + trailing;
  });
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

// ---------------------------------------------------------------------------
// Writing displayed values back
//
// A model that reads an endpoint through a tool sees the display form above
// (origin + fingerprint, masked header values). When it then calls an update
// action it often echoes that display form back. Storing it would replace the
// working URL / header value with the display string and break the check.
//
// Same convention as the masked-secret editors (`********` resolves to the
// stored value, see notificationChannelSecrets.ts): a value that is the
// display form of what is stored means "unchanged". A display-form value that
// does not belong to the stored value (or is supplied on create) is refused,
// so the caller is told to send the full value instead of a masked string
// being stored.
// ---------------------------------------------------------------------------

/** What tool-output redaction writes in place of a masked value (logRedaction.ts). */
export const REDACTED_DISPLAY_VALUE = '[REDACTED]';
/** What webhook tools show for an endpoint that could not be decrypted. */
export const ENCRYPTED_DISPLAY_VALUE = '[encrypted]';

const DISPLAY_PLACEHOLDERS = new Set<string>([
  REDACTED_DISPLAY_VALUE,
  ENCRYPTED_DISPLAY_VALUE,
  INVALID_URL_PLACEHOLDER,
]);

/** A placeholder a tool result shows instead of a stored value (or an all-asterisk mask). */
export function isDisplayPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return DISPLAY_PLACEHOLDERS.has(trimmed) || /^\*{3,}$/.test(trimmed);
}

export type DisplayedValueResolution<T> =
  | { ok: true; value: T; keptStored: boolean }
  | { ok: false; error: string };

function fullValueRequired(field: string, what: string): { ok: false; error: string } {
  return {
    ok: false,
    error: `${field} looks like the displayed form of ${what} (tool results show only scheme + host, a fingerprint, or a masked placeholder). Supply the full URL, or omit ${field} to keep the stored value.`,
  };
}

/**
 * Resolve an endpoint target / URL supplied on a write against the stored one.
 * `fingerprint` is the sibling fingerprint field (`targetFingerprint`,
 * `urlFingerprint`) when the caller echoed it back.
 */
export function resolveEndpointTargetInput(
  incoming: string,
  options: { stored?: string | null; fingerprint?: unknown; field: string },
): DisplayedValueResolution<string> {
  const { stored, fingerprint, field } = options;
  const hasFingerprint = fingerprint !== undefined && fingerprint !== null;

  if (typeof stored === 'string' && stored.length > 0) {
    if (incoming === stored && !hasFingerprint) return { ok: true, value: stored, keptStored: false };
    const shown = presentEndpointTarget(stored);
    const isShownForm = shown.fingerprint !== null && incoming === shown.target;
    if (isShownForm && (!hasFingerprint || fingerprint === shown.fingerprint)) {
      return { ok: true, value: stored, keptStored: true };
    }
    if (isShownForm || hasFingerprint || isDisplayPlaceholder(incoming)) {
      return fullValueRequired(field, 'a different endpoint than the one stored');
    }
    return { ok: true, value: incoming, keptStored: false };
  }

  if (hasFingerprint || isDisplayPlaceholder(incoming)) {
    return fullValueRequired(field, 'an endpoint');
  }
  return { ok: true, value: incoming, keptStored: false };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when two endpoints share an origin (scheme + host + port). Identical
 * strings (bare hosts included) count as the same; anything that cannot be
 * parsed to an origin on either side counts as changed.
 */
export function endpointOriginUnchanged(stored: string | null | undefined, next: string | null | undefined): boolean {
  if (typeof stored !== 'string' || typeof next !== 'string') return false;
  if (stored === next) return true;
  const a = originOf(stored);
  const b = originOf(next);
  return a !== null && a === b;
}

/**
 * Resolve a header map supplied on a write: a masked value keeps the stored
 * value for that header name; a whole-map placeholder keeps every stored
 * header. A masked value with nothing stored under that name is refused.
 *
 * Stored values are kept only while the endpoint origin is unchanged. When
 * `endpoints` is given and the origin differs, a masked value is refused so
 * the caller supplies the header values meant for the new endpoint.
 */
export function resolveHeaderValuesInput(
  incoming: unknown,
  stored: unknown,
  field: string,
  endpoints?: { storedEndpoint: string | null | undefined; nextEndpoint: string | null | undefined },
): DisplayedValueResolution<unknown> {
  const allowStoredReuse = !endpoints || endpointOriginUnchanged(endpoints.storedEndpoint, endpoints.nextEndpoint);
  const storedRecord = allowStoredReuse && isPlainRecord(stored) ? stored : null;
  const originNote = allowStoredReuse
    ? ''
    : ' The endpoint is changing to a different origin, so stored header values are not carried over.';
  if (isDisplayPlaceholder(incoming)) {
    if (storedRecord) return { ok: true, value: storedRecord, keptStored: true };
    return {
      ok: false,
      error: `${field} is a masked placeholder and there are no stored header values to keep.${originNote} Supply the header values.`,
    };
  }
  if (!isPlainRecord(incoming)) return { ok: true, value: incoming, keptStored: false };

  let keptStored = false;
  const missing: string[] = [];
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!isDisplayPlaceholder(value)) {
      resolved[name] = value;
      continue;
    }
    if (storedRecord && Object.hasOwn(storedRecord, name) && typeof storedRecord[name] === 'string') {
      resolved[name] = storedRecord[name];
      keptStored = true;
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error: `${field} has masked values for ${missing.join(', ')} with no stored value to keep.${originNote} Supply the actual header value, or omit the header.`,
    };
  }
  return { ok: true, value: resolved, keptStored };
}

/**
 * Path of the first masked placeholder (`[REDACTED]`, `[encrypted]`) inside a
 * value, or null. Used to refuse a write that would store one.
 */
export function findDisplayPlaceholderPath(value: unknown, path = ''): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === REDACTED_DISPLAY_VALUE || trimmed === ENCRYPTED_DISPLAY_VALUE ? path : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findDisplayPlaceholderPath(value[i], `${path}[${i}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (isPlainRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const found = findDisplayPlaceholderPath(entry, path ? `${path}.${key}` : key);
      if (found !== null) return found;
    }
  }
  return null;
}

const NETWORK_MONITOR_ALERT_SOURCE = 'network_monitor';
// Kept in step with the backfill migration
// 2026-12-07-110000-network-monitor-alert-endpoint-display.sql.
const MIN_SUBSTITUTABLE_TARGET_LENGTH = 4;

/**
 * Text copied out of an alert (title, message) into another record. Every URL
 * is reduced to its origin. A network-monitor alert stored before the monitor
 * worker presented its target also embeds the raw check target, which can be
 * scheme-less (`user@host/path`); that is reduced the way
 * presentEndpointTarget reduces it.
 */
export function scrubAlertText<T extends string | null | undefined>(text: T, context: unknown): T;
export function scrubAlertText(text: string | null | undefined, context: unknown): string | null | undefined {
  if (!text) return text;
  let out = text;
  const ctx = context as { source?: unknown; target?: unknown } | null | undefined;
  if (ctx && ctx.source === NETWORK_MONITOR_ALERT_SOURCE && typeof ctx.target === 'string' && ctx.target) {
    const presented = presentEndpointTarget(ctx.target).target;
    // A target with no host part ('@', '/', 'x@') reduces to the placeholder;
    // replacing such a short substring would rewrite unrelated characters of
    // the message, so only a host-shaped target is substituted.
    const substitutable = presented !== ctx.target
      && presented !== INVALID_URL_PLACEHOLDER
      && ctx.target.length >= MIN_SUBSTITUTABLE_TARGET_LENGTH;
    if (substitutable) out = out.split(ctx.target).join(presented);
  }
  return scrubUrlsInText(out);
}
