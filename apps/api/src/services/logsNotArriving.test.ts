import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// #8612 (W05 of #8607) — "Logs not arriving" after a log-level raise.
//
// Real drizzle-orm + real schema (deliberately NOT mocked), same harness shape
// as `deviceUninstallState.test.ts`: the parts of this read that can go wrong
// silently are its WHERE clauses (which command row; which timestamp the
// agent_logs probe compares against), so they are asserted on COMPILED SQL.

const selectMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

import { logsNotArriving, LOGS_NOT_ARRIVING_GRACE_MS } from './logsNotArriving';

const dialect = new PgDialect();

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-13T12:00:00.000Z');
// Queued 12 min ago, completed 10 min ago: well past the 5-min grace.
const CREATED_AT = new Date('2026-10-13T11:48:00.000Z');
const COMPLETED_AT = new Date('2026-10-13T11:50:00.000Z');

/** The stdout a W03+ agent's `handleSetLogLevel` returns for a raise. */
function agentStdout(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    newLevel: 'debug',
    appliedLevel: 'debug',
    baseLevel: 'warn',
    durationMinutes: 60,
    expiresAt: '2026-10-13T12:50:00Z',
    persisted: true,
    ...overrides,
  });
}

/** The row the `device_commands` SELECT projects, as `buildStoredCommandResult` stores it. */
function commandRow(overrides: Record<string, unknown> = {}, stdout: string | null = agentStdout()) {
  return {
    status: 'completed',
    createdAt: CREATED_AT,
    completedAt: COMPLETED_AT,
    result: {
      status: 'completed',
      exitCode: 0,
      stdout,
      stderr: undefined,
      durationMs: 3,
      error: undefined,
    } as unknown,
    ...overrides,
  };
}

const CANARY_CAPABLE = { logShippingState: 'ok' as string | null };

type Rig = { where: () => unknown; orderBy: () => unknown; limit: () => unknown };

/** Chainable select whose links are awaitable and capture their arguments. */
function rigSelect(rows: unknown[]): Rig {
  const captured: { where?: unknown; orderBy?: unknown; limit?: unknown } = {};
  const chain: Record<string, any> = {};
  chain.from = vi.fn(() => Object.assign(Promise.resolve(rows), chain));
  chain.where = vi.fn((cond: unknown) => {
    captured.where = cond;
    return Object.assign(Promise.resolve(rows), chain);
  });
  chain.orderBy = vi.fn((...cond: unknown[]) => {
    captured.orderBy = cond;
    return Object.assign(Promise.resolve(rows), chain);
  });
  chain.limit = vi.fn((n: unknown) => {
    captured.limit = n;
    return Object.assign(Promise.resolve(rows), chain);
  });
  selectMock.mockReturnValueOnce(Object.assign(Promise.resolve(rows), chain));
  return { where: () => captured.where, orderBy: () => captured.orderBy, limit: () => captured.limit };
}

beforeEach(() => {
  selectMock.mockReset();
});

describe('logsNotArriving — positive', () => {
  it('reports the raise when a debug raise completed >5 min ago and no agent_logs row exists since the command was created', async () => {
    rigSelect([commandRow()]);
    rigSelect([]);

    const out = await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE);

    expect(out).toEqual({ raisedAt: COMPLETED_AT.toISOString() });
  });

  it('also reports an info raise (base warn)', async () => {
    rigSelect([commandRow({}, agentStdout({ appliedLevel: 'info', newLevel: 'info' }))]);
    rigSelect([]);

    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toEqual({
      raisedAt: COMPLETED_AT.toISOString(),
    });
  });
});

