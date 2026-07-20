import { and, or, eq, desc, lt, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  invoices, invoiceLines, invoicePayments, invoiceStripePayments, organizations, partners,
  catalogBundleComponents, catalogItems, timeEntries, ticketParts, tickets
} from '../db/schema';
import { getConnection } from './stripeConnectService';
import { computeLineTotal, computeInvoiceTotals, resolveEffectiveTaxRate, deriveInvoiceStatus, toCents, fromCents } from './invoiceMath';
import { resolvePrice, computeBundleEconomics } from './catalogService';
// formatInvoiceNumber is shared with the standalone allocator; issueInvoice
// inlines the counter upsert itself (rather than calling allocateInvoiceCounter)
// to keep allocation atomic with the number write inside its single transaction.
import { formatInvoiceNumber } from './invoiceNumbers';
import { emitInvoiceEvent } from './invoiceEvents';
import { enqueueInvoicePdfRender } from '../jobs/invoiceWorker';
import { gatherOrgTimeEntries, gatherOrgParts, gatherTicketBillables, type DraftLineSpec } from './invoiceAssembly';
import { buildSellerSnapshot, buildBillToAddress } from './sellerSnapshot';
import { InvoiceServiceError } from './invoiceTypes';
import type { InvoiceActor } from './invoiceTypes';
import type { ManualLineInput, RecordPaymentInput } from '@breeze/shared';

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

async function getOwnedInvoiceOr404(id: string) {
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!rows[0]) throw new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND');
  return rows[0];
}

function assertDraft(inv: { status: string }): void {
  if (inv.status !== 'draft') throw new InvoiceServiceError('Invoice is not a draft', 409, 'NOT_A_DRAFT');
}

export async function createManualInvoice(input: { orgId: string; siteId?: string; notes?: string; termsAndConditions?: string }, actor: InvoiceActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, input.orgId);
  requireSiteAccess(actor, input.siteId ?? null);
  const rows = await db.insert(invoices).values({
    partnerId, orgId: input.orgId, siteId: input.siteId ?? null, status: 'draft',
    notes: input.notes ?? null, termsAndConditions: input.termsAndConditions ?? null, createdBy: actor.userId
  }).returning();
  return rows[0]!;
}

/** Draft-time effective tax rate: org rate or 0. The partner default is applied
 *  authoritatively at issue (system context, where the partner row is readable). */
async function effectiveRateForOrg(orgId: string, _partnerId: string): Promise<string> {
  const [org] = await db.select({ taxExempt: organizations.taxExempt, taxRate: organizations.taxRate })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return resolveEffectiveTaxRate({ taxExempt: org?.taxExempt ?? false, orgRate: org?.taxRate ?? null, partnerRate: null });
}

/** Recompute subtotal/tax/total/balance from the invoice's current lines. Draft-time
 *  uses the org's effective rate; on issue the snapshotted tax_rate is passed instead. */
export async function recomputeInvoiceTotals(invoiceId: string, taxRateOverride?: string | null) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  // Frozen invoices can never be re-totaled by a direct call. issueInvoice computes
  // totals inline with the snapshot rate and does NOT call this; assembly recomputes
  // a fresh draft (still draft here), so this guard is safe on both paths.
  assertDraft(inv);
  const lines = await db.select({
    lineTotal: invoiceLines.lineTotal, taxable: invoiceLines.taxable, customerVisible: invoiceLines.customerVisible
  }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  const taxRate = taxRateOverride !== undefined ? taxRateOverride : await effectiveRateForOrg(inv.orgId, inv.partnerId);
  const totals = computeInvoiceTotals(lines, taxRate);
  const balance = fromCents(toCents(totals.total) - toCents(inv.amountPaid));
  await db.update(invoices).set({
    subtotal: totals.subtotal, taxRate, taxTotal: totals.taxTotal, total: totals.total, balance, updatedAt: new Date()
  }).where(eq(invoices.id, invoiceId));
}

