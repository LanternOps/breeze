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
    `[${tag}] Skipped ${skippedIds.size} record(s) with malformed CVE id(s): ${sample.join(', ')}${suffix}`
  );
}
