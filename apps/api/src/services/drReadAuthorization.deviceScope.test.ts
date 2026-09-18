/**
 * #6096 finding 13 — the DR read boundary (`readableKeys`) only ever
 * intersected the SITE axis. `ai_agent` IS a site-restricted principal kind
 * (resilienceSiteAuthorization.ts), so it is not deny-all — which means a
 * device-bound run at site-1 could read every DR plan/execution naming any
 * other device at site-1, and a device-LESS analysis run (allowedDeviceIds set,
 * allowedSiteIds undefined) sailed straight through the `sites === null`
 * unrestricted path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

import { db } from '../db';
import {
  drGroupsReadable,
  filterReadableDrExecutions,
  filterReadableDrPlans,
} from './drReadAuthorization';
import { isSiteRestrictedPrincipalKind } from './resilienceSiteAuthorization';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function auth(allowedDeviceIds?: string[], allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'ai_agent' },
    user: { id: 'u1' },
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

/** groups read = select({planId,devices}); device read = select({id,siteId}) */
function mockReads(groups: Array<{ planId: string; devices: string[] }>, deviceRows: Array<{ id: string; siteId: string | null }>) {
  mockDb.select.mockImplementation((cols?: any) => {
    if (cols && 'planId' in cols) return { from: () => ({ where: () => Promise.resolve(groups) }) };
    if (cols && 'id' in cols && 'siteId' in cols) return { from: () => ({ where: () => Promise.resolve(deviceRows) }) };
    throw new Error(`unexpected select ${JSON.stringify(cols && Object.keys(cols))}`);
  });
}

describe('DR read boundary — exact-device axis', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ai_agent is a site-restricted principal kind (so this boundary is NOT already deny-all)', () => {
    expect(isSiteRestrictedPrincipalKind('ai_agent')).toBe(true);
  });

  it('hides a plan naming a sibling device at the SAME site', async () => {
    mockReads(
      [{ planId: 'plan-1', devices: ['dev-2'] }],
      [{ id: 'dev-2', siteId: 'site-1' }],
    );
    const rows = await filterReadableDrPlans([{ id: 'plan-1' }], auth(['dev-1'], ['site-1']), 'org-1');
    expect(rows).toEqual([]);
  });

  it('hides a plan from a device-LESS run (allowedDeviceIds set, allowedSiteIds undefined)', async () => {
    mockReads(
      [{ planId: 'plan-1', devices: ['dev-2'] }],
      [{ id: 'dev-2', siteId: 'site-1' }],
    );
    const rows = await filterReadableDrPlans([{ id: 'plan-1' }], auth(['dev-1'], undefined), 'org-1');
    expect(rows).toEqual([]);
  });

  it('still shows a plan containing only the run\'s OWN device', async () => {
    mockReads(
      [{ planId: 'plan-1', devices: ['dev-1'] }],
      [{ id: 'dev-1', siteId: 'site-1' }],
    );
    const rows = await filterReadableDrPlans([{ id: 'plan-1' }], auth(['dev-1'], ['site-1']), 'org-1');
    expect(rows).toEqual([{ id: 'plan-1' }]);
  });

  it('leaves an unrestricted caller untouched', async () => {
    mockReads([], []);
    const rows = await filterReadableDrPlans([{ id: 'plan-1' }], auth(undefined, undefined), 'org-1');
    expect(rows).toEqual([{ id: 'plan-1' }]);
  });

  it('drGroupsReadable denies groups holding a sibling device', async () => {
    mockReads([], [{ id: 'dev-2', siteId: 'site-1' }]);
    expect(await drGroupsReadable([{ planId: 'plan-1', devices: ['dev-2'] }], auth(['dev-1'], ['site-1']), 'org-1')).toBe(false);
    expect(await drGroupsReadable([{ planId: 'plan-1', devices: ['dev-1'] }], auth(['dev-1'], ['site-1']), 'org-1')).toBe(true);
  });

  it('hides an execution whose historical results name a sibling device', async () => {
    mockReads([{ planId: 'plan-1', devices: [] }], [{ id: 'dev-2', siteId: 'site-1' }]);
    const results = {
      groupResults: [{ devices: [{ deviceId: 'dev-2' }] }],
      queuedCommands: [],
      failedDispatches: [],
      plannedGroups: [],
    };
    const rows = await filterReadableDrExecutions([{ planId: 'plan-1', results }], auth(['dev-1'], ['site-1']), 'org-1');
    expect(rows).toEqual([]);
  });

  it('hides an execution from a device-less run too', async () => {
    mockReads([{ planId: 'plan-1', devices: [] }], [{ id: 'dev-2', siteId: 'site-1' }]);
    const results = {
      groupResults: [{ devices: [{ deviceId: 'dev-2' }] }],
      queuedCommands: [],
      failedDispatches: [],
      plannedGroups: [],
    };
    const rows = await filterReadableDrExecutions([{ planId: 'plan-1', results }], auth(['dev-1'], undefined), 'org-1');
    expect(rows).toEqual([]);
  });
});