async function insertLineAndRecompute(
  invoiceId: string,
  orgId: string,
  spec: Omit<typeof invoiceLines.$inferInsert, 'invoiceId' | 'orgId' | 'sortOrder'>
) {
  const sortRows = await db.select({ max: invoiceLines.sortOrder }).from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(desc(invoiceLines.sortOrder)).limit(1);
  const nextSort = (sortRows[0]?.max ?? 0) + 1;
  const [line] = await db.insert(invoiceLines).values({ ...spec, invoiceId, orgId, sortOrder: nextSort }).returning();
  await recomputeInvoiceTotals(invoiceId);
  return line!;
}

export async function addManualLine(invoiceId: string, input: ManualLineInput, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireInvoiceAccess(actor, inv);
  const lineTotal = computeLineTotal(String(input.quantity), String(input.unitPrice));
  return insertLineAndRecompute(invoiceId, inv.orgId, {
    sourceType: 'manual', sourceId: null, catalogItemId: null, parentLineId: null, ticketId: null,
    name: input.name ?? null, description: input.description ?? null, quantity: String(input.quantity), unitPrice: Number(input.unitPrice).toFixed(2),
    costBasis: input.costBasis != null ? Number(input.costBasis).toFixed(2) : null,
    taxable: input.taxable, customerVisible: true, lineTotal, isUnapprovedTime: false
  });
}

export async function addCatalogLine(invoiceId: string, catalogItemId: string, quantity: number, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireInvoiceAccess(actor, inv);
  const resolved = await resolvePrice(catalogItemId, inv.orgId, { userId: actor.userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds });
  const [item] = await db.select({ name: catalogItems.name, description: catalogItems.description, isBundle: catalogItems.isBundle }).from(catalogItems).where(eq(catalogItems.id, catalogItemId)).limit(1);
  if (item?.isBundle) throw new InvoiceServiceError('Use addBundleLine for bundles', 400, 'INVALID_STATE');
  const qty = String(quantity);
  return insertLineAndRecompute(invoiceId, inv.orgId, {
    sourceType: 'catalog', sourceId: null, catalogItemId, parentLineId: null, ticketId: null,
    name: item?.name ?? 'Catalog item', description: item?.description ?? null, quantity: qty, unitPrice: resolved.unitPrice,
    costBasis: resolved.costBasis, taxable: resolved.taxable, customerVisible: true,
    lineTotal: computeLineTotal(qty, resolved.unitPrice), isUnapprovedTime: false
  });
}

export async function addBundleLine(invoiceId: string, bundleId: string, quantity: number, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireInvoiceAccess(actor, inv);
  const catalogActor = { userId: actor.userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds };
  const econ = await computeBundleEconomics(bundleId, inv.orgId, catalogActor); // throws NOT_A_BUNDLE etc.
  const [bundle] = await db.select({ name: catalogItems.name, description: catalogItems.description }).from(catalogItems).where(eq(catalogItems.id, bundleId)).limit(1);
  const qty = String(quantity);
  const parent = await insertLineAndRecompute(invoiceId, inv.orgId, {
    sourceType: 'bundle', sourceId: null, catalogItemId: bundleId, parentLineId: null, ticketId: null,
    name: bundle?.name ?? 'Bundle', description: bundle?.description ?? null, quantity: qty, unitPrice: econ.headlinePrice,
    costBasis: econ.totalCost, taxable: true, customerVisible: true,
    lineTotal: computeLineTotal(qty, econ.headlinePrice), isUnapprovedTime: false
  });
  // child component lines (unit_price 0, visibility per show_on_invoice)
  const comps = await db.select({
    componentItemId: catalogBundleComponents.componentItemId, quantity: catalogBundleComponents.quantity,
    showOnInvoice: catalogBundleComponents.showOnInvoice, revenueAllocation: catalogBundleComponents.revenueAllocation,
    name: catalogItems.name, description: catalogItems.description, costBasis: catalogItems.costBasis
  }).from(catalogBundleComponents)
    .innerJoin(catalogItems, eq(catalogItems.id, catalogBundleComponents.componentItemId))
    .where(eq(catalogBundleComponents.bundleItemId, bundleId));
  for (const comp of comps) {
    await db.insert(invoiceLines).values({
      invoiceId, orgId: inv.orgId, sourceType: 'bundle', sourceId: null, catalogItemId: comp.componentItemId,
      parentLineId: parent.id, ticketId: null, name: comp.name, description: comp.description ?? null, quantity: comp.quantity, unitPrice: '0.00',
      costBasis: comp.costBasis, revenueAllocation: comp.revenueAllocation, taxable: false,
      customerVisible: comp.showOnInvoice, lineTotal: '0.00', isUnapprovedTime: false,
      sortOrder: parent.sortOrder // children sort directly under the parent
    });
  }
  await recomputeInvoiceTotals(invoiceId);
  return parent;
}

