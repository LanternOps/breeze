import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  contractLines,
  contracts,
  catalogItems,
  pax8CompanyMappings,
  pax8ContractLineLinks,
  pax8Integrations,
  pax8OrderLines,
  pax8Orders,
  pax8ProductMappings,
  pax8SubscriptionSnapshots,
} from '../../db/schema';
import { Pax8ApiError } from '../../services/pax8Client';
import { createPax8OrderSubmitService } from '../../services/pax8OrderSubmit';
import { pax8OrderSubmitRepository } from '../../services/pax8OrderSubmitRepository';
import { updateOrderLine } from '../../services/pax8OrderService';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const READY_COMPANY_METADATA = {
  contacts: [{ types: [
    { type: 'Admin', primary: true },
    { type: 'Billing', primary: true },
    { type: 'Technical', primary: true },
  ] }],
};

async function seedOrder(options: {
  action?: 'new_subscription' | 'cancel';
  source?: 'direct' | 'quote';
  companyReady?: boolean;
} = {}) {
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
    const [catalogItem] = await db.insert(catalogItems).values({
      partnerId: partner.id,
      itemType: 'software',
      name: 'Pax8 submit product',
      billingType: 'recurring',
      billingFrequency: 'monthly',
      unitPrice: '10.00',
      taxable: false,
    }).returning();
    if (!catalogItem) throw new Error('failed to seed catalog item');
    await db.insert(pax8ProductMappings).values({
      integrationId: integration.id,
      partnerId: partner.id,
      pax8ProductId: 'product-1',
      productName: 'Pax8 submit product',
      catalogItemId: catalogItem.id,
    });
    await db.insert(pax8CompanyMappings).values({
      integrationId: integration.id,
      partnerId: partner.id,
      pax8CompanyId: 'company-1',
      pax8CompanyName: 'Acme',
      orgId: org.id,
      status: 'Active',
      metadata: options.companyReady === false ? {} : READY_COMPANY_METADATA,
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
      manualQuantity: options.action === 'cancel' ? '7.00' : null,
    }).returning();
    if (!contractLine) throw new Error('failed to seed contract line');
    const [order] = await db.insert(pax8Orders).values({
      integrationId: integration.id,
      partnerId: partner.id,
      orgId: org.id,
      pax8CompanyId: null,
      status: 'ready',
      source: options.source ?? 'quote',
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
      catalogItemId: action === 'new_subscription' ? catalogItem.id : null,
      billingTerm: action === 'new_subscription' ? 'Monthly' : null,
      quantity: action === 'new_subscription' ? '7.00' : null,
      targetSubscriptionId: action === 'cancel' ? 'subscription-cancel' : null,
      contractLineId: contractLine.id,
    }).returning();
    if (!line) throw new Error('failed to seed order line');
    if (action === 'cancel') {
      const [snapshot] = await db.insert(pax8SubscriptionSnapshots).values({
        integrationId: integration.id,
        partnerId: partner.id,
        pax8CompanyId: 'company-1',
        pax8SubscriptionId: 'subscription-cancel',
        orgId: org.id,
        productId: 'product-1',
        quantity: '99.00',
        quantityKnown: false,
      }).returning();
      if (!snapshot) throw new Error('failed to seed subscription snapshot');
      await db.insert(pax8ContractLineLinks).values({
        integrationId: integration.id,
        partnerId: partner.id,
        orgId: org.id,
        subscriptionSnapshotId: snapshot.id,
        contractLineId: contractLine.id,
      });
    }
    return { partner, org, user, order, line, contractLine, integration, catalogItem };
  });
}

function serviceWithClient(client: Record<string, unknown>) {
  return serviceHarness(client).service;
}

