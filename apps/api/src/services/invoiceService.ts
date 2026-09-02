import { and, or, eq, desc, lt, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  invoices, invoiceLines, invoicePayments, invoiceStripePayments, organizations, partners,
  catalogBundleComponents, catalogItems, contracts, contractLines, timeEntries, ticketParts, tickets,
  accountingEntityMappings, accountingConnections
} from '../db/schema';
import { getConnection } from './stripeConnectService';
import { computeLineTotal, computeInvoiceTotals, resolveEffectiveTaxRate, deriveInvoiceStatus, toCents, fromCents } from './invoiceMath';
import { resolvePrice, computeBundleEconomics, CatalogServiceError, type CatalogActor } from './catalogService';
import { snapshotCost } from './catalogPricing';
// formatInvoiceNumber is shared with the standalone allocator; issueInvoice
// inlines the counter upsert itself (rather than calling allocateInvoiceCounter)
// to keep allocation atomic with the number write inside its single transaction.
import { formatInvoiceNumber } from './invoiceNumbers';
import { emitInvoiceEvent } from './invoiceEvents';
import { enqueueInvoicePdfRender } from '../jobs/invoiceWorker';
import {
  enqueueAccountingInvoicePush, enqueueAccountingInvoiceVoid,
  enqueueAccountingPaymentPush, enqueueAccountingPaymentDelete,
} from '../jobs/accountingSyncWorker';
import type { MappingSyncStatus } from './accounting/accountingMappingService';
import { requestPaymentPush, requestPaymentDelete } from './accounting/accountingPaymentPush';
import { gatherOrgTimeEntries, gatherOrgParts, gatherTicketBillables, mergeAssembly, type AssemblyResult, type DraftLineSpec, type MissingRateSpec } from './invoiceAssembly';
import { buildSellerSnapshot, buildBillToAddress } from './sellerSnapshot';
import { InvoiceServiceError } from './invoiceTypes';
import { changeOrgCurrency } from './orgCurrencyService';
import { readOrgStampingDefaults, OrgCurrencyServiceError, type DbExecutor as OrgLockExecutor } from './orgCurrencyCore';
import { buildAutomationEligibleOrgPredicate } from './tenantStatus';

/**
 * Boundary mapping for the org SHARE barrier (#3778, review finding 1).
 * `orgCurrencyCore` is domain-neutral by design and throws its own
 * `OrgCurrencyServiceError`; this service's route boundary rethrows anything it
 * does not recognise, so an unmapped ORG_NOT_FOUND would surface as a 500
 * instead of the 404 this path returned before the barrier existed. Only
 * ORG_NOT_FOUND is translated — a serialization failure, a deadlock or a
 * genuine helper bug must keep its own identity.
 */
async function lockOrgStampingDefaults(tx: OrgLockExecutor, orgId: string): Promise<{ currencyCode: string }> {
  try {
    return await readOrgStampingDefaults(tx, orgId);
  } catch (err) {
    if (err instanceof OrgCurrencyServiceError && err.code === 'ORG_NOT_FOUND') {
      throw new InvoiceServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    }
    throw err;
  }
}

import { resolvePartnerDocumentLocale } from './documentLocale';
import { retryOnTransientLockError } from '../utils/pgErrors';
import { mergeBillingContact, type ContactBlob } from './contacts/compat';
import type { InvoiceActor } from './invoiceTypes';
import { isRepresentableInCurrency, minorUnitExponent, roundToCurrency, buildStripeCurrencyWarning, type ManualLineInput, type RecordPaymentInput } from '@breeze/shared';

function requirePartner(actor: InvoiceActor): string {
  if (!actor.partnerId) throw new InvoiceServiceError('Partner could not be resolved', 400, 'PARTNER_UNRESOLVABLE');
  return actor.partnerId;
}

export function requireOrgAccess(actor: InvoiceActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new InvoiceServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
}

/**
 * Site-axis guard mirroring `siteAccessCheck` (middleware/auth.ts). An actor
 * with no `allowedSiteIds` (undefined) is unrestricted — this is a no-op, so
 * partner/system callers and all-sites org users are unaffected. A site-restricted
 * actor may only touch a siteId in its allowlist; a null/undefined siteId (an
 * org-level invoice with no site) is DENIED, exactly as the auth closure denies a
 * restricted caller for a null site.
 */
export function requireSiteAccess(actor: InvoiceActor, siteId: string | null | undefined): void {
  if (!actor.allowedSiteIds) return; // unrestricted (partner/system, or all-sites org user)
  if (!siteId || !actor.allowedSiteIds.includes(siteId)) {
    throw new InvoiceServiceError('Site access denied', 403, 'SITE_DENIED');
  }
}

/** Org + site guard for a loaded invoice row (the common case). */
export function requireInvoiceAccess(actor: InvoiceActor, inv: { orgId: string; siteId: string | null }): void {
  requireOrgAccess(actor, inv.orgId);
  requireSiteAccess(actor, inv.siteId);
}

/** Either the ambient `db` handle or a `db.transaction` callback handle. */
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function getOwnedInvoiceOr404(id: string, dbc: DbExecutor = db) {
  const rows = await dbc.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!rows[0]) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  return rows[0];
}

function assertDraft(inv: { status: string }): void {
  if (inv.status !== 'draft') throw new InvoiceServiceError('Invoice is not a draft', 409, 'NOT_A_DRAFT');
}

/**
 * B10 lock-order anchor (#3774): every draft line/header writer takes the
 * INVOICE row lock first, then mutates lines, then recomputes totals — all in
 * one transaction. issueInvoice locks in the same order (invoice → lines →
 * source rows), so writer-vs-issue interleavings serialize on the invoice row
 * instead of deadlocking (the old line→invoice recompute order was AB/BA
 * against issuance) or leaving a line invisible to the frozen totals. The
 * invoice lock is also what serializes line-insert phantoms — line-level
 * FOR UPDATE alone cannot.
 */
async function lockDraftInvoice(tx: DbExecutor, invoiceId: string) {
  const rows = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
  if (!rows[0]) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  assertDraft(rows[0]);
  return rows[0];
}

export async function createManualInvoice(input: { orgId: string; siteId?: string; notes?: string; termsAndConditions?: string; currencyCode?: string }, actor: InvoiceActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, input.orgId);
  requireSiteAccess(actor, input.siteId ?? null);
  // Stamp the document currency at creation (spec §5): the explicit override
  // (used internally by contract generation, which copies the CONTRACT's stamp)
  // or the org's currency — never the partner's, and never a DB default.
  // Creation barrier (#3778): the org default is read under a SHARE lock held
  // to commit, so `changeOrgCurrency`'s FOR UPDATE either sees this draft in its
  // in-lock summary or this insert re-reads the NEW default — a default-derived
  // stamp can never commit unseen. An explicit `currencyCode` is a source copy
  // (contract generation) and must NOT reread the org.
  const rows = await db.transaction(async (tx) => {
    let currencyCode = input.currencyCode;
    if (!currencyCode) {
      currencyCode = (await lockOrgStampingDefaults(tx, input.orgId)).currencyCode;
    }
    return tx.insert(invoices).values({
      partnerId, orgId: input.orgId, siteId: input.siteId ?? null, status: 'draft',
      notes: input.notes ?? null, termsAndConditions: input.termsAndConditions ?? null,
      currencyCode, createdBy: actor.userId
    }).returning();
  });
  return rows[0]!;
}

/** Draft-time effective tax rate: org rate or 0. The partner default is applied
 *  authoritatively at issue (system context, where the partner row is readable). */
async function effectiveRateForOrg(orgId: string, dbc: DbExecutor = db): Promise<string> {
  const [org] = await dbc.select({ taxExempt: organizations.taxExempt, taxRate: organizations.taxRate })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return resolveEffectiveTaxRate({ taxExempt: org?.taxExempt ?? false, orgRate: org?.taxRate ?? null, partnerRate: null });
}

/** Recompute subtotal/tax/total/balance from the invoice's current lines. Draft-time
 *  uses the org's effective rate; on issue the snapshotted tax_rate is passed instead.
 *  Writers holding the invoice row lock pass their `tx` so the recompute stays inside
 *  the same transaction (a global-db call here would escape the lock scope). */
