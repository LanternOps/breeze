/**
 * Wisp W06 — the two nudge deep-link formats (w00 "Nudges (W06)"):
 *   mobile  breeze://wisp/thread/:threadId[?concern=:concernId]
 *   web     /ai/wisp/thread/:threadId[#concern=:concernId]
 * The web form is what `user_notifications.link` stores (a relative path —
 * the table's CHECK refuses anything else); the mobile form travels in the
 * push `data.deepLink` and the in-app row's `metadata.deepLink`.
 */

const MOBILE_PREFIX = 'breeze://wisp/thread/';
const WEB_PREFIX = '/ai/wisp/thread/';
/** An id segment: uuid-ish, no separators, no percent-escapes, no dots. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function mobileDeepLink(threadId: string, concernId: string | null): string {
  return `${MOBILE_PREFIX}${threadId}${concernId ? `?concern=${concernId}` : ''}`;
}

export function webDeepLink(threadId: string, concernId: string | null): string {
  return `${WEB_PREFIX}${threadId}${concernId ? `#concern=${concernId}` : ''}`;
}

/** Accepts both forms; null for anything else (foreign scheme/host, extra segments, malformed ids). */
export function parseWispDeepLink(url: string): { threadId: string; concernId: string | null } | null {
  let rest: string;
  let sep: '?' | '#';
  if (url.startsWith(MOBILE_PREFIX)) {
    rest = url.slice(MOBILE_PREFIX.length);
    sep = '?';
  } else if (url.startsWith(WEB_PREFIX)) {
    rest = url.slice(WEB_PREFIX.length);
    sep = '#';
  } else {
    return null;
  }
  const at = rest.indexOf(sep);
  const threadId = at === -1 ? rest : rest.slice(0, at);
  if (!ID_RE.test(threadId)) return null;
  if (at === -1) return { threadId, concernId: null };
  const tail = rest.slice(at + 1);
  if (!tail.startsWith('concern=')) return null;
  const concernId = tail.slice('concern='.length);
  return ID_RE.test(concernId) ? { threadId, concernId } : null;
}
