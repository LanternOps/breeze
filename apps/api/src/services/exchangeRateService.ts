import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { isKnownCurrency, multiplyToCurrency } from '@breeze/shared';
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
/** numeric(18,8) => 18 - 8 = 10 digits available left of the decimal point. */
const RATE_WHOLE_DIGITS = 10;
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
  // numeric(18,8) leaves 10 digits left of the point. Without this cap a longer
  // integer part reaches Postgres as `numeric field overflow`, which is not an
  // ExchangeRateServiceError and so escapes the route's mapping as a 500.
  if (normalizedWhole.length > RATE_WHOLE_DIGITS) {
    throw new ExchangeRateServiceError(
      400,
      'INVALID_RATE',
      `Rate "${raw}" exceeds ${RATE_WHOLE_DIGITS} digits before the decimal point`,
    );
  }
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

// ---------------------------------------------------------------------------
// Resolution half — reporting-only conversion (multi-currency spec §8).
//
// EUR is the fixed pivot because the feed is explicitly ECB-backed: a
// conversion `from → to` is `from → EUR → to` off the stored `EUR→from` and
// `EUR→to` legs. `from === to` is the ONLY synthetic 1:1 in the program; a pair
// the feed does not cover is `unavailable`, never 1:1 and never a guess.
// ---------------------------------------------------------------------------

export interface ReportingRateLeg {
  currencyCode: string;
  kind: 'identity' | 'stored';
  rate: string;
  rateDate: string;
  source: 'identity' | ExchangeRateSource;
}

export interface ReportingUnavailableLeg {
  currencyCode: string;
  reason: 'missing' | 'stale';
  lastRateDate?: string;
}

export type ReportingRateResult =
  | {
      status: 'available';
      fromCode: string; toCode: string; requestedDate: string;
      rate: string; rateDate: string;
      source: 'identity' | 'ecb' | 'manual' | 'mixed';
      legs: ReportingRateLeg[];
    }
  | {
      status: 'unavailable';
      fromCode: string; toCode: string; requestedDate: string;
      unavailableLegs: ReportingUnavailableLeg[];
    };

export interface ReportingRateOptions { maxStalenessDays?: number }

const IDENTITY_RATE = '1.00000000';

/** Calendar-day distance in UTC — never a local-timezone or DST-sensitive diff. */
function utcDayDiff(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000);
}

type LegLookup = { rate: string; rateDate: string; source: ExchangeRateSource } | null;
type LegSnapshot = Map<string, LegLookup>;

/**
 * EVERY requested leg in ONE statement, so every cross rate is derived from a
 * SINGLE database snapshot. Two separate "latest leg" queries can straddle a
 * feed or manual commit and yield a hybrid cross rate that never existed at any
 * instant — the exact failure mode the manual-precedence work exists to
 * prevent, reappearing one layer up. `DISTINCT ON` keeps the "latest row on or
 * before" semantics and rides `exchange_rates_lookup_idx`.
 *
 * Reads run in the ambient context; the permissive SELECT policy makes that
 * safe from an org-scoped request.
 */
async function loadLatestLegs(
  quoteCodes: readonly string[], requestedDate: string,
): Promise<LegSnapshot> {
  const codes = [...new Set(quoteCodes)].filter((c) => c !== REPORTING_RATE_BASE_CODE);
  const out: LegSnapshot = new Map(codes.map((c) => [c, null]));
  if (codes.length === 0) return out;
  const rows = await db.execute<{ quote_code: string; rate: string; rate_date: string; source: ExchangeRateSource }>(sql`
    SELECT DISTINCT ON (quote_code)
      quote_code, rate::text AS rate, rate_date::text AS rate_date, source
    FROM exchange_rates
    WHERE base_code = ${REPORTING_RATE_BASE_CODE}
      AND quote_code IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})
      AND rate_date <= ${requestedDate}::date
    ORDER BY quote_code, rate_date DESC
  `);
  for (const r of rows) {
    out.set(r.quote_code.trim(), { rate: r.rate, rateDate: r.rate_date, source: r.source });
  }
  return out;
}

