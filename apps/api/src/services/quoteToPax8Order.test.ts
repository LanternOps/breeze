import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAX8_COMPANY_MAPPING_REQUIRED_ERROR,
  createQuoteToPax8OrderService,
  type QuoteToPax8OrderRepository,
  type StagePax8OrderInput,
} from './quoteToPax8Order';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const QUOTE_ID = '44444444-4444-4444-8444-444444444444';
const INTEGRATION_ID = '55555555-5555-4555-8555-555555555555';

function line(overrides: Partial<StagePax8OrderInput['lines'][number]> = {}) {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    catalogItemId: '77777777-7777-4777-8777-777777777777',
    quantity: '3.00',
    recurrence: 'monthly' as const,
    customerVisible: true,
    ...overrides,
  };
}

const baseInput: StagePax8OrderInput = {
  quoteId: QUOTE_ID,
  orgId: ORG_ID,
  partnerId: PARTNER_ID,
  contractIds: ['88888888-8888-4888-8888-888888888888'],
  contractLineLinks: [{
    quoteLineId: '66666666-6666-4666-8666-666666666666',
    contractLineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }],
  lines: [line()],
  actorUserId: '99999999-9999-4999-8999-999999999999',
};

function makeRepository() {
  const repo: QuoteToPax8OrderRepository = {
    findActiveProductMappings: vi.fn().mockResolvedValue([{
      integrationId: INTEGRATION_ID,
      catalogItemId: baseInput.lines[0]!.catalogItemId!,
      pax8ProductId: 'product-1',
    }]),
    findCompanyMappings: vi.fn().mockResolvedValue([]),
    findCreatedContractLines: vi.fn().mockResolvedValue([{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }]),
    insertOrder: vi.fn().mockResolvedValue(undefined),
    insertOrderLines: vi.fn().mockResolvedValue(undefined),
  };
  return repo;
}

