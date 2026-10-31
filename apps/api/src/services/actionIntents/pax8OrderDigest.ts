/** W15: local inputs of one Pax8 submit. Reads only through the supplied transaction. */
import { createHash } from 'node:crypto';
import { and, asc, eq, type AnyColumn } from 'drizzle-orm';
import type { Database } from '../../db';
import {
  catalogItemOrgPricing, catalogItemPrices, catalogItems, contractLines, contracts,
  pax8CompanyMappings, pax8ContractLineLinks, pax8Integrations, pax8OrderLines,
  pax8Orders, pax8ProductMappings, pax8SubscriptionSnapshots,
} from '../../db/schema';
import { snapshotActiveCommitmentEvidence } from '../pax8OrderService';
import { pax8CompanyOrderReadiness } from '../pax8CompanyReadiness';
import { isSubmittableStatus } from '../pax8OrderTypes';
import { canonicalizeArguments } from './canonicalize';

export const PAX8_ORDER_MATERIAL_VERSION = 1 as const;
type ContractLineMaterial = Pick<typeof contractLines.$inferSelect, 'id' | 'contractId' | 'manualQuantity' | 'unitPrice' | 'lineType' | 'catalogItemId'>;
type ContractMaterial = Pick<typeof contracts.$inferSelect, 'id' | 'currencyCode'>;
type OrderLineMaterial = Pick<typeof pax8OrderLines.$inferSelect,
  'id' | 'sortOrder' | 'action' | 'submitState' | 'pax8ProductId' | 'catalogItemId' | 'billingTerm' |
  'commitmentTermId' | 'quantity' | 'authorizedBaselineQuantity' | 'targetSubscriptionId' | 'cancelDate' |
  'contractLineId' | 'provisioningDetails'>;
type SnapshotProjection = Pick<typeof pax8SubscriptionSnapshots.$inferSelect,
  'id' | 'quantity' | 'quantityKnown' | 'unitCost' | 'unitPrice' | 'currencyCode' | 'status' | 'orgId' |
  'productId' | 'productName' | 'vendorSkuId' | 'billingTerm' | 'raw'>;
type SnapshotMaterial = Omit<SnapshotProjection, 'raw'> & {
  activeCommitment: ReturnType<typeof snapshotActiveCommitmentEvidence>;
};
type ProductMaterial = Pick<typeof pax8ProductMappings.$inferSelect, 'pax8ProductId' | 'productName' | 'vendorSkuId' | 'catalogItemId'>;
type CatalogMaterial = Pick<typeof catalogItems.$inferSelect, 'id' | 'isActive' | 'costBasis' | 'costCurrency' | 'taxable' | 'taxCategory'>;
type PriceMaterial = Pick<typeof catalogItemPrices.$inferSelect, 'unitPrice' | 'currencyCode'>;
type LinkMaterial = Pick<typeof pax8ContractLineLinks.$inferSelect, 'contractLineId' | 'syncEnabled'>;
type GenerationProjection = Pick<typeof pax8Integrations.$inferSelect,
  'id' | 'partnerId' | 'isActive' | 'apiBaseUrl' | 'tokenUrl' | 'clientIdEncrypted' | 'clientSecretEncrypted'>;
export type Pax8IntegrationGeneration = Omit<GenerationProjection, 'clientIdEncrypted' | 'clientSecretEncrypted'> & { credentialGeneration: string };
export const pax8CredentialGeneration = (generation: Pick<GenerationProjection, 'clientIdEncrypted' | 'clientSecretEncrypted'>): string =>
  createHash('sha256').update(canonicalizeArguments({
    clientId: generation.clientIdEncrypted, clientSecret: generation.clientSecretEncrypted,
  })).digest('hex');
