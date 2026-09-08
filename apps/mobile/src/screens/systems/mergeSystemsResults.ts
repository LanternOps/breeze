import type { Alert, ApiError, Device, FleetFindingCounts } from '../../services/api';
import type { MobileSummary, OrganizationSummary } from '../../services/systems';

/**
 * The six independent fetches behind the Systems screen, in the order
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
  /**
   * Open fleet-hygiene finding counts (#5139 / #5117 decision 1), folded into
   * the same issue count active alerts drive. `null` until the first
   * successful fetch — every consumer treats that the same as "0 findings"
   * (alerts-only), never a crash, matching the degrade-gracefully contract.
   */
  findings: FleetFindingCounts | null;
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
 * Slices that are allowed to disappear entirely on an older server. #5172:
 * `GET /fleet/findings/counts` (#5143) doesn't exist on prod v0.110.0, so a
 * self-hoster a release behind sees the findings fetch 404 forever — that is
 * "feature not on this server", not a transient failure, and must not trip
 * the partial-failure banner or block pull-to-refresh from ever clearing it.
 * Every other slice (devices, orgs, alerts, summary) is load-bearing for the
 * screen and keeps today's behavior even on a 404.
 */
const OPTIONAL_SLICES: ReadonlySet<keyof SystemsSlices> = new Set(['findings']);

/**
 * True when `key` is an optional slice (see `OPTIONAL_SLICES`) that rejected
 * with a 404 — "route missing on this server", to be degraded silently
 * rather than counted as a failure. Any other status code (5xx), a network
 * error (no `statusCode` at all), or a non-optional slice still counts as a
 * real failure.
 *
 * Duck-types the rejection reason via `Partial<ApiError>` rather than
 * `instanceof ApiError` — this module (and its test) must not force a
 * runtime import of `services/api.ts`, which pulls in `expo-secure-store` /
 * `@sentry/react-native` and cannot load under the node vitest runtime (see
 * `lib/errorReporting.ts` for the same pattern).
 */
export function isUnsupportedSlice(
  key: keyof SystemsSlices,
  result: PromiseSettledResult<unknown>
): boolean {
  if (!OPTIONAL_SLICES.has(key) || result.status !== 'rejected') return false;
  const reason = result.reason;
  const statusCode =
    reason && typeof reason === 'object' ? (reason as Partial<ApiError>).statusCode : undefined;
  return statusCode === 404;
}

/**
 * Merge the settled results of the six Systems fetches over the previously
 * rendered data.
 *
 * The screen used to issue these through `Promise.all` (back when there were
 * five), so a single rejection discarded ALL of them — a transient failure
 * on, say, the summary call blanked a fleet of devices that had loaded
 * perfectly well, and the user saw an
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
    findings: PromiseSettledResult<FleetFindingCounts | null>;
  }
): MergeOutcome {
  const failed: Array<keyof SystemsSlices> = [];
  for (const key of ['summary', 'alerts', 'activeAlerts', 'devices', 'orgs', 'findings'] as const) {
    if (results[key].status === 'rejected' && !isUnsupportedSlice(key, results[key])) failed.push(key);
  }

  const slices: SystemsSlices = {
    summary: take(results.summary, previous.summary),
    alerts: take(results.alerts, previous.alerts),
    activeAlerts: take(results.activeAlerts, previous.activeAlerts),
    devices: take(results.devices, previous.devices),
    orgs: take(results.orgs, previous.orgs),
    // A 404 degrades to null (fulfilled-with-null), not the stale previous
    // value — this is "the server has never had this feature", so there is
    // no last-known value worth preserving.
    findings: isUnsupportedSlice('findings', results.findings)
      ? null
      : take(results.findings, previous.findings),
  };

  const total = 6;
  let error: string | null = null;
  if (failed.length === total) {
    error = ALL_FAILED_MESSAGE;
  } else if (failed.length > 0) {
    error = PARTIAL_FAILED_MESSAGE;
  }

  return { slices, error, failed };
}

/**
 * The rejection reasons worth reporting to Sentry. Empty when nothing failed.
 *
 * Mirrors `mergeSystemsResults`' own `failed` classification exactly (via
 * `isUnsupportedSlice`) rather than every raw rejection: a 404 on `findings`
 * is expected and permanent on a server a release behind, not a bug — same
 * precedent as `DEVICE_BLOCKED_CODE` in `lib/errorReporting.ts` for another
 * expected, recurring condition. Reporting it anyway would spam Sentry on
 * every fetch for the lifetime of that server (#5172).
 */
export function rejectionReasons(results: {
  [K in keyof SystemsSlices]: PromiseSettledResult<unknown>;
}): unknown[] {
  return (['summary', 'alerts', 'activeAlerts', 'devices', 'orgs', 'findings'] as const)
    .filter((k) => results[k].status === 'rejected' && !isUnsupportedSlice(k, results[k]))
    .map((k) => (results[k] as PromiseRejectedResult).reason);
}

/**
 * Distinct from 'Unknown organization' on purpose: that one means the org is
 * genuinely absent from a list we successfully loaded, this one means we never
 * loaded the list.
 */
export const ORG_NAME_UNAVAILABLE = 'Organization unavailable';
export const ORG_NAME_UNKNOWN = 'Unknown organization';

/**
 * Resolve an org id to a display name, distinguishing "not in the list" from
 * "there is no list".
 *
 * Both used to collapse to 'Unknown organization', so a failed `orgs` slice
 * produced rows that looked exactly like real data about a genuinely unlisted
 * org. The caller renders under a partial-failure banner in that case, and a
 * confidently-labelled row directly contradicts it.
 */
export function resolveOrgName(
  orgs: ReadonlyArray<{ id: string; name: string }>,
  id: string,
  orgsFailed: boolean
): { name: string; unavailable: boolean } {
  const resolved = orgs.find((o) => o.id === id)?.name;
  if (resolved) return { name: resolved, unavailable: false };
  return orgsFailed
    ? { name: ORG_NAME_UNAVAILABLE, unavailable: true }
    : { name: ORG_NAME_UNKNOWN, unavailable: false };
}
