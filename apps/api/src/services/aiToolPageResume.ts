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
    /**
     * The furthest offset the tool will honour for this page size (it clamps
     * anything beyond). A resume point past it would be clamped back onto
     * rows already shown — re-delivering them forever — so none is minted.
     */
    maxOffset: number;
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
    if (!isCount(d.offset) || !isCount(d.rows) || !isCount(d.maxOffset)) return null;
    return { v: 1, key: d.key, f: d.f, mode: 'offset', offset: d.offset, rows: d.rows, maxOffset: d.maxOffset };
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

export type ResumePoint =
  /** Continue with this cursor. */
  | { kind: 'cursor'; cursor: string }
  /** The position is the very start of the list: call again without a cursor. */
  | { kind: 'start' }
  /** The tool cannot page to this position (offset ceiling). */
  | { kind: 'unreachable' };

/**
 * Where to continue right after the first `kept` rows of the page. `kept === 0`
 * is the start of this page.
 */
export function resumePointAfter(resume: PageResume, kept: number): ResumePoint {
  if (resume.mode === 'offset') {
    const o = resume.offset + kept;
    if (o > resume.maxOffset) return { kind: 'unreachable' };
    return { kind: 'cursor', cursor: encodePageCursor({ f: resume.f, o }) };
  }
  const at = kept > 0 ? resume.keys[kept - 1] : resume.after;
  if (kept > resume.keys.length) return { kind: 'unreachable' };
  if (!at) return { kind: 'start' };
  return { kind: 'cursor', cursor: encodePageCursor({ f: resume.f, t: at[0], i: at[1] }) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Split the descriptor off a SERIALIZED tool result, for code that handles the
 * result before the compactor does (large-result capture). Returns null when
 * the result carries none, so the caller keeps the original string untouched.
 */
export function splitPageResumeJson(raw: string): { rest: string; descriptor: unknown } | null {
  if (!raw.includes(PAGE_RESUME_KEY)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !(PAGE_RESUME_KEY in parsed)) return null;
  const { [PAGE_RESUME_KEY]: descriptor, ...rest } = parsed;
  return { rest: JSON.stringify(rest), descriptor };
}

/**
 * A tool result with the descriptor removed, for a consumer that uses the raw
 * `executeTool` string WITHOUT chat compaction (flow steps, the intent
 * ledger). Those never cut rows, so they have no use for it, and it must not
 * reach a model or a stored record as if it were tool output.
 */
export function stripPageResumeJson(raw: string): string {
  const split = splitPageResumeJson(raw);
  return split ? split.rest : raw;
}

/** Put a descriptor split off by `splitPageResumeJson` back on a JSON object string. */
export function attachPageResumeJson(json: string, descriptor: unknown): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (isPlainObject(parsed)) return JSON.stringify({ ...parsed, [PAGE_RESUME_KEY]: descriptor });
  } catch {
    // Redaction left something that is not JSON: hand it on without the
    // descriptor — the compactor then leaves the envelope as the tool wrote it.
  }
  return json;
}