function serviceHarness(client: Record<string, unknown>) {
  const createClient = vi.fn().mockResolvedValue(client);
  return {
    createClient,
    service: createPax8OrderSubmitService({
      repository: {
        ...pax8OrderSubmitRepository,
        createClient,
      },
      runOutsideDbContext: (fn) => fn(),
    }),
  };
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

async function seedChangeOrder(options: { baseline: string | null; current: string }) {
  const fixture = await seedOrder({ action: 'cancel' });
  await withSystemDbAccessContext(async () => {
    await db.update(contractLines)
      .set({ manualQuantity: options.current })
      .where(eq(contractLines.id, fixture.contractLine.id));
    await db.update(pax8OrderLines).set({
      action: 'change_quantity',
      quantity: '15.00',
      cancelDate: null,
      authorizedBaselineQuantity: options.baseline,
    }).where(eq(pax8OrderLines.id, fixture.line.id));
  });
  return fixture;
}

describe('Pax8 submit pipeline (real Postgres)', () => {
  runDb('rejects unready direct and quote-staged orders before client creation or writes', async () => {
    for (const source of ['direct', 'quote'] as const) {
      const fixture = await seedOrder({ source, companyReady: false });
      const client = successfulClient();
      const { service, createClient } = serviceHarness(client);

      await expect(service.submitOrder({
        partnerId: fixture.partner.id,
        orderId: fixture.order.id,
        actorUserId: fixture.user.id,
      })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('ready') });

      expect(createClient).not.toHaveBeenCalled();
      expect(client.createOrder).not.toHaveBeenCalled();
      expect(client.updateSubscriptionQuantity).not.toHaveBeenCalled();
      expect(client.cancelSubscription).not.toHaveBeenCalled();
      const [state] = await withSystemDbAccessContext(() => db.select({
        status: pax8Orders.status,
      }).from(pax8Orders).where(eq(pax8Orders.id, fixture.order.id)));
      const [line] = await withSystemDbAccessContext(() => db.select({
        submitState: pax8OrderLines.submitState,
      }).from(pax8OrderLines).where(eq(pax8OrderLines.id, fixture.line.id)));
      expect(state?.status).toBe('ready');
      expect(line?.submitState).toBe('pending');
    }
  });

  runDb('rejects a staged future cancellation before any vendor or billing write', async () => {
    const fixture = await seedOrder({ action: 'cancel' });
    await withSystemDbAccessContext(() => db.update(pax8OrderLines)
      .set({ cancelDate: '2999-01-01' })
      .where(eq(pax8OrderLines.id, fixture.line.id)));
    const client = successfulClient();
    const { service, createClient } = serviceHarness(client);

    await expect(service.submitOrder({
      partnerId: fixture.partner.id,
      orderId: fixture.order.id,
      actorUserId: fixture.user.id,
    })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('future') });

    expect(createClient).not.toHaveBeenCalled();
    expect(client.cancelSubscription).not.toHaveBeenCalled();
    const state = await withSystemDbAccessContext(async () => {
      const [order] = await db.select().from(pax8Orders).where(eq(pax8Orders.id, fixture.order.id));
      const [line] = await db.select().from(pax8OrderLines).where(eq(pax8OrderLines.id, fixture.line.id));
      const [billing] = await db.select().from(contractLines).where(eq(contractLines.id, fixture.contractLine.id));
      return { order, line, billing };
    });
    expect(state.order?.status).toBe('ready');
    expect(state.line?.submitState).toBe('pending');
    expect(state.billing?.manualQuantity).toBe('7.00');
  });

  runDb('rejects a same-org unrelated staged contract line before vendor execution', async () => {
    const fixture = await seedOrder({ action: 'cancel' });
    const [contract] = await withSystemDbAccessContext(() => db.select()
      .from(contracts).where(eq(contracts.orgId, fixture.org.id)));
    const [unrelated] = await withSystemDbAccessContext(() => db.insert(contractLines).values({
      contractId: contract!.id,
      orgId: fixture.org.id,
      lineType: 'manual',
      description: 'Unrelated same-org line',
      unitPrice: '1.00',
      manualQuantity: '33.00',
    }).returning());
    await withSystemDbAccessContext(() => db.update(pax8OrderLines)
      .set({ contractLineId: unrelated!.id })
      .where(eq(pax8OrderLines.id, fixture.line.id)));
    const client = successfulClient();

    await expect(serviceWithClient(client).submitOrder({
      partnerId: fixture.partner.id,
      orderId: fixture.order.id,
      actorUserId: fixture.user.id,
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('no longer matches') });

    expect(client.cancelSubscription).not.toHaveBeenCalled();
    const [unrelatedAfter] = await withSystemDbAccessContext(() => db.select()
      .from(contractLines).where(eq(contractLines.id, unrelated!.id)));
    expect(unrelatedAfter?.manualQuantity).toBe('33.00');
  });

  runDb('rechecks an active direct product mapping at submit time', async () => {
    const fixture = await seedOrder({ source: 'direct' });
    await withSystemDbAccessContext(() => db.update(catalogItems)
      .set({ isActive: false })
      .where(eq(catalogItems.id, fixture.catalogItem.id)));
    const client = successfulClient();

    await expect(serviceWithClient(client).submitOrder({
      partnerId: fixture.partner.id,
      orderId: fixture.order.id,
      actorUserId: fixture.user.id,
    })).rejects.toMatchObject({ status: 422, message: expect.stringContaining('active') });

    expect(client.createOrder).not.toHaveBeenCalled();
  });

  runDb('fails closed when the manual quantity changed after direction authorization', async () => {
    const fixture = await seedChangeOrder({ baseline: '10.00', current: '20.00' });
    const client = successfulClient();
    const { service, createClient } = serviceHarness(client);

    await expect(service.submitOrder({
      partnerId: fixture.partner.id,
      orderId: fixture.order.id,
      actorUserId: fixture.user.id,
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('changed') });

    expect(createClient).not.toHaveBeenCalled();
    expect(client.updateSubscriptionQuantity).not.toHaveBeenCalled();
    const state = await withSystemDbAccessContext(async () => {
      const [orderRow] = await db.select().from(pax8Orders).where(eq(pax8Orders.id, fixture.order.id));
      const [lineRow] = await db.select().from(pax8OrderLines).where(eq(pax8OrderLines.id, fixture.line.id));
      const [billing] = await db.select().from(contractLines).where(eq(contractLines.id, fixture.contractLine.id));
      return { orderRow, lineRow, billing };
    });
    expect(state.orderRow?.status).toBe('ready');
    expect(state.lineRow?.submitState).toBe('pending');
    expect(state.billing?.manualQuantity).toBe('20.00');
  });

  runDb('fails closed for a legacy quantity change without an authorization baseline', async () => {
    const fixture = await seedChangeOrder({ baseline: null, current: '10.00' });
    const client = successfulClient();

    await expect(serviceWithClient(client).submitOrder({
      partnerId: fixture.partner.id,
      orderId: fixture.order.id,
      actorUserId: fixture.user.id,
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('baseline') });
    expect(client.updateSubscriptionQuantity).not.toHaveBeenCalled();
  });

  runDb('submits an unchanged authorized baseline and records the new billing quantity', async () => {
    const fixture = await seedChangeOrder({ baseline: '10.00', current: '10.00' });
    const client = successfulClient();

    await serviceWithClient(client).submitOrder({
      partnerId: fixture.partner.id,
      orderId: fixture.order.id,
      actorUserId: fixture.user.id,
    });

    expect(client.updateSubscriptionQuantity).toHaveBeenCalledWith('subscription-cancel', 15);
    const [billing] = await withSystemDbAccessContext(() => db.select()
      .from(contractLines).where(eq(contractLines.id, fixture.contractLine.id)));
    expect(billing?.manualQuantity).toBe('15.00');
  });

  runDb('uses post-lock PATCH values when PATCH wins and rejects PATCH when claim wins', async () => {
    const patchWins = await seedOrder();
    await withSystemDbAccessContext(() => db.update(pax8Orders)
      .set({ status: 'awaiting_details' })
      .where(eq(pax8Orders.id, patchWins.order.id)));
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const patchTransaction = getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM pax8_orders WHERE id = ${patchWins.order.id} FOR UPDATE`);
      locked();
      await releasePromise;
      await tx.update(pax8OrderLines).set({
        commitmentTermId: 'patched-commitment',
        provisioningDetails: [{ key: 'domain', values: ['patched.example'] }],
      }).where(eq(pax8OrderLines.id, patchWins.line.id));
    });
    await lockedPromise;
    const patchWinsClient = successfulClient();
    const submitPending = serviceWithClient(patchWinsClient).submitOrder({
      partnerId: patchWins.partner.id,
      orderId: patchWins.order.id,
      actorUserId: patchWins.user.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(patchWinsClient.createOrder).not.toHaveBeenCalled();
    release();
    await patchTransaction;
    await submitPending;
    expect(patchWinsClient.createOrder).toHaveBeenNthCalledWith(2, expect.objectContaining({
      lineItems: [expect.objectContaining({
        commitmentTermId: 'patched-commitment',
        provisioningDetails: [{ key: 'domain', values: ['patched.example'] }],
      })],
    }));

    const claimWins = await seedOrder();
    await withSystemDbAccessContext(() => db.update(pax8Orders)
      .set({ status: 'awaiting_details' })
      .where(eq(pax8Orders.id, claimWins.order.id)));
    const claimWinsClient = successfulClient();
    await serviceWithClient(claimWinsClient).submitOrder({
      partnerId: claimWins.partner.id,
      orderId: claimWins.order.id,
      actorUserId: claimWins.user.id,
    });
    await expect(updateOrderLine({
      partnerId: claimWins.partner.id,
      orderId: claimWins.order.id,
      lineId: claimWins.line.id,
      provisioningDetails: [{ key: 'domain', values: ['too-late.example'] }],
    })).rejects.toMatchObject({ status: 409 });
  });

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
    const result = await rejectedService.submitOrder({
      partnerId: rejectedFixture.partner.id,
      orderId: rejectedFixture.order.id,
      actorUserId: rejectedFixture.user.id,
    });

    const [contractLine] = await withSystemDbAccessContext(() =>
      db.select().from(contractLines).where(eq(contractLines.id, rejectedFixture.contractLine.id)));
    expect(result.status).toBe('failed');
    expect(result.lines).toHaveLength(1);
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

    const parentGuardFixture = await seedOrder();
    const capturedAt = new Date('2026-07-20T01:00:00Z');
    await withSystemDbAccessContext(async () => {
      await db.update(pax8Orders).set({
        status: 'submitting',
        pax8CompanyId: 'company-1',
        pax8OrderId: 'captured-parent',
        submittedAt: capturedAt,
      }).where(eq(pax8Orders.id, parentGuardFixture.order.id));
      await db.update(pax8OrderLines).set({ submitState: 'needs_reconcile' })
        .where(eq(pax8OrderLines.id, parentGuardFixture.line.id));
    });
    const parentGuardBundle = await pax8OrderSubmitRepository.loadReconcileOrder({
      partnerId: parentGuardFixture.partner.id,
      orderId: parentGuardFixture.order.id,
    });
    await expect(pax8OrderSubmitRepository.persistReconcileResults(
      parentGuardBundle,
      [{
        lineId: parentGuardFixture.line.id,
        submitState: 'succeeded',
        error: null,
        resultSubscriptionId: 'conflicting-subscription',
      }],
      'conflicting-parent',
    )).rejects.toMatchObject({ status: 409 });
    const parentGuardState = await withSystemDbAccessContext(async () => {
      const [order] = await db.select().from(pax8Orders)
        .where(eq(pax8Orders.id, parentGuardFixture.order.id));
      const [line] = await db.select().from(pax8OrderLines)
        .where(eq(pax8OrderLines.id, parentGuardFixture.line.id));
      const [contractLine] = await db.select().from(contractLines)
        .where(eq(contractLines.id, parentGuardFixture.contractLine.id));
      return { order, line, contractLine };
    });
    expect(parentGuardState.order?.pax8OrderId).toBe('captured-parent');
    expect(parentGuardState.line?.submitState).toBe('needs_reconcile');
    expect(parentGuardState.line?.resultSubscriptionId).toBeNull();
    expect(parentGuardState.contractLine?.manualQuantity).toBeNull();
    await expect(pax8OrderSubmitRepository.persistReconcileResults(
      parentGuardBundle,
      [{
        lineId: parentGuardFixture.line.id,
        submitState: 'succeeded',
        error: null,
        resultSubscriptionId: 'captured-subscription',
      }],
      'captured-parent',
    )).resolves.toEqual({ resolved: 1, stillUnknown: 0 });

    const nullParentFixture = await seedOrder();
    await withSystemDbAccessContext(async () => {
      await db.update(pax8Orders).set({
        status: 'submitting',
        pax8CompanyId: 'company-1',
        submittedAt: capturedAt,
      }).where(eq(pax8Orders.id, nullParentFixture.order.id));
      await db.update(pax8OrderLines).set({ submitState: 'needs_reconcile' })
        .where(eq(pax8OrderLines.id, nullParentFixture.line.id));
    });
    const nullParentBundle = await pax8OrderSubmitRepository.loadReconcileOrder({
      partnerId: nullParentFixture.partner.id,
      orderId: nullParentFixture.order.id,
    });
    await expect(pax8OrderSubmitRepository.persistReconcileResults(
      nullParentBundle,
      [{
        lineId: nullParentFixture.line.id,
        submitState: 'succeeded',
        error: null,
        resultSubscriptionId: 'matched-subscription',
      }],
      'matched-parent',
    )).resolves.toEqual({ resolved: 1, stillUnknown: 0 });
    const [nullParentOrder] = await withSystemDbAccessContext(() => db.select()
      .from(pax8Orders).where(eq(pax8Orders.id, nullParentFixture.order.id)));
    expect(nullParentOrder?.pax8OrderId).toBe('matched-parent');

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
      authorizedBaselineQuantity: '7.00',
      contractLineId: duplicateFixture.contractLine.id,
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
