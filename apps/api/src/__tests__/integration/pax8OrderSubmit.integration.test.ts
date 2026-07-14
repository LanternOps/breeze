import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { getTestDb } from './setup';

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
    const failureMessages = results.flatMap((result) => result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : []);

    expect(results.filter((result) => result.status === 'fulfilled'), failureMessages.join(' | ')).toHaveLength(1);
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
    await withSystemDbAccessContext(() => db.insert(pax8OrderLines).values({
      orderId: rejectedFixture.order.id,
      partnerId: rejectedFixture.partner.id,
      orgId: rejectedFixture.org.id,
      action: 'change_quantity',
      targetSubscriptionId: 'mixed-subscription',
      quantity: '3.00',
    }));

    const result = await rejectedService.submitOrder({
      partnerId: rejectedFixture.partner.id,
      orderId: rejectedFixture.order.id,
      actorUserId: rejectedFixture.user.id,
    });

    const [contractLine] = await withSystemDbAccessContext(() =>
      db.select().from(contractLines).where(eq(contractLines.id, rejectedFixture.contractLine.id)));
    expect(result.status).toBe('failed');
    expect(result.lines).toHaveLength(2);
    expect(result.lines.every((line) => line.submitState === 'failed' && line.error === raw)).toBe(true);
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

    const timeoutFixture = await seedOrder();
    const timeoutClient = successfulClient();
    timeoutClient.createOrder.mockReset()
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    const timeoutService = serviceWithClient(timeoutClient);
    const timeoutResult = await timeoutService.submitOrder({
      partnerId: timeoutFixture.partner.id,
      orderId: timeoutFixture.order.id,
      actorUserId: timeoutFixture.user.id,
    });
    expect(timeoutResult.lines[0]?.submitState).toBe('needs_reconcile');
    await withSystemDbAccessContext(() => db.update(pax8CompanyMappings)
      .set({ pax8CompanyId: 'company-2', pax8CompanyName: 'Acme remapped' })
      .where(eq(pax8CompanyMappings.orgId, timeoutFixture.org.id)));
    const reconcileClient = {
      ...successfulClient(),
      listOrders: vi.fn().mockResolvedValue([]),
      listSubscriptions: vi.fn().mockResolvedValue([]),
    };
    const reconcileService = serviceWithClient(reconcileClient);
    await reconcileService.reconcileOrder({
      partnerId: timeoutFixture.partner.id,
      orderId: timeoutFixture.order.id,
    });
    const [timeoutOrder] = await withSystemDbAccessContext(() => db.select()
      .from(pax8Orders).where(eq(pax8Orders.id, timeoutFixture.order.id)));
    expect(reconcileClient.listOrders).toHaveBeenCalledWith({ companyId: 'company-1' });
    expect(reconcileClient.listSubscriptions).toHaveBeenCalledWith({ companyId: 'company-1' });
    expect(timeoutOrder?.pax8CompanyId).toBe('company-1');

    const rollbackFixture = await seedOrder();
    const rollbackClient = successfulClient();
    rollbackClient.createOrder.mockReset()
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockImplementationOnce(async () => {
        await withSystemDbAccessContext(() => db.delete(contractLines)
          .where(eq(contractLines.id, rollbackFixture.contractLine.id)));
        return {
          pax8OrderId: 'pax-order-rollback',
          lineItems: [{ lineItemNumber: 1, productId: 'product-1', subscriptionId: 'subscription-rollback' }],
        };
      });
    const rollbackService = serviceWithClient(rollbackClient);
    await expect(rollbackService.submitOrder({
      partnerId: rollbackFixture.partner.id,
      orderId: rollbackFixture.order.id,
      actorUserId: rollbackFixture.user.id,
    })).rejects.toMatchObject({ status: 409 });
    const rollbackState = await withSystemDbAccessContext(async () => {
      const [order] = await db.select().from(pax8Orders).where(eq(pax8Orders.id, rollbackFixture.order.id));
      const [line] = await db.select().from(pax8OrderLines).where(eq(pax8OrderLines.id, rollbackFixture.line.id));
      return { order, line };
    });
    expect(rollbackState.order?.status).toBe('submitting');
    expect(rollbackState.line?.submitState).toBe('in_flight');

    const duplicateFixture = await seedOrder({ action: 'cancel' });
    await withSystemDbAccessContext(() => db.insert(pax8OrderLines).values({
      orderId: duplicateFixture.order.id,
      partnerId: duplicateFixture.partner.id,
      orgId: duplicateFixture.org.id,
      action: 'change_quantity',
      targetSubscriptionId: 'subscription-cancel',
      quantity: '2.00',
    }));
    const duplicateClient = successfulClient();
    await expect(serviceWithClient(duplicateClient).submitOrder({
      partnerId: duplicateFixture.partner.id,
      orderId: duplicateFixture.order.id,
      actorUserId: duplicateFixture.user.id,
    })).rejects.toMatchObject({ status: 422 });
    expect(duplicateClient.createOrder).not.toHaveBeenCalled();
    expect(duplicateClient.cancelSubscription).not.toHaveBeenCalled();

    const wrongPartner = await withSystemDbAccessContext(() => createPartner());
    const isolatedClient = successfulClient();
    await expect(serviceWithClient(isolatedClient).submitOrder({
      partnerId: wrongPartner.id,
      orderId: duplicateFixture.order.id,
      actorUserId: duplicateFixture.user.id,
    })).rejects.toMatchObject({ status: 404 });
    expect(isolatedClient.createOrder).not.toHaveBeenCalled();

    const staleFixture = await seedOrder();
    await getTestDb().execute(sql`DROP TRIGGER IF EXISTS task4_delay_pax8_order_update ON pax8_orders`);
    await getTestDb().execute(sql`
        CREATE OR REPLACE FUNCTION task4_delay_pax8_order_update() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.25); RETURN NEW; END $$
      `);
    await getTestDb().execute(sql`
        CREATE TRIGGER task4_delay_pax8_order_update
        BEFORE UPDATE ON pax8_orders
        FOR EACH ROW EXECUTE FUNCTION task4_delay_pax8_order_update()
      `);
    try {
      const staleClient = successfulClient();
      const staleService = serviceWithClient(staleClient);
      const attempts = await Promise.allSettled([
        staleService.preflightOrder({ partnerId: staleFixture.partner.id, orderId: staleFixture.order.id }),
        staleService.preflightOrder({ partnerId: staleFixture.partner.id, orderId: staleFixture.order.id }),
      ]);
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
      expect(staleClient.createOrder).toHaveBeenCalledTimes(1);
    } finally {
      await getTestDb().execute(sql`DROP TRIGGER IF EXISTS task4_delay_pax8_order_update ON pax8_orders`);
      await getTestDb().execute(sql`DROP FUNCTION IF EXISTS task4_delay_pax8_order_update()`);
    }
  });
});
