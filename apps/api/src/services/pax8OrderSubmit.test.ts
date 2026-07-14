import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOutsideDbContextFn } from '../db';
import { Pax8ApiError } from './pax8Client';
import {
  createPax8OrderSubmitService,
  type Pax8OrderSubmitRepository,
  type SubmitBundle,
} from './pax8OrderSubmit';

const newLine = {
  id: 'line-new',
  orderId: 'ord-1',
  partnerId: 'p1',
  orgId: 'o1',
  action: 'new_subscription',
  submitState: 'pending',
  pax8ProductId: 'prod-1',
  billingTerm: 'Monthly',
  commitmentTermId: 'commit-1',
  quantity: '7.00',
  provisioningDetails: [{ key: 'msDomain', values: ['acme'] }],
  targetSubscriptionId: null,
  cancelDate: null,
  contractLineId: 'contract-line-1',
  sortOrder: 0,
} as const;

const changeLine = {
  ...newLine,
  id: 'line-change',
  action: 'change_quantity',
  pax8ProductId: null,
  billingTerm: null,
  commitmentTermId: null,
  quantity: '5.00',
  provisioningDetails: [],
  targetSubscriptionId: 'sub-existing',
  contractLineId: null,
  sortOrder: 1,
} as const;

const duplicateNewLine = {
  ...newLine,
  id: 'line-new-2',
  sortOrder: 1,
} as const;

const cancelLine = {
  ...changeLine,
  id: 'line-cancel',
  action: 'cancel',
  quantity: null,
  cancelDate: '2026-09-01',
  sortOrder: 2,
} as const;

function bundle(lines: readonly unknown[] = [newLine]): SubmitBundle {
  return {
    order: {
      id: 'ord-1',
      integrationId: 'integration-1',
      partnerId: 'p1',
      orgId: 'o1',
      pax8CompanyId: 'company-1',
      status: 'submitting',
      createdAt: new Date('2026-07-14T01:00:00Z'),
      submittedAt: new Date('2026-07-20T01:00:00Z'),
    } as SubmitBundle['order'],
    lines: lines as SubmitBundle['lines'],
  };
}

function resultFor(
  lines: Array<{ lineId: string; submitState: 'succeeded' | 'failed' | 'needs_reconcile'; error: string | null }>,
) {
  const states = lines.map((line) => line.submitState);
  const status = states.every((state) => state === 'succeeded')
    ? 'completed'
    : states.every((state) => state === 'failed') ? 'failed' : 'partially_failed';
  return { orderId: 'ord-1', status, lines } as const;
}

