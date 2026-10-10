import { sql } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { edrConnections, edrTenants } from '../../db/schema';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';

/** Just enough of `AuthContext` for the EDR routes, so tests can build one by hand. */
export type EdrRouteAuth = Pick<
  AuthContext,
  'scope' | 'partnerId' | 'partnerOrgAccess' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'
>;

export type GateFailure = { error: string; status: 400 | 403 };

/**
 * READ gate for the partner-level surfaces (connections, tenant mappings). An
 * org-scoped token is refused outright: these rows are the MSP's own vendor
 * credentials and customer directory. RLS says the same one layer down.
 */
export function resolveEdrPartnerId(auth: EdrRouteAuth): { partnerId: string } | GateFailure {
  if (auth.scope === 'organization') {
    return { error: 'EDR connections are managed at partner scope', status: 403 };
  }
  if (!auth.partnerId) {
    return { error: 'Partner context required', status: 403 };
  }
  return { partnerId: auth.partnerId };
}

/**
 * WRITE gate. A partner user with `org_access = 'selected'` may see the
 * connection card but must not rotate the key or re-map a tenant: both take
 * effect for EVERY org under the partner, including ones that user cannot see.
 */
export function requireEdrPartnerAdmin(auth: EdrRouteAuth): { partnerId: string } | GateFailure {
  const read = resolveEdrPartnerId(auth);
  if ('error' in read) return read;
  if (!canManagePartnerWidePolicies(auth)) {
    return { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, status: 403 };
  }
  return read;
}

export function isGateFailure(value: unknown): value is GateFailure {
  return !!value && typeof value === 'object' && 'error' in (value as Record<string, unknown>);
}

/** The Postgres error code of a caught driver error, however postgres.js wrapped it. */
export function pgErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' ? cause.code : null;
}

/**
 * The ONLY column set any route selects from `edr_connections`. Every
 * `*_encrypted` column is absent and replaced by a computed boolean, so a route
 * cannot leak a ciphertext it never loaded.
 */
export const EDR_CONNECTION_PUBLIC_SELECT = {
  id: edrConnections.id,
  partnerId: edrConnections.partnerId,
  provider: edrConnections.provider,
  name: edrConnections.name,
  baseUrl: edrConnections.baseUrl,
  region: edrConnections.region,
  vendorRootId: edrConnections.vendorRootId,
  vendorRootName: edrConnections.vendorRootName,
  vendorRootType: edrConnections.vendorRootType,
  isActive: edrConnections.isActive,
  status: edrConnections.status,
  detectionIntervalMinutes: edrConnections.detectionIntervalMinutes,
  inventoryIntervalMinutes: edrConnections.inventoryIntervalMinutes,
  effectiveDetectionIntervalMinutes: edrConnections.effectiveDetectionIntervalMinutes,
  effectiveInventoryIntervalMinutes: edrConnections.effectiveInventoryIntervalMinutes,
  lastInventorySyncAt: edrConnections.lastInventorySyncAt,
  lastInventorySyncStatus: edrConnections.lastInventorySyncStatus,
  lastInventorySyncError: edrConnections.lastInventorySyncError,
  lastDetectionSyncAt: edrConnections.lastDetectionSyncAt,
  lastDetectionSyncStatus: edrConnections.lastDetectionSyncStatus,
  lastDetectionSyncError: edrConnections.lastDetectionSyncError,
  lastSyncTenants: edrConnections.lastSyncTenants,
  lastSyncUnmappedTenants: edrConnections.lastSyncUnmappedTenants,
  lastSyncFailedTenants: edrConnections.lastSyncFailedTenants,
  lastSyncEndpoints: edrConnections.lastSyncEndpoints,
  lastSyncLinkedEndpoints: edrConnections.lastSyncLinkedEndpoints,
  lastSyncAmbiguousEndpoints: edrConnections.lastSyncAmbiguousEndpoints,
  lastSyncOpenDetections: edrConnections.lastSyncOpenDetections,
  capabilitiesSnapshot: edrConnections.capabilitiesSnapshot,
  createdAt: edrConnections.createdAt,
  updatedAt: edrConnections.updatedAt,
  hasCredentials: sql<boolean>`(${edrConnections.credentialsEncrypted} IS NOT NULL AND ${edrConnections.credentialsEncrypted} <> '')`,
  hasWebhookSecret: sql<boolean>`(${edrConnections.webhookSecretEncrypted} IS NOT NULL AND ${edrConnections.webhookSecretEncrypted} <> '')`,
} as const;

/** Same rule for `edr_tenants`: no `installer_secret_encrypted`, only a boolean. */
export const EDR_TENANT_PUBLIC_SELECT = {
  id: edrTenants.id,
  connectionId: edrTenants.connectionId,
  vendorTenantId: edrTenants.vendorTenantId,
  vendorTenantName: edrTenants.vendorTenantName,
  vendorParentId: edrTenants.vendorParentId,
  vendorTenantType: edrTenants.vendorTenantType,
  vendorExternalCode: edrTenants.vendorExternalCode,
  apiHost: edrTenants.apiHost,
  orgId: edrTenants.orgId,
  mappingSource: edrTenants.mappingSource,
  endpointCount: edrTenants.endpointCount,
  openDetectionCount: edrTenants.openDetectionCount,
  lastSeenAt: edrTenants.lastSeenAt,
  vendorMissingSince: edrTenants.vendorMissingSince,
  lastInventorySyncAt: edrTenants.lastInventorySyncAt,
  lastInventorySyncStatus: edrTenants.lastInventorySyncStatus,
  lastInventorySyncError: edrTenants.lastInventorySyncError,
  lastDetectionSyncAt: edrTenants.lastDetectionSyncAt,
  lastDetectionSyncStatus: edrTenants.lastDetectionSyncStatus,
  lastDetectionSyncError: edrTenants.lastDetectionSyncError,
  hasInstallerSecret: sql<boolean>`(${edrTenants.installerSecretEncrypted} IS NOT NULL AND ${edrTenants.installerSecretEncrypted} <> '')`,
} as const;
