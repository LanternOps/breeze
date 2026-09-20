import { fetchWithAuth, type FetchWithAuthOptions } from '../stores/auth';
import { fetchAllPages, LIST_MAX_PAGES, LIST_PAGE_SIZE } from './fetchAllPages';

export const ORGANIZATIONS_PAGE_SIZE = LIST_PAGE_SIZE;
export const ORGANIZATIONS_MAX_PAGES = LIST_MAX_PAGES;

/**
 * Walks every page of `GET /orgs/organizations` (#3446). Thin wrapper over the
 * shared {@link fetchAllPages} walker (#6412) — kept as a named export because
 * the org switcher store and the board page both call it, and because
 * `organizations` is this route's legacy envelope key.
 */
export async function fetchAllOrganizations<T = unknown>(
  fetchPage: (page: number, limit: number) => Promise<unknown>,
): Promise<T[] | null> {
  return fetchAllPages<T>(fetchPage, { aliasKeys: ['organizations'] });
}

/**
 * Convenience wrapper for the many org pickers that just want "every org I can
 * see" (#6412). `path` is the route plus any filters, WITHOUT `page`/`limit`.
 * Throws on a non-OK response so callers keep their existing error branch.
 */
export async function fetchAllOrganizationsFrom<T = any>(
  path: string,
  init?: FetchWithAuthOptions,
): Promise<T[]> {
  const separator = path.includes('?') ? '&' : '?';
  const orgs = await fetchAllOrganizations<T>(async (page, limit) => {
    const response = await fetchWithAuth(`${path}${separator}page=${page}&limit=${limit}`, init);
    if (!response.ok) {
      throw new Error(`Failed to fetch organizations (status ${response.status})`);
    }
    return response.json();
  });
  // Only a null page body yields null, which the fetcher above cannot produce.
  return orgs ?? [];
}
