/**
 * Reporting-only presentation helpers (multi-currency spec §8).
 *
 * NOT document code. Conversion and summation happen server-side in
 * `apps/api/src/services/reportingTotals.ts` via `convertForReporting`; this
 * module builds the query parameter and decides whether to render the line.
 * It performs NO arithmetic, so there is no second implementation of money
 * math in the browser and no converted figure a document editor can reuse.
 *
 * Display rules that are not negotiable:
 * - a book already entirely in the target currency shows no approximate line;
 * - ANY missing, stale or incomplete leg suppresses the whole FIGURE (the
 *   server returns status 'unavailable' and total null — a partial
 *   approximation is a dishonest number), but the line then SAYS SO and names
 *   the currencies it could not convert. Suppressing the figure is not the same
 *   as rendering nothing: rendering nothing is how #4415 (and the three
 *   hide-on-failure bugs before it) left self-hosters with no rate feed staring
 *   at a line that never appeared and no way to find out why;
 * - the disclosed rate date is whatever the server reports as the OLDEST
 *   contributing leg;
 * - the authoritative per-currency segmentation above this line always stays
 *   visible, in every state.
 */

import { roundToCurrency } from '@breeze/shared';

/** One converted group exactly as the API returns it. Amounts are exact
 *  decimal STRINGS computed server-side; this module never multiplies. */
export interface ReportingConvertedGroup {
  currencyCode: string;
  amount: string;
  convertedAmount: string | null;
  rate: string | null;
  rateDate: string | null;
  source: 'identity' | 'ecb' | 'manual' | 'mixed' | null;
  reason?: 'missing' | 'stale';
}

export interface ReportingTotalResponse {
  status: 'available' | 'unavailable' | 'not-needed';
  targetCurrencyCode: string;
  requestedDate: string;
  maxStalenessDays: number;
  rateDate: string | null;
  total: string | null;
  /** Read-only view: the web never mutates or accumulates the server's book. */
  groups: readonly ReportingConvertedGroup[];
  unavailableCurrencyCodes: readonly string[];
}

/** Why the server could not produce a total. `mixed` covers both "the failing
 *  legs disagree" and "the server named codes but no reason" — either way the
 *  copy has to stay non-committal rather than assert a cause we do not have. */
export type ApproxUnavailableReason = 'missing' | 'stale' | 'mixed';

/**
 * The view the line renders. Deliberately EXHAUSTIVE over everything the
 * endpoint can answer, with exactly one silent member (`hidden`) reserved for
 * the two states that genuinely have nothing to say: no request was made, and
 * `not-needed` (the book is already entirely in the reporting currency).
 *
 * Every failure is a NAMED member carrying its detail. That is the whole point
 * of #4415: `unavailable` used to fall into `hidden`, so four releases shipped
 * a line that silently never rendered for partners with no rate coverage. A
 * future contributor cannot re-hide a failure without deleting a union member
 * and reddening the switch in `ApproximateMoneyLine`.
 */
export type ApproxTotalView =
  | { status: 'hidden' }
  | {
    status: 'unavailable';
    currencyCodes: readonly string[];
    /** The currency the conversion was TO. Named in the copy on purpose: the
     *  server flags the source group that could not convert, which is not
     *  necessarily the leg whose rate is missing — when the target leg fails,
     *  every group inherits that reason (`reportingTotals.ts`). "no CAD rate
     *  for NGN" describes the PAIR and is true either way; "NGN's rate is
     *  missing" would assert a cause we have not established. */
    targetCurrencyCode: string;
    reason: ApproxUnavailableReason;
  }
  | { status: 'available'; amount: string; currencyCode: string; rateDate: string };

const PLAIN_NON_NEGATIVE_DECIMAL = /^(\d+)(?:\.(\d*))?$/;

/** What a book is worth asking about. `empty` and `invalid` were ONE return
 *  value ('') until #4415, which is why an unusable leg — a negative balance, a
 *  currency the client cannot round — made the whole line vanish with no
 *  request and no trace, indistinguishable from having nothing to ask. They are
 *  separate members now so the caller can stay silent for one and speak for the
 *  other. */
export type ApproxGroupsQuery =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'query'; value: string };

