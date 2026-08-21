import type { Alert, Device } from '../../services/api';
import type { MobileSummary, OrganizationSummary } from '../../services/systems';

/**
 * The five independent fetches behind the Systems screen, in the order
 * `fetchAll` issues them.
 */
export interface SystemsSlices {
  summary: MobileSummary | null;
  /**
   * The unfiltered inbox page. Drives RECENT (24h), which deliberately shows
   * acknowledged and resolved alerts as lifecycle context — `RecentRow` dims
   * acknowledged rows rather than hiding them.
   */
  alerts: Alert[];
  /**
   * Active-only page. Drives ACTIVE ISSUES and the org issue counts, which the
   * unfiltered page cannot serve: it is ordered by recency, so on a large fleet
   * resolved low-severity rows fill it and nothing actionable survives.
   */
  activeAlerts: Alert[];
  devices: Device[];
  orgs: OrganizationSummary[];
}

export interface MergeOutcome {
  slices: SystemsSlices;
  /** null when everything succeeded. */
  error: string | null;
  /** Slice names that rejected, for error reporting. */
  failed: Array<keyof SystemsSlices>;
}

export const ALL_FAILED_MESSAGE = 'Failed to load systems data.';
export const PARTIAL_FAILED_MESSAGE = 'Some data could not be refreshed.';

function take<T>(result: PromiseSettledResult<T>, previous: T): T {
  return result.status === 'fulfilled' ? result.value : previous;
}

/**
 * Merge the settled results of the five Systems fetches over the previously
 * rendered data.
 *
 * The screen used to issue these through `Promise.all`, so a single rejection
 * discarded ALL FIVE results — a transient failure on, say, the summary call
 * blanked a fleet of devices that had loaded perfectly well, and the user saw an
 * empty screen with a generic error. Each slice now stands on its own: whatever
 * arrived is rendered, whatever failed keeps its last-known value, and the error
 * line distinguishes "nothing loaded" from "some of this is stale".
 */
export function mergeSystemsResults(
  previous: SystemsSlices,
  results: {
    summary: PromiseSettledResult<MobileSummary | null>;
    alerts: PromiseSettledResult<Alert[]>;
    activeAlerts: PromiseSettledResult<Alert[]>;
    devices: PromiseSettledResult<Device[]>;
    orgs: PromiseSettledResult<OrganizationSummary[]>;
  }
): MergeOutcome {
  const failed: Array<keyof SystemsSlices> = [];
  for (const key of ['summary', 'alerts', 'activeAlerts', 'devices', 'orgs'] as const) {
    if (results[key].status === 'rejected') failed.push(key);
  }

  const slices: SystemsSlices = {
    summary: take(results.summary, previous.summary),
    alerts: take(results.alerts, previous.alerts),
    activeAlerts: take(results.activeAlerts, previous.activeAlerts),
    devices: take(results.devices, previous.devices),
    orgs: take(results.orgs, previous.orgs),
  };

  const total = 5;
  let error: string | null = null;
  if (failed.length === total) {
    error = ALL_FAILED_MESSAGE;
  } else if (failed.length > 0) {
    error = PARTIAL_FAILED_MESSAGE;
  }

  return { slices, error, failed };
}

/** The rejection reasons, for Sentry. Empty when nothing failed. */
export function rejectionReasons(results: {
  [K in keyof SystemsSlices]: PromiseSettledResult<unknown>;
}): unknown[] {
  return (['summary', 'alerts', 'activeAlerts', 'devices', 'orgs'] as const)
    .map((k) => results[k])
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason);
}
