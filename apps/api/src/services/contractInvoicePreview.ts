/**
 * What the next `generateDueInvoice` run of one contract would bill, computed
 * without writing anything (full-control W14 PR B, #6784).
 *
 * Two callers:
 *  - `manage_contracts:preview_invoice` shows a person (and the model) the
 *    period, the lines, the totals, whether the invoice auto-issues and who it
 *    would be emailed to, before anyone asks for a four-eyes generate;
 *  - the `manage_contracts:generate_invoice` effect digest
 *    (actionIntents/effectDigest.ts) hashes `previewDigestMaterial(preview)` at
 *    intent creation and again at release, so a drift between approval and
 *    release (a device added, a price edited, the billing contact changed,
 *    auto-issue switched, the period already billed) refuses the release.
 *
 * It mirrors generateDueInvoice step for step — the same due check and period
 * (billingRunPeriods), the same billable-line filter, the same quantity split
 * (resolveLineQty, which W06's parity test pins to the generator's device
 * walk), the same catalog price resolution in the contract currency with the
 * same snapshot fallback on a price-book gap, the same overage leg, and the
 * same tax arithmetic (resolveOrgTaxRateOn + computeInvoiceTotals) — but it
 * resolves each line once and never creates, claims or emails anything.
 *
 * Out of the preview's reach, so reported as `blocked` (the AI generate refuses
 * these; a person generates them in the web app):
 *  - a LIVE hour_block line: the run also closes block periods onto the
 *    invoice from logged time entries, which this preview cannot pin;
 *  - a line the generator would refuse (deleted site / group, a manual line
 *    with no quantity).
 *
 * Reads run on the ambient context. The generate path calls it under system
 * scope (as the route runs generateDueInvoice); the read action under the
 * caller's own partner context after the contract gate.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { contracts, contractLines, organizations } from '../db/schema';
import { resolveLineQty, type DeviceCache, type SeatCache } from './contractService';
import { billingRunPeriods, isAutoRenewing, isExpired, todayISO } from './contractMath';
import { billsOverage } from './contractAllowance';
import { resolvePrice, CatalogServiceError } from './catalogService';
import { computeInvoiceTotals, computeLineTotal } from './invoiceMath';
import { resolveOrgTaxRateOn } from './taxRateResolver';
import { resolveBillingEmail } from './invoiceRenderHelpers';

export type InvoicePreviewPricedFrom = 'org_override' | 'price_book' | 'contract_snapshot';

export interface InvoicePreviewLine {
  contractLineId: string;
  lineType: string;
  /** The base invoice line's quantity, formatted as the generator formats it. */
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  pricedFrom: InvoicePreviewPricedFrom;
  lineTotal: string;
  /** The sibling overage line, when this line bills one this period. */
  overage: { quantity: string; unitPrice: string; lineTotal: string } | null;
}

export type InvoicePreviewBlock =
  | { code: 'HOUR_BLOCK_NOT_SUPPORTED'; contractLineId: string }
  | { code: 'LINE_UNRESOLVED'; contractLineId: string; reason: string };

export type InvoicePreview =
  | {
    due: false;
    contractId: string;
    orgId: string;
    /** not_due: not active, no pointer or the pointer is in the future; the rest mirror the generator's skips. */
    reason: 'not_due' | 'expired' | 'renewal_pending' | 'no_billable_lines';
    nextBillingAt: string | null;
  }
  | {
    due: true;
    contractId: string;
    orgId: string;
    partnerId: string;
    period: { start: string; end: string };
    currencyCode: string;
    autoIssue: boolean;
    lines: InvoicePreviewLine[];
    subtotal: string;
    taxRate: string | null;
    taxTotal: string;
    total: string;
    /** Who the post-commit auto-issue email goes to; [] when auto-issue is off or no billing contact is set. */
    recipients: string[];
    blocked: InvoicePreviewBlock | null;
  };

export class ContractInvoicePreviewNotFound extends Error {
  constructor(contractId: string) {
    super(`contract ${contractId} not found`);
    this.name = 'ContractInvoicePreviewNotFound';
  }
}

/** The generator's own quantity formatting (materializeContractLineOntoInvoice). */
function baseQuantity(r: { billed: number; included: number | null }): string {
  return r.included === null ? String(r.billed) : r.billed.toFixed(2);
}

