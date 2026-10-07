import type { BackupHealth, ExternalBackupStatus } from './backupHealth';
import type { ServiceTileDto } from './portalService';

export type TileStatus =
  | 'ok'
  | 'no_data'
  | 'not_configured'
  | 'stale';

export type SecurityScoreBand =
  | 'strong'
  | 'good'
  | 'fair'
  | 'at_risk';

/**
 * Device protection state classification from security compliance analysis.
 * Reflects agent-provided and policy-provided signals.
 */
export type ProtectionState =
  | 'protected'
  | 'unprotected'
  | 'unknown';

export interface PaginationDto {
  page: number;
  limit: number;
  total: number;
}

export interface CountHoursDto {
  minutes: number;
  hours: number;
}

export interface SecurityScoreTileDto {
  status: TileStatus;
  score: number | null;
  band: SecurityScoreBand | null;
  delta30d: number | null;
  capturedAt: string | null;
}

export interface DevicesProtectedTileDto {
  status: TileStatus;
  protected: number | null;
  unprotected: number | null;
  unknown: number | null;
  total: number | null;
  asOf: string | null;
}

export interface PatchesAppliedTileDto {
  status: TileStatus;
  applied: number | null;
  devicesWithOutstandingCritical: number | null;
  month: string;
  timezone: string;
  asOf: string;
}

export interface BackupTileDto {
  status: TileStatus;
  completedAt: string | null;
  verificationType: string | null;
  configured: number | null;
  total: number | null;
  asOf: string;
}

export interface SupportTileDto {
  status: TileStatus;
  openTickets: number | null;
  averageFirstResponseMinutes: number | null;
  sampleSize: number;
  month: string;
  timezone: string;
  asOf: string;
}

export interface ActionItemsTileDto {
  status: TileStatus;
  count: number | null;
  topIssues: string[];
  asOf: string;
}

export interface AwaitingYouTileDto {
  status: TileStatus;
  proposals: number | null;
  invoices: number | null;
  asOf: string;
}

export interface DashboardDto {
  asOf: string;
  timezone: string;
  securityScore: SecurityScoreTileDto;
  devicesProtected: DevicesProtectedTileDto;
  patchesApplied: PatchesAppliedTileDto;
  backup: BackupTileDto;
  support: SupportTileDto;
  actionItems: ActionItemsTileDto;
  awaitingYou: AwaitingYouTileDto;
  /** Service deliverables W04: present only when the org's enable_service flag
   *  is on, so a portal that never enabled it keeps its previous payload. */
  service?: ServiceTileDto;
}

export interface SecurityTrendPoint {
  capturedAt: string;
  score: number;
}

export interface ThreatSourceCounts {
  native: number;
  sentinelOne: number;
  huntress: number;
}

export interface ThreatWeekDto {
  weekStart: string;
  detected: number;
  resolved: number;
  detectedBySource: ThreatSourceCounts;
  resolvedBySource: ThreatSourceCounts;
}

export interface SecurityOverviewDto {
  dataStatus: TileStatus;
  asOf: string;
  score: number | null;
  band: SecurityScoreBand | null;
  scoreHistory: SecurityTrendPoint[];
  threatEvents: {
    label: 'Endpoint threat events';
    weeks: ThreatWeekDto[];
  };
  vulnerabilities: {
    openBySeverity: Record<string, number>;
    kevCount: number;
    lastDetectedAt: string | null;
  };
}

export interface SecurityDeviceRow {
  id: string;
  name: string;
  protection: ProtectionState;
  avProducts: string[];
  realTimeProtection: boolean | null;
  definitionsAgeDays: number | null;
  encryption: string | null;
  firewall: boolean | null;
  pendingCriticalPatches: number;
  observedAt: string | null;
}

export interface SecurityDevicesDto {
  dataStatus: TileStatus;
  asOf: string;
  timezone: string;
  data: SecurityDeviceRow[];
  pagination: PaginationDto;
}

