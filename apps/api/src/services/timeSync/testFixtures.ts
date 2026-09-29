import type { TimeStatusSnapshot } from '@breeze/shared';
export const NOW = new Date('2026-09-28T10:40:00Z');
export function snapshot(): TimeStatusSnapshot {
  return {
    schemaVersion: 1,
    sequence: 1,
    collectedAt: NOW.toISOString(),
    config: {
      type: 'NTP',
      ntpServer: 'pool.ntp.org,0x9',
      specialPollIntervalSeconds: 3600,
      policyManaged: false,
      policyManagedValues: [],
      serviceState: 'running',
      serviceStartType: 'auto',
      hostTimeProviderEnabled: false,
    },
    status: {
      method: 'provider_api',
      source: 'pool.ntp.org',
      sourceKind: 'ntp_peer',
      lastSuccessfulSyncAt: '2026-09-28T09:00:00Z',
      lastSyncError: null,
      stratum: 3,
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
      windowsId: 'Pacific Standard Time',
      biasMinutes: 480,
      dynamicDstDisabled: false,
      autoUpdate: 'off',
    },
    events: [],
    enforcement: null,
  };
}
export function event(
  eventId: number,
  occurredAt: string,
  recordId = eventId,
): TimeStatusSnapshot['events'][number] {
  return {
    eventId,
    occurredAt,
    recordId,
    level: 2,
    message: 'Display-only message',
    properties: ['peer.example.com'],
  };
}