export async function previewDueInvoice(contractId: string, asOf: Date = new Date()): Promise<InvoicePreview> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (!c) throw new ContractInvoicePreviewNotFound(contractId);
  const notDue = (reason: Extract<InvoicePreview, { due: false }>['reason']): InvoicePreview => ({
    due: false, contractId, orgId: c.orgId, reason, nextBillingAt: c.nextBillingAt,
  });

  if ((c.status as string) !== 'active' || c.nextBillingAt === null) return notDue('not_due');
  if (c.nextBillingAt > todayISO(asOf)) return notDue('not_due');
  const { due: period } = billingRunPeriods({
    startDate: c.startDate, intervalMonths: c.intervalMonths,
    billingTiming: c.billingTiming as 'advance' | 'arrears', nextBillingAt: c.nextBillingAt,
  });
  if (isExpired({ endDate: c.endDate, periodStart: period.periodStart })) {
    return notDue(isAutoRenewing(c) ? 'renewal_pending' : 'expired');
  }

  const lines = await db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId))
    .orderBy(contractLines.sortOrder, contractLines.createdAt, contractLines.id);
  const billable = lines.filter((l) => !(l.lineType === 'hour_block' && l.hourBlockRetiredAt !== null));
  if (billable.length === 0) return notDue('no_billable_lines');

  const catalogActor = { userId: c.createdBy, partnerId: c.partnerId, accessibleOrgIds: [c.orgId] };
  const dc: DeviceCache = new Map();
  const sc: SeatCache = new Map();
  const out: InvoicePreviewLine[] = [];
  let blocked: InvoicePreviewBlock | null = null;

  for (const l of billable) {
    if (l.lineType === 'hour_block') {
      blocked ??= { code: 'HOUR_BLOCK_NOT_SUPPORTED', contractLineId: l.id };
    }
    const r = await resolveLineQty(c.orgId, l, dc, sc);
    if (r.unresolved) {
      blocked ??= { code: 'LINE_UNRESOLVED', contractLineId: l.id, reason: r.unresolved };
      continue;
    }
    // The block FEE bills like flat (qty 1); its allowance is hours, never units.
    const quantity = l.lineType === 'hour_block' ? '1' : baseQuantity(r);

    let unitPrice = Number(l.unitPrice).toFixed(2);
    let taxable = l.taxable;
    let pricedFrom: InvoicePreviewPricedFrom = 'contract_snapshot';
    if (l.catalogItemId) {
      try {
        const resolved = await resolvePrice(l.catalogItemId, c.currencyCode, c.orgId, catalogActor);
        unitPrice = resolved.unitPrice;
        taxable = resolved.taxable;
        pricedFrom = resolved.source;
      } catch (err) {
        // The generator's fallback (invoiceService.addContractLine): a gap bills the contract snapshot.
        if (!(err instanceof CatalogServiceError
          && (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE'))) throw err;
      }
    }
    const overage = l.lineType !== 'hour_block' && billsOverage(r) && l.overageUnitPrice !== null
      ? {
        quantity: r.overage.toFixed(2),
        unitPrice: l.overageUnitPrice,
        lineTotal: computeLineTotal(r.overage.toFixed(2), l.overageUnitPrice, c.currencyCode),
      }
      : null;
    out.push({
      contractLineId: l.id, lineType: l.lineType, quantity, unitPrice, taxable, pricedFrom,
      lineTotal: computeLineTotal(quantity, unitPrice, c.currencyCode), overage,
    });
  }

  // Tax exactly as the draft's recompute does (effectiveRateForOrg: an exempt org or no rate is no tax).
  const taxRate = await resolveOrgTaxRateOn(db, { orgId: c.orgId, partnerId: c.partnerId });
  const totals = computeInvoiceTotals(
    out.flatMap((l) => [
      { lineTotal: l.lineTotal, taxable: l.taxable, customerVisible: true },
      ...(l.overage ? [{ lineTotal: l.overage.lineTotal, taxable: l.taxable, customerVisible: true }] : []),
    ]),
    taxRate,
    c.currencyCode,
  );

  let recipients: string[] = [];
  if (c.autoIssue) {
    const [org] = await db.select({ billingContact: organizations.billingContact })
      .from(organizations).where(eq(organizations.id, c.orgId)).limit(1);
    const email = resolveBillingEmail(org?.billingContact);
    recipients = email ? [email] : [];
  }

  return {
    due: true, contractId, orgId: c.orgId, partnerId: c.partnerId,
    period: { start: period.periodStart, end: period.periodEnd },
    currencyCode: c.currencyCode, autoIssue: c.autoIssue, lines: out,
    subtotal: totals.subtotal, taxRate, taxTotal: totals.taxTotal, total: totals.total,
    recipients, blocked,
  };
}

/**
 * The bytes the generate_invoice effect digest hashes. Versioned, key order
 * fixed by construction. Everything an approver signs off on is here: the
 * period, the currency, every line's quantity / price / tax flag, the totals,
 * auto-issue and the recipients. A not-due preview pins its reason, so an
 * approval for a due period cannot release once the period has been billed.
 */
export function previewDigestMaterial(p: InvoicePreview): string {
  if (!p.due) return JSON.stringify({ v: 1, contractId: p.contractId, orgId: p.orgId, due: false, reason: p.reason, nextBillingAt: p.nextBillingAt });
  return JSON.stringify({
    v: 1, contractId: p.contractId, orgId: p.orgId, due: true,
    period: p.period, currencyCode: p.currencyCode, autoIssue: p.autoIssue,
    lines: p.lines.map((l) => [l.contractLineId, l.lineType, l.quantity, l.unitPrice, l.taxable, l.pricedFrom, l.lineTotal,
      l.overage ? [l.overage.quantity, l.overage.unitPrice, l.overage.lineTotal] : null]),
    subtotal: p.subtotal, taxRate: p.taxRate, taxTotal: p.taxTotal, total: p.total,
    recipients: [...p.recipients].sort(),
    blocked: p.blocked,
  });
}
