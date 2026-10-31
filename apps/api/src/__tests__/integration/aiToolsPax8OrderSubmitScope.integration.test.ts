/** W15 PR B: real claim/RLS/digest/billing persistence; only Pax8 HTTP is mocked. */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import {
  actionIntents, approvalRequests, catalogItems, contractLines, contracts,
  pax8CompanyMappings, pax8Integrations, pax8OrderLines, pax8Orders, pax8ProductMappings,
} from '../../db/schema';
import { buildDbAccessContext, buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { aiTools, executeTool, toolManagesDbContext } from '../../services/aiTools';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { decideApprovalRequest } from '../../services/approvals/decideApprovalRequest';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { pax8OrderSubmitRepository } from '../../services/pax8OrderSubmitRepository';
import type { Pax8Client } from '../../services/pax8Client';
import {
  assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const vendor = vi.hoisted(() => ({
  factory: vi.fn(), dependencies: vi.fn(), pricing: vi.fn(), createOrder: vi.fn(),
  listOrders: vi.fn(), listSubscriptions: vi.fn(),
}));
vi.mock('../../services/pax8SyncService', async original => ({
  ...await original<typeof import('../../services/pax8SyncService')>(),
  createPax8ClientForIntegration: vendor.factory,
}));
const TOOL = 'manage_pax8_orders';
const COMPANY = 'fixture-company';
const PRODUCT = 'fixture-product';
const TERM = 'fixture-term';
const REMOTE_ORDER = 'fixture-remote-order';
const REMOTE_SUBSCRIPTION = 'fixture-remote-subscription';
const READY = { contacts: [{ types: ['Admin', 'Billing', 'Technical'].map(type => ({ type, primary: true })) }] };

function authFor(user: { id: string; email: string }, partnerId: string, orgId: string, roleId: string): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Fixture Operator', isPlatformAdmin: false },
    token: { sub: user.id, email: user.email, roleId, orgId, partnerId, scope: 'partner', type: 'access', mfa: true },
    scope: 'partner', orgId, partnerId, partnerOrgAccess: 'all', accessibleOrgIds: [orgId],
    ...buildOrgAccessClosures([orgId]), canAccessSite: () => true,
  } as AuthContext;
}
function context(auth: AuthContext) {
  return buildDbAccessContext({ scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [],
    partnerId: auth.partnerId, userId: auth.user.id });
}
async function run(input: Record<string, unknown>, auth: AuthContext) {
  const call = () => executeTool(TOOL, input, auth);
  const raw = toolManagesDbContext(aiTools.get(TOOL), input) ? await call() : await withDbAccessContext(context(auth), call);
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

async function seed() {
  const database = getTestDb();
  const partner = await createPartner();
  const otherPartner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: otherPartner.id });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
  const requester = await createUser({ partnerId: partner.id, email: `fixture-requester-${randomUUID()}@example.com`, mfaEnabled: true });
  const approver = await createUser({ partnerId: partner.id, email: `fixture-approver-${randomUUID()}@example.com`, mfaEnabled: true });
  await assignUserToPartner(requester.id, partner.id, role.id, 'all');
  await assignUserToPartner(approver.id, partner.id, role.id, 'all');
  const otherRole = await createRole({ scope: 'partner', partnerId: otherPartner.id });
  await grantRolePermissions(otherRole.id, [{ resource: '*', action: '*' }]);
  const otherUser = await createUser({ partnerId: otherPartner.id, email: `fixture-other-${randomUUID()}@example.com` });
  await assignUserToPartner(otherUser.id, otherPartner.id, otherRole.id, 'all');
  const [integration] = await database.insert(pax8Integrations).values({
    partnerId: partner.id, name: 'Fixture Integration', clientIdEncrypted: 'fixture-encrypted-client-id',
    clientSecretEncrypted: 'fixture-encrypted-client-secret',
    apiBaseUrl: 'https://vendor.example.com/v1', tokenUrl: 'https://vendor.example.com/token',
  }).returning();
  if (!integration) throw new Error('integration fixture missing');
  await database.insert(pax8CompanyMappings).values({
    integrationId: integration.id, partnerId: partner.id, orgId: org.id,
    pax8CompanyId: COMPANY, pax8CompanyName: 'Fixture Company', status: 'Active', metadata: READY,
  });
  const [catalog] = await database.insert(catalogItems).values({
    partnerId: partner.id, itemType: 'software', name: 'Fixture Seats', billingType: 'recurring',
    billingFrequency: 'monthly', costCurrency: 'USD', taxable: false,
  }).returning();
  if (!catalog) throw new Error('catalog fixture missing');
  await database.insert(pax8ProductMappings).values({ integrationId: integration.id, partnerId: partner.id,
    pax8ProductId: PRODUCT, productName: 'Fixture Seats', vendorSkuId: 'fixture-sku', catalogItemId: catalog.id });
  const [contract] = await database.insert(contracts).values({ partnerId: partner.id, orgId: org.id,
    name: 'Fixture Contract', intervalMonths: 1, startDate: '2026-10-01', currencyCode: 'USD' }).returning();
  if (!contract) throw new Error('contract fixture missing');
  const [billingLine] = await database.insert(contractLines).values({ contractId: contract.id, orgId: org.id,
    lineType: 'manual', description: 'Fixture Seats', manualQuantity: '0.00', unitPrice: '12.00' }).returning();
  if (!billingLine) throw new Error('billing fixture missing');
  const [order] = await database.insert(pax8Orders).values({ integrationId: integration.id,
    partnerId: partner.id, orgId: org.id, source: 'quote', status: 'draft',
    dedupeKey: `fixture:${randomUUID()}`, createdBy: requester.id }).returning();
  if (!order) throw new Error('order fixture missing');
  const [line] = await database.insert(pax8OrderLines).values({ orderId: order.id, partnerId: partner.id,
    orgId: org.id, action: 'new_subscription', pax8ProductId: PRODUCT, catalogItemId: catalog.id,
    billingTerm: 'Monthly', commitmentTermId: TERM, quantity: '7.00', contractLineId: billingLine.id }).returning();
  if (!line) throw new Error('line fixture missing');
  vendor.factory.mockResolvedValue({ integration, client: {
    getProductDependencies: vendor.dependencies, getProductPricing: vendor.pricing, createOrder: vendor.createOrder,
    listOrders: vendor.listOrders, listSubscriptions: vendor.listSubscriptions,
  } });
  return { partner, org, integration, billingLine, order, line, requester, approver,
    auth: authFor(requester, partner.id, org.id, role.id),
    approverAuth: authFor(approver, partner.id, org.id, role.id),
    otherAuth: authFor(otherUser, otherPartner.id, otherOrg.id, otherRole.id) };
}
let f: Awaited<ReturnType<typeof seed>>;
beforeEach(async () => {
  vi.clearAllMocks();
  vendor.dependencies.mockResolvedValue({ commitments: [{ id: TERM, term: 'Annual',
    allowForQuantityIncrease: true, allowForQuantityDecrease: true, allowForEarlyCancellation: true, cancellationFeeApplied: false }] });
  vendor.pricing.mockResolvedValue([{ billingTerm: 'Monthly', commitmentTerm: 'Annual', partnerBuyRate: '8.00', currencyCode: 'USD', raw: {} }]);
  vendor.createOrder.mockImplementation(async (_input, options) => options?.isMock
    ? { pax8OrderId: null, lineItems: [] }
    : { pax8OrderId: REMOTE_ORDER, lineItems: [{ lineItemNumber: 1, productId: PRODUCT, subscriptionId: REMOTE_SUBSCRIPTION }] });
  vendor.listOrders.mockResolvedValue([]);
  vendor.listSubscriptions.mockResolvedValue([]);
  f = await seed();
});
afterEach(() => { vi.restoreAllMocks(); });

