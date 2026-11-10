import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every vendor update alert must go through createAlert (cooldown, dedupe,
// notifications, automations), never a bare insert into `alerts` (#5241).

const dbState = vi.hoisted(() => ({
  selects: [] as unknown[][],
  inserts: [] as Array<{ values: Record<string, unknown> }>,
}));

vi.mock('../../db', () => {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {
      from: () => c,
      where: () => c,
      innerJoin: () => c,
      orderBy: () => c,
      limit: () => Promise.resolve(rows),
      then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
    };
    return c;
  };
  return {
    db: {
      select: vi.fn(() => chain(dbState.selects.shift() ?? [])),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => {
          dbState.inserts.push({ values });
          return { returning: () => Promise.resolve([{ id: 'template-1' }]) };
        },
      })),
    },
    runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    getCurrentDbAccessContext: vi.fn(() => null),
  };
});

vi.mock('../alertService', () => ({
  createAlert: vi.fn(async () => 'alert-1'),
  resolveAlert: vi.fn(async () => true),
  RESOLVABLE_ALERT_STATUSES: ['active', 'acknowledged', 'suppressed'],
}));

vi.mock('../builtInAlertRules', () => ({
  insertBuiltInAlertRule: vi.fn(async () => 'rule-new'),
}));

vi.mock('../featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn(async () => ({ active: false, suppressAlerts: false })),
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { db } from '../../db';
import { createAlert, resolveAlert } from '../alertService';
import { insertBuiltInAlertRule } from '../builtInAlertRules';
import { checkDeviceMaintenanceWindow } from '../featureConfigResolver';
import {
  OEM_UPDATES_ALERT_SOURCE,
  emitDeviceNotReturnedAlert,
  emitProtectionStillSuspendedAlert,
  resolveProtectionRestoredAlerts,
  resolveReturnedDeviceAlerts,
} from './alerts';

const startedAt = new Date('2027-01-20T01:00:00.000Z');

beforeEach(() => {
  dbState.selects = [];
  dbState.inserts = [];
  vi.mocked(createAlert).mockClear();
  vi.mocked(createAlert).mockResolvedValue('alert-1');
  vi.mocked(resolveAlert).mockClear();
  vi.mocked(resolveAlert).mockResolvedValue(true);
  vi.mocked(insertBuiltInAlertRule).mockClear();
  vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: false, suppressAlerts: false } as never);
});

describe('emitDeviceNotReturnedAlert', () => {
  it('goes through createAlert on the existing org rule, never a bare insert', async () => {
    dbState.selects = [[{ hostname: 'host-1' }], [{ id: 'rule-1' }]];

    const id = await emitDeviceNotReturnedAlert({ deviceId: 'd1', orgId: 'o1', commandId: 'c1', startedAt });

    expect(id).toBe('alert-1');
    expect(createAlert).toHaveBeenCalledTimes(1);
    const params = vi.mocked(createAlert).mock.calls[0]![0];
    expect(params).toMatchObject({ ruleId: 'rule-1', deviceId: 'd1', orgId: 'o1', severity: 'critical' });
    expect(params.title).toContain('host-1');
    expect(params.context).toMatchObject({
      source: OEM_UPDATES_ALERT_SOURCE,
      commandId: 'c1',
      startedAt: startedAt.toISOString(),
    });
    expect(dbState.inserts).toEqual([]);
  });

  it('creates the org rule on first fire under the built-in source', async () => {
    dbState.selects = [[{ hostname: 'host-1' }], [], []];

    await emitDeviceNotReturnedAlert({ deviceId: 'd1', orgId: 'o1', commandId: 'c1', startedAt });

    expect(insertBuiltInAlertRule).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o1',
      overrideSettings: { source: 'oem-updates' },
    }));
    expect(vi.mocked(createAlert).mock.calls[0]![0].ruleId).toBe('rule-new');
  });

  it('stays quiet while a maintenance window suppresses alerts', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: true, suppressAlerts: true } as never);

    const id = await emitDeviceNotReturnedAlert({ deviceId: 'd1', orgId: 'o1', commandId: 'c1', startedAt });

    expect(id).toBeNull();
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('reads the maintenance window inside the system context: a worker has none of its own', async () => {
    const { withSystemDbAccessContext, getCurrentDbAccessContext } = await import('../../db');
    let inSystem = false;
    vi.mocked(getCurrentDbAccessContext).mockReturnValue(null as never);
    vi.mocked(withSystemDbAccessContext).mockImplementationOnce((async (fn: () => Promise<unknown>) => {
      inSystem = true;
      try { return await fn(); } finally { inSystem = false; }
    }) as never);
    let seenInSystem: boolean | null = null;
    vi.mocked(checkDeviceMaintenanceWindow).mockImplementationOnce((async () => {
      seenInSystem = inSystem;
      return { active: true, suppressAlerts: true };
    }) as never);

    await emitDeviceNotReturnedAlert({ deviceId: 'd1', orgId: 'o1', commandId: 'c1', startedAt });

    expect(seenInSystem).toBe(true);
  });

  it('propagates a failure so the monitor retries on the next tick', async () => {
    dbState.selects = [[{ hostname: 'host-1' }], [{ id: 'rule-1' }]];
    vi.mocked(createAlert).mockRejectedValue(new Error('boom'));

    await expect(
      emitDeviceNotReturnedAlert({ deviceId: 'd1', orgId: 'o1', commandId: 'c1', startedAt }),
    ).rejects.toThrow('boom');
  });
});

describe('emitProtectionStillSuspendedAlert', () => {
  it('goes through createAlert with its own rule', async () => {
    dbState.selects = [[{ hostname: 'host-1' }], [{ id: 'rule-2' }]];

    await emitProtectionStillSuspendedAlert({ deviceId: 'd1', orgId: 'o1', commandId: 'c1' });

    const params = vi.mocked(createAlert).mock.calls[0]![0];
    expect(params.ruleId).toBe('rule-2');
    expect(params.severity).toBe('high');
    expect(params.title).toContain('BitLocker');
    expect(params.context).toMatchObject({ source: OEM_UPDATES_ALERT_SOURCE, commandId: 'c1' });
  });
});

describe('resolve helpers', () => {
  it('resolves each open not-returned alert with a recovery reason', async () => {
    dbState.selects = [[{ id: 'a1' }, { id: 'a2' }]];

    await expect(resolveReturnedDeviceAlerts(['d1', 'd2'])).resolves.toBe(2);

    expect(resolveAlert).toHaveBeenCalledTimes(2);
    expect(vi.mocked(resolveAlert).mock.calls[0]).toEqual([
      'a1',
      expect.stringContaining('checked in'),
      undefined,
      false,
      'condition_cleared',
    ]);
  });

  it('does not query for an empty device list', async () => {
    vi.mocked(db.select).mockClear();
    await expect(resolveReturnedDeviceAlerts([])).resolves.toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('one failed resolve does not strand the rest of the batch, and then surfaces so the caller retries', async () => {
    dbState.selects = [[{ id: 'a1' }, { id: 'a2' }]];
    vi.mocked(resolveAlert).mockRejectedValueOnce(new Error('boom'));

    await expect(resolveReturnedDeviceAlerts(['d1'])).rejects.toThrow(/1 of 2/);
    expect(resolveAlert).toHaveBeenCalledTimes(2);
  });

  it('resolves the protection alert once protection is back', async () => {
    dbState.selects = [[{ id: 'a3' }]];

    await expect(resolveProtectionRestoredAlerts('d1')).resolves.toBe(1);

    expect(vi.mocked(resolveAlert).mock.calls[0]![0]).toBe('a3');
  });
});
