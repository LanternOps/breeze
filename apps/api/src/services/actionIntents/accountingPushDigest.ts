/**
 * Effect-digest material for `manage_accounting_sync` push / push_bulk
 * (full-control W14 PR B, #6784; PR B quorum QB4).
 *
 * A push sends the invoice — and, when they are not yet synced, its customer
 * and the catalog items its lines reference — into the partner's QuickBooks or
 * Xero books (accountingInvoicePush.ts). So the pin covers every input of that
 * effect, not only the invoice revision:
 *  - the invoice header and its lines (issued lines are frozen, but status,
 *    payments and totals still move);
 *  - the destination: the partner's active connection identity (row, provider,
 *    status, realm fingerprint) and the settings the payload applies (income
 *    account, tax codes, home currency) — never a token column;
 *  - the mapping rows the push reads or writes: the invoice's own (update vs
 *    create), the org's and each line item's (link / sync state, remote id);
 *  - the customer's and items' own payload inputs (org name, billing contact and
 *    address; item name / SKU / tax flag and the price-book rows in the invoice
 *    currency, whose edits do not bump `catalog_items.updated_at`).
 * Absent rows pin as null, so a row that appears or disappears under the
 * approval changes the digest too.
 *
 * Reads run through the caller's `database` (the creation transaction or a
 * release context — system-scoped, like every resolver in effectDigest.ts).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db';
import {
  accountingConnections, accountingEntityMappings, catalogItemOrgPricing, catalogItemPrices, catalogItems,
  invoiceLines, invoices, organizations,
} from '../../db/schema';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export async function accountingPushMaterial(
  database: Database,
  invoiceId: string,
  provider: string,
): Promise<Record<string, unknown> | null> {
  const [inv] = await database.select({
    id: invoices.id, orgId: invoices.orgId, partnerId: invoices.partnerId, status: invoices.status,
    invoiceNumber: invoices.invoiceNumber, currencyCode: invoices.currencyCode,
    subtotal: invoices.subtotal, taxTotal: invoices.taxTotal, total: invoices.total,
    amountPaid: invoices.amountPaid, updatedAt: invoices.updatedAt,
  }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!inv) return null;

  const lines = await database.select({
    id: invoiceLines.id, catalogItemId: invoiceLines.catalogItemId, quantity: invoiceLines.quantity,
    unitPrice: invoiceLines.unitPrice, lineTotal: invoiceLines.lineTotal, taxable: invoiceLines.taxable,
    customerVisible: invoiceLines.customerVisible,
  }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.id));

  // The partner's connection(s) for this provider: identity and payload settings only.
  const connections = await database.select({
    id: accountingConnections.id, provider: accountingConnections.provider, status: accountingConnections.status,
    realmIdFingerprint: accountingConnections.realmIdFingerprint, homeCurrency: accountingConnections.homeCurrency,
    multiCurrencyEnabled: accountingConnections.multiCurrencyEnabled,
    defaultIncomeAccountRef: accountingConnections.defaultIncomeAccountRef,
    defaultTaxCodeRef: accountingConnections.defaultTaxCodeRef,
    defaultExemptTaxCodeRef: accountingConnections.defaultExemptTaxCodeRef,
  }).from(accountingConnections)
    .where(and(eq(accountingConnections.partnerId, inv.partnerId), eq(accountingConnections.provider, provider)))
    .orderBy(asc(accountingConnections.id));

  const itemIds = [...new Set(lines.map((l) => l.catalogItemId).filter((id): id is string => id !== null))].sort();
  const entityIds = [inv.id, inv.orgId, ...itemIds];
  const mappings = connections.length === 0 ? [] : await database.select({
    integrationId: accountingEntityMappings.integrationId, breezeEntityType: accountingEntityMappings.breezeEntityType,
    breezeEntityId: accountingEntityMappings.breezeEntityId, remoteEntityId: accountingEntityMappings.remoteEntityId,
    linkStatus: accountingEntityMappings.linkStatus, syncStatus: accountingEntityMappings.syncStatus,
  }).from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.partnerId, inv.partnerId),
      inArray(accountingEntityMappings.integrationId, connections.map((c) => c.id)),
      inArray(accountingEntityMappings.breezeEntityId, entityIds),
    ))
    .orderBy(asc(accountingEntityMappings.breezeEntityType), asc(accountingEntityMappings.breezeEntityId), asc(accountingEntityMappings.integrationId));

  const [org] = await database.select({
    name: organizations.name, billingContact: organizations.billingContact, taxId: organizations.taxId,
    currencyCode: organizations.currencyCode, updatedAt: organizations.updatedAt,
    billingAddressLine1: organizations.billingAddressLine1, billingAddressLine2: organizations.billingAddressLine2,
    billingAddressCity: organizations.billingAddressCity, billingAddressRegion: organizations.billingAddressRegion,
    billingAddressPostalCode: organizations.billingAddressPostalCode, billingAddressCountry: organizations.billingAddressCountry,
  }).from(organizations).where(eq(organizations.id, inv.orgId)).limit(1);

  const items = itemIds.length === 0 ? [] : await database.select({
    id: catalogItems.id, name: catalogItems.name, sku: catalogItems.sku, description: catalogItems.description,
    taxable: catalogItems.taxable, isActive: catalogItems.isActive, updatedAt: catalogItems.updatedAt,
  }).from(catalogItems).where(inArray(catalogItems.id, itemIds)).orderBy(asc(catalogItems.id));
  const prices = itemIds.length === 0 ? [] : await database.select({
    itemId: catalogItemPrices.itemId, unitPrice: catalogItemPrices.unitPrice, updatedAt: catalogItemPrices.updatedAt,
  }).from(catalogItemPrices)
    .where(and(inArray(catalogItemPrices.itemId, itemIds), eq(catalogItemPrices.currencyCode, inv.currencyCode)))
    .orderBy(asc(catalogItemPrices.itemId));
  const orgPrices = itemIds.length === 0 ? [] : await database.select({
    itemId: catalogItemOrgPricing.catalogItemId, unitPrice: catalogItemOrgPricing.unitPrice,
    currencyCode: catalogItemOrgPricing.currencyCode, updatedAt: catalogItemOrgPricing.updatedAt,
  }).from(catalogItemOrgPricing)
    .where(and(inArray(catalogItemOrgPricing.catalogItemId, itemIds), eq(catalogItemOrgPricing.orgId, inv.orgId)))
    .orderBy(asc(catalogItemOrgPricing.catalogItemId));

  return {
    invoice: { ...inv, updatedAt: iso(inv.updatedAt) },
    lines,
    connections,
    mappings,
    org: org ? { ...org, updatedAt: iso(org.updatedAt) } : null,
    items: items.map((i) => ({ ...i, updatedAt: iso(i.updatedAt) })),
    prices: prices.map((p) => ({ ...p, updatedAt: iso(p.updatedAt) })),
    orgPrices: orgPrices.map((p) => ({ ...p, updatedAt: iso(p.updatedAt) })),
  };
}
