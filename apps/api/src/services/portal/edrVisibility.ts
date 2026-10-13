import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, portalBranding } from '../../db/schema';

/**
 * Strict, fail-closed read of portal_branding.enable_edr_visibility. A missing
 * settings row, or anything other than an explicit true, is off. Runs inside
 * the caller's org-scoped DB context (RLS by org_id on portal_branding).
 */
export async function isEdrVisibilityEnabled(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: portalBranding.enableEdrVisibility })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);
  return row?.enabled === true;
}

// EDR provider framework W02 (#8166). Only a healthy AND online linked endpoint
// counts as protected; unhealthy/degraded/unknown/offline rows never upgrade a
// device. edr_endpoints is org-axis (RLS by org_id) and the predicate repeats
// the org filter explicitly, like the s1/huntress subqueries. Shared by every
// portal read model that classifies device protection, so they agree.
export const edrEndpointProtectedSql = (orgId: string) => sql<boolean>`exists (
  select 1 from edr_endpoints e
  where e.org_id = ${orgId}
    and e.breeze_device_id = ${devices.id}
    and e.health = 'healthy'
    and e.online is true
)`;

// Any linked endpoint, whatever its health: drives only the generic label.
export const edrEndpointLinkedSql = (orgId: string) => sql<boolean>`exists (
  select 1 from edr_endpoints e
  where e.org_id = ${orgId}
    and e.breeze_device_id = ${devices.id}
)`;

/**
 * Whether a report run may use EDR-framework evidence (#8166). A run by a
 * PORTAL user (customer self-service) honours the org's strict
 * enableEdrVisibility flag, so a customer never sees EDR influence the MSP has
 * not opted into; MSP-side runs (user / system authorities) always may.
 */
export async function edrReportEvidenceAllowed(
  orgId: string,
  authority: { principalKind?: string },
): Promise<boolean> {
  if (authority.principalKind !== 'portal_user') return true;
  return isEdrVisibilityEnabled(orgId);
}
