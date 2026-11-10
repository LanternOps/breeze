import { fetchWithAuth } from '../../../stores/auth';
import { isPortalEntraTenantView, type PortalEntraTenantView } from '../portalAccess/types';

/**
 * Whether the directory methods can run for an org (plan D7, OD2, D8). This is
 * a UX hint that saves a pointless check; the server's checker is the authority
 * and answers `fail` / `unavailable` on its own. So a status we could not load
 * leaves the method enabled rather than guessing it away.
 */
export type MethodUnavailableReason = 'tenant_not_proven' | 'connection_missing' | 'not_enabled';
export type MethodAvailability = { available: true } | { available: false; reason: MethodUnavailableReason };
export interface DomainMethodAvailability {
  entra_tenant: MethodAvailability;
  google_directory: MethodAvailability;
}

const AVAILABLE: MethodAvailability = { available: true };
export const UNKNOWN_AVAILABILITY: DomainMethodAvailability = { entra_tenant: AVAILABLE, google_directory: AVAILABLE };

/**
 * D7: the Entra checker reads `/organization` through the org's identity-first
 * M365 connection bound to the PROVEN tenant. A tenant proven by a proof run
 * with no such connection cannot use the method (OD2).
 */
export function entraAvailability(tenant: PortalEntraTenantView): MethodAvailability {
  if (tenant.state !== 'proven' || !tenant.tenantId) return { available: false, reason: 'tenant_not_proven' };
  if (!tenant.connectionTenantId || tenant.connectionTenantId.toLowerCase() !== tenant.tenantId.toLowerCase()) {
    return { available: false, reason: 'connection_missing' };
  }
  return AVAILABLE;
}

async function loadEntra(orgId: string): Promise<MethodAvailability> {
  try {
    const res = await fetchWithAuth(`/orgs/organizations/${orgId}/portal-entra-tenant`);
    if (res.status === 404) {
      // No portal Entra app on this deployment: no tenant can be proven here (W4).
      const body = (await res.json().catch(() => ({}))) as { code?: unknown };
      return body.code === 'PORTAL_ENTRA_NOT_CONFIGURED' ? { available: false, reason: 'not_enabled' } : AVAILABLE;
    }
    if (!res.ok) return AVAILABLE;
    const body = (await res.json()) as { data?: unknown };
    return isPortalEntraTenantView(body.data) ? entraAvailability(body.data) : AVAILABLE;
  } catch (err) {
    console.warn('[orgDomains] Entra tenant status failed to load', err);
    return AVAILABLE;
  }
}

async function loadGoogle(orgId: string): Promise<MethodAvailability> {
  try {
    const res = await fetchWithAuth(`/google/connection?orgId=${encodeURIComponent(orgId)}`);
    if (res.status === 404) {
      // A disabled GOOGLE_WORKSPACE_ENABLED darks the whole /google group with a 404.
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      return /not enabled/i.test(String(body.error ?? '')) ? { available: false, reason: 'not_enabled' } : AVAILABLE;
    }
    if (!res.ok) return AVAILABLE;
    const body = (await res.json()) as { connected?: unknown };
    return body.connected === true ? AVAILABLE : { available: false, reason: 'connection_missing' };
  } catch (err) {
    console.warn('[orgDomains] Google Workspace connection failed to load', err);
    return AVAILABLE;
  }
}

export async function loadDomainMethodAvailability(orgId: string): Promise<DomainMethodAvailability> {
  const [entra_tenant, google_directory] = await Promise.all([loadEntra(orgId), loadGoogle(orgId)]);
  return { entra_tenant, google_directory };
}
