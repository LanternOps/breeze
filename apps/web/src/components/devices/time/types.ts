import type {
  TimeSyncHealth,
  TimeSyncType,
  TimeSyncServiceState,
  TimeSyncServiceStartType,
  TimeSyncStatusMethod,
  TimeSyncSourceKind,
  TimeSyncJoinType,
  TimeSyncDomainRole,
  TimeSyncAutoUpdate,
  TimeSyncEnforcementState,
  TimeSyncFindingCode,
  TimeSyncFindingSeverity,
} from '@breeze/shared';
export interface ExpectedTimezone {
  iana: string;
  windowsId: string;
  source: 'policy' | 'site';
  sourceId: string;
  sourceName: string | null;
}
export interface TimeSyncFinding {
  code: TimeSyncFindingCode;
  severity: TimeSyncFindingSeverity;
  detail: Record<string, string | number | null>;
}
export interface DeviceTimeStatusView {
  deviceId: string;
  state: 'reported' | 'not_reported' | 'unsupported_os';
  stale: boolean;
  receivedAt: string | null;
  collectedAt: string | null;
  health: TimeSyncHealth;
  findings: TimeSyncFinding[];
  config: {
    syncType: TimeSyncType | null;
    ntpServer: string | null;
    ntpServerHosts: string[];
    specialPollIntervalSeconds: number | null;
    policyManaged: boolean;
    policyManagedValues: string[];
    serviceState: TimeSyncServiceState;
    serviceStartType: TimeSyncServiceStartType;
    hostTimeProviderEnabled: boolean | null;
  } | null;
  status: {
    method: TimeSyncStatusMethod;
    source: string | null;
    sourceKind: TimeSyncSourceKind;
    lastSuccessfulSyncAt: string | null;
    lastSyncError: string | null;
    stratum: number | null;
    pollIntervalSeconds: number | null;
  } | null;
  domain: {
    joinType: TimeSyncJoinType;
    role: TimeSyncDomainRole;
    domainDns: string | null;
    forestDns: string | null;
    pdcName: string | null;
  } | null;
  timezone: {
    windowsId: string | null;
    biasMinutes: number | null;
    autoUpdate: TimeSyncAutoUpdate;
    expected: ExpectedTimezone | null;
    expectedUnsetReason: 'site_utc_default' | 'no_site' | 'unmapped' | null;
  } | null;
  recentEvents: Array<{
    recordId: number;
    eventId: number;
    level: number;
    occurredAt: string;
    message: string;
  }>;
  enforcement: TimeSyncEnforcementState | null;
}
