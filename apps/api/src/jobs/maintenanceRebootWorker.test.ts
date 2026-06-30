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
}));

import {
  decideRebootCommand,
  processRebootCandidate,
  MAINTENANCE_REBOOT_GRACE_MINUTES,
  REBOOT_DEDUP_STATUSES,
} from './maintenanceRebootWorker';

describe('REBOOT_DEDUP_STATUSES', () => {
  it('covers exactly pending, sent, and completed (not failed/timeout/cancelled)', () => {
    expect(REBOOT_DEDUP_STATUSES).toEqual(['pending', 'sent', 'completed']);
  });
});

describe('decideRebootCommand', () => {
  it('returns null when rebootIfPending is false', () => {
    expect(decideRebootCommand({ rebootIfPending: false, windowActive: true, osType: 'windows' })).toBeNull();
  });

  it('returns null when the window is not active', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: false, osType: 'windows' })).toBeNull();
  });

  it('returns null on macOS even when active and enabled', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'macos' })).toBeNull();
  });

  it('issues schedule_reboot with a 5-minute grace on Windows', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'windows' })).toEqual({
      type: 'schedule_reboot',
      payload: {
        delayMinutes: MAINTENANCE_REBOOT_GRACE_MINUTES,
        reason: 'Pending reboot — maintenance window',
        source: 'maintenance_window',
      },
    });
  });

  it('issues a delayed reboot on Linux', () => {
    expect(decideRebootCommand({ rebootIfPending: true, windowActive: true, osType: 'linux' })).toEqual({
      type: 'reboot',
      payload: { delay: MAINTENANCE_REBOOT_GRACE_MINUTES },
    });
  });
});

describe('processRebootCandidate', () => {
  const winDevice = { id: 'dev-1', orgId: 'org-1', osType: 'windows' as const };

  type Deps = NonNullable<Parameters<typeof processRebootCandidate>[1]>;

  function makeDeps(overrides: Partial<Deps> = {}): Deps {
    return {
      resolveMaintenanceConfigForDevice: vi.fn().mockResolvedValue({ rebootIfPending: true }),
      isInMaintenanceWindow: vi.fn().mockReturnValue({ active: true }),
      hasRecentRebootCommand: vi.fn().mockResolvedValue(false),
      queueCommandForExecution: vi.fn().mockResolvedValue({ command: { id: 'cmd-1' } }),
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
      expect.objectContaining({ delayMinutes: 5, source: 'maintenance_window' }),
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

  it('does not issue when the device is offline (queue returns error)', async () => {
    const deps = makeDeps({
      queueCommandForExecution: vi.fn().mockResolvedValue({ error: 'Device is offline, cannot execute command' }),
    } as never);
    const res = await processRebootCandidate(winDevice, deps);
    expect(res.issued).toBe(false);
  });

  it('skips without issuing when the maintenance window is not active (M3)', async () => {
    const deps = makeDeps({
      isInMaintenanceWindow: vi.fn().mockReturnValue({ active: false }),
    } as never);
    const res = await processRebootCandidate(winDevice, deps);
    expect(res).toEqual({ issued: false, reason: 'no-action' });
    expect(deps.queueCommandForExecution).not.toHaveBeenCalled();
  });
});
