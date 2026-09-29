export const TIME_SYNC_FINDING_CODES = [
  'pdc_no_external_source',
  'source_local_clock',
  'dc_vm_host_sync',
  'ntp_server_unresolvable',
  'ntp_peer_unreachable',
  'domain_source_unavailable',
  'member_not_on_hierarchy',
  'sync_disabled',
  'sync_stale',
  'correction_refused',
  'timezone_mismatch',
  'policy_not_applied', // raised only from W03a on
  'policy_conflict_gpo', // raised only from W03a on
] as const;
export type TimeSyncFindingCode = (typeof TIME_SYNC_FINDING_CODES)[number];

export type TimeSyncFindingSeverity = 'critical' | 'warning' | 'info';
export const TIME_SYNC_FINDING_SEVERITY: Record<
  TimeSyncFindingCode,
  TimeSyncFindingSeverity
> = {
  pdc_no_external_source: 'critical',
  source_local_clock: 'critical',
  dc_vm_host_sync: 'warning',
  ntp_server_unresolvable: 'warning',
  ntp_peer_unreachable: 'warning',
  domain_source_unavailable: 'warning',
  member_not_on_hierarchy: 'warning',
  sync_disabled: 'critical',
  sync_stale: 'warning',
  correction_refused: 'warning',
  timezone_mismatch: 'info',
  policy_not_applied: 'warning',
  policy_conflict_gpo: 'info',
};

export const TIME_SYNC_HEALTH = [
  'healthy',
  'warning',
  'critical',
  'unknown',
] as const;
export type TimeSyncHealth = (typeof TIME_SYNC_HEALTH)[number];

export const TIME_SYNC_TYPES = ['NT5DS', 'NTP', 'NoSync', 'AllSync'] as const;
export const TIME_SYNC_SOURCE_KINDS = [
  'ntp_peer',
  'domain_peer',
  'local_clock',
  'free_running',
  'vm_host',
  'unknown',
] as const;
export const TIME_SYNC_STATUS_METHODS = [
  'provider_api',
  'w32tm_tokens',
  'events',
  'unavailable',
] as const;
export const TIME_SYNC_JOIN_TYPES = [
  'none',
  'workplace',
  'azure_ad',
  'on_prem_ad',
  'hybrid_azure_ad',
  'unknown',
] as const;
export const TIME_SYNC_DOMAIN_ROLES = [
  'workgroup',
  'entra_only',
  'member',
  'dc',
  'pdc_emulator',
  'forest_root_pdc_emulator',
  'unknown',
] as const;
export const TIME_SYNC_SERVICE_STATES = [
  'running',
  'stopped',
  'start_pending',
  'stop_pending',
  'paused',
  'not_installed',
  'unknown',
] as const;
export const TIME_SYNC_SERVICE_START_TYPES = [
  'auto',
  'delayed_auto',
  'manual',
  'trigger_manual',
  'disabled',
  'unknown',
] as const;
export const TIME_SYNC_AUTO_UPDATE = ['on', 'off', 'unknown'] as const;
export type TimeSyncType = (typeof TIME_SYNC_TYPES)[number];
export type TimeSyncSourceKind = (typeof TIME_SYNC_SOURCE_KINDS)[number];
export type TimeSyncStatusMethod = (typeof TIME_SYNC_STATUS_METHODS)[number];
export type TimeSyncJoinType = (typeof TIME_SYNC_JOIN_TYPES)[number];
export type TimeSyncDomainRole = (typeof TIME_SYNC_DOMAIN_ROLES)[number];
export type TimeSyncServiceState = (typeof TIME_SYNC_SERVICE_STATES)[number];
export type TimeSyncServiceStartType =
  (typeof TIME_SYNC_SERVICE_START_TYPES)[number];
export type TimeSyncAutoUpdate = (typeof TIME_SYNC_AUTO_UPDATE)[number];

/** Time-Service event IDs the collector must send and the resolver reads. */
export const TIME_SYNC_FAILURE_EVENT_FINDING: Readonly<
  Record<number, TimeSyncFindingCode>
> = {
  12: 'pdc_no_external_source',
  24: 'ntp_peer_unreachable',
  29: 'ntp_peer_unreachable',
  36: 'sync_stale',
  47: 'ntp_peer_unreachable',
  52: 'correction_refused',
  129: 'domain_source_unavailable',
  134: 'ntp_server_unresolvable',
};
export const TIME_SYNC_SUCCESS_EVENT_IDS = [35, 37] as const;
export const TIME_SYNC_EVENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TIME_SYNC_SNAPSHOT_INTERVAL_MINUTES = 30;
/** A status older than this is stale (3 × interval). */
export const TIME_SYNC_STALE_AFTER_MS =
  3 * TIME_SYNC_SNAPSHOT_INTERVAL_MINUTES * 60 * 1000;
/** Poll fallback when the device reports none (Windows standalone default: 7 days). */
export const TIME_SYNC_DEFAULT_POLL_SECONDS = 604800;
export const TIME_SYNC_RECENT_EVENTS_MAX = 20;
export const TIME_SYNC_SNAPSHOT_EVENTS_MAX = 100;
/** Sites at these values have no expected timezone (spec D6). */
export const TIME_SYNC_UNSET_SITE_TIMEZONES = ['UTC', 'Etc/UTC'] as const;
