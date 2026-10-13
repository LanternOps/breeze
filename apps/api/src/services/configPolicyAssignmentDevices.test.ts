/**
 * Unit coverage for resolveAssignmentDevices (#8442; the partner-wide scheduler
 * cases from #1724/#2280/#3182 moved here from patchSchedulerWorker.test.ts).
 *
 * The db is a mocked chain, so every where()/join condition is compiled through
 * PgDialect and asserted on its params / SQL text. A mock that ignores its
 * argument would pass against broken code. The REAL schema and the REAL
 * matchesRoleOsFilter run; only the db and the group gating are stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

const mockResolveExecutionSafeGroupIds = vi.fn(async (groupIds: string[]) => ({
  allowedGroupIds: groupIds,
  refusedGroups: [] as Array<{ id: string; refusedFields: string[] }>,
}));
const mockAuditRefusedExecutionGroups = vi.fn();
vi.mock('./executionTargetGating', () => ({
  resolveExecutionSafeGroupIds: (...args: [string[]]) => mockResolveExecutionSafeGroupIds(...args),
  auditRefusedExecutionGroups: (...args: unknown[]) => mockAuditRefusedExecutionGroups(...args),
}));

import { db } from '../db';
import { deviceGroups, devices, organizations } from '../db/schema';
import { resolveAssignmentDevices, type AssignmentToExpand } from './configPolicyAssignmentDevices';

const dialect = new PgDialect();
const render = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

const AUDIT = 'patch_schedule.execution_target_refused_agent_reported_fields';
const PARTNER_TARGET = '88888888-8888-4888-8888-888888888888';

type Row = { id: string; deviceRole?: string | null; osType?: string | null };

function assignment(level: string, targetId: string, filters: Partial<AssignmentToExpand> = {}): AssignmentToExpand {
  return { level, targetId, roleFilter: null, osFilter: null, ...filters };
}

/** A chainable select() whose where() (or limit(), for device level) resolves to rows. */
function mockChain(rows: Row[], terminal: 'where' | 'limit' = 'where') {
  const chain: any = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => (terminal === 'where' ? Promise.resolve(rows) : chain)),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  vi.mocked(db.select).mockReturnValueOnce(chain);
  return chain;
}

