import { describe, expect, it, vi } from 'vitest';
import { eq, notInArray } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { devices } from '../db/schema';
import { ownDeviceRowCondition, updateOwnDeviceRow } from './agentOwnDeviceRow';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const AGENT = 'agent-abc';

function executor(rows: unknown[] = [{ id: DEVICE }]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { exec: { update } as never, update, set, where, returning };
}

describe('updateOwnDeviceRow (#8318 §6.4)', () => {
  it('always binds the write to devices.id AND devices.agent_id, in that statement', async () => {
    const { exec, update, set, where } = executor();
    await updateOwnDeviceRow(exec, { deviceId: DEVICE, agentId: AGENT }, { lastSeenAt: new Date(0) });
    expect(update).toHaveBeenCalledWith(devices);
    expect(set).toHaveBeenCalledWith({ lastSeenAt: new Date(0) });
    const { sql: text, params } = new PgDialect().sqlToQuery((where.mock.calls[0] as unknown[])[0] as SQL);
    expect(text).toContain('"devices"."id" = ');
    expect(text).toContain('"devices"."agent_id" = ');
    expect(params).toEqual([DEVICE, AGENT]);
  });

  it('ANDs the caller\'s extra predicate after the identity', async () => {
    const { exec, where } = executor();
    await updateOwnDeviceRow(exec, { deviceId: DEVICE, agentId: AGENT }, { status: 'online' }, {
      where: notInArray(devices.status, ['decommissioned', 'quarantined']),
    });
    const { sql: text, params } = new PgDialect().sqlToQuery((where.mock.calls[0] as unknown[])[0] as SQL);
    expect(text).toContain('"devices"."status" not in');
    expect(params).toEqual([DEVICE, AGENT, 'decommissioned', 'quarantined']);
  });

  it('returns the matched rows ({ id } by default) so callers keep their 0-row handling', async () => {
    const { exec, returning } = executor([]);
    const rows = await updateOwnDeviceRow(exec, { deviceId: DEVICE, agentId: AGENT }, { lastSeenAt: new Date() });
    expect(rows).toEqual([]);
    expect(returning).toHaveBeenCalledWith({ id: devices.id });
  });

  it('passes a custom returning map through', async () => {
    const { exec, returning } = executor([{ id: DEVICE, status: 'online' }]);
    const rows = await updateOwnDeviceRow(exec, { deviceId: DEVICE, agentId: AGENT }, { status: 'online' }, {
      returning: { id: devices.id, status: devices.status },
    });
    expect(returning).toHaveBeenCalledWith({ id: devices.id, status: devices.status });
    expect(rows[0]?.status).toBe('online');
  });

  it('ownDeviceRowCondition is the identity predicate alone', () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(ownDeviceRowCondition({ deviceId: DEVICE, agentId: AGENT }));
    expect(text).toBe('("devices"."id" = $1 and "devices"."agent_id" = $2)');
    expect(params).toEqual([DEVICE, AGENT]);
    // Sanity: the same shape a caller would otherwise hand-write.
    expect(new PgDialect().sqlToQuery(eq(devices.id, DEVICE)).params).toEqual([DEVICE]);
  });
});
