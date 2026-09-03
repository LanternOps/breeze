import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module pulls in the command queue and the policy resolver; both drag DB /
// websocket import chains into a DB-less unit run, so they are mocked and the
// behaviour under test is the delay resolution and the dispatch shape.
vi.mock('./commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('./featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn(),
  resolvePatchConfigForDevice: vi.fn(),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import {
  clampRebootDelayMinutes,
  resolveRebootDelayMinutes,
  executeReboot,
  evaluateRebootPolicy,
  DEFAULT_REBOOT_DELAY_MINUTES,
  MIN_REBOOT_DELAY_MINUTES,
  MAX_REBOOT_DELAY_MINUTES,
  DEFERRAL_OFF,
  MAX_REBOOT_DEFERRALS,
  MAX_REBOOT_DEFERRAL_MINUTES,
  computeRebootDeadline,
  rebootDeferralSettingsFrom,
  resolveRebootDeferralSettings,
} from './patchRebootHandler';
import { queueCommandForExecution } from './commandQueue';
import { checkDeviceMaintenanceWindow, resolvePatchConfigForDevice } from './featureConfigResolver';
import { captureException } from './sentry';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-1' } } as never);
});

describe('DEFAULT_REBOOT_DELAY_MINUTES', () => {
  // The reported defect (#3197): the patch path hardcoded 5 minutes while the
  // agent's warning ladder was 60/15/5 gated on strict `>`. 5 > 5 is false, so
  // nothing fired and the workstation rebooted silently. Whatever the default
  // becomes, it must never be a value that warns nobody.
  it('is high enough to reach the agent warning ladder', () => {
    expect(DEFAULT_REBOOT_DELAY_MINUTES).toBeGreaterThan(5);
  });

  it('sits inside the policy bounds', () => {
    expect(DEFAULT_REBOOT_DELAY_MINUTES).toBeGreaterThanOrEqual(MIN_REBOOT_DELAY_MINUTES);
    expect(DEFAULT_REBOOT_DELAY_MINUTES).toBeLessThanOrEqual(MAX_REBOOT_DELAY_MINUTES);
  });

  it('matches the bounds enforced by the DB CHECK and the zod validator', () => {
    expect(MIN_REBOOT_DELAY_MINUTES).toBe(1);
    expect(MAX_REBOOT_DELAY_MINUTES).toBe(1440);
  });
});

describe('clampRebootDelayMinutes', () => {
  it('passes through in-range values', () => {
    for (const v of [1, 5, 15, 60, 1439, 1440]) {
      expect(clampRebootDelayMinutes(v)).toBe(v);
    }
  });

  it('clamps out-of-range values to the bounds', () => {
    expect(clampRebootDelayMinutes(0)).toBe(MIN_REBOOT_DELAY_MINUTES);
    expect(clampRebootDelayMinutes(-30)).toBe(MIN_REBOOT_DELAY_MINUTES);
    expect(clampRebootDelayMinutes(99999)).toBe(MAX_REBOOT_DELAY_MINUTES);
  });

  it('rounds fractional minutes', () => {
    expect(clampRebootDelayMinutes(14.4)).toBe(14);
    expect(clampRebootDelayMinutes(14.6)).toBe(15);
  });

  it('falls back to the default for values that are not numbers', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity, 'abc', {}, []]) {
      expect(clampRebootDelayMinutes(v)).toBe(DEFAULT_REBOOT_DELAY_MINUTES);
    }
  });

  it('accepts numeric strings, which is how a jsonb/driver round-trip can arrive', () => {
    expect(clampRebootDelayMinutes('30')).toBe(30);
  });
});