export async function recomputeInvoiceTotals(invoiceId: string, taxRateOverride?: string | null, dbc: DbExecutor = db) {
  const inv = await getOwnedInvoiceOr404(invoiceId, dbc);
  // Frozen invoices can never be re-totaled by a direct call. issueInvoice computes
  // totals inline with the snapshot rate and does NOT call this; assembly recomputes
  // a fresh draft (still draft here), so this guard is safe on both paths.
  assertDraft(inv);
  const lines = await dbc.select({
    lineTotal: invoiceLines.lineTotal, taxable: invoiceLines.taxable, customerVisible: invoiceLines.customerVisible
  }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  const taxRate = taxRateOverride !== undefined ? taxRateOverride : await effectiveRateForOrg(inv.orgId, dbc);
  const totals = computeInvoiceTotals(lines, taxRate, inv.currencyCode);
  const balance = fromCents(toCents(totals.total) - toCents(inv.amountPaid));
  await dbc.update(invoices).set({
    subtotal: totals.subtotal, taxRate, taxTotal: totals.taxTotal, total: totals.total, balance, updatedAt: new Date()
  }).where(eq(invoices.id, invoiceId));
}

/** The catalog-side actor for a price resolution on behalf of an invoice actor. */
function catalogActorFrom(actor: InvoiceActor): CatalogActor {
  return { userId: actor.userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds };
}

/**
 * Multi-currency wave 3 (#3775): resolve a catalog item's sell price in the
 * INVOICE's currency on the already-locked tx (invoice → lines → catalog plain
 * SELECTs — no new lock edge). A price-book gap is mapped to the invoice's own
 * typed 409; every other catalog error propagates unchanged.
 */
async function resolveInvoicePrice(tx: DbExecutor, catalogItemId: string, inv: { currencyCode: string; orgId: string }, actor: InvoiceActor) {
  try {
    return await resolvePrice(catalogItemId, inv.currencyCode, inv.orgId, catalogActorFrom(actor), tx);
  } catch (err) {
    if (err instanceof CatalogServiceError && (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE')) {
      throw new InvoiceServiceError(err.message, 409, err.code);
    }
    throw err;
  }
}

/**
 * Wave-6 release gate (W6-G1-1): every hand-entered money value persisted on an
 * invoice line must be representable in the INVOICE's stamped currency — never
 * the org's current one, and never silently re-rounded (owner-fixed: no
 * conversion, snapshots rule). Mirrors catalogService's assertRepresentable.
 */
function assertRepresentable(value: string, currencyCode: string): void {
  if (!isRepresentableInCurrency(value, currencyCode)) {
    throw new InvoiceServiceError(
      `${value} is not representable in ${currencyCode} — this currency has ${minorUnitExponent(currencyCode)} decimal place(s)`,
      400, 'PRICE_NOT_REPRESENTABLE'
    );
  }
}

async function insertLineAndRecompute(
  tx: DbExecutor,
  invoiceId: string,
  orgId: string,
  spec: Omit<typeof invoiceLines.$inferInsert, 'invoiceId' | 'orgId' | 'sortOrder'>
) {
  const sortRows = await tx.select({ max: invoiceLines.sortOrder }).from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(desc(invoiceLines.sortOrder)).limit(1);
  const nextSort = (sortRows[0]?.max ?? 0) + 1;
  const [line] = await tx.insert(invoiceLines).values({ ...spec, invoiceId, orgId, sortOrder: nextSort }).returning();
  await recomputeInvoiceTotals(invoiceId, undefined, tx);
  return line!;
}

export async function addManualLine(invoiceId: string, input: ManualLineInput, actor: InvoiceActor) {
  return db.transaction(async (tx) => {
    const inv = await lockDraftInvoice(tx, invoiceId); requireInvoiceAccess(actor, inv);
    const unitPrice = Number(input.unitPrice).toFixed(2);
    const costBasis = input.costBasis != null ? Number(input.costBasis).toFixed(2) : null;
    assertRepresentable(unitPrice, inv.currencyCode);
    if (costBasis != null) assertRepresentable(costBasis, inv.currencyCode);
    const lineTotal = computeLineTotal(String(input.quantity), String(input.unitPrice), inv.currencyCode);
    return insertLineAndRecompute(tx, invoiceId, inv.orgId, {
      sourceType: 'manual', sourceId: null, catalogItemId: null, parentLineId: null, ticketId: null,
      name: input.name ?? null, description: input.description ?? null, quantity: String(input.quantity), unitPrice,
      costBasis,
      taxable: input.taxable, customerVisible: true, lineTotal, isUnapprovedTime: false
    });
  });
}

export async function addCatalogLine(invoiceId: string, catalogItemId: string, quantity: number, actor: InvoiceActor) {
  return db.transaction(async (tx) => {
    const inv = await lockDraftInvoice(tx, invoiceId); requireInvoiceAccess(actor, inv);
    // Price book in the invoice's currency (org override → catalog_item_prices),
    // never the deprecated catalog_items.unit_price mirror, never converted.
    const resolved = await resolveInvoicePrice(tx, catalogItemId, inv, actor);
    const [item] = await tx.select({ name: catalogItems.name, description: catalogItems.description, isBundle: catalogItems.isBundle }).from(catalogItems).where(eq(catalogItems.id, catalogItemId)).limit(1);
    if (item?.isBundle) throw new InvoiceServiceError('Use addBundleLine for bundles', 400, 'INVALID_STATE');
    const qty = String(quantity);
    return insertLineAndRecompute(tx, invoiceId, inv.orgId, {
      sourceType: 'catalog', sourceId: null, catalogItemId, parentLineId: null, ticketId: null,
      name: item?.name ?? 'Catalog item', description: item?.description ?? null, quantity: qty, unitPrice: resolved.unitPrice,
      // Cost is only meaningful in the line's currency: a cost stamped in another
      // currency makes the margin unavailable (no conversion), so snapshot null.
      costBasis: resolved.marginAvailable ? resolved.costBasis : null,
      taxable: resolved.taxable, customerVisible: true,
      lineTotal: computeLineTotal(qty, resolved.unitPrice, inv.currencyCode), isUnapprovedTime: false
    });
  });
}

export async function addBundleLine(invoiceId: string, bundleId: string, quantity: number, actor: InvoiceActor) {
  return db.transaction(async (tx) => {
    const inv = await lockDraftInvoice(tx, invoiceId); requireInvoiceAccess(actor, inv);
    // Economics in the INVOICE's currency on the locked tx (throws NOT_A_BUNDLE etc.).
    // The bundle's own gap and any component gap are typed 409s — a bundle is
    // never billed from a partial price book (wave 3, #3775).
    const econ = await computeBundleEconomics(bundleId, inv.currencyCode, inv.orgId, catalogActorFrom(actor), tx);
    if (econ.headlinePrice === null) {
      // Both headline gaps are typed 409s here (#3775 review #1). A legacy
      // non-representable row keeps the resolver's actionable text — telling the
      // operator to "add a price" when a wrong one already exists is a dead end.
      throw new InvoiceServiceError(
        econ.headlineGapMessage ?? `Bundle has no ${inv.currencyCode} price`,
        409,
        econ.headlineGap === 'PRICE_NOT_REPRESENTABLE' ? 'PRICE_NOT_REPRESENTABLE' : 'NO_PRICE_FOR_CURRENCY'
      );
    }
    if (!econ.priceBookComplete) {
      throw new InvoiceServiceError(
        `Bundle has no ${inv.currencyCode} price for ${econ.missingPriceComponentIds.length} component(s)`,
        409, 'PRICE_BOOK_INCOMPLETE'
      );
    }
    const [bundle] = await tx.select({ name: catalogItems.name, description: catalogItems.description }).from(catalogItems).where(eq(catalogItems.id, bundleId)).limit(1);
    const qty = String(quantity);
    const parent = await insertLineAndRecompute(tx, invoiceId, inv.orgId, {
      sourceType: 'bundle', sourceId: null, catalogItemId: bundleId, parentLineId: null, ticketId: null,
      name: bundle?.name ?? 'Bundle', description: bundle?.description ?? null, quantity: qty, unitPrice: econ.headlinePrice,
      costBasis: econ.totalCost, // null when any component's cost is in another currency (margin unavailable)
      taxable: true, customerVisible: true,
      lineTotal: computeLineTotal(qty, econ.headlinePrice, inv.currencyCode), isUnapprovedTime: false
    });
    // child component lines (unit_price 0, visibility per show_on_invoice)
    const comps = await tx.select({
      componentItemId: catalogBundleComponents.componentItemId, quantity: catalogBundleComponents.quantity,
      showOnInvoice: catalogBundleComponents.showOnInvoice, revenueAllocation: catalogBundleComponents.revenueAllocation,
      allocationCurrency: catalogBundleComponents.allocationCurrency,
      name: catalogItems.name, description: catalogItems.description,
      costBasis: catalogItems.costBasis, costCurrency: catalogItems.costCurrency
    }).from(catalogBundleComponents)
      .innerJoin(catalogItems, eq(catalogItems.id, catalogBundleComponents.componentItemId))
      .where(eq(catalogBundleComponents.bundleItemId, bundleId));
    for (const comp of comps) {
      await tx.insert(invoiceLines).values({
        invoiceId, orgId: inv.orgId, sourceType: 'bundle', sourceId: null, catalogItemId: comp.componentItemId,
        parentLineId: parent.id, ticketId: null, name: comp.name, description: comp.description ?? null, quantity: comp.quantity, unitPrice: '0.00',
        // Child cost snapshots only when stamped in the invoice's currency AND
        // representable in it (a legacy fractional-yen cost is a gap, #3775 review #4).
        costBasis: snapshotCost(comp.costBasis, comp.costCurrency, inv.currencyCode),
        // An allocation travels onto the line only when authored in the
        // invoice's currency (#3775 review #7); otherwise it is unavailable
        // (null) — never relabelled as an invoice-currency amount.
        revenueAllocation: comp.allocationCurrency === inv.currencyCode ? comp.revenueAllocation : null,
        taxable: false,
        customerVisible: comp.showOnInvoice, lineTotal: '0.00', isUnapprovedTime: false,
        sortOrder: parent.sortOrder // children sort directly under the parent
      });
    }
    await recomputeInvoiceTotals(invoiceId, undefined, tx);
    return parent;
  });
}

/**
 * Add a line sourced from a recurring contract (sub-project 3). This is an
 * internal engine helper — callers MUST supply org-scoped, engine-resolved
 * inputs (quantity computed by the contract engine, sourceId scoped to the
 * originating contract_line). Do NOT wire this directly to an HTTP endpoint.
 *
 * When catalogItemId is supplied the price, taxable flag, and costBasis are
 * authoritative from resolvePrice in the INVOICE's currency (tenant-scoped;
 * throws if inaccessible). **Price-book gap fallback (wave 3, #3775):** when the
 * catalog has no price in that currency (NO_PRICE_FOR_CURRENCY) the line is
 * billed at the CONTRACT LINE's stamped snapshot (`input.unitPrice` /
 * `input.taxable`, costBasis null) instead of failing the billing run or
 * converting. The B2 guard below has already proven that snapshot is in the
 * invoice's currency, so the fallback never crosses currencies. The gap is
 * never silent: the result carries `pricedFrom: 'contract_snapshot'` so
 * generateDueInvoice can report it (GenerateResult.priceBookGaps) and the
 * contract worker can log it. Any other CatalogServiceError still propagates.
 * On the non-catalog path the caller-supplied unitPrice and taxable are used,
 * with numeric normalization and a non-negative guard applied (reported as
 * `pricedFrom: 'contract_snapshot'` too — a non-catalog line IS its snapshot).
 * sourceId carries the originating contract_line id (already org-scoped by
 * the contract engine — no additional scoping is applied here).
 */
export type ContractLinePricedFrom = 'org_override' | 'price_book' | 'contract_snapshot';
export async function addContractLine(
  invoiceId: string,
  input: {
    description: string;
    quantity: string;        // fixed-2-decimal string
    unitPrice: string;       // fixed-2-decimal string (used on non-catalog path)
    taxable: boolean;        // used on non-catalog path
    catalogItemId?: string | null;
    sourceId?: string | null; // contract_line id
    /** The owning CONTRACT id — durable lineage (#3778). REQUIRED: a
     *  source_type='contract' line without it is a 500-worthy bug, never a
     *  silent insert, because the ACTIVE-contract restamp keys on this column. */
    contractId: string;
  },
  actor: InvoiceActor
): Promise<{ line: typeof invoiceLines.$inferSelect; pricedFrom: ContractLinePricedFrom }> {
  return db.transaction(async (tx) => {
    const inv = await lockDraftInvoice(tx, invoiceId); requireInvoiceAccess(actor, inv);

    // Wave 6 (#3778): the contract id is not optional at the service layer.
    if (!input.contractId) {
      throw new InvoiceServiceError('contractId is required for a contract-sourced line', 500, 'INVALID_STATE');
    }

    // PRODUCER SERIALIZATION (#3778): lock the PARENT CONTRACT after the invoice
    // lock and before validating/inserting, preserving the established
    // `invoice -> contract` order. Without it, a concurrent ACTIVE-contract
    // restamp could commit between this read and this insert, leaving an
    // old-currency line on a live draft that eligibility never saw.
    const [contractRow] = await tx.select({
      id: contracts.id, orgId: contracts.orgId, currencyCode: contracts.currencyCode,
    }).from(contracts).where(eq(contracts.id, input.contractId)).limit(1).for('update');
    if (!contractRow) throw new InvoiceServiceError('Contract not found', 404, 'INVALID_STATE');
    if (contractRow.orgId !== inv.orgId) {
      throw new InvoiceServiceError('Contract belongs to a different organization', 400, 'INVALID_STATE');
    }

    // B2 guard (spec §5): a contract-sourced line may only land on an invoice in
    // the SAME currency as its contract — no conversion, no silent restamp. This
    // is the source-vs-header validation for contract lines; time entries/parts
    // are asserted the same way on the locked rows in issueInvoice (wave 4, #3776).
    // Asserted against the LOCKED contract row (wave 6) rather than an unlocked
    // contract_lines join, so the stamp cannot move underneath it.
    if (contractRow.currencyCode !== inv.currencyCode) {
      throw new InvoiceServiceError(
        `Contract is in ${contractRow.currencyCode}; this invoice is in ${inv.currencyCode} — contract lines cannot cross currencies`,
        400, 'CURRENCY_MISMATCH'
      );
    }

    // Quantity is always engine-supplied (e.g. device count) — normalize but do not override.
    const quantity = String(input.quantity);

    let unitPrice: string;
    let taxable: boolean;
    let costBasis: string | null = null;
    let pricedFrom: ContractLinePricedFrom;

    if (input.catalogItemId) {
      // Catalog path: resolve price through the tenant-scoped catalog service in
      // the invoice's currency, on the locked tx. resolvePrice throws if the item
      // is not accessible to the actor's org/partner, closing the cross-tenant
      // catalog reference hole (Finding 1). A price-book GAP is not an error
      // here — see the doc-comment: bill the contract line's stamped snapshot.
      let resolved: Awaited<ReturnType<typeof resolvePrice>> | null;
      try {
        resolved = await resolvePrice(input.catalogItemId, inv.currencyCode, inv.orgId, catalogActorFrom(actor), tx);
      } catch (err) {
        // PRICE_NOT_REPRESENTABLE (legacy fractional-yen row, #3775 review #4)
        // is the same class of gap — the book is unusable in this currency —
        // so billing falls back to the contract snapshot too, never the bad row.
        if (err instanceof CatalogServiceError && (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE')) resolved = null;
        else throw err;
      }
      if (resolved) {
        unitPrice = resolved.unitPrice;
        taxable = resolved.taxable;
        costBasis = resolved.marginAvailable ? resolved.costBasis : null;
        pricedFrom = resolved.source;
      } else {
        unitPrice = Number(input.unitPrice).toFixed(2);
        assertRepresentable(unitPrice, inv.currencyCode);
        taxable = input.taxable;
        costBasis = null;
        pricedFrom = 'contract_snapshot';
      }
    } else {
      // Non-catalog path: normalize like addManualLine/updateLine (Finding 2).
      unitPrice = Number(input.unitPrice).toFixed(2);
      assertRepresentable(unitPrice, inv.currencyCode);
      taxable = input.taxable;
      pricedFrom = 'contract_snapshot';
      if (Number(quantity) < 0 || Number(unitPrice) < 0) {
        throw new InvoiceServiceError('Negative amounts not allowed', 400, 'INVALID_AMOUNT');
      }
    }

    const line = await insertLineAndRecompute(tx, invoiceId, inv.orgId, {
      sourceType: 'contract', sourceId: input.sourceId ?? null, sourceContractId: input.contractId,
      catalogItemId: input.catalogItemId ?? null,
      parentLineId: null, ticketId: null, description: input.description, quantity,
      unitPrice, costBasis, taxable, customerVisible: true,
      lineTotal: computeLineTotal(quantity, unitPrice, inv.currencyCode), isUnapprovedTime: false
    });
    return { line, pricedFrom };
  });
}

export async function updateLine(invoiceId: string, lineId: string, patch: { name?: string | null; description?: string | null; quantity?: number; unitPrice?: number; taxable?: boolean; customerVisible?: boolean }, actor: InvoiceActor) {
  return db.transaction(async (tx) => {
    const inv = await lockDraftInvoice(tx, invoiceId); requireInvoiceAccess(actor, inv);
    const [existing] = await tx.select().from(invoiceLines).where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId))).limit(1);
    if (!existing) throw new InvoiceServiceError('Line not found', 404, 'LINE_NOT_FOUND');
    const quantity = patch.quantity != null ? String(patch.quantity) : existing.quantity;
    const unitPrice = patch.unitPrice != null ? Number(patch.unitPrice).toFixed(2) : existing.unitPrice;
    if (patch.unitPrice != null) assertRepresentable(unitPrice, inv.currencyCode);
    await tx.update(invoiceLines).set({
      name: patch.name !== undefined ? patch.name : existing.name,
      description: patch.description !== undefined ? patch.description : existing.description, quantity, unitPrice,
      taxable: patch.taxable ?? existing.taxable, customerVisible: patch.customerVisible ?? existing.customerVisible,
      lineTotal: computeLineTotal(quantity, unitPrice, inv.currencyCode)
    }).where(eq(invoiceLines.id, lineId));
    await recomputeInvoiceTotals(invoiceId, undefined, tx);
    return getOwnedInvoiceOr404(invoiceId, tx);
  });
}

export async function removeLine(invoiceId: string, lineId: string, actor: InvoiceActor) {
  return db.transaction(async (tx) => {
    const inv = await lockDraftInvoice(tx, invoiceId); requireInvoiceAccess(actor, inv);
    // cascade FK removes bundle children when a parent is deleted
    await tx.delete(invoiceLines).where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId)));
    await recomputeInvoiceTotals(invoiceId, undefined, tx);
    return getOwnedInvoiceOr404(invoiceId, tx);
  });
}

