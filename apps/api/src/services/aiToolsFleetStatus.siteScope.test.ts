import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { db } from '../db';
import { registerFleetStatusTools } from './aiToolsFleetStatus';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerFleetStatusTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: 'p1', orgId: null, scope: 'partner',
    accessibleOrgIds: null, orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  };
}

// invites select first, then device rows (which now include siteId).
function invitesThenDevices(deviceRows: Array<Record<string, unknown>>) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    if (call === 1) return { from: () => ({ where: () => Promise.resolve([
      { id: 'i1', email: 'a@b.c', status: 'enrolled', clickedAt: new Date(), enrolledAt: new Date(), deviceId: 'd1' },
    ]) }) };
    return { from: () => ({ where: () => Promise.resolve(deviceRows) }) };
  });
}

describe('get_fleet_status — site narrowing of enrolled devices', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes enrolled devices in forbidden sites for a site-restricted caller', async () => {
    invitesThenDevices([{ id: 'd1', hostname: 'h', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-B' }]);
    const r = await handlerFor('get_fleet_status')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.invite_funnel.devices_online).toBe(0);
    expect(parsed.invite_funnel.recent_enrollments.every((e: any) => e.hostname === 'unknown' || e.hostname === undefined)).toBe(true);
  });

  it('unrestricted caller sees all enrolled devices (no regression)', async () => {
    invitesThenDevices([{ id: 'd1', hostname: 'h', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-B' }]);
    const r = await handlerFor('get_fleet_status')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.invite_funnel.devices_online).toBe(1);
  });
});
