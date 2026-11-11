import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { detachOriginDeviceTopologyAlerts, deleteOriginDeviceTopologyAlerts } from './siteOwnedAlerts';
import { sql } from 'drizzle-orm';

const deviceId = '00000000-0000-4000-8000-000000000001';

describe('detachOriginDeviceTopologyAlerts', () => {
  it.each([
    { result: Object.assign([{ id: 'a' }, { id: 'b' }], { count: 2 }), count: 2 },
    { result: { rows: [{ id: 'a' }], rowCount: 1 }, count: 1 },
    { result: [], count: 0 },
  ])('returns the detached count $count without touching alert children', async ({ result, count }) => {
    const tx = { execute: vi.fn().mockResolvedValue(result) };
    expect(await detachOriginDeviceTopologyAlerts(tx, deviceId)).toBe(count);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(tx.execute.mock.calls[0]![0]);
    expect(query).toMatchObject({
      sql: "UPDATE alerts SET device_id = NULL WHERE owner_kind = 'topology_site' AND device_id = $1::uuid RETURNING id",
      params: [deviceId],
    });
  });

  it('propagates a failed detach so the caller can roll back the purge', async () => {
    const error = new Error('detach failed');
    const tx = { execute: vi.fn().mockRejectedValue(error) };
    await expect(detachOriginDeviceTopologyAlerts(tx, deviceId)).rejects.toBe(error);
  });
});

it('keeps cross-org erasure deleting origin topology alerts and their children', async () => {
  const tx = { execute: vi.fn().mockResolvedValue([{ id: 'a' }]) };
  const orgId = '00000000-0000-4000-8000-000000000002';
  expect(await deleteOriginDeviceTopologyAlerts(tx, sql`${deviceId}::uuid`, { ownerOrgNot: orgId })).toBe(1);
  const queries = tx.execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query));
  expect(queries).toHaveLength(6);
  expect(queries[0]?.sql).toContain('DELETE FROM alert_correlations');
  expect(queries[1]?.sql).toContain('DELETE FROM alert_notifications');
  expect(queries[2]?.sql).toContain('DELETE FROM psa_ticket_mappings');
  expect(queries[5]?.sql).toContain('DELETE FROM alerts');
  for (const query of queries) {
    expect(query.sql).toContain('org_id <>');
    expect(query.params).toContain(orgId);
  }
});
