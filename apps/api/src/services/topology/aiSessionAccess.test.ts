import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ permissions: vi.fn() }));
vi.mock('../permissions', async (original) => ({ ...await original<object>(), getUserPermissions: mocks.permissions }));

import { resolveTopologySessionVisibility } from './aiSessionAccess';

const A = '20000000-0000-4000-8000-00000000000a';
const B = '20000000-0000-4000-8000-00000000000b';
const READ = [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }];
const auth = (allowedSiteIds?: string[]) => ({ user: { id: 'u' }, scope: 'organization', orgId: 'o', partnerId: null, allowedSiteIds }) as never;

beforeEach(() => vi.clearAllMocks());

describe('topology session visibility (M4-D2)', () => {
  it('shows every pinned session to an unrestricted topology reader', async () => {
    mocks.permissions.mockResolvedValue({ permissions: READ });
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'all' });
  });

  it('hides every pinned session without topology:read AND devices:read, or without permissions', async () => {
    mocks.permissions.mockResolvedValue({ permissions: [{ resource: 'topology', action: 'read' }] });
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'none' });
    mocks.permissions.mockResolvedValue(null);
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'none' });
  });

  it('narrows to the intersection of the token and permission site ceilings', async () => {
    mocks.permissions.mockResolvedValue({ permissions: READ, allowedSiteIds: [A, B] });
    expect(await resolveTopologySessionVisibility(auth([B]))).toEqual({ kind: 'sites', siteIds: [B] });
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'sites', siteIds: [A, B] });
    mocks.permissions.mockResolvedValue({ permissions: READ });
    expect(await resolveTopologySessionVisibility(auth([A]))).toEqual({ kind: 'sites', siteIds: [A] });
    expect(await resolveTopologySessionVisibility(auth([]))).toEqual({ kind: 'none' });
  });

  it('accepts wildcard grants like the rest of the permission system', async () => {
    mocks.permissions.mockResolvedValue({ permissions: [{ resource: '*', action: '*' }] });
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'all' });
  });

  it('fails closed for pinned sessions when permissions cannot be read', async () => {
    mocks.permissions.mockRejectedValue(new Error('db down'));
    expect(await resolveTopologySessionVisibility(auth())).toEqual({ kind: 'none' });
  });
});
