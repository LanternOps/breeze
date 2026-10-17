/**
 * Normalized EDR value sets (EDR provider framework, #8164 / spec D12).
 *
 * Each tuple is mirrored by a CHECK constraint on a varchar column in
 * apps/api/migrations/2026-12-16-100000-edr-provider-framework.sql, and
 * apps/api/src/__tests__/integration/edrProviderRls.integration.test.ts
 * compares the two. Extend both together: add the value here AND drop/re-add
 * the CHECK in a NEW migration. For the sets that bucket VENDOR values
 * (severity, detection status, endpoint health / type, isolation state, OS
 * platform) an unknown vendor value maps to `unknown` (`other` for OS
 * platform) — adapters never throw on one. The remaining sets are
 * Breeze-originated and closed.
 */
export const EDR_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unknown'] as const;
export const EDR_DETECTION_STATUSES = [
  'open', 'in_progress', 'mitigated', 'resolved', 'false_positive', 'dismissed', 'unknown',
] as const;
/** Statuses that count as "still open" for denormalized-link rewrites and the feed. */
export const EDR_OPEN_DETECTION_STATUSES = ['open', 'in_progress', 'unknown'] as const;
export const EDR_ENDPOINT_HEALTH = ['healthy', 'degraded', 'unhealthy', 'unknown'] as const;
export const EDR_ISOLATION_STATES = ['isolated', 'not_isolated', 'pending', 'unknown'] as const;
export const EDR_OS_PLATFORMS = ['windows', 'macos', 'linux', 'other'] as const;
export const EDR_ENDPOINT_TYPES = ['workstation', 'server', 'mobile', 'unknown'] as const;
/** Name matches are suggestions only, never an automatic mapping (spec §4.5). */
export const EDR_MAPPING_SOURCES = ['manual', 'auto_external_code', 'manual_unmapped'] as const;
export const EDR_DEVICE_MATCH_SOURCES = ['auto_hostname', 'auto_mac', 'auto_serial', 'manual'] as const;
export const EDR_CONNECTION_STATUSES = ['connected', 'error', 'reauth_required'] as const;
export const EDR_SYNC_STATUSES = ['running', 'success', 'partial', 'error'] as const;
export const EDR_ACTION_STATUSES = ['queued', 'submitted', 'succeeded', 'failed'] as const;
export const EDR_ACTION_REQUESTED_VIA = ['ui', 'ai', 'automation', 'api'] as const;
/** The vendor's own noun for a finding, kept for display and as part of the detection identity. */
export const EDR_VENDOR_KINDS = ['alert', 'detection', 'threat', 'incident', 'quarantine_item'] as const;
/** Normalized response-action keys (spec §4.3). Order is part of the contract. */
export const EDR_ACTIONS = [
  'isolate', 'unisolate', 'scan', 'update_agent', 'kill_process', 'rollback',
  'resolve_detection', 'mark_false_positive', 'quarantine_restore', 'quarantine_delete',
] as const;
/** Actions aimed at an endpoint (W03). With EDR_DETECTION_ACTIONS this partitions EDR_ACTIONS. */
export const EDR_ENDPOINT_ACTIONS = ['isolate', 'unisolate', 'scan', 'update_agent', 'kill_process'] as const;
/** Actions aimed at one detection / quarantine item (W03). */
export const EDR_DETECTION_ACTIONS = [
  'rollback', 'resolve_detection', 'mark_false_positive', 'quarantine_restore', 'quarantine_delete',
] as const;

