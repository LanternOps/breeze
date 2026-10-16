import type { EdrCapabilities } from './types';

/** Leave 20% of the vendor budget for on-demand calls (test, manual sync, enrichment). */
const UTILIZATION = 0.8;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

function perMinuteCapacity(b: EdrCapabilities['requestBudget']): number {
  const caps: number[] = [];
  if (b.perSecond) caps.push(b.perSecond * 60);
  if (b.perMinute) caps.push(b.perMinute);
  if (b.perHour) caps.push(b.perHour / 60);
  if (b.perDay) caps.push(b.perDay / 1440);
  return caps.length ? Math.min(...caps) : Number.POSITIVE_INFINITY;
}

/**
 * Pick sync intervals that fit the vendor's request budget. Requested values
 * below the adapter default are raised to it (the default is the floor); if the
 * steady-state call rate would exceed the budget, the heavier stream's interval
 * is doubled until it fits. `lengthened` reports whether any interval ended up
 * above what was asked for / the default.
 *
 * The adapter's `incidents` per-minute operation budget is also respected.
 * Incidents are fetched once per run, connection-wide (not per tenant), so each
 * detection cycle costs one incidents call regardless of tenant count; the
 * detection interval is lengthened only if even that one call per cycle would
 * exceed the budget.
 */
export function planCadence(o: {
  tenants: number;
  mappedTenants: number;
  capabilities: EdrCapabilities;
  requested: { detectionsMinutes: number | null; inventoryMinutes: number | null };
  estimatedCalls: { perTenantDetection: number; perTenantInventory: number; perConnectionOverhead: number };
}): { detectionsMinutes: number; inventoryMinutes: number; lengthened: boolean } {
  const { capabilities: cap, estimatedCalls: est } = o;
  const floorDet = cap.defaultIntervals.detectionsMinutes;
  const floorInv = cap.defaultIntervals.inventoryMinutes;
  let det = Math.max(o.requested.detectionsMinutes ?? floorDet, floorDet);
  let inv = Math.max(o.requested.inventoryMinutes ?? floorInv, floorInv);
  const wantDet = det;
  const wantInv = inv;

  const detCalls = o.mappedTenants * est.perTenantDetection + est.perConnectionOverhead;
  const invCalls = o.tenants * est.perTenantInventory + est.perConnectionOverhead;
  const capacity = perMinuteCapacity(cap.requestBudget) * UTILIZATION;
  const incidents = cap.operationBudgets?.incidents;
  const incidentsPerMinute = incidents
    ? perMinuteCapacity(incidents) * UTILIZATION
    : Number.POSITIVE_INFINITY;

  const fits = (): boolean =>
    detCalls / det + invCalls / inv <= capacity && 1 / det <= incidentsPerMinute;

  while (!fits() && (det < MAX_INTERVAL_MINUTES || inv < MAX_INTERVAL_MINUTES)) {
    // Stretch whichever stream is currently the heavier consumer; detections
    // are the only stream bound by the incidents budget.
    const detLoad = detCalls / det;
    const invLoad = invCalls / inv;
    const overIncidents = 1 / det > incidentsPerMinute;
    if ((overIncidents || detLoad >= invLoad) && det < MAX_INTERVAL_MINUTES) det *= 2;
    else if (inv < MAX_INTERVAL_MINUTES) inv *= 2;
    else det *= 2;
  }

  return { detectionsMinutes: det, inventoryMinutes: inv, lengthened: det > wantDet || inv > wantInv };
}

export function isStreamDue(lastAt: Date | null, intervalMinutes: number, now: Date): boolean {
  if (!lastAt) return true;
  return now.getTime() - lastAt.getTime() >= intervalMinutes * 60_000;
}
