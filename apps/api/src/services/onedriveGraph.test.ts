import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./m365DirectGraph', () => ({
  getToken: vi.fn(async () => ({ token: 'tok' })),
  graphFetch: vi.fn(),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { getToken, graphFetch } from './m365DirectGraph';
import { captureException } from './sentry';
import {
  clearGroupMembershipCache,
  GROUP_MEMBERSHIP_CACHE_TTL_MS,
  listSharePointLibraries,
  resolveUserGroupMembership,
  resolveUserGroupMembershipCached,
  buildTenantAutoMountValue,
} from './onedriveGraph';

describe('listSharePointLibraries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns flattened site+library list', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'host,scid,webid', displayName: 'Marketing', webUrl: 'https://c.sharepoint.com/sites/mktg' },
      ] } }) // /sites?search=*
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'drive-1', name: 'Documents', list: { id: 'list-1' } },
      ] } }); // /sites/{id}/drives

    const res = await listSharePointLibraries('org-1');
    expect(res.kind).toBe('ok');
    expect((res as any).data.libraries[0]).toMatchObject({
      siteName: 'Marketing', driveId: 'drive-1', listId: 'list-1', libraryName: 'Documents',
    });

    // Composite site IDs contain literal commas (hostname,scGuid,webGuid); Graph does not accept %2C
    const drivesPath = (graphFetch as any).mock.calls[1][2] as string;
    expect(drivesPath).toContain('/sites/host,scid,webid/drives');
    expect(drivesPath).not.toContain('%2C');
  });

  it('propagates a token error', async () => {
    (getToken as any).mockResolvedValueOnce({ kind: 'error', code: 'no_connection', message: 'x' });
    const res = await listSharePointLibraries('org-1');
    expect(res.kind).toBe('error');
  });

  it('skips an unreadable site (5xx/throttle) but still returns readable sites and records the skip', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'siteA', displayName: 'A', webUrl: 'https://c/a' },
        { id: 'siteB', displayName: 'B', webUrl: 'https://c/b' },
      ] } }) // /sites
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'drA', name: 'Docs', list: { id: 'lA' } },
      ] } }) // siteA /drives
      .mockResolvedValueOnce({ kind: 'error', code: 'graph_unavailable', message: 'boom' }); // siteB /drives

    const res = await listSharePointLibraries('org-1');
    expect(res.kind).toBe('ok');
    expect((res as any).data.libraries).toHaveLength(1);
    expect((res as any).data.libraries[0].driveId).toBe('drA');
    expect((res as any).data.skippedSites).toEqual([{ siteId: 'siteB', code: 'graph_unavailable' }]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('skips a forbidden (403) site quietly — not recorded, not alerted', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'siteA', displayName: 'A', webUrl: 'https://c/a' },
        { id: 'siteB', displayName: 'B', webUrl: 'https://c/b' },
      ] } }) // /sites
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'drA', name: 'Docs', list: { id: 'lA' } },
      ] } }) // siteA /drives
      .mockResolvedValueOnce({ kind: 'error', code: 'forbidden', message: 'no access' }); // siteB /drives

    const res = await listSharePointLibraries('org-1');
    expect(res.kind).toBe('ok');
    expect((res as any).data.libraries).toHaveLength(1);
    expect((res as any).data.skippedSites).toEqual([]);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('drops a malformed drive row with no string id rather than emitting an empty driveId', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'siteA', displayName: 'A', webUrl: 'https://c/a' },
      ] } }) // /sites
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'drA', name: 'Docs', list: { id: 'lA' } },
        { name: 'Broken', list: { id: 'lB' } }, // no id — must be dropped
      ] } }); // siteA /drives

    const res = await listSharePointLibraries('org-1');
    expect(res.kind).toBe('ok');
    expect((res as any).data.libraries).toHaveLength(1);
    expect((res as any).data.libraries[0].driveId).toBe('drA');
  });
});

