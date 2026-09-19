import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract: there is exactly ONE spreadsheet-formula escaper, and no CSV-adjacent
 * module hand-rolls a delimiter join around it.
 *
 * There were previously two near-identical copies of the neutraliser plus one
 * writer (`patchComplianceReportWorker.formatComplianceCsv`) that bypassed both
 * with a template literal. Code review does not reliably catch a new
 * `.join(',')`; a grep contract does.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCAN_ROOTS = ['apps/api/src', 'packages/shared/src'];

/** The one file allowed to implement neutralisation and to join raw delimiters. */
const CANONICAL_ESCAPER = 'packages/shared/src/utils/csvExport.ts';

/**
 * Files that match the CSV-adjacent scan but whose `join(',')` is unrelated to
 * spreadsheet output. Each entry needs a reason — if you are adding a CSV
 * writer here instead, you want `csvRow`/`tsvRow`, not an allowlist entry.
 */
const NON_CSV_JOIN_ALLOWLIST: Record<string, string> = {
  'apps/api/src/services/googleClient.ts': 'OAuth scope list sent to Google, not a spreadsheet row',
  'apps/api/src/services/ticketSla.ts': 'comma-separated tag column stored in the DB, not an export',
};

// Exactly `join(',')` / `join('\t')` — a CSV/TSV row assembly. `join(', ')`
// (comma-space) is a prose list and is deliberately not matched.
const ROW_JOIN = /\.join\((?:','|","|'\\t'|"\\t")\)/;
const NEUTRALISER = /FORMULA_PREFIXES|neutralizeSpreadsheetFormula\s*\(\s*value\s*:/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__snapshots__' || entry === '__tests__') continue;
      walk(full, out);
      continue;
    }
    if (!/\.ts$/.test(entry) || /\.test\.ts$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const sources = SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root))).map((full) => ({
  rel: path.relative(REPO_ROOT, full),
  text: readFileSync(full, 'utf8'),
}));

describe('CSV export escaper contract', () => {
  it('scans a non-empty set of sources', () => {
    // Guards the whole suite against a silently broken path/glob.
    expect(sources.length).toBeGreaterThan(500);
    expect(sources.some((f) => f.rel === CANONICAL_ESCAPER)).toBe(true);
  });

  it('has exactly one implementation of the formula neutraliser', () => {
    const implementers = sources.filter((f) => NEUTRALISER.test(f.text)).map((f) => f.rel);
    expect(implementers).toEqual([CANONICAL_ESCAPER]);
  });

  it('never assembles a spreadsheet row with a raw delimiter join', () => {
    const offenders = sources
      .filter((f) => /csv|tsv/i.test(f.text))
      .filter((f) => f.rel !== CANONICAL_ESCAPER)
      .filter((f) => !(f.rel in NON_CSV_JOIN_ALLOWLIST))
      .filter((f) => ROW_JOIN.test(f.text))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist honest — every entry still exists and still matches', () => {
    for (const rel of Object.keys(NON_CSV_JOIN_ALLOWLIST)) {
      const file = sources.find((f) => f.rel === rel);
      expect(file, `${rel} is allowlisted but no longer exists`).toBeDefined();
      expect(ROW_JOIN.test(file!.text), `${rel} no longer needs an allowlist entry`).toBe(true);
    }
  });
});
