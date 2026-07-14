import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  createPax8ClientForIntegration: vi.fn(),
  getProductDependencies: vi.fn(),
}));

vi.mock('../db', () => ({
  db: mocks.db,
  runOutsideDbContext: mocks.runOutsideDbContext,
}));

vi.mock('../db/schema', () => new Proxy({
  pax8Orders: {
    id: 'pax8_orders.id',
    integrationId: 'pax8_orders.integration_id',
    partnerId: 'pax8_orders.partner_id',
    orgId: 'pax8_orders.org_id',
    status: 'pax8_orders.status',
  },
  pax8OrderLines: {
    id: 'pax8_order_lines.id',
    orderId: 'pax8_order_lines.order_id',
    partnerId: 'pax8_order_lines.partner_id',
  },
  pax8CompanyMappings: {
    partnerId: 'pax8_company_mappings.partner_id',
    orgId: 'pax8_company_mappings.org_id',
    ignored: 'pax8_company_mappings.ignored',
  },
  pax8SubscriptionSnapshots: {
    integrationId: 'pax8_subscription_snapshots.integration_id',
    partnerId: 'pax8_subscription_snapshots.partner_id',
    pax8SubscriptionId: 'pax8_subscription_snapshots.pax8_subscription_id',
  },
}, {
  get(target, prop) {
    if (prop in target) return target[prop as keyof typeof target];
    return {};
  },
  // Vitest checks named exports with `in` before resolving them.
  has() {
    return true;
  },
}));

vi.mock('./pax8SyncService', () => ({
  createPax8ClientForIntegration: mocks.createPax8ClientForIntegration,
}));

import {
  addOrderLine,
  buildDedupeKey,
  getOrderWithLines,
  getOrCreateDraftOrder,
  removeOrderLine,
} from './pax8OrderService';

const baseOrder = {
  id: 'ord-1',
  integrationId: 'i1',
  partnerId: 'p1',
  orgId: 'o1',
  pax8CompanyId: 'co-1',
  status: 'draft',
};

const baseSnapshot = {
  id: 'snap-1',
  integrationId: 'i1',
  partnerId: 'p1',
  orgId: 'o1',
  pax8SubscriptionId: 'sub-1',
  productId: 'prod-1',
  quantity: '10.00',
};

function queryChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  chain.then = (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function selectRowsOnce(rows: unknown[]) {
  mocks.db.select.mockReturnValueOnce(queryChain(rows));
}

function mockCompanyMappingLookup(mapping: Record<string, unknown> | null) {
  selectRowsOnce(mapping ? [{ orgId: 'o1', ...mapping }] : []);
}

function mockOrder(overrides: Record<string, unknown> = {}) {
  selectRowsOnce([{ ...baseOrder, ...overrides }]);
}

function mockSubscriptionSnapshot(overrides: Record<string, unknown> = {}) {
  selectRowsOnce([{ ...baseSnapshot, ...overrides }]);
}

function mockDependencies(dependencies: Record<string, unknown>) {
  mocks.getProductDependencies.mockResolvedValueOnce(dependencies);
  mocks.createPax8ClientForIntegration.mockResolvedValueOnce({
    integration: { id: 'i1', partnerId: 'p1' },
    client: { getProductDependencies: mocks.getProductDependencies },
  });
}

function insertReturningOnce(rows: unknown[]) {
  const returning = vi.fn(async () => rows);
  const values = vi.fn(() => ({ returning }));
  mocks.db.insert.mockReturnValueOnce({ values });
  return { values, returning };
}

function deleteReturningOnce(rows: unknown[]) {
  const returning = vi.fn(async () => rows);
  const where = vi.fn(() => ({ returning }));
  mocks.db.delete.mockReturnValueOnce({ where });
  return { where, returning };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrCreateDraftOrder', () => {
  it('throws 409 when the org has no Pax8 company mapping', async () => {
    mockCompanyMappingLookup(null);

    await expect(getOrCreateDraftOrder({ partnerId: 'p1', orgId: 'o1', actorUserId: 'u1' }))
      .rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not mapped to a Pax8 company'),
      });
  });

  it('reuses the existing open draft rather than creating a second one', async () => {
    mockCompanyMappingLookup({ pax8CompanyId: 'co-1', integrationId: 'i1' });
    selectRowsOnce([{ ...baseOrder, id: 'ord-existing' }]);

    const order = await getOrCreateDraftOrder({ partnerId: 'p1', orgId: 'o1', actorUserId: 'u1' });

    expect(order.id).toBe('ord-existing');
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it('creates a direct draft with a stable per-order dedupe key', async () => {
    mockCompanyMappingLookup({ pax8CompanyId: 'co-1', integrationId: 'i1' });
    selectRowsOnce([]);
    const insert = insertReturningOnce([{ ...baseOrder, id: 'created-order' }]);

    await getOrCreateDraftOrder({ partnerId: 'p1', orgId: 'o1', actorUserId: 'u1' });

    expect(insert.values).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: 'i1',
      partnerId: 'p1',
      orgId: 'o1',
      pax8CompanyId: 'co-1',
      status: 'draft',
      source: 'direct',
      createdBy: 'u1',
      dedupeKey: expect.stringMatching(/^order:[0-9a-f-]{36}$/),
    }));
  });
});

