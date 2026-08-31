import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Contract test (wave 7, #3779): FX is REPORTING-ONLY.
 *
 * The architectural invariant of the multi-currency program is that a
 * converted amount never enters document math and is never persisted onto a
 * document. A quote, invoice, contract, deposit, payment, PDF, accounting
 * payload or portal view carries the currency it was STAMPED with;
 * reinterpreting a stamped amount through a mutable exchange rate would
 * violate the snapshot rule (spec §2).
 *
 * A hand-maintained DENYLIST cannot enforce that: an earlier draft of this
 * guard enumerated ~18 "protected files", missed every live document/payment
 * writer (`quoteToContract.ts`, `stripeSettle.ts`, `quoteToPax8Order.ts`,
 * `quoteOrderService.ts`, `stripeWebhook.ts`, `contractRenewal.ts`,
 * `quotePay.ts`) and named `services/depositMath.ts`, which does not exist.
 *
 * So this guard is inverted: EVERY production file is denied, and only the
 * explicit allowlist below may reference FX. Adding a file to it is a REVIEW
 * DECISION, not a formality — reporting, admin and job surfaces only.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const SCAN_ROOTS = [
  'apps/api/src',
  'apps/web/src',
  'apps/portal/src',
  'packages/shared/src',
  'ee',
];

const FX_MODULES = [
  'exchangeRateService',
  'frankfurterClient',
  'reportingTotals',
  'exchangeRateSync',
  'lib/reporting/approximateTotal',
];

const FX_SYMBOLS = [
  'convertForReporting',
  'resolveReportingRate',
  'resolveReportingRates',
  'computeReportingTotal',
  'upsertFeedRates',
  'setManualRate',
  'exchange_rates',
  'exchangeRates', // the Drizzle table export
];

const FX_TOKENS = [...FX_MODULES, ...FX_SYMBOLS];

// Deny by default: any production file importing an FX module or naming an FX
// symbol must appear here, with the reason it is allowed to. Reporting, admin
// and job surfaces only — never a document, line, payment, PDF, accounting or
// portal path.
const FX_IMPORT_ALLOWLIST: Record<string, string> = {
  'apps/api/src/services/exchangeRateService.ts': 'the FX service itself',
  'apps/api/src/services/frankfurterClient.ts': 'the feed client itself',
  'apps/api/src/services/reportingTotals.ts': 'reporting-only conversion + totalling',
  'apps/api/src/jobs/exchangeRateSync.ts': 'the daily feed job',
  'apps/api/src/routes/admin/exchangeRates.ts': 'platform-admin manual-rate API',
  'apps/api/src/routes/admin/index.ts': 'mounts the platform-admin manual-rate API (no money math)',
  'apps/api/src/routes/invoices/settings.ts': 'the read-only reporting-totals endpoint',
  'apps/api/src/db/schema/currency.ts': 'the table definition',
  'apps/api/src/services/workerRegistry.ts':
    'worker init/shutdown wiring only (wave 3.5d-b, #4086 — moved here from index.ts, which no longer imports job modules directly)',
  'packages/shared/src/validators/currency.ts':
    'query-shape validator for the reporting-totals endpoint (no arithmetic)',
  'apps/web/src/lib/reporting/approximateTotal.ts':
    'reporting-only presentation helper (no arithmetic)',
  'apps/web/src/lib/useApproximateTotal.ts': 'reporting-only hook',
  'apps/web/src/components/billing/shared/ApproximateMoneyLine.tsx':
    'the approximate line component',
};

// Assertion 3: an allowlisted path whose name reads like a document surface is
// a red flag. Exactly two are deliberate; a third requires editing this map.
const DOCUMENT_SHAPED_PATH = /invoice|quote|contract|deposit|payment|stripe|accounting|pdf|portal|timeEntry/i;
const DELIBERATE_DOCUMENT_SHAPED_ALLOWLIST: Record<string, string> = {
  'apps/api/src/routes/invoices/settings.ts':
    'lives under routes/invoices/ for mounting only; it is a read-only reporting-totals endpoint that writes nothing to any document',
  'apps/api/src/routes/admin/exchangeRates.ts':
    'the platform-admin manual-rate API — matches on "rate"-adjacent naming, mutates only the global exchange_rates table',
};

const RATIONALE =
  'FX is reporting-only, is never persisted onto a document, and a converted figure ' +
  'entering document math would violate the central invariant (spec §2) by ' +
  'reinterpreting a stamped amount. If this file is genuinely a reporting, admin or ' +
  'job surface, add it to FX_IMPORT_ALLOWLIST with a reason — that is a review decision.';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', '.astro', 'coverage', '__tests__']);

function walk(absDir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.|\.spec\./.test(entry.name)) continue;
    out.push(abs);
  }
}