function setup(lines: readonly unknown[] = [newLine]) {
  const client = {
    createOrder: vi.fn(),
    updateSubscriptionQuantity: vi.fn(),
    cancelSubscription: vi.fn(),
    listOrders: vi.fn(),
    listSubscriptions: vi.fn(),
  };
  const claimed = bundle(lines);
  const repository: Pax8OrderSubmitRepository = {
    loadResolvedOrder: vi.fn().mockResolvedValue(claimed),
    claimOrder: vi.fn().mockResolvedValue(claimed),
    createClient: vi.fn().mockResolvedValue(client),
    claimLines: vi.fn().mockResolvedValue(undefined),
    persistPreflightFailure: vi.fn().mockImplementation(async (_bundle, errorBody) =>
      resultFor(claimed.lines.map((line) => ({
        lineId: line.id,
        submitState: 'failed',
        error: errorBody,
      })) as never)),
    persistSubmitResults: vi.fn().mockImplementation(async (_bundle, outcomes) =>
      resultFor(outcomes.map((outcome: any) => ({
        lineId: outcome.lineId,
        submitState: outcome.submitState,
        error: outcome.error,
      })))),
    loadReconcileOrder: vi.fn().mockResolvedValue(claimed),
    resetUnsentOrder: vi.fn().mockResolvedValue({ resolved: 0, stillUnknown: 0 }),
    persistReconcileResults: vi.fn().mockResolvedValue({ resolved: 0, stillUnknown: 0 }),
  };
  const outside = vi.fn((fn: () => unknown): unknown => fn()) as unknown as RunOutsideDbContextFn;
  return {
    client,
    repository,
    outside,
    service: createPax8OrderSubmitService({ repository, runOutsideDbContext: outside }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('preflightOrder', () => {
  it('resolves the mapping before the isMock request and returns the raw 422 body', async () => {
    const { service, repository, client, outside } = setup();
    const raw = '{"details":[{"message":"msDomain is required"}]}';
    client.createOrder.mockRejectedValueOnce(new Pax8ApiError('Pax8 API returned 422', 422, raw));

    await expect(service.preflightOrder({ partnerId: 'p1', orderId: 'ord-1' }))
      .resolves.toEqual({ ok: false, errorBody: raw });

    expect(repository.loadResolvedOrder).toHaveBeenCalledBefore(repository.createClient as any);
    expect(client.createOrder).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), { isMock: true });
    expect(outside).toHaveBeenCalledTimes(1);
  });

  it('skips Pax8 when there are no new subscriptions', async () => {
    const { service, client, repository } = setup([changeLine]);
    await expect(service.preflightOrder({ partnerId: 'p1', orderId: 'ord-1' }))
      .resolves.toEqual({ ok: true });
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(repository.createClient).not.toHaveBeenCalled();
  });
});

describe('submitOrder', () => {
  it('runs isMock before any real write and aborts on raw 422', async () => {
    const { service, client, repository } = setup();
    const raw = '{"details":[{"message":"msDomain is required"}]}';
    client.createOrder.mockRejectedValueOnce(new Pax8ApiError('Pax8 API returned 422', 422, raw));

    const res = await service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(client.createOrder.mock.calls[0]![1]).toEqual({ isMock: true });
    expect(repository.claimLines).not.toHaveBeenCalled();
    expect(repository.persistPreflightFailure).toHaveBeenCalledWith(expect.anything(), raw);
    expect(res.status).toBe('failed');
    expect(res.lines[0]!.error).toContain('msDomain is required');
  });

  it('terminally fails every mixed-action line when isMock rejects before any real write', async () => {
    const { service, client } = setup([newLine, changeLine, cancelLine]);
    client.createOrder.mockRejectedValueOnce(new Pax8ApiError('Pax8 API returned 422', 422, 'invalid provisioning'));

    const res = await service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(res.status).toBe('failed');
    expect(res.lines.every((line) => line.submitState === 'failed')).toBe(true);
    expect(client.updateSubscriptionQuantity).not.toHaveBeenCalled();
    expect(client.cancelSubscription).not.toHaveBeenCalled();
  });

  it('claims every line in a committed DB phase before the one real write', async () => {
    const { service, client, repository } = setup();
    client.createOrder
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockResolvedValueOnce({ pax8OrderId: 'pax-order-1', lineItems: [] });

    await service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(repository.claimOrder).toHaveBeenCalledBefore(repository.claimLines as any);
    expect(client.createOrder).toHaveBeenCalledTimes(2);
    expect((repository.claimLines as any).mock.invocationCallOrder[0])
      .toBeLessThan(client.createOrder.mock.invocationCallOrder[1]!); // before real, after isMock
  });

  it('marks a timeout needs_reconcile and never retries the real write', async () => {
    const { service, client } = setup();
    client.createOrder
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const res = await service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(res.lines[0]!.submitState).toBe('needs_reconcile');
    expect(client.createOrder).toHaveBeenCalledTimes(2);
  });

  it('does not issue HTTP when the atomic order claim rejects an ambiguous prior state', async () => {
    const { service, repository, client } = setup();
    (repository.claimOrder as any).mockRejectedValueOnce(Object.assign(new Error('Reconcile first'), { status: 409 }));

    await expect(service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' }))
      .rejects.toMatchObject({ status: 409 });
    expect(client.createOrder).not.toHaveBeenCalled();
  });

  it('records partially_failed when POST succeeds but a quantity PUT gets a definite 422', async () => {
    const { service, client } = setup([newLine, changeLine]);
    client.createOrder
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockResolvedValueOnce({
        pax8OrderId: 'pax-order-1',
        lineItems: [{ lineItemNumber: 1, productId: 'prod-1', subscriptionId: 'sub-new' }],
      });
    client.updateSubscriptionQuantity.mockRejectedValueOnce(
      new Pax8ApiError('Pax8 API returned 422', 422, '{"message":"seat decrease not allowed"}'),
    );

    const res = await service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(res.status).toBe('partially_failed');
    expect(res.lines.find((line) => line.lineId === 'line-new')!.submitState).toBe('succeeded');
    expect(res.lines.find((line) => line.lineId === 'line-change')!.submitState).toBe('failed');
    expect(client.updateSubscriptionQuantity).toHaveBeenCalledTimes(1);
  });

  it('fails closed before HTTP when the expected line claim is incomplete', async () => {
    const { service, repository, client } = setup();
    client.createOrder.mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] });
    (repository.claimLines as any).mockRejectedValueOnce(Object.assign(new Error('Incomplete claim'), { status: 409 }));

    await expect(service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' }))
      .rejects.toMatchObject({ status: 409 });
    expect(client.createOrder).toHaveBeenCalledTimes(1); // isMock only
  });

  it('globally consumes create response items for duplicate products', async () => {
    const { service, client, repository } = setup([newLine, duplicateNewLine]);
    client.createOrder
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockResolvedValueOnce({ pax8OrderId: 'pax-order-1', lineItems: [
        { lineItemNumber: 1, productId: 'prod-1', subscriptionId: 'sub-1' },
        { lineItemNumber: 2, productId: 'prod-1', subscriptionId: 'sub-2' },
      ] });

    const res = await service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(res.lines.every((line) => line.submitState === 'succeeded')).toBe(true);
    expect(repository.persistSubmitResults).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ lineId: 'line-new', resultSubscriptionId: 'sub-1' }),
        expect.objectContaining({ lineId: 'line-new-2', resultSubscriptionId: 'sub-2' }),
      ]),
      'pax-order-1',
    );
  });

  it.each([
    {
      name: 'partial response',
      lineItems: [{ lineItemNumber: 1, productId: 'prod-1', subscriptionId: 'sub-1' }],
    },
    {
      name: 'mismatched line number and product',
      lineItems: [
        { lineItemNumber: 1, productId: 'other-product', subscriptionId: 'sub-1' },
        { lineItemNumber: 2, productId: 'prod-1', subscriptionId: 'sub-2' },
      ],
    },
  ])('marks every new line unknown after external success with $name', async ({ lineItems }) => {
    const { service, client } = setup([newLine, duplicateNewLine]);
    client.createOrder
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockResolvedValueOnce({ pax8OrderId: 'pax-order-1', lineItems });

    const res = await service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(res.lines.every((line) => line.submitState === 'needs_reconcile')).toBe(true);
  });

  it('keeps new lines unknown when the successful response omits the parent order id', async () => {
    const { service, client } = setup([newLine]);
    client.createOrder
      .mockResolvedValueOnce({ pax8OrderId: null, lineItems: [] })
      .mockResolvedValueOnce({
        pax8OrderId: null,
        lineItems: [{ lineItemNumber: 1, productId: 'prod-1', subscriptionId: 'sub-1' }],
      });

    const res = await service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(res.lines[0]!.submitState).toBe('needs_reconcile');
  });

  it.each([
    ['PUT timeout', changeLine, 'updateSubscriptionQuantity', Object.assign(new Error('timeout'), { name: 'AbortError' })],
    ['DELETE 503', cancelLine, 'cancelSubscription', new Pax8ApiError('Pax8 API returned 503', 503, 'unavailable')],
  ] as const)('does not retry a %s', async (_name, line, method, error) => {
    const { service, client } = setup([line]);
    client[method].mockRejectedValueOnce(error);

    const res = await service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' });

    expect(client[method]).toHaveBeenCalledTimes(1);
    expect(res.lines[0]!.submitState).toBe('needs_reconcile');
  });

  it('rejects duplicate subscription targets before external writes', async () => {
    const secondChange = { ...changeLine, id: 'line-change-2', quantity: '6.00' };
    const { service, repository, client } = setup([changeLine, secondChange]);
    (repository.claimOrder as any).mockRejectedValueOnce(Object.assign(new Error('duplicate target'), { status: 422 }));

    await expect(service.submitOrder({ partnerId: 'p1', orderId: 'ord-1', actorUserId: 'u1' }))
      .rejects.toMatchObject({ status: 422 });
    expect(client.updateSubscriptionQuantity).not.toHaveBeenCalled();
  });
});