/**
 * Add a line sourced from a recurring contract (sub-project 3). This is an
 * internal engine helper — callers MUST supply org-scoped, engine-resolved
 * inputs (quantity computed by the contract engine, sourceId scoped to the
 * originating contract_line). Do NOT wire this directly to an HTTP endpoint.
 *
 * When catalogItemId is supplied the price, taxable flag, and costBasis are
 * authoritative from resolvePrice (tenant-scoped; throws if inaccessible).
 * On the non-catalog path the caller-supplied unitPrice and taxable are used,
 * with numeric normalization and a non-negative guard applied.
 * sourceId carries the originating contract_line id (already org-scoped by
 * the contract engine — no additional scoping is applied here).
 */
export async function addContractLine(
  invoiceId: string,
  input: {
    description: string;
    quantity: string;        // fixed-2-decimal string
    unitPrice: string;       // fixed-2-decimal string (used on non-catalog path)
    taxable: boolean;        // used on non-catalog path
    catalogItemId?: string | null;
    sourceId?: string | null; // contract_line id
  },
  actor: InvoiceActor
) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireInvoiceAccess(actor, inv);

  // Quantity is always engine-supplied (e.g. device count) — normalize but do not override.
  const quantity = String(input.quantity);

  let unitPrice: string;
  let taxable: boolean;
  let costBasis: string | null = null;

  if (input.catalogItemId) {
    // Catalog path: resolve price through the tenant-scoped catalog service.
    // resolvePrice throws if the item is not accessible to the actor's org/partner,
    // closing the cross-tenant catalog reference hole (Finding 1).
    const resolved = await resolvePrice(
      input.catalogItemId, inv.orgId,
      { userId: actor.userId, partnerId: actor.partnerId, accessibleOrgIds: actor.accessibleOrgIds }
    );
    unitPrice = resolved.unitPrice;
    taxable = resolved.taxable;
    costBasis = resolved.costBasis;
  } else {
    // Non-catalog path: normalize like addManualLine/updateLine (Finding 2).
    unitPrice = Number(input.unitPrice).toFixed(2);
    taxable = input.taxable;
    if (Number(quantity) < 0 || Number(unitPrice) < 0) {
      throw new InvoiceServiceError('Negative amounts not allowed', 400, 'INVALID_AMOUNT');
    }
  }

  return insertLineAndRecompute(invoiceId, inv.orgId, {
    sourceType: 'contract', sourceId: input.sourceId ?? null, catalogItemId: input.catalogItemId ?? null,
    parentLineId: null, ticketId: null, description: input.description, quantity,
    unitPrice, costBasis, taxable, customerVisible: true,
    lineTotal: computeLineTotal(quantity, unitPrice), isUnapprovedTime: false
  });
}

export async function updateLine(invoiceId: string, lineId: string, patch: { name?: string | null; description?: string | null; quantity?: number; unitPrice?: number; taxable?: boolean; customerVisible?: boolean }, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireInvoiceAccess(actor, inv);
  const [existing] = await db.select().from(invoiceLines).where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId))).limit(1);
  if (!existing) throw new InvoiceServiceError('Line not found', 404, 'LINE_NOT_FOUND');
  const quantity = patch.quantity != null ? String(patch.quantity) : existing.quantity;
  const unitPrice = patch.unitPrice != null ? Number(patch.unitPrice).toFixed(2) : existing.unitPrice;
  await db.update(invoiceLines).set({
    name: patch.name !== undefined ? patch.name : existing.name,
    description: patch.description !== undefined ? patch.description : existing.description, quantity, unitPrice,
    taxable: patch.taxable ?? existing.taxable, customerVisible: patch.customerVisible ?? existing.customerVisible,
    lineTotal: computeLineTotal(quantity, unitPrice)
  }).where(eq(invoiceLines.id, lineId));
  await recomputeInvoiceTotals(invoiceId);
  return getOwnedInvoiceOr404(invoiceId);
}

