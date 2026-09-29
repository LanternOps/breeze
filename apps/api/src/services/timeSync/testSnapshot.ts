import type { TimeStatusSnapshot } from '@breeze/shared';
export function timeSnapshot(
  overrides: Partial<TimeStatusSnapshot> = {},
): TimeStatusSnapshot {
  return {
    schemaVersion: 1,
    sequence: 1,
    collectedAt: '2026-09-28T12:00:00Z',
    config: {
      type: 'NTP',
      ntpServer: null,
      specialPollIntervalSeconds: 3600,
      policyManaged: false,
      policyManagedValues: [],
      serviceState: 'running',
      serviceStartType: 'auto',
      hostTimeProviderEnabled: false,
    },
    status: {
      method: 'events',
      source: null,
      sourceKind: 'ntp_peer',
      lastSuccessfulSyncAt: '2026-09-28T11:59:00Z',
      lastSyncError: null,
      stratum: null,
      pollIntervalSeconds: 3600,
    },
    domain: {
      joinType: 'none',
      role: 'workgroup',
      domainDns: null,
      forestDns: null,
      pdcName: null,
    },
    timezone: {
      windowsId: 'UTC',
      biasMinutes: 0,
      dynamicDstDisabled: false,
      autoUpdate: 'off',
    },
    events: [],
    enforcement: null,
    ...overrides,
  };
}
