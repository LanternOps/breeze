import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  where: null as unknown,
  selects: 0,
  failUpdateFor: null as string | null,
}));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: (condition: unknown) => {
      state.where = condition;
      return chain;
    },
    orderBy: () => chain,
    limit: () => Promise.resolve(state.rows),
  };
  return {
    db: {
      select: vi.fn(() => {
        state.selects++;
        return chain;
      }),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            state.updates.push(values);
            return Promise.resolve();
          },
        }),
      })),
    },
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('bullmq', () => ({ Worker: vi.fn(), Queue: vi.fn(), Job: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/oemUpdates/alerts', () => ({
  emitDeviceNotReturnedAlert: vi.fn(async () => 'alert-1'),
  resolveReturnedDeviceAlerts: vi.fn(async () => 0),
}));
// The monitor alone: the other stages have oemUpdatesWorker.dispatch.test.ts.
vi.mock('../services/oemUpdates/candidates', () => ({
  decideScheduledRun: vi.fn(),
  maxDispatchPerTick: vi.fn(() => 200),
  selectDueDevices: vi.fn(async () => []),
}));
vi.mock('../services/oemUpdates/dispatch', () => ({ dispatchOemUpdateRun: vi.fn() }));
vi.mock('../services/oemUpdates/resolver', () => ({ resolveOemUpdatesLinkForDevice: vi.fn() }));
vi.mock('../services/oemUpdates/rebootSweep', () => ({ runOemRebootSweep: vi.fn(async () => undefined) }));
vi.mock('../services/oemUpdates/overdueSweep', () => ({ runOemOverdueSweep: vi.fn(async () => undefined) }));
vi.mock('../services/oemUpdates/releaseSweep', () => ({ runOemReleaseSweep: vi.fn(async () => undefined) }));

import { captureException } from '../services/sentry';
import { emitDeviceNotReturnedAlert, resolveReturnedDeviceAlerts } from '../services/oemUpdates/alerts';
import { db } from '../db';
import { runOemUpdatesTick } from './oemUpdatesWorker';

const HOUR = 60 * 60 * 1000;
const now = new Date('2027-01-21T02:00:00.000Z');
const started = new Date(now.getTime() - 25 * HOUR);

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: 'd1',
    orgId: 'org-current',
    deviceStatus: 'offline',
    lastSeenAt: new Date(started.getTime() + 30 * 60 * 1000),
    runStartedAt: started,
    returnDeadlineAt: new Date(started.getTime() + 24 * HOUR),
    notReturnedAlertedAt: null,
    rebootRequired: false,
    lastCommandId: 'c1',
    commandStatus: 'sent',
    commandExecutedAt: started,
    ...overrides,
  };
}

beforeEach(() => {
  state.rows = [];
  state.updates = [];
  state.where = null;
  state.selects = 0;
  vi.mocked(emitDeviceNotReturnedAlert).mockClear();
  vi.mocked(emitDeviceNotReturnedAlert).mockResolvedValue('alert-1');
  vi.mocked(resolveReturnedDeviceAlerts).mockClear();
  vi.mocked(captureException).mockClear();
});