function classifyLeg(
  code: string, row: LegLookup, requestedDate: string, maxStalenessDays: number,
): { ok: true; leg: ReportingRateLeg } | { ok: false; leg: ReportingUnavailableLeg } {
  if (!row) return { ok: false, leg: { currencyCode: code, reason: 'missing' } };
  const age = utcDayDiff(row.rateDate, requestedDate);
  if (age > maxStalenessDays) {
    // Beyond the ceiling the number is not honest enough to show. The caller
    // renders segmented totals only — never a guessed conversion.
    return { ok: false, leg: { currencyCode: code, reason: 'stale', lastRateDate: row.rateDate } };
  }
  return { ok: true, leg: { currencyCode: code, kind: 'stored', rate: row.rate, rateDate: row.rateDate, source: row.source } };
}

/** toLeg / fromLeg in Postgres numeric — never a JavaScript double division.
 *  Touches NO table (both operands are literals already read under the single
 *  leg snapshot), so it cannot introduce snapshot skew. */
async function deriveCrossRate(fromRate: string, toRate: string): Promise<string> {
  const [row] = await db.execute<{ rate: string }>(
    sql`select round(${toRate}::numeric / ${fromRate}::numeric, ${RATE_SCALE}) as rate`,
  );
  return String(row!.rate);
}

/**
 * The pure half of `resolveReportingRate`: classification + cross-rate
 * derivation against a PRE-LOADED leg snapshot. Both entry points funnel
 * through it so single-pair and batch resolution cannot drift.
 */
async function resolveFromLegs(
  fromCode: string, toCode: string, requestedDate: string,
  lookups: LegSnapshot, options: ReportingRateOptions,
): Promise<ReportingRateResult> {
  const maxStalenessDays = options.maxStalenessDays ?? DEFAULT_MAX_STALENESS_DAYS;

  // The ONLY synthetic 1:1 in the whole program. A pair the feed does not cover
  // is unavailable, never 1:1 (spec §8).
  if (fromCode === toCode) {
    return {
      status: 'available', fromCode, toCode, requestedDate,
      rate: IDENTITY_RATE, rateDate: requestedDate, source: 'identity',
      legs: [{ currencyCode: fromCode, kind: 'identity', rate: IDENTITY_RATE, rateDate: requestedDate, source: 'identity' }],
    };
  }

  const legs: ReportingRateLeg[] = [];
  const unavailableLegs: ReportingUnavailableLeg[] = [];
  for (const code of [fromCode, toCode]) {
    if (code === REPORTING_RATE_BASE_CODE) {
      legs.push({ currencyCode: code, kind: 'identity', rate: IDENTITY_RATE, rateDate: requestedDate, source: 'identity' });
      continue;
    }
    const classified = classifyLeg(code, lookups.get(code) ?? null, requestedDate, maxStalenessDays);
    if (classified.ok) legs.push(classified.leg); else unavailableLegs.push(classified.leg);
  }
  // ONE unavailable leg suppresses the WHOLE result. Never a partial rate.
  if (unavailableLegs.length > 0) {
    return { status: 'unavailable', fromCode, toCode, requestedDate, unavailableLegs };
  }

  const fromLeg = legs.find((l) => l.currencyCode === fromCode)!;
  const toLeg = legs.find((l) => l.currencyCode === toCode)!;
  const rate = fromLeg.kind === 'identity'
    ? toLeg.rate
    : await deriveCrossRate(fromLeg.rate, toLeg.rate);

  const stored = legs.filter((l) => l.kind === 'stored');
  const sources = new Set(stored.map((l) => l.source));
  return {
    status: 'available', fromCode, toCode, requestedDate, rate,
    // The single disclosed date is the OLDEST contributing leg — conservative,
    // so the UI never claims a rate is fresher than its weakest leg.
    rateDate: stored.map((l) => l.rateDate).sort()[0] ?? requestedDate,
    source: sources.size === 1 ? ([...sources][0] as 'ecb' | 'manual') : 'mixed',
    legs,
  };
}

