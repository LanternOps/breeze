import type {
  ComplianceState,
  ComplianceTrendPoint,
  EndpointFreshness,
  EndpointManagementSummary,
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
 * `measured` is an EXPLICIT argument, not inferred from `rows.length`, and that
 * is the whole point. "The domain was never enumerated" and "the domain was
 * enumerated and no devices are in scope" are different facts that happen to
 * share an empty array: the first must render "N/A", the second is a truthful
 * zero. Deriving it from the array conflated them and made the artifact claim
 * "not measured" about a domain that had synced perfectly.
 *
 * Returns `null` when unmeasured — NEVER an all-zero record. Anything Intune
 * reports that is not one of the four modelled states (it also emits
 * `configManager`, `conflict`, `error`, `notAssigned`) buckets as `unknown`; it
 * must never fall into `compliant` by default.
 */
export function complianceBreakdown(
  rows: ReadonlyArray<{ complianceState?: string | null }>,
  measured: boolean,
): Record<ComplianceState, number> | null {
  if (!measured) return null;
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

/**
 * Stated on EVERY Endpoint Management Review artifact. Lives here, not in the
 * API generator, because two producers must emit it: the generator itself and
 * `zeroSafeReport`'s restricted-empty short-circuit, which returns before the
 * generator is ever called.
 */
export const ENDPOINT_MANAGEMENT_HISTORY_CAVEAT =
  'This report shows the current Intune inventory plus the daily compliance trend from '
  + 'Microsoft 365 posture rollups. Device-level change history — which specific devices '
  + 'fell in or out of compliance during the period — is not available: Intune records are '
  + 'overwritten in place on each sync and devices absent for 30 days are removed.';

/**
 * The empty-but-SHAPED summary. Every field is present and every count is
 * `null`, so the PDF renderer's arm is entered and prints "N/A" plus the stated
 * reason — rather than the summary being absent, which drops the whole designed
 * artifact into `renderGenericReport`'s one-line "No data available for the
 * selected filters". That line reads as "nothing to report / all clear" to a
 * technician whose real situation is "your access scope contains no sites".
 */
export function emptyEndpointManagementSummary(args: {
  orgId: string;
  generatedAt: string;
  period?: { start?: string; end?: string };
  thresholdDays: number;
  dataGap: string;
}): EndpointManagementSummary {
  return {
    orgId: args.orgId,
    orgName: null,
    generatedAt: args.generatedAt,
    period: args.period,
    freshness: {},
    enrolment: {
      intuneDevices: null,
      breezeDevices: null,
      breezeWithoutIntune: null,
      intuneWithoutBreezeLink: null,
    },
    compliance: { byState: null, trend: [] },
    staleEnrolments: { count: null, thresholdDays: args.thresholdDays },
    rows: [],
    dataGaps: [args.dataGap],
    historyCaveat: ENDPOINT_MANAGEMENT_HISTORY_CAVEAT,
  };
}

/** The one sentence a restricted authority with no permitted sites is owed. */
export const ENDPOINT_MANAGEMENT_NO_SITES_GAP =
  'No sites are in scope for this report, so nothing was measured. This is an '
  + 'access-scope limit, not a finding about the devices.';