describe('addOrderLine', () => {
  it('rejects a change_quantity whose commitment forbids a decrease', async () => {
    mockOrder();
    mockSubscriptionSnapshot();
    mockDependencies({
      commitments: [{
        id: 'c1',
        allowForQuantityDecrease: false,
        allowForQuantityIncrease: true,
        allowForEarlyCancellation: false,
      }],
    });

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'change_quantity',
      targetSubscriptionId: 'sub-1',
      quantity: '5.00',
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('decrease'),
    });

    expect(mocks.runOutsideDbContext).toHaveBeenCalledTimes(1);
  });

  it('rejects a change_quantity whose commitment forbids an increase', async () => {
    mockOrder();
    mockSubscriptionSnapshot();
    mockDependencies({
      commitments: [{
        id: 'c1',
        allowForQuantityDecrease: true,
        allowForQuantityIncrease: false,
        allowForEarlyCancellation: false,
      }],
    });

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'change_quantity',
      targetSubscriptionId: 'sub-1',
      quantity: '11.00',
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('increase'),
    });
  });

  it('rejects a line targeting a subscription in a different org', async () => {
    mockOrder();
    mockSubscriptionSnapshot({ orgId: 'OTHER-ORG' });

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'cancel',
      targetSubscriptionId: 'sub-1',
    })).rejects.toMatchObject({ status: 403 });

    expect(mocks.createPax8ClientForIntegration).not.toHaveBeenCalled();
  });

  it('refuses to modify an order that is not draft/awaiting_details', async () => {
    mockOrder({ status: 'submitting' });

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'cancel',
      targetSubscriptionId: 'sub-1',
    })).rejects.toMatchObject({ status: 409 });
  });

  it('returns 404 when the partner-scoped order does not exist', async () => {
    selectRowsOnce([]);

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'cancel',
      targetSubscriptionId: 'sub-1',
    })).rejects.toMatchObject({ status: 404 });
  });

  it('returns 404 when the target subscription does not exist', async () => {
    mockOrder();
    selectRowsOnce([]);

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'cancel',
      targetSubscriptionId: 'sub-1',
    })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects an early cancellation forbidden by the commitment', async () => {
    mockOrder();
    mockSubscriptionSnapshot();
    mockDependencies({
      commitments: [{
        id: 'c1',
        allowForQuantityDecrease: true,
        allowForQuantityIncrease: true,
        allowForEarlyCancellation: false,
      }],
    });

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'cancel',
      targetSubscriptionId: 'sub-1',
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('cancellation'),
    });
  });

  it('rejects a new subscription without a product', async () => {
    mockOrder();

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'new_subscription',
      billingTerm: 'Monthly',
      quantity: '1.00',
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('product'),
    });
  });

  it('rejects a billing term that does not exactly match the shared vocabulary', async () => {
    mockOrder();

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'new_subscription',
      pax8ProductId: 'prod-1',
      billingTerm: 'monthly' as never,
      quantity: '1.00',
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('billing term'),
    });
  });

  it('rejects a new subscription with a non-positive quantity', async () => {
    mockOrder();

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'new_subscription',
      pax8ProductId: 'prod-1',
      billingTerm: 'Monthly',
      quantity: '0',
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('greater than zero'),
    });
  });

  it('rejects a change_quantity without a target subscription', async () => {
    mockOrder();

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'change_quantity',
      quantity: '5.00',
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('target subscription'),
    });
  });

  it('rejects a cancel action that includes a quantity', async () => {
    mockOrder();

    await expect(addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'cancel',
      targetSubscriptionId: 'sub-1',
      quantity: '1.00',
    })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('must not include a quantity'),
    });
  });

  it('inserts a valid new subscription line with order tenancy fields', async () => {
    mockOrder({ status: 'awaiting_details' });
    const insert = insertReturningOnce([{
      id: 'line-1',
      orderId: 'ord-1',
      partnerId: 'p1',
      orgId: 'o1',
      action: 'new_subscription',
    }]);

    const line = await addOrderLine({
      partnerId: 'p1',
      orderId: 'ord-1',
      action: 'new_subscription',
      pax8ProductId: 'prod-1',
      billingTerm: 'Annual',
      quantity: '2.00',
      provisioningDetails: [{ key: 'domain', values: ['example.com'] }],
    });

    expect(line.id).toBe('line-1');
    expect(insert.values).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'ord-1',
      partnerId: 'p1',
      orgId: 'o1',
      action: 'new_subscription',
      submitState: 'pending',
    }));
  });
});

describe('removeOrderLine', () => {
  it('refuses to remove a line from an immutable order', async () => {
    mockOrder({ status: 'ready' });

    await expect(removeOrderLine({ partnerId: 'p1', orderId: 'ord-1', lineId: 'line-1' }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('deletes only the partner and order-scoped line', async () => {
    mockOrder();
    deleteReturningOnce([{ id: 'line-1' }]);

    await expect(removeOrderLine({ partnerId: 'p1', orderId: 'ord-1', lineId: 'line-1' }))
      .resolves.toEqual({ removed: true });
  });
});

describe('getOrderWithLines', () => {
  it('returns a partner-scoped order and its partner-scoped lines', async () => {
    mockOrder();
    selectRowsOnce([{ id: 'line-1', orderId: 'ord-1', partnerId: 'p1' }]);

    await expect(getOrderWithLines({ partnerId: 'p1', orderId: 'ord-1' }))
      .resolves.toMatchObject({
        order: { id: 'ord-1' },
        lines: [{ id: 'line-1' }],
      });
  });

  it('returns 404 when the partner-scoped order does not exist', async () => {
    selectRowsOnce([]);

    await expect(getOrderWithLines({ partnerId: 'p1', orderId: 'ord-1' }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('buildDedupeKey', () => {
  it('is stable for the same order', () => {
    expect(buildDedupeKey('ord-1')).toBe(buildDedupeKey('ord-1'));
    expect(buildDedupeKey('ord-1')).toBe('order:ord-1');
  });
});
