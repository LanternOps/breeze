// Wisp W06 (web): the `#concern=<id>` fragment the thread page and the chat
// sidebar's concern list deep-link with (w00 "Nudges (W06)": web link
// `/ai/wisp/thread/:threadId#concern=:id`). Hash, not query: transient UI
// state per the repo's URL-state rule, and it never reaches the server (#2421).
//
// Check-in timers W05 (#10996): a fired check-in's bell link and post link are
// `/ai/wisp/thread/:threadId#checkin=:id` (services/wisp/notifyUser.ts), read
// the same way.

const CONCERN_PREFIX = '#concern=';
const CHECK_IN_PREFIX = '#checkin=';

/** `hash` starts with `prefix` → its decoded id; an empty id or malformed percent-encoding → null. */
function idFromHash(hash: string, prefix: string): string | null {
  if (!hash.startsWith(prefix)) return null;
  try {
    const id = decodeURIComponent(hash.slice(prefix.length));
    return id || null;
  } catch {
    return null; // a pasted link with broken encoding selects nothing rather than crashing the page
  }
}

/** `'#concern=abc'` → `'abc'`; any other hash, an empty id or malformed percent-encoding → null. */
export function concernIdFromHash(hash: string): string | null {
  return idFromHash(hash, CONCERN_PREFIX);
}

/** Inverse of `concernIdFromHash`; null → `''` (no fragment). */
export function hashForConcern(concernId: string | null): string {
  return concernId ? `${CONCERN_PREFIX}${encodeURIComponent(concernId)}` : '';
}

/** `'#checkin=abc'` → `'abc'`; any other hash, an empty id or malformed percent-encoding → null. */
export function checkInIdFromHash(hash: string): string | null {
  return idFromHash(hash, CHECK_IN_PREFIX);
}

/** A check-in post's link (`/ai/wisp/thread/<t>#checkin=<c>`) → `'<c>'`; no such fragment → null. */
export function checkInIdFromLink(link: string | null): string | null {
  if (!link) return null;
  const at = link.indexOf('#');
  return at === -1 ? null : checkInIdFromHash(link.slice(at));
}
