// apps/web/src/components/devices/time/fixtures.ts
import type { DeviceTimeStatusView } from './types';
export function view(
  patch: Partial<DeviceTimeStatusView> = {},
): DeviceTimeStatusView {
  return {
    deviceId: '11111111-1111-4111-8111-111111111111',
    state: 'reported',
    stale: false,
    collectedAt: '2026-09-28T10:00:00Z',
    receivedAt: '2026-09-28T10:01:00Z',
    health: 'healthy',
    findings: [],
    config: {
      syncType: 'NTP',
      ntpServer: 'pool.ntp.org,0x9',
      ntpServerHosts: ['pool.ntp.org'],
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
      lastSuccessfulSyncAt: '2026-09-28T09:59:00Z',
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
      autoUpdate: 'off',
      expected: null,
      expectedUnsetReason: 'site_utc_default',
    },
    recentEvents: [
      {
        recordId: 9,
        eventId: 134,
        level: 2,
        occurredAt: '2026-09-28T09:00:00Z',
        message: '<script>untrusted display text</script>',
      },
    ],
    enforcement: null,
    ...patch,
  };
}
