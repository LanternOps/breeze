import { toCents, fromCents } from './quoteMath';

/**
 * The single pay-amount rule (spec §"Pay-amount rule"):
 *   chargeNow = deposit set && amountPaid < depositDue ? depositDue − amountPaid : balance
 * Clamped to the invoice balance so a concurrent manual payment can never push a
 * Stripe charge past what is owed. Pure + browser-safe: shared by the API
 * checkout paths and the portal/web "Pay" button labels.
 */
export function computeChargeNow(inv: {
  depositDue: string | null;
  amountPaid: string;
  balance: string;
}): { amount: string; isDeposit: boolean } {
  const balanceCents = toCents(inv.balance);
  const depositCents = inv.depositDue !== null ? toCents(inv.depositDue) : 0;
  const paidCents = toCents(inv.amountPaid);
  if (depositCents > 0 && paidCents < depositCents) {
    return { amount: fromCents(Math.min(depositCents - paidCents, balanceCents)), isDeposit: true };
  }
  return { amount: inv.balance, isDeposit: false };
}
