/** Read-only Pax8 ordering evidence. Product-id-only HTTP runs outside DB contexts. */
import { and, eq } from 'drizzle-orm';
import { PAX8_BILLING_TERMS, type Pax8BillingTerm, type Pax8OrderAction, type Pax8OrderStatus } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext } from '../db';
import { contracts, contractLines, pax8CompanyMappings, pax8ProductMappings, pax8SubscriptionSnapshots } from '../db/schema';
import { pax8OrderDigestMaterial, hashPax8OrderMaterial } from './actionIntents/pax8OrderDigest';
import type { z } from 'zod';
import type { pax8SubmitAssertionsSchema } from './aiToolSchemasPax8';
import { isSubmittableStatus } from './pax8OrderTypes';
import { getOrderWithLines, snapshotActiveCommitmentEvidence } from './pax8OrderService';
import { createPax8ClientForIntegration } from './pax8SyncService';
import { pax8CompanyOrderReadiness } from './pax8CompanyReadiness';
import { CatalogServiceError, resolvePrice } from './catalogService';
import { computeInvoiceTotals, computeLineTotal } from './invoiceMath';
import type { Pax8Client, Pax8Commitment } from './pax8Client';

export interface Pax8PreviewLine {
  lineId: string;
  action: Pax8OrderAction;
  pax8ProductId: string | null;
  productName: string | null;
  vendorSkuId: string | null;
  quantity: string | null;
  fromQuantity: string | null;
  billingTerm: Pax8BillingTerm | null;
  commitmentTerm: string | null;
  unitCost: string | null;
  currency: string | null;
  sellUnitPrice: string | null;
  sellCurrency: string | null;
  contractLineId: string | null;
  allowForQuantityIncrease: boolean | null;
  allowForQuantityDecrease: boolean | null;
  allowForEarlyCancellation: boolean | null;
  cancellationFeeApplied: boolean | null;
}

export const PREVIEW_FIELD_SOURCE = {
  lineId: 'material', action: 'material', pax8ProductId: 'material', productName: 'material',
  vendorSkuId: 'material', quantity: 'derived', fromQuantity: 'material', billingTerm: 'material',
  commitmentTerm: 'vendor-live', unitCost: 'derived', currency: 'derived', sellUnitPrice: 'material',
  sellCurrency: 'material', contractLineId: 'material', allowForQuantityIncrease: 'vendor-live',
  allowForQuantityDecrease: 'vendor-live', allowForEarlyCancellation: 'vendor-live', cancellationFeeApplied: 'vendor-live',
} as const satisfies Record<keyof Pax8PreviewLine, 'material' | 'vendor-live' | 'derived'>;

export type Pax8PreviewBlocker =
  | { code: 'CONTRACT_LINE_MISSING'; lineId: string }
  | { code: 'COST_UNKNOWN'; lineId: string }
  | { code: 'TERM_UNKNOWN'; lineId: string }
  | { code: 'QUANTITY_UNKNOWN'; lineId: string }
  | { code: 'COMMITMENT_AMBIGUOUS'; lineId: string }
  | { code: 'SUBSCRIPTION_NOT_FOUND'; lineId: string }
  | { code: 'PRODUCT_UNKNOWN'; lineId: string }
  | { code: 'TOO_MANY_LINES'; lineId?: never }
  | { code: 'NOT_PENDING'; lineId?: string }
  | { code: 'COMPANY_UNRESOLVED'; lineId?: never };

export interface Pax8OrderPreview {
  order: { id: string; orgId: string; source: string; status: Pax8OrderStatus };
  company: { pax8CompanyId: string; name: string } | null;
  lines: Pax8PreviewLine[];
  totals: Array<{ currency: string; billingTerm: Pax8BillingTerm; partnerCost: string }>;
  totalsComplete: boolean;
  blocked: Pax8PreviewBlocker[];
  previewDigest: string | null;
  submitWith?: z.infer<typeof pax8SubmitAssertionsSchema> & { orderId: string };
}

export const MAX_PAX8_PREVIEW_LINES = 20;
const billingTerms: ReadonlySet<string> = new Set(PAX8_BILLING_TERMS);
const asBillingTerm = (value: string | null): Pax8BillingTerm | null =>
  value !== null && billingTerms.has(value) ? value as Pax8BillingTerm : null;