describe('stagePax8OrderFromQuote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null and writes nothing when the quote has no Pax8-backed lines', async () => {
    const repo = makeRepository();
    vi.mocked(repo.findActiveProductMappings).mockResolvedValue([]);
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    await expect(stage(baseInput)).resolves.toEqual({ orderId: null, lineCount: 0 });
    expect(repo.insertOrder).not.toHaveBeenCalled();
    expect(repo.insertOrderLines).not.toHaveBeenCalled();
  });

  it('stages one new_subscription line per backed line with stable order and exact billing terms', async () => {
    const repo = makeRepository();
    const annual = line({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      catalogItemId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      quantity: '12.50',
      recurrence: 'annual',
    });
    const oneTime = line({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      catalogItemId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      quantity: '2.00',
      recurrence: 'one_time',
    });
    vi.mocked(repo.findActiveProductMappings).mockResolvedValue([
      { integrationId: INTEGRATION_ID, catalogItemId: baseInput.lines[0]!.catalogItemId!, pax8ProductId: 'monthly-product' },
      { integrationId: INTEGRATION_ID, catalogItemId: annual.catalogItemId!, pax8ProductId: 'annual-product' },
      { integrationId: INTEGRATION_ID, catalogItemId: oneTime.catalogItemId!, pax8ProductId: 'one-time-product' },
    ]);
    vi.mocked(repo.findCreatedContractLines).mockResolvedValue([
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    ]);
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    await expect(stage({
      ...baseInput,
      lines: [baseInput.lines[0]!, annual, oneTime],
      contractLineLinks: [
        ...baseInput.contractLineLinks,
        { quoteLineId: annual.id, contractLineId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      ],
    }))
      .resolves.toEqual({ orderId: ORDER_ID, lineCount: 3 });

    expect(repo.insertOrder).toHaveBeenCalledWith(expect.objectContaining({
      id: ORDER_ID,
      source: 'quote',
      sourceQuoteId: QUOTE_ID,
      integrationId: INTEGRATION_ID,
      partnerId: PARTNER_ID,
      orgId: ORG_ID,
      dedupeKey: `order:${ORDER_ID}`,
      status: 'awaiting_details',
      createdBy: baseInput.actorUserId,
    }));
    expect(repo.insertOrderLines).toHaveBeenCalledWith([
      expect.objectContaining({ action: 'new_subscription', billingTerm: 'Monthly', quantity: '3.00', sortOrder: 0, provisioningDetails: [] }),
      expect.objectContaining({ action: 'new_subscription', billingTerm: 'Annual', quantity: '12.50', sortOrder: 1, provisioningDetails: [] }),
      expect.objectContaining({ action: 'new_subscription', billingTerm: 'One-Time', quantity: '2.00', sortOrder: 2, provisioningDetails: [] }),
    ]);
  });

  it('stages an unmapped organization with a null company id and the safe actionable error', async () => {
    const repo = makeRepository();
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    await stage(baseInput);

    expect(repo.insertOrder).toHaveBeenCalledWith(expect.objectContaining({
      pax8CompanyId: null,
      error: PAX8_COMPANY_MAPPING_REQUIRED_ERROR,
    }));
  });

  it('captures the exact company id when one unignored mapping exists', async () => {
    const repo = makeRepository();
    vi.mocked(repo.findCompanyMappings).mockResolvedValue([{ pax8CompanyId: 'company-1' }]);
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    await stage(baseInput);

    expect(repo.findCompanyMappings).toHaveBeenCalledWith(PARTNER_ID, ORG_ID, INTEGRATION_ID);
    expect(repo.insertOrder).toHaveBeenCalledWith(expect.objectContaining({ pax8CompanyId: 'company-1', error: null }));
  });

  it('treats ambiguous company mappings as unresolved without blocking acceptance', async () => {
    const repo = makeRepository();
    vi.mocked(repo.findCompanyMappings).mockResolvedValue([
      { pax8CompanyId: 'company-1' },
      { pax8CompanyId: 'company-2' },
    ]);
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    await stage(baseInput);

    expect(repo.insertOrder).toHaveBeenCalledWith(expect.objectContaining({
      pax8CompanyId: null,
      error: PAX8_COMPANY_MAPPING_REQUIRED_ERROR,
    }));
  });

  it('attaches only Phase 4 contract lines, claims duplicates once, and never attaches one-time lines', async () => {
    const repo = makeRepository();
    const duplicate = line({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    const oneTime = line({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', recurrence: 'one_time' });
    vi.mocked(repo.findCreatedContractLines).mockResolvedValue([
      { id: 'contract-line-1' },
      { id: 'contract-line-2' },
    ]);
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    const links = [
      { quoteLineId: baseInput.lines[0]!.id, contractLineId: 'contract-line-1' },
      { quoteLineId: duplicate.id, contractLineId: 'contract-line-2' },
    ];
    await stage({ ...baseInput, lines: [baseInput.lines[0]!, duplicate, oneTime], contractLineLinks: links });

    expect(repo.findCreatedContractLines).toHaveBeenCalledWith(
      PARTNER_ID,
      ORG_ID,
      baseInput.contractIds,
      ['contract-line-1', 'contract-line-2'],
    );
    const inserted = vi.mocked(repo.insertOrderLines).mock.calls[0]![0];
    expect(inserted.map((row) => row.contractLineId)).toEqual(['contract-line-1', 'contract-line-2', null]);
  });

  it('fails closed when a recurring backed line cannot match a Phase 4 contract line', async () => {
    const repo = makeRepository();
    vi.mocked(repo.findCreatedContractLines).mockResolvedValue([]);
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    await expect(stage(baseInput)).rejects.toMatchObject({ status: 409 });
    expect(repo.insertOrder).not.toHaveBeenCalled();
  });

  it('fails closed when one catalog item has multiple active Pax8 product mappings', async () => {
    const repo = makeRepository();
    vi.mocked(repo.findActiveProductMappings).mockResolvedValue([
      { integrationId: INTEGRATION_ID, catalogItemId: baseInput.lines[0]!.catalogItemId!, pax8ProductId: 'product-1' },
      { integrationId: INTEGRATION_ID, catalogItemId: baseInput.lines[0]!.catalogItemId!, pax8ProductId: 'product-2' },
    ]);
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    await expect(stage(baseInput)).rejects.toMatchObject({ status: 409 });
    expect(repo.insertOrder).not.toHaveBeenCalled();
  });

  it('fails closed rather than combining mappings from different active integrations', async () => {
    const repo = makeRepository();
    vi.mocked(repo.findActiveProductMappings).mockResolvedValue([
      { integrationId: INTEGRATION_ID, catalogItemId: baseInput.lines[0]!.catalogItemId!, pax8ProductId: 'product-1' },
      { integrationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', catalogItemId: baseInput.lines[0]!.catalogItemId!, pax8ProductId: 'product-2' },
    ]);
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    await expect(stage(baseInput)).rejects.toMatchObject({ status: 409 });
    expect(repo.insertOrder).not.toHaveBeenCalled();
  });

  it('ignores hidden, catalog-less, and foreign-partner lines returned without a scoped mapping', async () => {
    const repo = makeRepository();
    const hidden = line({ id: 'hidden', customerVisible: false });
    const catalogless = line({ id: 'catalogless', catalogItemId: null });
    vi.mocked(repo.findActiveProductMappings).mockResolvedValue([]);
    const stage = createQuoteToPax8OrderService({ repository: repo, randomUUID: () => ORDER_ID });

    await expect(stage({ ...baseInput, lines: [hidden, catalogless] }))
      .resolves.toEqual({ orderId: null, lineCount: 0 });
    expect(repo.findActiveProductMappings).not.toHaveBeenCalled();
  });
});
