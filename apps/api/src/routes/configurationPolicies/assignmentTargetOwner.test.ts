import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Who owns an assignment target (#12466 G5), per level. The db fake answers by
 * table, and records the projection and WHERE so a swapped column fails here.
 * The RLS read itself is proven in configPolicyAssignmentApply.integration.test.ts.
 */

const { selectMock, state } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  state: { rows: new Map<unknown, unknown[]>(), reads: [] as Array<{ table: unknown; cols: Record<string, unknown>; where: unknown }> },
}));

vi.mock('../../db', () => ({ db: { select: selectMock } }));

import { deviceGroups, devices, sites } from '../../db/schema';
import { resolveAssignmentTargetOwner } from './assignmentTargetOwner';

const dialect = new PgDialect();
const TARGET = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const PARTNER = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = new Map();
  state.reads = [];
  selectMock.mockImplementation((cols: Record<string, unknown>) => {
    let table: unknown;
    let where: unknown;
    const c: Record<string, unknown> = {};
    c.from = (t: unknown) => { table = t; return c; };
    c.where = (w: unknown) => { where = w; return c; };
    c.limit = () => {
      state.reads.push({ table, cols, where });
      return Promise.resolve(state.rows.get(table) ?? []);
    };
    return c;
  });
});

function lastWhereParams(): unknown[] {
  return dialect.sqlToQuery(state.reads.at(-1)!.where as SQL).params;
}

describe('resolveAssignmentTargetOwner', () => {
  it('partner and organization targets name themselves, with no read', async () => {
    expect(await resolveAssignmentTargetOwner('partner', PARTNER)).toEqual({ kind: 'partner', partnerId: PARTNER });
    expect(await resolveAssignmentTargetOwner('organization', ORG)).toEqual({ kind: 'organization', orgId: ORG });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("a site resolves to the site's organization", async () => {
    state.rows.set(sites, [{ orgId: ORG }]);
    expect(await resolveAssignmentTargetOwner('site', TARGET)).toEqual({ kind: 'organization', orgId: ORG });
    expect(state.reads[0]!.table).toBe(sites);
    expect(state.reads[0]!.cols).toEqual({ orgId: sites.orgId });
    expect(lastWhereParams()).toEqual([TARGET]);
  });

  it("a device resolves to the device's organization", async () => {
    state.rows.set(devices, [{ orgId: ORG }]);
    expect(await resolveAssignmentTargetOwner('device', TARGET)).toEqual({ kind: 'organization', orgId: ORG });
    expect(state.reads[0]!.table).toBe(devices);
    expect(state.reads[0]!.cols).toEqual({ orgId: devices.orgId });
  });

  it('an org-owned group resolves to its organization; a partner-owned one to its partner', async () => {
    state.rows.set(deviceGroups, [{ orgId: ORG, partnerId: null }]);
    expect(await resolveAssignmentTargetOwner('device_group', TARGET)).toEqual({ kind: 'organization', orgId: ORG });
    expect(state.reads[0]!.cols).toEqual({ orgId: deviceGroups.orgId, partnerId: deviceGroups.partnerId });

    state.rows.set(deviceGroups, [{ orgId: null, partnerId: PARTNER }]);
    expect(await resolveAssignmentTargetOwner('device_group', TARGET)).toEqual({ kind: 'partner_group', partnerId: PARTNER });
  });

  it('an unreadable or ownerless target resolves to null (fail closed)', async () => {
    expect(await resolveAssignmentTargetOwner('site', TARGET)).toBeNull();
    expect(await resolveAssignmentTargetOwner('device', TARGET)).toBeNull();
    expect(await resolveAssignmentTargetOwner('device_group', TARGET)).toBeNull();
    state.rows.set(deviceGroups, [{ orgId: null, partnerId: null }]);
    expect(await resolveAssignmentTargetOwner('device_group', TARGET)).toBeNull();
    expect(await resolveAssignmentTargetOwner('galaxy' as never, TARGET)).toBeNull();
  });
});
