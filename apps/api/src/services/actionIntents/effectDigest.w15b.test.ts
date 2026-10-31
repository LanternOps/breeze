import { getTableColumns, getTableName } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import { computeEffectDigestOutcome, effectDigestResolverKey, requiresPinnedEffectDigest } from './effectDigest';
import { hashPax8OrderMaterial, pax8OrderDigestMaterial } from './pax8OrderDigest';

const ORDER = '10000000-0000-4000-8000-000000000001';
const PARTNER = '10000000-0000-4000-8000-000000000002';
const ORG = '10000000-0000-4000-8000-000000000003';
type Row = Record<string, unknown>;
let rows: Record<string, Row[]>;
let database: Database;
let writes: ReturnType<typeof vi.fn>;
const first = (table: string) => rows[table]![0]!;

beforeEach(() => {
  rows = {
    pax8_orders: [{ id: ORDER, partnerId: PARTNER, orgId: ORG, integrationId: 'fixture-integration', source: 'quote', sourceQuoteId: 'fixture-quote', status: 'draft', pax8CompanyId: null }],
    pax8_order_lines: [{ id: 'fixture-line', orderId: ORDER, partnerId: PARTNER, orgId: ORG, action: 'change_quantity', submitState: 'pending', sortOrder: 0, pax8ProductId: 'fixture-product', catalogItemId: 'fixture-item', billingTerm: 'Monthly', commitmentTermId: 'fixture-term', quantity: '8.00', authorizedBaselineQuantity: '5.00', targetSubscriptionId: 'fixture-subscription', cancelDate: null, contractLineId: 'fixture-contract-line', provisioningDetails: [{ key: 'domain', values: ['example.test'] }] }],
    pax8_integrations: [{ id: 'fixture-integration', partnerId: PARTNER, apiBaseUrl: 'https://vendor.example/v1', tokenUrl: 'https://vendor.example/token', isActive: true, clientIdEncrypted: 'fixture-id-ciphertext', clientSecretEncrypted: 'fixture-secret-ciphertext', accessTokenEncrypted: 'fixture-token', accessTokenExpiresAt: new Date() }],
    pax8_company_mappings: [{ id: 'fixture-company-mapping', partnerId: PARTNER, integrationId: 'fixture-integration', orgId: ORG, pax8CompanyId: 'fixture-company', pax8CompanyName: 'Fixture Company', status: 'Active', ignored: false, metadata: { contacts: [{ types: ['Admin', 'Billing', 'Technical'].map(type => ({ type, primary: true })) }] } }],
    pax8_subscription_snapshots: [{ id: 'fixture-snapshot', orgId: ORG, productId: 'fixture-product', productName: 'Fixture Subscription', quantity: '5.00', quantityKnown: true, unitCost: '7.50', unitPrice: '11.00', currencyCode: 'USD', billingTerm: 'Monthly', status: 'Active', raw: { commitmentTermId: 'fixture-term' } }],
    pax8_contract_line_links: [{ contractLineId: 'fixture-contract-line', syncEnabled: true }],
    pax8_product_mappings: [{ pax8ProductId: 'fixture-product', productName: 'Fixture Product', vendorSkuId: 'fixture-sku', catalogItemId: 'fixture-item' }],
    contract_lines: [{ id: 'fixture-contract-line', contractId: 'fixture-contract', manualQuantity: '5.00', unitPrice: '15.00', lineType: 'manual', catalogItemId: 'fixture-item' }],
    contracts: [{ id: 'fixture-contract', currencyCode: 'CAD' }],
    catalog_items: [{ id: 'fixture-item', name: 'Fixture Item', sku: 'fixture-item-sku', itemType: 'software', isActive: true, costBasis: '6.00', costCurrency: 'USD', taxable: true }],
    catalog_item_prices: [{ itemId: 'fixture-item', currencyCode: 'CAD', unitPrice: '16.00' }],
    catalog_item_org_pricing: [{ catalogItemId: 'fixture-item', currencyCode: 'CAD', unitPrice: '14.00' }],
  };
  writes = vi.fn(() => { throw new Error('digest must never write'); });
  const select = vi.fn((shape?: Record<string, unknown>) => {
    let table: Parameters<typeof getTableName>[0];
    const chain: Record<string, unknown> = {};
    chain.from = (value: typeof table) => { table = value; return chain; };
    for (const method of ['where', 'limit', 'orderBy']) chain[method] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => {
      const columns = getTableColumns(table);
      const result = (rows[getTableName(table)] ?? []).map(row => shape
        ? Object.fromEntries(Object.entries(shape).map(([key, column]) => {
          const sourceKey = Object.keys(columns).find(name => columns[name] === column);
          return [key, sourceKey === undefined ? undefined : row[sourceKey]];
        })) : row);
      return resolve(result);
    };
    return chain;
  });
  database = { select, update: writes, insert: writes, delete: writes } as unknown as Database;
});