describe('buildTenantAutoMountValue', () => {
  it('matches the known-good real-world composite shape', () => {
    const val = buildTenantAutoMountValue({
      tenantId: '02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c',
      siteId: '87a9f4b2-757b-4663-b19e-d58398f0f1e4',
      webId: 'd1135130-a5e3-41d2-a8f1-a547508eaf04',
      listId: '265BA069-9F1C-4065-83AC-B7C7A0CE4C28',
      siteUrl: 'https://wvdcloud901026.sharepoint.com/sites/Office_Templates',
    });
    expect(val).toBe(
      'tenantId=02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c'
      + '&siteId={87a9f4b2-757b-4663-b19e-d58398f0f1e4}'
      + '&webId={d1135130-a5e3-41d2-a8f1-a547508eaf04}'
      + '&listId={265BA069-9F1C-4065-83AC-B7C7A0CE4C28}'
      + '&webUrl=https%3A%2F%2Fwvdcloud901026.sharepoint.com%2Fsites%2FOffice%5FTemplates'
      + '&version=1'
    );
  });

  it('strips pre-braced GUIDs before re-bracing', () => {
    const val = buildTenantAutoMountValue({
      tenantId: 't', siteId: '{s}', webId: '{w}', listId: '{l}', siteUrl: 'https://x',
    });
    expect(val).toContain('siteId={s}');
    expect(val).not.toContain('{{');
  });
});

describe('listSharePointLibraries sharePointIds expansion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns sharePointIds-derived fields + a prebuilt autoMountValue', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'host,scid,webid', displayName: 'Marketing', webUrl: 'https://c.sharepoint.com/sites/mktg' },
      ] } })
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        {
          id: 'drive-1', name: 'Documents',
          list: {
            id: 'list-1',
            sharePointIds: {
              tenantId: 'tid', siteId: 'sid-guid', webId: 'wid-guid', listId: 'list-1',
              siteUrl: 'https://c.sharepoint.com/sites/mktg',
            },
          },
        },
      ] } });

    const res = await listSharePointLibraries('org-1');
    expect(res.kind).toBe('ok');
    const lib = (res as any).data.libraries[0];
    expect(lib).toMatchObject({
      siteName: 'Marketing', driveId: 'drive-1', listId: 'list-1',
      tenantId: 'tid', webId: 'wid-guid', spSiteId: 'sid-guid',
    });
    expect(lib.autoMountValue).toContain('tenantId=tid');
    expect(lib.autoMountValue).toContain('siteId={sid-guid}');
    // the drives call must request the expansion
    const drivesPath = (graphFetch as any).mock.calls[1][2] as string;
    expect(drivesPath).toContain('$expand=list(');
    expect(drivesPath).toContain('sharePointIds');
  });

  it('returns an empty autoMountValue when sharePointIds is missing', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'host,scid,webid', displayName: 'M', webUrl: 'https://c.sharepoint.com/sites/m' },
      ] } })
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'drive-1', name: 'Documents', list: { id: 'list-1' } },
      ] } });
    const res = await listSharePointLibraries('org-1');
    const lib = (res as any).data.libraries[0];
    expect(lib.autoMountValue).toBe('');
    expect(lib.tenantId).toBe('');
  });
});

