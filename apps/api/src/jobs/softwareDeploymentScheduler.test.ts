import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  selectMock,
  updateMock,
  buildAndDispatchMock,
  captureExceptionMock,
  softwareDeploymentsTable,
  deploymentResultsTable,
  maintenanceWindowsTable,
  softwareVersionsTable,
  softwareCatalogTable,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  buildAndDispatchMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  softwareDeploymentsTable: {
    id: 'software_deployments.id',
    orgId: 'software_deployments.org_id',
    softwareVersionId: 'software_deployments.software_version_id',
    deploymentType: 'software_deployments.deployment_type',
    scheduleType: 'software_deployments.schedule_type',
    scheduledAt: 'software_deployments.scheduled_at',
    maintenanceWindowId: 'software_deployments.maintenance_window_id',
    options: 'software_deployments.options',
    createdBy: 'software_deployments.created_by',
    dispatchedAt: 'software_deployments.dispatched_at',
  },
  deploymentResultsTable: {
    id: 'deployment_results.id',
    deploymentId: 'deployment_results.deployment_id',
    deviceId: 'deployment_results.device_id',
    status: 'deployment_results.status',
    errorMessage: 'deployment_results.error_message',
    completedAt: 'deployment_results.completed_at',
  },
  maintenanceWindowsTable: {
    id: 'maintenance_windows.id',
    status: 'maintenance_windows.status',
    startTime: 'maintenance_windows.start_time',
    endTime: 'maintenance_windows.end_time',
  },
  softwareVersionsTable: {
    id: 'software_versions.id',
    catalogId: 'software_versions.catalog_id',
  },
  softwareCatalogTable: {
    id: 'software_catalog.id',
    name: 'software_catalog.name',
    integrationProvider: 'software_catalog.integration_provider',
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

// db mock: chainable select/update + a pass-through system context so the tick
// runs without a real Postgres RLS context (follows staleCommandReaper.test.ts).
vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../db/schema', () => ({
  softwareDeployments: softwareDeploymentsTable,
  deploymentResults: deploymentResultsTable,
  maintenanceWindows: maintenanceWindowsTable,
  softwareVersions: softwareVersionsTable,
  softwareCatalog: softwareCatalogTable,
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

// The payload-building fan-out (presign/EDR/variables/detection rules) is
// covered by services/softwareDeployment.test.ts — here we assert the
// scheduler hands it the right deployments and device ids.
vi.mock('../services/softwareDeployment', () => ({
  buildAndDispatchSoftwareInstalls: (...args: unknown[]) => buildAndDispatchMock(...(args as [])),
}));

import {
  isDeploymentDue,
  isMaintenanceWindowOpen,
  runSoftwareDeploymentSchedulerTick,
  MAINTENANCE_SCHEDULE_TYPES,
  MAX_DEPLOYMENTS_PER_TICK,
  SCHEDULER_INTERVAL_MS,
  type DueDeploymentCandidate,
} from './softwareDeploymentScheduler';

// ---------------------------------------------------------------------------
// Chain helpers (staleCommandReaper.test.ts pattern)
// ---------------------------------------------------------------------------

function selectChain(resolvedValue: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

/**
 * Update chain supporting both terminal shapes used by the scheduler:
 *   .set().where()             → resolves undefined  (fail-pending-results)
 *   .set().where().returning() → resolves returningRows (conditional claim)
 * Captures .set() payloads into updateSetCalls.
 */
let updateSetCalls: Record<string, unknown>[] = [];
function updChain(returningRows: unknown[] = []) {
  return {
    set: vi.fn((values: Record<string, unknown>) => {
      updateSetCalls.push(values);
      return {
        where: vi.fn(() =>
          Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue(returningRows),
          }),
        ),
      };
    }),
  };
}

const MINUTE = 60 * 1000;