describe('logsNotArriving — the queries', () => {
  it('reads the newest COMPLETED set_log_level row for this device only, LIMIT 1', async () => {
    const cmd = rigSelect([commandRow()]);
    rigSelect([]);

    await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE);

    const built = dialect.sqlToQuery(cmd.where() as never);
    const sqlText = built.sql.toLowerCase();
    expect(sqlText).not.toContain(' or ');
    expect(sqlText).toContain('"device_commands"."device_id" = $');
    expect(sqlText).toContain('"device_commands"."type" = $');
    expect(sqlText).toContain('"device_commands"."completed_at" is not null');
    expect(built.params).toContain(DEVICE_ID);
    // The STORED type; `set_agent_log_level` is only the AI tool's name.
    expect(built.params).toContain('set_log_level');
    expect(built.params).not.toContain('set_agent_log_level');

    const order = (cmd.orderBy() as unknown[]).map((o) => dialect.sqlToQuery(o as never).sql.toLowerCase());
    expect(order[0]).toContain('"device_commands"."completed_at" desc');
    expect(cmd.limit()).toBe(1);
  });

  it('probes agent_logs by device and created_at >= the COMMAND\'s created_at (not completed_at, not devices.last_log_at)', async () => {
    rigSelect([commandRow()]);
    const logs = rigSelect([]);

    await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE);

    const built = dialect.sqlToQuery(logs.where() as never);
    const sqlText = built.sql.toLowerCase();
    expect(sqlText).not.toContain(' or ');
    expect(sqlText).toContain('"agent_logs"."device_id" = $');
    expect(sqlText).toContain('"agent_logs"."created_at" >= $');
    // Review Focus 7: the throttled column must never be the signal.
    expect(sqlText).not.toContain('last_log_at');
    expect(built.params).toContain(DEVICE_ID);
    // The canary ships before the API records completion, so the bound is
    // the command's creation time. Comparing against completed_at would miss
    // the canary and false-alarm.
    const bound = built.params.find((p) => p !== DEVICE_ID);
    expect(String(bound)).toContain('11:48:00');
    expect(String(bound)).not.toContain('11:50:00');
    expect(logs.limit()).toBe(1);
  });
});

describe('logsNotArriving — negatives (null)', () => {
  it('agent never reported logShipping (stored state NULL) → null without touching the database', async () => {
    expect(await logsNotArriving(DEVICE_ID, NOW, { logShippingState: null })).toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('no set_log_level command → null', async () => {
    rigSelect([]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('command failed → null', async () => {
    rigSelect([commandRow({ status: 'failed', result: { status: 'failed', error: 'log shipper not initialized' } })]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it.each(['warn', 'error'])('raise to %s → null (no canary line at that level)', async (level) => {
    rigSelect([commandRow({}, agentStdout({ appliedLevel: level, newLevel: level, baseLevel: 'error' }))]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
  });

  it('level re-stated at the base level (not a raise: the agent emits no canary) → null', async () => {
    rigSelect([commandRow({}, agentStdout({ appliedLevel: 'info', newLevel: 'info', baseLevel: 'info' }))]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
  });

  it('pre-#7416 result without expiresAt → null', async () => {
    rigSelect([commandRow({}, JSON.stringify({ newLevel: 'debug', durationMinutes: 60 }))]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
  });

  it('unparseable / empty stdout → null', async () => {
    rigSelect([commandRow({}, 'not json')]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
    rigSelect([commandRow({}, null)]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
  });

  it('override expired → null', async () => {
    rigSelect([commandRow({}, agentStdout({ expiresAt: '2026-10-13T11:59:59Z' }))]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
  });

  it('completed less than 5 min ago → null', async () => {
    const justNow = new Date(NOW.getTime() - LOGS_NOT_ARRIVING_GRACE_MS + 1000);
    rigSelect([commandRow({ completedAt: justNow })]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('a fresh agent_logs row since the command was created → null (the probe, not devices.last_log_at, decides)', async () => {
    // The service is never handed last_log_at, so a throttled last_log_at
    // cannot cause a false alarm. Which rows the probe can see (the createdAt
    // bound, so a canary stored before completedAt counts) is pinned by the
    // compiled-SQL test above and by the integration test.
    rigSelect([commandRow()]);
    rigSelect([{ one: 1 }]);
    expect(await logsNotArriving(DEVICE_ID, NOW, CANARY_CAPABLE)).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});