describe('resolveRebootDelayMinutes', () => {
  it('reads the delay off the device effective patch policy', async () => {
    const resolver = vi.fn().mockResolvedValue({ rebootDelayMinutes: 45 });
    await expect(
      resolveRebootDelayMinutes('dev-1', { resolvePatchConfigForDevice: resolver }),
    ).resolves.toBe(45);
    expect(resolver).toHaveBeenCalledWith('dev-1');
  });

  it('falls back to the default when the device resolves to no patch policy', async () => {
    const resolver = vi.fn().mockResolvedValue(null);
    await expect(
      resolveRebootDelayMinutes('dev-1', { resolvePatchConfigForDevice: resolver }),
    ).resolves.toBe(DEFAULT_REBOOT_DELAY_MINUTES);
  });

  it('clamps a nonsense stored value rather than dispatching it', async () => {
    const resolver = vi.fn().mockResolvedValue({ rebootDelayMinutes: 0 });
    await expect(
      resolveRebootDelayMinutes('dev-1', { resolvePatchConfigForDevice: resolver }),
    ).resolves.toBe(MIN_REBOOT_DELAY_MINUTES);
  });

  it('reports a resolver failure to Sentry instead of swallowing it, and still returns a warning delay', async () => {
    const boom = new Error('policy hierarchy lookup failed');
    const resolver = vi.fn().mockRejectedValue(boom);
    await expect(
      resolveRebootDelayMinutes('dev-1', { resolvePatchConfigForDevice: resolver }),
    ).resolves.toBe(DEFAULT_REBOOT_DELAY_MINUTES);
    expect(captureException).toHaveBeenCalledWith(boom);
  });

  it('uses the real resolver by default', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockResolvedValue({ rebootDelayMinutes: 25 } as never);
    await expect(resolveRebootDelayMinutes('dev-1')).resolves.toBe(25);
    expect(resolvePatchConfigForDevice).toHaveBeenCalledWith('dev-1');
  });
});

describe('executeReboot', () => {
  it('resolves the delay from policy when none is passed — no hardcoded 5 (#3197)', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockResolvedValue({ rebootDelayMinutes: 30 } as never);

    const res = await executeReboot('dev-1', 'Installed patch requires reboot');

    expect(res).toEqual({ success: true, delayMinutes: 30 });
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1',
      'schedule_reboot',
      expect.objectContaining({
        delayMinutes: 30,
        reason: 'Installed patch requires reboot',
        source: 'patch_job',
      }),
      { expectedOrgId: undefined },
    );
  });

  it('never dispatches the old hardcoded 5-minute delay when policy is absent', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockResolvedValue(null as never);

    await executeReboot('dev-1', 'reason');

    const call = vi.mocked(queueCommandForExecution).mock.calls[0];
    expect(call).toBeDefined();
    const payload = call![2] as { delayMinutes: number };
    expect(payload.delayMinutes).toBe(DEFAULT_REBOOT_DELAY_MINUTES);
    expect(payload.delayMinutes).toBeGreaterThan(5);
  });

  it('honours an explicit delay and clamps it', async () => {
    await executeReboot('dev-1', 'reason', { delayMinutes: 99999 });
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1',
      'schedule_reboot',
      expect.objectContaining({ delayMinutes: MAX_REBOOT_DELAY_MINUTES }),
      expect.anything(),
    );
    // #3207: an explicit delay no longer skips the policy lookup outright —
    // the deferral budget still has to come from somewhere. What must hold is
    // that ONE walk of the policy hierarchy answers both questions.
    expect(resolvePatchConfigForDevice).toHaveBeenCalledTimes(1);
  });

  it('skips the policy lookup entirely when the caller supplies delay AND deferral', async () => {
    await executeReboot('dev-1', 'reason', {
      delayMinutes: 15,
      deferral: { allowDeferral: false, maxDeferrals: 0, deferralMinutes: 0 },
    });
    expect(resolvePatchConfigForDevice).not.toHaveBeenCalled();
  });

  it('forwards expectedOrgId so the cross-tenant guard is armed on this system-context dispatch', async () => {
    await executeReboot('dev-1', 'reason', { delayMinutes: 15, expectedOrgId: 'org-9' });
    expect(queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1',
      'schedule_reboot',
      expect.anything(),
      { expectedOrgId: 'org-9' },
    );
  });

  it('surfaces a queue error rather than reporting success', async () => {
    vi.mocked(queueCommandForExecution).mockResolvedValue({ error: 'Device is offline, cannot execute command' } as never);
    const res = await executeReboot('dev-1', 'reason', { delayMinutes: 15 });
    expect(res).toEqual({ success: false, error: 'Device is offline, cannot execute command' });
  });
});

// ============================================================================
// #3207 — end-user reboot deferral
// ============================================================================

function payloadOf(): Record<string, unknown> {
  const call = vi.mocked(queueCommandForExecution).mock.calls[0];
  expect(call).toBeDefined();
  return call![2] as Record<string, unknown>;
}

