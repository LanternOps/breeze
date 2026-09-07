import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #5128 — the reaper's TWO CLOCKS.
 *
 * `pending` rows carrying a `deliver_by` are on the DELIVERY clock and expire
 * at that instant, no matter what their execution timeout says. Legacy
 * `pending` rows (`deliver_by IS NULL`) and every `sent` row stay on the
 * EXECUTION clock exactly as before. Every terminal UPDATE is a CAS on the
 * OBSERVED `(status, executed_at)`, never `status IN ('pending','sent')`.
 *
 * Kept in its own file so the mock surface can stay small and the CAS/clock
 * assertions read without the 1,000-line fixture set of staleCommandReaper.test.ts.
 */

const {
  selectMock,
  updateMock,
  deviceCommandsTable,
  applyAutomationActionTerminalMock,
  captureExceptionMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  deviceCommandsTable: {
    id: 'device_commands.id',
    type: 'device_commands.type',
    status: 'device_commands.status',
    payload: 'device_commands.payload',
    createdAt: 'device_commands.created_at',
    executedAt: 'device_commands.executed_at',
    completedAt: 'device_commands.completed_at',
    deliverBy: 'device_commands.deliver_by',
    submittedOrgId: 'device_commands.submitted_org_id',
    result: 'device_commands.result',
    deviceId: 'device_commands.device_id',
    uninstallReasons: 'device_commands.uninstall_reasons',
    deviceRemoveExpiresAt: 'device_commands.device_remove_expires_at',
  },
  applyAutomationActionTerminalMock: vi.fn().mockResolvedValue(true),
  captureExceptionMock: vi.fn(),
}));

vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      select: (...args: unknown[]) => selectMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
  };
});

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return { ...actual, deviceCommands: deviceCommandsTable };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

