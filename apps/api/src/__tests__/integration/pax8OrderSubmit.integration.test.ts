import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  contractLines,
  contracts,
  pax8CompanyMappings,
  pax8Integrations,
  pax8OrderLines,
  pax8Orders,
} from '../../db/schema';
import { Pax8ApiError } from '../../services/pax8Client';
import { createPax8OrderSubmitService } from '../../services/pax8OrderSubmit';
import { pax8OrderSubmitRepository } from '../../services/pax8OrderSubmitRepository';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedOrder(options: { action?: 'new_subscription' | 'cancel' } = {}) {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const [integration] = await db.insert(pax8Integrations).values({
      partnerId: partner.id,
      name: 'Pax8 submit test',
      clientIdEncrypted: 'enc:test-client',
      clientSecretEncrypted: 'enc:test-secret',
      tokenUrl: 'https://api.pax8.com/v1/token',
    }).returning();
    if (!integration) throw new Error('failed to seed integration');
    await db.insert(pax8CompanyMappings).values({
      integrationId: integration.id,
      partnerId: partner.id,
      pax8CompanyId: 'company-1',
      pax8CompanyName: 'Acme',
      orgId: org.id,
    });
    const [contract] = await db.insert(contracts).values({
      partnerId: partner.id,
      orgId: org.id,
      name: 'Pax8 contract',
      intervalMonths: 1,
      startDate: '2026-07-14',
    }).returning();
    if (!contract) throw new Error('failed to seed contract');
    const [contractLine] = await db.insert(contractLines).values({
      contractId: contract.id,
      orgId: org.id,
      lineType: 'manual',
      description: 'Pax8 seats',
      unitPrice: '10.00',
      manualQuantity: null,
    }).returning();
    if (!contractLine) throw new Error('failed to seed contract line');
    const [order] = await db.insert(pax8Orders).values({
      integrationId: integration.id,
      partnerId: partner.id,
      orgId: org.id,
      pax8CompanyId: null,
      status: 'ready',
      source: 'quote',
      dedupeKey: `submit-test:${randomUUID()}`,
      createdBy: user.id,
    }).returning();
    if (!order) throw new Error('failed to seed order');
    const action = options.action ?? 'new_subscription';
    const [line] = await db.insert(pax8OrderLines).values({
      orderId: order.id,
      partnerId: partner.id,
      orgId: org.id,
      action,
      pax8ProductId: action === 'new_subscription' ? 'product-1' : null,
      billingTerm: action === 'new_subscription' ? 'Monthly' : null,
      quantity: action === 'new_subscription' ? '7.00' : null,
      targetSubscriptionId: action === 'cancel' ? 'subscription-cancel' : null,
      contractLineId: contractLine.id,
    }).returning();
    if (!line) throw new Error('failed to seed order line');
    return { partner, org, user, order, line, contractLine };
  });
}

function serviceWithClient(client: Record<string, unknown>) {
  return createPax8OrderSubmitService({
    repository: {
      ...pax8OrderSubmitRepository,
      createClient: vi.fn().mockResolvedValue(client),
    },
    runOutsideDbContext: (fn) => fn(),
  });
}

function successfulClient() {
  return {
    createOrder: vi.fn()
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockResolvedValueOnce({
        pax8OrderId: 'pax-order-1',
        lineItems: [{ lineItemNumber: 1, productId: 'product-1', subscriptionId: 'subscription-1' }],
      }),
    updateSubscriptionQuantity: vi.fn(),
    cancelSubscription: vi.fn(),
    listOrders: vi.fn(),
    listSubscriptions: vi.fn(),
  };
}

describe('Pax8 submit pipeline (real Postgres)', () => {
  runDb('atomically claims one submit, persists billing success, and keeps rejected billing untouched', async () => {
    const fixture = await seedOrder();
    const client = successfulClient();
    const service = serviceWithClient(client);
    const input = { partnerId: fixture.partner.id, orderId: fixture.order.id, actorUserId: fixture.user.id };

    const results = await Promise.allSettled([service.submitOrder(input), service.submitOrder(input)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(client.createOrder).toHaveBeenCalledTimes(2); // one winner: isMock + one real POST

    const state = await withSystemDbAccessContext(async () => {
      const [line] = await db.select().from(pax8OrderLines).where(eq(pax8OrderLines.id, fixture.line.id));
      const [contractLine] = await db.select().from(contractLines).where(eq(contractLines.id, fixture.contractLine.id));
      return { line, contractLine };
    });
    expect(state.line?.submitState).toBe('succeeded');
    expect(state.line?.resultSubscriptionId).toBe('subscription-1');
    expect(state.contractLine?.manualQuantity).toBe('7.00');

    const rejectedFixture = await seedOrder();
    const raw = '{"details":[{"message":"msDomain is required"}]}';
    const rejectedClient = successfulClient();
    rejectedClient.createOrder.mockReset()
      .mockRejectedValueOnce(new Pax8ApiError('Pax8 API returned 422', 422, raw));
    const rejectedService = serviceWithClient(rejectedClient);

    const result = await rejectedService.submitOrder({
      partnerId: rejectedFixture.partner.id,
      orderId: rejectedFixture.order.id,
      actorUserId: rejectedFixture.user.id,
    });

    const [contractLine] = await withSystemDbAccessContext(() =>
      db.select().from(contractLines).where(eq(contractLines.id, rejectedFixture.contractLine.id)));
    expect(result.status).toBe('failed');
    expect(result.lines[0]?.error).toBe(raw);
    expect(contractLine?.manualQuantity).toBeNull();
    expect(rejectedClient.createOrder).toHaveBeenCalledTimes(1);

    const cancelFixture = await seedOrder({ action: 'cancel' });
    const cancelClient = successfulClient();
    const cancelService = serviceWithClient(cancelClient);
    await cancelService.submitOrder({
      partnerId: cancelFixture.partner.id,
      orderId: cancelFixture.order.id,
      actorUserId: cancelFixture.user.id,
    });
    const [cancelContractLine] = await withSystemDbAccessContext(() =>
      db.select().from(contractLines).where(eq(contractLines.id, cancelFixture.contractLine.id)));
    expect(cancelClient.createOrder).not.toHaveBeenCalled();
    expect(cancelClient.cancelSubscription).toHaveBeenCalledWith('subscription-cancel', null);
    expect(cancelContractLine?.manualQuantity).toBe('0.00');
  });
});
