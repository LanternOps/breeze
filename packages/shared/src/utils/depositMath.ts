import { isRepresentableInCurrency, roundToCurrency, toMinorUnits } from './currency';
import { toCents } from './quoteMath';

/**
 * The single pay-amount rule (spec §"Pay-amount rule"):
 *   chargeNow = deposit set && amountPaid < depositDue ? depositDue − amountPaid : balance
 * Clamped to the invoice balance so a concurrent manual payment can never push a
 * Stripe charge past what is owed. Pure + browser-safe: shared by the API
 * checkout paths and the portal/web "Pay" button labels.
 */
/** Input to the deposit-first charge rule. Exported so the portal's re-implemented
 *  copy (which can't import runtime code from this package) can import the TYPE and
 *  cannot structurally drift from the server's contract. */
export interface DepositChargeInput {
  depositDue: string | null;
  amountPaid: string;
  balance: string;
}

export function computeChargeNow(inv: DepositChargeInput, currencyCode = 'USD'): { amount: string; isDeposit: boolean } {
  const balanceCents = toCents(inv.balance);
  const depositCents = inv.depositDue !== null ? toCents(inv.depositDue) : 0;
  const paidCents = toCents(inv.amountPaid);
  if (depositCents > 0 && paidCents < depositCents) {
    return { amount: roundToCurrency(Math.min(depositCents - paidCents, balanceCents) / 100, currencyCode), isDeposit: true };
  }
  return { amount: roundToCurrency(inv.balance, currencyCode), isDeposit: false };
}

/** What a Stripe Checkout session may charge for an invoice right now. */
export type CheckoutCharge =
  /** `minor` is the Stripe `unit_amount`; `amount` is the same value as the
   *  fixed-2 string the mapping row records (fromMinorUnits(minor) === amount). */
  | { kind: 'charge'; amount: string; minor: number; isDeposit: boolean }
  | { kind: 'nothing' }
  /** The balance has digits the currency cannot express (a legacy zero-decimal
   *  row such as JPY '1000.50'). No Checkout amount is correct: rounding up
   *  over-charges, rounding down strands a residue no later Checkout can collect.
   *  recordPayment accepts only the exact payoff against it. */
  | { kind: 'not_representable'; balance: string };

/**
 * THE Checkout charge rule (#3803 item 8): computeChargeNow's deposit-first
 * amount, converted to Stripe minor units, refused outright when the balance is
 * not representable in the invoice currency. Every Checkout producer and the
 * publication check under the invoice lock call this, so the amount minted, the
 * amount re-checked and the amount recorded cannot drift apart.
 *
 * A representable balance keeps every charge safe: a deposit remainder is
 * clamped to the balance and then rounded half-up to a whole minor unit, and a
 * whole-unit balance is never exceeded by that round.
 */
export function computeCheckoutCharge(inv: DepositChargeInput, currencyCode: string): CheckoutCharge {
  if (!isRepresentableInCurrency(inv.balance, currencyCode)) return { kind: 'not_representable', balance: inv.balance };
  const charge = computeChargeNow(inv, currencyCode);
  const minor = toMinorUnits(charge.amount, currencyCode);
  if (minor <= 0) return { kind: 'nothing' };
  return { kind: 'charge', amount: charge.amount, minor, isDeposit: charge.isDeposit };
}
