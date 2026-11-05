// Wisp W06 (web): the `#concern=<id>` fragment the thread page and the chat
// sidebar's concern list deep-link with (w00 "Nudges (W06)": web link
// `/ai/wisp/thread/:threadId#concern=:id`). Hash, not query: transient UI
// state per the repo's URL-state rule, and it never reaches the server (#2421).

const PREFIX = '#concern=';

/** `'#concern=abc'` → `'abc'`; any other hash, an empty id or malformed percent-encoding → null. */
export function concernIdFromHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const id = decodeURIComponent(hash.slice(PREFIX.length));
    return id || null;
  } catch {
    return null; // a pasted link with broken encoding selects nothing rather than crashing the page
  }
}

/** Inverse of `concernIdFromHash`; null → `''` (no fragment). */
export function hashForConcern(concernId: string | null): string {
  return concernId ? `${PREFIX}${encodeURIComponent(concernId)}` : '';
}
