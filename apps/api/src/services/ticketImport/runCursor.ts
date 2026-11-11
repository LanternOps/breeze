/**
 * A run's position (#8313 W4; spec 2026-10-19 §5.8, §5.9), stored in
 * `ticket_import_runs.cursor` and saved with every commit of a slice, in the
 * same transaction as the ledger rows it covers. Positions and counts only
 * (review #13): the links waiting for the links phase live on their ledger
 * items (`pending_links`), and `owner_unmatched` is deduplicated by a unique
 * index on the issue rows, so the cursor stays a few hundred bytes whatever
 * the source's size.
 *
 * - `scan.page` is the module's cursor of the page being processed, and
 *   `scan.index` how many of its rows are done. A crash mid-page re-reads the
 *   same page and skips the rows already committed; the ledger makes a row
 *   reprocessed after a source shift cost nothing.
 * - `links.after` and `deletions.after` are keyset positions over the
 *   source's items.
 * - `sourceFailures` counts consecutive source failures after retries,
 *   `Retry-After` waits included; at SOURCE_FAILURE_LIMIT the run stops
 *   (`source_unavailable`).
 * - `clockSkewMs` is measured once per run, at its first slice's connect.
 */

export const SOURCE_FAILURE_LIMIT = 20;

export type RunCursor = {
  scan: { page: unknown; index: number; done: boolean };
  links: { after: string | null };
  deletions: { after: string | null };
  sourceFailures: number;
  clockSkewMs: number | null | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function keyOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function normalizeCursor(raw: unknown): RunCursor {
  const c = isRecord(raw) ? raw : {};
  const scan = isRecord(c.scan) ? c.scan : {};
  const links = isRecord(c.links) ? c.links : {};
  const deletions = isRecord(c.deletions) ? c.deletions : {};
  return {
    scan: { page: scan.page ?? null, index: nonNegativeInt(scan.index), done: scan.done === true },
    links: { after: keyOrNull(links.after) },
    deletions: { after: keyOrNull(deletions.after) },
    sourceFailures: nonNegativeInt(c.sourceFailures),
    clockSkewMs: typeof c.clockSkewMs === 'number' ? c.clockSkewMs : c.clockSkewMs === null ? null : undefined,
  };
}