describe('runOemUpdatesTick: the not-returned monitor', () => {
  it('exits early when no row has a deadline due', async () => {
    await runOemUpdatesTick(now);
    expect(state.selects).toBe(1);
    expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('excludes ephemeral and parked devices and picks only due deadlines', async () => {
    await runOemUpdatesTick(now);
    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.sql).toContain('"is_ephemeral"');
    expect(query.sql).toContain("'unassigned_pool'");
    expect(query.sql).toContain('"return_deadline_at" is not null');
    expect(query.sql).toContain('"return_deadline_at" <=');
  });

  it('no check-in 24 h after a bios run raises the alert once', async () => {
    state.rows = [row()];
    await runOemUpdatesTick(now);
    expect(emitDeviceNotReturnedAlert).toHaveBeenCalledTimes(1);
    expect(emitDeviceNotReturnedAlert).toHaveBeenCalledWith({
      deviceId: 'd1',
      orgId: 'org-current',
      commandId: 'c1',
      startedAt: started,
    });
    expect(state.updates).toEqual([expect.objectContaining({ notReturnedAlertedAt: now })]);

    vi.mocked(emitDeviceNotReturnedAlert).mockClear();
    state.updates = [];
    state.rows = [row({ notReturnedAlertedAt: now })];
    await runOemUpdatesTick(new Date(now.getTime() + 10 * 60 * 1000));
    expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('a check-in clears the deadline and resolves the alert', async () => {
    const alertedAt = new Date(now.getTime() - HOUR);
    state.rows = [row({ notReturnedAlertedAt: alertedAt, lastSeenAt: new Date(alertedAt.getTime() + 60_000) })];
    await runOemUpdatesTick(now);
    expect(state.updates).toEqual([expect.objectContaining({ returnDeadlineAt: null, notReturnedAlertedAt: null })]);
    expect(resolveReturnedDeviceAlerts).toHaveBeenCalledWith(['d1']);
    expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
  });

  it('a device moved mid-monitor raises in its current org', async () => {
    state.rows = [row({ orgId: 'org-moved-to' })];
    await runOemUpdatesTick(now);
    expect(vi.mocked(emitDeviceNotReturnedAlert).mock.calls[0]![0].orgId).toBe('org-moved-to');
  });

  it('heartbeats from during the run do not count as coming back', async () => {
    state.rows = [row({ lastSeenAt: new Date(started.getTime() + 90 * 60 * 1000) })];
    await runOemUpdatesTick(now);
    expect(emitDeviceNotReturnedAlert).toHaveBeenCalledTimes(1);
  });

  it('a check-in after the run window, then offline at the deadline, is not an alert', async () => {
    state.rows = [row({ lastSeenAt: new Date(started.getTime() + 3 * HOUR) })];
    await runOemUpdatesTick(now);
    expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
    expect(state.updates).toEqual([expect.objectContaining({ returnDeadlineAt: null })]);
  });

  it('coming back resolves any open alert even when the marker write was lost', async () => {
    state.rows = [row({ deviceStatus: 'online', notReturnedAlertedAt: null })];
    await runOemUpdatesTick(now);
    expect(resolveReturnedDeviceAlerts).toHaveBeenCalledWith(['d1']);
  });

  it('a failed resolve keeps the row armed, so the next tick tries again', async () => {
    const alertedAt = new Date(now.getTime() - HOUR);
    vi.mocked(resolveReturnedDeviceAlerts).mockRejectedValueOnce(new Error('boom'));
    state.rows = [row({ notReturnedAlertedAt: alertedAt, lastSeenAt: new Date(alertedAt.getTime() + 60_000) })];
    await expect(runOemUpdatesTick(now)).resolves.toBeUndefined();
    expect(state.updates).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('online at the deadline is back, even with no result', async () => {
    state.rows = [row({ deviceStatus: 'online' })];
    await runOemUpdatesTick(now);
    expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
    expect(state.updates).toEqual([expect.objectContaining({ returnDeadlineAt: null })]);
  });

  it('online with the flash restart still owed keeps watching: the held restart is what applies it', async () => {
    state.rows = [row({ deviceStatus: 'online', rebootRequired: true })];
    await runOemUpdatesTick(now);
    expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
    expect(resolveReturnedDeviceAlerts).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('leaves out decommissioned devices and pages by device', async () => {
    await runOemUpdatesTick(now);
    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.sql).toContain('"devices"."status" <>');
    expect(query.params).toContain('decommissioned');
  });

  it('a reboot still owed and offline at the deadline raises, whatever it reported before', async () => {
    state.rows = [row({ rebootRequired: true, lastSeenAt: new Date(started.getTime() + 20 * HOUR) })];
    await runOemUpdatesTick(now);
    expect(emitDeviceNotReturnedAlert).toHaveBeenCalledTimes(1);
  });

  it('a run that was never delivered disarms without an alert', async () => {
    for (const commandStatus of ['cancelled', 'failed', 'timeout']) {
      state.updates = [];
      state.rows = [row({ commandStatus, commandExecutedAt: null })];
      await runOemUpdatesTick(now);
      expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
      expect(state.updates).toEqual([expect.objectContaining({ returnDeadlineAt: null })]);
    }
  });

  it('a command row that has gone disarms without an alert', async () => {
    state.rows = [row({ commandStatus: null, commandExecutedAt: null })];
    await runOemUpdatesTick(now);
    expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
    expect(state.updates).toEqual([expect.objectContaining({ returnDeadlineAt: null })]);
  });

  it('a run still waiting to be delivered waits', async () => {
    state.rows = [row({ commandStatus: 'pending', commandExecutedAt: null })];
    await runOemUpdatesTick(now);
    expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('the 24 h clock runs from delivery, not dispatch', async () => {
    state.rows = [row({ commandExecutedAt: new Date(now.getTime() - 20 * HOUR) })];
    await runOemUpdatesTick(now);
    expect(emitDeviceNotReturnedAlert).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it('an alert that was not raised leaves the marker unset, to retry next tick', async () => {
    vi.mocked(emitDeviceNotReturnedAlert).mockResolvedValue(null);
    state.rows = [row()];
    await runOemUpdatesTick(now);
    expect(state.updates).toEqual([]);
  });

  it('a tick that throws for one device continues with the next', async () => {
    vi.mocked(emitDeviceNotReturnedAlert)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('alert-2');
    state.rows = [row({ deviceId: 'd1' }), row({ deviceId: 'd2' })];
    await expect(runOemUpdatesTick(now)).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(emitDeviceNotReturnedAlert).toHaveBeenCalledTimes(2);
    expect(state.updates).toHaveLength(1);
  });
});