export async function removeLine(invoiceId: string, lineId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireInvoiceAccess(actor, inv);
  // cascade FK removes bundle children when a parent is deleted
  await db.delete(invoiceLines).where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId)));
  await recomputeInvoiceTotals(invoiceId);
  return getOwnedInvoiceOr404(invoiceId);
}

export async function deleteDraftInvoice(invoiceId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); assertDraft(inv); requireInvoiceAccess(actor, inv);
  await db.delete(invoices).where(eq(invoices.id, invoiceId)); // lines cascade
}

/** Draft-only header edit (notes/site/dueDate/termsAndConditions). Only provided fields are written;
 *  siteId can be explicitly set to null to clear it. issue() overwrites dueDate
 *  with issueDate + partner terms, so a draft dueDate is advisory until then. */
export async function updateInvoice(
  invoiceId: string,
  patch: { notes?: string; siteId?: string | null; dueDate?: string; termsAndConditions?: string | null },
  actor: InvoiceActor
) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  assertDraft(inv);
  requireInvoiceAccess(actor, inv);
  // A site-restricted caller may not move the invoice to a site it can't access
  // (nor clear it to null, which a restricted caller can never see).
  if (patch.siteId !== undefined) requireSiteAccess(actor, patch.siteId);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.siteId !== undefined) set.siteId = patch.siteId;     // null clears it
  if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;  // date string
  if (patch.termsAndConditions !== undefined) set.termsAndConditions = patch.termsAndConditions;
  await db.update(invoices).set(set).where(eq(invoices.id, invoiceId));
  return getOwnedInvoiceOr404(invoiceId);
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

export async function getInvoice(invoiceId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId); requireInvoiceAccess(actor, inv);
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder);
  // Whether this invoice's partner can collect online (gates the "Send payment
  // link" UI). Partner-axis read under a partner/system request scope, so the
  // actor's own connection row is RLS-visible. Best-effort: a lookup failure
  // (e.g. Stripe unconfigured) just means "not connected".
  const conn = await getConnection(inv.partnerId).catch(() => null);
  return { invoice: inv, lines, stripeConnected: conn?.status === 'connected' }; // accounting view (all lines)
}

export type CustomerInvoiceLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  lineTotal: string;
};

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
    description: line.description ?? line.name ?? '',
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxable: line.taxable,
    lineTotal: line.lineTotal,
  };
}

export async function getCustomerInvoice(invoiceId: string, orgId?: string) {
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
  return { invoice: inv, lines };
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
    catalogAiStyle?: string | null;
    invoiceFooter?: string | null;
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
  if (patch.catalogAiStyle !== undefined) set.catalogAiStyle = patch.catalogAiStyle?.trim() || null;
  if (patch.invoiceFooter !== undefined) set.invoiceFooter = patch.invoiceFooter;
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
    catalogAiStyle: partners.catalogAiStyle, invoiceFooter: partners.invoiceFooter,
  });
  if (!row) throw new InvoiceServiceError('Partner could not be resolved', 400, 'PARTNER_UNRESOLVABLE');
  return row;
}

