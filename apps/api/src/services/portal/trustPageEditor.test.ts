import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each db.select() takes the next queued result; every chain method returns the
// chain and the chain is awaitable, so `.limit()` and a bare `.where()` both resolve.
const state = vi.hoisted(() => ({ results: [] as unknown[][], selects: 0 }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      state.selects += 1;
      const result = state.results.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'leftJoin', 'innerJoin', 'where', 'limit']) chain[m] = vi.fn(() => chain);
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
      return chain;
    }),
  },
}));

import { decidePortalTrustPageEditor, isPortalTrustPageEditor } from './trustPageEditor';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const USER = { id: 'pu-1', orgId: ORG };
const userRow = (over: Record<string, unknown> = {}) => ({ flag: true, status: 'active', contactId: 'contact-1', ...over });
const orgAdmin = { orgId: ORG, siteId: null, deviceGroupId: null };

describe('isPortalTrustPageEditor (Trust Center W3d gate)', () => {
  beforeEach(() => { state.results = []; state.selects = 0; });

  it('flag off → false (PORTAL_TRUST_EDITING_DISABLED)', async () => {
    state.results = [[userRow({ flag: false })], [orgAdmin]];
    expect(await decidePortalTrustPageEditor(USER)).toEqual({ allowed: false, code: 'PORTAL_TRUST_EDITING_DISABLED' });
    // The role lookup is skipped: the flag alone decides.
    expect(state.selects).toBe(1);
  });

  it('missing portal_branding row (flag null) → false, fail closed', async () => {
    state.results = [[userRow({ flag: null })], [orgAdmin]];
    expect(await isPortalTrustPageEditor(USER)).toBe(false);
  });

  it('contactId null → false (PORTAL_TRUST_EDITOR_REQUIRED)', async () => {
    state.results = [[userRow({ contactId: null })], [orgAdmin]];
    expect(await decidePortalTrustPageEditor(USER)).toEqual({ allowed: false, code: 'PORTAL_TRUST_EDITOR_REQUIRED' });
  });

  it('admin role scoped to a site → false', async () => {
    state.results = [[userRow()], [{ orgId: ORG, siteId: 'site-1', deviceGroupId: null }]];
    expect(await isPortalTrustPageEditor(USER)).toBe(false);
  });

  it('admin role scoped to a device group → false', async () => {
    state.results = [[userRow()], [{ orgId: ORG, siteId: null, deviceGroupId: 'dg-1' }]];
    expect(await isPortalTrustPageEditor(USER)).toBe(false);
  });

  it('admin role for another org → false', async () => {
    state.results = [[userRow()], [{ orgId: OTHER_ORG, siteId: null, deviceGroupId: null }]];
    expect(await isPortalTrustPageEditor(USER)).toBe(false);
  });

  it('no admin role at all → false (PORTAL_TRUST_EDITOR_REQUIRED)', async () => {
    state.results = [[userRow()], []];
    expect(await decidePortalTrustPageEditor(USER)).toEqual({ allowed: false, code: 'PORTAL_TRUST_EDITOR_REQUIRED' });
  });

  it('org-scoped admin + flag on → true', async () => {
    state.results = [[userRow()], [{ orgId: ORG, siteId: 'site-1', deviceGroupId: null }, orgAdmin]];
    expect(await decidePortalTrustPageEditor(USER)).toEqual({ allowed: true, contactId: 'contact-1' });
  });

  it('portal user status disabled → false', async () => {
    state.results = [[userRow({ status: 'disabled' })], [orgAdmin]];
    expect(await isPortalTrustPageEditor(USER)).toBe(false);
  });

  it('portal user row missing → false', async () => {
    state.results = [[], [orgAdmin]];
    expect(await isPortalTrustPageEditor(USER)).toBe(false);
  });

  it('the lookup runs every call (no memo)', async () => {
    state.results = [[userRow()], [orgAdmin], [userRow({ flag: false })]];
    expect(await isPortalTrustPageEditor(USER)).toBe(true);
    expect(await isPortalTrustPageEditor(USER)).toBe(false);
    expect(state.selects).toBe(3);
  });
});