describe('rebootDeferralSettingsFrom (#3207)', () => {
  it('is OFF for a device with no resolvable patch policy', () => {
    expect(rebootDeferralSettingsFrom(null)).toEqual(DEFERRAL_OFF);
  });

  it('is OFF when the policy has not opted in', () => {
    expect(rebootDeferralSettingsFrom({
      rebootAllowDeferral: false, rebootMaxDeferrals: 5, rebootDeferralMinutes: 30,
    } as never)).toEqual(DEFERRAL_OFF);
  });

  // The guard is `rebootAllowDeferral !== true`, not a truthy check. Swapping it
  // for `!settings.rebootAllowDeferral` would still pass the false/true cases
  // above, so the discriminating input is a value that is truthy but not `true`.
  it('treats a truthy-but-not-true opt-in as OFF, never as enabled', () => {
    for (const bad of [1, 'true', 'yes', {}, [], undefined]) {
      expect(rebootDeferralSettingsFrom({
        rebootAllowDeferral: bad, rebootMaxDeferrals: 5, rebootDeferralMinutes: 60,
      } as never), String(bad)).toEqual(DEFERRAL_OFF);
    }
  });

  it('is OFF when the column is absent entirely (a pre-migration row)', () => {
    expect(rebootDeferralSettingsFrom({ rebootDelayMinutes: 15 } as never)).toEqual(DEFERRAL_OFF);
  });

  it('carries an opted-in budget through unchanged', () => {
    expect(rebootDeferralSettingsFrom({
      rebootAllowDeferral: true, rebootMaxDeferrals: 2, rebootDeferralMinutes: 45,
    } as never)).toEqual({ allowDeferral: true, maxDeferrals: 2, deferralMinutes: 45 });
  });

  it('clamps an out-of-range window to the policy bounds', () => {
    expect(rebootDeferralSettingsFrom({
      rebootAllowDeferral: true, rebootMaxDeferrals: 99, rebootDeferralMinutes: 99999,
    } as never)).toEqual({
      allowDeferral: true,
      maxDeferrals: MAX_REBOOT_DEFERRALS,
      deferralMinutes: MAX_REBOOT_DEFERRAL_MINUTES,
    });
  });

  it('treats an unusable count as OFF, never as "unlimited"', () => {
    for (const bad of [null, undefined, '', 'lots', NaN, -1, 0]) {
      expect(rebootDeferralSettingsFrom({
        rebootAllowDeferral: true, rebootMaxDeferrals: bad, rebootDeferralMinutes: 60,
      } as never)).toEqual(DEFERRAL_OFF);
    }
  });

  it('falls back to the column default for an unusable window rather than the 5-minute floor', () => {
    expect(rebootDeferralSettingsFrom({
      rebootAllowDeferral: true, rebootMaxDeferrals: 2, rebootDeferralMinutes: null,
    } as never)).toEqual({ allowDeferral: true, maxDeferrals: 2, deferralMinutes: 60 });
  });
});

describe('computeRebootDeadline (#3207)', () => {
  const now = new Date('2026-09-02T12:00:00.000Z');

  it('is exactly the scheduled reboot time when deferral is off', () => {
    expect(computeRebootDeadline(now, 15, DEFERRAL_OFF).toISOString())
      .toBe('2026-09-02T12:15:00.000Z');
  });

  it('adds the whole deferral budget on top of the delay', () => {
    expect(computeRebootDeadline(now, 15, {
      allowDeferral: true, maxDeferrals: 2, deferralMinutes: 60,
    }).toISOString()).toBe('2026-09-02T14:15:00.000Z');
  });

  it('clamps to the end of a maintenance window that closes sooner', () => {
    const windowEndsAt = new Date('2026-09-02T12:45:00.000Z');
    expect(computeRebootDeadline(now, 15, {
      allowDeferral: true, maxDeferrals: 4, deferralMinutes: 60,
    }, windowEndsAt).toISOString()).toBe('2026-09-02T12:45:00.000Z');
  });

  it('never returns a deadline earlier than the scheduled reboot itself', () => {
    // A window that closes before the warning period even elapses would
    // otherwise produce a deadline in the past relative to the reboot.
    const windowEndsAt = new Date('2026-09-02T12:05:00.000Z');
    expect(computeRebootDeadline(now, 15, {
      allowDeferral: true, maxDeferrals: 4, deferralMinutes: 60,
    }, windowEndsAt).toISOString()).toBe('2026-09-02T12:15:00.000Z');
  });

  it('ignores a window that closes after the budget is exhausted', () => {
    const windowEndsAt = new Date('2026-09-03T00:00:00.000Z');
    expect(computeRebootDeadline(now, 15, {
      allowDeferral: true, maxDeferrals: 1, deferralMinutes: 60,
    }, windowEndsAt).toISOString()).toBe('2026-09-02T13:15:00.000Z');
  });
});