export async function updateOrgBillingSettings(
  orgId: string,
  patch: {
    taxId?: string | null; taxExempt?: boolean; taxRate?: number | null;
    billingContactEmail?: string | null; billingContactName?: string | null;
    billingAddressLine1?: string | null; billingAddressLine2?: string | null;
    billingAddressCity?: string | null; billingAddressRegion?: string | null;
    billingAddressPostalCode?: string | null; billingAddressCountry?: string | null;
  },
  actor: InvoiceActor
) {
  requireOrgAccess(actor, orgId);
  const set: Record<string, unknown> = {};
  if (patch.taxId !== undefined) set.taxId = patch.taxId;
  if (patch.taxExempt !== undefined) set.taxExempt = patch.taxExempt;
  if (patch.taxRate !== undefined) set.taxRate = patch.taxRate === null ? null : Number(patch.taxRate).toFixed(5);
  // billingContact is a jsonb bag other importers (e.g. QuickBooks) also write.
  // Merge email/name in the DB with `||` (COALESCE handles a NULL start on a fresh
  // org) so we never drop keys we don't model here AND never lose a concurrent
  // writer's key to a read-modify-write race — the merge is one atomic statement,
  // no pre-read round-trip. Only build it when a contact field is in the patch.
  const contactPatch: Record<string, unknown> = {};
  if (patch.billingContactEmail !== undefined) contactPatch.email = patch.billingContactEmail;
  if (patch.billingContactName !== undefined) contactPatch.name = patch.billingContactName;
  if (Object.keys(contactPatch).length > 0) {
    set.billingContact = sql`COALESCE(${organizations.billingContact}, '{}'::jsonb) || ${JSON.stringify(contactPatch)}::jsonb`;
  }
  if (patch.billingAddressLine1 !== undefined) set.billingAddressLine1 = patch.billingAddressLine1;
  if (patch.billingAddressLine2 !== undefined) set.billingAddressLine2 = patch.billingAddressLine2;
  if (patch.billingAddressCity !== undefined) set.billingAddressCity = patch.billingAddressCity;
  if (patch.billingAddressRegion !== undefined) set.billingAddressRegion = patch.billingAddressRegion;
  if (patch.billingAddressPostalCode !== undefined) set.billingAddressPostalCode = patch.billingAddressPostalCode;
  if (patch.billingAddressCountry !== undefined) set.billingAddressCountry = patch.billingAddressCountry;
  const [row] = await db.update(organizations).set(set).where(eq(organizations.id, orgId)).returning({
    id: organizations.id, taxId: organizations.taxId, taxExempt: organizations.taxExempt, taxRate: organizations.taxRate,
    billingContact: organizations.billingContact,
    billingAddressLine1: organizations.billingAddressLine1, billingAddressLine2: organizations.billingAddressLine2,
    billingAddressCity: organizations.billingAddressCity, billingAddressRegion: organizations.billingAddressRegion,
    billingAddressPostalCode: organizations.billingAddressPostalCode, billingAddressCountry: organizations.billingAddressCountry,
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

export async function assembleDraftFromOrg(input: { orgId: string; siteId?: string; from: string; to: string }, actor: InvoiceActor) {
  const partnerId = requirePartner(actor);
  requireOrgAccess(actor, input.orgId);
  requireSiteAccess(actor, input.siteId ?? null);
  const from = new Date(input.from + 'T00:00:00Z');
  const to = new Date(input.to + 'T23:59:59Z');
  const specs = [...(await gatherOrgTimeEntries(input.orgId, from, to)), ...(await gatherOrgParts(input.orgId, from, to))];
  if (specs.length === 0) throw new InvoiceServiceError('No unbilled billable work in range', 409, 'NOTHING_TO_INVOICE');
  const [inv] = await db.insert(invoices).values({ partnerId, orgId: input.orgId, siteId: input.siteId ?? null, status: 'draft', createdBy: actor.userId }).returning();
  await materializeLines(inv!.id, input.orgId, specs);
  await recomputeInvoiceTotals(inv!.id);
  return getInvoice(inv!.id, actor);
}

export async function assembleDraftFromTicket(ticketId: string, actor: InvoiceActor) {
  const partnerId = requirePartner(actor);
  const [tk] = await db.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!tk) throw new InvoiceServiceError('Ticket not found', 404, 'INVOICE_NOT_FOUND');
  requireOrgAccess(actor, tk.orgId);
  // This path produces an org-level (null-site) invoice; a site-restricted caller
  // can never see such a row, so deny it up front rather than orphan an invoice.
  requireSiteAccess(actor, null);
  const specs = await gatherTicketBillables(ticketId);
  if (specs.length === 0) throw new InvoiceServiceError('Nothing billable on this ticket', 409, 'NOTHING_TO_INVOICE');
  const [inv] = await db.insert(invoices).values({ partnerId, orgId: tk.orgId, status: 'draft', createdBy: actor.userId }).returning();
  await materializeLines(inv!.id, tk.orgId, specs);
  await recomputeInvoiceTotals(inv!.id);
  return getInvoice(inv!.id, actor);
}

// ---------------------------------------------------------------------------
// Issue: numbering, double-bill guard, freeze, snapshot, source flip (Task 3.6)
// ---------------------------------------------------------------------------

export async function issueInvoice(invoiceId: string, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  assertDraft(inv);
  requireInvoiceAccess(actor, inv);

  // Gather source rows referenced by lines, for the double-bill guard + flip.
  const lines = await db.select({ id: invoiceLines.id, sourceType: invoiceLines.sourceType, sourceId: invoiceLines.sourceId, customerVisible: invoiceLines.customerVisible }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  if (!lines.some((l) => l.customerVisible)) throw new InvoiceServiceError('Invoice has no customer-visible lines', 409, 'NO_VISIBLE_LINES');
  const timeIds = lines.filter((l) => l.sourceType === 'time_entry' && l.sourceId).map((l) => l.sourceId!) as string[];
  const partIds = lines.filter((l) => l.sourceType === 'part' && l.sourceId).map((l) => l.sourceId!) as string[];

  // Everything below runs in ONE system transaction (withSystemDbAccessContext
  // wraps its callback in baseDb.transaction — db/index.ts:107). The double-bill
  // guard's FOR UPDATE locks, the gapless counter upsert, the number/snapshot
  // write, and the source-row flip are therefore atomic: a failed issue rolls
  // the counter back too (no committed gap), and the source locks are held only
  // for this short system tx. We inline the counter upsert rather than calling
  // allocateInvoiceCounter() — that helper does its own runOutsideDbContext,
  // which would exit THIS transaction and break atomicity (checkpoint 3).
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, inv.orgId)).limit(1);
    const [partner] = await db.select().from(partners).where(eq(partners.id, inv.partnerId)).limit(1);

    // Double-bill guard: re-lock referenced source rows; any already billed → abort.
    if (timeIds.length) {
      const billed = await db.select({ id: timeEntries.id }).from(timeEntries).where(and(inArray(timeEntries.id, timeIds), sql`${timeEntries.billingStatus} <> 'not_billed'`)).for('update');
      if (billed.length) throw new InvoiceServiceError(`Time entries already billed: ${billed.map((b) => b.id).join(', ')}`, 409, 'SOURCE_ALREADY_BILLED');
    }
    if (partIds.length) {
      const billed = await db.select({ id: ticketParts.id }).from(ticketParts).where(and(inArray(ticketParts.id, partIds), sql`${ticketParts.billingStatus} <> 'not_billed'`)).for('update');
      if (billed.length) throw new InvoiceServiceError(`Parts already billed: ${billed.map((b) => b.id).join(', ')}`, 409, 'SOURCE_ALREADY_BILLED');
    }

    const taxRate = resolveEffectiveTaxRate({ taxExempt: org?.taxExempt ?? false, orgRate: org?.taxRate ?? null, partnerRate: partner?.defaultTaxRate ?? null });
    const issueDate = new Date();
    const dueDate = new Date(issueDate.getTime() + (partner?.invoiceTermsDays ?? 30) * 86400000);
    const year = issueDate.getUTCFullYear();

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

    // Recompute totals with the snapshotted rate, then write everything atomically.
    const lineRows = await db.select({ lineTotal: invoiceLines.lineTotal, taxable: invoiceLines.taxable, customerVisible: invoiceLines.customerVisible }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    const { subtotal, taxTotal, total } = computeInvoiceTotals(lineRows, taxRate);
    const billToAddress = buildBillToAddress(org);

    await db.update(invoices).set({
      // status 'sent' is the lifecycle "issued/finalized" state. sentAt is left
      // NULL here on purpose — it means "emailed to the customer" and is stamped
      // only by sendInvoiceEmail. That lets the UI distinguish "Issued" (no email
      // yet) from "Sent" (emailed) instead of mislabeling a plain Issue as Sent.
      status: 'sent', invoiceNumber: number, currencyCode: partner?.currencyCode ?? 'USD',
      issueDate: issueDate.toISOString().slice(0, 10), dueDate: dueDate.toISOString().slice(0, 10),
      taxRate, subtotal, taxTotal, total, balance: total,
      billToName: org?.name ?? null, billToAddress, billToTaxId: org?.taxId ?? null,
      billToTaxExempt: org?.taxExempt ?? false,
      // `terms` is the small footer line (from partner.invoiceFooter); `termsAndConditions`
      // is the labeled Terms & Conditions block (from partner.billingTermsAndConditions).
      terms: partner?.invoiceFooter ?? null,
      sellerSnapshot: buildSellerSnapshot(partner),
      termsAndConditions: inv.termsAndConditions ?? partner?.billingTermsAndConditions ?? null,
      updatedAt: issueDate
    }).where(eq(invoices.id, invoiceId));

    // A since-deleted source row makes its `billed` flip a harmless no-op; the
    // invoice stays self-contained via its immutable snapshot lines, so we don't
    // re-verify the source rows still exist before flipping.
    if (timeIds.length) await db.update(timeEntries).set({ billingStatus: 'billed', updatedAt: issueDate }).where(inArray(timeEntries.id, timeIds));
    if (partIds.length) await db.update(ticketParts).set({ billingStatus: 'billed', updatedAt: issueDate }).where(inArray(ticketParts.id, partIds));
  }));

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
  return getOwnedInvoiceOr404(invoiceId);
}

