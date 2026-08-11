export const ORGANIZATIONS_PAGE_SIZE = 100; // the server's hard ceiling — fewest round-trips
export const ORGANIZATIONS_MAX_PAGES = 100; // 10k orgs; a stop so a bad `total` cannot spin

/**
 * Walks every page of `GET /orgs/organizations` (#3446). The server clamps
 * `limit` to 100, so any single request silently truncates past 100 orgs —
 * every reader that wants "all organizations" must page. Lives in lib/ because
 * the org switcher store needs it too and a store cannot import from a page
 * component without a cycle (OrganizationsPage imports the store).
 */
export async function fetchAllOrganizations<T = unknown>(
  fetchPage: (page: number, limit: number) => Promise<unknown>,
): Promise<T[] | null> {
  const all: T[] = [];

  for (let page = 1; page <= ORGANIZATIONS_MAX_PAGES; page += 1) {
    const data = (await fetchPage(page, ORGANIZATIONS_PAGE_SIZE)) as
      | { data?: unknown; organizations?: unknown; pagination?: { total?: unknown } }
      | unknown[]
      | null;
    if (data === null) return null;

    const body = data as { data?: unknown; organizations?: unknown; pagination?: { total?: unknown } };
    const batch: T[] = Array.isArray(body?.data)
      ? (body.data as T[])
      : Array.isArray(body?.organizations)
        ? (body.organizations as T[])
        : Array.isArray(data)
          ? (data as T[])
          : [];
    all.push(...batch);

    // Stop on a short page rather than trusting `total` alone: a legacy or
    // unpaginated response is a bare array with no pagination block and must
    // still terminate.
    const total = typeof body?.pagination?.total === 'number' ? body.pagination.total : undefined;
    if (batch.length < ORGANIZATIONS_PAGE_SIZE) break;
    if (total !== undefined && all.length >= total) break;
  }

  return all;
}