describe('executeReboot deferral payload (#3207)', () => {
  it('sends deferral settings resolved from the device patch policy', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockResolvedValue({
      rebootDelayMinutes: 15, rebootAllowDeferral: true,
      rebootMaxDeferrals: 2, rebootDeferralMinutes: 60,
    } as never);

    await executeReboot('dev-1', 'Patch install');

    const payload = payloadOf();
    expect(payload.allowDeferral).toBe(true);
    expect(payload.maxDeferrals).toBe(2);
    expect(payload.deferralMinutes).toBe(60);
  });

  it('always sends a deadline, and sets it to delay + the full deferral budget', async () => {
    // 15 + (2 x 60) = 135 minutes out. Without a deadline the agent defaults it
    // to now+delay and would refuse every deferral (#3253).
    vi.mocked(resolvePatchConfigForDevice).mockResolvedValue({
      rebootDelayMinutes: 15, rebootAllowDeferral: true,
      rebootMaxDeferrals: 2, rebootDeferralMinutes: 60,
    } as never);

    await executeReboot('dev-1', 'Patch install');

    const minutesOut = (Date.parse(payloadOf().deadline as string) - Date.now()) / 60000;
    expect(minutesOut).toBeGreaterThan(134);
    expect(minutesOut).toBeLessThan(136);
  });

  it('with deferral disabled, deadline is exactly the scheduled reboot time', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockResolvedValue({
      rebootDelayMinutes: 15, rebootAllowDeferral: false,
      rebootMaxDeferrals: 3, rebootDeferralMinutes: 60,
    } as never);

    await executeReboot('dev-1', 'Patch install');

    const payload = payloadOf();
    expect(payload.allowDeferral).toBe(false);
    expect(payload.maxDeferrals).toBe(0);
    expect(payload.deferralMinutes).toBe(0);
    const minutesOut = (Date.parse(payload.deadline as string) - Date.now()) / 60000;
    expect(minutesOut).toBeGreaterThan(14);
    expect(minutesOut).toBeLessThan(16);
  });

  it('falls back to deferral-off when the policy cannot be resolved', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockRejectedValue(new Error('db down'));

    await executeReboot('dev-1', 'Patch install');

    const payload = payloadOf();
    expect(payload.allowDeferral).toBe(false);
    expect(payload.delayMinutes).toBe(DEFAULT_REBOOT_DELAY_MINUTES);
    expect(captureException).toHaveBeenCalled();
  });

  it('resolves the whole policy exactly once per dispatch', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockResolvedValue({
      rebootDelayMinutes: 15, rebootAllowDeferral: true,
      rebootMaxDeferrals: 2, rebootDeferralMinutes: 60,
    } as never);

    await executeReboot('dev-1', 'Patch install');

    expect(resolvePatchConfigForDevice).toHaveBeenCalledTimes(1);
  });

  it('caps the deadline at a supplied maintenance-window close', async () => {
    // Budget alone would put the deadline 4h out; the window shuts in 20min.
    const windowEndsAt = new Date(Date.now() + 20 * 60_000);
    await executeReboot('dev-1', 'In active maintenance window', {
      delayMinutes: 5,
      deferral: { allowDeferral: true, maxDeferrals: 4, deferralMinutes: 60 },
      windowEndsAt,
    });
    expect(Date.parse(payloadOf().deadline as string)).toBe(windowEndsAt.getTime());
  });

  it('ignores a null window close (the non-maintenance policies)', async () => {
    await executeReboot('dev-1', 'Patch install', {
      delayMinutes: 5,
      deferral: { allowDeferral: true, maxDeferrals: 1, deferralMinutes: 60 },
      windowEndsAt: null,
    });
    const minutesOut = (Date.parse(payloadOf().deadline as string) - Date.now()) / 60000;
    expect(minutesOut).toBeGreaterThan(64);
    expect(minutesOut).toBeLessThan(66);
  });

  it('honours a caller-supplied deferral budget over the policy', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockResolvedValue({
      rebootDelayMinutes: 15, rebootAllowDeferral: true,
      rebootMaxDeferrals: 9, rebootDeferralMinutes: 30,
    } as never);

    await executeReboot('dev-1', 'reason', {
      delayMinutes: 20,
      deferral: { allowDeferral: true, maxDeferrals: 1, deferralMinutes: 10 },
    });

    const payload = payloadOf();
    expect(payload.maxDeferrals).toBe(1);
    expect(payload.deferralMinutes).toBe(10);
  });
});