// ---------------------------------------------------------------------------
// Payments + status recompute (Task 3.7)
// ---------------------------------------------------------------------------

export async function recomputeInvoiceStatus(invoiceId: string): Promise<void> {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  const paidRows = await db.select({ amount: invoicePayments.amount }).from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId));
  const amountPaid = fromCents(paidRows.reduce((s, r) => s + toCents(r.amount), 0));
  const balance = fromCents(toCents(inv.total) - toCents(amountPaid));
  const issued = inv.invoiceNumber !== null;
  const status = deriveInvoiceStatus({ voided: inv.voidedAt !== null, issued, total: inv.total, amountPaid, dueDate: inv.dueDate, asOf: new Date() });
  const patch: Record<string, unknown> = { amountPaid, balance, status, updatedAt: new Date() };
  if (status === 'paid' && inv.paidAt === null) patch.paidAt = new Date();
  if (status === 'overdue' && inv.markedOverdueAt === null) patch.markedOverdueAt = new Date();
  await db.update(invoices).set(patch).where(eq(invoices.id, invoiceId));
}

export async function recordPayment(invoiceId: string, input: RecordPaymentInput, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireInvoiceAccess(actor, inv);
  if (inv.status === 'draft') throw new InvoiceServiceError('Cannot record payment on a draft', 409, 'INVALID_STATE');
  if (inv.status === 'void') throw new InvoiceServiceError('Cannot record payment on a void invoice', 409, 'INVALID_STATE');
  // Exact integer-cents comparison — robust against float representation error.
  if (Math.round(Number(input.amount) * 100) > Math.round(Number(inv.balance) * 100)) {
    throw new InvoiceServiceError('Payment exceeds balance', 400, 'OVERPAYMENT');
  }
  const [payment] = await db.insert(invoicePayments).values({
    invoiceId, orgId: inv.orgId, amount: Number(input.amount).toFixed(2), method: input.method,
    reference: input.reference ?? null, receivedAt: input.receivedAt, recordedBy: actor.userId, note: input.note ?? null
  }).returning();
  await recomputeInvoiceStatus(invoiceId);
  await emitInvoiceEvent({ type: 'payment.recorded', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, paymentId: payment!.id, actorUserId: actor.userId });
  const updated = await getOwnedInvoiceOr404(invoiceId);
  if (updated.status === 'paid') await emitInvoiceEvent({ type: 'invoice.paid', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, actorUserId: actor.userId });
  // Surface the persisted payment alongside the refreshed invoice so the route
  // can write a durable audit_logs entry for this money-path mutation. The
  // emitInvoiceEvent bus above is intentionally unconsumed and is NOT the
  // durable chain.
  return {
    invoice: updated,
    audit: {
      orgId: inv.orgId,
      paymentId: payment!.id,
      invoiceId,
      amount: payment!.amount,
      method: payment!.method,
      reference: payment!.reference,
      recordedBy: payment!.recordedBy,
    },
  };
}

