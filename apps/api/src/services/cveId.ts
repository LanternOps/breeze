/**
 * CVE id validation shared by the vulnerability feed parsers (MSRC, NVD, SOFA)
 * and the sync jobs that upsert into the `vulnerabilities` catalog.
 *
 * Upstream feeds occasionally ship garbage — Microsoft's CBL-Mariner CVRF feed
 * published a record whose CVE id is the literal string
 * `CVE-2023-38039 mariner - do not use this one` (44 chars). The catalog column
 * `vulnerabilities.cve_id` is varchar(32), so an unvalidated insert fails with
 * `22001 value too long` and, because each sync runs in a single transaction,
 * aborts the whole run (#2261). Malformed ids are dropped at the parse boundary
 * instead: real CVE ids are short, and widening the column would just persist
 * garbage into the catalog and its unique index.
 */

import { captureMessage } from './sentry';

/** Canonical CVE id shape per the CVE Numbering Authority: CVE-YYYY-NNNN+. */
const CVE_ID_PATTERN = /^CVE-\d{4}-\d{4,}$/;

/** Matches `vulnerabilities.cve_id` varchar(32). */
export const MAX_CVE_ID_LENGTH = 32;

export function isValidCveId(value: string): boolean {
  return value.length <= MAX_CVE_ID_LENGTH && CVE_ID_PATTERN.test(value);
}

const MAX_WARNED_IDS = 10;
const MAX_WARNED_ID_LENGTH = 80;

/**
 * Emit a single per-run warning for the malformed CVE ids skipped by a feed
 * parse/sync, carrying the skipped count and a truncated sample of the
 * offending ids. No-op when nothing was skipped.
 */
export function warnMalformedCveIds(tag: string, skippedIds: ReadonlySet<string>): void {
  if (skippedIds.size === 0) return;

  const sample = Array.from(skippedIds)
    .slice(0, MAX_WARNED_IDS)
    .map((id) => JSON.stringify(id.length > MAX_WARNED_ID_LENGTH ? `${id.slice(0, MAX_WARNED_ID_LENGTH)}…` : id));
  const suffix = skippedIds.size > MAX_WARNED_IDS ? `, … +${skippedIds.size - MAX_WARNED_IDS} more` : '';
  console.warn(
    `[${tag}] Skipped ${skippedIds.size} distinct malformed CVE id(s): ${sample.join(', ')}${suffix}`
  );
}

/**
 * Skip-ratio escalation threshold (#2427): a handful of malformed ids is the
 * occasional-garbage case the skip path exists for, but a feed where more than
 * this fraction of entries is dropped is a probable upstream schema/quality
 * regression that deserves more than a stdout line.
 */
export const SKIP_RATIO_WARN_THRESHOLD = 0.01;

/**
 * Absolute skip floor: escalate on this many dropped entries REGARDLESS of
 * ratio. NVD ships ~250k CVEs, so a regression dropping 5,000 of them is only
 * a 2% ratio — but on a big enough feed even a sub-threshold ratio can hide
 * thousands of missing CVEs. Ratio alone is not a sufficient trigger.
 */
export const SKIP_ABSOLUTE_WARN_FLOOR = 100;

/**
 * Minimum entries before the RATIO trigger is trusted. On a 3-entry feed one
 * skip is 33% — statistically meaningless and pure alert noise. Below this,
 * only the absolute floor can escalate.
 */
export const MIN_ENTRIES_FOR_RATIO_WARN = 50;

/**
 * Escalate a sync run's malformed-CVE skips (#2427): console.error + a Sentry
 * warning event, so a feed regression that mangles a chunk of ids (but not all
 * of them — that's assertSomeValidCveIds' job) is visible without tailing
 * stdout.
 *
 * `skippedCount` MUST be a count of dropped ENTRIES, not of distinct malformed
 * ids: upstream garbage is typically one repeated literal (Microsoft's Mariner
 * record ships an identical bogus id on every affected entry), so a distinct-id
 * count would render a mass drop as `1` and never trip either trigger — the
 * precise blind spot this function exists to close.
 *
 * Fires when EITHER the skip ratio exceeds SKIP_RATIO_WARN_THRESHOLD (on a feed
 * large enough for a ratio to mean anything) OR the absolute count reaches
 * SKIP_ABSOLUTE_WARN_FLOOR. No-op when nothing was skipped.
 */
export function warnHighSkipRatio(tag: string, skippedCount: number, entryCount: number): void {
  if (skippedCount <= 0 || entryCount <= 0) return;

  const ratio = skippedCount / entryCount;
  const ratioTrips = entryCount >= MIN_ENTRIES_FOR_RATIO_WARN && ratio > SKIP_RATIO_WARN_THRESHOLD;
  const floorTrips = skippedCount >= SKIP_ABSOLUTE_WARN_FLOOR;
  if (!ratioTrips && !floorTrips) return;

  const message =
    `[${tag}] High malformed-CVE skip count: ${skippedCount} of ${entryCount} `
    + `CVE entries (${(ratio * 100).toFixed(1)}%) were skipped this sync — `
    + 'probable upstream feed quality regression';
  console.error(message);
  captureMessage(message, 'warning', {
    tag,
    skippedCount,
    entryCount,
    ratio,
    trigger: ratioTrips ? 'ratio' : 'absolute_floor',
  });
}

/**
 * Escalation guard for the total-drop case: a feed that contains vulnerability
 * entries but yields ZERO valid CVE ids is a probable upstream format change
 * (renamed id field, new id scheme), not the occasional-garbage case the skip
 * path exists for. Silently completing would mark the source healthy and
 * advance its cursor past data we never ingested, so throw instead — the sync
 * jobs' existing error paths mark the source `error` and leave the cursor
 * untouched for a retry after the parser is fixed. A feed with at least one
 * valid id never throws.
 */
export function assertSomeValidCveIds(params: {
  tag: string;
  entryCount: number;
  validCount: number;
  malformedIds: ReadonlySet<string>;
}): void {
  if (params.entryCount === 0 || params.validCount > 0) return;
  throw new Error(
    `[${params.tag}] Feed contains ${params.entryCount} vulnerability entries but zero valid CVE ids `
    + `(${params.malformedIds.size} malformed, ${params.entryCount - params.malformedIds.size} missing) — `
    + 'probable upstream feed format change; refusing to mark the sync successful'
  );
}
