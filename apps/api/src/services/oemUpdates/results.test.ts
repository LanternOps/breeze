import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  command: null as Record<string, unknown> | null,
  device: null as Record<string, unknown> | null,
  status: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  failReads: false,
  afterCommit: [] as Promise<unknown>[],
}));

vi.mock('../../db', () => {
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {
      from: () => c,
      leftJoin: () => c,
      innerJoin: () => c,
      where: () => c,
      limit: () => {
        if (state.failReads) return Promise.reject(new Error('db down'));
        return Promise.resolve(rows());
      },
    };
    return c;
  };
  return {
    db: {
      select: vi.fn((shape: Record<string, unknown>) => {
        if ('type' in shape) return chain(() => (state.command ? [state.command] : []));
        if ('hardwareModel' in shape) return chain(() => (state.device ? [state.device] : []));
        return chain(() => (state.status ? [state.status] : []));
      }),
      update: vi.fn(() => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            state.updates.push(values);
            return Promise.resolve();
          },
        }),
      })),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoNothing: () => {
            state.inserts.push(values);
            return Promise.resolve();
          },
        }),
      })),
    },
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
    // Runs the work after "commit"; collected so a test can await it.
    runAfterDbContextCommit: vi.fn((_label: string, work: () => unknown) => {
      state.afterCommit.push(Promise.resolve().then(work));
    }),
  };
});

vi.mock('../patchRebootHandler', () => ({
  resolveRebootPlan: vi.fn(async () => ({
    delayMinutes: 30,
    deferral: { allowDeferral: true, maxDeferrals: 2, deferralMinutes: 60 },
    promptText: { title: 'Restart' },
  })),
  executeReboot: vi.fn(async () => ({ success: true, delayMinutes: 30 })),
}));

