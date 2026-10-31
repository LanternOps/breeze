import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

const m = vi.hoisted(() => ({
  material: vi.fn(), select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
  getOrderWithLines: vi.fn(), createClient: vi.fn(), resolvePrice: vi.fn(),
  dependencies: vi.fn(), pricing: vi.fn(), contextDepth: 0, outsideDepth: 0,
  withContext: vi.fn(), outside: vi.fn(),
}));
vi.mock('../db', () => ({
  db: { select: m.select, insert: m.insert, update: m.update, delete: m.delete },
  withDbAccessContext: m.withContext, runOutsideDbContext: m.outside,
}));
vi.mock('./pax8OrderService', async (original) => ({
  ...await original<typeof import('./pax8OrderService')>(), getOrderWithLines: m.getOrderWithLines,
}));
vi.mock('./pax8SyncService', () => ({ createPax8ClientForIntegration: m.createClient }));
vi.mock('./catalogService', () => ({
  resolvePrice: m.resolvePrice,
  CatalogServiceError: class CatalogServiceError extends Error { constructor(message: string, public status = 400, public code?: string) { super(message); } },
}));
vi.mock('./actionIntents/pax8OrderDigest', () => ({ pax8OrderDigestMaterial: m.material, hashPax8OrderMaterial: () => 'a'.repeat(64) }));
import { previewPax8Order } from './pax8OrderPreview';
import { Pax8ApiError } from './pax8Client';
import { CatalogServiceError } from './catalogService';

const partnerId = '10000000-0000-4000-8000-000000000001';
const orgId = '10000000-0000-4000-8000-000000000002';
const orderId = '10000000-0000-4000-8000-000000000003';
const integrationId = '10000000-0000-4000-8000-000000000004';
const lineId = '10000000-0000-4000-8000-000000000005';
const client = { getProductDependencies: m.dependencies, getProductPricing: m.pricing };
const commitment = (id = 'fixture-term', term = 'Annual') => ({
  id, term, allowForQuantityIncrease: true, allowForQuantityDecrease: false,
  allowForEarlyCancellation: false, cancellationFeeApplied: true,
});
let rows: Record<string, unknown[]>;
let order: Record<string, unknown>;
let lines: Record<string, unknown>[];
const run = () => previewPax8Order({ partnerId, orderId, client: client as never });

beforeEach(() => {
  vi.clearAllMocks();
  m.material.mockImplementation(async () => { expect(m.contextDepth).toBeGreaterThan(0); return { local: true }; });
  m.contextDepth = 0; m.outsideDepth = 0;
  m.outside.mockImplementation(async (fn) => {
    const saved = m.contextDepth; m.contextDepth = 0; m.outsideDepth++;
    try { return await fn(); } finally { m.outsideDepth--; m.contextDepth = saved; }
  });
  m.withContext.mockImplementation(async (_ctx, fn) => {
    m.contextDepth++;
    try { return await fn(); } finally { m.contextDepth--; }
  });
  order = { id: orderId, partnerId, orgId, integrationId, pax8CompanyId: null, source: 'direct', status: 'draft' };
  lines = [{ id: lineId, action: 'new_subscription', submitState: 'pending', pax8ProductId: 'fixture-product',
    quantity: '5', billingTerm: 'Monthly', commitmentTermId: 'fixture-term', contractLineId: null,
    authorizedBaselineQuantity: null, targetSubscriptionId: null }];
  rows = {
    pax8_company_mappings: [{ pax8CompanyId: 'fixture-company', pax8CompanyName: 'Fixture Company', status: 'Active',
      metadata: { contacts: [{ types: ['Admin', 'Billing', 'Technical'].map(type => ({ type, primary: true })) }] } }],
    pax8_product_mappings: [{ productName: 'Fixture Product', vendorSkuId: 'fixture-sku' }],
    pax8_subscription_snapshots: [{ productId: 'fixture-product', productName: 'Fixture Subscription', vendorSkuId: 'fixture-sku',
      unitCost: '7.50', currencyCode: 'USD', billingTerm: 'Monthly', raw: { commitmentTermId: 'fixture-term' } }],
    contract_lines: [{ id: 'fixture-contract-line', contractId: 'fixture-contract', catalogItemId: 'fixture-catalog', unitPrice: '12.00' }],
    contracts: [{ id: 'fixture-contract', currencyCode: 'CAD', createdBy: 'fixture-user' }],
  };
  m.select.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    let table = '';
    chain.from = vi.fn((value) => { table = getTableName(value); return chain; });
    for (const method of ['where', 'limit', 'orderBy']) chain[method] = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown[]) => unknown) => resolve(rows[table] ?? []);
    return chain;
  });
  m.getOrderWithLines.mockImplementation(async () => {
    expect(m.contextDepth).toBeGreaterThan(0);
    return { order, lines };
  });
  m.dependencies.mockImplementation(async () => {
    expect(m.contextDepth).toBe(0); expect(m.outsideDepth).toBeGreaterThan(0);
    return { commitments: [commitment()] };
  });
  m.pricing.mockImplementation(async () => {
    expect(m.contextDepth).toBe(0); expect(m.outsideDepth).toBeGreaterThan(0);
    return [{ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '8.25', currencyCode: 'USD' }];
  });
  m.resolvePrice.mockResolvedValue({ unitPrice: '15.00' });
  m.createClient.mockResolvedValue({ client });
});