export async function deleteDraftInvoice(invoiceId: string, actor: InvoiceActor) {
  return db.transaction(async (tx) => {
    const inv = await lockDraftInvoice(tx, invoiceId); requireInvoiceAccess(actor, inv);
    await tx.delete(invoices).where(eq(invoices.id, invoiceId)); // lines cascade
  });
}

/** Draft-only header edit (notes/site/dueDate/termsAndConditions). Only provided fields are written;
 *  siteId can be explicitly set to null to clear it. issue() overwrites dueDate
 *  with issueDate + partner terms, so a draft dueDate is advisory until then. */
export async function updateInvoice(
  invoiceId: string,
  patch: { notes?: string; siteId?: string | null; dueDate?: string; termsAndConditions?: string | null },
  actor: InvoiceActor
) {
  return db.transaction(async (tx) => {
    const inv = await lockDraftInvoice(tx, invoiceId);
    requireInvoiceAccess(actor, inv);
    // A site-restricted caller may not move the invoice to a site it can't access
    // (nor clear it to null, which a restricted caller can never see).
    if (patch.siteId !== undefined) requireSiteAccess(actor, patch.siteId);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.siteId !== undefined) set.siteId = patch.siteId;     // null clears it
    if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;  // date string
    if (patch.termsAndConditions !== undefined) set.termsAndConditions = patch.termsAndConditions;
    await tx.update(invoices).set(set).where(eq(invoices.id, invoiceId));
    return getOwnedInvoiceOr404(invoiceId, tx);
  });
}

/**
 * Draft-only atomic change-currency operation (multi-currency wave 2, #3774).
 * A draft's stamped currency is immutable through every other mutation path —
 * no PATCH schema admits currencyCode — so this is the ONLY way the stamp
 * moves, and only while the document is a draft. With monetary lines present
 * the change is refused (CURRENCY_LOCKED 409) unless the caller opts into
 * `clearLines`, which deletes the lines and restamps in ONE transaction, or
 * into `reprice` (wave 3, #3775), which re-resolves catalog-sourced lines from
 * the price book in the new currency. Amounts are never converted or
 * reinterpreted.
 */
export async function changeInvoiceCurrency(
  invoiceId: string,
  input: { currencyCode: string; clearLines?: boolean; reprice?: boolean },
  actor: InvoiceActor
) {
  return db.transaction(async (tx) => {
    // Invoice row lock FIRST (Task 8 lock order: invoices → invoice_lines) so a
    // concurrent issue or line write serializes against the restamp instead of
    // deadlocking or observing a half-changed draft.
    const inv = await lockDraftInvoice(tx, invoiceId);
    requireInvoiceAccess(actor, inv);
    if (inv.currencyCode === input.currencyCode) return inv; // no-op restamp

    const lineRows = await tx.select({
      id: invoiceLines.id, sourceType: invoiceLines.sourceType, catalogItemId: invoiceLines.catalogItemId,
      parentLineId: invoiceLines.parentLineId, quantity: invoiceLines.quantity,
    }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.id);
    if (lineRows.length > 0 && input.reprice) {
      // Multi-currency wave 3 (#3775): re-resolve every catalog-sourced line
      // from the price book in the NEW currency on the locked tx (invoice →
      // lines → catalog plain SELECTs). Bundle parents/children, contract,
      // time-entry, part and manual lines are NOT repriceable — their presence
      // refuses the whole operation. One gap aborts the transaction: never a
      // partial reprice, never a converted number.
      const repriceable = lineRows.filter((l) => l.sourceType === 'catalog' && l.catalogItemId !== null && l.parentLineId === null);
      const rest = lineRows.length - repriceable.length;
      if (rest > 0) {
        throw new InvoiceServiceError(`${rest} non-catalog line(s) cannot be repriced — pass clearLines instead`, 409, 'CURRENCY_LOCKED');
      }
      const target = { currencyCode: input.currencyCode, orgId: inv.orgId };
      for (const line of repriceable) {
        const resolved = await resolveInvoicePrice(tx, line.catalogItemId!, target, actor);
        await tx.update(invoiceLines).set({
          unitPrice: resolved.unitPrice,
          lineTotal: computeLineTotal(line.quantity, resolved.unitPrice, input.currencyCode),
          // Cost is only meaningful in the line's currency (no conversion).
          costBasis: resolved.marginAvailable ? resolved.costBasis : null,
        }).where(eq(invoiceLines.id, line.id));
      }
      // Header restamp first so the recompute rounds in the NEW currency, then
      // sum the repriced lines (the [] shortcut below is only valid line-less).
      await tx.update(invoices).set({ currencyCode: input.currencyCode, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
      await recomputeInvoiceTotals(invoiceId, undefined, tx);
      return getOwnedInvoiceOr404(invoiceId, tx);
    }
    if (lineRows.length > 0) {
      if (!input.clearLines) {
        throw new InvoiceServiceError(
          `Invoice has ${lineRows.length} line(s) priced in ${inv.currencyCode} — pass clearLines to remove them, or delete the draft`,
          409, 'CURRENCY_LOCKED'
        );
      }
      // Clear-and-restamp. Draft gathering never flips source billing_status
      // (time entries/parts stay 'not_billed' until issueInvoice flips them),
      // so a draft holds no billed claim and there is nothing to release here.
      // Deliberately NOT mirroring voidInvoice's unconditional reset: another
      // invoice may have legitimately billed these sources since this draft
      // gathered them, and resetting would corrupt that claim (#3774 addendum).
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    }

    // Lines are guaranteed gone (or never existed): totals recompute to zero,
    // rounded in the NEW currency. The draft-time taxRate snapshot is kept.
    const totals = computeInvoiceTotals([], inv.taxRate, input.currencyCode);
    const balance = fromCents(toCents(totals.total) - toCents(inv.amountPaid));
    const [updated] = await tx.update(invoices).set({
      currencyCode: input.currencyCode,
      subtotal: totals.subtotal, taxTotal: totals.taxTotal, total: totals.total, balance,
      updatedAt: new Date(),
    }).where(eq(invoices.id, invoiceId)).returning();
    return updated!;
  });
}

/**
 * Due-date carve-out (deposit spec): the ONE field editable on an ISSUED invoice.
 * Due date is scheduling metadata, not signed financial content — the immutability
 * rule (billing-v1.1 roadmap) covers money/lines, which stay locked. Status is
 * re-derived so pushing the date out un-flags a premature 'overdue'.
 */
export async function updateIssuedDueDate(invoiceId: string, dueDate: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireInvoiceAccess(actor, inv);
  if (!['sent', 'partially_paid', 'overdue'].includes(inv.status)) {
    throw new InvoiceServiceError('Due date can only be changed on an open issued invoice', 409, 'INVALID_STATE');
  }
  const oldDueDate = inv.dueDate;
  await db.update(invoices).set({ dueDate, updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
  await recomputeInvoiceStatus(invoiceId); // overdue ↔ partially_paid/sent keys off due date
  const updated = await getOwnedInvoiceOr404(invoiceId);
  return { invoice: updated, audit: { orgId: inv.orgId, invoiceId, oldDueDate, newDueDate: dueDate } };
}

export interface InvoiceAccountingSync {
  provider: 'quickbooks';
  syncStatus: MappingSyncStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  remoteDocNumber: string | null;
}

/**
 * QuickBooks push status for this invoice's `accounting_entity_mappings` row
 * (Phase C, Task 5). `accounting_entity_mappings` is a partner-axis (shape 3)
 * RLS table — this is a plain read through the ambient `db` (the caller's
 * request-scoped context), so it deliberately does NOT escalate to a system
 * context: an org-scoped token has no partner access and the read returns no
 * rows, which this function reports as `null` (fail closed) with no special-
 * casing needed. The join to `accounting_connections` scopes the mapping to
 * THIS partner's QuickBooks connection (never another provider/partner's row
 * with a colliding breezeEntityId, which the schema's uniqueness constraints
 * make impossible anyway, but the join keeps the read self-contained).
 */
async function getInvoiceAccountingSync(invoiceId: string, partnerId: string): Promise<InvoiceAccountingSync | null> {
  const rows = await db
    .select({
      syncStatus: accountingEntityMappings.syncStatus,
      lastSyncedAt: accountingEntityMappings.lastSyncedAt,
      lastError: accountingEntityMappings.lastError,
      remoteDocNumber: accountingEntityMappings.remoteDocNumber,
    })
    .from(accountingEntityMappings)
    .innerJoin(accountingConnections, and(
      eq(accountingConnections.id, accountingEntityMappings.integrationId),
      eq(accountingConnections.partnerId, partnerId),
      eq(accountingConnections.provider, 'quickbooks'),
    ))
    .where(and(
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'invoice'),
      eq(accountingEntityMappings.breezeEntityId, invoiceId),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    provider: 'quickbooks',
    syncStatus: row.syncStatus as MappingSyncStatus,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastError: row.lastError,
    remoteDocNumber: row.remoteDocNumber,
  };
}

export async function getInvoice(invoiceId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); requireInvoiceAccess(actor, inv);
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder);
  // Whether this invoice's partner can collect online (gates the "Send payment
  // link" UI). Partner-axis read under a partner/system request scope, so the
  // actor's own connection row is RLS-visible. Best-effort: a lookup failure
  // (e.g. Stripe unconfigured) just means "not connected".
  const conn = await getConnection(inv.partnerId).catch(() => null);
  const connected = conn?.status === 'connected';
  // Best-effort, same fail-closed rationale as the Stripe lookup above: a
  // lookup failure (e.g. no accounting connection row) must never fail the
  // whole invoice detail load.
  const accountingSync = await getInvoiceAccountingSync(invoiceId, inv.partnerId).catch(() => null);
  // Multi-currency (#3777, spec §10): surface the CACHED account currency and a
  // warn-don't-block mismatch so the detail page can flag the FX spread before
  // the partner sends a pay link. Cached columns only — no Stripe call here.
  return {
    invoice: inv, lines, stripeConnected: connected, // accounting view (all lines)
    stripeAccountCurrency: connected ? conn.defaultCurrency ?? null : null,
    currencyWarning: connected ? buildStripeCurrencyWarning(inv.currencyCode, conn.defaultCurrency) : null,
    accountingSync,
  };
}

export type CustomerInvoiceLine = {
  /**
   * Line title, mirroring invoice_lines.name (#3319). NULL for legacy lines
   * created before the name/description split, where `description` holds the
   * title — the portal renders `name ?? description` as the title and shows
   * `description` as a sub-line only when `name` is set, exactly like
   * invoicePdf's lineTitle/lineBlurb.
   */
  name: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  lineTotal: string;
};

type InvoiceRow = typeof invoices.$inferSelect;

export type CustomerInvoiceHeader = Pick<InvoiceRow,
  | 'id'
  | 'invoiceNumber'
  | 'status'
  | 'currencyCode'
  | 'issueDate'
  | 'dueDate'
  | 'subtotal'
  | 'taxRate'
  | 'taxTotal'
  | 'total'
  | 'amountPaid'
  | 'balance'
  | 'depositDue'
  | 'billToName'
  | 'notes'
  | 'sellerSnapshot'
  | 'termsAndConditions'
>;

type CustomerInvoiceLineSource = {
  name?: string | null;
  description?: string | null;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  lineTotal: string;
};

/** Explicit serialization boundary: never spread an invoice_lines row here. */
export function toCustomerInvoiceLine(line: CustomerInvoiceLineSource): CustomerInvoiceLine {
  return {
    // Carry BOTH fields (#3319). This previously collapsed to
    // `description ?? name`, which is the INVERSE of the fallback every other
    // renderer uses, so a line with both set showed the customer only the
    // blurb and never the title.
    name: line.name ?? null,
    description: line.description ?? '',
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxable: line.taxable,
    lineTotal: line.lineTotal,
  };
}

/** Explicit portal serialization boundary: never spread an invoices row here. */
export function toCustomerInvoiceHeader(invoice: InvoiceRow): CustomerInvoiceHeader {
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    currencyCode: invoice.currencyCode,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    subtotal: invoice.subtotal,
    taxRate: invoice.taxRate,
    taxTotal: invoice.taxTotal,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    balance: invoice.balance,
    depositDue: invoice.depositDue,
    billToName: invoice.billToName,
    notes: invoice.notes,
    sellerSnapshot: invoice.sellerSnapshot,
    termsAndConditions: invoice.termsAndConditions,
  };
}

export async function getCustomerInvoice(
  invoiceId: string,
  orgId?: string
): Promise<{ invoice: CustomerInvoiceHeader; lines: CustomerInvoiceLine[]; partnerId: string }> {
  const inv = await getOwnedInvoiceOr404(invoiceId); // RLS scopes; portal context supplies org access
  // App-layer org guard (defense-in-depth over RLS). 404, not 403 — don't leak existence to the portal.
  if (orgId !== undefined && inv.orgId !== orgId) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  const rows = await db.select({
    name: invoiceLines.name,
    description: invoiceLines.description,
    quantity: invoiceLines.quantity,
    unitPrice: invoiceLines.unitPrice,
    taxable: invoiceLines.taxable,
    lineTotal: invoiceLines.lineTotal,
  }).from(invoiceLines).where(and(eq(invoiceLines.invoiceId, invoiceId), eq(invoiceLines.customerVisible, true))).orderBy(invoiceLines.sortOrder);
  const lines = rows.map(toCustomerInvoiceLine);
  // partnerId rides OUTSIDE the serialized header: the portal route needs it
  // for the partner-name branding lookup, but CustomerInvoiceHeader is the
  // customer payload and internal ids stay out of it. Reading it off the
  // header (`result.invoice.partnerId`) compiled as `undefined` and made
  // every portal invoice-detail request 500 in the partners query.
  return { invoice: toCustomerInvoiceHeader(inv), lines, partnerId: inv.partnerId };
}

export async function listInvoices(query: { orgId?: string; status?: string; limit: number; cursor?: string }, actor: InvoiceActor) {
  const conds = [] as Array<ReturnType<typeof eq>>;
  if (query.orgId) { requireOrgAccess(actor, query.orgId); conds.push(eq(invoices.orgId, query.orgId)); }
  if (query.status) conds.push(eq(invoices.status, query.status as never));
  // Site-restricted callers only see invoices assigned to a site in their allowlist.
  // `siteId IN (...)` is false for NULL, so null-site (org-level) invoices are
  // excluded — consistent with requireSiteAccess denying a restricted caller a null site.
  if (actor.allowedSiteIds) conds.push(inArray(invoices.siteId, actor.allowedSiteIds) as ReturnType<typeof eq>);
  // Deterministic keyset: order by (createdAt, id) desc. The cursor is the last
  // row's id; resolve its createdAt and filter (createdAt, id) < (cursorCreatedAt, cursorId).
  if (query.cursor) {
    const [c] = await db.select({ createdAt: invoices.createdAt }).from(invoices).where(eq(invoices.id, query.cursor)).limit(1);
    if (c) {
      conds.push(or(
        lt(invoices.createdAt, c.createdAt),
        and(eq(invoices.createdAt, c.createdAt), lt(invoices.id, query.cursor))
      ) as ReturnType<typeof eq>);
    }
  }
  const rows = await db.select().from(invoices).where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(invoices.createdAt), desc(invoices.id)).limit(query.limit);
  return rows;
}