export interface BackupDeviceRow {
  id: string;
  name: string;
  configured: boolean;
  lastRestorePointAt: string | null;
  lastRestorePointDegraded: boolean;
  lastTestRestore: {
    status: string;
    completedAt: string | null;
    restoreTimeSeconds: number | null;
  } | null;
  openBreaches: string[];
  readinessScore: number | null;
  estimatedRtoMinutes: number | null;
  estimatedRpoMinutes: number | null;
  /** Which product `status`/`health` come from. 'breeze' = first-party backup
   *  (or no backup at all); a third party may ALSO back the device up — see
   *  `providerLabel`. 'external' = only a third party backs this row up: a
   *  managed device (`id` = device id) or a third-party row with no managed
   *  device (`id` = `provider:<row id>`). Verification, restore-test, breach
   *  and readiness fields are first-party facts either way. (#6012) */
  source: 'breeze' | 'external';
  /** The third-party product label to SHOW, already resolved server-side per
   *  the connection's portal-name toggle (spec D5): the generic "Managed cloud
   *  backup" unless the MSP chose to name the vendor. Null when no third-party
   *  backup covers this row. */
  providerLabel: string | null;
  status: ExternalBackupStatus;
  health: BackupHealth;
  /** Newest successful backup across every source backing this row up. */
  lastSuccessAt: string | null;
}

export interface BackupOverviewDto {
  dataStatus: TileStatus;
  asOf: string;
  protected: number | null;
  unprotected: number | null;
  total: number | null;
  lastPassedVerification: {
    completedAt: string;
    verificationType: string;
  } | null;
  lastTestRestoreAt: string | null;
  openRpoBreaches: number | null;
  openRtoBreaches: number | null;
  meanReadinessScore: number | null;
  lastTestRestoreStatus: string | null;
  readinessScoredDevices: number | null;
  readinessTotalDevices: number | null;
  /** Rows of the device ledger by derived health — one per Breeze device
   *  (first-party and third-party merged) plus one per unlinked third-party
   *  row. Always zero-filled. (#6012) */
  byHealth: Record<BackupHealth, number>;
  /** Distinct third-party backup labels shown for this org (D5-resolved),
   *  sorted. Empty when no third-party backup reports for the org. (#6012) */
  externalProviders: string[];
}

export interface BackupDevicesDto {
  dataStatus: TileStatus;
  asOf: string;
  data: BackupDeviceRow[];
  pagination: PaginationDto;
}

export interface SupportUsageTicketDto {
  ticketNumber: string;
  title: string | null;
  billedMinutes: number;
  toBeBilledMinutes: number;
  coveredByContractMinutes: number;
  pendingReviewMinutes: number;
}

export interface SupportUsageDto {
  dataStatus: TileStatus;
  asOf: string;
  month: string;
  timezone: string;
  totals: {
    billed: CountHoursDto;
    toBeBilled: CountHoursDto;
    coveredByContract: CountHoursDto;
    pendingReview: CountHoursDto;
  };
  tickets: SupportUsageTicketDto[];
}

export interface SlaDto {
  firstResponseMinutes: number | null;
  resolutionMinutes: number | null;
  responseTargetMinutes: number | null;
  resolutionTargetMinutes: number | null;
  status:
    | 'breached'
    | 'at_risk'
    | 'paused'
    | 'on_track'
    | 'met'
    | 'not_configured';
}

export interface PortalRunDto {
  id: string;
  reportId: string;
  /** Every type a portal run row can carry. `portalRunListPredicate` filters
   *  on org, portal_self_service and status — it has NO type filter — so a
   *  managed-evidence run of a new type flows through here. An unwidened union
   *  is a type lie the compiler cannot see, because the value comes from the
   *  database. Not every member is portal-GENERATABLE: see PORTAL_REPORT_TYPES. */
  type:
    | 'security_compliance_posture'
    | 'executive_summary'
    | 'hardware_lifecycle'
    // #5784 W02 — managed evidence. Visible (after delivery) but never
    // generatable by a portal user, so it belongs in this union without
    // belonging in PORTAL_REPORT_TYPES.
    | 'threat_detection_review'
    // #5784 W03 — managed evidence; listed after delivery, never generated here.
    | 'endpoint_management_review'
    // #5784 W04 — managed evidence, visible only once delivered.
    | 'vulnerability_management'
    // #5784 W06 — managed evidence, same rule. `portalRunListPredicate` has no
    // type filter, so an unwidened union here is a type lie the compiler cannot
    // see: the value comes from the database.
    | 'identity_access_review';
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  rowCount: number | null;
  createdAt: string;
}

