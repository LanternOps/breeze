import { eq } from 'drizzle-orm';
import { isKnownCurrency, minorUnitExponent } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema';
import {
  DEFAULT_MAX_STALENESS_DAYS,
  ExchangeRateServiceError,
  assertIsoDate,
  convertForReportingBatch,
} from './exchangeRateService';

/**
 * Server-side reporting totals (multi-currency spec §8, wave 7 #3779).
 *
 * THE conversion happens HERE, never in the browser: `convertForReporting` is
 * the spec's reporting primitive, and keeping it server-side means there is
 * exactly one implementation of reporting money math and no converted value
 * sitting one import away from a document editor. FX is reporting-only — nothing
 * this module produces is ever persisted onto a billing document.
 *
 * Two invariants the UI depends on:
 *  - ONE unavailable leg suppresses the WHOLE total. Never a partial sum, never
 *    a placeholder, never a zero — the caller then renders its authoritative
 *    per-currency segmentation only.
 *  - The disclosed `rateDate` is the OLDEST contributing leg, so the label never
 *    claims more freshness than its weakest leg.
 *
 * Sums accumulate in `bigint` minor units parsed TEXTUALLY from the exact
 * fixed-scale strings the FX service returns. `toMinorUnits` is `Math.round(n *
 * 100)` on a double — fine for one line total, lossy for a portfolio near
 * Number.MAX_SAFE_INTEGER, which a rollup of many orgs reaches.
 */

export interface ReportingMoneyGroup { currencyCode: string; amount: string }

export interface ReportingConvertedGroup extends ReportingMoneyGroup {
  convertedAmount: string | null;
  rate: string | null;
  rateDate: string | null;
  source: 'identity' | 'ecb' | 'manual' | 'mixed' | null;
  reason?: 'missing' | 'stale';
}

export interface ReportingTotal {
  status: 'available' | 'unavailable' | 'not-needed';
  targetCurrencyCode: string;
  requestedDate: string;
  maxStalenessDays: number;
  /** OLDEST contributing leg date — never fresher than the weakest leg. */
  rateDate: string | null;
  /** Exact, or null. NEVER a partial sum. */
  total: string | null;
  groups: ReportingConvertedGroup[];
  unavailableCurrencyCodes: string[];
}

/** The whole supported list is the ceiling — a caller cannot segment further. */
const MAX_GROUPS = 34;
const AMOUNT_RE = /^(\d+)(?:\.(\d*))?$/;

function assertCurrency(value: string, label: string): string {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!isKnownCurrency(normalized)) {
    throw new ExchangeRateServiceError(400, 'INVALID_CURRENCY', `"${value}" is not a supported ${label} currency`);
  }
  return normalized;
}

/**
 * Exact decimal string → bigint minor units, TEXTUALLY. A residue beyond the
 * currency's minor unit means an unrounded value slipped in (the FX primitive
 * already rounds at the target minor unit), so it fails loudly rather than
 * silently truncating money.
 */
function toMinorBigInt(amount: string, exp: number, currencyCode: string): bigint {
  const m = AMOUNT_RE.exec(String(amount ?? '').trim());
  if (!m) {
    throw new ExchangeRateServiceError(400, 'INVALID_RATE', `Amount "${amount}" is not a non-negative decimal`);
  }
  const [, whole, frac = ''] = m;
  if (frac.replace(/0+$/, '').length > exp) {
    throw new ExchangeRateServiceError(
      400, 'INVALID_RATE',
      `Amount "${amount}" is not exact at the ${exp}-decimal minor unit of ${currencyCode}`,
    );
  }
  return BigInt(whole!) * 10n ** BigInt(exp) + BigInt((frac + '0'.repeat(exp)).slice(0, exp) || '0');
}

/** bigint minor units → the fixed-scale decimal string money crosses the wire as. */
function fromMinorBigInt(minor: bigint, exp: number): string {
  const digits = minor.toString();
  if (exp === 0) return `${digits}.00`;
  const padded = digits.padStart(exp + 1, '0');
  return `${padded.slice(0, -exp)}.${padded.slice(-exp)}`;
}

/**
 * `CODE:amount,CODE:amount` → groups. Owns the pair grammar, the supported-code
 * rule, the duplicate rule and the ceiling; the Zod schema only bounds the raw
 * string. Every failure is a 400 the route surfaces verbatim.
 */
export function parseGroupsParam(raw: string): ReportingMoneyGroup[] {
  const parts = String(raw ?? '').split(',');
  if (parts.length > MAX_GROUPS) {
    throw new ExchangeRateServiceError(400, 'INVALID_CURRENCY', `At most ${MAX_GROUPS} currency groups are accepted`);
  }
  const seen = new Set<string>();
  return parts.map((part) => {
    const pieces = part.split(':');
    if (pieces.length !== 2) {
      throw new ExchangeRateServiceError(400, 'INVALID_RATE', `"${part}" is not a CODE:amount pair`);
    }
    const [code, amount] = pieces as [string, string];
    const currencyCode = assertCurrency(code, 'group');
    if (!AMOUNT_RE.test(amount.trim()) || amount.trim() === '') {
      throw new ExchangeRateServiceError(400, 'INVALID_RATE', `"${amount}" is not a non-negative decimal amount`);
    }
    if (seen.has(currencyCode)) {
      throw new ExchangeRateServiceError(400, 'INVALID_CURRENCY', `Currency ${currencyCode} appears twice in groups`);
    }
    seen.add(currencyCode);
    return { currencyCode, amount: amount.trim() };
  });
}