/** `USD:12300.00,EUR:4100.00` — sorted, deduplicated, every amount quantized to
 *  the currency's minor unit. `invalid` when any single leg is unusable
 *  (negative, non-finite, unroundable): the caller then makes no request and
 *  reports that it could not build one. Skipping the bad leg instead would ask
 *  the server to approximate a book it was not given, and the answer would come
 *  back `available` — a partial approximate total, which the spec forbids
 *  (§8: one unavailable leg suppresses the WHOLE figure).
 *
 *  Quantization is mandatory, not cosmetic: the callers' per-currency sums come
 *  from `sumByCurrency`, which accumulates in JS `number`, so a rollup of a
 *  dozen 2-decimal amounts routinely lands on 24714.529999999995. The server's
 *  `toMinorBigInt` rejects any residue past the minor unit (400 INVALID_RATE),
 *  which would silently hide the line on roughly half of real books. Rounding
 *  half-up at the minor unit through the shared money primitive is the only
 *  arithmetic this module does, and it is done on the REQUEST, never on a
 *  converted figure. */
export function buildGroupsParam(
  byCurrency: readonly { code: string; amount: string | number }[],
): ApproxGroupsQuery {
  const groups = new Map<string, string>();
  const seenCodes = new Set<string>();

  for (const group of byCurrency) {
    const code = group.code.trim().toUpperCase();
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);

    let amount: string;
    try {
      amount = roundToCurrency(group.amount, code);
    } catch {
      return { kind: 'invalid' };
    }
    if (!PLAIN_NON_NEGATIVE_DECIMAL.test(amount)) return { kind: 'invalid' };

    groups.set(code, amount);
  }

  if (groups.size === 0) return { kind: 'empty' };

  return {
    kind: 'query',
    value: [...groups]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, amount]) => `${code}:${amount}`)
      .join(','),
  };
}

/** Codes the server could not convert, uppercased and deduplicated in the order
 *  the server reported them — the copy names them verbatim, so a duplicate or a
 *  lowercase code would read as two different currencies. */
function unavailableCodes(response: ReportingTotalResponse): string[] {
  const seen = new Set<string>();
  for (const raw of response.unavailableCurrencyCodes ?? []) {
    const code = String(raw).trim().toUpperCase();
    if (code) seen.add(code);
  }
  return [...seen];
}

/** The reason the FAILING legs agree on, or `mixed`. Never guesses: a leg with
 *  no reason (or a reason outside the contract — the body is unvalidated JSON)
 *  contributes nothing, and disagreement stays `mixed` rather than picking the
 *  first and presenting it as THE cause. */
function unavailableReason(
  response: ReportingTotalResponse,
  codes: readonly string[],
): ApproxUnavailableReason {
  const wanted = new Set(codes);
  const reasons = new Set<'missing' | 'stale'>();
  for (const group of response.groups ?? []) {
    if (group?.reason !== 'missing' && group?.reason !== 'stale') continue;
    if (!wanted.has(String(group.currencyCode).trim().toUpperCase())) continue;
    reasons.add(group.reason);
  }
  if (reasons.size !== 1) return 'mixed';
  return reasons.has('stale') ? 'stale' : 'missing';
}

/**
 * The ONLY display decision. Three outcomes, no fourth: the server's total, an
 * explicit account of why there isn't one, or silence — and silence is reserved
 * for the two states that carry no information (nothing was asked; the book
 * needs no conversion). A body that claims `available` without a usable total or
 * rate date is a contract violation, and it reports as unavailable rather than
 * disappearing: `useApproximateTotal.validate` already rejects that shape, so
 * this branch exists to make the drift visible if it ever stops doing so.
 */
export function selectApproxTotal(response: ReportingTotalResponse | null): ApproxTotalView {
  if (!response || response.status === 'not-needed') return { status: 'hidden' };

  if (response.status === 'available' && response.total !== null && response.rateDate !== null) {
    return {
      status: 'available',
      amount: response.total,
      currencyCode: response.targetCurrencyCode,
      rateDate: response.rateDate,
    };
  }

  const currencyCodes = unavailableCodes(response);
  return {
    status: 'unavailable',
    currencyCodes,
    targetCurrencyCode: String(response.targetCurrencyCode ?? '').trim().toUpperCase(),
    reason: unavailableReason(response, currencyCodes),
  };
}
