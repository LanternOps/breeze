/**
 * #6096 finding 5 — `manage_peripheral_policies` create/update writes ORG-WIDE
 * enforcement (targetType 'organization') and then schedules every resolved
 * device. Its only write gate was `canMutateOrgWideGovernance`, which reads
 * `scope === 'organization' && allowedSiteIds !== undefined` — blind to the
 * exact-device axis. A device-LESS analysis run carries `allowedDeviceIds` with
 * NO `allowedSiteIds`, so it sailed straight through and could block USB storage
 * across the whole organization.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: vi.fn(async () => ['dev-1', 'dev-2']),
  schedulePeripheralPolicyDevices: vi.fn(async () => undefined),
}));
vi.mock('./approvalGeneration', () => ({ bumpApprovalGeneration: vi.fn() }));

import { db } from '../db';
import { schedulePeripheralPolicyDevices } from '../jobs/peripheralJobs';
import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerPolicyPrereqTools(reg);
  return reg.get(name)!.handler;
}

function auth(allowedDeviceIds?: string[], allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'ai_agent' },
    user: { id: 'u1' },
    orgId: 'org-1',
    partnerId: 'partner-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

describe('manage_peripheral_policies — device-restricted callers cannot write org-wide policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.insert.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([{ id: 'pp-1', name: 'block usb' }]) }) });
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'pp-1', orgId: 'org-1', name: 'block usb' }]) }) }) });
    mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
  });

  it('refuses create for a device-LESS analysis run (allowedDeviceIds, no allowedSiteIds)', async () => {
    const out = JSON.parse(await handlerFor('manage_peripheral_policies')(
      { action: 'create', name: 'block usb', deviceClass: 'storage', action_type: 'block' },
      auth(['dev-1'], undefined),
    ));
    expect(out.error).toBeTruthy();
    expect(out.success).toBeUndefined();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(schedulePeripheralPolicyDevices).not.toHaveBeenCalled();
  });

  it('refuses update for a device-bound run', async () => {
    const out = JSON.parse(await handlerFor('manage_peripheral_policies')(
      { action: 'update', policyId: 'pp-1', isActive: false },
      auth(['dev-1'], ['site-1']),
    ));
    expect(out.error).toBeTruthy();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('still allows list for a device-bound run (reads are not gated here)', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }) });
    const out = JSON.parse(await handlerFor('manage_peripheral_policies')({ action: 'list' }, auth(['dev-1'], undefined)));
    expect(out.policies).toEqual([]);
  });

  it('unrestricted caller can still create', async () => {
    const out = JSON.parse(await handlerFor('manage_peripheral_policies')(
      { action: 'create', name: 'block usb', deviceClass: 'storage', action_type: 'block' },
      auth(undefined, undefined),
    ));
    expect(out.success).toBe(true);
  });
});
