import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/patchAlerts', () => ({
  REBOOT_PENDING_ALERT_THRESHOLD_DAYS: 7,
  emitRebootPendingAlert: vi.fn().mockResolvedValue(null),
  loadOldestRebootRequiredSince: vi.fn().mockResolvedValue(null),
}));

import {
  decideRebootCommand,
  rebootWarranted,
  processRebootCandidate,
  runMaintenanceRebootSweep,
  REBOOT_DEDUP_STATUSES,
} from './maintenanceRebootWorker';
import { DEFAULT_REBOOT_DELAY_MINUTES, DEFERRAL_OFF } from '../services/patchRebootHandler';
import { emitRebootPendingAlert, loadOldestRebootRequiredSince } from '../services/patchAlerts';
import { captureException, captureMessage } from '../services/sentry';

beforeEach(() => {
  vi.mocked(captureException).mockClear();
  vi.mocked(captureMessage).mockClear();
});

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
    expect(decideRebootCommand({ rebootIfPending: false, windowActive: true, osType: 'windows', delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF, promptText: {} })).toBeNull();
  });

  it('returns null when the window is not active', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: false, osType: 'windows', delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF, promptText: {} })).toBeNull();
  });

  it('returns null on macOS even when active and enabled', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'macos', delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF, promptText: {} })).toBeNull();
  });

  it('carries the policy-resolved grace onto the Windows schedule_reboot payload', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'windows', delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF, promptText: {} })).toEqual({
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

  // #9181: Linux rides the same warn-then-reboot manager as Windows. The old
  // `reboot` + bare `delay` path (an OS-scheduled `shutdown -r +N`) could not
  // carry the deferral budget or the #8030 prompt text, so a Linux user was
  // never offered Postpone and never saw the operator's custom copy.
  it('sends Linux the same schedule_reboot payload Windows gets (#9181)', () => {
    const params = { rebootIfPending: true, windowActive: true, delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF, promptText: {} };
    const linux = decideRebootCommand({ ...params, osType: 'linux' });
    expect(linux).toEqual({
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
    const windows = decideRebootCommand({ ...params, osType: 'windows' });
    expect(Object.keys(linux!.payload).sort()).toEqual(Object.keys(windows!.payload).sort());
  });

  it('never sends Linux the legacy reboot command or its bare delay key (#9181)', () => {
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'linux',
      delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF, promptText: {},
    });
    expect(decision?.type).not.toBe('reboot');
    expect(decision!.payload).not.toHaveProperty('delay');
  });

  it('carries the deferral budget onto the Linux payload when enabled (#9181)', () => {
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'linux',
      delayMinutes: POLICY_DELAY,
      deferral: { allowDeferral: true, maxDeferrals: 3, deferralMinutes: 60 },
      promptText: {},
    });
    expect(decision?.type).toBe('schedule_reboot');
    expect(decision!.payload).toMatchObject({
      allowDeferral: true, maxDeferrals: 3, deferralMinutes: 60,
    });
  });

  it('carries the deferral budget onto the Windows payload when enabled', () => {
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'windows',
      delayMinutes: 15,
      deferral: { allowDeferral: true, maxDeferrals: 2, deferralMinutes: 60 },
      promptText: {},
    });
    expect(decision?.type).toBe('schedule_reboot');
    expect(decision!.payload).toMatchObject({
      allowDeferral: true, maxDeferrals: 2, deferralMinutes: 60,
    });
  });

  it('adds no prompt keys to the Windows payload when the policy sets no text (#8030)', () => {
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'windows',
      delayMinutes: 15, deferral: DEFERRAL_OFF, promptText: {},
    });
    expect(Object.keys(decision!.payload).sort()).toEqual(
      ['allowDeferral', 'deadline', 'deferralMinutes', 'delayMinutes', 'maxDeferrals', 'reason', 'source'],
    );
  });

  it('carries the #8030 prompt text onto the Linux payload (#9181)', () => {
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'linux',
      delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF,
      promptText: { title: 'Neustart', body: 'Bitte speichern', button: 'Jetzt' },
    });
    expect(decision?.type).toBe('schedule_reboot');
    expect(decision!.payload).toMatchObject({
      promptTitle: 'Neustart', promptBody: 'Bitte speichern', promptButton: 'Jetzt',
    });
  });

  it('clamps the Linux maintenance-window deadline to the end of the window (#9181)', () => {
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'linux',
      delayMinutes: 15,
      deferral: { allowDeferral: true, maxDeferrals: 4, deferralMinutes: 60 },
      promptText: {},
      windowEndsAt: new Date(Date.now() + 45 * 60_000),
    });
    const deadline = (decision!.payload as { deadline: string }).deadline;
    const minutesOut = (Date.parse(deadline) - Date.now()) / 60000;
    expect(minutesOut).toBeGreaterThan(44);
    expect(minutesOut).toBeLessThanOrEqual(45);
  });

  it('clamps the maintenance-window deadline to the end of the window', () => {
    // Budget would allow 15 + 240 = 255 minutes; the window closes in 45.
    const decision = decideRebootCommand({
      rebootIfPending: true, windowActive: true, osType: 'windows',
      delayMinutes: 15,
      deferral: { allowDeferral: true, maxDeferrals: 4, deferralMinutes: 60 },
      promptText: {},
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
      delayMinutes: 15, deferral: DEFERRAL_OFF, promptText: {},
    });
    const deadline = (decision!.payload as { deadline: string }).deadline;
    const minutesOut = (Date.parse(deadline) - Date.now()) / 60000;
    expect(minutesOut).toBeGreaterThan(14);
    expect(minutesOut).toBeLessThanOrEqual(15);
  });

  it('never hardcodes a grace of its own — the delay always comes from the caller (#3197)', () => {
    for (const delayMinutes of [1, 5, 15, 60, 1440]) {
      const decision = decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'windows', delayMinutes, deferral: DEFERRAL_OFF, promptText: {} });
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
            decideRebootCommand({ ...gate, delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF, promptText: {} }) !== null,
          );
        }
      }
    }
  });
});

