import { asList } from './asList';

/** The server's hard ceiling (`getPagination` clamps `limit` to 100) — asking
 *  for it makes the fewest round-trips. */
export const LIST_PAGE_SIZE = 100;
/** A stop so a wrong/absent `total` can never spin: 100 pages = 10k rows. */
export const LIST_MAX_PAGES = 100;

/**
 * Walk every page of a Breeze list route (#3446, #6412).
 *
 * Every paginated route defaults to `limit=50` and clamps at 100
 * (`apps/api/src/utils/pagination.ts`), so a single request silently truncates.
 * In a `<select>` that truncation is invisible — the row is simply absent,
 * which reads as "it does not exist" rather than "the list stopped" — and for a
 * mandatory picker (move-device target site) it makes the row unreachable by
 * any route in the UI. Paging to exhaustion removes the failure mode instead of
 * hand-tuning a `limit=` per call site.
 *
 * `null` from `fetchPage` propagates as `null` so a caller can abort (401
 * redirect) rather than render a spuriously empty list.
 */
/**
 * A list route answered non-OK. Carries the status so a caller that had a
 * dedicated 401 branch (bail to the auth redirect rather than toast over it)
 * can keep it after moving to these helpers.
 */
export class ListFetchError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ListFetchError';
  }
}

function isRecognizedListShape(body: unknown, aliasKeys: string[]): boolean {
  if (Array.isArray(body)) return true;
  if (body === null || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  return Array.isArray(record.data) || aliasKeys.some((key) => Array.isArray(record[key]));
}

export async function fetchAllPages<T = unknown>(
  fetchPage: (page: number, limit: number) => Promise<unknown>,
  options: { pageSize?: number; maxPages?: number; aliasKeys?: string[]; strictShape?: boolean } = {},
): Promise<T[] | null> {
  const pageSize = options.pageSize ?? LIST_PAGE_SIZE;
  const maxPages = options.maxPages ?? LIST_MAX_PAGES;
  const aliasKeys = options.aliasKeys ?? [];
  const all: T[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const body = await fetchPage(page, pageSize);
    // A `null` page anywhere aborts the whole walk: returning the pages
    // gathered so far would be the silent truncation this helper exists to kill.
    if (body === null || body === undefined) return null;

    // `asList` fails closed to `[]` on a body it doesn't recognise, which is
    // right for a list that only renders. A caller that must distinguish
    // "confirmed empty" from "the response made no sense" (useSiteCrud's
    // first-site nag) opts into `strictShape` and handles the throw.
    if (options.strictShape && !isRecognizedListShape(body, aliasKeys)) {
      throw new Error('fetchAllPages: response was ok but not a parseable list');
    }
    const batch = asList<T>(body, ...aliasKeys);
    all.push(...batch);

    // Stop on a short page rather than trusting `total` alone: a legacy or
    // unpaginated response is a bare array with no pagination block and must
    // still terminate.
    if (batch.length < pageSize) break;
    const total = (body as { pagination?: { total?: unknown } })?.pagination?.total;
    if (typeof total === 'number' && all.length >= total) break;
  }

  return all;
}
