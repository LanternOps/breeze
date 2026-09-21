/**
 * #6096 finding 2 — `execute_dr_plan` created (and enqueued) an execution after
 * only `loadPlanWithAccess` (org axis). A device-bound AI run could fail a whole
 * DR plan over onto devices it was never bound to. `manage_dr_plan` add_group
 * had the same hole: the SUBMITTED device ids are gated by `deviceArgs`, but the
 * plan being attached to is not.
 *
 * Finding 13 — the list reads short-circuited on the SITE ceiling alone, so a
 * device-less analysis run (`allowedDeviceIds` set, `allowedSiteIds` undefined)
 * took the unfiltered single-query path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  // aiToolsDR imports verifyDeviceAccess from the hub (W05b), which loads commandQueue.
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./drExecutionService', () => ({ createDrExecutionAndEnqueue: vi.fn() }));

import { db } from '../db';
import { createDrExecutionAndEnqueue } from './drExecutionService';
import { registerDRTools } from './aiToolsDR';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerDRTools(reg);
  return reg.get(name)!.handler;
}

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

const PLAN = { id: 'plan-1', orgId: 'org-1', name: 'Plan', status: 'active' };

/**
 * `select()` (no cols) = plan; `select({id,siteId})` = the org device scan;
 * `select({devices})` = stored plan groups; anything else = the handler's own
 * group read.
 */
function mockReads(opts: { orgDevices: Array<{ id: string; siteId: string | null }>; storedGroups: Array<{ devices: string[] }> }) {
  mockDb.select.mockImplementation((cols?: any) => {
    if (cols === undefined) {
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([PLAN]) }) }) };
    }
    if ('id' in cols && 'siteId' in cols && Object.keys(cols).length === 2) {
      return { from: () => ({ where: () => Promise.resolve(opts.orgDevices) }) };
    }
    if ('devices' in cols && Object.keys(cols).length === 1) {
      return { from: () => ({ where: () => Promise.resolve(opts.storedGroups) }) };
    }
    return { from: () => ({ where: () => ({ orderBy: () => Promise.resolve(opts.storedGroups) }) }) };
  });
  mockDb.insert.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([{ id: 'group-1' }]) }) });
}

describe('execute_dr_plan — stored-device scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createDrExecutionAndEnqueue).mockResolvedValue({ id: 'exec-1', status: 'queued' } as any);
  });

  it('refuses a plan whose stored groups reach a sibling device at the same site', async () => {
    mockReads({
      orgDevices: [{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' }],
      storedGroups: [{ devices: ['dev-2'] }],
    });
    const out = JSON.parse(await handlerFor('execute_dr_plan')({ planId: 'plan-1', executionType: 'failover' }, auth(['dev-1'], ['site-1'])));
    expect(out.error).toBeTruthy();
    expect(out.success).toBeUndefined();
    expect(createDrExecutionAndEnqueue).not.toHaveBeenCalled();
  });

  it('refuses for a device-LESS run (allowedDeviceIds set, allowedSiteIds undefined)', async () => {
    mockReads({
      orgDevices: [{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' }],
      storedGroups: [{ devices: ['dev-2'] }],
    });
    const out = JSON.parse(await handlerFor('execute_dr_plan')({ planId: 'plan-1', executionType: 'failover' }, auth(['dev-1'], undefined)));
    expect(out.error).toBeTruthy();
    expect(createDrExecutionAndEnqueue).not.toHaveBeenCalled();
  });

  it('still executes a plan that only reaches the run\'s own device', async () => {
    mockReads({
      orgDevices: [{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' }],
      storedGroups: [{ devices: ['dev-1'] }],
    });
    const out = JSON.parse(await handlerFor('execute_dr_plan')({ planId: 'plan-1', executionType: 'failover' }, auth(['dev-1'], ['site-1'])));
    expect(out.success).toBe(true);
    expect(createDrExecutionAndEnqueue).toHaveBeenCalledOnce();
  });

  it('unrestricted caller is unchanged', async () => {
    mockReads({ orgDevices: [], storedGroups: [{ devices: ['dev-2'] }] });
    const out = JSON.parse(await handlerFor('execute_dr_plan')({ planId: 'plan-1', executionType: 'failover' }, auth(undefined, undefined)));
    expect(out.success).toBe(true);
  });
});

describe('manage_dr_plan add_group — stored-device scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to attach a group to a plan already reaching a sibling device', async () => {
    mockReads({
      orgDevices: [{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' }],
      storedGroups: [{ devices: ['dev-2'] }],
    });
    const out = JSON.parse(await handlerFor('manage_dr_plan')(
      { action: 'add_group', planId: 'plan-1', name: 'g', devices: ['dev-1'] },
      auth(['dev-1'], ['site-1']),
    ));
    expect(out.error).toBeTruthy();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('attaches when the plan only reaches the run\'s own device', async () => {
    mockReads({
      orgDevices: [{ id: 'dev-1', siteId: 'site-1' }, { id: 'dev-2', siteId: 'site-1' }],
      storedGroups: [{ devices: ['dev-1'] }],
    });
    const out = JSON.parse(await handlerFor('manage_dr_plan')(
      { action: 'add_group', planId: 'plan-1', name: 'g', devices: ['dev-1'] },
      auth(['dev-1'], ['site-1']),
    ));
    expect(out.success).toBe(true);
  });
});

describe('DR list reads — device-less analysis run must not take the unfiltered path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('query_dr_plans filters for a caller with allowedDeviceIds and no allowedSiteIds', async () => {
    mockDb.select.mockImplementation((cols?: any) => {
      if (cols && 'id' in cols && 'siteId' in cols && Object.keys(cols).length === 2) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'dev-2', siteId: 'site-1' }]) }) };
      }
      if (cols && 'planId' in cols && 'devices' in cols) {
        return { from: () => ({ where: () => Promise.resolve([{ planId: 'plan-1', devices: ['dev-2'] }]) }) };
      }
      return {
        from: () => ({
          leftJoin: () => ({
            where: () => ({ groupBy: () => ({ orderBy: () => ({ limit: () => Promise.resolve([{ id: 'plan-1', name: 'SECRET-PLAN', createdAt: new Date() }]) }) }) }),
          }),
        }),
      };
    });
    const out = JSON.parse(await handlerFor('query_dr_plans')({}, auth(['dev-1'], undefined)));
    expect(out.plans).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('SECRET-PLAN');
  });
});