const normalized = (value: string | null) => value?.trim().toLowerCase() ?? null;
const usableCost = (value: string | null | undefined): value is string => value != null && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
const usableQuantity = (value: string | null, action: string): value is string =>
  value !== null && /^\d{1,10}(?:\.\d{1,2})?$/.test(value)
  && (action === 'new_subscription' ? Number(value) > 0 : Number(value) >= 0);

export async function previewPax8Order(input: {
  partnerId: string;
  orderId: string;
  client?: Pax8Client;
}): Promise<Pax8OrderPreview> {
  // Defensively escape an accidental ambient caller before opening the short read transaction.
  const local = await runOutsideDbContext(() => withDbAccessContext({
    scope: 'partner', orgId: null, accessibleOrgIds: null,
    accessiblePartnerIds: [input.partnerId], userId: null, currentPartnerId: input.partnerId,
  }, async () => {
    const bundle = await getOrderWithLines(input);
    const { order } = bundle;
    const companies = await db.select({
      pax8CompanyId: pax8CompanyMappings.pax8CompanyId,
      pax8CompanyName: pax8CompanyMappings.pax8CompanyName,
      status: pax8CompanyMappings.status, metadata: pax8CompanyMappings.metadata,
    }).from(pax8CompanyMappings).where(and(
      eq(pax8CompanyMappings.partnerId, input.partnerId),
      eq(pax8CompanyMappings.integrationId, order.integrationId),
      eq(pax8CompanyMappings.orgId, order.orgId), eq(pax8CompanyMappings.ignored, false),
    ));
    const evidence = [];
    for (const line of bundle.lines) {
      const [snapshot] = line.targetSubscriptionId ? await db.select({
        productId: pax8SubscriptionSnapshots.productId,
        productName: pax8SubscriptionSnapshots.productName,
        vendorSkuId: pax8SubscriptionSnapshots.vendorSkuId,
        unitCost: pax8SubscriptionSnapshots.unitCost,
        currencyCode: pax8SubscriptionSnapshots.currencyCode,
        billingTerm: pax8SubscriptionSnapshots.billingTerm,
        raw: pax8SubscriptionSnapshots.raw,
      }).from(pax8SubscriptionSnapshots).where(and(
        eq(pax8SubscriptionSnapshots.partnerId, input.partnerId),
        eq(pax8SubscriptionSnapshots.integrationId, order.integrationId),
        eq(pax8SubscriptionSnapshots.orgId, order.orgId),
        eq(pax8SubscriptionSnapshots.pax8SubscriptionId, line.targetSubscriptionId),
      )).limit(1) : [];
      const productId = line.pax8ProductId ?? snapshot?.productId ?? null;
      const [mapping] = productId ? await db.select({
        productName: pax8ProductMappings.productName, vendorSkuId: pax8ProductMappings.vendorSkuId,
      }).from(pax8ProductMappings).where(and(
        eq(pax8ProductMappings.partnerId, input.partnerId),
        eq(pax8ProductMappings.integrationId, order.integrationId),
        eq(pax8ProductMappings.pax8ProductId, productId),
      )).limit(1) : [];
      let contractLineMissing = false;
      let baseline = line.authorizedBaselineQuantity;
      let sellUnitPrice: string | null = null;
      let sellCurrency: string | null = null;
      if (line.contractLineId) {
        const [contractLine] = await db.select({
          contractId: contractLines.contractId, catalogItemId: contractLines.catalogItemId,
          unitPrice: contractLines.unitPrice, manualQuantity: contractLines.manualQuantity,
        }).from(contractLines).where(and(
          eq(contractLines.id, line.contractLineId), eq(contractLines.orgId, order.orgId),
        )).limit(1);
        contractLineMissing = !contractLine;
        if (contractLine) {
          baseline = contractLine.manualQuantity;
          const [contract] = await db.select({
            currencyCode: contracts.currencyCode, createdBy: contracts.createdBy,
          }).from(contracts).where(and(
            eq(contracts.id, contractLine.contractId), eq(contracts.orgId, order.orgId),
            eq(contracts.partnerId, input.partnerId),
          )).limit(1);
          if (contract) {
            sellCurrency = contract.currencyCode;
            sellUnitPrice = Number(contractLine.unitPrice).toFixed(2);
            if (contractLine.catalogItemId) {
              try {
                sellUnitPrice = (await resolvePrice(contractLine.catalogItemId, contract.currencyCode, order.orgId, {
                  userId: contract.createdBy, partnerId: input.partnerId, accessibleOrgIds: [order.orgId],
                })).unitPrice;
              } catch (error) {
                // Exactly the invoice generator's price-book-gap fallback.
                if (!(error instanceof CatalogServiceError
                  && (error.code === 'NO_PRICE_FOR_CURRENCY' || error.code === 'PRICE_NOT_REPRESENTABLE'))) throw error;
              }
            }
          }
        }
      }
      evidence.push({ line, snapshot, mapping, productId, sellUnitPrice, sellCurrency, baseline, contractLineMissing });
    }
    const material = await pax8OrderDigestMaterial(db, order.id);
    return { ...bundle, companies, evidence, previewDigest: material ? hashPax8OrderMaterial(material) : null };
  }, { isolationLevel: 'repeatable read' }));

  const { order, previewDigest } = local;
  const blocked: Pax8OrderPreview['blocked'] = [];
  const mapping = local.companies.length === 1 ? local.companies[0]! : null;
  const company = mapping && pax8CompanyOrderReadiness(mapping.status, mapping.metadata).orderReady
    ? { pax8CompanyId: mapping.pax8CompanyId, name: mapping.pax8CompanyName } : null;
  if (!company) blocked.push({ code: 'COMPANY_UNRESOLVED' });
  if (local.lines.length > MAX_PAX8_PREVIEW_LINES) blocked.push({ code: 'TOO_MANY_LINES' });
  // The persisted action/status vocabularies are constrained by DB CHECKs.
  const status = order.status as Pax8OrderStatus;
  if (!isSubmittableStatus(status)) blocked.push({ code: 'NOT_PENDING' });
  const projectedOrder = { id: order.id, orgId: order.orgId, source: order.source, status };
  if (blocked.some(item => item.code === 'TOO_MANY_LINES' || item.code === 'NOT_PENDING')) {
    return { order: projectedOrder, company, lines: [], totals: [], totalsComplete: local.lines.length === 0, blocked, previewDigest };
  }

  // Client construction reads encrypted credentials; keep that DB read scoped,
  // then close the transaction before token refresh or product HTTP can run.
  const client = input.client ?? (await runOutsideDbContext(() => withDbAccessContext({
    scope: 'partner', orgId: null, accessibleOrgIds: null,
    accessiblePartnerIds: [input.partnerId], userId: null, currentPartnerId: input.partnerId,
  }, () => createPax8ClientForIntegration(order.integrationId)))).client;
  const lines: Pax8PreviewLine[] = [];
  // Cache live evidence only for this preview: repeated product lines must share one observation.
  const dependencies = new Map<string, Awaited<ReturnType<Pax8Client['getProductDependencies']>>>();
  const pricing = new Map<string, Awaited<ReturnType<Pax8Client['getProductPricing']>>>();
  for (const { line, snapshot, mapping: product, productId, sellUnitPrice, sellCurrency, baseline, contractLineMissing } of local.evidence) {
    if (contractLineMissing) blocked.push({ lineId: line.id, code: 'CONTRACT_LINE_MISSING' });
    if (line.submitState !== 'pending') blocked.push({ lineId: line.id, code: 'NOT_PENDING' });
    const missingSnapshot = line.action !== 'new_subscription' && !snapshot;
    if (missingSnapshot) blocked.push({ lineId: line.id, code: 'SUBSCRIPTION_NOT_FOUND' });
    if (!productId) blocked.push({ lineId: line.id, code: 'PRODUCT_UNKNOWN' });
    if (productId && !dependencies.has(productId)) {
      dependencies.set(productId, await runOutsideDbContext(() => client.getProductDependencies(productId)));
    }
    const commitments = productId ? dependencies.get(productId)!.commitments : [];
    let commitment: Pax8Commitment | null = null;
    if (line.action === 'new_subscription') {
      const matches = line.commitmentTermId
        ? commitments.filter(c => c.id === line.commitmentTermId) : commitments;
      if (matches.length === 1) commitment = matches[0]!;
    } else if (snapshot) {
      const active = snapshotActiveCommitmentEvidence(snapshot?.raw);
      const matches = active.activeCommitmentId
        ? commitments.filter(c => c.id === active.activeCommitmentId) : commitments;
      if (!active.activeCommitmentAmbiguous && matches.length === 1) commitment = matches[0]!;
    }
    if (!commitment && productId && !missingSnapshot) blocked.push({ lineId: line.id, code: 'COMMITMENT_AMBIGUOUS' });
    const billingTerm = asBillingTerm(line.billingTerm ?? snapshot?.billingTerm ?? null);
    if (!billingTerm) blocked.push({ lineId: line.id, code: 'TERM_UNKNOWN' });
    const quantity = line.action === 'cancel' ? '0' : usableQuantity(line.quantity, line.action) ? line.quantity : null;
    if (quantity === null) blocked.push({ lineId: line.id, code: 'QUANTITY_UNKNOWN' });
    let unitCost: string | null = null;
    let currency: string | null = null;
    if (line.action === 'new_subscription') {
      if (productId && !pricing.has(productId)) {
        pricing.set(productId, await runOutsideDbContext(() => client.getProductPricing(productId)));
      }
      const prices = productId ? pricing.get(productId)! : [];
      const matches = commitment ? prices.filter(p => normalized(p.billingTerm) === normalized(billingTerm)
        && normalized(p.commitmentTerm) === normalized(commitment.term)) : [];
      if (matches.length === 1 && usableCost(matches[0]!.partnerBuyRate) && matches[0]!.currencyCode) {
        unitCost = matches[0]!.partnerBuyRate; currency = matches[0]!.currencyCode;
      }
    } else {
      unitCost = usableCost(snapshot?.unitCost) ? snapshot.unitCost : null;
      currency = snapshot?.currencyCode ?? null;
    }
    if (unitCost === null || !currency) blocked.push({ lineId: line.id, code: 'COST_UNKNOWN' });
    lines.push({
      lineId: line.id, action: line.action as Pax8OrderAction, pax8ProductId: productId,
      productName: product?.productName ?? snapshot?.productName ?? null,
      vendorSkuId: product?.vendorSkuId ?? snapshot?.vendorSkuId ?? null,
      quantity,
      fromQuantity: line.action === 'new_subscription' ? null : baseline,
      billingTerm, commitmentTerm: commitment?.term ?? null, unitCost, currency,
      sellUnitPrice, sellCurrency, contractLineId: line.contractLineId,
      allowForQuantityIncrease: commitment?.allowForQuantityIncrease ?? null,
      allowForQuantityDecrease: commitment?.allowForQuantityDecrease ?? null,
      allowForEarlyCancellation: commitment?.allowForEarlyCancellation ?? null,
      cancellationFeeApplied: commitment?.cancellationFeeApplied ?? null,
    });
  }
  let totalsComplete = true;
  const buckets = new Map<string, { currency: string; billingTerm: Pax8BillingTerm; amounts: string[] }>();
  for (const line of lines) {
    if (line.unitCost === null || !line.currency || !line.billingTerm || line.quantity === null) {
      totalsComplete = false;
      continue;
    }
    const key = JSON.stringify([line.currency, line.billingTerm]);
    const bucket = buckets.get(key) ?? { currency: line.currency, billingTerm: line.billingTerm, amounts: [] };
    bucket.amounts.push(computeLineTotal(line.quantity, line.unitCost, line.currency)); buckets.set(key, bucket);
  }
  const totals = [...buckets.values()].map(({ currency, billingTerm, amounts }) => ({
    currency, billingTerm, partnerCost: computeInvoiceTotals(amounts.map(lineTotal => ({
      lineTotal, taxable: false, customerVisible: true,
    })), null, currency).total,
  }));
  const submitWith = blocked.length === 0 && lines.length > 0 && company && previewDigest ? {
    orderId: order.id, previewDigest, expectedCompany: company,
    expectedLines: lines.map(({ lineId, action, pax8ProductId, productName, quantity, fromQuantity, unitCost, currency, billingTerm, commitmentTerm, cancellationFeeApplied }) => ({
      lineId, action, pax8ProductId, productName, quantity, fromQuantity, unitCost, currency, billingTerm, commitmentTerm, cancellationFeeApplied,
    })),
  } : undefined;
  return { order: projectedOrder, company, lines, totals, totalsComplete, blocked, previewDigest, ...(submitWith ? { submitWith } : {}) };
}
