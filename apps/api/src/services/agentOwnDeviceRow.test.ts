import { describe, expect, it, vi } from 'vitest';
import { eq, notInArray } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { devices } from '../db/schema';
import {
  ownDeviceRowChangedHands,
  ownDeviceRowCondition,
  selectOwnDeviceRowForUpdate,
  updateOwnDeviceRow,
} from './agentOwnDeviceRow';

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

describe('ownDeviceRowChangedHands (#8318 §6.4)', () => {
  function reader(rows: unknown[]) {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    return { exec: { select } as never, select, from, where, limit };
  }

  it('re-reads the row by id once, on the caller\'s executor', async () => {
    const { exec, select, from, where, limit } = reader([{ agentId: AGENT }]);
    await ownDeviceRowChangedHands(exec, { deviceId: DEVICE, agentId: AGENT });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith({ agentId: devices.agentId });
    expect(from).toHaveBeenCalledWith(devices);
    const { params } = new PgDialect().sqlToQuery((where.mock.calls[0] as unknown[])[0] as SQL);
    expect(params).toEqual([DEVICE]);
    expect(limit).toHaveBeenCalledWith(1);
  });

  it('is true only when the row now carries another agent_id', async () => {
    expect(await ownDeviceRowChangedHands(reader([{ agentId: 'agent-new-install' }]).exec, { deviceId: DEVICE, agentId: AGENT })).toBe(true);
    // Same agent_id: the site's own predicate (e.g. the terminal-status guard) refused the write.
    expect(await ownDeviceRowChangedHands(reader([{ agentId: AGENT }]).exec, { deviceId: DEVICE, agentId: AGENT })).toBe(false);
    // Not visible to the caller: no proof of a hand-over, the caller keeps its 0-row handling.
    expect(await ownDeviceRowChangedHands(reader([]).exec, { deviceId: DEVICE, agentId: AGENT })).toBe(false);
  });
});

describe('selectOwnDeviceRowForUpdate (#8318 §6.4, review of wave 1b-1)', () => {
  function lockingReader(rows: unknown[]) {
    const lock = vi.fn().mockResolvedValue(rows);
    const limit = vi.fn(() => ({ for: lock }));
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    return { exec: { select } as never, select, from, where, limit, lock };
  }

  it('reads the row bound to devices.id AND devices.agent_id, one row, locked FOR NO KEY UPDATE', async () => {
    const { exec, select, from, where, limit, lock } = lockingReader([{ id: DEVICE, agentId: AGENT }]);
    const row = await selectOwnDeviceRowForUpdate(exec, { deviceId: DEVICE, agentId: AGENT });
    expect(row).toEqual({ id: DEVICE, agentId: AGENT });
    expect(select).toHaveBeenCalledWith(); // the whole row by default
    expect(from).toHaveBeenCalledWith(devices);
    const { sql: text, params } = new PgDialect().sqlToQuery((where.mock.calls[0] as unknown[])[0] as SQL);
    expect(text).toBe('("devices"."id" = $1 and "devices"."agent_id" = $2)');
    expect(params).toEqual([DEVICE, AGENT]);
    expect(limit).toHaveBeenCalledWith(1);
    // Conflicts with confirm's FOR UPDATE and the re-enroll's key-changing
    // UPDATE, but not with the KEY SHARE an FK insert elsewhere takes.
    expect(lock).toHaveBeenCalledWith('no key update');
  });

  it('passes a column map through', async () => {
    const { exec, select } = lockingReader([{ id: DEVICE }]);
    await selectOwnDeviceRowForUpdate(exec, { deviceId: DEVICE, agentId: AGENT }, { id: devices.id });
    expect(select).toHaveBeenCalledWith({ id: devices.id });
  });

  it('answers undefined when the identity no longer matches (stale caller or vanished row)', async () => {
    expect(await selectOwnDeviceRowForUpdate(lockingReader([]).exec, { deviceId: DEVICE, agentId: AGENT })).toBeUndefined();
  });
});

