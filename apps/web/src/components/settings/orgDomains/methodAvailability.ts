import { fetchWithAuth } from '../../../stores/auth';
import {
  isPortalEntraTenantView,
  passwordFallbackOf,
  type PortalEntraTenantView,
  type PortalPasswordFallbackNotice,
} from '../portalAccess/types';

/**
 * Whether the directory methods can run for an org (plan D7, OD2, D8). This is
 * a UX hint that saves a pointless check; the server's checker is the authority
 * and answers `fail` / `unavailable` on its own. So a status we could not load,
 * or could not read, leaves the method enabled rather than guessing it away.
 */
export type EntraUnavailableReason = 'tenant_not_proven' | 'connection_missing' | 'not_enabled';
export type GoogleUnavailableReason = 'connection_missing' | 'not_enabled';
type Availability<R extends string> = { available: true } | { available: false; reason: R };
export type DirectoryMethod = 'entra_tenant' | 'google_directory';
export interface DomainMethodAvailability {
  entra_tenant: Availability<EntraUnavailableReason>;
  google_directory: Availability<GoogleUnavailableReason>;
}

const AVAILABLE = { available: true } as const;
export const UNKNOWN_AVAILABILITY: DomainMethodAvailability = { entra_tenant: AVAILABLE, google_directory: AVAILABLE };

/**
 * D7: the Entra checker reads `/organization` through the org's identity-first
 * M365 connection bound to the PROVEN tenant. A tenant proven by a proof run
 * with no such connection cannot use the method (OD2).
 */
export function entraAvailability(tenant: PortalEntraTenantView): Availability<EntraUnavailableReason> {
  if (tenant.state !== 'proven' || !tenant.tenantId) return { available: false, reason: 'tenant_not_proven' };
  if (!tenant.connectionTenantId || tenant.connectionTenantId.toLowerCase() !== tenant.tenantId.toLowerCase()) {
    return { available: false, reason: 'connection_missing' };
  }
  return AVAILABLE;
}

type EntraStatus = { availability: Availability<EntraUnavailableReason>; passwordFallback: PortalPasswordFallbackNotice | null };

/** One read of the org's Entra tenant status serves both the method hint and the #11582 password-fallback notice. */
async function loadEntra(orgId: string): Promise<EntraStatus> {
  const unknown: EntraStatus = { availability: AVAILABLE, passwordFallback: null };
  try {
    const res = await fetchWithAuth(`/orgs/organizations/${orgId}/portal-entra-tenant`);
    if (res.status === 404) {
      // No portal Entra app on this deployment: no tenant can be proven here (W4).
      const body = (await res.json().catch(() => ({}))) as { code?: unknown };
      if (body.code === 'PORTAL_ENTRA_NOT_CONFIGURED') return { availability: { available: false, reason: 'not_enabled' }, passwordFallback: null };
    }
    if (!res.ok) {
      console.warn(`[orgDomains] Entra tenant status failed to load: ${res.status}`);
      return unknown;
    }
    const body = (await res.json()) as { data?: unknown };
    if (!isPortalEntraTenantView(body.data)) {
      console.warn('[orgDomains] Entra tenant status returned an unexpected body');
      return unknown;
    }
    return { availability: entraAvailability(body.data), passwordFallback: passwordFallbackOf(body.data) };
  } catch (err) {
    console.warn('[orgDomains] Entra tenant status failed to load', err);
    return unknown;
  }
}

async function loadGoogle(orgId: string): Promise<Availability<GoogleUnavailableReason>> {
  try {
    const res = await fetchWithAuth(`/google/connection?orgId=${encodeURIComponent(orgId)}`);
    if (res.status === 404) {
      // A disabled GOOGLE_WORKSPACE_ENABLED darks the whole /google group with a 404
      // whose body says "...is not enabled" (no code) — the same test
      // GoogleWorkspaceIntegration uses. Any other 404 stays available.
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (/not enabled/i.test(String(body.error ?? ''))) return { available: false, reason: 'not_enabled' };
    }
    if (!res.ok) {
      console.warn(`[orgDomains] Google Workspace connection failed to load: ${res.status}`);
      return AVAILABLE;
    }
    const body = (await res.json()) as { connected?: unknown };
    // Only an explicit "not connected" disables the method.
    if (body.connected === false) return { available: false, reason: 'connection_missing' };
    if (body.connected !== true) console.warn('[orgDomains] Google Workspace connection returned an unexpected body');
    return AVAILABLE;
  } catch (err) {
    console.warn('[orgDomains] Google Workspace connection failed to load', err);
    return AVAILABLE;
  }
}

export interface DomainTabStatus {
  availability: DomainMethodAvailability;
  /** #11582: the org's portal fell back to password sign-in after losing its tenant proof. */
  passwordFallback: PortalPasswordFallbackNotice | null;
}

export async function loadDomainTabStatus(orgId: string): Promise<DomainTabStatus> {
  const [entra, google_directory] = await Promise.all([loadEntra(orgId), loadGoogle(orgId)]);
  return { availability: { entra_tenant: entra.availability, google_directory }, passwordFallback: entra.passwordFallback };
}
