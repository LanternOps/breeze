import type { FleetSegments } from './FleetBar';

/**
 * Neutral, already-aggregated input to the bar mapping. Deliberately plain
 * numbers rather than `Alert[]` / `MobileSummary`: the two call sites reach
 * the same fleet state through different endpoints (the Systems hero has the
 * unacked alert rows, the Home strip only has `/mobile/summary` aggregates),
 * and the mapping must not care which.
 */
export interface FleetSegmentInput {
  /** Non-decommissioned device total the bar is proportioned against. */
  total: number;
  offline: number;
  maintenance: number;
  /** Unacknowledged alerts at critical/high severity — the red slice. */
  criticalAlerts: number;
  /** Unacknowledged alerts at medium/low severity — folded into amber. */
  warningAlerts: number;
}

/**
 * The single fleet-bar severity mapping (#5364). Home and Systems used to
 * carry their own copies and disagreed on what a device being offline means:
 * the Home strip painted offline devices red (`critical`) while the Systems
 * hero painted the very same devices amber (`warning`). Offline is degraded
 * fleet state, not an emergency, so amber is the answer both surfaces now
 * give — and they give it by calling this function rather than by two
 * expressions that happen to agree today.
 *
 * Red is reserved for critical/high *alerts*. Slices are clamped so they can
 * never sum past `total` (a fleet can easily carry more alerts than devices),
 * with critical taking precedence over warning for the space available.
 */
export function deriveFleetBarSegments({
  total,
  offline,
  maintenance,
  criticalAlerts,
  warningAlerts,
}: FleetSegmentInput): FleetSegments {
  // Offline + maintenance devices contribute to warning even without alerts,
  // since they're degraded fleet state.
  const degradedDevices = Math.max(0, offline + maintenance);

  const criticalSlice = Math.min(criticalAlerts, total);
  const warningSlice = Math.min(warningAlerts + degradedDevices, total - criticalSlice);
  const healthySlice = Math.max(0, total - criticalSlice - warningSlice);

  return { healthy: healthySlice, warning: warningSlice, critical: criticalSlice };
}