export async function resolveReportingRate(
  from: string, to: string, date: string, options: ReportingRateOptions = {},
): Promise<ReportingRateResult> {
  const fromCode = assertCurrency(from, 'from');
  const toCode = assertCurrency(to, 'to');
  const requestedDate = assertIsoDate(date);
  // ONE statement for both legs — see loadLatestLegs for why this must not be
  // two round trips. An identity pair reads nothing at all.
  const lookups: LegSnapshot = fromCode === toCode
    ? new Map()
    : await loadLatestLegs([fromCode, toCode], requestedDate);
  return resolveFromLegs(fromCode, toCode, requestedDate, lookups, options);
}

/**
 * Batched AND snapshot-consistent: ONE `loadLatestLegs` call covering every
 * distinct source currency PLUS the target, then pure classification per pair.
 * Never one statement per dashboard row, and never a second read of the target
 * leg — re-reading it per pair is how a batch ends up mixing two snapshots.
 */
export async function resolveReportingRates(
  fromCodes: readonly string[], to: string, date: string, options: ReportingRateOptions = {},
): Promise<ReportingRateResult[]> {
  const toCode = assertCurrency(to, 'to');
  const requestedDate = assertIsoDate(date);
  const unique = [...new Set(fromCodes.map((c) => assertCurrency(c, 'from')))];
  if (unique.length === 0) return [];
  const lookups = await loadLatestLegs([...unique, toCode], requestedDate);
  const results = await Promise.all(
    unique.map((code) => resolveFromLegs(code, toCode, requestedDate, lookups, options)),
  );
  const byCode = new Map(results.map((r) => [r.fromCode, r]));
  return fromCodes.map((code) => byCode.get(assertCurrency(code, 'from'))!);
}

export type ReportingConversionResult =
  | (Extract<ReportingRateResult, { status: 'available' }> & { amount: string; convertedAmount: string })
  | Extract<ReportingRateResult, { status: 'unavailable' }>;

/**
 * Reporting-only conversion. Consumed by dashboards and reports ONLY — the
 * result is display data, is labelled approximate with its rate date, is never
 * written to a money column, and never reaches document math. There is
 * deliberately NO assertRepresentable guard: this is not a persisted amount.
 */
export async function convertForReporting(
  amount: string | number, from: string, to: string, date: string, options: ReportingRateOptions = {},
): Promise<ReportingConversionResult> {
  const resolved = await resolveReportingRate(from, to, date, options);
  if (resolved.status === 'unavailable') return resolved;
  return {
    ...resolved,
    amount: String(amount),
    // Exact half-up at the TARGET currency's minor unit (JPY → whole yen).
    convertedAmount: multiplyToCurrency(amount, resolved.rate, resolved.toCode),
  };
}

/**
 * The BATCH reporting conversion — one leg snapshot for the whole set.
 *
 * A caller totalling several currencies (a dashboard row, a reporting total)
 * MUST use this rather than looping `convertForReporting`: each single-pair
 * call runs its OWN `loadLatestLegs`, and under READ COMMITTED every statement
 * takes a fresh snapshot, so a feed or manual-rate commit landing mid-request
 * yields a total whose legs came from two different database states — the
 * hybrid cross-rate failure `loadLatestLegs` exists to prevent, reappearing one
 * layer up. It is also N round trips per request against a pool with a
 * documented starvation history.
 *
 * Still reporting-only: display data, labelled approximate with its rate date,
 * never written to a money column and never part of document math.
 */
export async function convertForReportingBatch(
  items: readonly { amount: string | number; from: string }[],
  to: string, date: string, options: ReportingRateOptions = {},
): Promise<ReportingConversionResult[]> {
  if (items.length === 0) return [];
  const resolved = await resolveReportingRates(items.map((i) => i.from), to, date, options);
  return items.map((item, i) => {
    const r = resolved[i]!;
    if (r.status === 'unavailable') return r;
    return {
      ...r,
      amount: String(item.amount),
      convertedAmount: multiplyToCurrency(item.amount, r.rate, r.toCode),
    };
  });
}
