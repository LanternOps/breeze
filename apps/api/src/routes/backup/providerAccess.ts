import { sql } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { backupProviderConnections } from '../../db/schema';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';

/** Just enough of `AuthContext` for the provider routes, so tests can build one by hand. */
export type ProviderRouteAuth = Pick<
  AuthContext,
  'scope' | 'partnerId' | 'partnerOrgAccess' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'
>;

export type GateFailure = { error: string; status: 400 | 403 };

/**
 * READ gate for the partner-level surfaces (connections, customer mappings).
 *
 * An org-scoped token is refused outright rather than filtered: these rows are
 * the MSP's own vendor credentials and its customer directory, and an org user
 * has no business knowing which other customers exist. RLS enforces the same
 * thing one layer down — `breeze_has_partner_access` is false for an org
 * token — so this gate produces an honest 403 instead of an empty list.
 */
export function resolveProviderPartnerId(auth: ProviderRouteAuth): { partnerId: string } | GateFailure {
  if (auth.scope === 'organization') {
    return { error: 'Backup provider connections are managed at partner scope', status: 403 };
  }
  if (!auth.partnerId) {
    return { error: 'Partner context required', status: 403 };
  }
  return { partnerId: auth.partnerId };
}

/**
 * WRITE gate. Adds `canManagePartnerWidePolicies` — a partner user with
 * `org_access = 'selected'` may see the connection card but must not rotate the
 * credential or re-map a customer, because both take effect for EVERY org under
 * the partner including ones that user cannot see. Same gate as
 * `routes/huntress.ts`'s integration upsert and org mapping.
 */
export function requireProviderPartnerAdmin(auth: ProviderRouteAuth): { partnerId: string } | GateFailure {
  const read = resolveProviderPartnerId(auth);
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
 * The ONLY column set any route selects from `backup_provider_connections`.
 *
 * `credentials_encrypted` is deliberately absent and replaced by a computed
 * `hasCredentials`: a route cannot leak a ciphertext it never loaded, and the
 * UI only ever needs to know whether one is present. This is the mechanical
 * half of "the password is never returned by any route".
 */
export const CONNECTION_PUBLIC_SELECT = {
  id: backupProviderConnections.id,
  partnerId: backupProviderConnections.partnerId,
  provider: backupProviderConnections.provider,
  name: backupProviderConnections.name,
  baseUrl: backupProviderConnections.baseUrl,
  vendorRootId: backupProviderConnections.vendorRootId,
  vendorRootName: backupProviderConnections.vendorRootName,
  isActive: backupProviderConnections.isActive,
  status: backupProviderConnections.status,
  syncIntervalMinutes: backupProviderConnections.syncIntervalMinutes,
  showProviderNameInPortal: backupProviderConnections.showProviderNameInPortal,
  lastSyncAt: backupProviderConnections.lastSyncAt,
  lastSyncStatus: backupProviderConnections.lastSyncStatus,
  lastSyncError: backupProviderConnections.lastSyncError,
  lastSyncCustomers: backupProviderConnections.lastSyncCustomers,
  lastSyncUnmappedCustomers: backupProviderConnections.lastSyncUnmappedCustomers,
  lastSyncDevices: backupProviderConnections.lastSyncDevices,
  lastSyncUnmappedDevices: backupProviderConnections.lastSyncUnmappedDevices,
  lastSyncLinkedDevices: backupProviderConnections.lastSyncLinkedDevices,
  lastSyncAmbiguousDevices: backupProviderConnections.lastSyncAmbiguousDevices,
  createdAt: backupProviderConnections.createdAt,
  updatedAt: backupProviderConnections.updatedAt,
  hasCredentials: sql<boolean>`(${backupProviderConnections.credentialsEncrypted} IS NOT NULL AND ${backupProviderConnections.credentialsEncrypted} <> '')`,
} as const;

export type ConnectionPublicRow = {
  [K in keyof typeof CONNECTION_PUBLIC_SELECT]: unknown;
};

/**
 * The default endpoint is pinned; an override must be HTTPS (spec, Security).
 * The database CHECK `backup_provider_connections_base_url_chk` is the
 * structural backstop — this is the friendly 400.
 */
export function assertHttpsBaseUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') return 'baseUrl must use https://';
    return null;
  } catch {
    return 'baseUrl must be a valid URL';
  }
}