// ---------------------------------------------------------------------------
// Billing settings (Task 6.3): partner-level invoice config + per-org tax/address.
// Only provided fields are written; `null` explicitly clears a nullable column.
// ---------------------------------------------------------------------------

export async function updatePartnerBillingSettings(
  patch: {
    currencyCode: string; defaultTaxRate?: number | null; invoiceNumberPrefix: string;
    invoiceTermsDays: number; defaultMarkupPercent?: number | null; autoTaxHardware?: boolean;
    autoEmailInvoiceOnQuoteAccept?: boolean;
    catalogAiStyle?: string | null;
    invoiceFooter?: string | null;
    documentTheme?: 'classic' | 'condensed'; documentPageSize?: 'letter' | 'a4';
    billingCompanyName?: string | null; billingPhone?: string | null; billingWebsite?: string | null;
    billingAddressLine1?: string | null; billingAddressLine2?: string | null; billingAddressCity?: string | null;
    billingAddressRegion?: string | null; billingAddressPostalCode?: string | null; billingAddressCountry?: string | null;
    billingTermsAndConditions?: string | null;
  },
  actor: InvoiceActor
) {
  const partnerId = requirePartner(actor);
  const set: Record<string, unknown> = {
    currencyCode: patch.currencyCode,
    invoiceNumberPrefix: patch.invoiceNumberPrefix,
    invoiceTermsDays: patch.invoiceTermsDays,
  };
  // Numeric columns take fixed-string values; null clears the optional rate/footer.
  if (patch.defaultTaxRate !== undefined) {
    set.defaultTaxRate = patch.defaultTaxRate === null ? null : Number(patch.defaultTaxRate).toFixed(5);
  }
  if (patch.defaultMarkupPercent !== undefined) {
    set.defaultMarkupPercent = patch.defaultMarkupPercent === null ? null : Number(patch.defaultMarkupPercent).toFixed(2);
  }
  if (patch.autoTaxHardware !== undefined) set.autoTaxHardware = patch.autoTaxHardware;
  if (patch.autoEmailInvoiceOnQuoteAccept !== undefined) set.autoEmailInvoiceOnQuoteAccept = patch.autoEmailInvoiceOnQuoteAccept;
  if (patch.catalogAiStyle !== undefined) set.catalogAiStyle = patch.catalogAiStyle?.trim() || null;
  if (patch.invoiceFooter !== undefined) set.invoiceFooter = patch.invoiceFooter;
  if (patch.documentTheme !== undefined) set.documentTheme = patch.documentTheme;
  if (patch.documentPageSize !== undefined) set.documentPageSize = patch.documentPageSize;
  for (const key of [
    'billingCompanyName', 'billingPhone', 'billingWebsite', 'billingAddressLine1', 'billingAddressLine2',
    'billingAddressCity', 'billingAddressRegion', 'billingAddressPostalCode', 'billingAddressCountry',
    'billingTermsAndConditions',
  ] as const) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
  const [row] = await db.update(partners).set(set).where(eq(partners.id, partnerId)).returning({
    currencyCode: partners.currencyCode, defaultTaxRate: partners.defaultTaxRate,
    invoiceNumberPrefix: partners.invoiceNumberPrefix, invoiceTermsDays: partners.invoiceTermsDays,
    defaultMarkupPercent: partners.defaultMarkupPercent, autoTaxHardware: partners.autoTaxHardware,
    autoEmailInvoiceOnQuoteAccept: partners.autoEmailInvoiceOnQuoteAccept,
    catalogAiStyle: partners.catalogAiStyle, invoiceFooter: partners.invoiceFooter,
    documentTheme: partners.documentTheme, documentPageSize: partners.documentPageSize,
  });
  if (!row) throw new InvoiceServiceError('Partner could not be resolved', 400, 'PARTNER_UNRESOLVABLE');
  return row;
}

/** Org billing-settings projection. `currencyCode` is included (#3778) so the
 *  web form reads the org's currency back from the same response it PATCHes. */
const orgBillingProjection = () => ({
  id: organizations.id, taxId: organizations.taxId, taxExempt: organizations.taxExempt, taxRate: organizations.taxRate,
  billingContact: organizations.billingContact,
  billingAddressLine1: organizations.billingAddressLine1, billingAddressLine2: organizations.billingAddressLine2,
  billingAddressCity: organizations.billingAddressCity, billingAddressRegion: organizations.billingAddressRegion,
  billingAddressPostalCode: organizations.billingAddressPostalCode, billingAddressCountry: organizations.billingAddressCountry,
  currencyCode: organizations.currencyCode,
});

export async function updateOrgBillingSettings(
  orgId: string,
  patch: {
    taxId?: string | null; taxExempt?: boolean; taxRate?: number | null;
    billingContactEmail?: string | null; billingContactName?: string | null;
    billingAddressLine1?: string | null; billingAddressLine2?: string | null;
    billingAddressCity?: string | null; billingAddressRegion?: string | null;
    billingAddressPostalCode?: string | null; billingAddressCountry?: string | null;
    // Multi-currency wave 6 (#3778): the currency branch is delegated wholesale
    // to orgCurrencyService (org row FOR UPDATE, optimistic precondition,
    // explicit confirmation). See the currency-only rule below.
    currencyCode?: string; expectedCurrentCurrencyCode?: string; confirmSnapshotRetention?: boolean;
  },
  actor: InvoiceActor
) {
  requireOrgAccess(actor, orgId);
  // --- currency branch (#3778) -------------------------------------------
  // A currency-carrying PATCH is deliberately currency-ONLY. The contact-merge
  // path below opens its own transaction whose first statement is a plain
  // `SELECT id`; combining it with the currency change would either put the org
  // `FOR UPDATE` behind that read (breaking the wave-6 lock order, which
  // requires the organizations lock to be the FIRST statement of its
  // transaction) or split one request across two transactions with a partial
  // success. The plan sanctions this fallback explicitly (Task 11, Step 5) and
  // the wave-6 UI sends a currency-only payload, so nothing legitimate is lost.
  if (patch.currencyCode !== undefined) {
    const CURRENCY_KEYS = ['currencyCode', 'expectedCurrentCurrencyCode', 'confirmSnapshotRetention'];
    const others = Object.entries(patch)
      .filter(([k, v]) => v !== undefined && !CURRENCY_KEYS.includes(k))
      .map(([k]) => k);
    if (others.length > 0) {
      throw new InvoiceServiceError(
        `A currency change must be sent on its own (also received: ${others.join(', ')})`,
        400, 'INVALID_STATE'
      );
    }
    if (patch.expectedCurrentCurrencyCode === undefined) {
      throw new InvoiceServiceError('expectedCurrentCurrencyCode is required when currencyCode is supplied', 400, 'INVALID_STATE');
    }
    const change = await changeOrgCurrency(orgId, {
      currencyCode: patch.currencyCode,
      expectedCurrentCurrencyCode: patch.expectedCurrentCurrencyCode,
      confirmSnapshotRetention: patch.confirmSnapshotRetention
    }, actor);
    const [current] = await db.select(orgBillingProjection()).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!current) throw new InvoiceServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    return { ...current, currencyChange: change };
  }

  const set: Record<string, unknown> = {};
  if (patch.taxId !== undefined) set.taxId = patch.taxId;
  if (patch.taxExempt !== undefined) set.taxExempt = patch.taxExempt;
  if (patch.taxRate !== undefined) set.taxRate = patch.taxRate === null ? null : Number(patch.taxRate).toFixed(5);
  // billingContact is a jsonb bag other importers (e.g. QuickBooks) also write.
  // It is written by the contacts compat service rather than here (#3258), so
  // the `contacts` row stays in step with the blob. `mergeBillingContact` keeps
  // the same atomic `COALESCE(...) || ...::jsonb` this code used before: we
  // never drop keys we don't model here AND never lose a concurrent writer's
  // key to a read-modify-write race. Only built when a contact field is in the
  // patch.
  const contactPatch: ContactBlob = {};
  if (patch.billingContactEmail !== undefined) contactPatch.email = patch.billingContactEmail;
  if (patch.billingContactName !== undefined) contactPatch.name = patch.billingContactName;
  if (patch.billingAddressLine1 !== undefined) set.billingAddressLine1 = patch.billingAddressLine1;
  if (patch.billingAddressLine2 !== undefined) set.billingAddressLine2 = patch.billingAddressLine2;
  if (patch.billingAddressCity !== undefined) set.billingAddressCity = patch.billingAddressCity;
  if (patch.billingAddressRegion !== undefined) set.billingAddressRegion = patch.billingAddressRegion;
  if (patch.billingAddressPostalCode !== undefined) set.billingAddressPostalCode = patch.billingAddressPostalCode;
  if (patch.billingAddressCountry !== undefined) set.billingAddressCountry = patch.billingAddressCountry;
  const projection = orgBillingProjection();

  // One transaction so the contact merge and the column update still land
  // together, as they did when this was a single statement.
  const row = await db.transaction(async (tx) => {
    if (Object.keys(contactPatch).length > 0) {
      // Existence check, scoped to the contact path ONLY. The merge inserts a
      // `contacts` row for the org, so an unknown orgId would raise an FK
      // violation where this endpoint has always returned a clean 404. It does
      // NOT reintroduce a read-modify-write race: it selects `id`, never
      // `billing_contact`, and the merge value below is still computed by
      // Postgres via `||`. A patch with no contact field does no read at all,
      // exactly as before.
      const [exists] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      if (!exists) return undefined;

      // Merged FIRST so the projection below observes the merged blob —
      // OrgBillingSettings.tsx renders straight from this response.
      await mergeBillingContact(tx, orgId, contactPatch, actor.userId ?? null);
    }

    // `set` is empty only when the patch carried ONLY contact fields, and
    // drizzle rejects `.set({})` — read the same projection back instead.
    if (Object.keys(set).length === 0) {
      const [r] = await tx.select(projection).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      return r;
    }
    const [r] = await tx.update(organizations).set(set).where(eq(organizations.id, orgId)).returning(projection);
    return r;
  });
  if (!row) throw new InvoiceServiceError('Organization not found', 404, 'INVOICE_NOT_FOUND');
  return row;
}

