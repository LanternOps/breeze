import { fetchWithAuth, type FetchWithAuthOptions } from '../stores/auth';
import { fetchAllPages } from './fetchAllPages';

/**
 * Loads EVERY site matching `path` (#6412).
 *
 * `GET /orgs/sites` defaults to 50 rows and caps at 100, and the site pickers
 * all render the response straight into a `<select>`. A site past the page
 * limit is therefore not just missing from the list — in a mandatory picker
 * (e.g. the move-device target site) it is a destination the technician cannot
 * reach by any route in the UI, with nothing on screen to say the list stopped.
 *
 * `path` is the route plus any filters, WITHOUT `page`/`limit`:
 *   `fetchAllSites('/orgs/sites?organizationId=' + orgId)`
 *
 * Throws on a non-OK response so callers keep their existing error branch —
 * this never converts a failed load into an empty list.
 */
export class ListFetchError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ListFetchError';
  }
}

export async function fetchAllSites<T = any>(
  path: string,
  init?: FetchWithAuthOptions,
  options: { strictShape?: boolean } = {},
): Promise<T[]> {
  const separator = path.includes('?') ? '&' : '?';
  const sites = await fetchAllPages<T>(async (page, limit) => {
    const response = await fetchWithAuth(`${path}${separator}page=${page}&limit=${limit}`, init);
    if (!response.ok) {
      // Carries the status so a caller that had a dedicated 401 branch before
      // (bail to the auth redirect rather than toast) can keep it.
      throw new ListFetchError(response.status, `Failed to fetch sites (status ${response.status})`);
    }
    return response.json();
  }, { aliasKeys: ['sites'], strictShape: options.strictShape });
  // `fetchAllPages` only answers null when a page body is null, which the
  // fetcher above cannot produce (a non-OK response throws instead).
  return sites ?? [];
}
