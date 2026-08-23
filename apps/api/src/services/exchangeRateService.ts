import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { isKnownCurrency } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { exchangeRates } from '../db/schema';

/**
 * Reporting-only FX rates (multi-currency spec §8).
 *
 * DEPENDENCY RULE (mirrors orgCurrencyCore.ts:1-18): this module imports ONLY
 * `../db`, the schema and `@breeze/shared` — never a domain service. It is
 * consumed by dashboards and reports; every caller maps ExchangeRateServiceError
 * at its own boundary. FX NEVER touches document math and is never persisted
 * onto a document.
 */
export const REPORTING_RATE_BASE_CODE = 'EUR';
export const DEFAULT_MAX_STALENESS_DAYS = 7;
const RATE_SCALE = 8;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

export type ExchangeRateSource = 'ecb' | 'manual';
export type ExchangeRateServiceErrorCode =
  | 'INVALID_RATE' | 'INVALID_DATE' | 'INVALID_CURRENCY' | 'UNSUPPORTED_BASE';

export class ExchangeRateServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ExchangeRateServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExchangeRateServiceError';
  }
}

export interface ExchangeRateKey { rateDate: string; baseCode: string; quoteCode: string; }
export interface FeedRateInput extends ExchangeRateKey { rate: string; fetchedAt: Date; }
export interface ManualRateInput extends ExchangeRateKey { rate: string; }
export interface ExchangeRateRecord extends ExchangeRateKey { rate: string; source: ExchangeRateSource; fetchedAt: Date; }
export interface FeedUpsertResult { submitted: number; stored: number; manualProtected: number; }

export function assertIsoDate(value: string): string {
  if (!ISO_DATE_RE.test(String(value ?? ''))) {
    throw new ExchangeRateServiceError(400, 'INVALID_DATE', `"${value}" is not an ISO calendar date (YYYY-MM-DD)`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const asUtc = new Date(Date.UTC(y!, m! - 1, d!));
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() + 1 !== m || asUtc.getUTCDate() !== d) {
    throw new ExchangeRateServiceError(400, 'INVALID_DATE', `"${value}" is not a real calendar date`);
  }
  return value;
}

function assertCurrency(code: string, label: string): string {
  const normalized = String(code ?? '').trim().toUpperCase();
  if (!isKnownCurrency(normalized)) {
    throw new ExchangeRateServiceError(400, 'INVALID_CURRENCY', `${label} "${code}" is not a supported currency`);
  }
  return normalized;
}

/** Fixed-scale decimal string, normalized TEXTUALLY — a rate never round-trips
 *  through a binary double on its way into numeric(18,8). */
function assertRate(raw: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(String(raw ?? '').trim());
  if (!m) throw new ExchangeRateServiceError(400, 'INVALID_RATE', `Rate "${raw}" is not a positive decimal`);
  const [, whole, frac = ''] = m;
  if (frac.length > RATE_SCALE) {
    throw new ExchangeRateServiceError(400, 'INVALID_RATE', `Rate "${raw}" exceeds ${RATE_SCALE} decimal places`);
  }
  if (/^0+$/.test(whole!) && /^0*$/.test(frac)) {
    throw new ExchangeRateServiceError(400, 'INVALID_RATE', 'Rate must be greater than zero');
  }
  const normalizedWhole = whole!.replace(/^0+(?=\d)/, '');
  return `${normalizedWhole}.${frac.padEnd(RATE_SCALE, '0')}`;
}

function normalizeKey(key: ExchangeRateKey): ExchangeRateKey {
  const baseCode = assertCurrency(key.baseCode, 'base');
  const quoteCode = assertCurrency(key.quoteCode, 'quote');
  if (baseCode !== REPORTING_RATE_BASE_CODE) {
    // The table is structurally generic, but wave 7 stores exactly one pivot:
    // ECB publishes against EUR, so a second pivot would silently create
    // incomparable cross rates.
    throw new ExchangeRateServiceError(400, 'UNSUPPORTED_BASE', `Only ${REPORTING_RATE_BASE_CODE}-based rates are stored`);
  }
  if (baseCode === quoteCode) {
    throw new ExchangeRateServiceError(400, 'INVALID_CURRENCY', 'base and quote currency must differ');
  }
  return { rateDate: assertIsoDate(key.rateDate), baseCode, quoteCode };
}

/**
 * Store feed rows. THE manual-precedence invariant lives in the conflict
 * predicate: `WHERE exchange_rates.source <> 'manual'`. Whichever transaction
 * commits first, the final state of a contested cell is the manual rate —
 * feed-then-manual overwrites, manual-then-feed updates zero rows.
 *
 * Keys are sorted before the write so two concurrent feed batches take the
 * conflicting row locks in the same order and cannot deadlock.
 */
export async function upsertFeedRates(rates: readonly FeedRateInput[]): Promise<FeedUpsertResult> {
  const byKey = new Map<string, FeedRateInput>();
  for (const raw of rates) {
    const key = normalizeKey(raw);
    byKey.set(`${key.rateDate}|${key.baseCode}|${key.quoteCode}`, { ...key, rate: assertRate(raw.rate), fetchedAt: raw.fetchedAt });
  }
  const values = [...byKey.values()].sort((a, b) =>
    a.rateDate.localeCompare(b.rateDate) || a.baseCode.localeCompare(b.baseCode) || a.quoteCode.localeCompare(b.quoteCode),
  );
  if (values.length === 0) return { submitted: 0, stored: 0, manualProtected: 0 };

  const stored = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .insert(exchangeRates)
        .values(values.map((v) => ({ ...v, source: 'ecb' as const })))
        .onConflictDoUpdate({
          target: [exchangeRates.rateDate, exchangeRates.baseCode, exchangeRates.quoteCode],
          set: { rate: sql`excluded.rate`, source: sql`'ecb'`, fetchedAt: sql`excluded.fetched_at` },
          setWhere: sql`${exchangeRates.source} <> 'manual'`,
        })
        .returning({ quoteCode: exchangeRates.quoteCode }),
    ),
  );

  return { submitted: values.length, stored: stored.length, manualProtected: values.length - stored.length };
}

