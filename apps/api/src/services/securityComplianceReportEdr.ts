import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { edrEndpoints } from '../db/schema';

/**
 * EDR provider framework (#8164) as posture-report evidence.
 *
 * Label: the posture report is a customer deliverable (scheduled delivery and
 * the customer portal both render it), and the portal never names the EDR
 * vendor, so the product is the generic "Managed endpoint protection" — never
 * `edrProviderLabel()`.
 */
export const EDR_PRODUCT_LABEL = 'Managed endpoint protection';

/**
 * Device ids (within the report's already site-narrowed population) that an
 * EDR connector reports as HEALTHY. Unhealthy / degraded / unknown endpoints do
 * not count as protection, mirroring how only an active product is evidence.
 *
 * Reads the org-axis `edr_endpoints` only; the partner-axis connection tables
 * are invisible to an org-scoped context and are not consulted. Endpoints with
 * no linked Breeze device (`breeze_device_id` NULL) have no device to attribute
 * and never match `inArray`.
 */
export async function loadEdrDeviceCoverage(
  orgId: string,
  deviceIds: string[],
): Promise<Set<string>> {
  if (deviceIds.length === 0) return new Set();

  const rows = await db
    .select({ deviceId: edrEndpoints.breezeDeviceId })
    .from(edrEndpoints)
    .where(and(
      eq(edrEndpoints.orgId, orgId),
      eq(edrEndpoints.health, 'healthy'),
      inArray(edrEndpoints.breezeDeviceId, deviceIds),
    ));

  return new Set(rows.map((r) => r.deviceId).filter((id): id is string => typeof id === 'string'));
}
