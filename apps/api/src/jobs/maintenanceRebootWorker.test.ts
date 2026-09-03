import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
// Mock the service modules so the test does not drag the websocket / resolver
// import chains into a DB-less unit run. processRebootCandidate is tested with
// injected deps; decideRebootCommand is pure (defined in the worker module).
vi.mock('../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../services/featureConfigResolver', () => ({
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
  resolvePatchConfigForDevice: vi.fn(),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import {
  decideRebootCommand,
  rebootWarranted,
  processRebootCandidate,
  runMaintenanceRebootSweep,
  REBOOT_DEDUP_STATUSES,
} from './maintenanceRebootWorker';
import { DEFAULT_REBOOT_DELAY_MINUTES, DEFERRAL_OFF } from '../services/patchRebootHandler';

// #3197: the grace period is no longer a constant in this module. It resolves
// from the device's effective patch policy — the same setting the post-patch
// reboot path reads — so the two reboot paths cannot drift apart again. The old
// MAINTENANCE_REBOOT_GRACE_MINUTES export is gone.
const POLICY_DELAY = 42;

describe('REBOOT_DEDUP_STATUSES', () => {
  it('covers exactly pending, sent, and completed (not failed/timeout/cancelled)', () => {
    expect(REBOOT_DEDUP_STATUSES).toEqual(['pending', 'sent', 'completed']);
  });
});

describe('decideRebootCommand', () => {
  it('returns null when rebootIfPending is false', () => {
    expect(decideRebootCommand({ rebootIfPending: false, windowActive: true, osType: 'windows', delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF })).toBeNull();
  });

  it('returns null when the window is not active', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: false, osType: 'windows', delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF })).toBeNull();
  });

  it('returns null on macOS even when active and enabled', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'macos', delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF })).toBeNull();
  });

  it('carries the policy-resolved grace onto the Windows schedule_reboot payload', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'windows', delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF })).toEqual({
      type: 'schedule_reboot',
      payload: {
        delayMinutes: POLICY_DELAY,
        reason: 'Pending reboot — maintenance window',
        source: 'maintenance_window',
        deadline: expect.any(String),
        allowDeferral: false,
        maxDeferrals: 0,
        deferralMinutes: 0,
      },
    });
  });

  it('carries the policy-resolved grace onto the Linux reboot payload', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'linux', delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF })).toEqual({
      type: 'reboot',
      payload: { delay: POLICY_DELAY },
    });
  });

  // #3207: the Linux path is a different command with a different contract
  // (`shutdown -r +N` via the `delay` wire key). It has no deferral surface
  // until W4 ships a Linux prompt, and must not grow one by accident.
  it('leaves the Linux reboot payload a bare delay even when deferral is enabled', () => {
    expect(decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'linux',
      delayMinutes: POLICY_DELAY,
      deferral: { allowDeferral: true, maxDeferrals: 3, deferralMinutes: 60 },
    })).toEqual({ type: 'reboot', payload: { delay: POLICY_DELAY } });
  });

  it('carries the deferral budget onto the Windows payload when enabled', () => {
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'windows',
      delayMinutes: 15,
      deferral: { allowDeferral: true, maxDeferrals: 2, deferralMinutes: 60 },
    });
    expect(decision?.type).toBe('schedule_reboot');
    expect(decision!.payload).toMatchObject({
      allowDeferral: true, maxDeferrals: 2, deferralMinutes: 60,
    });
  });

  it('clamps the maintenance-window deadline to the end of the window', () => {
    // Budget would allow 15 + 240 = 255 minutes; the window closes in 45.
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'windows',
      delayMinutes: 15,
      deferral: { allowDeferral: true, maxDeferrals: 4, deferralMinutes: 60 },
      windowEndsAt: new Date(Date.now() + 45 * 60_000),
    });
    expect(decision?.type).toBe('schedule_reboot');
    const deadline = (decision!.payload as { deadline: string }).deadline;
    const minutesOut = (Date.parse(deadline) - Date.now()) / 60000;
    expect(minutesOut).toBeGreaterThan(44);
    expect(minutesOut).toBeLessThanOrEqual(45);
  });

  it('with deferral off, the deadline is the scheduled reboot time itself', () => {
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'windows',
      delayMinutes: 15, deferral: DEFERRAL_OFF,
    });
    const deadline = (decision!.payload as { deadline: string }).deadline;
    const minutesOut = (Date.parse(deadline) - Date.now()) / 60000;
    expect(minutesOut).toBeGreaterThan(14);
    expect(minutesOut).toBeLessThanOrEqual(15);
  });

  it('never hardcodes a grace of its own — the delay always comes from the caller (#3197)', () => {
    for (const delayMinutes of [1, 5, 15, 60, 1440]) {
      const decision = decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'windows', delayMinutes, deferral: DEFERRAL_OFF });
      expect(decision).not.toBeNull();
      expect((decision as { payload: { delayMinutes: number } }).payload.delayMinutes).toBe(delayMinutes);
    }
  });
});

