import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract: there is exactly ONE spreadsheet-formula escaper anywhere in the
 * repo, and no CSV-adjacent server module hand-rolls a delimiter join around it.
 *
 * There were previously three copies of the neutraliser (two near-identical, one
 * that omitted neutralisation entirely) plus one writer
 * (`patchComplianceReportWorker.formatComplianceCsv`) that bypassed all of them
 * with a template literal. Code review does not reliably catch a new local
 * escaper or a new `.join(',')`; a grep contract does.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Roots scanned for a duplicate escaper — every app and package that could
 * plausibly emit a spreadsheet.
 */
const ESCAPER_SCAN_ROOTS = [
  'apps/api/src',
  'apps/web/src',
  'apps/portal/src',
  'packages/shared/src',
  'ee',
];

/**
 * Roots scanned for raw row joins. Narrower than the escaper scan on purpose:
 * the front ends build query strings, `mailto:` lists and navigation targets
 * with `join(',')` constantly, so a file-level regex there is mostly noise. The
 * duplicate-escaper check above is what covers the front ends — a web export
 * cannot emit an unescaped cell without either importing the canonical helper
 * or defining its own escaper, and the latter fails that check.
 */
const ROW_JOIN_SCAN_ROOTS = ['apps/api/src', 'packages/shared/src'];

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

/**
 * A local re-implementation of the escaper. Matches the canonical module's
 * prefix set, a redefinition of the neutraliser, or the RFC-4180 quote-doubling
 * idiom used by a hand-rolled cell escaper.
 */
const LOCAL_ESCAPER =
  /FORMULA_PREFIXES|function\s+neutralizeSpreadsheetFormula|replace\(\/"\/g,\s*['"`]""['"`]\)/;

/**
 * Files matching {@link LOCAL_ESCAPER} that are not spreadsheet escapers. SQL
 * identifier quoting doubles embedded quotes exactly like RFC 4180 does, so the
 * idiom alone cannot distinguish them — each entry needs a reason.
 */
const NON_CSV_ESCAPER_ALLOWLIST: Record<string, string> = {
  'apps/api/src/db/ensureAppRole.ts': 'quotes a SQL identifier, not a spreadsheet cell',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '__snapshots__') continue;
      if (entry === '__tests__') continue;
      walk(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function load(roots: string[]) {
  return roots
    .flatMap((root) => walk(path.join(REPO_ROOT, root)))
    .map((full) => ({ rel: path.relative(REPO_ROOT, full), text: readFileSync(full, 'utf8') }));
}

const escaperSources = load(ESCAPER_SCAN_ROOTS);
const rowJoinSources = load(ROW_JOIN_SCAN_ROOTS);

describe('CSV export escaper contract', () => {
  it('scans a non-empty set of sources', () => {
    // Guards the whole suite against a silently broken path.
    expect(escaperSources.length).toBeGreaterThan(1000);
    expect(rowJoinSources.length).toBeGreaterThan(500);
    expect(escaperSources.some((f) => f.rel === CANONICAL_ESCAPER)).toBe(true);
  });

  it('has exactly one implementation of the cell escaper', () => {
    const implementers = escaperSources
      .filter((f) => LOCAL_ESCAPER.test(f.text))
      .filter((f) => !(f.rel in NON_CSV_ESCAPER_ALLOWLIST))
      .map((f) => f.rel);
    expect(implementers).toEqual([CANONICAL_ESCAPER]);
  });

  it('never assembles a spreadsheet row with a raw delimiter join', () => {
    const offenders = rowJoinSources
      .filter((f) => /csv|tsv/i.test(f.text))
      .filter((f) => f.rel !== CANONICAL_ESCAPER)
      .filter((f) => !(f.rel in NON_CSV_JOIN_ALLOWLIST))
      .filter((f) => ROW_JOIN.test(f.text))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  it('keeps both allowlists honest — every entry still exists and still matches', () => {
    for (const rel of Object.keys(NON_CSV_JOIN_ALLOWLIST)) {
      const file = rowJoinSources.find((f) => f.rel === rel);
      expect(file, `${rel} is allowlisted but no longer exists`).toBeDefined();
      expect(ROW_JOIN.test(file!.text), `${rel} no longer needs an allowlist entry`).toBe(true);
    }
    for (const rel of Object.keys(NON_CSV_ESCAPER_ALLOWLIST)) {
      const file = escaperSources.find((f) => f.rel === rel);
      expect(file, `${rel} is allowlisted but no longer exists`).toBeDefined();
      expect(LOCAL_ESCAPER.test(file!.text), `${rel} no longer needs an allowlist entry`).toBe(true);
    }
  });
});