describe('reconcileOrder', () => {
  it('recovers a submitting order whose pending lines prove no real write was claimed', async () => {
    const { service, client, repository } = setup([newLine]);

    await expect(service.reconcileOrder({ partnerId: 'p1', orderId: 'ord-1' }))
      .resolves.toEqual({ resolved: 0, stillUnknown: 0 });
    expect(repository.resetUnsentOrder).toHaveBeenCalledWith(expect.anything());
    expect(client.listOrders).not.toHaveBeenCalled();
    expect(client.listSubscriptions).not.toHaveBeenCalled();
  });

  it('reconciles a line left in_flight by a crash instead of leaving it permanently stuck', async () => {
    const crashedLine = { ...changeLine, submitState: 'in_flight' };
    const { service, client, repository } = setup([crashedLine]);
    client.listOrders.mockResolvedValueOnce([]);
    client.listSubscriptions.mockResolvedValueOnce([{
      pax8SubscriptionId: 'sub-existing', quantity: '5.00', quantityKnown: true,
    }]);
    (repository.persistReconcileResults as any).mockResolvedValueOnce({ resolved: 1, stillUnknown: 0 });

    await expect(service.reconcileOrder({ partnerId: 'p1', orderId: 'ord-1' }))
      .resolves.toEqual({ resolved: 1, stillUnknown: 0 });
    expect(repository.persistReconcileResults).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ lineId: 'line-change', submitState: 'succeeded' })],
      null,
    );
  });

  it('uses reads only and leaves ambiguous same-day product matches unknown', async () => {
    const unknownLine = { ...newLine, submitState: 'needs_reconcile' };
    const { service, client, repository } = setup([unknownLine]);
    client.listOrders.mockResolvedValueOnce([
      { pax8OrderId: 'a', pax8CompanyId: 'company-1', createdDate: '2026-07-20', lineItems: [{ lineItemNumber: 1, productId: 'prod-1', quantity: '7.00', quantityKnown: true, subscriptionId: 's1' }] },
      { pax8OrderId: 'b', pax8CompanyId: 'company-1', createdDate: '2026-07-20', lineItems: [{ lineItemNumber: 1, productId: 'prod-1', quantity: '7.00', quantityKnown: true, subscriptionId: 's2' }] },
    ]);
    client.listSubscriptions.mockResolvedValueOnce([]);
    (repository.persistReconcileResults as any).mockResolvedValueOnce({ resolved: 0, stillUnknown: 1 });

    await expect(service.reconcileOrder({ partnerId: 'p1', orderId: 'ord-1' }))
      .resolves.toEqual({ resolved: 0, stillUnknown: 1 });

    expect(client.listOrders).toHaveBeenCalledWith({ companyId: 'company-1' });
    expect(client.listSubscriptions).toHaveBeenCalledWith({ companyId: 'company-1' });
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.updateSubscriptionQuantity).not.toHaveBeenCalled();
    expect(client.cancelSubscription).not.toHaveBeenCalled();
    expect(repository.persistReconcileResults).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ lineId: 'line-new', submitState: 'needs_reconcile' })],
      null,
    );
  });

  it('matches the whole new-subscription batch to one order on submittedAt date', async () => {
    const lines = [
      { ...newLine, submitState: 'needs_reconcile' },
      { ...duplicateNewLine, submitState: 'needs_reconcile' },
    ];
    const { service, client, repository } = setup(lines);
    client.listOrders.mockResolvedValueOnce([{
      pax8OrderId: 'matched-parent',
      pax8CompanyId: 'company-1',
      createdDate: '2026-07-20',
      lineItems: [
        { lineItemNumber: 1, productId: 'prod-1', quantity: '7.00', quantityKnown: true, subscriptionId: 's1' },
        { lineItemNumber: 2, productId: 'prod-1', quantity: '7.00', quantityKnown: true, subscriptionId: 's2' },
      ],
    }]);
    client.listSubscriptions.mockResolvedValueOnce([]);
    (repository.persistReconcileResults as any).mockResolvedValueOnce({ resolved: 2, stillUnknown: 0 });

    await service.reconcileOrder({ partnerId: 'p1', orderId: 'ord-1' });

    expect(repository.persistReconcileResults).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ lineId: 'line-new', submitState: 'succeeded', resultSubscriptionId: 's1' }),
        expect.objectContaining({ lineId: 'line-new-2', submitState: 'succeeded', resultSubscriptionId: 's2' }),
      ]),
      'matched-parent',
    );
  });

  it('never assembles one batch match from line items belonging to different parent orders', async () => {
    const lines = [
      { ...newLine, submitState: 'needs_reconcile' },
      { ...duplicateNewLine, submitState: 'needs_reconcile' },
    ];
    const { service, client, repository } = setup(lines);
    client.listOrders.mockResolvedValueOnce([
      { pax8OrderId: 'parent-a', pax8CompanyId: 'company-1', createdDate: '2026-07-20', lineItems: [{ lineItemNumber: 1, productId: 'prod-1', quantity: '7.00', quantityKnown: true, subscriptionId: 's1' }] },
      { pax8OrderId: 'parent-b', pax8CompanyId: 'company-1', createdDate: '2026-07-20', lineItems: [{ lineItemNumber: 2, productId: 'prod-1', quantity: '7.00', quantityKnown: true, subscriptionId: 's2' }] },
    ]);
    client.listSubscriptions.mockResolvedValueOnce([]);

    await service.reconcileOrder({ partnerId: 'p1', orderId: 'ord-1' });

    expect(repository.persistReconcileResults).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ lineId: 'line-new', submitState: 'needs_reconcile' }),
        expect.objectContaining({ lineId: 'line-new-2', submitState: 'needs_reconcile' }),
      ]),
      null,
    );
  });

  it('uses the captured company snapshot even after the org mapping changes', async () => {
    const unknownLine = { ...changeLine, submitState: 'needs_reconcile' };
    const { service, client } = setup([unknownLine]);
    client.listOrders.mockResolvedValueOnce([]);
    client.listSubscriptions.mockResolvedValueOnce([]);

    await service.reconcileOrder({ partnerId: 'p1', orderId: 'ord-1' });

    expect(client.listOrders).toHaveBeenCalledWith({ companyId: 'company-1' });
    expect(client.listSubscriptions).toHaveBeenCalledWith({ companyId: 'company-1' });
  });

  it('recognizes a still-present future-dated cancellation only from matching end-date evidence', async () => {
    const unknownLine = { ...cancelLine, submitState: 'needs_reconcile' };
    const { service, client, repository } = setup([unknownLine]);
    client.listOrders.mockResolvedValueOnce([]);
    client.listSubscriptions.mockResolvedValueOnce([{
      pax8SubscriptionId: 'sub-existing', quantity: '0.00', quantityKnown: false,
      status: 'ACTIVE', endDate: '2026-09-01',
    }]);

    await service.reconcileOrder({ partnerId: 'p1', orderId: 'ord-1' });

    expect(repository.persistReconcileResults).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ submitState: 'succeeded' })],
      null,
    );
  });

  it.each([
    ['missing target cancellation', { ...cancelLine, submitState: 'needs_reconcile' }, []],
    ['unknown zero quantity', { ...changeLine, quantity: '0.00', submitState: 'needs_reconcile' }, [{
      pax8SubscriptionId: 'sub-existing', quantity: '0.00', quantityKnown: false,
    }]],
  ] as const)('leaves %s unresolved without conclusive evidence', async (_name, line, subscriptions) => {
    const { service, client, repository } = setup([line]);
    client.listOrders.mockResolvedValueOnce([]);
    client.listSubscriptions.mockResolvedValueOnce(subscriptions);

    await service.reconcileOrder({ partnerId: 'p1', orderId: 'ord-1' });

    expect(repository.persistReconcileResults).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ submitState: 'needs_reconcile' })],
      null,
    );
  });
});