describe('rebootWarranted', () => {
  it('gates on rebootIfPending, window activity and OS', () => {
    expect(rebootWarranted({ rebootIfPending: true, windowActive: true, osType: 'windows' })).toBe(true);
    expect(rebootWarranted({ rebootIfPending: true, windowActive: true, osType: 'linux' })).toBe(true);
    expect(rebootWarranted({ rebootIfPending: true, windowActive: true, osType: 'macos' })).toBe(false);
    expect(rebootWarranted({ rebootIfPending: false, windowActive: true, osType: 'windows' })).toBe(false);
    expect(rebootWarranted({ rebootIfPending: true, windowActive: false, osType: 'windows' })).toBe(false);
  });

  it('agrees with decideRebootCommand on every combination', () => {
    for (const rebootIfPending of [true, false]) {
      for (const windowActive of [true, false]) {
        for (const osType of ['windows', 'linux', 'macos'] as const) {
          const gate = { rebootIfPending, windowActive, osType };
          expect(rebootWarranted(gate)).toBe(
            decideRebootCommand({ ...gate, delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF }) !== null,
          );
        }
      }
    }
  });
});

describe('processRebootCandidate', () => {
  const winDevice = { id: 'dev-1', orgId: 'org-1', osType: 'windows' as const };
  const linuxDevice = { id: 'dev-2', orgId: 'org-1', osType: 'linux' as const };

  type Deps = NonNullable<Parameters<typeof processRebootCandidate>[1]>;

  function makeDeps(overrides: Partial<Deps> = {}): Deps {
    return {
      resolveMaintenanceConfigForDevice: vi.fn().mockResolvedValue({ rebootIfPending: true }),
      isInMaintenanceWindow: vi.fn().mockReturnValue({ active: true }),
      hasRecentRebootCommand: vi.fn().mockResolvedValue(false),
      queueCommandForExecution: vi.fn().mockResolvedValue({ command: { id: 'cmd-1' } }),
      resolveRebootPlan: vi.fn().mockResolvedValue({ delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF }),
      rebootWarranted,
      decideRebootCommand,
      ...overrides,
    } as unknown as Deps;
  }

  it('issues the decided command and passes expectedOrgId', async () => {
    const deps = makeDeps();
    const res = await processRebootCandidate(winDevice, deps);
    expect(res.issued).toBe(true);
    expect(deps.queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1',
      'schedule_reboot',
      expect.objectContaining({ delayMinutes: POLICY_DELAY, source: 'maintenance_window' }),
      { expectedOrgId: 'org-1' },
    );
  });

  it('issues reboot with grace delay on Linux', async () => {
    const deps = makeDeps();
    const res = await processRebootCandidate(linuxDevice, deps);
    expect(res.issued).toBe(true);
    expect(deps.queueCommandForExecution).toHaveBeenCalledWith(
      'dev-2',
      'reboot',
      expect.objectContaining({ delay: POLICY_DELAY }),
      { expectedOrgId: 'org-1' },
    );
  });

  it('skips when no maintenance policy applies', async () => {
    const deps = makeDeps({
      resolveMaintenanceConfigForDevice: vi.fn().mockResolvedValue(null),
    } as never);
    const res = await processRebootCandidate(winDevice, deps);
    expect(res).toEqual({ issued: false, reason: 'no-maintenance-policy' });
    expect(deps.queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('skips (dedup) when a recent reboot command exists', async () => {
    const deps = makeDeps({
      hasRecentRebootCommand: vi.fn().mockResolvedValue(true),
    } as never);
    const res = await processRebootCandidate(winDevice, deps);
    expect(res).toEqual({ issued: false, reason: 'recent-reboot-command' });
    expect(deps.queueCommandForExecution).not.toHaveBeenCalled();
  });

  it('does not issue when the device is offline (queue returns error), and returns the error as reason', async () => {
    const errorMsg = 'Device is offline, cannot execute command';
    const deps = makeDeps({
      queueCommandForExecution: vi.fn().mockResolvedValue({ error: errorMsg }),
    } as never);
    const res = await processRebootCandidate(winDevice, deps);
    expect(res.issued).toBe(false);
    expect(res.reason).toBe(errorMsg);
  });

  it('skips without issuing when the maintenance window is not active (M3)', async () => {
    const deps = makeDeps({
      isInMaintenanceWindow: vi.fn().mockReturnValue({ active: false }),
    } as never);
    const res = await processRebootCandidate(winDevice, deps);
    expect(res).toEqual({ issued: false, reason: 'no-action' });
    expect(deps.queueCommandForExecution).not.toHaveBeenCalled();
  });

  // The policy lookup is a hierarchy walk per device, and this sweep runs over
  // the whole online fleet every ten minutes. It must not fire for devices that
  // are not about to reboot anyway.
  it('does not resolve the reboot delay when no reboot is warranted', async () => {
    const deps = makeDeps({
      isInMaintenanceWindow: vi.fn().mockReturnValue({ active: false }),
    } as never);
    await processRebootCandidate(winDevice, deps);
    expect(deps.resolveRebootPlan).not.toHaveBeenCalled();
  });

  it('does not resolve the reboot delay when the dedup guard suppresses the dispatch', async () => {
    const deps = makeDeps({
      hasRecentRebootCommand: vi.fn().mockResolvedValue(true),
    } as never);
    await processRebootCandidate(winDevice, deps);
    expect(deps.resolveRebootPlan).not.toHaveBeenCalled();
  });

  // #3207: the fan-out that actually matters. The policy is resolved per
  // device; if the worker dropped the deferral half of the plan on the floor,
  // an enabled policy would silently never reach the endpoint.
  it('threads the resolved deferral budget onto the dispatched payload', async () => {
    const deps = makeDeps({
      resolveRebootPlan: vi.fn().mockResolvedValue({
        delayMinutes: 15,
        deferral: { allowDeferral: true, maxDeferrals: 2, deferralMinutes: 30 },
      }),
    } as never);
    await processRebootCandidate(winDevice, deps);
    expect(deps.queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1', 'schedule_reboot',
      expect.objectContaining({ allowDeferral: true, maxDeferrals: 2, deferralMinutes: 30 }),
      { expectedOrgId: 'org-1' },
    );
  });

  it('caps the deadline at the close of the maintenance window it fired inside', async () => {
    const windowEndsAt = new Date(Date.now() + 20 * 60_000);
    const deps = makeDeps({
      isInMaintenanceWindow: vi.fn().mockReturnValue({ active: true, windowEndsAt }),
      resolveRebootPlan: vi.fn().mockResolvedValue({
        delayMinutes: 5,
        deferral: { allowDeferral: true, maxDeferrals: 4, deferralMinutes: 60 },
      }),
    } as never);
    await processRebootCandidate(winDevice, deps);
    const payload = vi.mocked(deps.queueCommandForExecution).mock.calls[0]![2] as { deadline: string };
    expect(Date.parse(payload.deadline)).toBeLessThanOrEqual(windowEndsAt.getTime());
  });

  it('resolves the policy exactly once per dispatched device', async () => {
    const deps = makeDeps();
    await processRebootCandidate(winDevice, deps);
    expect(deps.resolveRebootPlan).toHaveBeenCalledTimes(1);
  });

  it('resolves the delay per device, so two devices can get different graces', async () => {
    const deps = makeDeps({
      resolveRebootPlan: vi.fn(async (id: string) => ({ delayMinutes: id === 'dev-1' ? 30 : 5, deferral: DEFERRAL_OFF })),
    } as never);
    await processRebootCandidate(winDevice, deps);
    await processRebootCandidate(linuxDevice, deps);
    expect(deps.queueCommandForExecution).toHaveBeenNthCalledWith(
      1, 'dev-1', 'schedule_reboot', expect.objectContaining({ delayMinutes: 30 }), { expectedOrgId: 'org-1' },
    );
    expect(deps.queueCommandForExecution).toHaveBeenNthCalledWith(
      2, 'dev-2', 'reboot', expect.objectContaining({ delay: 5 }), { expectedOrgId: 'org-1' },
    );
  });

  it('falls back to the shared default when the device has no patch policy', async () => {
    const deps = makeDeps({
      resolveRebootPlan: vi.fn().mockResolvedValue({ delayMinutes: DEFAULT_REBOOT_DELAY_MINUTES, deferral: DEFERRAL_OFF }),
    } as never);
    await processRebootCandidate(winDevice, deps);
    expect(deps.queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1', 'schedule_reboot',
      expect.objectContaining({ delayMinutes: DEFAULT_REBOOT_DELAY_MINUTES }),
      { expectedOrgId: 'org-1' },
    );
    // The old hardcoded patch-path value warned nobody; the shared default must
    // be high enough to reach the agent's warning ladder.
    expect(DEFAULT_REBOOT_DELAY_MINUTES).toBeGreaterThan(5);
  });
});

describe('runMaintenanceRebootSweep', () => {
  it('isolates per-device errors so a throw on one device does not abort others', async () => {
    const candidates = [
      { id: 'dev-1', orgId: 'org-1', osType: 'linux' as const },
      { id: 'dev-2', orgId: 'org-1', osType: 'linux' as const },
    ];
    const result = await runMaintenanceRebootSweep({
      getRebootCandidates: vi.fn().mockResolvedValue(candidates),
      processRebootCandidate: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ issued: true, reason: 'issued' }),
    });
    expect(result).toEqual({ issued: 1, checked: 2 });
  });
});
