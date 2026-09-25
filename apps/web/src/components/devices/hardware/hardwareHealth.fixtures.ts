import type { HardwareComponentView, HardwareHealthView } from './types';
export function component(overrides: Partial<HardwareComponentView> = {}): HardwareComponentView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
    orgId: '33333333-3333-4333-8333-333333333333',
    componentKey: 'storcli:c0', componentType: 'controller', parentKey: null,
    source: 'storcli', name: 'PERC H730P Mini', model: 'H730P', serial: 'CTRL-1',
    firmware: '1.0', sizeBytes: null, health: 'ok', state: 'ok', stateDetail: null,
    progressPercent: null, temperatureC: null, predictiveFailure: false,
    alertExempt: false, attributes: {}, unhealthyStreak: 0, criticalStreak: 0,
    healthyStreak: 2, belowCriticalStreak: 2, predictiveStreak: 0,
    stale: false, staleSince: null, fresh: true,
    firstSeenAt: '2026-09-23T12:00:01.000Z', lastSeenAt: '2026-09-23T12:00:01.000Z',
    createdAt: '2026-09-23T12:00:01.000Z', updatedAt: '2026-09-23T12:00:01.000Z',
    ...overrides,
  };
}
export function view(overrides: Partial<HardwareHealthView> = {}): HardwareHealthView {
  return {
    health: 'ok', collectorHealth: 'ok', lastCollectedAt: '2026-09-23T12:00:00.000Z',
    lastReceivedAt: '2026-09-23T12:00:01.000Z', pollIntervalMinutes: 10,
    diskHealthIntervalMinutes: 60, tiersRun: ['raid'], agentVersion: '0.117.0',
    sources: [{ source: 'storcli', status: 'ok', complete: true, toolVersion: '7.4' }],
    components: [component()], events: [], policy: { enabled: true, source: 'default' },
    ...overrides,
  };
}