// ---------------------------------------------------------------------------
// Assembly: materialize draft lines from unbilled source rows (Task 3.5)
// ---------------------------------------------------------------------------

async function materializeLines(invoiceId: string, orgId: string, specs: DraftLineSpec[]): Promise<void> {
  if (specs.length === 0) return;
  let sort = 0;
  await db.insert(invoiceLines).values(specs.map((s) => ({
    invoiceId, orgId, sourceType: s.sourceType, sourceId: s.sourceId, catalogItemId: s.catalogItemId,
    parentLineId: null, ticketId: s.ticketId, description: s.description, quantity: s.quantity,
    unitPrice: s.unitPrice, costBasis: s.costBasis, taxable: s.taxable, customerVisible: s.customerVisible,
    lineTotal: s.lineTotal, isUnapprovedTime: s.isUnapprovedTime, sortOrder: sort++
  })));
}

/** One blocked group on an assembly response: unbilled work snapshotted in a
 *  currency other than the draft header's (multi-currency wave 4, #3776). */
export interface BlockedCurrencySummary { currencyCode: string; count: number; amount: string }

/** Count + sum the blocked specs per currency, rounded at THAT currency's minor
 *  unit. The defensive `UNKNOWN` key (null snapshot — impossible while the DB
 *  CHECK holds) is summed at the 2-decimal exponent via 'USD'. */
export function summarizeBlocked(blocked: Record<string, DraftLineSpec[]>): BlockedCurrencySummary[] {
  return Object.entries(blocked).map(([currencyCode, specs]) => ({
    currencyCode,
    count: specs.length,
    amount: roundToCurrency(
      specs.reduce((sum, sp) => sum + Number(sp.lineTotal), 0),
      currencyCode === 'UNKNOWN' ? 'USD' : currencyCode
    )
  }));
}

/** One time entry on an assembly response that is billable but has no hourly
 *  rate (review #1, #3776). Never materialized — it would bill at zero and be
 *  marked billed. Set a rate on the entry and assemble again. */
export interface MissingRateEntry { timeEntryId: string; ticketId: string | null; description: string; hours: string }

export function summarizeMissingRate(missing: MissingRateSpec[]): MissingRateEntry[] {
  return missing.map((m) => ({ timeEntryId: m.sourceId, ticketId: m.ticketId, description: m.description, hours: m.quantity }));
}

/** Shared tail of both assembly paths: materialize only the header-currency
 *  specs; on an empty `included` delete the transient draft and explain WHY
 *  (blocked groups → ALL_BLOCKED_BY_CURRENCY with details; only rate-less time
 *  → ALL_MISSING_RATE with the entries; nothing at all → NOTHING_TO_INVOICE).
 *  Never converts, never silently drops a blocked row, never bills a NULL rate
 *  as zero. */
async function finishAssembly(
  inv: { id: string; orgId: string; currencyCode: string },
  gathered: AssemblyResult,
  nothingMessage: string,
  actor: InvoiceActor
) {
  const blockedByCurrency = summarizeBlocked(gathered.blockedByCurrency);
  const missingRate = summarizeMissingRate(gathered.missingRate);
  if (gathered.included.length === 0) {
    await db.delete(invoices).where(eq(invoices.id, inv.id));
    if (blockedByCurrency.length > 0) {
      throw new InvoiceServiceError(
        `All unbilled work is in ${blockedByCurrency.map((b) => b.currencyCode).join(', ')}; this draft is in ${inv.currencyCode} — assemble a draft in that currency instead`,
        409, 'ALL_BLOCKED_BY_CURRENCY', { blockedByCurrency, missingRate }
      );
    }
    if (missingRate.length > 0) {
      throw new InvoiceServiceError(
        `${missingRate.length} billable time ${missingRate.length === 1 ? 'entry has' : 'entries have'} no hourly rate in ${inv.currencyCode} — set a rate on ${missingRate.length === 1 ? 'it' : 'them'} and assemble again`,
        409, 'ALL_MISSING_RATE', { missingRate }
      );
    }
    throw new InvoiceServiceError(nothingMessage, 409, 'NOTHING_TO_INVOICE');
  }
  await materializeLines(inv.id, inv.orgId, gathered.included);
  await recomputeInvoiceTotals(inv.id);
  return { ...(await getInvoice(inv.id, actor)), blockedByCurrency, missingRate };
}

export async function assembleDraftFromOrg(
  input: { orgId: string; siteId?: string; from: string; to: string; currencyCode?: string },
  actor: InvoiceActor
) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, input.orgId);
  requireSiteAccess(actor, input.siteId ?? null);
  const from = new Date(input.from + 'T00:00:00Z');
  const to = new Date(input.to + 'T23:59:59Z');
  // Create the draft FIRST so the gathered line totals are rounded in the
  // invoice row's actual currency (JPY drafts must not persist cent-fraction
  // line totals). On an empty gather the transient draft is deleted again.
  // Header currency: the org's current currency (spec §5), or an explicit
  // override so pre-change billables (snapshotted in the org's OLD currency)
  // stay invoiceable (spec §7). Never a conversion — rows in any other currency
  // are returned under `blockedByCurrency`. The default read takes the org
  // SHARE barrier so the stamp cannot lose a race with changeOrgCurrency (#3778).
  const [inv] = await db.transaction(async (tx) => {
    const org = await lockOrgStampingDefaults(tx, input.orgId);
    const currencyCode = input.currencyCode ?? org.currencyCode;
    return tx.insert(invoices).values({ partnerId, orgId: input.orgId, siteId: input.siteId ?? null, status: 'draft', currencyCode, createdBy: actor.userId }).returning();
  });
  const gathered = mergeAssembly(
    await gatherOrgTimeEntries(input.orgId, from, to, inv!.currencyCode),
    await gatherOrgParts(input.orgId, from, to, inv!.currencyCode)
  );
  return finishAssembly(inv!, gathered, 'No unbilled billable work in range', actor);
}

export async function assembleDraftFromTicket(ticketId: string, actor: InvoiceActor, opts: { currencyCode?: string } = {}) {
  const partnerId = requirePartner(actor);
  const [tk] = await db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!tk) throw new InvoiceServiceError('Ticket not found', 404, 'INVOICE_NOT_FOUND');
  requireOrgAccess(actor, tk.orgId);
  // This path produces an org-level (null-site) invoice; a site-restricted caller
  // can never see such a row, so deny it up front rather than orphan an invoice.
  requireSiteAccess(actor, null);
  // Draft first: gathered line totals must round in the invoice row's actual
  // currency (see assembleDraftFromOrg). Empty gathers delete the transient draft.
  // Ticket org's currency (spec §5) or the explicit old-currency override (spec §7),
  // read under the org SHARE barrier (#3778).
  const [inv] = await db.transaction(async (tx) => {
    const org = await lockOrgStampingDefaults(tx, tk.orgId);
    const currencyCode = opts.currencyCode ?? org.currencyCode;
    return tx.insert(invoices).values({ partnerId, orgId: tk.orgId, status: 'draft', currencyCode, createdBy: actor.userId }).returning();
  });
  const gathered = await gatherTicketBillables(ticketId, inv!.currencyCode);
  return finishAssembly(inv!, gathered, 'Nothing billable on this ticket', actor);
}

// ---------------------------------------------------------------------------
// Issue: numbering, double-bill guard, freeze, snapshot, source flip (Task 3.6)
// ---------------------------------------------------------------------------

