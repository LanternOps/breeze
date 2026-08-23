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
 * - ANY missing, stale or incomplete leg hides the WHOLE line (the server
 *   returns status 'unavailable' and total null — a partial approximation is a
 *   dishonest number);
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

export type ApproxTotalView =
  | { status: 'hidden' }
  | { status: 'available'; amount: string; currencyCode: string; rateDate: string };

const PLAIN_NON_NEGATIVE_DECIMAL = /^(\d+)(?:\.(\d*))?$/;

/** `USD:12300.00,EUR:4100.00` — sorted, deduplicated, every amount quantized to
 *  the currency's minor unit. Returns '' when there is nothing to ask about,
 *  and ALSO when any single leg is unusable (negative, non-finite): the caller
 *  then makes no request and renders no line at all. Skipping the bad leg
 *  instead would ask the server to approximate a book it was not given, and the
 *  answer would come back `available` — a partial approximate total, which the
 *  spec forbids (§8: one unavailable leg suppresses the WHOLE line).
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
): string {
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
      return '';
    }
    if (!PLAIN_NON_NEGATIVE_DECIMAL.test(amount)) return '';

    groups.set(code, amount);
  }

  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, amount]) => `${code}:${amount}`)
    .join(',');
}

/** The ONLY display decision: show the server's total, or show nothing. */
export function selectApproxTotal(response: ReportingTotalResponse | null): ApproxTotalView {
  if (
    response?.status !== 'available'
    || response.total === null
    || response.rateDate === null
  ) {
    return { status: 'hidden' };
  }

  return {
    status: 'available',
    amount: response.total,
    currencyCode: response.targetCurrencyCode,
    rateDate: response.rateDate,
  };
}