const scannedFiles: string[] = [];
for (const root of SCAN_ROOTS) {
  const abs = path.join(REPO_ROOT, root);
  if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs, scannedFiles);
}

interface FxHit {
  file: string;
  tokens: string[];
}

const hits: FxHit[] = [];
for (const abs of scannedFiles) {
  const source = readFileSync(abs, 'utf8');
  const tokens = FX_TOKENS.filter((token) => source.includes(token));
  if (tokens.length > 0) {
    hits.push({ file: path.relative(REPO_ROOT, abs).split(path.sep).join('/'), tokens });
  }
}

describe('FX document-boundary guard (deny-by-default)', () => {
  it('scanned a realistic number of production files (a broken glob cannot pass vacuously)', () => {
    expect(scannedFiles.length).toBeGreaterThan(500);
  });

  it('every file referencing an FX module or symbol is explicitly allowlisted', () => {
    const offenders = hits
      .filter((hit) => !(hit.file in FX_IMPORT_ALLOWLIST))
      .map((hit) => `  ${hit.file} — matched: ${hit.tokens.join(', ')}`);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `FX reference in non-allowlisted production file(s):\n${offenders.join('\n')}\n\n${RATIONALE}`,
    ).toEqual([]);
  });

  it('every allowlist entry resolves to an existing file (a stale entry guards nothing)', () => {
    const missing = Object.keys(FX_IMPORT_ALLOWLIST).filter(
      (rel) => !existsSync(path.join(REPO_ROOT, rel)),
    );
    expect(missing, `Stale FX allowlist entr(ies): ${missing.join(', ')}`).toEqual([]);
  });

  it('every allowlist entry has a non-empty reason', () => {
    const blank = Object.entries(FX_IMPORT_ALLOWLIST)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([rel]) => rel);
    expect(blank).toEqual([]);
  });

  it('no allowlisted path is a document surface except the deliberate ones', () => {
    const undeclared = Object.keys(FX_IMPORT_ALLOWLIST).filter(
      (rel) =>
        DOCUMENT_SHAPED_PATH.test(rel) && !(rel in DELIBERATE_DOCUMENT_SHAPED_ALLOWLIST),
    );
    expect(
      undeclared.sort(),
      'A document-shaped path was allowlisted for FX without being declared deliberate. ' +
        RATIONALE,
    ).toEqual([]);
  });

  it('every deliberate document-adjacent entry is itself allowlisted', () => {
    const orphans = Object.keys(DELIBERATE_DOCUMENT_SHAPED_ALLOWLIST).filter(
      (rel) => !(rel in FX_IMPORT_ALLOWLIST),
    );
    expect(orphans).toEqual([]);
  });

  it('the canonical formatting and money modules stay FX-free', () => {
    for (const rel of [
      'apps/web/src/components/billing/shared/format.ts',
      'packages/shared/src/utils/currency.ts',
    ]) {
      const abs = path.join(REPO_ROOT, rel);
      expect(existsSync(abs), `${rel} must exist for this guard to mean anything`).toBe(true);
      const source = readFileSync(abs, 'utf8');
      const found = FX_TOKENS.filter((token) => source.includes(token));
      expect(found, `${rel} must contain no FX identifier. ${RATIONALE}`).toEqual([]);
    }
  });
});
