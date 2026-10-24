/**
 * `key=value` state in `window.location.hash` for the Operator surfaces
 * (CLAUDE.md: transient UI state lives in the hash, never a query param).
 *
 * The /operator page carries two keys at once (`#tab=library&recipe=…`), so a
 * writer must keep the keys it does not own. These helpers are the one place
 * that parses and re-serializes the fragment.
 */

export function readHashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ''));
}

export function readHashParam(hash: string, key: string): string | null {
  return readHashParams(hash).get(key);
}

/**
 * Set (or, with `null`, remove) one key and keep every other one. Assigns
 * `location.hash` like every other tab in the app, so `useHashState`
 * listeners see the change through the browser's own `hashchange`.
 */
export function writeHashParam(key: string, value: string | null): void {
  const params = readHashParams(window.location.hash);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const next = params.toString();
  if (next === window.location.hash.replace(/^#/, '')) return;
  window.location.hash = next;
}
