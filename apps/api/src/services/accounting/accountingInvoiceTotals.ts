/**
 * Invoice totals invariant for EVERY accounting provider (Xero W01 "Invoice
 * totals invariant"; the fix itself is #7161, moved here unchanged from
 * `accountingInvoicePush.ts`). Breeze's `computeInvoiceTotals` excludes
 * customer_visible = false lines, so the accounting payload sends them at zero,
 * the pushed lines must sum to Breeze's subtotal before anything is sent, and
 * after a push both tax and total are compared. Provider-neutral on purpose: a
 * provider maps fields, it does not decide what the customer was billed.
 */

import { AccountingInvoicePushError } from './accountingInvoicePushErrors';
import type { InvoicePushResult } from './types';

type RemoteVarianceStatus = 'synced' | 'synced_with_tax_variance';

/**
 * #7161: a hidden line (customer_visible = false) is excluded from Breeze's
 * subtotal (`computeInvoiceTotals`), so it must carry no money in the
 * accounting copy either — pushed at its stored price it inflated the
 * provider's invoice over what the customer was billed. The line itself is
 * KEPT by the caller (the accounting view is meant to expose every line), with
 * its description and quantity; only the price and amount are zeroed.
 */
export function pushedLineAmounts(
  line: { customerVisible: boolean; unitPrice: string; lineTotal: string },
): { unitPrice: string; lineTotal: string } {
  const hidden = !line.customerVisible;
  return {
    unitPrice: hidden ? '0.00' : line.unitPrice,
    lineTotal: hidden ? '0.00' : line.lineTotal,
  };
}

/** DB `numeric(12,2)` decimal strings — exact, no binary float rounding. */
function centsFromDecimalString(value: string): number {
  return Math.round(Number(value) * 100);
}

/** >1¢ absolute difference is a variance; 1¢ or less (or no remote figure) is within tolerance. */
function varianceCents(remoteAmount: string | null, breezeAmount: string): number | null {
  if (remoteAmount === null) return null;
  const diffCents = Math.abs(centsFromDecimalString(remoteAmount) - centsFromDecimalString(breezeAmount));
  return diffCents > 1 ? diffCents : null;
}

/**
 * Post-push drift check. Tax (the provider computes its own) and, since #7161,
 * the invoice total are compared against Breeze with the same 1¢ tolerance.
 * Either one drifting marks the mapping `synced_with_tax_variance` — the one
 * drifted-but-synced state the mapping row has — never plain `synced`.
 */
export function computeRemoteVariance(
  result: Pick<InvoicePushResult, 'remoteTaxTotal' | 'remoteTotal'>,
  inv: { taxTotal: string; total: string },
): { syncStatus: RemoteVarianceStatus; taxVarianceCents: number | null; totalVarianceCents: number | null } {
  const taxVarianceCents = varianceCents(result.remoteTaxTotal, inv.taxTotal);
  const totalVarianceCents = varianceCents(result.remoteTotal, inv.total);
  const drifted = taxVarianceCents !== null || totalVarianceCents !== null;
  return { syncStatus: drifted ? 'synced_with_tax_variance' : 'synced', taxVarianceCents, totalVarianceCents };
}

/**
 * Exact integer cents from a `numeric(12,2)` decimal string by parsing the
 * digits — no binary float anywhere, so a sum of many lines cannot drift.
 * Returns null for anything that is not a plain decimal with at most two
 * fraction digits; the caller treats that as a mismatch (fail closed).
 */
function exactCents(value: string): number | null {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return m[1] ? -cents : cents;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * #7161 pre-flight: the line amounts the provider will receive must sum to
 * Breeze's own subtotal, or the provider would record a different amount than
 * the customer was billed. Runs on the exact payload lines that get pushed.
 * `label` is the provider's display name (`accountingProviderDisplayName`).
 */
export function assertPushedLinesMatchSubtotal(
  inv: { subtotal: string },
  linePayloads: readonly { lineTotal: string }[],
  label: string,
): void {
  let sumCents = 0;
  let parseable = true;
  for (const l of linePayloads) {
    const c = exactCents(l.lineTotal);
    if (c === null) { parseable = false; break; }
    sumCents += c;
  }
  const subtotalCents = exactCents(inv.subtotal);
  if (parseable && subtotalCents !== null && sumCents === subtotalCents) return;

  const pushed = parseable ? formatCents(sumCents) : 'an unreadable amount';
  throw new AccountingInvoicePushError(
    'invoice_totals_mismatch',
    409,
    `The invoice lines sent to ${label} would total ${pushed}, but this invoice's subtotal is ${inv.subtotal}. `
      + `Breeze refused the push so ${label} does not record a different amount than the customer was billed. `
      + 'Review the invoice lines and totals, then push again.',
  );
}
