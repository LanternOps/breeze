import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), update: vi.fn() },
  validateLines: vi.fn(),
  events: [] as string[],
}));

vi.mock('../db', () => ({
  db: mocks.db,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_context: unknown, fn: () => unknown) => fn(),
}));

vi.mock('./pax8OrderService', () => {
  class Pax8OrderError extends Error {
    constructor(message: string, public readonly status: number) {
      super(message);
    }
  }
  return {
    Pax8OrderError,
    requireImmediateCancelDate: vi.fn(),
    validateDirectOrderLinesForSubmit: mocks.validateLines,
  };
});

vi.mock('./pax8SyncService', () => ({ createPax8ClientForIntegration: vi.fn() }));

import { pax8OrderSubmitRepository } from './pax8OrderSubmitRepository';

const READY_METADATA = {
  contacts: [{ types: [
    { type: 'Admin', primary: true },
    { type: 'Billing', primary: true },
    { type: 'Technical', primary: true },
  ] }],
};

const order = {
  id: 'order-1', integrationId: 'integration-1', partnerId: 'partner-1', orgId: 'org-1',
  pax8CompanyId: 'company-1', status: 'ready', source: 'quote', sourceQuoteId: null,
  dedupeKey: 'order:order-1', pax8OrderId: null, error: null, createdBy: 'user-1',
  submittedBy: null, submittedAt: null, createdAt: new Date(), updatedAt: new Date(),
  rowVersion: '7',
} as const;

function selectChain(rows: unknown[], terminal: 'limit' | 'for' | 'orderBy', event?: string) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => {
    if (terminal === 'limit' && event) mocks.events.push(event);
    return rows;
  });
  chain.for = vi.fn(async () => {
    if (terminal === 'for' && event) mocks.events.push(event);
    return rows;
  });
  chain.orderBy = vi.fn(async () => {
    if (terminal === 'orderBy' && event) mocks.events.push(event);
    return rows;
  });
  return chain;
}

beforeEach(() => {
  mocks.db.select.mockReset();
  mocks.db.update.mockReset();
  mocks.validateLines.mockReset();
  mocks.events.length = 0;
});

describe('pax8OrderSubmitRepository.claimOrder', () => {
  it('reads and returns the authoritative line only after the parent claim lock', async () => {
    const patchedLine = {
      id: 'line-1', orderId: order.id, partnerId: order.partnerId, orgId: order.orgId,
      action: 'new_subscription', submitState: 'pending', pax8ProductId: 'product-1',
      catalogItemId: 'catalog-1', billingTerm: 'Monthly', commitmentTermId: 'commit-new',
      quantity: '2.00', authorizedBaselineQuantity: null,
      provisioningDetails: [{ key: 'domain', values: ['patched.example'] }],
      targetSubscriptionId: null, cancelDate: null, resultSubscriptionId: null,
      contractLineId: null, sourceQuoteLineId: 'quote-line-1', error: null, sortOrder: 0,
      createdAt: new Date(), updatedAt: new Date(),
    };
    mocks.db.select
      .mockReturnValueOnce(selectChain([order], 'limit', 'org-discovered'))
      .mockReturnValueOnce(selectChain([order], 'limit', 'order-reloaded'))
      .mockReturnValueOnce(selectChain([{
        pax8CompanyId: 'company-1', status: 'Active', metadata: READY_METADATA,
      }], 'for', 'company-locked'))
      .mockReturnValueOnce(selectChain([patchedLine], 'orderBy', 'lines-read'));
    const returning = vi.fn(async () => {
      mocks.events.push('parent-claimed');
      return [{ ...order, status: 'submitting', submittedAt: new Date() }];
    });
    mocks.db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
    });
    mocks.validateLines.mockImplementation(async (_order, lines) => {
      mocks.events.push('lines-validated');
      return lines;
    });

    const bundle = await pax8OrderSubmitRepository.claimOrder({
      partnerId: order.partnerId,
      orderId: order.id,
      actorUserId: 'actor-1',
    });

    expect(mocks.events.indexOf('parent-claimed')).toBeLessThan(mocks.events.indexOf('lines-read'));
    expect(mocks.events.indexOf('lines-read')).toBeLessThan(mocks.events.indexOf('lines-validated'));
    expect(bundle.lines).toEqual([patchedLine]);
  });
});