export type EdrSeverity =(typeof EDR_SEVERITIES)[number];
export type EdrDetectionStatus = (typeof EDR_DETECTION_STATUSES)[number];
export type EdrOpenDetectionStatus = (typeof EDR_OPEN_DETECTION_STATUSES)[number];
export type EdrEndpointHealth = (typeof EDR_ENDPOINT_HEALTH)[number];
export type EdrIsolationState = (typeof EDR_ISOLATION_STATES)[number];
export type EdrOsPlatform = (typeof EDR_OS_PLATFORMS)[number];
export type EdrEndpointType = (typeof EDR_ENDPOINT_TYPES)[number];
export type EdrMappingSource = (typeof EDR_MAPPING_SOURCES)[number];
export type EdrDeviceMatchSource = (typeof EDR_DEVICE_MATCH_SOURCES)[number];
export type EdrConnectionStatus = (typeof EDR_CONNECTION_STATUSES)[number];
export type EdrSyncStatus = (typeof EDR_SYNC_STATUSES)[number];
export type EdrActionStatus = (typeof EDR_ACTION_STATUSES)[number];
export type EdrActionRequestedVia = (typeof EDR_ACTION_REQUESTED_VIA)[number];
export type EdrVendorKind = (typeof EDR_VENDOR_KINDS)[number];
export type EdrActionKey = (typeof EDR_ACTIONS)[number];
export type EdrEndpointActionKey = (typeof EDR_ENDPOINT_ACTIONS)[number];
export type EdrDetectionActionKey = (typeof EDR_DETECTION_ACTIONS)[number];

/**
 * Whether one action can be taken on one endpoint right now, and why not
 * (W03). Computed without a vendor call from the connection, tenant and
 * endpoint rows; the vendor stays authoritative at dispatch.
 */
export interface EdrEndpointActionAvailability {
  action: EdrActionKey;
  available: boolean;
  reason: string | null;
  /**
   * Set (true) only when the action would be allowed but the session has not
   * passed MFA, so the UI can prompt for verification instead of a dead button.
   */
  mfaRequired?: boolean;
}

/**
 * One `edr_actions` ledger row as routes, AI tools and the web UI see it (W03).
 * The jsonb `payload` is never part of it. `outcomeUnknown` = the request may
 * have reached the vendor but no answer came back; the reconciler settles it
 * and nothing re-sends.
 */
export interface EdrActionDto {
  id: string;
  orgId: string;
  provider: string;
  action: EdrActionKey;
  status: EdrActionStatus;
  requestedVia: EdrActionRequestedVia;
  requestedBy: string | null;
  aiSessionId: string | null;
  approvalId: string | null;
  endpointId: string | null;
  detectionId: string | null;
  breezeDeviceId: string | null;
  error: string | null;
  outcomeUnknown: boolean;
  requestedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
}

/**
 * One EDR-framework detection as the read routes, AI tools and web UI see it
 * (#8166 W02). Vendor jsonb (`details`) and raw payloads are never part of it.
 * `title`/`threatName`/`filePath`/`processName` are vendor-supplied
 * (attacker-influenced) text: AI output fences them as raw text.
 */
export interface EdrDetectionDto {
  id: string;
  /** Omitted for organization-scope callers: they cannot read connections. */
  connectionId?: string;
  orgId: string;
  provider: string;
  providerLabel: string;
  vendorDetectionId: string;
  vendorKind: EdrVendorKind;
  severity: EdrSeverity;
  status: EdrDetectionStatus;
  title: string | null;
  category: string | null;
  threatName: string | null;
  filePath: string | null;
  processName: string | null;
  mitreTechniques: string[];
  detectedAt: string | null;
  resolvedAt: string | null;
  endpointId: string | null;
  breezeDeviceId: string | null;
  deviceName: string | null;
  /** The device link was cleared by an org move / device delete (D14). */
  detached: boolean;
  promotedIncidentId: string | null;
}

/**
 * Coverage disclosure carried by every EDR read (D6): an empty detection list
 * with `partial: true` is NOT evidence of "no threats". `notes` are
 * Breeze-generated sentences only, never vendor-supplied text.
 */
export interface EdrCoverage {
  orgsWithEdr: number;
  partial: boolean;
  notes: string[];
}

export interface EdrStatusProviderSummary {
  provider: string;
  label: string;
  /** Partner/system scope only (org tokens cannot read connections/tenants under RLS). */
  connectionId?: string;
  connectionStatus?: EdrConnectionStatus;
  tenantsMapped?: number;
  tenantsUnmapped?: number;
  tenantsStale?: number;
  tenantsFailed?: number;
  /** Mapped tenants that have never completed a detection sync. */
  tenantsPending?: number;
  endpoints: number;
  linkedEndpoints: number;
  unhealthyEndpoints: number;
  openDetections: number;
  lastDetectionSyncAt: string | null;
}

export interface EdrStatusSummary {
  providers: EdrStatusProviderSummary[];
  coverage: EdrCoverage;
}