describe('previewPax8Order', () => {
  it('returns a digest and exact submit assertions from the same local read context', async () => {
    const result = await run();
    expect(result.previewDigest).toBe('a'.repeat(64));
    expect(result.submitWith).toMatchObject({ orderId, previewDigest: result.previewDigest, expectedCompany: result.company,
      expectedLines: [expect.objectContaining({ lineId, quantity: '5', unitCost: '8.25', commitmentTerm: 'Annual' })] });
    expect(m.material).toHaveBeenCalledTimes(1);
  });
  it('blocked previews never offer submitWith', async () => {
    m.pricing.mockResolvedValue([]);
    expect((await run()).submitWith).toBeUndefined();
  });
  it('cancel preview uses the current linked manual quantity for its approved baseline', async () => {
    Object.assign(lines[0]!, { action: 'cancel', targetSubscriptionId: 'fixture-subscription', contractLineId: 'fixture-contract-line', authorizedBaselineQuantity: null });
    Object.assign(rows.contract_lines![0]!, { manualQuantity: '3' });
    expect((await run()).lines[0]?.fromQuantity).toBe('3');
  });
  it('new line priced from the live pricing row matching billing and commitment term', async () => {
    m.pricing.mockResolvedValue([
      { commitmentTerm: 'Annual', billingTerm: 'Annual', partnerBuyRate: '99', currencyCode: 'USD' },
      { commitmentTerm: 'Monthly', billingTerm: 'Monthly', partnerBuyRate: '20', currencyCode: 'USD' },
      { commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '8.25', currencyCode: 'USD' },
    ]);
    const result = await run();
    expect(result.lines[0]).toMatchObject({ unitCost: '8.25', commitmentTerm: 'Annual', productName: 'Fixture Product' });
    expect(result.totals).toEqual([{ currency: 'USD', billingTerm: 'Monthly', partnerCost: '41.25' }]);
    expect(result.blocked).toEqual([]);
    expect(result.totalsComplete).toBe(true);
    expect(m.pricing).toHaveBeenCalledWith('fixture-product');
  });
  it.each([{ pricing: [] }, { pricing: [{ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '8', currencyCode: 'USD' },
    { commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '9', currencyCode: 'USD' }] }])('no unique pricing row blocks unknown cost (%j)', async ({ pricing }) => {
    m.pricing.mockResolvedValue(pricing);
    const result = await run();
    expect(result.lines[0]?.unitCost).toBeNull();
    expect(result.blocked).toContainEqual({ lineId, code: 'COST_UNKNOWN' });
  });
  it('change uses authorized baseline and snapshot cost', async () => {
    Object.assign(lines[0]!, { action: 'change_quantity', targetSubscriptionId: 'fixture-subscription', authorizedBaselineQuantity: '3' });
    const result = await run();
    expect(result.lines[0]).toMatchObject({ fromQuantity: '3', quantity: '5', unitCost: '7.50' });
    expect(m.pricing).not.toHaveBeenCalled();
  });
  it('cancel carries ACTIVE commitment flags rather than the first commitment', async () => {
    Object.assign(lines[0]!, { action: 'cancel', targetSubscriptionId: 'fixture-subscription', authorizedBaselineQuantity: '3', quantity: null });
    m.dependencies.mockResolvedValue({ commitments: [{ ...commitment('other', 'Monthly'), cancellationFeeApplied: false }, commitment()] });
    expect((await run()).lines[0]).toMatchObject({ quantity: '0', fromQuantity: '3', commitmentTerm: 'Annual', cancellationFeeApplied: true, allowForEarlyCancellation: false });
  });
  it('increase with null snapshot cost is blocked', async () => {
    Object.assign(lines[0]!, { action: 'change_quantity', targetSubscriptionId: 'fixture-subscription', authorizedBaselineQuantity: '3' });
    Object.assign(rows.pax8_subscription_snapshots![0]!, { unitCost: null });
    expect((await run()).blocked).toContainEqual({ lineId, code: 'COST_UNKNOWN' });
  });
  it('quote-created new line reports contract-currency customer price', async () => {
    order.source = 'quote'; lines[0]!.contractLineId = 'fixture-contract-line';
    expect((await run()).lines[0]).toMatchObject({ sellUnitPrice: '15.00', sellCurrency: 'CAD' });
    expect(m.resolvePrice).toHaveBeenCalledWith('fixture-catalog', 'CAD', orgId, expect.objectContaining({ partnerId, accessibleOrgIds: [orgId] }));
  });
  it('never resolves or persists an unresolved company', async () => {
    rows.pax8_company_mappings = [];
    const result = await run();
    expect(result.company).toBeNull();
    expect(result.blocked).toContainEqual({ code: 'COMPANY_UNRESOLVED' });
    expect(m.update).not.toHaveBeenCalled(); expect(m.insert).not.toHaveBeenCalled();
  });
  it('more than 20 lines are blocked', async () => {
    lines = Array.from({ length: 21 }, (_, i) => ({ ...lines[0], id: `${lineId}-${i}` }));
    const result = await previewPax8Order({ partnerId, orderId });
    expect(result.blocked).toContainEqual({ code: 'TOO_MANY_LINES' });
    expect(result.totalsComplete).toBe(false);
    expect(m.createClient).not.toHaveBeenCalled();
    expect(m.dependencies).not.toHaveBeenCalled();
    expect(m.pricing).not.toHaveBeenCalled();
  });
  it('constructs the credential-reading client in a short partner DB context', async () => {
    m.createClient.mockImplementation(async () => {
      expect(m.contextDepth).toBeGreaterThan(0);
      expect(m.withContext).toHaveBeenLastCalledWith(expect.objectContaining({
        scope: 'partner', accessiblePartnerIds: [partnerId], currentPartnerId: partnerId,
      }), expect.any(Function));
      return { client };
    });
    await previewPax8Order({ partnerId, orderId });
    expect(m.createClient).toHaveBeenCalledWith(integrationId);
  });
  it('runs every Pax8 HTTP call outside the client-construction DB context', async () => {
    await previewPax8Order({ partnerId, orderId });
    expect(m.dependencies).toHaveBeenCalledWith('fixture-product');
    expect(m.pricing).toHaveBeenCalledWith('fixture-product');
  });
  it('writes nothing and returns no raw payloads', async () => {
    const result = await run();
    for (const write of [m.insert, m.update, m.delete]) expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/metadata|raw|encrypted/);
  });
  it('ambiguous active commitment blocks the line', async () => {
    Object.assign(lines[0]!, { action: 'cancel', targetSubscriptionId: 'fixture-subscription' });
    Object.assign(rows.pax8_subscription_snapshots![0]!, { raw: { commitmentTermId: 'fixture-term', commitment: { id: 'other' } } });
    expect((await run()).blocked).toContainEqual({ lineId, code: 'COMMITMENT_AMBIGUOUS' });
  });
  it('nonpending lines are blocked separately from the order', async () => {
    lines[0]!.submitState = 'succeeded';
    const result = await run();
    expect(result.blocked).toContainEqual({ lineId, code: 'NOT_PENDING' });
    expect(result.blocked).not.toContainEqual({ code: 'NOT_PENDING' });
  });
  it('nonsubmittable orders return early without constructing a client or vendor calls', async () => {
    order.status = 'completed';
    const result = await previewPax8Order({ partnerId, orderId });
    expect(result.blocked).toContainEqual({ code: 'NOT_PENDING' });
    expect(result.totalsComplete).toBe(false);
    expect(result.lines).toEqual([]);
    expect(m.createClient).not.toHaveBeenCalled();
    expect(m.dependencies).not.toHaveBeenCalled();
    expect(m.pricing).not.toHaveBeenCalled();
  });
  it('caches dependencies and pricing once per product within each preview', async () => {
    lines.push({ ...lines[0], id: 'second-line', quantity: '2' });
    const result = await run();
    expect(m.dependencies).toHaveBeenCalledTimes(1);
    expect(m.pricing).toHaveBeenCalledTimes(1);
    expect(result.totals).toEqual([{ currency: 'USD', billingTerm: 'Monthly', partnerCost: '57.75' }]);
    await run();
    expect(m.dependencies).toHaveBeenCalledTimes(2);
    expect(m.pricing).toHaveBeenCalledTimes(2);
  });
  it.each(['change_quantity', 'cancel'])('%s with missing snapshot cost reports incomplete totals', async action => {
    Object.assign(lines[0]!, { action, targetSubscriptionId: 'fixture-subscription', quantity: '2', authorizedBaselineQuantity: '3' });
    Object.assign(rows.pax8_subscription_snapshots![0]!, { unitCost: null });
    const result = await run();
    expect(result.blocked).toContainEqual({ lineId, code: 'COST_UNKNOWN' });
    expect(result.totals).toEqual([]);
    expect(result.totalsComplete).toBe(false);
  });
  it.each([null, '', 'unrecognized'])('unknown billing term %s blocks totals', async billingTerm => {
    lines[0]!.billingTerm = billingTerm;
    const result = await run();
    expect(result.blocked).toContainEqual({ lineId, code: 'TERM_UNKNOWN' });
    expect(result.totalsComplete).toBe(false);
    expect(result.totals).toEqual([]);
  });
  it.each([null, '', 'garbage', '-1', 'Infinity', '0', '0x10', '1e2'])('missing or invalid quantity %s is never priced as zero', async quantity => {
    lines[0]!.quantity = quantity;
    const result = await run();
    expect(result.blocked).toContainEqual({ lineId, code: 'QUANTITY_UNKNOWN' });
    expect(result.lines[0]?.quantity).toBeNull();
    expect(result.totalsComplete).toBe(false);
    expect(result.totals).toEqual([]);
  });
  it('a quantity change to zero remains valid', async () => {
    Object.assign(lines[0]!, { action: 'change_quantity', quantity: '0', targetSubscriptionId: 'fixture-subscription', authorizedBaselineQuantity: '3' });
    const result = await run();
    expect(result.lines[0]?.quantity).toBe('0');
    expect(result.totalsComplete).toBe(true);
    expect(result.blocked).toEqual([]);
  });
  it('snapshot billing term gaps block otherwise known snapshot cost', async () => {
    Object.assign(lines[0]!, { action: 'change_quantity', billingTerm: null, targetSubscriptionId: 'fixture-subscription', authorizedBaselineQuantity: '3' });
    Object.assign(rows.pax8_subscription_snapshots![0]!, { billingTerm: null });
    const result = await run();
    expect(result.blocked).toEqual([{ lineId, code: 'TERM_UNKNOWN' }]);
    expect(result.totalsComplete).toBe(false);
  });
  it.each([null, '', '-2', 'NaN'])('unknown snapshot cost %s always blocks a decrease', async unitCost => {
    Object.assign(lines[0]!, { action: 'change_quantity', quantity: '2', targetSubscriptionId: 'fixture-subscription', authorizedBaselineQuantity: '3' });
    Object.assign(rows.pax8_subscription_snapshots![0]!, { unitCost });
    const result = await run();
    expect(result.blocked).toContainEqual({ lineId, code: 'COST_UNKNOWN' });
    expect(result.totalsComplete).toBe(false);
  });
  it('missing target snapshot is identified instead of commitment ambiguity', async () => {
    Object.assign(lines[0]!, { action: 'change_quantity', targetSubscriptionId: 'missing', authorizedBaselineQuantity: '3' });
    rows.pax8_subscription_snapshots = [];
    const result = await run();
    expect(result.blocked).toContainEqual({ lineId, code: 'SUBSCRIPTION_NOT_FOUND' });
    expect(result.blocked).not.toContainEqual({ lineId, code: 'COMMITMENT_AMBIGUOUS' });
  });
  it('missing product is identified instead of commitment ambiguity', async () => {
    lines[0]!.pax8ProductId = null;
    const result = await run();
    expect(result.blocked).toContainEqual({ lineId, code: 'PRODUCT_UNKNOWN' });
    expect(result.blocked).not.toContainEqual({ lineId, code: 'COMMITMENT_AMBIGUOUS' });
    expect(m.dependencies).not.toHaveBeenCalled();
    expect(m.pricing).not.toHaveBeenCalled();
  });
  it('partial totals explicitly report excluded lines', async () => {
    lines.push({ ...lines[0], id: 'second-line', quantity: null });
    const result = await run();
    expect(result.totals).toEqual([{ currency: 'USD', billingTerm: 'Monthly', partnerCost: '41.25' }]);
    expect(result.totalsComplete).toBe(false);
    expect(result.blocked).toContainEqual({ lineId: 'second-line', code: 'QUANTITY_UNKNOWN' });
  });
  it.each(['pricing', 'dependencies', 'createClient'] as const)('%s rejection propagates without a partial preview', async method => {
    const error = new Pax8ApiError('vendor failure', 503, 'failure body');
    m[method].mockRejectedValue(error);
    await expect(previewPax8Order({ partnerId, orderId })).rejects.toBe(error);
  });
  it.each(['NO_PRICE_FOR_CURRENCY', 'PRICE_NOT_REPRESENTABLE'] as const)('falls back to contract price for %s', async code => {
    lines[0]!.contractLineId = 'fixture-contract-line';
    m.resolvePrice.mockRejectedValue(new CatalogServiceError('price unavailable', 400, code));
    expect((await run()).lines[0]).toMatchObject({ sellUnitPrice: '12.00', sellCurrency: 'CAD' });
  });
  it('uses a contract price directly when there is no catalog item', async () => {
    lines[0]!.contractLineId = 'fixture-contract-line';
    Object.assign(rows.contract_lines![0]!, { catalogItemId: null });
    expect((await run()).lines[0]).toMatchObject({ sellUnitPrice: '12.00', sellCurrency: 'CAD' });
    expect(m.resolvePrice).not.toHaveBeenCalled();
  });
  it('propagates unrelated catalog errors instead of silently falling back', async () => {
    lines[0]!.contractLineId = 'fixture-contract-line';
    const error = new Error('database unavailable');
    m.resolvePrice.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
  });
  it('empty orders have complete empty totals', async () => {
    lines = [];
    expect(await run()).toMatchObject({ totals: [], totalsComplete: true });
  });
});
