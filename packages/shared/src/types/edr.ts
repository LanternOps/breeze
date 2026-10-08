/**
 * Normalized EDR value sets (EDR provider framework, #8164 / spec D12).
 *
 * Each tuple is mirrored by a CHECK constraint on a varchar column in
 * apps/api/migrations/2026-12-16-100000-edr-provider-framework.sql, and
 * apps/api/src/__tests__/integration/edrProviderRls.integration.test.ts
 * compares the two. Extend both together: add the value here AND drop/re-add
 * the CHECK in a NEW migration. An unknown vendor value maps to the `unknown`
 * bucket (or `other` for OS platform) — adapters never throw on one.
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

export type EdrSeverity = (typeof EDR_SEVERITIES)[number];
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