/** Operator override. Always writes source='manual'; a caller cannot choose the
 *  provenance. This is the self-host / air-gapped path. */
export async function setManualRate(input: ManualRateInput): Promise<ExchangeRateRecord> {
  const key = normalizeKey(input);
  const rate = assertRate(input.rate);
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .insert(exchangeRates)
        .values({ ...key, rate, source: 'manual' })
        .onConflictDoUpdate({
          target: [exchangeRates.rateDate, exchangeRates.baseCode, exchangeRates.quoteCode],
          set: { rate: sql`excluded.rate`, source: sql`'manual'`, fetchedAt: sql`now()` },
        })
        .returning(),
    ),
  );
  return row as ExchangeRateRecord;
}

/** Deletes ONLY a manual cell. Deleting does not resurrect a previously
 *  replaced ECB row: the lookup falls back to an earlier eligible row, and an
 *  online deployment repopulates the cell on the next feed run. */
export async function deleteManualRate(key: ExchangeRateKey): Promise<boolean> {
  const k = normalizeKey(key);
  const deleted = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .delete(exchangeRates)
        .where(and(
          eq(exchangeRates.rateDate, k.rateDate),
          eq(exchangeRates.baseCode, k.baseCode),
          eq(exchangeRates.quoteCode, k.quoteCode),
          eq(exchangeRates.source, 'manual'),
        ))
        .returning({ rateDate: exchangeRates.rateDate }),
    ),
  );
  return deleted.length > 0;
}

/** Read path runs in the AMBIENT context — the permissive `USING (true)` SELECT
 *  policy is exactly what makes an org-scoped request able to read rates. */
export async function listExchangeRates(input: {
  baseCode?: string; quoteCode?: string; source?: ExchangeRateSource; onOrBefore?: string; limit?: number;
} = {}): Promise<ExchangeRateRecord[]> {
  const conds = [];
  if (input.baseCode) conds.push(eq(exchangeRates.baseCode, assertCurrency(input.baseCode, 'base')));
  if (input.quoteCode) conds.push(eq(exchangeRates.quoteCode, assertCurrency(input.quoteCode, 'quote')));
  if (input.source) conds.push(eq(exchangeRates.source, input.source));
  if (input.onOrBefore) conds.push(lte(exchangeRates.rateDate, assertIsoDate(input.onOrBefore)));
  const rows = await db
    .select()
    .from(exchangeRates)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(exchangeRates.rateDate), exchangeRates.baseCode, exchangeRates.quoteCode)
    .limit(Math.min(input.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
  return rows as ExchangeRateRecord[];
}
