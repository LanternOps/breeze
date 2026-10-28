/**
 * #10385: lets chat compaction re-issue a paged tool's `nextCursor` after it
 * drops rows from the page.
 *
 * Chat compaction (aiToolOutput.ts) runs AFTER the tool has built its paging
 * envelope, and may cut the page's row array to fit the chat budget. Before
 * this, `nextCursor` / `showing` / `hasMore` still described the FULL page, so
 * following the cursor skipped every dropped row, and a `hasMore: false` page
 * had no cursor at all. The compactor cannot mint a cursor on its own: it does
 * not know the query fingerprint, and a keyset cursor needs each row's
 * full-precision sort key, which the tool strips from the visible rows.
 *
 * So the envelope helpers (aiToolPagination.ts) attach a small descriptor under
 * PAGE_RESUME_KEY carrying exactly that material. The compactor always strips
 * it (the model never sees it) and, when it cut the page, mints the cursor
 * that resumes after the last row it kept.
 *
 * This module is a dependency-free leaf on purpose: aiToolOutput.ts is imported
 * by every worker (MAX_TOOL_RESULT_CHARS) and must not pull drizzle/zod through
 * aiToolPagination.ts.
 */

export const PAGE_RESUME_KEY = '_pageResume';

type OffsetCursorBody = { f: string; o: number };
type KeysetCursorBody = { f: string; t: string; i: string };

/** The one cursor encoding; aiToolPagination.ts decodes it. */
export function encodePageCursor(body: OffsetCursorBody | KeysetCursorBody): string {
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export type PageResume =
  | {
    v: 1;
    key: string;
    f: string;
    mode: 'offset';
    /** The offset this page started at. */
    offset: number;
    /** How many rows the tool put on the page. */
    rows: number;
  }
  | {
    v: 1;
    key: string;
    f: string;
    mode: 'keyset';
    /** The cursor position this page started after (null = first page). */
    after: [string, string] | null;
    /** Each row's sort key [t, i], in row order. */
    keys: Array<[string, string]>;
  };

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isKeyPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string';
}

/**
 * Validate a descriptor read back out of a tool result. Anything malformed
 * yields null and the compactor leaves the envelope exactly as the tool wrote
 * it — a wrong cursor is worse than the old behaviour.
 */
export function readPageResume(value: unknown): PageResume | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (d.v !== 1 || typeof d.key !== 'string' || d.key.length === 0 || typeof d.f !== 'string' || d.f.length === 0) {
    return null;
  }
  if (d.mode === 'offset') {
    if (!isCount(d.offset) || !isCount(d.rows)) return null;
    return { v: 1, key: d.key, f: d.f, mode: 'offset', offset: d.offset, rows: d.rows };
  }
  if (d.mode === 'keyset') {
    if (d.after !== null && !isKeyPair(d.after)) return null;
    if (!Array.isArray(d.keys) || !d.keys.every(isKeyPair)) return null;
    return { v: 1, key: d.key, f: d.f, mode: 'keyset', after: d.after, keys: d.keys };
  }
  return null;
}

/**
 * How many rows the tool put on the page. The compactor only re-mints a cursor
 * when this matches the row array it received — if a tool reshaped the rows
 * after building the envelope, row N no longer maps to position N.
 */
export function pageResumeRowCount(resume: PageResume): number {
  return resume.mode === 'keyset' ? resume.keys.length : resume.rows;
}

/**
 * The cursor that continues right after the first `kept` rows of the page.
 * `kept === 0` resumes at the start of this page. Returns null only when that
 * position is "no cursor" (the first page of a keyset list).
 */
export function resumeCursorAfter(resume: PageResume, kept: number): string | null {
  if (resume.mode === 'offset') return encodePageCursor({ f: resume.f, o: resume.offset + kept });
  const at = kept > 0 ? resume.keys[kept - 1] : resume.after;
  if (!at) return null;
  return encodePageCursor({ f: resume.f, t: at[0], i: at[1] });
}
