/**
 * URL-fragment grammar for the Restore tab: `restore[?snapshot=<id>&paths=<a,b,c>]`.
 *
 * `SnapshotBrowser`'s per-file checkbox selection is otherwise local state
 * only — clicking through to the Restore tab used to make the operator
 * re-select the same snapshot and files in the wizard (#6456). This carries
 * the browser's snapshot id + selected paths across in the URL fragment
 * (CLAUDE.md: `window.location.hash` is the sanctioned mechanism for
 * client-side UI state — never a query param), never the server.
 *
 * Each path is `encodeURIComponent`-ed individually before being joined with
 * a literal comma, so a comma inside a path (which `encodeURIComponent`
 * escapes to `%2C`) can never be confused with the path separator.
 */

export type RestoreHashParams = { snapshotId: string; paths: string[] };

const RESTORE_TAB = 'restore';

/**
 * Returns the fragment WITHOUT a leading `#` — callers assign it to
 * `window.location.hash` (which prepends one) or hand it to `HashLink`.
 *
 * Built by hand rather than via `URLSearchParams` (which would re-encode the
 * already-`encodeURIComponent`-ed path segments on `.toString()`, doubling
 * the `%` escapes) — one encode layer in, one decode layer out in
 * `parseRestoreHash`.
 */
export function buildRestoreHash(snapshotId: string, paths: string[]): string {
  const query = [`snapshot=${encodeURIComponent(snapshotId)}`];
  if (paths.length > 0) {
    query.push(`paths=${paths.map(encodeURIComponent).join(',')}`);
  }
  return `${RESTORE_TAB}?${query.join('&')}`;
}

/**
 * Parses a restore-tab hash (leading `#` optional) back into the snapshot id
 * + selected paths. Returns `null` when the hash isn't a restore hash carrying
 * a snapshot id — including a plain `restore` hash with no query, which is
 * the normal case when the operator navigates to the tab directly rather than
 * via a carried selection.
 */
export function parseRestoreHash(hash: string): RestoreHashParams | null {
  const stripped = hash.replace(/^#/, '');
  const [base, query] = stripped.split('?');
  if (base !== RESTORE_TAB || !query) return null;

  const fields = new Map<string, string>();
  for (const pair of query.split('&')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    fields.set(pair.slice(0, eqIndex), pair.slice(eqIndex + 1));
  }

  const rawSnapshotId = fields.get('snapshot');
  if (!rawSnapshotId) return null;
  const snapshotId = decodeURIComponent(rawSnapshotId);

  const rawPaths = fields.get('paths');
  const paths = rawPaths
    ? rawPaths.split(',').filter(Boolean).map((segment) => decodeURIComponent(segment))
    : [];

  return { snapshotId, paths };
}