export async function voidPayment(paymentId: string, actor: InvoiceActor) {
  const [pay] = await db.select().from(invoicePayments).where(eq(invoicePayments.id, paymentId)).limit(1);
  if (!pay) throw new InvoiceServiceError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
  // The payment row carries orgId but not siteId; load the parent invoice so the
  // site-axis guard runs against the invoice's site (a site-restricted caller must
  // not void a payment on an out-of-site invoice).
  const parentInv = await getOwnedInvoiceOr404(pay.invoiceId);
  requireInvoiceAccess(actor, parentInv);
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
  await db.delete(invoicePayments).where(eq(invoicePayments.id, paymentId));
  await recomputeInvoiceStatus(pay.invoiceId);
  const inv = await getOwnedInvoiceOr404(pay.invoiceId);
  await emitInvoiceEvent({ type: 'payment.voided', invoiceId: pay.invoiceId, orgId: pay.orgId, partnerId: inv.partnerId, paymentId, actorUserId: actor.userId });
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
  return rows.map((r) => ({ ...r, source: stripeIds.has(r.id) ? ('stripe' as const) : ('manual' as const) }));
}

// ---------------------------------------------------------------------------
// Void + reissue + overdue sweep + viewed (Task 3.8)
// ---------------------------------------------------------------------------

