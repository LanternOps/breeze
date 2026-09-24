import { expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../db', () => ({ db: { select: m.select } }));
vi.mock('../services/eventBus', () => ({ getEventBus: () => ({ subscribe: vi.fn() }) }));
// automationWorker.ts's real imports of automationRuntime/featureConfigResolver
// pull in scriptDispatch -> commandQueue, which destructures `runOutsideDbContext`
// off `../db` at MODULE LOAD TIME — a real crash against the narrow `db`-only
// mock above, unrelated to what this test actually exercises (the early return
// before any of those code paths run). Sibling worker tests
// (automationWorker.monitorBinding.test.ts, automationWorker.monitorPause.test.ts)
// mock the same two modules for the same reason; mirrored here.
vi.mock('../services/automationRuntime', () => ({
  createAutomationRunRecord: vi.fn(),
  executeAutomationRun: vi.fn(),
  executeConfigPolicyAutomationRun: vi.fn(),
  formatScheduleTriggerKey: vi.fn(),
  isCronDue: vi.fn(),
  normalizeAutomationTrigger: vi.fn((trigger: Record<string, unknown>) => ({
    type: trigger.type,
    eventType: trigger.eventType ?? trigger.event,
    filter: trigger.filter,
  })),
}));
vi.mock('../services/featureConfigResolver', () => ({
  scanScheduledAutomations: vi.fn(),
  resolveAutomationsForDevice: vi.fn(),
  resolveAutomationsForDeviceWithPolicy: vi.fn(),
  resolveMaintenanceConfigForDevice: vi.fn(),
  isInMaintenanceWindow: vi.fn(),
}));

import { __testOnly } from './automationWorker';

it('does not query pause state or create a run for the second subject', async () => {
  m.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [{
          id: 'automation', managedByMonitorId: 'monitor', enabled: true,
          trigger: { type: 'event', event: 'alert.triggered' },
        }],
      }),
    }),
  });
  expect(await __testOnly.processTriggerEvent({
    type: 'trigger-event', automationId: 'automation', eventType: 'alert.triggered',
    eventPayload: { deviceId: 'device', responsesOwner: false }, eventTimestamp: '2026-09-23T12:00:00Z',
  })).toEqual({ skipped: 'subject_alert_not_response_owner' });
  expect(m.select).toHaveBeenCalledTimes(1);
});