type CompanyProjection = Pick<typeof pax8CompanyMappings.$inferSelect, 'pax8CompanyId' | 'status' | 'ignored' | 'orgId' | 'metadata'> & { name: string };
type CompanyMaterial = Omit<CompanyProjection, 'metadata'> & { readiness: ReturnType<typeof pax8CompanyOrderReadiness> };
export interface Pax8OrderMaterial {
  id: string;
  partnerId: string;
  orgId: string;
  integrationId: string;
  source: string;
  sourceQuoteId: string | null;
  submittable: boolean;
  pax8CompanyId: string | null;
  mappings: CompanyMaterial[];
  integration: Pax8IntegrationGeneration | null;
  lines: Array<OrderLineMaterial & {
    contractLine: ContractLineMaterial | null;
    contract: ContractMaterial | null;
    snapshot: SnapshotMaterial | null;
    link: LinkMaterial | null;
    productMapping: ProductMaterial | null;
    catalog: Array<{ itemId: string; item: CatalogMaterial | null; price: PriceMaterial | null; orgPrice: PriceMaterial | null }>;
  }>;
}
export const serializePax8OrderMaterial = (order: Pax8OrderMaterial): string =>
  canonicalizeArguments({ v: PAX8_ORDER_MATERIAL_VERSION, order });
export const hashPax8OrderMaterial = (order: Pax8OrderMaterial): string =>
  createHash('sha256').update(serializePax8OrderMaterial(order)).digest('hex');

