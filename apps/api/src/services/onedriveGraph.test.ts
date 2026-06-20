import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./m365DirectGraph', () => ({
  getToken: vi.fn(async () => ({ token: 'tok' })),
  graphFetch: vi.fn(),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { getToken, graphFetch } from './m365DirectGraph';
import { captureException } from './sentry';
import { listSharePointLibraries, resolveUserGroupMembership } from './onedriveGraph';

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
  });

  it('rejects an empty upn before calling Graph', async () => {
    const res = await resolveUserGroupMembership('org-1', '');
    expect(res.kind).toBe('error');
    expect((graphFetch as any)).not.toHaveBeenCalled();
  });
});
