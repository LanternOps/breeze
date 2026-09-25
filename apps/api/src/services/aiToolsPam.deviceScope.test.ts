/**
 * #6096 finding 4 — `revoke_elevation` gated on
 * `auth.canAccessSite && existing.siteId && !canAccessSite(siteId)`, so:
 *  - a grant with a NULL site skipped the check entirely, and
 *  - the exact-device allowlist was never consulted at all, letting a
 *    device-bound run revoke a sibling device's elevation at the same site
 *    (and a device-less analysis run revoke anything in the org).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./pamRuleEngine', () => ({ evaluatePamRules: vi.fn() }));

import { db } from '../db';
import { registerPamTools } from './aiToolsPam';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { transaction: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerPamTools(reg);
  return reg.get(name)!.handler;
}

function auth(allowedDeviceIds?: string[], allowedSiteIds?: string[]): AuthContext {
  return {
    // #6911: revoke_elevation now refuses any ai_agent-principal caller
    // outright (no approver to substitute at Tier 2). These tests exercise
    // exact-device/site scoping for a real user session, not that refusal.
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

let updateRan = false;

function mockTransaction(existing: Record<string, unknown> | undefined) {
  updateRan = false;
  mockDb.transaction.mockImplementation(async (fn: any) =>
    fn({
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(existing ? [existing] : []) }) }) }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => {
              updateRan = true;
              return Promise.resolve([{ id: 'er-1' }]);
            },
          }),
        }),
      }),
      insert: () => ({ values: () => Promise.resolve(undefined) }),
    }),
  );
}

const SIBLING = { id: 'er-1', orgId: 'org-1', siteId: 'site-1', deviceId: 'dev-2', flowType: 'os', status: 'approved' };
const OWN = { ...SIBLING, deviceId: 'dev-1' };
const NULL_SITE = { ...SIBLING, siteId: null };

describe('revoke_elevation — exact-device scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a sibling device\'s grant at the same site', async () => {
    mockTransaction(SIBLING);
    const out = JSON.parse(await handlerFor('revoke_elevation')({ elevationRequestId: 'er-1', reason: 'r' }, auth(['dev-1'], ['site-1'])));
    expect(out.error).toContain('not found');
    expect(updateRan).toBe(false);
  });

  it('refuses a NULL-site grant for a device-bound caller whose device is not the target', async () => {
    mockTransaction({ ...NULL_SITE, deviceId: 'dev-2' });
    const out = JSON.parse(await handlerFor('revoke_elevation')({ elevationRequestId: 'er-1', reason: 'r' }, auth(['dev-1'], ['site-1'])));
    expect(out.error).toContain('not found');
    expect(updateRan).toBe(false);
  });

  it('refuses for a device-LESS analysis run (allowedDeviceIds, no allowedSiteIds)', async () => {
    mockTransaction(SIBLING);
    const out = JSON.parse(await handlerFor('revoke_elevation')({ elevationRequestId: 'er-1', reason: 'r' }, auth(['dev-1'], undefined)));
    expect(out.error).toContain('not found');
    expect(updateRan).toBe(false);
  });

  it('still revokes the run\'s OWN device grant', async () => {
    mockTransaction(OWN);
    const out = JSON.parse(await handlerFor('revoke_elevation')({ elevationRequestId: 'er-1', reason: 'r' }, auth(['dev-1'], ['site-1'])));
    expect(out.status).toBe('revoked');
    expect(updateRan).toBe(true);
  });

  it('unrestricted caller is unchanged', async () => {
    mockTransaction(SIBLING);
    const out = JSON.parse(await handlerFor('revoke_elevation')({ elevationRequestId: 'er-1', reason: 'r' }, auth(undefined, undefined)));
    expect(out.status).toBe('revoked');
  });
});