export async function voidInvoice(invoiceId: string, reason: string, opts: { reissue?: boolean }, actor: InvoiceActor) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireInvoiceAccess(actor, inv);
  if (inv.status === 'draft') throw new InvoiceServiceError('Delete drafts instead of voiding', 409, 'INVALID_STATE');
  if (inv.status === 'void') throw new InvoiceServiceError('Already void', 409, 'INVALID_STATE');

  const lines = await db.select({ sourceType: invoiceLines.sourceType, sourceId: invoiceLines.sourceId }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  const timeIds = lines.filter((l) => l.sourceType === 'time_entry' && l.sourceId).map((l) => l.sourceId!) as string[];
  const partIds = lines.filter((l) => l.sourceType === 'part' && l.sourceId).map((l) => l.sourceId!) as string[];

  // Void + (optional) reissue commit atomically in ONE system transaction: the
  // void/release and the fresh-draft clone must not be observable independently.
  let draftId: string | null = null;
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const now = new Date();
    await db.update(invoices).set({ status: 'void', voidedAt: now, voidReason: reason, updatedAt: now }).where(eq(invoices.id, invoiceId));
    // release source rows so they can be re-invoiced
    if (timeIds.length) await db.update(timeEntries).set({ billingStatus: 'not_billed', updatedAt: now }).where(inArray(timeEntries.id, timeIds));
    if (partIds.length) await db.update(ticketParts).set({ billingStatus: 'not_billed', updatedAt: now }).where(inArray(ticketParts.id, partIds));

    if (!opts.reissue) return;
    // Clone source-backed lines into a fresh draft (released rows are not_billed again).
    const [draft] = await db.insert(invoices).values({ partnerId: inv.partnerId, orgId: inv.orgId, siteId: inv.siteId, status: 'draft', notes: inv.notes, replacesInvoiceId: invoiceId, createdBy: actor.userId }).returning();
    draftId = draft!.id;
    await db.update(invoices).set({ replacedByInvoiceId: draft!.id }).where(eq(invoices.id, invoiceId));
    const srcLines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder);

    // Two-pass clone to preserve bundle hierarchy: insert parents (parentLineId IS
    // NULL) first, map old line id → new line id, then insert children with their
    // parentLineId remapped to the cloned parent.
    const cloneValues = (l: typeof srcLines[number], parentLineId: string | null) => ({
      invoiceId: draft!.id, orgId: l.orgId, sourceType: l.sourceType, sourceId: l.sourceId, catalogItemId: l.catalogItemId,
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

  await emitInvoiceEvent({ type: 'invoice.voided', invoiceId, orgId: inv.orgId, partnerId: inv.partnerId, actorUserId: actor.userId });

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
      .where(and(inArray(invoices.status, ['sent', 'partially_paid'] as never), lt(invoices.dueDate, today), sql`${invoices.balance} > 0`));
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
