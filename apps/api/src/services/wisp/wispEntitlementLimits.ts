import type { WispLimits } from '@breeze/shared';
import { getEntitlements } from '../entitlements';

/**
 * The one seam between Wisp grants and Partner Entitlements (Wisp W01,
 * `services/entitlements.ts`).
 *
 * `enabled: false` covers a plan default of disabled, a disabled row, and an
 * expired row past grace. `limits` null means "no cap" in grants.ts (w00 A21).
 * Today an enabled wisp entitlement always carries limits: the resolver falls
 * back to the entry tier's defaults when the plan has none (a manual grant on
 * `free` gets pro's), so null is reachable only if the registry drops them.
 *
 * One `getEntitlements` read gives state and limits together, so they cannot
 * come from two different cache generations (`hasEntitlement` followed by
 * `getEntitlementLimits` could straddle a reload).
 *
 * Throws `EntitlementResolutionError` once the resolver cache is past its
 * stale ceiling; the caller fails closed on it.
 */
export type WispEntitlement = { enabled: false } | { enabled: true; limits: WispLimits | null };

export async function loadWispEntitlement(partnerId: string): Promise<WispEntitlement> {
  const { wisp } = (await getEntitlements(partnerId)).entitlements;
  if (wisp.state !== 'enabled') return { enabled: false };
  // Stored limits are schema-checked on read by the resolver (storedLimitsOrDefault).
  return { enabled: true, limits: wisp.limits as WispLimits | null };
}
