import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { deploymentInvites } from '../db/schema/deploymentInvites';
import { registerFleetStatusTools } from './aiToolsFleetStatus';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerFleetStatusTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(
  allowedSiteIds?: string[],
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: 'p1', orgId: null, scope: 'partner',
    accessibleOrgIds: null, orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    ...overrides,
  };
}

// The invites query is now `.from(...).leftJoin(...).where(...)`; the device
// query (call 2) is `.from(...).where(...)` and only fires when an enrolled
// invite has a deviceId.
function mockSelects(inviteRows: Array<Record<string, unknown>>, deviceRows: Array<Record<string, unknown>> = []) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    if (call === 1) {
      return { from: () => ({ leftJoin: () => ({ where: () => Promise.resolve(inviteRows) }) }) };
    }
    return { from: () => ({ where: () => Promise.resolve(deviceRows) }) };
  });
}

describe('get_fleet_status — site narrowing of enrolled devices', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes enrolled devices in forbidden sites for a site-restricted caller', async () => {
    // Invite is on a key in an allowed site so it survives the invite-level
    // filter, but its enrolled device is in a forbidden site → dropped.
    mockSelects(
      [{ id: 'i1', email: 'a@b.c', status: 'enrolled', clickedAt: new Date(), enrolledAt: new Date(), deviceId: 'd1', keySiteId: 'site-A' }],
      [{ id: 'd1', hostname: 'h', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-B' }],
    );
    const r = await handlerFor('get_fleet_status')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.invite_funnel.devices_online).toBe(0);
    expect(parsed.invite_funnel.recent_enrollments.every((e: any) => e.hostname === 'unknown' || e.hostname === undefined)).toBe(true);
  });

  it('unrestricted caller sees all enrolled devices (no regression)', async () => {
    mockSelects(
      [{ id: 'i1', email: 'a@b.c', status: 'enrolled', clickedAt: new Date(), enrolledAt: new Date(), deviceId: 'd1', keySiteId: 'site-B' }],
      [{ id: 'd1', hostname: 'h', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-B' }],
    );
    const r = await handlerFor('get_fleet_status')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.invite_funnel.devices_online).toBe(1);
  });
});

describe('get_fleet_status — SR5-18 invite-total narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes invite totals/clicks whose enrollment key is outside the caller site allowlist', async () => {
    mockSelects([
      { id: 'i1', email: 'in@x.c', status: 'clicked', clickedAt: new Date(), enrolledAt: null, deviceId: null, keySiteId: 'site-A' },
      { id: 'i2', email: 'out@x.c', status: 'clicked', clickedAt: new Date(), enrolledAt: null, deviceId: null, keySiteId: 'site-B' },
      { id: 'i3', email: 'orgwide@x.c', status: 'clicked', clickedAt: new Date(), enrolledAt: null, deviceId: null, keySiteId: null },
    ]);
    const r = await handlerFor('get_fleet_status')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    // Only the site-A invite is visible; site-B and the org-wide (null-site) key are excluded (fail closed).
    expect(parsed.invite_funnel.total_invited).toBe(1);
    expect(parsed.invite_funnel.invites_clicked).toBe(1);
  });

  it('unrestricted caller sees partner-wide invite totals (no regression)', async () => {
    mockSelects([
      { id: 'i1', email: 'in@x.c', status: 'clicked', clickedAt: new Date(), enrolledAt: null, deviceId: null, keySiteId: 'site-A' },
      { id: 'i2', email: 'out@x.c', status: 'clicked', clickedAt: new Date(), enrolledAt: null, deviceId: null, keySiteId: 'site-B' },
      { id: 'i3', email: 'orgwide@x.c', status: 'sent', clickedAt: null, enrolledAt: null, deviceId: null, keySiteId: null },
    ]);
    const r = await handlerFor('get_fleet_status')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.invite_funnel.total_invited).toBe(3);
    expect(parsed.invite_funnel.invites_clicked).toBe(2);
  });

  it('narrows the invite query to the caller org (org-scoped caller not shown partner-wide totals)', async () => {
    // MCP-OAUTH-06 superseded the SR5-18 `auth.orgCondition` mechanism here:
    // computeInviteFunnel now selects the axis explicitly from auth.scope, so
    // an org-scoped caller filters deployment_invites by their OWN org id
    // (strictly narrower than the partner-wide condition SR5-18 guarded
    // against). Assert the WHERE predicate directly.
    let capturedWhere: unknown;
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        leftJoin: () => ({
          where: (predicate: unknown) => {
            capturedWhere = predicate;
            return Promise.resolve([]);
          },
        }),
      }),
    }));
    const auth = makeAuth(undefined, { scope: 'organization', orgId: 'org-1' });
    await handlerFor('get_fleet_status')({}, auth);
    // The invite query narrows by the actor's org axis, not partner-wide only.
    expect(capturedWhere).toEqual(eq(deploymentInvites.orgId, 'org-1'));
  });
});