vi.mock('./alerts', () => ({
  emitProtectionStillSuspendedAlert: vi.fn(async () => 'alert-1'),
  resolveProtectionRestoredAlerts: vi.fn(async () => 0),
  resolveReturnedDeviceAlerts: vi.fn(async () => 0),
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { captureException } from '../sentry';
import {
  emitProtectionStillSuspendedAlert,
  resolveProtectionRestoredAlerts,
  resolveReturnedDeviceAlerts,
} from './alerts';
import { applyOemUpdateRelease, applyOemUpdateResult, applyOemUpdateVerification } from './results';
import { executeReboot, resolveRebootPlan } from '../patchRebootHandler';
import { runAfterDbContextCommit } from '../../db';
import { getLaneManifest } from './toolManifest';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '44444444-4444-4444-8444-444444444444';

function goodResult(overrides: Record<string, unknown> = {}) {
  return {
    lane: 'dell',
    outcome: 'success',
    toolVersion: '5.7.2',
    rawExitCode: 0,
    errorCode: null,
    rebootRequired: false,
    shutdownRequired: false,
    items: [
      { title: 'Driver A', category: 'driver', version: '1.0', result: 'installed' },
      { title: 'Driver B', category: 'driver', version: '1.1', result: 'installed' },
      { title: 'App C', category: 'application', version: '2.0', result: 'failed' },
      { title: 'App D', category: 'application', version: '2.1', result: 'skipped' },
    ],
    skippedCategories: [],
    takeover: 'not_attempted',
    ...overrides,
  };
}

function statusRow(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG_ID,
    lane: 'dell',
    lastCommandId: COMMAND_ID,
    firstCompletedAt: null,
    rebootPendingSince: null,
    returnDeadlineAt: null,
    biosVersionBefore: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.command = { id: COMMAND_ID, deviceId: DEVICE_ID, type: 'oem_update_run', payload: { categories: ['bios'] } };
  state.device = { orgId: ORG_ID, hardwareModel: 'Latitude 7420', hardwareBiosVersion: '1.20.0' };
  state.status = statusRow();
  state.updates = [];
  state.inserts = [];
  state.failReads = false;
  state.afterCommit = [];
  vi.mocked(runAfterDbContextCommit).mockClear();
  vi.mocked(executeReboot).mockClear();
  vi.mocked(executeReboot).mockResolvedValue({ success: true, delayMinutes: 30 });
  vi.mocked(resolveRebootPlan).mockClear();
  vi.mocked(captureException).mockClear();
  vi.mocked(emitProtectionStillSuspendedAlert).mockClear();
  vi.mocked(emitProtectionStillSuspendedAlert).mockResolvedValue('alert-1');
  vi.mocked(resolveProtectionRestoredAlerts).mockClear();
  vi.mocked(resolveReturnedDeviceAlerts).mockClear();
});

const apply = (result: unknown) => applyOemUpdateResult({ commandId: COMMAND_ID, deviceId: DEVICE_ID, result });

describe('applyOemUpdateResult', () => {
  it('stores the outcome, the counts and the tool version', async () => {
    await apply(goodResult());
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({
      lastOutcome: 'success',
      lastErrorCode: null,
      toolVersion: '5.7.2',
      installedCount: 2,
      failedCount: 1,
      rebootRequired: false,
      applicability: 'applicable',
    });
    expect(state.updates[0]!.lastSuccessAt).toBeInstanceOf(Date);
  });

  it.each([
    ['null', null],
    ['text', 'not json'],
    ['an unknown key', { ...goodResult(), extra: 1 }],
    ['an unknown outcome', goodResult({ outcome: 'great' })],
    ['201 items', goodResult({ items: Array.from({ length: 201 }, () => ({ title: 't', category: 'driver', version: '1', result: 'skipped' })) })],
    ['a lane other than the one that was sent', goodResult({ lane: 'hp' })],
  ])('a malformed result (%s) stores failed with result_unparseable, never throws', async (_name, result) => {
    await expect(apply(result)).resolves.toBeUndefined();
    expect(state.updates[0]).toMatchObject({
      lastOutcome: 'failed',
      lastErrorCode: 'result_unparseable',
      installedCount: 0,
      failedCount: 0,
    });
    expect(state.updates[0]).not.toHaveProperty('lastSuccessAt');
    expect(state.updates[0]).not.toHaveProperty('firstCompletedAt');
  });

  it('never throws on a database fault', async () => {
    state.failReads = true;
    await expect(apply(goodResult())).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("a result naming another device's command is ignored", async () => {
    state.command = { id: COMMAND_ID, deviceId: OTHER_DEVICE_ID, type: 'oem_update_run' };
    await apply(goodResult());
    expect(state.updates).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it('a result naming a command that does not exist is ignored', async () => {
    state.command = null;
    await apply(goodResult());
    expect(state.updates).toEqual([]);
  });

  it('a result for another command type is ignored', async () => {
    state.command = { id: COMMAND_ID, deviceId: DEVICE_ID, type: 'script' };
    await apply(goodResult());
    expect(state.updates).toEqual([]);
  });

  it('a late result for an older run does not overwrite the newer one', async () => {
    state.status = statusRow({ lastCommandId: '99999999-9999-4999-8999-999999999999' });
    await apply(goodResult());
    expect(state.updates).toEqual([]);
  });

  it('with no row, creates one under the device org', async () => {
    state.status = null;
    await apply(goodResult());
    expect(state.inserts[0]).toMatchObject({ deviceId: DEVICE_ID, orgId: ORG_ID, lane: 'dell', applicability: 'applicable', lastCommandId: COMMAND_ID });
    expect(state.updates).toHaveLength(1);
  });

  describe('first_completed_at', () => {
    it('is set by the first run that finished', async () => {
      await apply(goodResult());
      expect(state.updates[0]!.firstCompletedAt).toBeInstanceOf(Date);
    });

    it('is set once', async () => {
      state.status = statusRow({ firstCompletedAt: new Date('2027-01-01T00:00:00.000Z') });
      await apply(goodResult());
      expect(state.updates[0]).not.toHaveProperty('firstCompletedAt');
    });

    it.each(['failed', 'blocked_on_battery', 'retry_later', 'not_supported', 'tool_unavailable'])(
      'is not set by %s',
      async (outcome) => {
        await apply(goodResult({ outcome }));
        expect(state.updates[0]).not.toHaveProperty('firstCompletedAt');
      },
    );
  });

  describe('not_supported', () => {
    it('is sticky to the tool version the manifest asked for and the model', async () => {
      await apply(goodResult({ outcome: 'not_supported', toolVersion: '5.7.1' }));
      expect(state.updates[0]).toMatchObject({
        applicability: 'not_supported',
        lastOutcome: 'not_supported',
        toolVersion: '5.7.1',
        notSupportedToolVersion: getLaneManifest('dell').tool!.version,
        notSupportedModel: 'Latitude 7420',
      });
    });

    it('clears once the tool says something else', async () => {
      state.status = statusRow({ applicability: 'not_supported', notSupportedToolVersion: '5.7.1', notSupportedModel: 'X' });
      await apply(goodResult());
      expect(state.updates[0]).toMatchObject({
        applicability: 'applicable',
        notSupportedToolVersion: null,
        notSupportedModel: null,
      });
    });
  });

  describe('reboot state', () => {
    it('a reboot required starts the pending clock', async () => {
      await apply(goodResult({ outcome: 'success_reboot_required', rebootRequired: true }));
      expect(state.updates[0]!.rebootRequired).toBe(true);
      expect(state.updates[0]!.rebootPendingSince).toBeInstanceOf(Date);
    });

    it('keeps the clock already running', async () => {
      state.status = statusRow({ rebootPendingSince: new Date('2027-01-01T00:00:00.000Z') });
      await apply(goodResult({ outcome: 'success_reboot_required', rebootRequired: true }));
      expect(state.updates[0]).not.toHaveProperty('rebootPendingSince');
    });

    it('blocked_reboot_pending starts it too, so it never reads as failing', async () => {
      await apply(goodResult({ outcome: 'blocked_reboot_pending' }));
      expect(state.updates[0]!.rebootPendingSince).toBeInstanceOf(Date);
    });

    it('a shutdown request is not a reboot', async () => {
      await apply(goodResult({ shutdownRequired: true }));
      expect(state.updates[0]!.rebootRequired).toBe(false);
      expect(state.updates[0]!.rebootPendingSince).toBeNull();
    });

    it('a clean run clears the clock', async () => {
      state.status = statusRow({ rebootPendingSince: new Date('2027-01-01T00:00:00.000Z') });
      await apply(goodResult());
      expect(state.updates[0]!.rebootPendingSince).toBeNull();
    });
  });

  describe('the not-returned monitor', () => {
    const armed = () => statusRow({ returnDeadlineAt: new Date('2027-01-02T00:00:00.000Z'), runStartedAt: new Date('2027-01-01T00:00:00.000Z') });

    it('a result with nothing left to reboot disarms it and resolves', async () => {
      state.status = armed();
      await apply(goodResult());
      expect(state.updates[0]).toMatchObject({ returnDeadlineAt: null, notReturnedAlertedAt: null });
      expect(resolveReturnedDeviceAlerts).toHaveBeenCalledWith([DEVICE_ID]);
    });

    it.each([
      ['a reboot', { rebootRequired: true }],
      ['a shutdown', { shutdownRequired: true }],
    ])('a result still waiting on %s stays armed: the flash lands at the restart', async (_name, extra) => {
      state.status = armed();
      await apply(goodResult(extra));
      expect(state.updates[0]).not.toHaveProperty('returnDeadlineAt');
      expect(resolveReturnedDeviceAlerts).not.toHaveBeenCalled();
    });

    it('a BIOS run blocked by a pending reboot flashed nothing: it disarms', async () => {
      state.status = armed();
      await apply(goodResult({ outcome: 'blocked_reboot_pending' }));
      expect(state.updates[0]).toMatchObject({ returnDeadlineAt: null, notReturnedAlertedAt: null });
      expect(state.updates[0]!.rebootPendingSince).toBeInstanceOf(Date);
      expect(resolveReturnedDeviceAlerts).toHaveBeenCalledWith([DEVICE_ID]);
    });

    it('a blocked BIOS run disarms even when the agent also reports the reboot it found', async () => {
      state.status = armed();
      await apply(goodResult({ outcome: 'blocked_reboot_pending', rebootRequired: true }));
      expect(state.updates[0]).toMatchObject({ returnDeadlineAt: null });
    });

    it('a BIOS run blocked by the reboot an earlier flash still owes stays armed', async () => {
      state.status = statusRow({
        returnDeadlineAt: new Date('2027-01-02T00:00:00.000Z'),
        rebootPendingSince: new Date('2027-01-01T00:00:00.000Z'),
      });
      await apply(goodResult({ outcome: 'blocked_reboot_pending' }));
      expect(state.updates[0]).not.toHaveProperty('returnDeadlineAt');
      expect(resolveReturnedDeviceAlerts).not.toHaveBeenCalled();
    });

    it('a driver-only run blocked by a pending reboot says nothing about an earlier flash: it stays armed', async () => {
      state.command = { id: COMMAND_ID, deviceId: DEVICE_ID, type: 'oem_update_run', payload: { categories: ['driver'] } };
      state.status = armed();
      await apply(goodResult({ outcome: 'blocked_reboot_pending' }));
      expect(state.updates[0]).not.toHaveProperty('returnDeadlineAt');
    });

    it('a malformed result stays armed: it is no evidence of anything', async () => {
      state.status = armed();
      await apply('garbage');
      expect(state.updates[0]).not.toHaveProperty('returnDeadlineAt');
    });

    it('an unarmed row does not touch alerts', async () => {
      await apply(goodResult());
      expect(resolveReturnedDeviceAlerts).not.toHaveBeenCalled();
    });
  });
});

describe('applyOemUpdateVerification', () => {
  const verify = (over: Record<string, unknown> = {}) => applyOemUpdateVerification({
    deviceId: DEVICE_ID,
    verification: { commandId: COMMAND_ID, bitlockerAfter: 'on', biosVersionAfter: '1.21.0', ...over } as never,
  });

  it('records the report and clears the monitor and the reboot clock', async () => {
    state.status = statusRow({ biosVersionBefore: '1.20.0', returnDeadlineAt: new Date(), rebootPendingSince: new Date() });
    await expect(verify()).resolves.toBe(true);
    expect(state.updates[0]).toMatchObject({
      bitlockerAfter: 'on',
      biosVersionAfter: '1.21.0',
      returnDeadlineAt: null,
      notReturnedAlertedAt: null,
      rebootRequired: false,
      rebootPendingSince: null,
    });
    expect(state.updates[0]!.verifiedAt).toBeInstanceOf(Date);
    expect(resolveReturnedDeviceAlerts).toHaveBeenCalledWith([DEVICE_ID]);
  });

  it('a BIOS version other than the one before the run is recorded next to it', async () => {
    state.status = statusRow({ biosVersionBefore: '1.20.0' });
    await verify({ biosVersionAfter: '1.99.0' });
    expect(state.updates[0]!.biosVersionAfter).toBe('1.99.0');
  });

  it('falls back to the inventory BIOS version when the agent reports none', async () => {
    await verify({ biosVersionAfter: null });
    expect(state.updates[0]!.biosVersionAfter).toBe('1.20.0');
  });

  it('suspended raises the alert (Decision 8), in the device org', async () => {
    await verify({ bitlockerAfter: 'suspended' });
    expect(emitProtectionStillSuspendedAlert).toHaveBeenCalledWith({ deviceId: DEVICE_ID, orgId: ORG_ID, commandId: COMMAND_ID });
    expect(resolveProtectionRestoredAlerts).not.toHaveBeenCalled();
  });

  it('on resolves it', async () => {
    await verify({ bitlockerAfter: 'on' });
    expect(emitProtectionStillSuspendedAlert).not.toHaveBeenCalled();
    expect(resolveProtectionRestoredAlerts).toHaveBeenCalledWith(DEVICE_ID);
  });

  it.each(['off', 'unknown'])('%s raises nothing and resolves nothing', async (bitlockerAfter) => {
    await verify({ bitlockerAfter });
    expect(emitProtectionStillSuspendedAlert).not.toHaveBeenCalled();
    expect(resolveProtectionRestoredAlerts).not.toHaveBeenCalled();
  });

  it('a failed alert surfaces to the caller, so the agent resends an idempotent report', async () => {
    vi.mocked(emitProtectionStillSuspendedAlert).mockRejectedValue(new Error('boom'));
    await expect(verify({ bitlockerAfter: 'suspended' })).rejects.toThrow('boom');
    expect(state.updates).toHaveLength(1);
  });

  it('a report for a run that is not the current one is ignored', async () => {
    state.status = statusRow({ lastCommandId: '99999999-9999-4999-8999-999999999999' });
    await expect(verify()).resolves.toBe(false);
    expect(state.updates).toEqual([]);
    expect(emitProtectionStillSuspendedAlert).not.toHaveBeenCalled();
  });

  it('a report with no status row is ignored', async () => {
    state.status = null;
    await expect(verify()).resolves.toBe(false);
  });
});

describe('reboot when finished (#11065 W04)', () => {
  const whenFinished = (over: Record<string, unknown> = {}) => {
    state.command = {
      id: COMMAND_ID,
      deviceId: DEVICE_ID,
      type: 'oem_update_run',
      submittedOrgId: ORG_ID,
      payload: { categories: ['bios'], trigger: 'on_demand', rebootControlled: true },
      ...over,
    };
  };
  const needsReboot = (over: Record<string, unknown> = {}) =>
    goodResult({ outcome: 'success_reboot_required', rebootRequired: true, ...over });
  const applied = async (result: unknown) => {
    await apply(result);
    await Promise.all(state.afterCommit);
  };

  it('when_finished then rebootRequired queues schedule_reboot with source oem_updates', async () => {
    whenFinished();
    await applied(needsReboot());
    expect(executeReboot).toHaveBeenCalledTimes(1);
    expect(executeReboot).toHaveBeenCalledWith(DEVICE_ID, expect.any(String), {
      // The patch policy's delay, deferral and prompt text.
      delayMinutes: 30,
      deferral: { allowDeferral: true, maxDeferrals: 2, deferralMinutes: 60 },
      promptText: { title: 'Restart' },
      expectedOrgId: ORG_ID,
      source: 'oem_updates',
      commitBeforeDelivery: true,
    });
  });

  it('waits for the result to commit: the reboot never rides the result transaction', async () => {
    whenFinished();
    await apply(needsReboot());
    expect(runAfterDbContextCommit).toHaveBeenCalledWith('oemUpdates.rebootWhenFinished', expect.any(Function));
    await Promise.all(state.afterCommit);
  });

  it('a result whose transaction never commits queues no reboot', async () => {
    whenFinished();
    // Rollback: the deferred work is dropped, never run.
    vi.mocked(runAfterDbContextCommit).mockImplementationOnce(() => undefined);
    await apply(needsReboot());
    await Promise.all(state.afterCommit);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('Dell exit 5 is a reboot the tech agreed to: blocked, and rebootRequired set', async () => {
    whenFinished();
    await applied(goodResult({ outcome: 'blocked_reboot_pending', rebootRequired: true, items: [] }));
    expect(executeReboot).toHaveBeenCalledTimes(1);
  });

  it('flash_guard_busy is not: a section or a power action is already going, so nothing reboots over it', async () => {
    whenFinished();
    await applied(goodResult({ outcome: 'blocked_reboot_pending', rebootRequired: false, errorCode: 'flash_guard_busy', items: [] }));
    expect(executeReboot).not.toHaveBeenCalled();
    expect(state.updates[0]!.rebootPendingSince).toBeInstanceOf(Date);
  });

  it('leave_to_me queues no reboot, and the clock still shows it is owed', async () => {
    whenFinished({ payload: { categories: ['driver'], trigger: 'on_demand', rebootControlled: false } });
    await applied(needsReboot());
    expect(executeReboot).not.toHaveBeenCalled();
    expect(state.updates[0]!.rebootPendingSince).toBeInstanceOf(Date);
  });

  it.each([
    ['nothing needs one', goodResult()],
    ['only a shutdown was asked for', goodResult({ shutdownRequired: true })],
    ['the result cannot be read', { rebootRequired: true }],
  ])('queues no reboot when %s', async (_label, result) => {
    whenFinished();
    await applied(result);
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('a scheduled run is not this path: the scheduler owns its reboots', async () => {
    whenFinished({ payload: { categories: ['bios'], trigger: 'scheduled', rebootControlled: true } });
    await applied(needsReboot());
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it.each([
    ['no payload', null],
    ['no reboot choice', { trigger: 'on_demand' }],
    ['a truthy string', { trigger: 'on_demand', rebootControlled: 'true' }],
  ])('an unreadable choice (%s) is not consent to restart', async (_label, payload) => {
    whenFinished({ payload });
    await applied(needsReboot());
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('a device moved mid-run gets no reboot: the consent was given under another org', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    whenFinished({ submittedOrgId: '99999999-9999-4999-8999-999999999999' });
    await applied(needsReboot());
    expect(executeReboot).not.toHaveBeenCalled();
    expect(state.updates[0]!.rebootPendingSince).toBeInstanceOf(Date);
    // The new owner sees a pending reboot with no run of theirs behind it, so the skip leaves a trace.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('moved'),
      expect.objectContaining({ commandId: COMMAND_ID, deviceId: DEVICE_ID, submittedOrgId: '99999999-9999-4999-8999-999999999999', orgId: ORG_ID }),
    );
    warn.mockRestore();
  });

  it('a row with no stamp gets no reboot', async () => {
    whenFinished({ submittedOrgId: null });
    await applied(needsReboot());
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('leave_to_me is a choice, not something to warn about', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    whenFinished({ payload: { categories: ['driver'], trigger: 'on_demand', rebootControlled: false } });
    await applied(needsReboot());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a superseded run queues no reboot', async () => {
    whenFinished();
    state.status = statusRow({ lastCommandId: '99999999-9999-4999-8999-999999999999' });
    await applied(needsReboot());
    expect(executeReboot).not.toHaveBeenCalled();
  });

  it('a refused reboot is reported, the result stands, and the row keeps showing it is owed', async () => {
    whenFinished();
    vi.mocked(executeReboot).mockResolvedValue({ success: false, error: 'trust denied' });
    await expect(applied(needsReboot())).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(state.updates[0]!.rebootPendingSince).toBeInstanceOf(Date);
  });

  it('a throwing reboot never escapes into the deferred-work runner', async () => {
    whenFinished();
    vi.mocked(executeReboot).mockRejectedValue(new Error('pool'));
    await expect(applied(needsReboot())).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe('applyOemUpdateResult: attempts (#11065 W07)', () => {
  const OCCURRENCE = '2027-01';

  function scheduledRun(status: Record<string, unknown> = {}) {
    state.command = {
      id: COMMAND_ID,
      deviceId: DEVICE_ID,
      type: 'oem_update_run',
      payload: { categories: ['driver'], trigger: 'scheduled', occurrenceKey: OCCURRENCE },
    };
    state.status = statusRow({ occurrenceKey: OCCURRENCE, lastOutcome: null, attempts: 0, ...status });
  }

  function consumed(): boolean {
    const attempts = state.updates[0]!.attempts;
    if (attempts === undefined) return false;
    const { sql } = new PgDialect().sqlToQuery(attempts as SQL);
    expect(sql).toContain('"attempts"');
    expect(sql).toContain('+ 1');
    return true;
  }

  it.each([
    ['failed', null],
    ['partial', null],
    ['interrupted', null],
    ['tool_unavailable', null],
    ['blocked_no_recovery_key', null],
    ['success', null],
    ['no_updates', null],
    ['retry_later', null],
    ['retry_later', 'wu_search_failed'],
  ])('%s (%s) consumes one', async (outcome, errorCode) => {
    scheduledRun();
    await apply(goodResult({ outcome, errorCode, items: [] }));
    expect(consumed()).toBe(true);
  });

  it.each([
    ['blocked_on_battery', null],
    ['blocked_reboot_pending', null],
    ['retry_later', 'not_after_passed'],
    ['retry_later', 'run_in_flight'],
    ['retry_later', 'preflight_failed'],
    ['retry_later', 'flash_in_progress'],
  ])('%s (%s) consumes none', async (outcome, errorCode) => {
    scheduledRun();
    await apply(goodResult({ outcome, errorCode, items: [] }));
    expect(consumed()).toBe(false);
  });

  it('a malformed result is recorded as failed and consumes one', async () => {
    scheduledRun();
    await apply('not json');
    expect(state.updates[0]).toMatchObject({ lastOutcome: 'failed' });
    expect(consumed()).toBe(true);
  });

  it('Run Now consumes none', async () => {
    state.command = { id: COMMAND_ID, deviceId: DEVICE_ID, type: 'oem_update_run', payload: { categories: ['driver'], trigger: 'on_demand', occurrenceKey: null } };
    state.status = statusRow({ occurrenceKey: OCCURRENCE, lastOutcome: null, attempts: 1 });
    await apply(goodResult({ outcome: 'failed', items: [] }));
    expect(consumed()).toBe(false);
  });

  it('a result delivered twice consumes one: the first wrote an outcome', async () => {
    scheduledRun({ lastOutcome: 'failed', attempts: 1 });
    await apply(goodResult({ outcome: 'failed', items: [] }));
    expect(consumed()).toBe(false);
  });

  it('an unreadable payload consumes none', async () => {
    state.command = { id: COMMAND_ID, deviceId: DEVICE_ID, type: 'oem_update_run', payload: null };
    state.status = statusRow({ occurrenceKey: OCCURRENCE, lastOutcome: null, attempts: 0 });
    await apply(goodResult({ outcome: 'failed', items: [] }));
    expect(consumed()).toBe(false);
  });

  it('a run of an occurrence the row has moved on from consumes none', async () => {
    scheduledRun({ occurrenceKey: '2027-02' });
    await apply(goodResult({ outcome: 'failed', items: [] }));
    expect(consumed()).toBe(false);
  });
});

describe('applyOemUpdateResult: a run that applied nothing leaves an owed reboot alone (#11065 W07)', () => {
  const owed = new Date('2027-01-19T02:00:00.000Z');
  const armed = new Date('2027-01-20T02:00:00.000Z');

  it.each([
    ['blocked_on_battery', null],
    ['blocked_no_recovery_key', null],
    ['tool_unavailable', null],
    ['retry_later', 'not_after_passed'],
    ['retry_later', 'flash_in_progress'],
    ['interrupted', null],
    ['failed', 'not_elevated'],
  ])('%s (%s) keeps the clock, the flag and the monitor', async (outcome, errorCode) => {
    state.status = statusRow({ rebootPendingSince: owed, returnDeadlineAt: armed });
    await apply(goodResult({ outcome, errorCode, rebootRequired: false, items: [] }));
    expect(state.updates[0]).not.toHaveProperty('rebootPendingSince');
    expect(state.updates[0]).not.toHaveProperty('rebootRequired');
    expect(state.updates[0]).not.toHaveProperty('returnDeadlineAt');
    expect(resolveReturnedDeviceAlerts).not.toHaveBeenCalled();
  });

  it('a clean run that applied something still clears them', async () => {
    state.status = statusRow({ rebootPendingSince: owed, returnDeadlineAt: armed });
    await apply(goodResult({ outcome: 'no_updates', rebootRequired: false, items: [] }));
    expect(state.updates[0]).toMatchObject({ rebootPendingSince: null, rebootRequired: false, returnDeadlineAt: null });
  });
});

describe('applyOemUpdateResult: reboot owed (#11065 W07)', () => {
  it('a shutdown request is not a reboot: no pending clock', async () => {
    await apply(goodResult({ outcome: 'success', rebootRequired: false, shutdownRequired: true }));
    expect(state.updates[0]).toMatchObject({ rebootRequired: false, rebootPendingSince: null });
  });

  it('a scheduled run that needs a restart queues none here: the sweep owns the window', async () => {
    state.command = {
      id: COMMAND_ID,
      deviceId: DEVICE_ID,
      type: 'oem_update_run',
      submittedOrgId: ORG_ID,
      payload: { categories: ['driver'], trigger: 'scheduled', occurrenceKey: '2027-01', rebootControlled: true },
    };
    await apply(goodResult({ outcome: 'success_reboot_required', rebootRequired: true }));
    expect(state.updates[0]!.rebootPendingSince).toBeInstanceOf(Date);
    expect(runAfterDbContextCommit).not.toHaveBeenCalled();
    expect(executeReboot).not.toHaveBeenCalled();
  });
});

describe('applyOemUpdateResult: takeover state (#11065 W07)', () => {
  it('ok records the takeover', async () => {
    await apply(goodResult({ takeover: 'ok' }));
    expect(state.updates[0]).toMatchObject({ takeoverState: 'taken_over' });
  });

  it('policy_locked records that nothing was changed', async () => {
    await apply(goodResult({ takeover: 'policy_locked' }));
    expect(state.updates[0]).toMatchObject({ takeoverState: 'policy_locked' });
  });

  it('not_attempted leaves an earlier takeover alone', async () => {
    state.status = statusRow({ takeoverState: 'taken_over' });
    await apply(goodResult({ takeover: 'not_attempted' }));
    expect(state.updates[0]).not.toHaveProperty('takeoverState');
  });

  it('a malformed result leaves it alone too', async () => {
    state.status = statusRow({ takeoverState: 'taken_over' });
    await apply('not json');
    expect(state.updates[0]).not.toHaveProperty('takeoverState');
  });
});

describe('applyOemUpdateRelease (#11065 W07)', () => {
  const release = (result: unknown, deviceId = DEVICE_ID) => applyOemUpdateRelease({ commandId: COMMAND_ID, deviceId, result });

  beforeEach(() => {
    state.command = { id: COMMAND_ID, deviceId: DEVICE_ID, type: 'oem_update_release', payload: { lane: 'dell' } };
  });

  it.each(['restored', 'nothing_to_restore'])('%s clears the state', async (outcome) => {
    await release({ lane: 'dell', outcome, errorCode: null });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ takeoverState: 'none', reason: null });
  });

  it('failed leaves the state for the sweep to retry', async () => {
    await release({ lane: 'dell', outcome: 'failed', errorCode: 'settings_import_failed' });
    expect(state.updates).toEqual([]);
  });

  it('a malformed ack leaves the state, and does not throw', async () => {
    await expect(release('not json')).resolves.toBeUndefined();
    expect(state.updates).toEqual([]);
  });

  it('an ack for another device command is ignored', async () => {
    await release({ lane: 'dell', outcome: 'restored', errorCode: null }, OTHER_DEVICE_ID);
    expect(state.updates).toEqual([]);
  });

  it('a failure to write reaches Sentry and does not throw', async () => {
    state.failReads = true;
    await expect(release({ lane: 'dell', outcome: 'restored', errorCode: null })).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