function scheduledCandidate(overrides: Partial<DueDeploymentCandidate> = {}): DueDeploymentCandidate {
  return {
    id: 'dep-1',
    orgId: 'org-1',
    softwareVersionId: 'ver-1',
    scheduleType: 'scheduled',
    scheduledAt: new Date(Date.now() - 5 * MINUTE),
    options: null,
    createdBy: 'user-1',
    windowStatus: null,
    windowStartTime: null,
    windowEndTime: null,
    ...overrides,
  };
}

function maintenanceCandidate(overrides: Partial<DueDeploymentCandidate> = {}): DueDeploymentCandidate {
  const now = Date.now();
  return {
    id: 'dep-mw',
    orgId: 'org-1',
    softwareVersionId: 'ver-1',
    scheduleType: 'maintenance_window',
    scheduledAt: null,
    options: null,
    createdBy: null,
    windowStatus: 'scheduled',
    windowStartTime: new Date(now - 10 * MINUTE),
    windowEndTime: new Date(now + 50 * MINUTE),
    ...overrides,
  };
}

const versionRecord = { id: 'ver-1', catalogId: 'cat-1', version: '1.0.0' };
const catalogItem = { id: 'cat-1', name: 'TestApp', integrationProvider: null };

/**
 * Queue the standard per-deployment select sequence AFTER the candidates
 * select: pending results → software version → catalog item.
 */
function queueHappyPathSelects(pendingDeviceIds: string[]) {
  selectMock
    .mockReturnValueOnce(selectChain(pendingDeviceIds.map((deviceId) => ({ deviceId }))))
    .mockReturnValueOnce(selectChain([versionRecord]))
    .mockReturnValueOnce(selectChain([catalogItem]));
}