const resolveOpts = { refusedGroups: 'resolve' as const, auditAction: AUDIT };

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveAssignmentDevices — partner / org scoping', () => {
  it('resolves every device under the partner when the policy has no owning org (partner-wide)', async () => {
    const chain = mockChain([{ id: 'dev-a' }, { id: 'dev-b' }]);
    const { deviceIds } = await resolveAssignmentDevices(
      assignment('partner', PARTNER_TARGET),
      { policyOrgId: null, policyPartnerId: null },
      resolveOpts,
    );
    expect(deviceIds).toEqual(['dev-a', 'dev-b']);
    // No org clamp: the partner id reaches organizations.partner_id only.
    const { sql, params } = render(chain.where.mock.calls[0][0]);
    expect(sql).toContain('"organizations"."partner_id"');
    expect(sql).not.toContain('"devices"."org_id"');
    expect(params).toContain(PARTNER_TARGET);
  });

  it('clamps an org-owned policy (policyOrgId set) by devices.orgId, not organizations.partnerId', async () => {
    const chain = mockChain([{ id: 'dev-a' }]);
    const { deviceIds } = await resolveAssignmentDevices(
      assignment('organization', 'org-x'),
      { policyOrgId: 'org-x', policyPartnerId: null },
      resolveOpts,
    );
    expect(deviceIds).toEqual(['dev-a']);
    // Every subset branch inner-joins organizations (for the partner re-clamp / holding org).
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    const { sql, params } = render(chain.where.mock.calls[0][0]);
    expect(params).toContain('org-x');
    expect(sql).toContain('"devices"."org_id"');
    expect(sql).not.toContain('"organizations"."partner_id"');
  });

  it('re-clamps an ORGANIZATION-level subset assignment on a partner-owned policy to the policy partner (TOCTOU, #2280)', async () => {
    const chain = mockChain([{ id: 'dev-a' }]);
    const { deviceIds } = await resolveAssignmentDevices(
      assignment('organization', 'org-x'),
      { policyOrgId: null, policyPartnerId: 'partner-123' },
      resolveOpts,
    );
    expect(deviceIds).toEqual(['dev-a']);
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    const { sql, params } = render(chain.where.mock.calls[0][0]);
    expect(params).toContain('org-x');
    expect(params).toContain('partner-123');
    expect(sql).toContain('"organizations"."partner_id"');
  });

  it('re-clamps a SITE-level subset assignment on a partner-owned policy to the policy partner (#2280)', async () => {
    const chain = mockChain([{ id: 'dev-a' }]);
    const { deviceIds } = await resolveAssignmentDevices(
      assignment('site', 'site-x'),
      { policyOrgId: null, policyPartnerId: 'partner-123' },
      resolveOpts,
    );
    expect(deviceIds).toEqual(['dev-a']);
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    const { sql, params } = render(chain.where.mock.calls[0][0]);
    expect(sql).toContain('"devices"."site_id"');
    expect(params).toContain('site-x');
    expect(params).toContain('partner-123');
  });

  it('re-clamps a DEVICE_GROUP-level subset assignment on a partner-owned policy to the policy partner (#2280)', async () => {
    const chain = mockChain([{ id: 'dev-a' }]);
    const { deviceIds } = await resolveAssignmentDevices(
      assignment('device_group', 'group-x'),
      { policyOrgId: null, policyPartnerId: 'partner-123' },
      resolveOpts,
    );
    expect(deviceIds).toEqual(['dev-a']);
    // deviceGroups + devices (#3182 membership chain) then organizations for the clamp.
    expect(chain.innerJoin).toHaveBeenCalledTimes(3);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(deviceGroups);
    expect(chain.innerJoin.mock.calls[1][0]).toBe(devices);
    expect(chain.innerJoin.mock.calls[2][0]).toBe(organizations);
    const { sql, params } = render(chain.where.mock.calls[0][0]);
    expect(params).toContain('group-x');
    expect(params).toContain('partner-123');
    expect(sql).toContain('"organizations"."partner_id"');
  });

  it('re-clamps a DEVICE-level subset assignment on a partner-owned policy to the policy partner (#2280)', async () => {
    // The device branch chains .limit(1) after .where().
    const chain = mockChain([{ id: 'dev-a' }], 'limit');
    const { deviceIds } = await resolveAssignmentDevices(
      assignment('device', 'dev-x'),
      { policyOrgId: null, policyPartnerId: 'partner-123' },
      resolveOpts,
    );
    expect(deviceIds).toEqual(['dev-a']);
    expect(chain.innerJoin).toHaveBeenCalledTimes(1);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(organizations);
    expect(chain.limit).toHaveBeenCalledWith(1);
    const { params } = render(chain.where.mock.calls[0][0]);
    expect(params).toContain('dev-x');
    expect(params).toContain('partner-123');
  });

  it('adds the partner + holding-org clamp for every subset level when requirePartnerId is set', async () => {
    const chain = mockChain([{ id: 'dev-a' }]);
    await resolveAssignmentDevices(
      assignment('site', 'site-x'),
      { policyOrgId: null, policyPartnerId: null, requirePartnerId: 'ring-partner' },
      resolveOpts,
    );
    const { sql, params } = render(chain.where.mock.calls[0][0]);
    expect(params).toContain('ring-partner');
    expect(sql).toContain('"organizations"."partner_id"');
    expect(sql).toContain('"organizations"."type" <>');
  });

  it('returns nothing for an unknown level', async () => {
    const { deviceIds } = await resolveAssignmentDevices(
      assignment('galaxy', 'x'),
      { policyOrgId: null, policyPartnerId: null },
      resolveOpts,
    );
    expect(deviceIds).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('resolveAssignmentDevices — device_group', () => {
  it('#3182 — join conditions tie deviceGroups/devices org_id to the membership row, not just id', async () => {
    // An empty result simulates the tightened join filtering out a membership
    // row whose group/device sit in a different org than the membership itself.
    const chain = mockChain([]);
    const { deviceIds } = await resolveAssignmentDevices(
      assignment('device_group', 'group-x'),
      { policyOrgId: 'org-y', policyPartnerId: null },
      resolveOpts,
    );
    expect(deviceIds).toEqual([]);
    expect(chain.innerJoin.mock.calls[0][0]).toBe(deviceGroups);
    expect(chain.innerJoin.mock.calls[1][0]).toBe(devices);

    const groupJoin = render(chain.innerJoin.mock.calls[0][1]).sql;
    expect(groupJoin).toContain('"device_group_memberships"."group_id" = "device_groups"."id"');
    expect(groupJoin).toContain('"device_groups"."org_id" = "device_group_memberships"."org_id"');

    const deviceJoin = render(chain.innerJoin.mock.calls[1][1]).sql;
    expect(deviceJoin).toContain('"device_group_memberships"."device_id" = "devices"."id"');
    expect(deviceJoin).toContain('"devices"."org_id" = "device_group_memberships"."org_id"');
  });

  it('still resolves a refused device_group when refusedGroups is "resolve", and audits the refusal', async () => {
    const refused = [{ id: 'group-x', refusedFields: ['hostname'] }];
    mockResolveExecutionSafeGroupIds.mockResolvedValueOnce({ allowedGroupIds: [], refusedGroups: refused });
    mockChain([{ id: 'dev-legit' }]);

    const result = await resolveAssignmentDevices(
      assignment('device_group', 'group-x'),
      { policyOrgId: 'org-y', policyPartnerId: null },
      resolveOpts,
    );

    expect(result.deviceIds).toEqual(['dev-legit']);
    expect(result.refusedGroups).toEqual(refused);
    expect(mockAuditRefusedExecutionGroups).toHaveBeenCalledWith('org-y', AUDIT, refused);
  });

  it('with refusedGroups "exclude", returns [] and the refused groups without querying membership', async () => {
    const refused = [{ id: 'group-x', refusedFields: ['hostname'] }];
    mockResolveExecutionSafeGroupIds.mockResolvedValueOnce({ allowedGroupIds: [], refusedGroups: refused });

    const result = await resolveAssignmentDevices(
      assignment('device_group', 'group-x'),
      { policyOrgId: 'org-y', policyPartnerId: null },
      { refusedGroups: 'exclude', auditAction: 'update_ring.refused' },
    );

    expect(result).toEqual({ deviceIds: [], refusedGroups: refused });
    expect(db.select).not.toHaveBeenCalled();
    expect(mockAuditRefusedExecutionGroups).toHaveBeenCalledWith('org-y', 'update_ring.refused', refused);
  });
});

describe('resolveAssignmentDevices — role / OS filter (#8442)', () => {
  const rows: Row[] = [
    { id: 'ws-linux', deviceRole: 'workstation', osType: 'linux' },
    { id: 'ws-win', deviceRole: 'workstation', osType: 'windows' },
    { id: 'srv-linux', deviceRole: 'server', osType: 'linux' },
    { id: 'srv-win', deviceRole: 'server', osType: 'windows' },
  ];
  const scope = { policyOrgId: 'org-x', policyPartnerId: null };

  async function resolve(filters: Partial<AssignmentToExpand>, data: Row[] = rows) {
    mockChain(data);
    const { deviceIds } = await resolveAssignmentDevices(assignment('organization', 'org-x', filters), scope, resolveOpts);
    return deviceIds;
  }

  it('keeps every device when both filters are null', async () => {
    expect(await resolve({})).toEqual(['ws-linux', 'ws-win', 'srv-linux', 'srv-win']);
  });

  it('roleFilter ["workstation"] drops servers', async () => {
    expect(await resolve({ roleFilter: ['workstation'] })).toEqual(['ws-linux', 'ws-win']);
  });

  it('osFilter ["linux"] drops windows devices', async () => {
    expect(await resolve({ osFilter: ['linux'] })).toEqual(['ws-linux', 'srv-linux']);
  });

  it('combines role and OS filters (AND)', async () => {
    expect(await resolve({ roleFilter: ['server'], osFilter: ['windows'] })).toEqual(['srv-win']);
  });

  it('an EMPTY roleFilter or osFilter array matches no device', async () => {
    expect(await resolve({ roleFilter: [] })).toEqual([]);
    expect(await resolve({ osFilter: [] })).toEqual([]);
  });

  it('drops a device with a null deviceRole when roleFilter is non-null, keeps it when null', async () => {
    const data: Row[] = [{ id: 'no-role', deviceRole: null, osType: 'linux' }];
    expect(await resolve({ roleFilter: ['workstation'] }, data)).toEqual([]);
    expect(await resolve({ roleFilter: null }, data)).toEqual(['no-role']);
  });

  it('drops a device with a null osType when osFilter is non-null', async () => {
    const data: Row[] = [{ id: 'no-os', deviceRole: 'server', osType: null }];
    expect(await resolve({ osFilter: ['linux'] }, data)).toEqual([]);
  });

  it('applies the filter at device level too', async () => {
    mockChain([{ id: 'dev-a', deviceRole: 'server', osType: 'linux' }], 'limit');
    const { deviceIds } = await resolveAssignmentDevices(
      assignment('device', 'dev-a', { roleFilter: ['workstation'] }),
      scope,
      resolveOpts,
    );
    expect(deviceIds).toEqual([]);
  });

  it('de-duplicates device ids', async () => {
    const data: Row[] = [
      { id: 'dev-a', deviceRole: 'server', osType: 'linux' },
      { id: 'dev-a', deviceRole: 'server', osType: 'linux' },
      { id: 'dev-b', deviceRole: 'server', osType: 'linux' },
    ];
    expect(await resolve({}, data)).toEqual(['dev-a', 'dev-b']);
  });
});