export async function issueInvoice(invoiceId: string, actor: InvoiceActor) {
  // Fast-fail pre-checks only. NOT authoritative: everything is re-checked on
  // the LOCKED row inside the system transaction below (B10) — this read runs
  // under the caller's RLS scope purely to 404/409 cheaply before opening a
  // system tx.
  const pre = await getOwnedInvoiceOr404(invoiceId);
  assertDraft(pre);
  requireInvoiceAccess(actor, pre);

  // Everything below runs in ONE system transaction (withSystemDbAccessContext
  // wraps its callback in baseDb.transaction — db/index.ts). Lock order is the
  // repo-wide invoice contract (see lockDraftInvoice): invoices row → invoice
  // lines → source rows (contracts before contract_lines, then time_entries,
  // then ticket_parts, each deduplicated + ORDER BY id). ALL validation happens
  // on the locked rows; the gapless counter upsert, the number/snapshot write,
  // and the source-row flips are atomic with it — a failed issue rolls the
  // counter back too (no committed gap). We inline the counter upsert rather
  // than calling allocateInvoiceCounter() — that helper does its own
  // runOutsideDbContext, which would exit THIS transaction and break atomicity.
  const issueTx = () => runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    // 1. Invoice row lock. Recheck draft state and re-run actor authorization
    //    against the LOCKED row — the system tx bypasses RLS, so the pre-tx
    //    check above is a fast-fail only, not authoritative.
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
    if (!inv) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
    assertDraft(inv); // a concurrent issue that won the lock leaves 'sent' → NOT_A_DRAFT
    requireInvoiceAccess(actor, inv);

    // 2. Lock the lines. ONLY these locked rows feed source-id collection AND
    //    totals — a pre-tx snapshot would let a line added/removed mid-flight
    //    desync the frozen totals from the flipped sources.
    const lines = await db.select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.id).for('update');
    if (!lines.some((l) => l.customerVisible)) throw new InvoiceServiceError('Invoice has no customer-visible lines', 409, 'NO_VISIBLE_LINES');
    const sourceIds = (type: string) => [...new Set(
      lines.filter((l) => l.sourceType === type && l.sourceId).map((l) => l.sourceId!)
    )].sort();
    const timeIds = sourceIds('time_entry');
    const partIds = sourceIds('part');
    const contractLineIds = sourceIds('contract');

    // 3. Lock ALL referenced source rows with NO billing-status filter (the old
    //    guard's inverted predicate locked nothing when rows were not_billed),
    //    then validate on the locked rows.
    if (contractLineIds.length) {
      // Parent contracts lock BEFORE contract_lines (repo lock order). The
      //  unlocked discovery read only maps line → contract; membership is
      //  re-verified on the locked rows below.
      const discovered = await db.select({ contractId: contractLines.contractId })
        .from(contractLines).where(inArray(contractLines.id, contractLineIds));
      const contractIds = [...new Set(discovered.map((r) => r.contractId))].sort();
      const lockedContracts = contractIds.length
        ? await db.select({ id: contracts.id, orgId: contracts.orgId, currencyCode: contracts.currencyCode })
            .from(contracts).where(inArray(contracts.id, contractIds)).orderBy(contracts.id).for('update')
        : [];
      const contractById = new Map(lockedContracts.map((c) => [c.id, c]));
      const lockedContractLines = await db.select({ id: contractLines.id, contractId: contractLines.contractId })
        .from(contractLines).where(inArray(contractLines.id, contractLineIds)).orderBy(contractLines.id).for('update');
      const contractLineById = new Map(lockedContractLines.map((l) => [l.id, l]));
      for (const id of contractLineIds) {
        const cl = contractLineById.get(id);
        const parent = cl ? contractById.get(cl.contractId) : undefined;
        if (!cl || !parent || parent.orgId !== inv.orgId) {
          throw new InvoiceServiceError(`Contract line ${id} no longer exists for this organization`, 409, 'SOURCE_NOT_FOUND');
        }
        // B2 under lock: the contract's currency must match the header.
        if (parent.currencyCode !== inv.currencyCode) {
          throw new InvoiceServiceError(
            `Contract is in ${parent.currencyCode}; this invoice is in ${inv.currencyCode} — contract lines cannot cross currencies`,
            400, 'CURRENCY_MISMATCH'
          );
        }
      }
    }
    const validateBillable = (
      label: string, ids: string[],
      locked: Array<{ id: string; orgId: string | null; billingStatus: string; currencyCode: string | null }>
    ) => {
      const byId = new Map(locked.map((r) => [r.id, r]));
      const missing = ids.filter((id) => byId.get(id)?.orgId !== inv.orgId);
      if (missing.length) {
        throw new InvoiceServiceError(`${label} no longer exist for this organization: ${missing.join(', ')}`, 409, 'SOURCE_NOT_FOUND');
      }
      const billed = ids.filter((id) => byId.get(id)!.billingStatus !== 'not_billed');
      if (billed.length) {
        throw new InvoiceServiceError(`${label} already billed: ${billed.join(', ')}`, 409, 'SOURCE_ALREADY_BILLED');
      }
      const foreign = ids.filter((id) => byId.get(id)!.currencyCode !== inv.currencyCode);
      if (foreign.length) {
        const codes = [...new Set(foreign.map((id) => byId.get(id)!.currencyCode ?? 'no currency'))].join(', ');
        throw new InvoiceServiceError(
          `${label} are in ${codes}; this invoice is in ${inv.currencyCode} — lines cannot cross currencies`,
          400, 'CURRENCY_MISMATCH'
        );
      }
    };
    if (timeIds.length) {
      validateBillable('Time entries', timeIds, await db
        .select({ id: timeEntries.id, orgId: timeEntries.orgId, billingStatus: timeEntries.billingStatus, currencyCode: timeEntries.currencyCode })
        .from(timeEntries).where(inArray(timeEntries.id, timeIds)).orderBy(timeEntries.id).for('update'));
    }
    if (partIds.length) {
      validateBillable('Parts', partIds, await db
        .select({ id: ticketParts.id, orgId: ticketParts.orgId, billingStatus: ticketParts.billingStatus, currencyCode: ticketParts.currencyCode })
        .from(ticketParts).where(inArray(ticketParts.id, partIds)).orderBy(ticketParts.id).for('update'));
    }
    // Source-vs-header currency is asserted in validateBillable on the LOCKED rows (wave 4, #3776).

    // 4. Snapshot inputs, totals from the LOCKED lines, number allocation LAST
    //    before the guarded write.
    const [org] = await db.select().from(organizations).where(eq(organizations.id, inv.orgId)).limit(1);
    const [partner] = await db.select().from(partners).where(eq(partners.id, inv.partnerId)).limit(1);
    const taxRate = resolveEffectiveTaxRate({ taxExempt: org?.taxExempt ?? false, orgRate: org?.taxRate ?? null, partnerRate: partner?.defaultTaxRate ?? null });
    const issueDate = new Date();
    const dueDate = new Date(issueDate.getTime() + (partner?.invoiceTermsDays ?? 30) * 86400000);
    const year = issueDate.getUTCFullYear();

    const { subtotal, taxTotal, total } = computeInvoiceTotals(lines, taxRate, inv.currencyCode);
    const billToAddress = buildBillToAddress(org);

    // Gapless-safe counter allocation, atomic with the rest of this transaction.
    const counterRows = await db.execute(sql`
      INSERT INTO partner_invoice_sequences (partner_id, year, counter)
      VALUES (${inv.partnerId}, ${year}, 1)
      ON CONFLICT (partner_id, year)
      DO UPDATE SET counter = partner_invoice_sequences.counter + 1
      RETURNING counter
    `);
    const counter = Number((counterRows as unknown as Array<{ counter: number }>)[0]?.counter);
    if (!Number.isFinite(counter) || counter < 1) throw new InvoiceServiceError('Failed to allocate invoice number', 500, 'NUMBER_ALLOCATION_FAILED');
    const number = formatInvoiceNumber(partner?.invoiceNumberPrefix ?? 'INV', year, counter);

    const updated = await db.update(invoices).set({
      // status 'sent' is the lifecycle "issued/finalized" state. sentAt is left
      // NULL here on purpose — it means "emailed to the customer" and is stamped
      // only by sendInvoiceEmail. That lets the UI distinguish "Issued" (no email
      // yet) from "Sent" (emailed) instead of mislabeling a plain Issue as Sent.
      // currencyCode is deliberately NOT written here (B1): the draft's stamped
      // header currency is a snapshot and must survive issue verbatim — totals
      // above are already rounded with inv.currencyCode, so header and totals agree.
      status: 'sent', invoiceNumber: number,
      issueDate: issueDate.toISOString().slice(0, 10), dueDate: dueDate.toISOString().slice(0, 10),
      taxRate, subtotal, taxTotal, total, balance: total,
      billToName: org?.name ?? null, billToAddress, billToTaxId: org?.taxId ?? null,
      billToTaxExempt: org?.taxExempt ?? false,
      // `terms` is the small footer line (from partner.invoiceFooter); `termsAndConditions`
      // is the labeled Terms & Conditions block (from partner.billingTermsAndConditions).
      terms: partner?.invoiceFooter ?? null,
      sellerSnapshot: buildSellerSnapshot(partner),
      termsAndConditions: inv.termsAndConditions ?? partner?.billingTermsAndConditions ?? null,
      // Render-locale snapshot (#3777): stamped ONCE at issue from the partner's
      // language and never restamped — `??` keeps a locale the draft already
      // carries. Pure key addition using the `partner` row read above (after
      // all locks): no new read, no new lock class.
      documentLocale: inv.documentLocale ?? resolvePartnerDocumentLocale(partner),
      updatedAt: issueDate
    }).where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'draft'))).returning({ id: invoices.id });
    // Guarded write: impossible to miss while we hold the row lock and asserted
    // draft above — a mismatch means the locking contract broke, so fail loudly.
    if (updated.length !== 1) {
      throw new InvoiceServiceError('Invoice changed under the issuance lock', 500, 'CONCURRENT_MODIFICATION');
    }

    // Guarded source flips (belt-and-braces under the held locks — also stops
    // an unconditional flip of a deleted/foreign/already-billed row).
    if (timeIds.length) {
      const flipped = await db.update(timeEntries).set({ billingStatus: 'billed', updatedAt: issueDate })
        .where(and(inArray(timeEntries.id, timeIds), eq(timeEntries.orgId, inv.orgId), eq(timeEntries.billingStatus, 'not_billed')))
        .returning({ id: timeEntries.id });
      if (flipped.length !== timeIds.length) {
        throw new InvoiceServiceError('Time entries changed under the issuance lock', 500, 'CONCURRENT_MODIFICATION');
      }
    }
    if (partIds.length) {
      const flipped = await db.update(ticketParts).set({ billingStatus: 'billed', updatedAt: issueDate })
        .where(and(inArray(ticketParts.id, partIds), eq(ticketParts.orgId, inv.orgId), eq(ticketParts.billingStatus, 'not_billed')))
        .returning({ id: ticketParts.id });
      if (flipped.length !== partIds.length) {
        throw new InvoiceServiceError('Parts changed under the issuance lock', 500, 'CONCURRENT_MODIFICATION');
      }
    }
    return inv;
  }));

  // Single retry on a transient lock error (40P01 deadlock / 40001
  // serialization): the new invoice-first lock order cannot deadlock against
  // itself, but during a rolling deploy old-code orderings (line → invoice)
  // may still run; one fresh transaction absorbs that window. issueTx is a
  // fresh TOP-LEVEL system transaction (runOutsideDbContext), so the helper's
  // nested-savepoint caveat does not apply — a failed attempt rolls back
  // cleanly and the retry starts a brand-new transaction.
  const inv = await retryOnTransientLockError('issueInvoice', issueTx, { attempts: 2 });

  await emitInvoiceEvent({ type: 'invoice.issued', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, actorUserId: actor.userId });
  // Async PDF render (worker stores invoice_documents). enqueueInvoicePdfRender is
  // itself Redis-outage-safe (try/catch + Sentry), but wrap defensively too so no
  // unexpected throw — e.g. a transient import/connection error — can fail an
  // otherwise-committed issuance. The email/send path renders synchronously and
  // does NOT depend on this job, so a missed enqueue only delays the cached PDF.
  try {
    await enqueueInvoicePdfRender(invoiceId);
  } catch (err) {
    console.error('[invoiceService] enqueueInvoicePdfRender failed (issuance already committed)', `invoiceId=${invoiceId}`, err instanceof Error ? err.message : err);
  }
  // Auto-push to QuickBooks (Phase C, Task 4). enqueueAccountingInvoicePush is
  // itself Redis-outage-safe (try/catch + Sentry) — the worker decides whether
  // this partner is even connected/pushMode:'auto'; the try/catch here is the
  // same defensive belt-and-braces as the PDF render above.
  try {
    await enqueueAccountingInvoicePush(invoiceId, inv.partnerId);
  } catch (err) {
    console.error('[invoiceService] enqueueAccountingInvoicePush failed (issuance already committed)', `invoiceId=${invoiceId}`, err instanceof Error ? err.message : err);
  }
  return getOwnedInvoiceOr404(invoiceId);
}

// ---------------------------------------------------------------------------
// Payments + status recompute (Task 3.7)
// ---------------------------------------------------------------------------

/** Derive amount_paid/balance/status from the payment rows and persist them.
 *  The locking payment writers (recordPayment, voidPayment, recordStripePayment)
 *  hold the invoice row lock and pass their `tx`, so the sum read here is
 *  consistent with the write (B10) — a global-db call from a locked writer
 *  would escape the transaction and race the lock it holds. Exception:
 *  reflectStripeRefund (stripeReconcile.ts) does NOT lock the invoice row
 *  before calling this — deliberately deferred, tracked as #3803 item 1. */
export async function recomputeInvoiceStatus(invoiceId: string, dbc: DbExecutor = db): Promise<void> {
  const inv = await getOwnedInvoiceOr404(invoiceId, dbc);
  const paidRows = await dbc.select({ amount: invoicePayments.amount }).from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId));
  const amountPaid = fromCents(paidRows.reduce((s, r) => s + toCents(r.amount), 0));
  const balance = fromCents(toCents(inv.total) - toCents(amountPaid));
  const issued = inv.invoiceNumber !== null;
  const status = deriveInvoiceStatus({ voided: inv.voidedAt !== null, issued, total: inv.total, amountPaid, dueDate: inv.dueDate, asOf: new Date() });
  const patch: Record<string, unknown> = { amountPaid, balance, status, updatedAt: new Date() };
  if (status === 'paid' && inv.paidAt === null) patch.paidAt = new Date();
  // #4542: paid_at was STAMPED but never CLEARED, so an invoice that fell back
  // out of `paid` — a voided payment, a QuickBooks-side reversal, a Stripe
  // refund — kept reporting a payment date it no longer had, and every
  // "paid in period" report counted it twice. Only written when it actually
  // changes, so an ordinary recompute of an unpaid invoice writes no churn.
  if (status !== 'paid' && inv.paidAt !== null) patch.paidAt = null;
  if (status === 'overdue' && inv.markedOverdueAt === null) patch.markedOverdueAt = new Date();
  await dbc.update(invoices).set(patch).where(eq(invoices.id, invoiceId));
}

