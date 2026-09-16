import type {
  ComplianceState,
  ComplianceTrendPoint,
  EndpointFreshness,
} from '../types/endpointManagementReport';

/**
 * Arithmetic shared by the Endpoint Management Review report's three consumers
 * (#5784 W03): the API generator, the shared PDF renderer and the web preview.
 * Kept here so the three cannot disagree about what "unmeasured" looks like.
 *
 * The governing rule: **unmeasured is never zero.** An empty population and a
 * population of zero non-compliant devices are different facts, and a PDF that
 * prints "0" for the first is a lie the reader cannot detect.
 */

const KNOWN_STATES: Readonly<Record<string, ComplianceState>> = {
  compliant: 'compliant',
  noncompliant: 'noncompliant',
  inGracePeriod: 'inGracePeriod',
  unknown: 'unknown',
};

/** Source outcomes that mean "this domain did not measure the tenant". */
const GAP_OUTCOMES: Readonly<Record<string, string>> = {
  needs_consent: 'consent has not been granted',
  throttled: 'Microsoft Graph throttled the sync',
  unlicensed: 'the tenant is not licensed for this data',
  error: 'the last sync failed',
};

/**
 * Bucket an Intune population by compliance state.
 *
 * Returns `null` — NOT an all-zero record — for an empty population, because a
 * caller that has not measured anything must render "N/A", not "0 compliant".
 * Anything Intune reports that is not one of the four modelled states (Intune
 * also emits `configManager`, `conflict`, `error`, `notAssigned`) buckets as
 * `unknown`; it must never fall into `compliant` by default.
 */
export function complianceBreakdown(
  rows: ReadonlyArray<{ complianceState?: string | null }>,
): Record<ComplianceState, number> | null {
  if (rows.length === 0) return null;
  const out: Record<ComplianceState, number> = {
    compliant: 0,
    noncompliant: 0,
    inGracePeriod: 0,
    unknown: 0,
  };
  for (const row of rows) {
    const raw = typeof row?.complianceState === 'string' ? row.complianceState : '';
    out[KNOWN_STATES[raw] ?? 'unknown'] += 1;
  }
  return out;
}

/**
 * Change in the compliant count across the rollup series (last minus first).
 *
 * `null` when the series is shorter than two points OR when either endpoint is
 * unmeasured — coercing a null endpoint to 0 would manufacture a dramatic
 * swing out of a sync gap.
 */
export function trendDelta(series: readonly ComplianceTrendPoint[]): number | null {
  if (series.length < 2) return null;
  const first = series[0]?.compliant;
  const last = series[series.length - 1]?.compliant;
  if (typeof first !== 'number' || typeof last !== 'number') return null;
  return last - first;
}

/**
 * One human sentence naming every freshness gap for a domain, or `''` when
 * there is nothing to say.
 *
 * Staleness is judged against the domain's SYNC CADENCE, not against the
 * reporting period: `intune_devices` syncs on a 6 h adaptive cadence, so a
 * 29-day-old inventory is stale even though it sits comfortably inside a
 * monthly report's window. A grace multiple is applied so a single skipped run
 * does not cry wolf.
 */
export function freshnessLine(
  freshness: EndpointFreshness,
  cadenceHours: number,
  now: Date = new Date(),
): string {
  const parts: string[] = [];

  for (const [source, outcome] of Object.entries(freshness.sources ?? {})) {
    const reason = GAP_OUTCOMES[outcome];
    if (reason) parts.push(`${source}: ${reason}`);
  }

  if (!freshness.asOf) {
    parts.unshift('this domain has never completed a full snapshot');
  } else {
    const ageHours = (now.getTime() - new Date(freshness.asOf).getTime()) / 3600_000;
    if (Number.isFinite(ageHours) && ageHours > cadenceHours * STALE_CADENCE_MULTIPLE) {
      parts.unshift(
        `the inventory is stale — last complete snapshot ${describeAge(ageHours)} old, against a ${cadenceHours}h sync cadence`,
      );
    }
  }

  if (freshness.truncated) {
    parts.push('the last enumeration was truncated, so the population may be incomplete');
  }
  if (freshness.lastStatus === 'partial') {
    parts.push('the last run was partial and did not enumerate the whole tenant');
  }

  return parts.length === 0 ? '' : `${capitalise(parts.join('; '))}.`;
}

/** How many cadences may elapse before a snapshot counts as stale. Two skipped
 *  runs is a gap worth printing; one is ordinary jitter. */
export const STALE_CADENCE_MULTIPLE = 3;

/** True when `asOf` is older than the domain's cadence allows. The same
 *  threshold `freshnessLine` uses, exported so callers set `stale` consistently. */
export function isStaleSnapshot(
  asOf: string | null | undefined,
  cadenceHours: number,
  now: Date = new Date(),
): boolean {
  if (!asOf) return true;
  const ageHours = (now.getTime() - new Date(asOf).getTime()) / 3600_000;
  if (!Number.isFinite(ageHours)) return true;
  return ageHours > cadenceHours * STALE_CADENCE_MULTIPLE;
}

function describeAge(hours: number): string {
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

function capitalise(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