describe('processRebootCandidate', () => {
  const winDevice = {
    id: 'dev-1', orgId: 'org-1', osType: 'windows' as const,
    hostname: 'WIN-01', uptimeSeconds: 3600,
  };
  const linuxDevice = {
    id: 'dev-2', orgId: 'org-1', osType: 'linux' as const,
    hostname: 'lnx-01', uptimeSeconds: 3600,
  };

  type Deps = NonNullable<Parameters<typeof processRebootCandidate>[1]>;

  function makeDeps(overrides: Partial<Deps> = {}): Deps {
    return {
      resolveMaintenanceConfigForDevice: vi.fn().mockResolvedValue({ rebootIfPending: true }),
      isInMaintenanceWindow: vi.fn().mockReturnValue({ active: true }),
      hasRecentRebootCommand: vi.fn().mockResolvedValue(false),
      queueCommandForExecution: vi.fn().mockResolvedValue({ command: { id: 'cmd-1' } }),
      resolveRebootPlan: vi.fn().mockResolvedValue({ delayMinutes: POLICY_DELAY, deferral: DEFERRAL_OFF, promptText: {} }),
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

  it('issues schedule_reboot with the policy grace on Linux (#9181)', async () => {
    const deps = makeDeps();
    const res = await processRebootCandidate(linuxDevice, deps);
    expect(res.issued).toBe(true);
    expect(deps.queueCommandForExecution).toHaveBeenCalledWith(
      'dev-2',
      'schedule_reboot',
      expect.objectContaining({ delayMinutes: POLICY_DELAY, source: 'maintenance_window' }),
      { expectedOrgId: 'org-1' },
    );
  });

  it('carries the policy prompt text and deferral budget to a Linux device (#9181)', async () => {
    const deps = makeDeps({
      resolveRebootPlan: vi.fn().mockResolvedValue({
        delayMinutes: POLICY_DELAY,
        deferral: { allowDeferral: true, maxDeferrals: 2, deferralMinutes: 30 },
        promptText: { title: 'Restart soon', body: 'Save your work', button: 'OK' },
      }),
    } as never);
    await processRebootCandidate(linuxDevice, deps);
    expect(deps.queueCommandForExecution).toHaveBeenCalledWith(
      'dev-2',
      'schedule_reboot',
      expect.objectContaining({
        allowDeferral: true, maxDeferrals: 2, deferralMinutes: 30,
        promptTitle: 'Restart soon', promptBody: 'Save your work', promptButton: 'OK',
      }),
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

  // #8022 (BREEZE-45): a refused dispatch used to be reported as
  // `captureException(new Error(<message with the device id and reason>))`.
  // scrubEvent rewrites every exception value to '[redacted]' and drops
  // untagged context, so production saw only a contentless "Error" whose top
  // frame was processRebootCandidate — read as a throw, when the sweep had in
  // fact reported a refusal and moved on. The refusal must arrive as a warning
  // whose only content is bounded, allowlisted tags.
  it('reports a refused dispatch as a tagged warning, not a contentless exception (#8022)', async () => {
    const deps = makeDeps({
      queueCommandForExecution: vi.fn().mockResolvedValue({
        error: 'TRUST_PROBATION',
        trust: { capability: 'device_execute', reason: 'probation_default_deny' },
        refusal: 'trust_denied',
      }),
    } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await processRebootCandidate(winDevice, deps);

      expect(res).toEqual({ issued: false, reason: 'TRUST_PROBATION' });
      expect(captureException).not.toHaveBeenCalled();
      expect(captureMessage).toHaveBeenCalledTimes(1);
      expect(captureMessage).toHaveBeenCalledWith('[MaintenanceReboot] reboot dispatch refused', {
        eventCode: 'maintenance_reboot_dispatch_refused',
        level: 'warning',
        tags: { org_id: 'org-1', command_dispatch_refusal: 'trust_denied' },
      });
      // The unbounded detail (device id, full reason) stays on the console line.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dev-1'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('TRUST_PROBATION'));
    } finally {
      warn.mockRestore();
    }
  });

  it('tags a refusal that carries no class as unclassified rather than dropping the tag (#8022)', async () => {
    const deps = makeDeps({
      queueCommandForExecution: vi.fn().mockResolvedValue({ error: 'something new' }),
    } as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await processRebootCandidate(winDevice, deps);

      expect(captureMessage).toHaveBeenCalledWith(
        '[MaintenanceReboot] reboot dispatch refused',
        expect.objectContaining({
          tags: { org_id: 'org-1', command_dispatch_refusal: 'unclassified' },
        }),
      );
    } finally {
      warn.mockRestore();
    }
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
        promptText: {},
      }),
    } as never);
    await processRebootCandidate(winDevice, deps);
    expect(deps.queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1', 'schedule_reboot',
      expect.objectContaining({ allowDeferral: true, maxDeferrals: 2, deferralMinutes: 30 }),
      { expectedOrgId: 'org-1' },
    );
  });

  // #8030: same fan-out risk for the restart-prompt text.
  it('threads the resolved restart-prompt text onto the dispatched payload', async () => {
    const deps = makeDeps({
      resolveRebootPlan: vi.fn().mockResolvedValue({
        delayMinutes: 15,
        deferral: DEFERRAL_OFF,
        promptText: { title: 'Neustart', body: 'In {{countdown}}', button: 'Jetzt' },
      }),
    } as never);
    await processRebootCandidate(winDevice, deps);
    expect(deps.queueCommandForExecution).toHaveBeenCalledWith(
      'dev-1', 'schedule_reboot',
      expect.objectContaining({ promptTitle: 'Neustart', promptBody: 'In {{countdown}}', promptButton: 'Jetzt' }),
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
        promptText: {},
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
      resolveRebootPlan: vi.fn(async (id: string) => ({ delayMinutes: id === 'dev-1' ? 30 : 5, deferral: DEFERRAL_OFF, promptText: {} })),
    } as never);
    await processRebootCandidate(winDevice, deps);
    await processRebootCandidate(linuxDevice, deps);
    expect(deps.queueCommandForExecution).toHaveBeenNthCalledWith(
      1, 'dev-1', 'schedule_reboot', expect.objectContaining({ delayMinutes: 30 }), { expectedOrgId: 'org-1' },
    );
    expect(deps.queueCommandForExecution).toHaveBeenNthCalledWith(
      2, 'dev-2', 'schedule_reboot', expect.objectContaining({ delayMinutes: 5 }), { expectedOrgId: 'org-1' },
    );
  });

  it('falls back to the shared default when the device has no patch policy', async () => {
    const deps = makeDeps({
      resolveRebootPlan: vi.fn().mockResolvedValue({ delayMinutes: DEFAULT_REBOOT_DELAY_MINUTES, deferral: DEFERRAL_OFF, promptText: {} }),
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
  const candidate1 = {
    id: 'dev-1', orgId: 'org-1', osType: 'linux' as const,
    hostname: 'HOST-1', uptimeSeconds: 10 * 86400,
  };
  const candidate2 = {
    id: 'dev-2', orgId: 'org-1', osType: 'linux' as const,
    hostname: 'HOST-2', uptimeSeconds: 10 * 86400,
  };

  function makeSweepDeps(overrides: Partial<Parameters<typeof runMaintenanceRebootSweep>[0]> = {}) {
    return {
      getRebootCandidates: vi.fn().mockResolvedValue([candidate1, candidate2]),
      processRebootCandidate: vi.fn().mockResolvedValue({ issued: false, reason: 'no-action' }),
      emitRebootPendingAlert: vi.fn().mockResolvedValue(null),
      loadOldestRebootRequiredSince: vi.fn().mockResolvedValue(null),
      ...overrides,
    };
  }

  it('isolates per-device errors so a throw on one device does not abort others', async () => {
    const result = await runMaintenanceRebootSweep(
      makeSweepDeps({
        processRebootCandidate: vi.fn()
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValueOnce({ issued: true, reason: 'issued' }),
      }),
    );
    expect(result).toEqual({ issued: 1, checked: 2 });
  });

  // #8022: a throw on one candidate is caught, logged with its device id and
  // reported with tags that survive scrubEvent; the candidates after it are
  // still processed in the same tick.
  it('reports a per-device throw with worker + org tags and still processes the next candidate (#8022)', async () => {
    const boom = new Error('boom');
    const otherOrgCandidate = { ...candidate2, orgId: 'org-2' };
    const deps = makeSweepDeps({
      getRebootCandidates: vi.fn().mockResolvedValue([candidate1, otherOrgCandidate]),
      processRebootCandidate: vi.fn()
        .mockRejectedValueOnce(boom)
        .mockResolvedValueOnce({ issued: true, reason: 'issued' }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runMaintenanceRebootSweep(deps);

      expect(result).toEqual({ issued: 1, checked: 2 });
      expect(deps.processRebootCandidate).toHaveBeenNthCalledWith(2, otherOrgCandidate);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(boom, undefined, {
        worker: 'maintenanceRebootWorker',
        org_id: 'org-1',
      });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('dev-1'), boom);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('calls the reboot-pending emitter for a non-issued candidate with the right args', async () => {
    const deps = makeSweepDeps({
      getRebootCandidates: vi.fn().mockResolvedValue([candidate1]),
      processRebootCandidate: vi.fn().mockResolvedValue({ issued: false, reason: 'no-action' }),
      loadOldestRebootRequiredSince: vi.fn().mockResolvedValue(null),
    });

    await runMaintenanceRebootSweep(deps);

    expect(deps.loadOldestRebootRequiredSince).toHaveBeenCalledWith('dev-1', 'org-1');
    expect(deps.emitRebootPendingAlert).toHaveBeenCalledTimes(1);
    expect(deps.emitRebootPendingAlert).toHaveBeenCalledWith({
      orgId: 'org-1',
      deviceId: 'dev-1',
      hostname: 'HOST-1',
      uptimeSeconds: 10 * 86400,
      oldestRebootRequiredSince: null,
    });
  });

  it('skips the patch-history read for a device up for less than the threshold (it cannot alert)', async () => {
    const deps = makeSweepDeps({
      getRebootCandidates: vi.fn().mockResolvedValue([{ ...candidate1, uptimeSeconds: 3600 }]),
    });

    await runMaintenanceRebootSweep(deps);

    expect(deps.loadOldestRebootRequiredSince).not.toHaveBeenCalled();
    expect(deps.emitRebootPendingAlert).toHaveBeenCalledWith(expect.objectContaining({ uptimeSeconds: 3600, oldestRebootRequiredSince: null }));
  });

  it('does not call the reboot-pending emitter for an issued candidate', async () => {
    const deps = makeSweepDeps({
      getRebootCandidates: vi.fn().mockResolvedValue([candidate1]),
      processRebootCandidate: vi.fn().mockResolvedValue({ issued: true, reason: 'issued' }),
    });

    await runMaintenanceRebootSweep(deps);

    expect(deps.emitRebootPendingAlert).not.toHaveBeenCalled();
    expect(deps.loadOldestRebootRequiredSince).not.toHaveBeenCalled();
  });

  it('an emitter throw does not stop the sweep', async () => {
    const deps = makeSweepDeps({
      getRebootCandidates: vi.fn().mockResolvedValue([candidate1, candidate2]),
      processRebootCandidate: vi.fn().mockResolvedValue({ issued: false, reason: 'no-action' }),
      emitRebootPendingAlert: vi.fn().mockRejectedValue(new Error('alert boom')),
    });

    const result = await runMaintenanceRebootSweep(deps);

    expect(result).toEqual({ issued: 0, checked: 2 });
    expect(deps.emitRebootPendingAlert).toHaveBeenCalledTimes(2);
  });

  it('never dispatches a reboot off the back of the alert path — it only reads and alerts', async () => {
    const deps = makeSweepDeps({
      getRebootCandidates: vi.fn().mockResolvedValue([candidate1]),
      processRebootCandidate: vi.fn().mockResolvedValue({ issued: false, reason: 'no-action' }),
    });

    await runMaintenanceRebootSweep(deps);

    // processRebootCandidate is the only thing allowed to issue commands, and
    // it already reported it did not. The emitter/loader stubs above prove
    // nothing else in the sweep did either.
    expect(deps.processRebootCandidate).toHaveBeenCalledTimes(1);
  });
});
