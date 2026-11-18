import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ permissions: null as any }));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../services/permissions', async () => ({
  ...(await vi.importActual<object>('../services/permissions')),
  getUserPermissions: vi.fn(async () => m.permissions),
}));

import { resolveCallerPermissions, resolveCallerSiteScope } from './sitePermissionScope';
import { TopologyError } from '../services/topology/access';

function ctx(auth: any, permissions?: any) {
  return { get: (k: string) => (k === 'auth' ? auth : k === 'permissions' ? permissions : undefined) } as any;
}
const auth = (allowedSiteIds?: string[]) => ({ user: { id: 'u' }, scope: 'organization', orgId: 'o', partnerId: null, allowedSiteIds });

beforeEach(() => { m.permissions = { allowedSiteIds: undefined }; });

describe('resolveCallerPermissions', () => {
  it('prefers the permissions already on the context', async () => {
    const p = { allowedSiteIds: undefined };
    expect(await resolveCallerPermissions(ctx(auth(), p))).toBe(p);
  });
  it('falls back to a live lookup and fails closed with a TopologyError when none exist', async () => {
    m.permissions = null;
    await expect(resolveCallerPermissions(ctx(auth()))).rejects.toBeInstanceOf(TopologyError);
  });
});

describe('resolveCallerSiteScope', () => {
  it('is unrestricted when neither ceiling is set', async () => {
    expect(await resolveCallerSiteScope(ctx(auth()))).toEqual({ allowedSiteIds: null });
  });
  it('uses a single ceiling as is', async () => {
    expect(await resolveCallerSiteScope(ctx(auth(['a']), { allowedSiteIds: undefined }))).toEqual({ allowedSiteIds: ['a'] });
    expect(await resolveCallerSiteScope(ctx(auth(), { allowedSiteIds: ['b'] }))).toEqual({ allowedSiteIds: ['b'] });
  });
  it('intersects token ceiling and permission allowlist', async () => {
    expect(await resolveCallerSiteScope(ctx(auth(['a', 'b']), { allowedSiteIds: ['b', 'c'] }))).toEqual({ allowedSiteIds: ['b'] });
  });
  it('fails closed on a malformed allowlist', async () => {
    expect(await resolveCallerSiteScope(ctx(auth(), { allowedSiteIds: 'oops' as any }))).toEqual({ allowedSiteIds: [] });
  });
});
