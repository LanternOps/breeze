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
  class Pax8OrderRestageRequiredError extends Pax8OrderError {}
  return {
    Pax8OrderError,
    Pax8OrderRestageRequiredError,
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

  it('commits a safe direct ready-to-draft recovery before surfacing a baseline conflict', async () => {
    const directOrder = { ...order, source: 'direct' as const };
    const legacyLine = {
      id: 'line-legacy', orderId: order.id, partnerId: order.partnerId, orgId: order.orgId,
      action: 'change_quantity', submitState: 'pending', targetSubscriptionId: 'sub-1',
      contractLineId: 'contract-line-1', authorizedBaselineQuantity: null,
    };
    mocks.db.select
      .mockReturnValueOnce(selectChain([directOrder], 'limit'))
      .mockReturnValueOnce(selectChain([directOrder], 'limit'))
      .mockReturnValueOnce(selectChain([{
        pax8CompanyId: 'company-1', status: 'Active', metadata: READY_METADATA,
      }], 'for'))
      .mockReturnValueOnce(selectChain([legacyLine], 'orderBy'));
    const claimedAt = new Date('2026-07-14T12:00:00.000Z');
    const claimReturning = vi.fn(async () => [{
      ...directOrder, status: 'submitting', submittedAt: claimedAt,
    }]);
    const resetReturning = vi.fn(async () => {
      mocks.events.push('draft-reset-committed');
      return [{ id: order.id }];
    });
    const claimSet = vi.fn(() => ({ where: vi.fn(() => ({ returning: claimReturning })) }));
    const resetSet = vi.fn(() => ({ where: vi.fn(() => ({ returning: resetReturning })) }));
    mocks.db.update
      .mockReturnValueOnce({ set: claimSet })
      .mockReturnValueOnce({ set: resetSet });
    const { Pax8OrderRestageRequiredError } = await import('./pax8OrderService');
    mocks.validateLines.mockRejectedValueOnce(new Pax8OrderRestageRequiredError(
      'This legacy quantity change has no authorization baseline; remove and stage it again.',
      409,
    ));

    await expect(pax8OrderSubmitRepository.claimOrder({
      partnerId: order.partnerId,
      orderId: order.id,
      actorUserId: 'actor-1',
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('stage it again') });

    expect(resetSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'draft', submittedBy: null, submittedAt: null,
    }));
    expect(mocks.events).toContain('draft-reset-committed');
  });

  it('never demotes a quote order for a restage-required conflict', async () => {
    const quoteLine = {
      id: 'line-quote', orderId: order.id, partnerId: order.partnerId, orgId: order.orgId,
      action: 'change_quantity', submitState: 'pending', targetSubscriptionId: 'sub-1',
      contractLineId: 'contract-line-1', authorizedBaselineQuantity: null,
    };
    mocks.db.select
      .mockReturnValueOnce(selectChain([order], 'limit'))
      .mockReturnValueOnce(selectChain([order], 'limit'))
      .mockReturnValueOnce(selectChain([{
        pax8CompanyId: 'company-1', status: 'Active', metadata: READY_METADATA,
      }], 'for'))
      .mockReturnValueOnce(selectChain([quoteLine], 'orderBy'));
    const claimReturning = vi.fn(async () => [{
      ...order, status: 'submitting', submittedAt: new Date('2026-07-14T12:00:00.000Z'),
    }]);
    mocks.db.update.mockReturnValueOnce({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: claimReturning })) })),
    });
    const { Pax8OrderRestageRequiredError } = await import('./pax8OrderService');
    mocks.validateLines.mockRejectedValueOnce(new Pax8OrderRestageRequiredError(
      'Quote conflict must remain non-actionable.',
      409,
    ));

    await expect(pax8OrderSubmitRepository.claimOrder({
      partnerId: order.partnerId,
      orderId: order.id,
      actorUserId: 'actor-1',
    })).rejects.toMatchObject({ status: 409 });

    expect(mocks.db.update).toHaveBeenCalledTimes(1);
  });
});
