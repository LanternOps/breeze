import { describe, expect, it, vi } from 'vitest';
import {
  fetchAllOrganizations,
  ORGANIZATIONS_MAX_PAGES,
  ORGANIZATIONS_PAGE_SIZE,
} from './OrganizationsPage';

// #3446: the org list rendered only the first page (server default limit 50,
// clamped to 100), so orgs past it were invisible in the list AND in the
// client-side search.

function org(n: number) {
  return { id: `org-${n}`, name: `Org ${n}` };
}
/** A server page of `size` orgs starting at `from`. */
function page(from: number, size: number, total: number) {
  return { data: Array.from({ length: size }, (_, i) => org(from + i)), pagination: { total } };
}

describe('fetchAllOrganizations (#3446)', () => {
  it('walks every page, not just the first', async () => {
    // 250 orgs => 100 + 100 + 50
    const fetchPage = vi.fn(async (p: number) =>
      p === 1 ? page(1, 100, 250) : p === 2 ? page(101, 100, 250) : page(201, 50, 250),
    );

    const all = await fetchAllOrganizations(fetchPage);

    expect(all).toHaveLength(250);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    // the org that the bug hid — first one past the old 50-row cap
    expect((all as Array<{ id: string }>).some((o) => o.id === 'org-51')).toBe(true);
    expect((all as Array<{ id: string }>).at(-1)).toEqual(org(250));
  });

  it('requests the server ceiling so it makes the fewest round-trips', async () => {
    const fetchPage = vi.fn(async () => page(1, 10, 10));
    await fetchAllOrganizations(fetchPage);
    expect(fetchPage).toHaveBeenCalledWith(1, ORGANIZATIONS_PAGE_SIZE);
    expect(ORGANIZATIONS_PAGE_SIZE).toBe(100); // the clamp in getPagination
  });

  it('stops on a short page even when the response carries no pagination block', async () => {
    // legacy/unpaginated shape: a bare array
    const fetchPage = vi.fn(async () => [org(1), org(2)]);
    const all = await fetchAllOrganizations(fetchPage);
    expect(all).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('accepts the {organizations:[...]} shape', async () => {
    const fetchPage = vi.fn(async () => ({ organizations: [org(1)] }));
    expect(await fetchAllOrganizations(fetchPage)).toHaveLength(1);
  });

  it('does not spin forever when the server keeps returning full pages', async () => {
    // a `total` that never arrives (or is wrong) must not loop unbounded
    const fetchPage = vi.fn(async (p: number) => page((p - 1) * 100 + 1, 100, 10_000_000));
    const all = await fetchAllOrganizations(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(ORGANIZATIONS_MAX_PAGES);
    expect(all).toHaveLength(ORGANIZATIONS_MAX_PAGES * 100);
  });

  it('propagates null so the caller can abort (401 redirect)', async () => {
    const fetchPage = vi.fn(async () => null);
    expect(await fetchAllOrganizations(fetchPage)).toBeNull();
  });

  it('lets a thrown fetch error escape rather than silently truncating the list', async () => {
    const fetchPage = vi.fn(async (p: number) => {
      if (p === 2) throw new Error('boom');
      return page(1, 100, 250);
    });
    await expect(fetchAllOrganizations(fetchPage)).rejects.toThrow('boom');
  });
});