export async function recordPayment(invoiceId: string, input: RecordPaymentInput, actor: InvoiceActor) {
  // ONE transaction, invoice row lock FIRST (B10 lock order — every payment
  // writer: manual record, manual void, Stripe reconcile). All validation runs
  // against the LOCKED row and the in-tx payment sum; a check-then-insert
  // against a pre-lock snapshot let two concurrent full-balance payments both
  // land. Every helper gets the `tx` handle — inside a request context this
  // transaction is a savepoint on the request tx, and a stray global-`db` call
  // would escape it.
  const { inv, payment, updated, paymentPushMappingId } = await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
    if (!inv) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
    // Re-authorize against the locked row (it may have moved site/org since any
    // earlier unlocked read the caller made).
    requireInvoiceAccess(actor, inv);
    if (inv.status === 'draft') throw new InvoiceServiceError('Cannot record payment on a draft', 409, 'INVALID_STATE');
    if (inv.status === 'void') throw new InvoiceServiceError('Cannot record payment on a void invoice', 409, 'INVALID_STATE');

    // Authoritative balance: recompute from invoice_payments UNDER the lock.
    // Consistent because every payment writer locks the invoice row first —
    // the header's balance column is only a cache of this sum.
    const paidRows = await tx.select({ amount: invoicePayments.amount })
      .from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId));
    const balanceCents = toCents(inv.total) - paidRows.reduce((s, r) => s + toCents(r.amount), 0);
    // Exact integer-cents comparison — robust against float representation error.
    const amountCents = toCents(input.amount);

    if (!isRepresentableInCurrency(fromCents(balanceCents), inv.currencyCode)) {
      // Legacy escape hatch: invoices created before currency-aware rounding
      // can carry a zero-decimal-currency balance with cent fractions (e.g.
      // JPY '1000.50'). ONLY the exact payoff may land on such a balance —
      // requiring representability would strand the invoice forever, and a
      // smaller representable payment would strand a non-representable residue
      // (e.g. '0.50') that no later payment could clear. Evaluated against the
      // LOCKED balance: a stale pre-lock balance could let both an exact payoff
      // and an underpayment through.
      if (amountCents !== balanceCents) {
        throw new InvoiceServiceError(
          'Invoice balance is not representable in its currency; only the exact payoff amount can be recorded',
          400, 'INVALID_AMOUNT'
        );
      }
    } else {
      if (!isRepresentableInCurrency(input.amount, inv.currencyCode)) {
        throw new InvoiceServiceError('Payment amount has more precision than the invoice currency allows', 400, 'INVALID_AMOUNT');
      }
      if (amountCents > balanceCents) {
        throw new InvoiceServiceError('Payment exceeds balance', 400, 'OVERPAYMENT');
      }
    }

    const [payment] = await tx.insert(invoicePayments).values({
      invoiceId, orgId: inv.orgId, amount: Number(input.amount).toFixed(2), method: input.method,
      reference: input.reference ?? null, receivedAt: input.receivedAt, recordedBy: actor.userId, note: input.note ?? null
    }).returning();
    await recomputeInvoiceStatus(invoiceId, tx);
    // The mapping row is the OUTBOX and it is written HERE, in the same
    // transaction as the payment — not from a post-commit hook. If the process
    // dies before the enqueue below, the reconcile sweep finds the pending row
    // and pushes it anyway; if this transaction rolls back, no promise to
    // QuickBooks survives it either. Null = nothing owed (push disabled, manual
    // push mode, or the invoice itself is not in QuickBooks yet — the invoice
    // push fans its payments out when it lands).
    const paymentPushMappingId = await requestPaymentPush(tx, {
      invoicePaymentId: payment!.id, invoiceId, partnerId: inv.partnerId,
    });
    const updated = await getOwnedInvoiceOr404(invoiceId, tx);
    return { inv, payment: payment!, updated, paymentPushMappingId };
  });

  // Event emission runs after db.transaction returns, but that does NOT mean
  // the invoice row lock is released: on the request path db.transaction is a
  // SAVEPOINT inside the request-wide withDbAccessContext transaction, so the
  // FOR UPDATE lock persists until the request tx commits. (recordStripePayment
  // avoids this by emitting after its top-level system tx has returned.)
  // Moving emission to post-commit is the follow-up tracked in #3803.
  await emitInvoiceEvent({ type: 'payment.recorded', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, paymentId: payment.id, actorUserId: actor.userId });
  if (updated.status === 'paid') await emitInvoiceEvent({ type: 'invoice.paid', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, actorUserId: actor.userId });
  // Fire-and-forget nudge, AFTER the transaction callback returned.
  // `enqueueAccountingPaymentPush` is itself Redis-outage-safe; the extra
  // try/catch is the same defensive belt as the issue-side push hook, so no
  // unexpected throw can fail a payment that is already committed.
  if (paymentPushMappingId) {
    try {
      await enqueueAccountingPaymentPush(paymentPushMappingId, inv.partnerId);
    } catch (err) {
      console.error('[invoiceService] enqueueAccountingPaymentPush failed (payment already committed)', `paymentId=${payment.id}`, err instanceof Error ? err.message : err);
    }
  }
  // Surface the persisted payment alongside the refreshed invoice so the route
  // can write a durable audit_logs entry for this money-path mutation. The
  // emitInvoiceEvent bus above is intentionally unconsumed and is NOT the
  // durable chain.
  return {
    invoice: updated,
    audit: {
      orgId: inv.orgId,
      paymentId: payment.id,
      invoiceId,
      amount: payment.amount,
      method: payment.method,
      reference: payment.reference,
      recordedBy: payment.recordedBy,
    },
  };
}

export async function voidPayment(paymentId: string, actor: InvoiceActor) {
  // Unlocked discovery read: the caller supplies a payment id, but the lock
  // order is invoice row FIRST (B10) — so resolve the parent invoice id, then
  // lock invoice → payment inside one transaction and re-validate both.
  const [pre] = await db.select({ invoiceId: invoicePayments.invoiceId }).from(invoicePayments).where(eq(invoicePayments.id, paymentId)).limit(1);
  if (!pre) throw new InvoiceServiceError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  const { inv, audit, deleteMappingId } = await db.transaction(async (tx) => {
    // The payment row carries orgId but not siteId; the parent invoice drives the
    // site-axis guard (a site-restricted caller must not void a payment on an
    // out-of-site invoice) — run it against the LOCKED row.
    const [parentInv] = await tx.select().from(invoices).where(eq(invoices.id, pre.invoiceId)).limit(1).for('update');
    if (!parentInv) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
    requireInvoiceAccess(actor, parentInv);
    // Re-read the payment under the invoice lock: a concurrent void or Stripe
    // full-refund may have deleted it while we waited.
    const [pay] = await tx.select().from(invoicePayments).where(eq(invoicePayments.id, paymentId)).limit(1).for('update');
    if (!pay || pay.invoiceId !== pre.invoiceId) throw new InvoiceServiceError('Payment not found', 404, 'PAYMENT_NOT_FOUND');

    // QuickBooks-origin payments are refused at the SERVICE layer, not just
    // hidden in the UI (spec decision 14). QuickBooks is the system of record
    // for them: a Breeze-side void would not touch the books, and the next CDC
    // sweep would pull the payment straight back in — leaving an audit trail of
    // a void that did nothing. Read with the same (type, entity id) shape
    // `requestPaymentDelete` uses so the two can never disagree about which row
    // they are looking at; unscoped by partner on purpose, so a row that somehow
    // belonged to another partner refuses the void instead of slipping past it.
    const [existingMapping] = await tx
      .select({ breezeOrigin: accountingEntityMappings.breezeOrigin })
      .from(accountingEntityMappings)
      .where(and(
        eq(accountingEntityMappings.breezeEntityType, 'payment'),
        eq(accountingEntityMappings.breezeEntityId, paymentId),
      ))
      .limit(1);
    if (existingMapping && !existingMapping.breezeOrigin) {
      throw new InvoiceServiceError(
        'This payment came from QuickBooks; reverse it in QuickBooks instead',
        409, 'QUICKBOOKS_OWNED_PAYMENT',
      );
    }

    // Capture the destroyed row's financial details BEFORE the delete so the voided
    // payment survives in the durable audit chain even after the row is gone.
    const audit = {
      orgId: pay.orgId,
      paymentId,
      invoiceId: pay.invoiceId,
      amount: pay.amount,
      method: pay.method,
      reference: pay.reference,
      recordedBy: pay.recordedBy,
    };
    // Settle the 'payment' accounting_entity_mappings row FIRST, inside this
    // same transaction. breeze_entity_id is polymorphic (no FK, so nothing
    // cascades — see orgMerge.runPostPassFixups' orphan-sweep comment): deleting
    // the payment row first would strand the mapping, and a later QuickBooks CDC
    // delivery for that Payment would then read as "already applied" and
    // silently skip re-recording it. Replaces Phase D's
    // `clearPaymentMappingForInvoicePayment`, which only ever deleted the row: a
    // Breeze-origin payment that reached QuickBooks now KEEPS its mapping with
    // pending_op='delete' until QuickBooks confirms the removal. Null (nothing
    // to enqueue) is the normal case — a manual or Stripe payment usually has no
    // accounting mapping at all.
    const deleteMappingId = await requestPaymentDelete(tx, paymentId);
    await tx.delete(invoicePayments).where(eq(invoicePayments.id, paymentId));
    await recomputeInvoiceStatus(pay.invoiceId, tx);
    const inv = await getOwnedInvoiceOr404(pay.invoiceId, tx);
    return { inv, audit, deleteMappingId };
  });
  // Emitted after db.transaction returns — NOT after the lock is released: on
  // the request path this is a savepoint of the request-wide tx, so the invoice
  // row lock is held until the request commits. Post-commit emission: #3803.
  await emitInvoiceEvent({ type: 'payment.voided', invoiceId: audit.invoiceId, orgId: audit.orgId, partnerId: inv.partnerId, paymentId, actorUserId: actor.userId });
  // Same fire-and-forget contract as the record hook above: the mapping row
  // already carries pending_op='delete', so a failed enqueue only delays the
  // removal until the reconcile sweep re-enqueues it.
  if (deleteMappingId) {
    try {
      await enqueueAccountingPaymentDelete(deleteMappingId, inv.partnerId);
    } catch (err) {
      console.error('[invoiceService] enqueueAccountingPaymentDelete failed (void already committed)', `paymentId=${paymentId}`, err instanceof Error ? err.message : err);
    }
  }
  return { invoice: inv, audit };
}