/**
 * The reporting target for an actor, derived SERVER-side from the actor's
 * partner. Deriving it here is what lets an organization-scoped viewer keep the
 * approximate line: `/orgs/partners/me` is `requireScope('partner')`, so an
 * org-scoped token 403s there and would silently lose the line.
 *
 * Returns null — NEVER a USD substitute — when nothing usable is stored. The
 * caller turns that into an explicit 409.
 */
export async function resolvePartnerReportingCurrency(partnerId: string): Promise<string | null> {
  // SYSTEM context, deliberately. `partners` RLS is `breeze_has_partner_access(id)`,
  // which reads `breeze.accessible_partner_ids`, and `computeAccessiblePartnerIds`
  // returns `[]` for `scope === 'organization'` (middleware/auth.ts) — org users
  // do not see the partners table at all. Read in the ambient request context this
  // SELECT therefore returns ZERO rows for precisely the caller this fallback
  // exists to serve, so the endpoint answered 409 NO_REPORTING_CURRENCY for a
  // partner that has a currency configured, and the approximate line never
  // rendered for any organization-scoped viewer.
  //
  // The widening is as narrow as it can be: ONE row, ONE column, by primary key,
  // for the caller's OWN partner id taken from the verified token — never a
  // caller-supplied id, so it cannot be steered at another tenant. The value is
  // not tenant-sensitive to that partner's own orgs either: it is the reporting
  // currency their documents already display. `runOutsideDbContext` first, so the
  // system GUCs open a genuinely fresh context instead of nesting inside (and
  // outliving) the request transaction (#1105).
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(async () =>
    db
      .select({ currencyCode: partners.currencyCode })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1),
  ));
  const code = rows[0]?.currencyCode?.trim().toUpperCase();
  return code && isKnownCurrency(code) ? code : null;
}

/** Groups merged by currency, first-appearance order preserved, amounts summed
 *  exactly — so a duplicate currency can never be converted (or rounded) twice. */
function mergeByCurrency(groups: readonly ReportingMoneyGroup[]): ReportingMoneyGroup[] {
  const order: string[] = [];
  const totals = new Map<string, bigint>();
  for (const g of groups) {
    const currencyCode = assertCurrency(g.currencyCode, 'group');
    const exp = minorUnitExponent(currencyCode);
    const minor = toMinorBigInt(g.amount, exp, currencyCode);
    if (!totals.has(currencyCode)) order.push(currencyCode);
    totals.set(currencyCode, (totals.get(currencyCode) ?? 0n) + minor);
  }
  return order.map((currencyCode) => ({
    currencyCode,
    amount: fromMinorBigInt(totals.get(currencyCode)!, minorUnitExponent(currencyCode)),
  }));
}

export async function computeReportingTotal(
  groups: readonly ReportingMoneyGroup[],
  targetCurrencyCode: string,
  date: string,
): Promise<ReportingTotal> {
  const target = assertCurrency(targetCurrencyCode, 'target');
  const requestedDate = assertIsoDate(date);
  const merged = mergeByCurrency(groups);

  const base: ReportingTotal = {
    status: 'not-needed',
    targetCurrencyCode: target,
    requestedDate,
    maxStalenessDays: DEFAULT_MAX_STALENESS_DAYS,
    rateDate: null,
    total: null,
    groups: [],
    unavailableCurrencyCodes: [],
  };
  if (merged.length === 0) return base;

  // ONE conversion per DISTINCT currency — including the target itself, so even
  // the identity 1:1 comes from the FX service of record rather than being
  // synthesized here (the program has exactly one synthetic 1.00000000).
  //
  // ONE BATCH CALL, never a loop of single-pair conversions: the batch entry
  // point loads every leg (sources AND target) in a SINGLE statement, so the
  // whole total is derived from ONE database snapshot. Looping per group would
  // take a fresh READ COMMITTED snapshot per group and let a feed or
  // manual-rate commit landing mid-request produce a total whose legs never
  // coexisted — plus up to 2N round trips per dashboard request.
  const converted = await convertForReportingBatch(
    merged.map((g) => ({ amount: g.amount, from: g.currencyCode })), target, requestedDate,
  );

  const exp = minorUnitExponent(target);
  const out: ReportingConvertedGroup[] = [];
  const unavailableCurrencyCodes: string[] = [];
  const contributingDates: string[] = [];
  let totalMinor = 0n;

  merged.forEach((group, i) => {
    const result = converted[i]!;
    if (result.status === 'unavailable') {
      // The reason for THIS group is its own leg's when it has one; otherwise
      // the target leg failed and every group inherits that reason.
      const leg = result.unavailableLegs.find((l) => l.currencyCode === group.currencyCode)
        ?? result.unavailableLegs[0]!;
      unavailableCurrencyCodes.push(group.currencyCode);
      out.push({ ...group, convertedAmount: null, rate: null, rateDate: null, source: null, reason: leg.reason });
      return;
    }
    out.push({
      ...group,
      convertedAmount: result.convertedAmount,
      rate: result.rate,
      rateDate: result.rateDate,
      source: result.source,
    });
    if (result.source !== 'identity') contributingDates.push(result.rateDate);
    totalMinor += toMinorBigInt(result.convertedAmount, exp, target);
  });

  // ONE unavailable leg suppresses the WHOLE total — never a partial sum.
  if (unavailableCurrencyCodes.length > 0) {
    return { ...base, status: 'unavailable', groups: out, unavailableCurrencyCodes };
  }
  return {
    ...base,
    status: contributingDates.length === 0 ? 'not-needed' : 'available',
    rateDate: contributingDates.length === 0 ? null : contributingDates.slice().sort()[0]!,
    total: fromMinorBigInt(totalMinor, exp),
    groups: out,
  };
}