describe('resolveUserGroupMembership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns transitive group ids for the user', async () => {
    (graphFetch as any).mockResolvedValueOnce({ kind: 'ok', data: { value: [
      { id: 'g-1' }, { id: 'g-2' },
    ] } });
    const res = await resolveUserGroupMembership('org-1', "user@contoso.com");
    expect((res as any).data.groupIds).toEqual(['g-1', 'g-2']);
    // verify the upn was encodeURIComponent-encoded into the path segment
    const calledPath = (graphFetch as any).mock.calls[0][2] as string;
    expect(calledPath).toContain('/users/');
    expect(calledPath).toContain('transitiveMemberOf');
    // The OData group cast is an advanced query: Graph 400s without
    // ConsistencyLevel: eventual + $count=true.
    expect(calledPath).toContain('$count=true');
    expect((graphFetch as any).mock.calls[0][4]).toEqual({ headers: { ConsistencyLevel: 'eventual' } });
  });

  it('a 2xx with no value array is an error, not an empty membership', async () => {
    (graphFetch as any).mockResolvedValueOnce({ kind: 'ok', data: null });
    const res = await resolveUserGroupMembership('org-1', 'u@contoso.com');
    expect(res.kind).toBe('error');
    expect((res as any).code).toBe('graph_malformed_response');
  });

  it('rejects an empty upn before calling Graph', async () => {
    const res = await resolveUserGroupMembership('org-1', '');
    expect(res.kind).toBe('error');
    expect((graphFetch as any)).not.toHaveBeenCalled();
  });

  it('follows @odata.nextLink and unions the pages', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: {
        value: [{ id: 'g-1' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/u/transitiveMemberOf?$skiptoken=abc',
      } })
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-2' }] } });
    const res = await resolveUserGroupMembership('org-1', 'u@contoso.com');
    expect((res as any).data.groupIds).toEqual(['g-1', 'g-2']);
    expect(graphFetch).toHaveBeenCalledTimes(2);
    // page 2 must be requested via the absolute nextLink verbatim
    expect((graphFetch as any).mock.calls[1][2]).toContain('$skiptoken=abc');
  });

  it('never returns a truncated set as ok — past the page bound it errors', async () => {
    (graphFetch as any).mockResolvedValue({ kind: 'ok', data: {
      value: [{ id: 'g-n' }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users/u/transitiveMemberOf?$skiptoken=more',
    } });
    const res = await resolveUserGroupMembership('org-1', 'u@contoso.com');
    expect(res.kind).toBe('error');
    expect((res as any).code).toBe('too_many_groups');
    expect(graphFetch).toHaveBeenCalledTimes(5); // GROUP_MEMBERSHIP_MAX_PAGES
  });

  it('a mid-pagination Graph error propagates (not a partial ok)', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: {
        value: [{ id: 'g-1' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
      } })
      .mockResolvedValueOnce({ kind: 'error', code: 'graph_unreachable', message: 'x' });
    const res = await resolveUserGroupMembership('org-1', 'u@contoso.com');
    expect(res.kind).toBe('error');
    expect((res as any).code).toBe('graph_unreachable');
  });
});

describe('resolveUserGroupMembershipCached', () => {
  beforeEach(() => { vi.clearAllMocks(); clearGroupMembershipCache(); });

  it('second call within TTL hits the cache (no second Graph call)', async () => {
    (graphFetch as any).mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-1' }] } });
    const a = await resolveUserGroupMembershipCached('org-1', 'User@Contoso.com');
    const b = await resolveUserGroupMembershipCached('org-1', 'user@contoso.com'); // case-insensitive key
    expect((a as any).data.groupIds).toEqual(['g-1']);
    expect(b).toEqual(a);
    expect(graphFetch).toHaveBeenCalledTimes(1);
  });

  it('errors are not cached (next call retries)', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'error', code: 'throttled', message: 'x' })
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-2' }] } });
    const a = await resolveUserGroupMembershipCached('org-1', 'u@contoso.com');
    expect(a.kind).toBe('error');
    const b = await resolveUserGroupMembershipCached('org-1', 'u@contoso.com');
    expect((b as any).data.groupIds).toEqual(['g-2']);
    expect(graphFetch).toHaveBeenCalledTimes(2);
  });

  it('expired entries refetch — a revoked membership cannot outlive the TTL', async () => {
    vi.useFakeTimers();
    try {
      (graphFetch as any)
        .mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-1' }] } })
        .mockResolvedValueOnce({ kind: 'ok', data: { value: [] } }); // user removed from the group
      await resolveUserGroupMembershipCached('org-1', 'u@contoso.com');
      vi.advanceTimersByTime(GROUP_MEMBERSHIP_CACHE_TTL_MS + 1);
      const b = await resolveUserGroupMembershipCached('org-1', 'u@contoso.com');
      expect((b as any).data.groupIds).toEqual([]);
      expect(graphFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinct orgs do not share cache entries', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-1' }] } })
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [{ id: 'g-9' }] } });
    await resolveUserGroupMembershipCached('org-1', 'u@contoso.com');
    const b = await resolveUserGroupMembershipCached('org-2', 'u@contoso.com');
    expect((b as any).data.groupIds).toEqual(['g-9']);
    expect(graphFetch).toHaveBeenCalledTimes(2);
  });
});