export async function listPayments(invoiceId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireInvoiceAccess(actor, inv);
  const rows = await db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId)).orderBy(invoicePayments.receivedAt);
  // Tag each payment's origin so the UI can badge online (Stripe) payments and
  // hide manual-void on them (Stripe payments are refunded through Stripe, not
  // voided by hand). A payment is Stripe-sourced when a succeeded mapping links it.
  const linked = await db
    .select({ invoicePaymentId: invoiceStripePayments.invoicePaymentId })
    .from(invoiceStripePayments)
    .where(and(eq(invoiceStripePayments.invoiceId, invoiceId), eq(invoiceStripePayments.status, 'succeeded')));
  const stripeIds = new Set(linked.map((r) => r.invoicePaymentId).filter((x): x is string => !!x));
  // QuickBooks-sourced payments (Phase D pull-back) carry a 'payment' mapping row
  // keyed on the invoice_payments id. Same purpose as the Stripe badge: the UI
  // must not offer a hand-void on a row QuickBooks owns — voiding it here would
  // just be re-pulled on the next CDC sweep. Partner-scoped for the same reason
  // every other accounting_entity_mappings read is: RLS is stricter than the app
  // layer, and this read must never depend on it alone.
  const paymentIds = rows.map((r) => r.id);
  const qboLinked = paymentIds.length === 0 ? [] : await db
    .select({
      breezeEntityId: accountingEntityMappings.breezeEntityId,
      breezeOrigin: accountingEntityMappings.breezeOrigin,
      syncStatus: accountingEntityMappings.syncStatus,
      lastError: accountingEntityMappings.lastError,
    })
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.partnerId, inv.partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      inArray(accountingEntityMappings.breezeEntityId, paymentIds),
    ));
  const mappingByPaymentId = new Map(qboLinked.map((r) => [r.breezeEntityId, r]));
  // Stripe wins a (structurally impossible) double link: it is the badge that
  // gates the destructive hand-void affordance.
  return rows.map((r) => {
    const mapping = mappingByPaymentId.get(r.id) ?? null;
    // `quickbooks` means "QuickBooks OWNS this row", which is true only for a
    // payment the pull created (spec decision 14). A Breeze-origin payment that
    // Breeze PUSHED to QuickBooks stays manual/stripe — it is still hand-voidable
    // and the void propagates the deletion — and instead carries a sync badge.
    const source = stripeIds.has(r.id)
      ? ('stripe' as const)
      : mapping && !mapping.breezeOrigin ? ('quickbooks' as const) : ('manual' as const);
    return {
      ...r,
      source,
      accountingSync: mapping && mapping.breezeOrigin
        ? { status: mapping.syncStatus, lastError: mapping.lastError }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Void + reissue + overdue sweep + viewed (Task 3.8)
// ---------------------------------------------------------------------------

/**
 * Void an issued invoice and optionally reissue it as a fresh draft.
 *
 * WAVE 6 (#3778) LOCK DISCIPLINE. Until wave 6 the invoice and its lines were
 * read BEFORE the transaction opened, and the transaction then flipped the
 * status and RELEASED the source rows off that unlocked snapshot — so a void
 * could interleave with issueInvoice, with line mutation, or with source
 * attachment/removal, and release rows that a concurrent issue had just claimed.
 * The source release is the dangerous half and it happens with AND without
 * reissue, so ALL authoritative reads now live inside one transaction and take
 * the established chain in order:
 *
 *     invoices -> invoice_lines -> contracts -> contract_lines
 *              -> time_entries -> ticket_parts
 *
 * HISTORICAL REISSUE EDGE. After an ACTIVE-contract restamp, cloning an old
 * contract-sourced invoice would carry the HISTORICAL currency while issue
 * validation demands the contract's live one — an invoice that can never be
 * issued. `reissue: true` is therefore rejected with CURRENCY_MISMATCH when any
 * referenced contract now carries a different currency; void WITHOUT reissue
 * still works, and the operator creates an explicit old-currency correction
 * draft. Sources are never detached, historical lines are never restamped, and
 * issue validation is never bypassed (owner-fixed: no conversion, snapshots rule).
 */
export async function voidInvoice(invoiceId: string, reason: string, opts: { reissue?: boolean }, actor: InvoiceActor) {
  // Void + (optional) reissue commit atomically in ONE system transaction: the
  // void/release and the fresh-draft clone must not be observable independently.
  let draftId: string | null = null;
  let voidedOrgId = '';
  let voidedPartnerId = '';
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    // 1. Invoice row FIRST, FOR UPDATE — status is re-validated on the LOCKED row.
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1).for('update');
    if (!inv) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
    requireInvoiceAccess(actor, inv);
    if (inv.status === 'draft') throw new InvoiceServiceError('Delete drafts instead of voiding', 409, 'INVALID_STATE');
    if (inv.status === 'void') throw new InvoiceServiceError('Already void', 409, 'INVALID_STATE');
    voidedOrgId = inv.orgId;
    voidedPartnerId = inv.partnerId;

    // 2. Lines FOR UPDATE (deterministic id order), so a concurrent line
    //    mutation or source attach/detach cannot slip between read and release.
    const srcLines = await db.select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.id).for('update');
    const timeIds = [...new Set(srcLines.filter((l) => l.sourceType === 'time_entry' && l.sourceId).map((l) => l.sourceId!))].sort();
    const partIds = [...new Set(srcLines.filter((l) => l.sourceType === 'part' && l.sourceId).map((l) => l.sourceId!))].sort();
    const contractLineIds = [...new Set(srcLines.filter((l) => l.sourceType === 'contract' && l.sourceId).map((l) => l.sourceId!))].sort();

    // 3. Contracts, then contract_lines (parents before children, repo order).
    //    Durable lineage first (#3778); the contract_lines join is the legacy
    //    fallback for rows written before the column existed.
    const legacy = contractLineIds.length
      ? await db.select({ contractId: contractLines.contractId })
          .from(contractLines).where(inArray(contractLines.id, contractLineIds))
      : [];
    const contractIds = [...new Set([
      ...srcLines.map((l) => l.sourceContractId).filter((x): x is string => !!x),
      ...legacy.map((r) => r.contractId),
    ])].sort();
    const lockedContracts = contractIds.length
      ? await db.select({ id: contracts.id, currencyCode: contracts.currencyCode })
          .from(contracts).where(inArray(contracts.id, contractIds)).orderBy(contracts.id).for('update')
      : [];
    if (contractLineIds.length) {
      await db.select({ id: contractLines.id }).from(contractLines)
        .where(inArray(contractLines.id, contractLineIds)).orderBy(contractLines.id).for('update');
    }

    // 4. Source rows FOR UPDATE before they are released.
    if (timeIds.length) {
      await db.select({ id: timeEntries.id }).from(timeEntries)
        .where(inArray(timeEntries.id, timeIds)).orderBy(timeEntries.id).for('update');
    }
    if (partIds.length) {
      await db.select({ id: ticketParts.id }).from(ticketParts)
        .where(inArray(ticketParts.id, partIds)).orderBy(ticketParts.id).for('update');
    }

    // 5. Historical-reissue guard, on the LOCKED contract rows.
    if (opts.reissue) {
      const drifted = lockedContracts.filter((c) => c.currencyCode !== inv.currencyCode);
      if (drifted.length) {
        const codes = [...new Set(drifted.map((c) => c.currencyCode))].join(', ');
        throw new InvoiceServiceError(
          `This invoice is in ${inv.currencyCode} but its contract(s) are now in ${codes} — reissue would create a draft that can never be issued. Void without reissue and create an explicit ${inv.currencyCode} correction draft instead`,
          400, 'CURRENCY_MISMATCH'
        );
      }
    }

    const now = new Date();
    // paid_at cleared with the same reasoning as recomputeInvoiceStatus above
    // (#4542): this update bypasses the recompute entirely, so a paid invoice
    // that is voided would otherwise keep its payment date forever.
    await db.update(invoices).set({ status: 'void', voidedAt: now, voidReason: reason, paidAt: null, updatedAt: now }).where(eq(invoices.id, invoiceId));
    // release source rows so they can be re-invoiced
    if (timeIds.length) await db.update(timeEntries).set({ billingStatus: 'not_billed', updatedAt: now }).where(inArray(timeEntries.id, timeIds));
    if (partIds.length) await db.update(ticketParts).set({ billingStatus: 'not_billed', updatedAt: now }).where(inArray(ticketParts.id, partIds));

    if (!opts.reissue) return;
    // Clone source-backed lines into a fresh draft (released rows are not_billed
    // again). The clone copies the ORIGINAL document's currency, not the org's
    // current setting (spec §5) — line totals are copied verbatim, so they only
    // make sense in the currency they were rounded in. document_locale is
    // likewise NOT copied: it is an issue-time snapshot, restamped when this
    // draft issues (#3777).
    const [draft] = await db.insert(invoices).values({ partnerId: inv.partnerId, orgId: inv.orgId, siteId: inv.siteId, status: 'draft', notes: inv.notes, currencyCode: inv.currencyCode, replacesInvoiceId: invoiceId, createdBy: actor.userId }).returning();
    draftId = draft!.id;
    await db.update(invoices).set({ replacedByInvoiceId: draft!.id }).where(eq(invoices.id, invoiceId));
    // Cloned from the rows LOCKED in step 2 — not re-read unlocked.
    srcLines.sort((a, b) => a.sortOrder - b.sortOrder);

    // Two-pass clone to preserve bundle hierarchy: insert parents (parentLineId IS
    // NULL) first, map old line id → new line id, then insert children with their
    // parentLineId remapped to the cloned parent.
    const cloneValues = (l: typeof srcLines[number], parentLineId: string | null) => ({
      invoiceId: draft!.id, orgId: l.orgId, sourceType: l.sourceType, sourceId: l.sourceId, catalogItemId: l.catalogItemId,
      sourceContractId: l.sourceContractId,
      parentLineId, ticketId: l.ticketId, name: l.name, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
      costBasis: l.costBasis, revenueAllocation: l.revenueAllocation, taxable: l.taxable, customerVisible: l.customerVisible,
      lineTotal: l.lineTotal, isUnapprovedTime: l.isUnapprovedTime, sortOrder: l.sortOrder
    });
    const oldToNew = new Map<string, string>();
    const parents = srcLines.filter((l) => l.parentLineId === null);
    if (parents.length) {
      const inserted = await db.insert(invoiceLines).values(parents.map((l) => cloneValues(l, null))).returning({ id: invoiceLines.id });
      parents.forEach((l, i) => oldToNew.set(l.id, inserted[i]!.id));
    }
    const children = srcLines.filter((l) => l.parentLineId !== null);
    if (children.length) {
      await db.insert(invoiceLines).values(children.map((l) => cloneValues(l, oldToNew.get(l.parentLineId!) ?? null)));
    }
  }));

  await emitInvoiceEvent({ type: 'invoice.voided', invoiceId, orgId: voidedOrgId, partnerId: voidedPartnerId, actorUserId: actor.userId });
  // Auto-void in QuickBooks (Phase C, Task 4). Fire-and-forget, own try/catch —
  // mirrors the issue-side push hook. VOID jobs process regardless of
  // pushMode: books must not keep a voided invoice open in QuickBooks just
  // because auto-push is off (voidInvoiceInAccounting itself no-ops when the
  // invoice was never pushed).
  try {
    await enqueueAccountingInvoiceVoid(invoiceId, voidedPartnerId);
  } catch (err) {
    console.error('[invoiceService] enqueueAccountingInvoiceVoid failed (void already committed)', `invoiceId=${invoiceId}`, err instanceof Error ? err.message : err);
  }

  if (opts.reissue && draftId) {
    await recomputeInvoiceTotals(draftId);
    return getInvoice(draftId, actor);
  }
  return getInvoice(invoiceId, actor);
}

/** Daily sweep: flip sent/partially_paid past their due date (balance>0) to overdue. */
export async function runOverdueSweep(asOf: Date = new Date()): Promise<number> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const today = asOf.toISOString().slice(0, 10);
    const due = await db.select({ id: invoices.id, orgId: invoices.orgId, partnerId: invoices.partnerId })
      .from(invoices)
      .where(and(
        inArray(invoices.status, ['sent', 'partially_paid'] as never),
        lt(invoices.dueDate, today),
        sql`${invoices.balance} > 0`,
        // Org-lifecycle Wave 4: never flip an ARCHIVED/purging/merging tenant's
        // invoice to overdue. The org is hidden and read-only for its whole
        // retention window, so the status change (and its invoice.overdue event
        // → notification/webhook) would be work nobody can see or act on,
        // landing inside a tenant counting down to erasure.
        buildAutomationEligibleOrgPredicate(invoices.orgId),
      ));
    for (const r of due) {
      await db.update(invoices).set({ status: 'overdue', markedOverdueAt: asOf, updatedAt: asOf }).where(eq(invoices.id, r.id));
      await emitInvoiceEvent({ type: 'invoice.overdue', invoiceId: r.id, orgId: r.orgId, partnerId: r.partnerId });
    }
    return due.length;
  }));
}

/** Portal/email open: stamp viewed timestamps (independent of status). */
export async function markViewed(invoiceId: string, orgId?: string): Promise<void> {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  // App-layer org guard (defense-in-depth over RLS). 404, not 403 — don't leak existence to the portal.
  if (orgId !== undefined && inv.orgId !== orgId) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  const now = new Date();
  // SQL CASE keeps first_viewed_at write-once so concurrent calls can't both set it.
  // Bind `now` as an ISO string cast to `timestamp` — a raw JS Date in the
  // fragment is inferred as timestamptz (OID 1184), which mismatches this
  // column's `timestamp` (OID 1114) and makes the CASE bind fail at the driver.
  const nowParam = sql`${now.toISOString()}::timestamp`;
  await db.update(invoices).set({
    viewedAt: now,
    firstViewedAt: sql`CASE WHEN ${invoices.firstViewedAt} IS NULL THEN ${nowParam} ELSE ${invoices.firstViewedAt} END`
  }).where(eq(invoices.id, invoiceId));
  if (inv.firstViewedAt === null) await emitInvoiceEvent({ type: 'invoice.viewed', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId });
}
