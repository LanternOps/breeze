import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * #9561: the labour rule lives in ONE place per language —
 * `laborHours`/`laborAmount` in packages/shared/src/utils/laborMath.ts and
 * `laborHoursSql`/`laborAmountSql` in apps/api/src/services/currencySql.ts.
 * Before #9561 it was copied into nine files; copies drift (the
 * billableMinutes sweep next door exists because one already did).
 *
 * Two checks:
 *  1. every former copy now routes through a helper (names the helper and no
 *     longer carries the inline formula);
 *  2. no NEW inline copy appears anywhere in the API, web or shared sources.
 */

const REPO = join(__dirname, '../../../..');

const HELPER_FILES = new Set([
  'packages/shared/src/utils/laborMath.ts',
  'apps/api/src/services/currencySql.ts',
]);

/** Former copies (issue #9561 comment) → the helper each must now call. */
const FORMER_COPIES: Record<string, RegExp> = {
  'apps/api/src/services/timeEntryService.ts': /\blaborAmount\(|\blaborAmountSql\(/,
  'apps/api/src/services/invoiceAssembly.ts': /\blaborHours\(/,
  'apps/api/src/services/ticketApproval/gate.ts': /\blaborAmount\(/,
  'apps/api/src/services/orgCurrencyService.ts': /\blaborAmountSql\(/,
  'apps/api/src/services/businessReports/technicianTimeReport.ts': /\blaborAmountSql\(/,
  'apps/api/src/services/contractHourBlocks.ts': /\blaborHundredths\(/,
  'apps/web/src/components/tickets/TicketTimeBilling.tsx': /\blaborHours\(/,
  'apps/web/src/components/time/TimesheetPage.tsx': /\blaborHours\(/,
};

/**
 * Inline shapes of the rule: `(minutes / 60).toFixed(2)`,
 * `Math.round(minutes * 100 / 60)`, and SQL `ROUND(minutes … / 60[.0], 2)`.
 */
const INLINE_FORMULA = [
  /\/\s*60\s*\)\s*\.toFixed\(\s*2\s*\)/,
  /\*\s*100\s*\)?\s*\/\s*60\b/,
  /\/\s*60(?:\.0)?\s*,\s*2\s*\)/i,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}

const rel = (file: string) => relative(REPO, file).split('\\').join('/');
const inlineHits = (source: string) =>
  source.split('\n').flatMap((line, i) => (INLINE_FORMULA.some((re) => re.test(line)) ? [i + 1] : []));
/** Catches a copy split across lines (`ROUND(\n  m / 60,\n  2)`), which the per-line scan misses. */
const hasMultiLineCopy = (source: string) => {
  const collapsed = source.replace(/\s+/g, ' ');
  return INLINE_FORMULA.some((re) => re.test(collapsed));
};

/**
 * The money paths inside a file that has several: each named block (from its
 * anchor to the next top-level declaration) must itself call the helper, so a
 * revert of one reader cannot hide behind another reader's call in the same file.
 */
const BLOCKS: Array<{ file: string; anchor: string; helper: RegExp }> = [
  { file: 'apps/api/src/services/timeEntryService.ts', anchor: 'export async function getTimesheet(', helper: /\blaborAmount\(/ },
  { file: 'apps/api/src/services/timeEntryService.ts', anchor: 'export async function getTicketBillingSummary(', helper: /\blaborAmountSql\(/ },
  { file: 'apps/api/src/services/timeEntryService.ts', anchor: 'export async function listBillables(', helper: /\blaborAmount\(/ },
  { file: 'apps/api/src/services/orgCurrencyService.ts', anchor: 'function laborSumSql(', helper: /\blaborAmountSql\(/ },
  { file: 'apps/api/src/services/businessReports/technicianTimeReport.ts', anchor: 'const MONEY = ', helper: /\blaborAmountSql\(/ },
  { file: 'apps/api/src/services/ticketApproval/gate.ts', anchor: 'export function entryAmountMinor(', helper: /\blaborAmount\(/ },
  { file: 'apps/api/src/services/invoiceAssembly.ts', anchor: 'const entryHours = ', helper: /\blaborHours\(/ },
];

function block(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) return '';
  const rest = source.slice(start + anchor.length);
  const next = rest.search(/\n(?:export |async |function |const |let |interface |type )/);
  return anchor + (next < 0 ? rest : rest.slice(0, next));
}

describe('labour rule has one implementation (#9561)', () => {
  it.each(Object.entries(FORMER_COPIES))('%s routes through the shared helper', (file, helperCall) => {
    const source = readFileSync(join(REPO, file), 'utf8');
    expect(helperCall.test(source), `${file} must call the labour helper (${helperCall})`).toBe(true);
    expect(inlineHits(source), `${file} still carries an inline copy of the labour formula`).toEqual([]);
    expect(hasMultiLineCopy(source), `${file} carries a multi-line inline copy of the labour formula`).toBe(false);
  });

  it.each(BLOCKS)('$anchor ($file) itself calls the helper', ({ file, anchor, helper }) => {
    const body = block(readFileSync(join(REPO, file), 'utf8'), anchor);
    expect(body, `anchor "${anchor}" not found in ${file} — update this test if it was renamed`).not.toBe('');
    expect(helper.test(body), `${anchor} in ${file} must call ${helper}`).toBe(true);
  });

  it('no inline copy of the formula exists outside the helpers', () => {
    const offenders: string[] = [];
    // apps/mobile is deliberately absent: CI gates it on its own filter and a
    // mobile-only change never runs test-api (ci-area-gating.test.mjs), so a
    // read of it here would be a cross-area reference with no rule behind it.
    const roots = ['apps/api/src', 'apps/web/src', 'apps/portal/src', 'packages/shared/src', 'ee'];
    for (const root of roots) {
      for (const file of walk(join(REPO, root))) {
        const path = rel(file);
        if (HELPER_FILES.has(path)) continue;
        const source = readFileSync(file, 'utf8');
        for (const line of inlineHits(source)) offenders.push(`${path}:${line}`);
        if (offenders.every((o) => !o.startsWith(`${path}:`)) && hasMultiLineCopy(source)) offenders.push(`${path} (multi-line)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