vi.mock('../services/automationActionResults', () => ({
  applyAutomationActionTerminal: (...args: unknown[]) =>
    applyAutomationActionTerminalMock(...(args as [])),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { reapStaleDeviceCommands } from './staleCommandReaper';

/**
 * The mocked `deviceCommands` columns are plain strings, not Drizzle Column
 * instances, so they compile to BOUND PARAMETERS. That is what makes the exact
 * shape of a WHERE clause assertable here (the same technique the sibling
 * staleCommandReaper.test.ts uses for the device-remove drain arm).
 */
function compile(whereArg: unknown) {
  return new PgDialect().sqlToQuery(whereArg as never);
}

function selectChain(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

type UpdateChain = {
  set: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
};

function updateChain(returning: unknown): UpdateChain {
  const chain = {} as UpdateChain;
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(async () => returning);
  return chain;
}

/**
 * Routes `db.update(...)` by TABLE. Only the `device_commands` writes belong to
 * the reaper's own terminal CAS; `propagateTimedOutDeviceCommand` issues
 * further UPDATEs (script_executions, deployment_results, restore_jobs) that
 * would otherwise land on the same spy and make the counts meaningless.
 */
function routeUpdates(returning: unknown): { command: UpdateChain; other: UpdateChain } {
  const command = updateChain(returning);
  const other = updateChain([]);
  updateMock.mockImplementation((table: unknown) => (table === deviceCommandsTable ? command : other));
  return { command, other };
}

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A script command whose EXECUTION timeout (300 s + 5 min grace) lapsed an hour ago. */
const scriptRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  type: 'script',
  payload: { timeoutSeconds: 300 },
  status: 'pending',
  createdAt: new Date(NOW - HOUR),
  executedAt: null,
  deliverBy: null,
  ...over,
});

describe('reapStaleDeviceCommands — two clocks (#5128)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyAutomationActionTerminalMock.mockResolvedValue(true);
  });

  it('a pending row with a FUTURE deliver_by is not reaped even though its execution timeout lapsed', async () => {
    selectMock.mockReturnValue(selectChain([scriptRow({ deliverBy: new Date(NOW + 6 * DAY) })]));
    const reaped = await reapStaleDeviceCommands();
    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('a pending row past deliver_by is failed with expired / not_delivered_before_deadline', async () => {
    const deliverBy = new Date(NOW - 1000);
    selectMock.mockReturnValue(selectChain([scriptRow({ deliverBy })]));
    const { command: update } = routeUpdates([{ id: 'c1' }]);

    const reaped = await reapStaleDeviceCommands();

    expect(reaped).toBe(1);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        result: expect.objectContaining({
          status: 'expired',
          reason: 'not_delivered_before_deadline',
          timedOutBy: 'server',
        }),
      })
    );
    const setArg = update.set.mock.calls[0]![0] as { result: { error: string } };
    expect(setArg.result.error).toContain(deliverBy.toISOString());
    expect(setArg.result.error).toContain('never delivered');
  });

  it('a legacy pending row (deliver_by NULL) keeps the created_at + execution-timeout rule', async () => {
    selectMock.mockReturnValue(selectChain([scriptRow({ deliverBy: null })]));
    const { command: update } = routeUpdates([{ id: 'c1' }]);

    expect(await reapStaleDeviceCommands()).toBe(1);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ status: 'timeout' }) })
    );
    const setArg = update.set.mock.calls[0]![0] as { result: { error: string; reason?: string } };
    expect(setArg.result.error).toContain('agent never received the command');
    expect(setArg.result.reason).toBeUndefined();
  });

  it('a legacy pending row still inside its execution timeout is left alone', async () => {
    selectMock.mockReturnValue(
      selectChain([scriptRow({ deliverBy: null, createdAt: new Date(NOW - 60_000) })])
    );
    expect(await reapStaleDeviceCommands()).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('a sent row still measures from executed_at, and a deliver_by does not shorten it', async () => {
    // The delivery clock stops at the claim: once a row is `sent`, only the
    // execution timeout applies, even though deliver_by has since passed.
    selectMock.mockReturnValue(
      selectChain([
        scriptRow({
          status: 'sent',
          executedAt: new Date(NOW - 60_000),
          deliverBy: new Date(NOW - 30 * 60 * 1000),
        }),
      ])
    );
    expect(await reapStaleDeviceCommands()).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('a sent row past its execution timeout is failed as timeout, not expired', async () => {
    const executedAt = new Date(NOW - HOUR);
    selectMock.mockReturnValue(
      selectChain([scriptRow({ status: 'sent', executedAt, deliverBy: new Date(NOW - 2 * HOUR) })])
    );
    const { command: update } = routeUpdates([{ id: 'c1' }]);

    expect(await reapStaleDeviceCommands()).toBe(1);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ status: 'timeout' }) })
    );
    const setArg = update.set.mock.calls[0]![0] as { result: { error: string } };
    expect(setArg.result.error).toContain('no response from agent');
  });

  it('the terminal UPDATE is a CAS on the observed pending status, never IN (pending, sent)', async () => {
    selectMock.mockReturnValue(selectChain([scriptRow({ deliverBy: new Date(NOW - 1000) })]));
    const { command: update } = routeUpdates([{ id: 'c1' }]);

    await reapStaleDeviceCommands();

    const { sql: sqlText, params } = compile(update.where.mock.calls[0]![0]);
    expect(params).toEqual(['device_commands.id', 'c1', 'device_commands.status', 'pending']);
    expect(sqlText).toContain('and');
    // The old guard. If this ever comes back, a row claimed between the SELECT
    // and the UPDATE gets failed the instant it was delivered.
    expect(sqlText).not.toMatch(/ in \(/i);
  });

  it('the terminal UPDATE for a sent row fences on the observed executed_at', async () => {
    const executedAt = new Date(NOW - HOUR);
    selectMock.mockReturnValue(selectChain([scriptRow({ status: 'sent', executedAt })]));
    const { command: update } = routeUpdates([{ id: 'c1' }]);

    await reapStaleDeviceCommands();

    const { sql: sqlText, params } = compile(update.where.mock.calls[0]![0]);
    expect(params).toEqual([
      'device_commands.id',
      'c1',
      'device_commands.status',
      'sent',
      'device_commands.executed_at',
      executedAt,
    ]);
    expect(sqlText).not.toMatch(/ in \(/i);
  });

  it('a CAS that matches zero rows (claimed under us) is not counted and does not propagate', async () => {
    selectMock.mockReturnValue(selectChain([scriptRow({ deliverBy: new Date(NOW - 1000) })]));
    routeUpdates([]);

    expect(await reapStaleDeviceCommands()).toBe(0);
    expect(applyAutomationActionTerminalMock).not.toHaveBeenCalled();
  });

  it('mixes the two clocks in one batch: only the genuinely due rows are reaped', async () => {
    selectMock.mockReturnValue(
      selectChain([
        scriptRow({ id: 'due-delivery', deliverBy: new Date(NOW - 1000) }),
        scriptRow({ id: 'waiting', deliverBy: new Date(NOW + 6 * DAY) }),
        scriptRow({ id: 'due-legacy', deliverBy: null }),
        scriptRow({
          id: 'sent-fresh',
          status: 'sent',
          executedAt: new Date(NOW - 60_000),
          deliverBy: null,
        }),
      ])
    );
    const { command: update } = routeUpdates([{ id: 'x' }]);

    expect(await reapStaleDeviceCommands()).toBe(2);
    expect(update.set).toHaveBeenCalledTimes(2);
    const statuses = update.set.mock.calls.map(
      (c) => (c[0] as { result: { status: string } }).result.status
    );
    expect(statuses).toEqual(['expired', 'timeout']);
  });

  it('propagates the delivery expiry with kind="expired" so owning records can distinguish it', async () => {
    selectMock.mockReturnValue(
      selectChain([
        scriptRow({ deliverBy: new Date(NOW - 1000), payload: { executionId: 'exec-1' } }),
      ])
    );
    // One update chain serves the terminal command UPDATE and every propagation
    // UPDATE; only the first is asserted here.
    const { command: update } = routeUpdates([{ id: 'c1' }]);

    expect(await reapStaleDeviceCommands()).toBe(1);
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'reaper', commandId: 'c1', terminalStatus: 'timed_out' })
    );
  });
  // ── Legacy software_install keeps its retired 7-day queue wait ──────────
  //
  // #5128 folded `software_install` into the 2-hour LONG_TIMEOUT_TYPES tier
  // because its queue wait is now a `deliver_by` deadline. Rows written before
  // the 2026-10-13 migration have no deadline and fall into the legacy branch,
  // where the EXECUTION timeout doubles as the queue wait — so without the
  // carve-out the first reaper pass after deploy would fail a week's worth of
  // legitimately-waiting installs as "agent never received the command".

  const legacyInstall = (over: Record<string, unknown> = {}) => ({
    id: 'si-1',
    type: 'software_install',
    payload: {},
    status: 'pending',
    createdAt: new Date(NOW - 3 * HOUR),
    executedAt: null,
    deliverBy: null,
    ...over,
  });

  it('a legacy pending software_install 3 hours old is NOT reaped, despite the 2 h execution timeout', async () => {
    selectMock.mockReturnValue(selectChain([legacyInstall()]));
    expect(await reapStaleDeviceCommands()).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('a legacy pending software_install 8 days old IS reaped, as a timeout', async () => {
    selectMock.mockReturnValue(selectChain([legacyInstall({ createdAt: new Date(NOW - 8 * DAY) })]));
    const { command: update } = routeUpdates([{ id: 'si-1' }]);

    expect(await reapStaleDeviceCommands()).toBe(1);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ status: 'timeout' }) })
    );
    const setArg = update.set.mock.calls[0]![0] as { result: { error: string } };
    expect(setArg.result.error).toContain('agent never received the command');
    // The message reports the clock that was actually applied (7 days), not the
    // 2-hour execution timeout that would have been used without the carve-out.
    expect(setArg.result.error).toContain(`${7 * 24 * 60} min`);
  });

  it('the 7-day carve-out applies ONLY to the legacy branch: a software_install with a deliver_by still expires on it', async () => {
    const deliverBy = new Date(NOW - 1000);
    selectMock.mockReturnValue(selectChain([legacyInstall({ deliverBy, createdAt: new Date(NOW - HOUR) })]));
    const { command: update } = routeUpdates([{ id: 'si-1' }]);

    expect(await reapStaleDeviceCommands()).toBe(1);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ reason: 'not_delivered_before_deadline' }),
      })
    );
  });

  it('the carve-out does not leak to other types: a legacy script row still uses its own timeout', async () => {
    selectMock.mockReturnValue(selectChain([scriptRow({ deliverBy: null })]));
    routeUpdates([{ id: 'c1' }]);
    expect(await reapStaleDeviceCommands()).toBe(1);
  });
});
