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
      { delayMinutes: 30, reason: 'Installed patch requires reboot', source: 'patch_job' },
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
    // An explicit delay skips the policy lookup entirely.
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

describe('evaluateRebootPolicy', () => {
  it('never reboots under the never policy', async () => {
    await expect(evaluateRebootPolicy('dev-1', 'never', true)).resolves.toEqual({
      shouldReboot: false,
      reason: 'Reboot policy is never',
      deferred: false,
    });
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
