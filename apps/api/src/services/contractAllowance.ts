/**
 * Pure allowance arithmetic (#3205 W04 / #4607). No DB, no I/O, no line-type
 * enum. The ONE definition of how a counted quantity splits into billed +
 * overage, called by resolveLineQty (estimate, contracts list, MRR rollup) AND
 * by generateDueInvoice's own switch, so the four paths can never disagree on
 * QUANTITIES.
 *
 * `baseBillingMode` is an explicit PARAMETER rather than a lineType switch so
 * this module never imports the contract-line enum — which is what lets #4547
 * (block hours) reuse it while it is itself extending that enum.
 *
 * The one money function, `overageValue`, is a single call to the shared
 * exact-decimal primitive `multiplyToCurrency` (scaled-integer multiply, one
 * half-up round at the currency's minor unit). It lives here, not inline in the
 * four callers, because a duplicated money expression is how `Number(a) * b`
 * creeps back in. It imports no enum and touches no DB, so #4547's reuse is
 * unaffected. Accumulation across lines stays with the callers (toCents /
 * fromCents), because only they know what a "period total" is.
 */
import { multiplyToCurrency, type OverageMode } from '@breeze/shared';

export type { OverageMode };

/**
 * 'included_units' — the base line bills the ALLOWANCE (unit_price is per unit).
 *                    Every W04 line type.
 * 'single_block'   — the base line bills 1 (unit_price is the price of the whole
 *                    block; included_quantity is an entitlement in another unit).
 *                    #4547's hour_block.
 */
export type BaseBillingMode = 'included_units' | 'single_block';

/** The three allowance columns as they come off a contract_lines row. */
export interface AllowanceSpec {
  includedQuantity: string | null;
  overageMode: OverageMode | null;
  overageUnitPrice: string | null;
}

export interface ResolvedQuantity {
  /** What the resolver measured: devices, seats, manualQuantity, or 1 for flat. */
  counted: number;
  /** The quantity that goes on the BASE invoice line. */
  billed: number;
  /** The allowance, or null when this line has none. */
  included: number | null;
  /** max(0, counted - included). 0 when there is no allowance. */
  overage: number;
  overageMode: OverageMode | null;
}

/**
 * FIXED allowance (roadmap, settled): with an allowance the base bills the
 * ALLOWANCE every period, whether the count reaches it or not. Never min().
 */
export function applyAllowance(
  counted: number, spec: AllowanceSpec, baseBillingMode: BaseBillingMode,
): ResolvedQuantity {
  const included = spec.includedQuantity == null ? null : Number(spec.includedQuantity);
  if (included === null) {
    return {
      counted,
      billed: baseBillingMode === 'single_block' ? 1 : counted,
      included: null,
      overage: 0,
      overageMode: null,
    };
  }
  return {
    counted,
    billed: baseBillingMode === 'single_block' ? 1 : included,
    included,
    overage: Math.max(0, counted - included),
    overageMode: spec.overageMode,
  };
}

/** True when this line owes an overage INVOICE line this period. */
export function billsOverage(r: ResolvedQuantity): boolean {
  return r.overageMode === 'bill' && r.overage > 0;
}

/**
 * The overage leg's money, exact in `currencyCode`. `'0.00'` in every
 * currency, zero-decimal ones included (storage is fixed-2 major units — spec:
 * numeric(_,2) in every currency), whenever nothing is billed — a flag-mode line,
 * a line inside its allowance, or a line with no rate — so a caller can always
 * add it without a branch. The overage leg is never catalog-priced, so this is
 * the same number the estimate and the invoice both show.
 */
export function overageValue(
  r: ResolvedQuantity,
  spec: Pick<AllowanceSpec, 'overageUnitPrice'>,
  currencyCode: string,
): string {
  const bills = billsOverage(r) && spec.overageUnitPrice !== null;
  return multiplyToCurrency(bills ? r.overage : 0, bills ? spec.overageUnitPrice! : '0', currencyCode);
}
