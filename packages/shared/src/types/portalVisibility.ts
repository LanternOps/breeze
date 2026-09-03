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
    label: 'endpoint threat events';
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
  type: 'security_compliance_posture' | 'executive_summary';
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
