/**
 * Scripts list fetcher — walks the offset-paginated `/scripts` endpoint and
 * accumulates every accessible row (#3301).
 *
 * `GET /scripts` defaults to 50 rows and hard-caps `limit` at 100
 * (`apps/api/src/routes/scripts.ts`). Four web call sites requested it with no
 * `limit` and no pagination, so any partner with more than 50 scripts silently
 * saw only the first 50 — no error, no "showing 50 of N", no way to reach the
 * rest. Raising the cap alone would not have fixed that; it would have moved
 * the same silent truncation to 100.
 *
 * Modelled on {@link fetchAllNetworkDevices} in `devicesFetch.ts`, which walks
 * the same offset shape. Kept as its own module rather than folded in there
 * because that file is about the two device arms; sharing only the pagination
 * idiom is not a reason to couple scripts to it.
 */
import { fetchWithAuth } from '../stores/auth';
import { asList } from './asList';

/** Per-page size. 100 is the server's hard ceiling for this endpoint —
 *  requesting more is silently clamped, so asking for exactly the cap is the
 *  fewest round trips available. */
const PAGE_LIMIT = 100;

/** Defensive ceiling on the page walk. PAGE_LIMIT * MAX_PAGES = 5,000 scripts,
 *  which is far beyond any realistic library (the bundle-export flow caps a
 *  single bundle well below this) while still bounding the loop if the server
 *  ever returns a full page forever. */
const MAX_PAGES = 50;

export interface ScriptsListResponse<T = Record<string, unknown>> {
  /** All accessible script rows, in whatever order the server returned. */
  data: T[];
  /** Total accessible row count when the server reported one. */
  total?: number;
  /** How many pages were walked. 1 means the library fit in a single page. */
  pagesWalked: number;
}

export interface FetchAllScriptsOptions {
  /** Include `is_system` seed scripts. Matches the old query param exactly —
   *  two of the four call sites passed it, two did not. */
  includeSystem?: boolean;
  /** Override the per-page size for tests. Production should leave this at the
   *  module default. */
  pageLimit?: number;
  /** Override fetcher for tests. Defaults to the auth-wrapped fetch. */
  fetcher?: typeof fetchWithAuth;
  /** Optional cancellation signal. A caller that navigates away mid-walk stops
   *  the walker between pages rather than issuing the remaining requests. */
  signal?: AbortSignal;
  /** Invoked when the walk hits MAX_PAGES without exhausting the list. Lets the
   *  caller surface a visible warning, because a silent truncation here is the
   *  exact bug this module exists to remove — it would just reappear at 5,000
   *  instead of 50. */
  onTruncated?: (info: { pagesWalked: number; pageLimit: number; actualCount: number }) => void;
}

/**
 * Walk `/scripts` and return the full accessible set as one array.
 *
 * Throws the failed `Response` on the first non-OK page, matching
 * `fetchAllDevices`, so callers keep their existing status handling —
 * `catch (err) { if (err instanceof Response && err.status === 401) ... }`.
 * Failing the whole walk rather than returning a partial list is deliberate:
 * a partial script library rendered without comment is indistinguishable from
 * a complete one, which is the bug being fixed.
 *
 * `T` is an unchecked assertion about untyped JSON, same as `asList<T>` — pass
 * it where the caller already has a row type, leave it off otherwise.
 */
export async function fetchAllScripts<T = Record<string, unknown>>(
  options: FetchAllScriptsOptions = {},
): Promise<ScriptsListResponse<T>> {
  const pageLimit = options.pageLimit ?? PAGE_LIMIT;
  const fetcher = options.fetcher ?? fetchWithAuth;
  const signal = options.signal;

  if (signal?.aborted) throw signalAbortError(signal);

  const accumulated: T[] = [];
  let total: number | undefined;

  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    // Between-page check so a navigate-away stops the next request before it
    // is issued, even when the underlying fetch ignores the signal.
    if (signal?.aborted) throw signalAbortError(signal);

    const params = new URLSearchParams();
    if (options.includeSystem) params.set('includeSystem', 'true');
    params.set('limit', String(pageLimit));
    params.set('page', String(pageNum + 1));

    const resp = await fetcher(`/scripts?${params.toString()}`);
    if (!resp.ok) throw resp;

    const body = (await resp.json()) as {
      pagination?: { total?: number; page?: number; limit?: number };
    };
    // `asList` with the legacy `scripts` alias, matching every other consumer
    // of this endpoint — and failing closed to [] rather than storing an
    // envelope object in React state.
    const page = asList<T>(body, 'scripts');
    accumulated.push(...page);

    if (pageNum === 0 && typeof body.pagination?.total === 'number') {
      total = body.pagination.total;
    }

    // Offset pagination: a short (or empty) page is the end of the list.
    if (page.length < pageLimit) {
      return { data: accumulated, total, pagesWalked: pageNum + 1 };
    }
  }

  console.warn(
    `[fetchAllScripts] hit MAX_PAGES=${MAX_PAGES} safety ceiling at limit=${pageLimit}; truncating walk.`,
  );
  try {
    options.onTruncated?.({ pagesWalked: MAX_PAGES, pageLimit, actualCount: accumulated.length });
  } catch (err) {
    // A misbehaving callback must not corrupt the return.
    console.warn('[fetchAllScripts] onTruncated callback threw:', err);
  }
  // `total` is dropped so the caller cannot claim "this is the whole library".
  return { data: accumulated, total: undefined, pagesWalked: MAX_PAGES };
}

/** Standard DOMException-shaped AbortError, so callers can branch on
 *  `err.name === 'AbortError'` regardless of abort source. */
function signalAbortError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  return new DOMException('Aborted', 'AbortError');
}