export async function pax8OrderDigestMaterial(
  database: Pick<Database, 'select'>,
  orderId: string,
): Promise<Pax8OrderMaterial | null> {
  const [order] = await database.select({
    id: pax8Orders.id, partnerId: pax8Orders.partnerId, orgId: pax8Orders.orgId,
    integrationId: pax8Orders.integrationId, source: pax8Orders.source,
    sourceQuoteId: pax8Orders.sourceQuoteId, status: pax8Orders.status,
  } satisfies Record<keyof Pick<typeof pax8Orders.$inferSelect, 'id' | 'partnerId' | 'orgId' | 'integrationId' | 'source' | 'sourceQuoteId' | 'status'>, AnyColumn>).from(pax8Orders).where(eq(pax8Orders.id, orderId)).limit(1);
  if (!order) return null;

  const rows = await database.select({
    id: pax8OrderLines.id, sortOrder: pax8OrderLines.sortOrder, action: pax8OrderLines.action,
    submitState: pax8OrderLines.submitState, pax8ProductId: pax8OrderLines.pax8ProductId,
    catalogItemId: pax8OrderLines.catalogItemId, billingTerm: pax8OrderLines.billingTerm,
    commitmentTermId: pax8OrderLines.commitmentTermId, quantity: pax8OrderLines.quantity,
    authorizedBaselineQuantity: pax8OrderLines.authorizedBaselineQuantity,
    targetSubscriptionId: pax8OrderLines.targetSubscriptionId, cancelDate: pax8OrderLines.cancelDate,
    contractLineId: pax8OrderLines.contractLineId, provisioningDetails: pax8OrderLines.provisioningDetails,
  } satisfies Record<keyof OrderLineMaterial, AnyColumn>).from(pax8OrderLines).where(and(
    eq(pax8OrderLines.orderId, order.id), eq(pax8OrderLines.partnerId, order.partnerId),
    eq(pax8OrderLines.orgId, order.orgId),
  )).orderBy(asc(pax8OrderLines.sortOrder), asc(pax8OrderLines.id));

  const companies = await database.select({
    pax8CompanyId: pax8CompanyMappings.pax8CompanyId, name: pax8CompanyMappings.pax8CompanyName,
    status: pax8CompanyMappings.status, ignored: pax8CompanyMappings.ignored,
    orgId: pax8CompanyMappings.orgId, metadata: pax8CompanyMappings.metadata,
  } satisfies Record<keyof CompanyProjection, AnyColumn>).from(pax8CompanyMappings).where(and(
    eq(pax8CompanyMappings.integrationId, order.integrationId),
    eq(pax8CompanyMappings.partnerId, order.partnerId), eq(pax8CompanyMappings.orgId, order.orgId),
    eq(pax8CompanyMappings.ignored, false),
  )).orderBy(asc(pax8CompanyMappings.pax8CompanyId));
  const mappings = companies.map(({ metadata, ...company }) => ({
    ...company, readiness: pax8CompanyOrderReadiness(company.status, metadata),
  }));
  const company = mappings.length === 1 && mappings[0]!.readiness.orderReady ? mappings[0]! : null;

  const [generation] = await database.select({
    id: pax8Integrations.id, partnerId: pax8Integrations.partnerId, isActive: pax8Integrations.isActive,
    apiBaseUrl: pax8Integrations.apiBaseUrl, tokenUrl: pax8Integrations.tokenUrl,
    clientIdEncrypted: pax8Integrations.clientIdEncrypted, clientSecretEncrypted: pax8Integrations.clientSecretEncrypted,
  } satisfies Record<keyof GenerationProjection, AnyColumn>).from(pax8Integrations).where(and(
    eq(pax8Integrations.id, order.integrationId), eq(pax8Integrations.partnerId, order.partnerId),
  )).limit(1);
  const integration = generation ? {
    id: generation.id, partnerId: generation.partnerId, isActive: generation.isActive,
    apiBaseUrl: generation.apiBaseUrl, tokenUrl: generation.tokenUrl,
    credentialGeneration: pax8CredentialGeneration(generation),
  } : null;

  const lines = [];
  for (const line of rows) {
    const [contractLine] = line.contractLineId ? await database.select({
      id: contractLines.id, contractId: contractLines.contractId, manualQuantity: contractLines.manualQuantity,
      unitPrice: contractLines.unitPrice, lineType: contractLines.lineType, catalogItemId: contractLines.catalogItemId,
    } satisfies Record<keyof ContractLineMaterial, AnyColumn>).from(contractLines).where(and(
      eq(contractLines.id, line.contractLineId), eq(contractLines.orgId, order.orgId),
    )).limit(1) : [];
    const [contract] = contractLine ? await database.select({
      id: contracts.id, currencyCode: contracts.currencyCode,
    } satisfies Record<keyof ContractMaterial, AnyColumn>).from(contracts).where(and(
      eq(contracts.id, contractLine.contractId), eq(contracts.orgId, order.orgId),
      eq(contracts.partnerId, order.partnerId),
    )).limit(1) : [];
    const [snapshotRow] = line.targetSubscriptionId ? await database.select({
      id: pax8SubscriptionSnapshots.id, quantity: pax8SubscriptionSnapshots.quantity,
      quantityKnown: pax8SubscriptionSnapshots.quantityKnown, unitCost: pax8SubscriptionSnapshots.unitCost,
      unitPrice: pax8SubscriptionSnapshots.unitPrice, currencyCode: pax8SubscriptionSnapshots.currencyCode,
      status: pax8SubscriptionSnapshots.status, orgId: pax8SubscriptionSnapshots.orgId,
      productId: pax8SubscriptionSnapshots.productId, productName: pax8SubscriptionSnapshots.productName,
      vendorSkuId: pax8SubscriptionSnapshots.vendorSkuId, billingTerm: pax8SubscriptionSnapshots.billingTerm,
      raw: pax8SubscriptionSnapshots.raw,
    } satisfies Record<keyof SnapshotProjection, AnyColumn>).from(pax8SubscriptionSnapshots).where(and(
      eq(pax8SubscriptionSnapshots.integrationId, order.integrationId),
      eq(pax8SubscriptionSnapshots.partnerId, order.partnerId), eq(pax8SubscriptionSnapshots.orgId, order.orgId),
      eq(pax8SubscriptionSnapshots.pax8SubscriptionId, line.targetSubscriptionId),
    )).limit(1) : [];
    const snapshot = snapshotRow ? (() => {
      const { raw, ...local } = snapshotRow;
      return { ...local, activeCommitment: snapshotActiveCommitmentEvidence(raw) };
    })() : null;
    const [link] = snapshot ? await database.select({
      contractLineId: pax8ContractLineLinks.contractLineId, syncEnabled: pax8ContractLineLinks.syncEnabled,
    } satisfies Record<keyof LinkMaterial, AnyColumn>).from(pax8ContractLineLinks).where(and(
      eq(pax8ContractLineLinks.subscriptionSnapshotId, snapshot.id),
      eq(pax8ContractLineLinks.integrationId, order.integrationId),
      eq(pax8ContractLineLinks.partnerId, order.partnerId), eq(pax8ContractLineLinks.orgId, order.orgId),
    )).limit(1) : [];
    const productId = line.pax8ProductId ?? snapshot?.productId;
    // All actions pin the display name too: the claim-time check also binds the approval card's assertions.
    const [productMapping] = productId ? await database.select({
      pax8ProductId: pax8ProductMappings.pax8ProductId, productName: pax8ProductMappings.productName,
      vendorSkuId: pax8ProductMappings.vendorSkuId, catalogItemId: pax8ProductMappings.catalogItemId,
    } satisfies Record<keyof ProductMaterial, AnyColumn>).from(pax8ProductMappings).where(and(
      eq(pax8ProductMappings.integrationId, order.integrationId), eq(pax8ProductMappings.partnerId, order.partnerId),
      eq(pax8ProductMappings.pax8ProductId, productId),
    )).limit(1) : [];
    const itemIds = [...new Set([line.catalogItemId, contractLine?.catalogItemId, productMapping?.catalogItemId]
      .filter((id): id is string => typeof id === 'string'))].sort();
    const catalog = [];
    for (const itemId of itemIds) {
      const [item] = await database.select({
        // Price resolution uses cost/currency/tax fields; pin identity and availability too.
        // Catalog description, SKU and billing metadata are not shown on the approval or sent to Pax8.
        id: catalogItems.id, isActive: catalogItems.isActive,
        costBasis: catalogItems.costBasis, costCurrency: catalogItems.costCurrency,
        taxable: catalogItems.taxable, taxCategory: catalogItems.taxCategory,
      } satisfies Record<keyof CatalogMaterial, AnyColumn>).from(catalogItems).where(and(eq(catalogItems.id, itemId), eq(catalogItems.partnerId, order.partnerId))).limit(1);
      const [price] = contract ? await database.select({
        unitPrice: catalogItemPrices.unitPrice, currencyCode: catalogItemPrices.currencyCode,
      } satisfies Record<keyof PriceMaterial, AnyColumn>).from(catalogItemPrices).where(and(
        eq(catalogItemPrices.itemId, itemId), eq(catalogItemPrices.partnerId, order.partnerId),
        eq(catalogItemPrices.currencyCode, contract.currencyCode),
      )).limit(1) : [];
      const [orgPrice] = contract ? await database.select({
        unitPrice: catalogItemOrgPricing.unitPrice, currencyCode: catalogItemOrgPricing.currencyCode,
      } satisfies Record<keyof PriceMaterial, AnyColumn>).from(catalogItemOrgPricing).where(and(
        eq(catalogItemOrgPricing.catalogItemId, itemId), eq(catalogItemOrgPricing.partnerId, order.partnerId),
        eq(catalogItemOrgPricing.orgId, order.orgId),
      )).limit(1) : [];
      catalog.push({ itemId, item: item ?? null, price: price ?? null, orgPrice: orgPrice ?? null });
    }
    lines.push({
      ...line,
      // A staged quantity change already carries its authorization baseline, which validation must preserve.
      // B1 newly captures new/cancel baselines at claim time: normalize only those pre-capture values.
      authorizedBaselineQuantity: line.action === 'change_quantity'
        ? line.authorizedBaselineQuantity : contractLine?.manualQuantity ?? null,
      contractLine: contractLine ?? null, contract: contract ?? null, snapshot, link: link ?? null,
      productMapping: productMapping ?? null, catalog,
    });
  }
  // The claim's own parent transition is not content drift. Only a provably unsent submitting bundle is
  // equivalent here; submit's CAS still refuses every re-delivery before any HTTP can run.
  const submittable = isSubmittableStatus(order.status)
    || (order.status === 'submitting' && rows.length > 0 && rows.every(line => line.submitState === 'pending'));
  return {
    id: order.id, partnerId: order.partnerId, orgId: order.orgId, integrationId: order.integrationId,
    source: order.source, sourceQuoteId: order.sourceQuoteId, submittable,
    pax8CompanyId: company?.pax8CompanyId ?? null, mappings, integration, lines,
  };
}
