/**
 * Devices list fetcher — walks the `/devices` keyset cursor and accumulates
 * every accessible row (Discussion #742 PR 3b — web consumer).
 *
 * Forward + backward compatible with the API on either side of the
 * cursor migration:
 *   - **New API** (cursor mode): server returns
 *     `{data, pagination: {nextCursor, limit, total?}}`. We follow
 *     `nextCursor` until it goes null, accumulating pages.
 *   - **Old API** (offset mode): server returns
 *     `{data, pagination: {page, limit, total}}` with no `nextCursor`.
 *     The walk terminates after the first page, giving the same capped
 *     single-page behavior the UI had before.
 *
 * `includeTotal=true` is set only on the first request; the cursor mode
 * doesn't recompute the count per page (the client carries it). On the
 * old API the param is ignored — no behavior change.
 *
 * Defensive: every page is capped at PAGE_LIMIT, and the walk itself is
 * capped at MAX_PAGES so a misbehaving server can't pull the UI into an
 * unbounded loop.
 */
import { fetchWithAuth } from '../stores/auth';

/** Per-page size requested from the server. 200 matches the UI's
 *  largest natural page size selector and keeps responses around 200KB
 *  for the widest current device shape — well under the 1MB cursor mode
 *  ceiling and well below the server's `DEVICES_LIST_HARD_MAX=1000`. */
const PAGE_LIMIT = 200;

/** Defensive ceiling on the page walk. PAGE_LIMIT * MAX_PAGES = 40,000
 *  devices — at least an order of magnitude over the realistic fleet
 *  size for the next several years, and a hard guard against an API bug
 *  that returns a stuck `nextCursor` pointing back at the same window. */
const MAX_PAGES = 200;

export interface DevicesListResponse {
  /** All accessible device rows. Order: whatever the server returned
   *  (default `hostname ASC` under the cursor API; `last_seen_at DESC`
   *  under the legacy offset API). */
  data: Record<string, unknown>[];
  /** Total accessible row count when known. Undefined when the server
   *  didn't return it (cursor mode with includeTotal=false) or when the
   *  count was unavailable (legacy mode it should always be set). */
  total?: number;
  /** How many cursor pages were walked. 1 means single-page (legacy or
   *  small fleet). Useful for tests and telemetry. */
  pagesWalked: number;
}

export interface FetchAllDevicesOptions {
  /** Whether to include decommissioned devices. Matches the old query
   *  param exactly. */
  includeDecommissioned?: boolean;
  /** Override the per-page size for tests. Production should leave this
   *  at the module default. */
  pageLimit?: number;
  /** Override fetcher for tests. Defaults to the auth-wrapped fetch. */
  fetcher?: typeof fetchWithAuth;
  /** Optional cancellation signal. When the caller (e.g. the DevicesPage
   *  on navigate-away) aborts, the walker stops between pages and rejects
   *  with the standard `DOMException('Aborted', 'AbortError')`. Without
   *  this, a multi-page walk can keep issuing up to MAX_PAGES requests
   *  after the user has left the page — wasted bandwidth on slow links
   *  and unnecessary API load. */
  signal?: AbortSignal;
  /** Invoked when the walker hits the MAX_PAGES safety ceiling without
   *  reaching the end of the cursor. Lets the caller surface a visible
   *  warning (toast, telemetry) so a silent truncation doesn't get
   *  reported later as "devices are missing." The walker still returns
   *  the accumulated rows with `total=undefined` to indicate the count
   *  is unreliable. */
  onTruncated?: (info: { pagesWalked: number; pageLimit: number }) => void;
}

/**
 * Walk the `/devices` cursor (or single page on legacy API) and return
 * the full accessible set as one array.
 *
 * Rejects (throws the failed Response) on the first non-OK page so the
 * caller surfaces a single clear error rather than a partial render with
 * a misleading device count. A retry from the UI redoes the walk
 * end-to-end.
 */
export async function fetchAllDevices(
  options: FetchAllDevicesOptions = {},
): Promise<DevicesListResponse> {
  const includeDecommissioned = options.includeDecommissioned ?? true;
  const pageLimit = options.pageLimit ?? PAGE_LIMIT;
  const fetcher = options.fetcher ?? fetchWithAuth;
  const signal = options.signal;

  // Fast-path: if the caller already aborted before invocation, throw
  // immediately rather than issuing page 0.
  if (signal?.aborted) {
    throw signalAbortError(signal);
  }

  const accumulated: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let total: number | undefined;

  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    // Check between pages so a navigate-away that lands mid-walk stops
    // the next request before we issue it. Checking here (rather than
    // inside the fetcher) means we still surface a single AbortError
    // even when the underlying fetch implementation does not honor
    // AbortSignal.
    if (signal?.aborted) {
      throw signalAbortError(signal);
    }

    const params = new URLSearchParams();
    if (includeDecommissioned) params.set('includeDecommissioned', 'true');
    params.set('limit', String(pageLimit));
    if (cursor !== null) params.set('cursor', cursor);
    // includeTotal only on the cursor-less first page — the cursor API
    // skips the count(*) on subsequent pages and we carry the value
    // received on page 0.
    if (pageNum === 0) params.set('includeTotal', 'true');

    const resp = await fetcher(`/devices?${params.toString()}`);
    if (!resp.ok) throw resp;
    const body = (await resp.json()) as {
      data?: Record<string, unknown>[];
      pagination?: {
        nextCursor?: string | null;
        total?: number;
        // Legacy fields — present on the offset API, harmless to read.
        page?: number;
        limit?: number;
      };
    };
    // Both the cursor API (#777) and the legacy offset API return `data`.
    // A previous draft also accepted a `devices` key, but no deployed shape
    // ever returns that — dropped per #778 review.
    const page = body.data ?? [];
    accumulated.push(...page);

    if (pageNum === 0 && typeof body.pagination?.total === 'number') {
      total = body.pagination.total;
    }
    cursor =
      typeof body.pagination?.nextCursor === 'string' && body.pagination.nextCursor.length > 0
        ? body.pagination.nextCursor
        : null;
    if (cursor === null) {
      return { data: accumulated, total, pagesWalked: pageNum + 1 };
    }
  }

  // Hit the safety ceiling. Return what we have, but flag total as
  // undefined so the caller knows the walk didn't complete and shouldn't
  // assert "this is the full fleet." Invoke onTruncated so the UI can
  // surface a visible warning — a silent console.warn gets reported as
  // "missing devices" with no obvious cause (Todd's #778 review).
  console.warn(
    `[fetchAllDevices] hit MAX_PAGES=${MAX_PAGES} safety ceiling at limit=${pageLimit}; truncating walk. ` +
      `Investigate server-side cursor loop.`,
  );
  try {
    options.onTruncated?.({ pagesWalked: MAX_PAGES, pageLimit });
  } catch (err) {
    // A misbehaving onTruncated must not corrupt the return — we still
    // surface the accumulated rows so the UI degrades gracefully.
    console.warn('[fetchAllDevices] onTruncated callback threw:', err);
  }
  return { data: accumulated, total: undefined, pagesWalked: MAX_PAGES };
}

/** Build the standard DOMException-shaped AbortError so callers can do
 *  `catch (err) { if (err.name === 'AbortError') return; }` against any
 *  abort source (DOM-native fetch, our walker, any other library). When
 *  the signal carries a `reason`, prefer that; otherwise fall back to the
 *  generic message. */
function signalAbortError(signal: AbortSignal): Error {
  // AbortSignal.reason was added in 17+/Chromium 100+; gracefully degrade
  // if we're in an older environment.
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  return new DOMException('Aborted', 'AbortError');
}