async function digest() {
  const material = await pax8OrderDigestMaterial(database, ORDER);
  if (!material) throw new Error('missing fixture order');
  return hashPax8OrderMaterial(material);
}

describe('Pax8 submit local effect material (W15 Q2/Q4/Q5/Q7)', () => {
  it.each([
    ['line quantity', 'pax8_order_lines', 'quantity', '9.00'],
    ['sortOrder / outbound lineItemNumber', 'pax8_order_lines', 'sortOrder', 1],
    ['provisioning details', 'pax8_order_lines', 'provisioningDetails', [{ key: 'domain', values: ['changed.example.test'] }]],
    ['commitmentTermId', 'pax8_order_lines', 'commitmentTermId', 'fixture-other-term'],
    ['snapshot unitCost', 'pax8_subscription_snapshots', 'unitCost', '8.00'],
    ['derived active commitment', 'pax8_subscription_snapshots', 'raw', { commitmentTermId: 'fixture-other-term' }],
    ['manual billing quantity', 'contract_lines', 'manualQuantity', '6.00'],
    ['contract unitPrice', 'contract_lines', 'unitPrice', '17.00'],
    ['contract currency', 'contracts', 'currencyCode', 'USD'],
    ['contract-currency catalog price', 'catalog_item_prices', 'unitPrice', '18.00'],
    ['org catalog price override', 'catalog_item_org_pricing', 'unitPrice', '19.00'],
    ['company mapping', 'pax8_company_mappings', 'pax8CompanyId', 'fixture-other-company'],
    ['company name shown on card', 'pax8_company_mappings', 'pax8CompanyName', 'Changed Fixture'],
    ['company readiness', 'pax8_company_mappings', 'metadata', {}],
    ['integration URL', 'pax8_integrations', 'apiBaseUrl', 'https://other-vendor.example/v1'],
    ['integration token URL', 'pax8_integrations', 'tokenUrl', 'https://other-vendor.example/token'],
    ['credential ciphertext', 'pax8_integrations', 'clientSecretEncrypted', 'fixture-changed-ciphertext'],
    ['product name shown on card', 'pax8_product_mappings', 'productName', 'Changed Fixture Product'],
    ['contract link', 'pax8_contract_line_links', 'contractLineId', 'fixture-other-contract-line'],
    ['syncEnabled', 'pax8_contract_line_links', 'syncEnabled', false],
  ])('changes when %s changes', async (_name, table, field, value) => {
    const before = await digest();
    first(table as string)[field as string] = value;
    expect(await digest()).not.toBe(before);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(['manualQuantity', 'unitPrice'])('quote-created new lines pin linked contract %s', async field => {
    Object.assign(first('pax8_order_lines'), { action: 'new_subscription', targetSubscriptionId: null, authorizedBaselineQuantity: null });
    const before = await digest();
    first('contract_lines')[field] = '21.00';
    expect(await digest()).not.toBe(before);
  });

  it('pins catalog item / product mapping for new lines', async () => {
    Object.assign(first('pax8_order_lines'), { action: 'new_subscription', targetSubscriptionId: null });
    const before = await digest();
    first('catalog_items').isActive = false;
    expect(await digest()).not.toBe(before);
    first('catalog_items').isActive = true;
    first('pax8_product_mappings').catalogItemId = 'fixture-other-item';
    expect(await digest()).not.toBe(before);
  });

  it('does not change for sync timestamps, token refresh, irrelevant raw or metadata', async () => {
    const before = await digest();
    first('pax8_subscription_snapshots').lastSeenAt = new Date('2026-10-31');
    first('pax8_subscription_snapshots').updatedAt = new Date('2026-10-31');
    first('pax8_subscription_snapshots').raw = { commitmentTermId: 'fixture-term', unrelated: 'noise' };
    first('pax8_integrations').accessTokenEncrypted = 'fixture-refreshed-token';
    first('pax8_integrations').accessTokenExpiresAt = new Date('2026-11-01');
    first('pax8_company_mappings').metadata = { ...(first('pax8_company_mappings').metadata as object), irrelevant: true };
    expect(await digest()).toBe(before);
  });

  it.each(['draft', 'awaiting_details', 'ready'])('claim from %s does not change its own digest', async status => {
    first('pax8_orders').status = status;
    const before = await digest();
    Object.assign(first('pax8_orders'), { status: 'submitting', pax8CompanyId: 'fixture-company', submittedAt: new Date(), updatedAt: new Date() });
    expect(await digest()).toBe(before);
    first('pax8_order_lines').submitState = 'in_flight';
    expect(await digest()).not.toBe(before);
  });

  it.each(['new_subscription', 'cancel'])('claim baseline capture is normalized for %s', async action => {
    Object.assign(first('pax8_order_lines'), { action, authorizedBaselineQuantity: null });
    const before = await digest();
    first('pax8_order_lines').authorizedBaselineQuantity = '5.00';
    expect(await digest()).toBe(before);
    first('contract_lines').manualQuantity = '6.00';
    expect(await digest()).not.toBe(before);
  });

  it('canonicalizes provisioning object-key order', async () => {
    const before = await digest();
    first('pax8_order_lines').provisioningDetails = [{ values: ['example.test'], key: 'domain' }];
    expect(await digest()).toBe(before);
  });

  it('pins absent rows as null and detects a row appearing or disappearing', async () => {
    const before = await digest();
    rows.contract_lines = [];
    expect(await digest()).not.toBe(before);
    rows.catalog_item_prices = [];
    const absent = await digest();
    rows.catalog_item_prices = [{ itemId: 'fixture-item', currencyCode: 'CAD', unitPrice: '22.00' }];
    // No linked contract remains, so contract-currency prices are no longer used.
    expect(await digest()).toBe(absent);
  });

  it('returns only opaque credential identity, derived raw evidence and no timestamp churn', async () => {
    const material = await pax8OrderDigestMaterial(database, ORDER);
    const json = JSON.stringify(material);
    for (const forbidden of ['fixture-id-ciphertext', 'fixture-secret-ciphertext', 'fixture-token', 'Encrypted', '"raw"', '"metadata"', 'lastSeenAt', 'updatedAt']) {
      expect(json).not.toContain(forbidden);
    }
    expect(json).toContain('credentialGeneration');
    expect(json).toContain('fixture-term');
  });
});

describe('manage_pax8_orders:submit resolver and mandatory pin', () => {
  it('requires a submit pin and registers an on-demand resolver', () => {
    expect(requiresPinnedEffectDigest('manage_pax8_orders', { action: 'submit' })).toBe(true);
    expect(requiresPinnedEffectDigest('manage_pax8_orders', { action: 'reconcile' })).toBe(false);
    expect(effectDigestResolverKey('manage_pax8_orders', 'submit')).toBe('manage_pax8_orders:submit');
  });

  it('resolver hashes the exact preview material envelope', async () => {
    const result = await computeEffectDigestOutcome('manage_pax8_orders', { action: 'submit', orderId: ORDER }, database);
    expect(result).toEqual({ kind: 'pinned', digest: await digest() });
  });

  it('returns MISSING_ARG and TARGET_ABSENT without risking a malformed UUID query', async () => {
    expect(await computeEffectDigestOutcome('manage_pax8_orders', { action: 'submit' }, database)).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    expect(await computeEffectDigestOutcome('manage_pax8_orders', { action: 'submit', orderId: 'bad-id' }, database)).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    rows.pax8_orders = [];
    expect(await pax8OrderDigestMaterial(database, ORDER)).toBeNull();
    expect(await computeEffectDigestOutcome('manage_pax8_orders', { action: 'submit', orderId: ORDER }, database)).toEqual({ kind: 'unresolved', reason: 'target_absent' });
  });
});