async function approvedArguments() {
  const preview = await run({ action: 'preview', orderId: f.order.id }, f.auth);
  expect(preview.body.blocked, preview.raw).toEqual([]);
  expect(preview.body.previewDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.body.submitWith).toBeTruthy();
  return { action: 'submit', ...preview.body.submitWith };
}
async function state() {
  const database = getTestDb();
  const [order] = await database.select().from(pax8Orders).where(eq(pax8Orders.id, f.order.id));
  const [line] = await database.select().from(pax8OrderLines).where(eq(pax8OrderLines.id, f.line.id));
  const [billing] = await database.select().from(contractLines).where(eq(contractLines.id, f.billingLine.id));
  return { order: order!, line: line!, billing: billing! };
}

describe('Pax8 AI approved submit scope and execution binding (real PostgreSQL)', () => {
  it('partner B cannot submit partner A order: no row changes and no client construction', async () => {
    const input = await approvedArguments();
    const before = await state();
    vendor.factory.mockClear(); vendor.createOrder.mockClear();
    const result = await run(input, f.otherAuth);
    expect(result.body.code, result.raw).toBe('NOT_FOUND');
    expect(await state()).toEqual(before);
    expect(vendor.factory).not.toHaveBeenCalled();
    expect(vendor.createOrder).not.toHaveBeenCalled();
  });

  it('an edit after intent creation fails real release with content_changed before any Pax8 HTTP', async () => {
    const input = await approvedArguments();
    const intent = await createActionIntent(f.auth, { toolName: TOOL, input, source: 'chat', orgId: f.org.id });
    expect(intent.status).toBe('pending_approval');
    const [approval] = await getTestDb().select().from(approvalRequests).where(and(
      eq(approvalRequests.intentId, intent.id), eq(approvalRequests.userId, f.approver.id),
    ));
    expect(approval).toBeTruthy();
    const decision = await withDbAccessContext(context(f.approverAuth), () => decideApprovalRequest({
      auth: f.approverAuth, id: approval!.id, status: 'approved',
    }));
    expect(decision.httpStatus, JSON.stringify(decision.body)).toBe(200);
    const readIntent = async () => (await getTestDb().select().from(actionIntents).where(eq(actionIntents.id, intent.id)))[0]!;
    const approved = await readIntent();
    expect(approved.status).toBe('approved');
    expect(approved.approvalScope).toBe('four_eyes');
    expect(approved.effectDigest).toMatch(/^[a-f0-9]{64}$/);
    await getTestDb().update(pax8OrderLines).set({ quantity: '8.00' }).where(eq(pax8OrderLines.id, f.line.id));
    vendor.factory.mockClear(); vendor.createOrder.mockClear();
    await releaseApprovedIntent(intent.id);
    const released = await readIntent();
    expect(released.status).toBe('failed');
    expect(released.errorCode).toBe('content_changed');
    expect(released.executedAt).toBeNull();
    expect(released.effectDigest).toBe(approved.effectDigest);
    expect((await state()).order.status).toBe('draft');
    expect(vendor.factory).not.toHaveBeenCalled();
    expect(vendor.createOrder).not.toHaveBeenCalled();
  });

  it('an edit inside verifyClaim after the release read refuses and rolls the claim back to draft', async () => {
    const input = await approvedArguments();
    const claimOrder = pax8OrderSubmitRepository.claimOrder;
    const verification = vi.fn();
    vi.spyOn(pax8OrderSubmitRepository, 'claimOrder').mockImplementationOnce(args => claimOrder({
      ...args,
      verifyClaim: async (bundle, database) => {
        // Deliberately use the claim transaction: a separate connection would
        // wait for its parent lock and could not model this exact check/use gap.
        await database.update(pax8OrderLines).set({ quantity: '8.00' }).where(eq(pax8OrderLines.id, f.line.id));
        const [edited] = await database.select({ quantity: pax8OrderLines.quantity }).from(pax8OrderLines)
          .where(eq(pax8OrderLines.id, f.line.id));
        expect(edited?.quantity).toBe('8.00');
        verification();
        expect(args.verifyClaim).toBeTypeOf('function');
        await args.verifyClaim!(bundle, database);
      },
    }));
    vendor.createOrder.mockClear();
    const result = await run(input, f.auth);
    expect(verification).toHaveBeenCalledTimes(1);
    expect(result.body.code, result.raw).toBe('PREVIEW_MISMATCH');
    const current = await state();
    expect(current.order.status).toBe('draft');
    expect(current.order.submittedAt).toBeNull();
    expect(current.line.submitState).toBe('pending');
    expect(current.line.quantity).toBe('7.00');
    expect(current.line.authorizedBaselineQuantity).toBeNull();
    expect(current.billing.manualQuantity).toBe('0.00');
    expect(vendor.createOrder).not.toHaveBeenCalled();
  });

  it('an approved successful submit persists the captured baseline and linked manual billing quantity', async () => {
    const result = await run(await approvedArguments(), f.auth);
    expect(result.body.status, result.raw).toBe('completed');
    expect(result.body.lines).toEqual([{ lineId: f.line.id, submitState: 'succeeded', error: null }]);
    const current = await state();
    expect(current.line.authorizedBaselineQuantity).toBe('0.00');
    expect(current.line.resultSubscriptionId).toBe(REMOTE_SUBSCRIPTION);
    expect(current.billing.manualQuantity).toBe('7.00');
    expect(vendor.createOrder).toHaveBeenCalledTimes(2);
    expect(vendor.createOrder.mock.calls[0]?.[1]).toEqual({ isMock: true });
    expect(vendor.createOrder.mock.calls[1]?.[1]).toBeUndefined();
  });

  it('a mocked timeout remains needs_reconcile until a unique listOrders match resolves billing without resending', async () => {
    const input = await approvedArguments();
    vendor.createOrder.mockImplementation(async (_input, options) => {
      if (options?.isMock) return { pax8OrderId: null, lineItems: [] };
      throw new Error('Fixture timeout after request was sent');
    });
    const submitted = await run(input, f.auth);
    expect(submitted.body.lines, submitted.raw).toEqual([expect.objectContaining({ lineId: f.line.id, submitState: 'needs_reconcile' })]);
    const unknown = await state();
    expect(unknown.line.authorizedBaselineQuantity).toBe('0.00');
    expect(unknown.billing.manualQuantity).toBe('0.00');
    expect(unknown.order.submittedAt).toBeInstanceOf(Date);
    vendor.listOrders.mockResolvedValue([{
      pax8OrderId: REMOTE_ORDER, pax8CompanyId: COMPANY,
      createdDate: unknown.order.submittedAt!.toISOString().slice(0, 10),
      lineItems: [{ lineItemNumber: 1, productId: PRODUCT, quantity: '7.00', quantityKnown: true, subscriptionId: REMOTE_SUBSCRIPTION }], raw: {},
    } satisfies Awaited<ReturnType<Pax8Client['listOrders']>>[number]]);
    const reconciled = await run({ action: 'reconcile', orderId: f.order.id }, f.auth);
    expect(reconciled.body, reconciled.raw).toEqual({ resolved: 1, stillUnknown: 0 });
    const current = await state();
    expect(current.order.status).toBe('completed');
    expect(current.line.submitState).toBe('succeeded');
    expect(current.line.resultSubscriptionId).toBe(REMOTE_SUBSCRIPTION);
    expect(current.billing.manualQuantity).toBe('7.00');
    expect(vendor.listOrders).toHaveBeenCalledWith({ companyId: COMPANY });
    expect(vendor.createOrder).toHaveBeenCalledTimes(2);
  });
});
