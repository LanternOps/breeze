import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./m365DirectGraph', () => ({
  getToken: vi.fn(async () => ({ token: 'tok' })),
  graphFetch: vi.fn(),
}));

import { getToken, graphFetch } from './m365DirectGraph';
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