export interface PortalRunsDto {
  data: PortalRunDto[];
  pagination: PaginationDto;
  timezone: string;
}

export interface EnrichedPortalDevice {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  osVersion: string;
  status: string;
  lastSeenAt: string | null;
  lastPatchAt: string | null;
  protection: ProtectionState;
  encryption: string | null;
  lastBackupAt: string | null;
  warrantyEndsAt: string | null;
}

/**
 * Customer-safe Network Visibility overview (#5861).
 *
 * `no_data` and `not_enabled` deliberately carry null metrics so unavailable
 * information can never be confused with a measured zero.
 */
export type NetworkOverviewDto =
  | {
      dataStatus: 'ok';
      totalAssets: number;
      onlineAssets: number;
      offlineAssets: number;
      snmpDevicesPolling: number;
      monitorsDown: number;
    }
  | {
      dataStatus: 'no_data' | 'not_enabled';
      totalAssets: null;
      onlineAssets: null;
      offlineAssets: null;
      snmpDevicesPolling: null;
      monitorsDown: null;
    };

/** Mirrors alert_severity (apps/api/src/db/schema/alerts.ts); ranked critical > high > medium > low > info. */
export type NetworkAssetAlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface NetworkAssetRowDto {
  id: string;
  hostname: string | null;
  /** Technician-set display name; often more useful than hostname, which is frequently null. */
  label: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  assetType: string;
  /** null = unverified; never conflated with offline. */
  onlineState: 'online' | 'offline' | null;
  lastSeenAt: string | null;
  firstSeenAt: string;
  manufacturer: string | null;
  model: string | null;
  siteName: string;
  /**
   * Alert/ticket enrichment (#5861 PR 3). Present -- zero-filled when the
   * asset has no active alerts -- whenever the org's enable_network_alerts
   * flag is on; omitted entirely (never null-filled) when the flag is off,
   * mirroring the optional `service?` pattern on DashboardDto.
   */
  activeAlertCount?: number;
  /** Highest severity among this asset's active network-monitor alerts; null when activeAlertCount is 0. */
  highestAlertSeverity?: NetworkAssetAlertSeverity | null;
  /** Distinct non-terminal tickets linked (via ticket_alert_links) to this asset's active alerts. */
  openTicketCount?: number;
}

/** A site that has at least one portal-visible network asset (#7025). */
export interface NetworkSiteDto {
  id: string;
  name: string;
}

/**
 * Sites to offer in the per-asset table's Site filter (#7025). Only sites with
 * portal-visible (non-dismissed) assets are listed, so every option can match
 * rows. `not_enabled` carries an empty list, mirroring NetworkAssetsDto.
 */
export interface NetworkSitesDto {
  dataStatus: 'ok' | 'not_enabled';
  data: NetworkSiteDto[];
}

/**
 * Customer-safe Network Visibility per-asset list (#5861, PR 2).
 *
 * `no_data` and `not_enabled` carry an empty list, never a partial or
 * synthetic one, mirroring the `not_enabled`/`no_data`/`ok` contract from
 * NetworkOverviewDto.
 */
export type NetworkAssetsDto =
  | {
      dataStatus: 'ok';
      data: NetworkAssetRowDto[];
      pagination: PaginationDto;
    }
  | {
      dataStatus: 'no_data' | 'not_enabled';
      data: [];
      pagination: PaginationDto;
    };