beforeEach(() => {
  selectMock.mockReset();
  updateMock.mockReset();
  buildAndDispatchMock.mockReset();
  captureExceptionMock.mockReset();
  updateSetCalls = [];
  buildAndDispatchMock.mockResolvedValue({ status: 'pending', dispatchedDeviceIds: [] });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('scheduler constants', () => {
  it('ticks every 60s with a bounded per-tick claim count', () => {
    expect(SCHEDULER_INTERVAL_MS).toBe(60 * 1000);
    expect(MAX_DEPLOYMENTS_PER_TICK).toBeGreaterThan(0);
  });

  it('accepts both maintenance schedule-type vocabularies', () => {
    expect(MAINTENANCE_SCHEDULE_TYPES).toContain('maintenance_window');
    expect(MAINTENANCE_SCHEDULE_TYPES).toContain('maintenance');
  });
});

// ---------------------------------------------------------------------------
// Dueness / window evaluation (System B interpretation)
// ---------------------------------------------------------------------------

describe('isMaintenanceWindowOpen', () => {
  const now = new Date('2026-07-28T12:00:00Z');

  it('is open while status=scheduled and now is inside [start, end]', () => {
    expect(
      isMaintenanceWindowOpen(
        {
          windowStatus: 'scheduled',
          windowStartTime: new Date('2026-07-28T11:00:00Z'),
          windowEndTime: new Date('2026-07-28T13:00:00Z'),
        },
        now,
      ),
    ).toBe(true);
  });

  it('is closed before the window starts', () => {
    expect(
      isMaintenanceWindowOpen(
        {
          windowStatus: 'scheduled',
          windowStartTime: new Date('2026-07-28T13:00:00Z'),
          windowEndTime: new Date('2026-07-28T14:00:00Z'),
        },
        now,
      ),
    ).toBe(false);
  });

  it('is closed after the window ends', () => {
    expect(
      isMaintenanceWindowOpen(
        {
          windowStatus: 'scheduled',
          windowStartTime: new Date('2026-07-28T09:00:00Z'),
          windowEndTime: new Date('2026-07-28T10:00:00Z'),
        },
        now,
      ),
    ).toBe(false);
  });

  it('is closed for a cancelled/completed window even inside the time range', () => {
    for (const windowStatus of ['cancelled', 'completed', 'active']) {
      expect(
        isMaintenanceWindowOpen(
          {
            windowStatus,
            windowStartTime: new Date('2026-07-28T11:00:00Z'),
            windowEndTime: new Date('2026-07-28T13:00:00Z'),
          },
          now,
        ),
      ).toBe(false);
    }
  });

  it('is closed when the linked window is missing (left-join nulls)', () => {
    expect(
      isMaintenanceWindowOpen(
        { windowStatus: null, windowStartTime: null, windowEndTime: null },
        now,
      ),
    ).toBe(false);
  });
});

describe('isDeploymentDue', () => {
  const now = new Date();

  it('scheduled: due once scheduledAt has passed, not before', () => {
    expect(isDeploymentDue(scheduledCandidate(), now)).toBe(true);
    expect(
      isDeploymentDue(scheduledCandidate({ scheduledAt: new Date(now.getTime() + 5 * MINUTE) }), now),
    ).toBe(false);
    expect(isDeploymentDue(scheduledCandidate({ scheduledAt: null }), now)).toBe(false);
  });

  it('maintenance (both vocabularies): due only while the window is open', () => {
    expect(isDeploymentDue(maintenanceCandidate(), now)).toBe(true);
    expect(
      isDeploymentDue(maintenanceCandidate({ scheduleType: 'maintenance' }), now),
    ).toBe(true);
    expect(
      isDeploymentDue(
        maintenanceCandidate({
          windowStartTime: new Date(now.getTime() + 10 * MINUTE),
          windowEndTime: new Date(now.getTime() + 60 * MINUTE),
        }),
        now,
      ),
    ).toBe(false);
  });

  it('immediate/unknown schedule types are never due', () => {
    expect(isDeploymentDue(scheduledCandidate({ scheduleType: 'immediate' }), now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tick behavior
// ---------------------------------------------------------------------------

describe('runSoftwareDeploymentSchedulerTick', () => {
  it('claims a due scheduled deployment and dispatches its pending result rows exactly once', async () => {
    selectMock.mockReturnValueOnce(selectChain([scheduledCandidate()]));
    updateMock.mockReturnValueOnce(updChain([{ id: 'dep-1' }])); // claim won
    queueHappyPathSelects(['dev-1', 'dev-2']);
    buildAndDispatchMock.mockResolvedValueOnce({
      status: 'pending',
      dispatchedDeviceIds: ['dev-1', 'dev-2'],
    });

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 1, skipped: 0, errors: 0 });
    // Claim is the conditional dispatched_at update.
    expect(updateSetCalls).toHaveLength(1);
    expect(updateSetCalls[0]!.dispatchedAt).toBeInstanceOf(Date);
    // Fan-out invoked once, with the pending devices, without re-stamping
    // dispatched_at (the claim already did).
    expect(buildAndDispatchMock).toHaveBeenCalledTimes(1);
    expect(buildAndDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: 'dep-1',
        orgId: 'org-1',
        versionRecord,
        catalogItem,
        deviceIds: ['dev-1', 'dev-2'],
        createdBy: 'user-1',
        markDispatched: false,
      }),
    );
  });

  it('dispatches nothing when the claim race is lost (no row returned)', async () => {
    selectMock.mockReturnValueOnce(selectChain([scheduledCandidate()]));
    updateMock.mockReturnValueOnce(updChain([])); // another instance claimed first

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 0, skipped: 1, errors: 0 });
    expect(buildAndDispatchMock).not.toHaveBeenCalled();
    // Only the (lost) claim attempt — no result-row selects, no fan-out.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a future scheduledAt deployment untouched', async () => {
    selectMock.mockReturnValueOnce(
      selectChain([scheduledCandidate({ scheduledAt: new Date(Date.now() + 30 * MINUTE) })]),
    );

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 0, skipped: 0, errors: 0 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(buildAndDispatchMock).not.toHaveBeenCalled();
  });

  it('leaves an already-dispatched deployment untouched (conditional claim returns no row)', async () => {
    // The SQL filter (dispatched_at IS NULL) normally excludes such rows; if
    // one races in anyway, the guarded claim returns nothing and we skip.
    selectMock.mockReturnValueOnce(selectChain([scheduledCandidate({ id: 'dep-done' })]));
    updateMock.mockReturnValueOnce(updChain([]));

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 0, skipped: 1, errors: 0 });
    expect(buildAndDispatchMock).not.toHaveBeenCalled();
  });

  it('does not dispatch a maintenance-window deployment while the window is closed', async () => {
    selectMock.mockReturnValueOnce(
      selectChain([
        maintenanceCandidate({
          windowStartTime: new Date(Date.now() + 60 * MINUTE),
          windowEndTime: new Date(Date.now() + 120 * MINUTE),
        }),
      ]),
    );

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 0, skipped: 0, errors: 0 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(buildAndDispatchMock).not.toHaveBeenCalled();
  });

  it('claims and dispatches a maintenance-window deployment while the window is open', async () => {
    selectMock.mockReturnValueOnce(selectChain([maintenanceCandidate()]));
    updateMock.mockReturnValueOnce(updChain([{ id: 'dep-mw' }]));
    queueHappyPathSelects(['dev-9']);

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 1, skipped: 0, errors: 0 });
    expect(buildAndDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'dep-mw', deviceIds: ['dev-9'], markDispatched: false }),
    );
  });

  it('skips the fan-out (but keeps the claim) when a deployment has no pending result rows', async () => {
    selectMock.mockReturnValueOnce(selectChain([scheduledCandidate()]));
    updateMock.mockReturnValueOnce(updChain([{ id: 'dep-1' }]));
    selectMock.mockReturnValueOnce(selectChain([])); // no pending rows (e.g. all cancelled)

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 1, skipped: 0, errors: 0 });
    expect(buildAndDispatchMock).not.toHaveBeenCalled();
  });

  it('fails pending result rows instead of dispatching when the software version is gone', async () => {
    selectMock.mockReturnValueOnce(selectChain([scheduledCandidate()]));
    updateMock.mockReturnValueOnce(updChain([{ id: 'dep-1' }]));
    selectMock
      .mockReturnValueOnce(selectChain([{ deviceId: 'dev-1' }])) // pending rows
      .mockReturnValueOnce(selectChain([])); // version vanished
    updateMock.mockReturnValueOnce(updChain()); // fail-pending-results update

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 1, skipped: 0, errors: 0 });
    expect(buildAndDispatchMock).not.toHaveBeenCalled();
    const failWrite = updateSetCalls.find((v) => v.status === 'failed');
    expect(failWrite).toBeDefined();
    expect(failWrite!.errorMessage).toMatch(/version no longer exists/i);
  });

  it('processes each pending device of each due deployment, and one failing deployment does not block the next', async () => {
    const depA = scheduledCandidate({ id: 'dep-a' });
    const depB = scheduledCandidate({ id: 'dep-b', createdBy: null });
    selectMock.mockReturnValueOnce(selectChain([depA, depB]));

    // dep-a: claim ok, then the fan-out blows up.
    updateMock.mockReturnValueOnce(updChain([{ id: 'dep-a' }]));
    queueHappyPathSelects(['dev-a1']);
    buildAndDispatchMock.mockRejectedValueOnce(new Error('presign exploded'));

    // dep-b: claim ok, dispatches its two pending devices.
    updateMock.mockReturnValueOnce(updChain([{ id: 'dep-b' }]));
    queueHappyPathSelects(['dev-b1', 'dev-b2']);
    buildAndDispatchMock.mockResolvedValueOnce({
      status: 'pending',
      dispatchedDeviceIds: ['dev-b1', 'dev-b2'],
    });

    const result = await runSoftwareDeploymentSchedulerTick();

    expect(result).toEqual({ claimed: 1, skipped: 0, errors: 1 });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(buildAndDispatchMock).toHaveBeenCalledTimes(2);
    expect(buildAndDispatchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ deploymentId: 'dep-b', deviceIds: ['dev-b1', 'dev-b2'] }),
    );
  });
});
