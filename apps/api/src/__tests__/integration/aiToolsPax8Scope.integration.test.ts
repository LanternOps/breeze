/** W15 PR A: real breeze_app/RLS proof; only product-id Pax8 HTTP is mocked. */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  catalogItems, contractLines, contracts, pax8CompanyMappings, pax8ContractLineLinks,
  pax8Integrations, pax8OrderLines, pax8Orders, pax8ProductMappings, pax8SubscriptionSnapshots,
} from '../../db/schema';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { aiTools, executeTool, toolManagesDbContext } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const vendor = vi.hoisted(() => ({
  createClient: vi.fn(), dependencies: vi.fn(), pricing: vi.fn(), createOrder: vi.fn(),
}));
vi.mock('../../services/pax8SyncService', async original => ({
  ...await original<typeof import('../../services/pax8SyncService')>(),
  createPax8ClientForIntegration: vendor.createClient,
}));
const PRODUCT = 'fixture-product';
const COMPANY = 'fixture-company';
const SUBSCRIPTION = 'fixture-subscription';
const TERM = 'fixture-term';
const CLIENT_SECRET = 'fixture-encrypted-client-secret';
const TOKEN_SECRET = 'fixture-encrypted-access-token';
const RAW_MARKER = 'fixture-raw-private-payload';
const READY = { contacts: [{ types: ['Admin', 'Billing', 'Technical'].map(type => ({ type, primary: true })) }] };

