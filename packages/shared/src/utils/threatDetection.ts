/**
 * Arithmetic and prose shared by the Threat Detection Review report's three
 * consumers (#5784 W02): the API generator (`apps/api/src/services/
 * threatDetectionReport.ts`), the shared PDF renderer and the web preview. It
 * lives here rather than in any one of them so the three cannot disagree about
 * what "mean resolution time" or "the covered window" means.
 *
 * The rule the whole module exists to enforce: UNMEASURED IS NOT ZERO. Every
 * function returns `null` — never `0` — when there was nothing to measure, and
 * `coverageGapLine` never produces a sentence that reads as "there were no
 * incidents" for a source that was simply not observed.
 */
import type { ThreatCoverage } from '../types/threatDetectionReport';

/** Severity buckets, most severe first. Anything Huntress sends that is not in
 *  this list is kept verbatim and sorted after the known ones. */
export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

/** The bucket a null/absent value falls into. Named rather than dropped: a
 *  severity Huntress did not supply is a fact about the data, not a zero. */
export const UNKNOWN_BUCKET = 'unknown';

type ResolvableRow = { reportedAt: string | null; resolvedAt: string | null };

export type ResolutionStats = {
  meanResolveHours: number | null;
  medianResolveHours: number | null;
};

function hoursBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  // Clamped at zero: a resolved_at before reported_at is clock skew at the
  // source, not a negative duration, and a negative would drag the mean below
  // what any single incident actually took.
  return Math.max(0, (end - start) / 3_600_000);
}

/**
 * Mean and median hours to resolution over the RESOLVED rows only. An
 * unresolved incident is excluded rather than counted as instant — counting it
 * as zero would make a month where nothing was closed look like the fastest
 * month on record. Zero resolved rows yields `null`, never `0`.
 */
export function resolutionStats(rows: readonly ResolvableRow[]): ResolutionStats {
  const durations: number[] = [];
  for (const row of rows ?? []) {
    if (!row?.reportedAt || !row?.resolvedAt) continue;
    const hours = hoursBetween(row.reportedAt, row.resolvedAt);
    if (hours !== null) durations.push(hours);
  }
  if (durations.length === 0) return { meanResolveHours: null, medianResolveHours: null };

  const mean = durations.reduce((sum, h) => sum + h, 0) / durations.length;
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  const median = sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] as number) + upper) / 2;
  return { meanResolveHours: round2(mean), medianResolveHours: round2(median) };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Counts rows by a string-valued key, bucketing null/empty under `unknown`.
 * The returned object's key order is severity order first (so a PDF or a table
 * reading `Object.keys` prints critical before low), then anything unrecognised
 * alphabetically, then `unknown` last.
 */
export function countBy<T extends Record<string, unknown>>(
  rows: readonly T[],
  key: keyof T & string,
): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows ?? []) {
    const raw = row?.[key];
    const bucket = typeof raw === 'string' && raw.trim() !== '' ? raw : UNKNOWN_BUCKET;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const rank = (bucket: string) => {
    if (bucket === UNKNOWN_BUCKET) return SEVERITY_ORDER.length + 1;
    const index = (SEVERITY_ORDER as readonly string[]).indexOf(bucket);
    return index === -1 ? SEVERITY_ORDER.length : index;
  };
  const ordered: Record<string, number> = {};
  for (const bucket of [...counts.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    ordered[bucket] = counts.get(bucket) as number;
  }
  return ordered;
}

/** ISO instants and ISO dates are both comparable as `YYYY-MM-DD` prefixes. */
function datePart(value: string): string {
  return value.slice(0, 10);
}

/**
 * One sentence naming every way the artifact falls short of "we observed the
 * whole period", or `''` when it does not fall short at all. The renderer
 * prints the result verbatim on the cover.
 *
 * Returns `''` ONLY when the source is `ok`, the covered window spans the
 * period, and nothing was withheld or excluded. Every other case says what is
 * missing — and never phrases an unobserved source as an absence of incidents.
 */
export function coverageGapLine(coverage: ThreatCoverage | null | undefined): string {
  if (!coverage) return 'Coverage for this period could not be determined.';
  const parts: string[] = [];

  switch (coverage.sourceStatus) {
    case 'not_connected':
      parts.push(
        'Huntress is not connected for this partner, so threat detection was not measured for this period',
      );
      break;
    case 'never_synced':
      parts.push(
        'Huntress is connected but has never completed a sync, so threat detection was not measured for this period',
      );
      break;
    case 'stale':
      parts.push(
        `Huntress last synced ${coverage.lastSyncAt ? datePart(coverage.lastSyncAt) : 'an unknown time ago'}, so anything after that is not reflected here`,
      );
      break;
    default:
      break;
  }

  if (coverage.sourceStatus === 'ok' || coverage.sourceStatus === 'stale') {
    if (coverage.periodStart && coverage.coveredFrom
      && datePart(coverage.coveredFrom) > datePart(coverage.periodStart)) {
      parts.push(
        `the data held starts at ${datePart(coverage.coveredFrom)} and so does not cover ${datePart(coverage.periodStart)} to ${datePart(coverage.coveredFrom)}`,
      );
    }
    if (coverage.periodEnd && coverage.coveredTo
      && datePart(coverage.coveredTo) < datePart(coverage.periodEnd)) {
      parts.push(
        `the data held ends at ${datePart(coverage.coveredTo)} and so does not cover ${datePart(coverage.coveredTo)} to ${datePart(coverage.periodEnd)}`,
      );
    }
  }

  if (coverage.unattributableExcluded && coverage.unattributableExcluded > 0) {
    parts.push(
      `${coverage.unattributableExcluded} incident(s) could not be attributed to a device in your sites and are excluded`,
    );
  }
  if (coverage.withheld && coverage.withheld > 0) {
    parts.push(`${coverage.withheld} further incident(s) are withheld from the table below`);
  }

  if (parts.length === 0) return '';
  return `${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}.`;
}