describe('resolveRebootDeferralSettings (#3207)', () => {
  it('is OFF when the policy lookup throws, and reports the failure', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockRejectedValue(new Error('db down'));
    await expect(resolveRebootDeferralSettings('dev-1')).resolves.toEqual(DEFERRAL_OFF);
    expect(captureException).toHaveBeenCalled();
  });

  it('reads the budget off the device policy', async () => {
    vi.mocked(resolvePatchConfigForDevice).mockResolvedValue({
      rebootDelayMinutes: 15, rebootAllowDeferral: true,
      rebootMaxDeferrals: 4, rebootDeferralMinutes: 90,
    } as never);
    await expect(resolveRebootDeferralSettings('dev-1')).resolves.toEqual({
      allowDeferral: true, maxDeferrals: 4, deferralMinutes: 90,
    });
  });
});

describe('evaluateRebootPolicy', () => {
  it('never reboots under the never policy', async () => {
    await expect(evaluateRebootPolicy('dev-1', 'never', true)).resolves.toEqual({
      shouldReboot: false,
      reason: 'Reboot policy is never',
      deferred: false,
      windowEndsAt: null,
    });
  });

  // #3207: this is the ONLY place the post-patch reboot path can learn when the
  // maintenance window closes. Dropping it here means the deferral deadline is
  // never capped to the window on the patch path, silently and only there.
  it('reports when the active maintenance window closes so the deadline can be capped', async () => {
    const windowEndsAt = new Date('2026-02-17T02:00:00.000Z');
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: true, windowEndsAt } as never);
    await expect(evaluateRebootPolicy('dev-1', 'maintenance_window', false)).resolves.toMatchObject({
      shouldReboot: true,
      windowEndsAt,
    });
  });

  it('reports no window close on every non-maintenance policy', async () => {
    for (const policy of ['never', 'if_required', 'always', 'nonsense']) {
      await expect(evaluateRebootPolicy('dev-1', policy, true)).resolves.toMatchObject({
        windowEndsAt: null,
      });
    }
  });

  it('reboots under if_required only when a patch demands it', async () => {
    await expect(evaluateRebootPolicy('dev-1', 'if_required', true)).resolves.toMatchObject({ shouldReboot: true });
    await expect(evaluateRebootPolicy('dev-1', 'if_required', false)).resolves.toMatchObject({ shouldReboot: false });
  });

  it('always reboots under always', async () => {
    await expect(evaluateRebootPolicy('dev-1', 'always', false)).resolves.toMatchObject({ shouldReboot: true });
  });

  it('defers outside an active maintenance window', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: false } as never);
    await expect(evaluateRebootPolicy('dev-1', 'maintenance_window', true)).resolves.toMatchObject({
      shouldReboot: false,
      deferred: true,
    });
  });

  it('reboots inside an active maintenance window', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: true } as never);
    await expect(evaluateRebootPolicy('dev-1', 'maintenance_window', false)).resolves.toMatchObject({
      shouldReboot: true,
      deferred: false,
    });
  });

  it('treats an unknown policy as if_required', async () => {
    await expect(evaluateRebootPolicy('dev-1', 'nonsense', true)).resolves.toMatchObject({ shouldReboot: true });
    await expect(evaluateRebootPolicy('dev-1', 'nonsense', false)).resolves.toMatchObject({ shouldReboot: false });
  });
});
