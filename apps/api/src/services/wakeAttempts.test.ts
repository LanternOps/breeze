import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn(), values: vi.fn(), set: vi.fn(), where: vi.fn(), returning: vi.fn(), onConflictDoUpdate: vi.fn(), limit: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: mocks.select, insert: mocks.insert, update: mocks.update },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
import { openOrJoinWakeAttempt, recordWakeRefusal, applyWakeRelayResult, WAKE_OUTCOME_WINDOW_MS } from './wakeAttempts';
import { commandResultHandlers } from './commandResultHandlers';

const id = '11111111-1111-4111-8111-111111111111';
const input = { deviceId: id, orgId: id, relayDeviceId: id, relayHostname: 'relay', requestedBy: id, macs: ['AA:BB:CC:DD:EE:01'], broadcast: '192.0.2.255' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: mocks.limit }) }) });
  mocks.limit.mockResolvedValue([]);
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockReturnValue({ returning: mocks.returning, onConflictDoUpdate: mocks.onConflictDoUpdate });
  mocks.onConflictDoUpdate.mockReturnValue({ returning: mocks.returning });
  mocks.returning.mockResolvedValue([{ id, joined: false }]);
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ returning: mocks.returning });
});

describe('wake attempts', () => {
  it('new attempt is pending with deadline_at = now + 10 min', async () => {
    expect(WAKE_OUTCOME_WINDOW_MS).toBe(600_000);
    const before = Date.now();
    expect(await openOrJoinWakeAttempt(input)).toEqual({ attemptId: id, joined: false });
    const row = mocks.values.mock.calls[0]![0];
    expect(row).toMatchObject({ ...input, outcome: 'pending', sendCount: 1 });
    expect(row.deadlineAt.getTime() - row.requestedAt.getTime()).toBe(600_000);
    expect(row.requestedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
  it('a repeat click atomically joins and increments only send_count', async () => {
    mocks.returning.mockResolvedValue([{ id, joined: true }]);
    expect(await openOrJoinWakeAttempt(input)).toEqual({ attemptId: id, joined: true });
    const conflict = mocks.onConflictDoUpdate.mock.calls[0]![0];
    expect(Object.keys(conflict.set)).toEqual(['sendCount']);
    expect(new PgDialect().sqlToQuery(conflict.set.sendCount).sql).toContain('"send_count" + 1');
    expect(new PgDialect().sqlToQuery(conflict.targetWhere).sql).toContain("IN ('pending','sent')");
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('propagates unrelated insert errors', async () => {
    const error = { code: '23503' };
    mocks.returning.mockRejectedValueOnce(error);
    await expect(openOrJoinWakeAttempt(input)).rejects.toBe(error);
  });
  it.each(['NO_RELAY', 'NO_MACS', 'NO_SUBNET', 'IPV6_ONLY', 'RELAY_OVERRIDE_INVALID'] as const)('records %s with null relay and deadline', async code => {
    await recordWakeRefusal({ ...input, code });
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'refused', refusalCode: code, relayDeviceId: null, deadlineAt: null, resolvedAt: expect.any(Date) }));
  });
  it.each(['TARGET_NOT_FOUND', 'TARGET_ONLINE', 'DEVICE_PENDING_ASSIGNMENT'] as const)('does not record %s', async code => {
    await recordWakeRefusal({ ...input, code });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('logs a failed refusal insert without throwing', async () => {
    mocks.values.mockRejectedValueOnce(new Error('write failed'));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordWakeRefusal({ ...input, code: 'NO_MACS' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it.each([true, false])('relay result %s compares and sets pending only', async sent => {
    await applyWakeRelayResult(id, sent);
    expect(mocks.set).toHaveBeenCalledWith(sent ? { outcome: 'sent' } : { outcome: 'send_failed', resolvedAt: expect.any(Date) });
    const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0]![0]);
    expect(query.params).toEqual([id, 'pending']);
  });
});

describe('wake command result handler', () => {
  it('receives HTTP fallback results as well as websocket results', () => {
    const source = readFileSync(new URL('../routes/agents/commands.ts', import.meta.url), 'utf8');
    const entries = source.match(/const REGISTRY_DISPATCHED_COMMAND_TYPES = new Set\(\[([\s\S]*?)\]\)/)?.[1];
    expect(entries).toContain("'wake_on_lan'");
  });
  const handle = async (wakeAttemptId: unknown, status: 'completed' | 'failed' | 'timeout', result: unknown) => commandResultHandlers.wake_on_lan!({
    command: { payload: { wakeAttemptId } } as never, commandId: id, agentId: 'relay', resolvedDeviceId: id,
    result: { status }, stdout: JSON.stringify(result),
  });
  it.each([
    ['completed', { packetsSent: 1 }, 'sent'],
    ['completed', { packetsSent: 0 }, 'send_failed'],
    ['completed', { packetsSent: '1' }, 'send_failed'],
    ['completed', null, 'send_failed'],
    ['failed', { packetsSent: 1 }, 'send_failed'],
    ['timeout', { packetsSent: 1 }, 'send_failed'],
  ] as const)('%s with %j becomes %s', async (status, result, outcome) => {
    await handle(id, status, result);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
  });
  it.each([undefined, null, '', 'invalid', 42])('ignores malformed id %s', async value => {
    await handle(value, 'completed', { packetsSent: 1 });
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
