import { beforeEach, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), outside: vi.fn(), system: vi.fn() }));
vi.mock('../db', () => ({
  db: { transaction: mocks.transaction },
  runOutsideDbContext: mocks.outside,
  withSystemDbAccessContext: mocks.system,
}));
import { deleteDeviceGroup } from './deviceGroupDelete';

const GROUP = '10000000-0000-4000-8000-000000000001';
const PARTNER = '20000000-0000-4000-8000-000000000001';
const dialect = new PgDialect();
beforeEach(() => {
  vi.resetAllMocks();
  mocks.outside.mockImplementation((fn) => fn());
  mocks.system.mockImplementation((fn) => fn());
});

it('locks partner group FOR UPDATE, prelocks the complete sorted org union, then deletes in order', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const events: string[] = [];
  const rows = [
    [{ id: GROUP, name: 'Partner', orgId: null, partnerId: PARTNER }],
    [{ deviceId: 'device-1' }],
  ];
  const tx = {
    select: () => {
      const result = rows.shift();
      const chain = {
        from: () => chain,
        where: (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
          statements.push(dialect.sqlToQuery(query));
          return chain;
        },
        for: async (mode: string) => { events.push(`group:${mode}`); return result; },
        then: (resolve: (value: unknown) => unknown) => resolve(result),
      };
      return chain;
    },
    execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      events.push('export-lock');
      statements.push(dialect.sqlToQuery(query));
      return [];
    },
    delete: (table: Parameters<typeof getTableName>[0]) => ({
      where: async () => { events.push(`delete:${getTableName(table)}`); },
    }),
  };
  mocks.transaction.mockImplementation((fn) => fn(tx));
  const result = await deleteDeviceGroup(GROUP, { partnerId: PARTNER });
  expect(result).toEqual({ group: { id: GROUP, name: 'Partner', orgId: null, partnerId: PARTNER }, affectedDeviceIds: ['device-1'] });
  expect(mocks.outside).toHaveBeenCalledOnce();
  expect(mocks.system).toHaveBeenCalledOnce();
  expect(statements[0]?.sql).toMatch(/"device_groups"\."org_id" is null/);
  expect(statements[0]?.sql).toMatch(/"device_groups"\."partner_id" =/);
  expect(statements[0]?.params).toEqual([GROUP, PARTNER]);
  expect(statements[1]?.sql).toMatch(/breeze_partner_export_lock_orgs_exclusive/);
  expect(statements[1]?.sql).toMatch(/UNION/);
  expect(statements[1]?.sql).toMatch(/ORDER BY/);
  expect(statements[1]?.sql).toMatch(/organizations/);
  expect(statements[1]?.sql).toMatch(/device_group_memberships/);
  expect(statements[1]?.sql).not.toMatch(/status|is_quick_support|is_holding/);
  expect(statements[1]?.params).toEqual([PARTNER, GROUP]);
  expect(events).toEqual(['group:update', 'export-lock', 'delete:config_policy_assignments', 'delete:group_membership_log', 'delete:device_group_memberships', 'delete:device_groups']);
});

it('missing partner group fails before export locks or deletes', async () => {
  const execute = vi.fn();
  const del = vi.fn();
  mocks.transaction.mockImplementation((fn) => fn({
    select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
    execute, delete: del,
  }));
  await expect(deleteDeviceGroup(GROUP, { partnerId: PARTNER })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(execute).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
});
