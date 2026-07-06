// Deposit presentation helpers, shared by InvoiceList (list badge) and
// InvoiceDetailView (deposit strip + deposit-aware Pay-button label) — extracted
// here (mirroring invoiceStatus.ts) so the load-bearing money math has one home
// and a sibling unit test.
//
// The charge-now rule mirrors computeChargeNow (@breeze/shared depositMath.ts —
// the single source of truth the server charges by, Task 8). The portal browser
// bundle can't import that runtime package (api/web/portal share types only, never
// runtime code), so the two-branch rule is re-implemented here with integer-cents
// math. Keeping it identical to the server rule guarantees the Pay button label can
// never advertise a different amount than the checkout route actually charges.
//
// The input contract is sourced from @breeze/shared (type-only — erased at build,
// as with InvoiceStatus in invoiceStatus.ts) so this re-implemented copy can never
// structurally drift from the server's computeChargeNow signature.
import type { DepositChargeInput } from '@breeze/shared';
export type { DepositChargeInput };

/** Money string → integer cents (mirrors quoteMath.toCents). Compare money in cents,
 *  never as floats. Null/empty/non-finite → 0. */
export function toCents(v: string | null): number {
  if (v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Deposit-first charge amount: when a deposit is set and still unmet, charge the
 *  deposit remaining (clamped to the balance so a concurrent manual payment can't
 *  push the charge past what is owed); otherwise charge the full balance. Identical
 *  to computeChargeNow(@breeze/shared). */
export function computeChargeNow(inv: DepositChargeInput): { amount: string; isDeposit: boolean } {
  const balanceCents = toCents(inv.balance);
  const depositCents = inv.depositDue !== null ? toCents(inv.depositDue) : 0;
  const paidCents = toCents(inv.amountPaid);
  if (depositCents > 0 && paidCents < depositCents) {
    return { amount: (Math.min(depositCents - paidCents, balanceCents) / 100).toFixed(2), isDeposit: true };
  }
  return { amount: inv.balance, isDeposit: false };
}

/** List-badge state for an invoice: 'unpaid' while amountPaid < depositDue, 'paid'
 *  once the deposit is met, null when the invoice carries no deposit (null depositDue
 *  is the no-deposit sentinel — no badge, zero visual change). */
export function depositBadgeState(inv: { depositDue: string | null; amountPaid: string }): 'unpaid' | 'paid' | null {
  if (inv.depositDue == null) return null;
  return toCents(inv.amountPaid) < toCents(inv.depositDue) ? 'unpaid' : 'paid';
}