function makeAuth(userId: string, partnerId: string, orgIds: string[], partnerOrgAccess: 'all' | 'selected' = 'all'): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'fixture-operator@example.com', name: 'Fixture Operator', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    scope: 'partner', orgId: null, partnerId, partnerOrgAccess, accessibleOrgIds: orgIds,
    orgCondition: (column: Parameters<typeof inArray>[0]) => inArray(column, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id), canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: randomUUID() },
  } as unknown as AuthContext;
}
function context(auth: AuthContext): DbAccessContext {
  return buildDbAccessContext({ scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id });
}
async function run(tool: string, input: Record<string, unknown>, auth: AuthContext) {
  const call = () => executeTool(tool, input, auth);
  const raw = toolManagesDbContext(aiTools.get(tool), input)
    ? await call()
    : await withDbAccessContext(context(auth), call);
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

async function seed() {
  const testDb = getTestDb();
  const partner = await createPartner();
  const otherPartner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const orgOther = await createOrganization({ partnerId: otherPartner.id });
  const user = await createUser({ partnerId: partner.id });
  const otherUser = await createUser({ partnerId: otherPartner.id });
  const integrationValues = (partnerId: string) => ({ partnerId, name: 'Fixture Pax8 Integration',
    clientIdEncrypted: 'fixture-encrypted-client-id', clientSecretEncrypted: CLIENT_SECRET,
    accessTokenEncrypted: TOKEN_SECRET, webhookSecretEncrypted: 'fixture-encrypted-webhook',
    apiBaseUrl: 'https://vendor.example.com/v1', tokenUrl: 'https://vendor.example.com/token',
  });
  const [integration] = await testDb.insert(pax8Integrations).values(integrationValues(partner.id)).returning();
  const [otherIntegration] = await testDb.insert(pax8Integrations).values(integrationValues(otherPartner.id)).returning();
  if (!integration || !otherIntegration) throw new Error('integration seed failed');
  await testDb.insert(pax8CompanyMappings).values([orgA, orgB].map((org, i) => ({
    integrationId: integration.id, partnerId: partner.id, orgId: org.id,
    pax8CompanyId: i === 0 ? COMPANY : 'fixture-company-b', pax8CompanyName: `Fixture Company ${i}`,
    status: 'Active', metadata: { ...READY, privateMarker: RAW_MARKER },
  })));
  const [catalog] = await testDb.insert(catalogItems).values({
    partnerId: partner.id, itemType: 'software', name: 'Fixture seats', billingType: 'recurring', billingFrequency: 'monthly',
    costCurrency: 'USD', taxable: false,
  }).returning();
  if (!catalog) throw new Error('catalog seed failed');
  await testDb.insert(pax8ProductMappings).values({
    integrationId: integration.id, partnerId: partner.id, pax8ProductId: PRODUCT,
    productName: 'Fixture seats', vendorSkuId: 'fixture-sku', catalogItemId: catalog.id,
  });
  const [contractA] = await testDb.insert(contracts).values({
    partnerId: partner.id, orgId: orgA.id, name: 'Fixture A contract', intervalMonths: 1, startDate: '2026-10-01', currencyCode: 'USD',
  }).returning();
  const [contractB] = await testDb.insert(contracts).values({
    partnerId: partner.id, orgId: orgB.id, name: 'Fixture B contract', intervalMonths: 1, startDate: '2026-10-01', currencyCode: 'USD',
  }).returning();
  if (!contractA || !contractB) throw new Error('contract seed failed');
  const [lineA] = await testDb.insert(contractLines).values({
    contractId: contractA.id, orgId: orgA.id, lineType: 'manual', description: 'Fixture seats', unitPrice: '12.00', manualQuantity: '10.00',
  }).returning();
  const [lineB] = await testDb.insert(contractLines).values({
    contractId: contractB.id, orgId: orgB.id, lineType: 'manual', description: 'Fixture other seats', unitPrice: '15.00', manualQuantity: '5.00',
  }).returning();
  if (!lineA || !lineB) throw new Error('contract line seed failed');
  const [snapshot] = await testDb.insert(pax8SubscriptionSnapshots).values({
    integrationId: integration.id, partnerId: partner.id, pax8CompanyId: COMPANY, orgId: orgA.id,
    pax8SubscriptionId: SUBSCRIPTION, productId: PRODUCT, productName: 'Fixture seats',
    quantity: '10.00', quantityKnown: true, unitCost: '8.00', currencyCode: 'USD', billingTerm: 'Monthly',
    raw: { commitmentTermId: TERM, privateMarker: RAW_MARKER },
  }).returning();
  if (!snapshot) throw new Error('snapshot seed failed');
  const [order] = await testDb.insert(pax8Orders).values({
    integrationId: integration.id, partnerId: partner.id, orgId: orgA.id, pax8CompanyId: COMPANY,
    status: 'draft', source: 'direct', dedupeKey: `fixture:${randomUUID()}`, createdBy: user.id,
  }).returning();
  const [orderB] = await testDb.insert(pax8Orders).values({
    integrationId: integration.id, partnerId: partner.id, orgId: orgB.id, pax8CompanyId: 'fixture-company-b',
    status: 'draft', source: 'direct', dedupeKey: `fixture:${randomUUID()}`, createdBy: user.id,
  }).returning();
  if (!order || !orderB) throw new Error('order seed failed');
  vendor.createClient.mockResolvedValue({ integration, client: {
    getProductDependencies: vendor.dependencies, getProductPricing: vendor.pricing, createOrder: vendor.createOrder,
  } });
  return { partner, otherPartner, orgA, orgB, integration, otherIntegration, catalog, lineA, lineB, snapshot, order, orderB,
    auth: makeAuth(user.id, partner.id, [orgA.id, orgB.id]),
    selected: makeAuth(user.id, partner.id, [orgA.id], 'selected'),
    otherAuth: makeAuth(otherUser.id, otherPartner.id, [orgOther.id]),
  };
}
let f: Awaited<ReturnType<typeof seed>>;
beforeEach(async () => {
  vi.clearAllMocks();
  vendor.dependencies.mockResolvedValue({ commitments: [{ id: TERM, term: 'Annual',
    allowForQuantityIncrease: true, allowForQuantityDecrease: true, allowForEarlyCancellation: true, cancellationFeeApplied: false }] });
  vendor.pricing.mockResolvedValue([{ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '8.00', currencyCode: 'USD', raw: { privateMarker: RAW_MARKER } }]);
  vendor.createOrder.mockRejectedValue(new Error('PR A scope test must never place or preflight an order'));
  f = await seed();
});
async function link() {
  const result = await run('manage_pax8_subscriptions', { action: 'link', integrationId: f.integration.id,
    subscriptionSnapshotId: f.snapshot.id, contractLineId: f.lineA.id, syncEnabled: true }, f.auth);
  expect(result.body.error, result.raw).toBeUndefined();
  return result;
}

describe('Pax8 AI scope and local authoring (real PostgreSQL)', () => {
  it('pins all PR A action classes, including supervised sync and preflight', () => {
    for (const [tool, actions] of Object.entries({ search_pax8_products: ['search', 'provision_details', 'dependencies', 'pricing'],
      manage_pax8_subscriptions: ['list', 'drift'], manage_pax8_orders: ['list', 'get', 'preview'] })) {
      for (const action of actions) expect(checkGuardrails(tool, { action }), `${tool}:${action}`).toMatchObject({ tier: 1 });
    }
    expect(checkGuardrails('get_pax8_status', {})).toMatchObject({ tier: 1 });
    for (const action of ['create_draft', 'add_line', 'update_line', 'remove_line']) expect(checkGuardrails('manage_pax8_orders', { action })).toMatchObject({ tier: 2 });
    for (const action of ['sync', 'link', 'unlink']) expect(checkGuardrails('manage_pax8_subscriptions', { action })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_pax8_orders', { action: 'preflight' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
  });

  it('partner B cannot read partner A integration, subscriptions or orders, and RLS selects zero rows', async () => {
    const summary = await run('get_pax8_status', { integrationId: f.integration.id }, f.otherAuth);
    expect(summary.body.data, summary.raw).toBeNull();
    const subscriptions = await run('manage_pax8_subscriptions', { action: 'list', integrationId: f.integration.id }, f.otherAuth);
    expect(subscriptions.body.code, subscriptions.raw).toBe('NOT_FOUND');
    const order = await run('manage_pax8_orders', { action: 'get', orderId: f.order.id }, f.otherAuth);
    expect(order.body.code, order.raw).toBe('NOT_FOUND');
    const rows = await withDbAccessContext(context(f.otherAuth), async () => ({
      integrations: await db.select().from(pax8Integrations).where(eq(pax8Integrations.id, f.integration.id)),
      subscriptions: await db.select().from(pax8SubscriptionSnapshots).where(eq(pax8SubscriptionSnapshots.id, f.snapshot.id)),
      orders: await db.select().from(pax8Orders).where(eq(pax8Orders.id, f.order.id)),
    }));
    expect(rows).toEqual({ integrations: [], subscriptions: [], orders: [] });
    expect(vendor.createClient).not.toHaveBeenCalled();
  });

  it('refuses restricted partner members on status and every subscriptions action (CONTROL: full member reads)', async () => {
    expect((await run('get_pax8_status', {}, f.selected)).body.code).toBe('ACCESS_DENIED');
    for (const action of ['list', 'drift', 'sync', 'link', 'unlink']) {
      const denied = await run('manage_pax8_subscriptions', { action, integrationId: f.integration.id,
        subscriptionSnapshotId: f.snapshot.id, contractLineId: f.lineA.id }, f.selected);
      expect(denied.body.code, denied.raw).toBe('ACCESS_DENIED');
    }
    expect((await run('get_pax8_status', {}, f.auth)).body.data.id).toBe(f.integration.id);
    const allowed = await run('manage_pax8_subscriptions', { action: 'list' }, f.auth);
    expect(allowed.body.data.map((row: { id: string }) => row.id), allowed.raw).toContain(f.snapshot.id);
    expect(await getTestDb().select().from(pax8ContractLineLinks)).toHaveLength(0);
  });

  it('links and unlinks within one org without changing billed quantity', async () => {
    await link();
    expect(await getTestDb().select().from(pax8ContractLineLinks).where(eq(pax8ContractLineLinks.subscriptionSnapshotId, f.snapshot.id)))
      .toMatchObject([{ contractLineId: f.lineA.id, orgId: f.orgA.id, syncEnabled: true }]);
    const removed = await run('manage_pax8_subscriptions', { action: 'unlink', integrationId: f.integration.id, subscriptionSnapshotId: f.snapshot.id }, f.auth);
    expect(removed.body.data, removed.raw).toEqual({ unlinked: true });
    expect(await getTestDb().select().from(pax8ContractLineLinks).where(eq(pax8ContractLineLinks.subscriptionSnapshotId, f.snapshot.id))).toHaveLength(0);
    const [line] = await getTestDb().select().from(contractLines).where(eq(contractLines.id, f.lineA.id));
    expect(line!.manualQuantity).toBe('10.00');
  });

  it('refuses a cross-org contract line and stores no link (CONTROL: same-org link succeeds)', async () => {
    const result = await run('manage_pax8_subscriptions', { action: 'link', integrationId: f.integration.id,
      subscriptionSnapshotId: f.snapshot.id, contractLineId: f.lineB.id, syncEnabled: true }, f.auth);
    expect(result.body.error, result.raw).toBeTruthy();
    expect(await getTestDb().select().from(pax8ContractLineLinks)).toHaveLength(0);
    await link();
  });

  it('create_draft returns the existing mutable draft, including repeated calls', async () => {
    for (let i = 0; i < 2; i++) {
      const result = await run('manage_pax8_orders', { action: 'create_draft', orgId: f.orgA.id }, f.auth);
      expect(result.body.data.id, result.raw).toBe(f.order.id);
    }
    const drafts = await getTestDb().select().from(pax8Orders).where(and(eq(pax8Orders.orgId, f.orgA.id), eq(pax8Orders.source, 'direct'), eq(pax8Orders.status, 'draft')));
    expect(drafts).toHaveLength(1);
    expect(vendor.createClient).not.toHaveBeenCalled();
  });

  it.each(['change_quantity', 'cancel'])('stages %s using mocked live dependencies and leaves billing unchanged', async action => {
    await link();
    const result = await run('manage_pax8_orders', { action: 'add_line', orderId: f.order.id,
      line: { action, targetSubscriptionId: SUBSCRIPTION, ...(action === 'change_quantity' ? { quantity: '15' } : {}) } }, f.auth);
    expect(result.body.error, result.raw).toBeUndefined();
    expect(result.body.data).toMatchObject({ orderId: f.order.id, action, contractLineId: f.lineA.id, submitState: 'pending' });
    expect(vendor.dependencies).toHaveBeenCalledWith(PRODUCT);
    expect(vendor.createOrder).not.toHaveBeenCalled();
    const [billing] = await getTestDb().select().from(contractLines).where(eq(contractLines.id, f.lineA.id));
    expect(billing!.manualQuantity).toBe('10.00');
  });

  it('refuses an order outside the selected org before any Pax8 read or write', async () => {
    const result = await run('manage_pax8_orders', { action: 'add_line', orderId: f.orderB.id,
      line: { action: 'new_subscription', pax8ProductId: PRODUCT, catalogItemId: f.catalog.id, billingTerm: 'Monthly', quantity: '5' } }, f.selected);
    expect(['FORBIDDEN', 'NOT_FOUND'], result.raw).toContain(result.body.code);
    expect(await getTestDb().select().from(pax8OrderLines).where(eq(pax8OrderLines.orderId, f.orderB.id))).toHaveLength(0);
    expect(vendor.createClient).not.toHaveBeenCalled();
  });

  it('preview with an unresolved company writes nothing and never sends staged content', async () => {
    await getTestDb().update(pax8Orders).set({ pax8CompanyId: null }).where(eq(pax8Orders.id, f.order.id));
    await getTestDb().insert(pax8OrderLines).values({
      orderId: f.order.id, partnerId: f.partner.id, orgId: f.orgA.id, action: 'new_subscription',
      pax8ProductId: PRODUCT, catalogItemId: f.catalog.id, billingTerm: 'Monthly', commitmentTermId: TERM, quantity: '5',
    });
    const state = async () => ({
      orders: await getTestDb().select().from(pax8Orders).where(eq(pax8Orders.id, f.order.id)),
      lines: await getTestDb().select().from(pax8OrderLines).where(eq(pax8OrderLines.orderId, f.order.id)),
      billing: await getTestDb().select().from(contractLines).where(eq(contractLines.id, f.lineA.id)),
    });
    const before = await state();
    const result = await run('manage_pax8_orders', { action: 'preview', orderId: f.order.id }, f.auth);
    expect(result.body.error, result.raw).toBeUndefined();
    expect(result.body.order.id).toBe(f.order.id);
    expect(result.body.lines[0]).toMatchObject({ unitCost: '8.00', quantity: '5.00' });
    expect(await state()).toEqual(before);
    expect(vendor.createOrder).not.toHaveBeenCalled();
    expect(vendor.pricing).toHaveBeenCalledWith(PRODUCT);
  });

  it('never exposes encrypted values, raw subscriptions, or company metadata on any read projection', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['get_pax8_status', {}], ['get_pax8_status', { view: 'companies' }],
      ['manage_pax8_subscriptions', { action: 'list' }], ['manage_pax8_subscriptions', { action: 'drift' }],
      ['search_pax8_products', { action: 'search' }], ['search_pax8_products', { action: 'pricing', productId: PRODUCT }],
      ['manage_pax8_orders', { action: 'list' }], ['manage_pax8_orders', { action: 'get', orderId: f.order.id }],
      ['manage_pax8_orders', { action: 'preview', orderId: f.order.id }],
    ];
    for (const [tool, input] of calls) {
      const result = await run(tool, input, f.auth);
      expect(result.body.error, `${tool} ${result.raw}`).toBeUndefined();
      expect(result.raw, tool).not.toMatch(/_encrypted|Encrypted|accessToken|"raw"|"metadata"/);
      for (const secret of [CLIENT_SECRET, TOKEN_SECRET, RAW_MARKER]) expect(result.raw, tool).not.toContain(secret);
    }
  });
});
