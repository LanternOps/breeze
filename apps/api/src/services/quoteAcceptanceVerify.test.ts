import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';

const { results, capturedValues } = vi.hoisted(() => ({
  results: [] as unknown[][],
  capturedValues: [] as unknown[],
}));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  const passthrough = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin'];
  for (const method of passthrough) chain[method] = vi.fn(() => chain);
  chain.values = vi.fn((value: unknown) => {
    capturedValues.push(value);
    return chain;
  });
  chain.execute = vi.fn(() => chain);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

vi.mock('./contractTemplateRender', () => ({
  loadContractBlockRenderData: vi.fn(async () => []),
}));

vi.mock('./contractDocumentService', () => ({
  assertContractRenderDataComplete: vi.fn(),
  buildContractHashParts: vi.fn(() => []),
  createExecutedDocuments: vi.fn(async () => []),
}));

vi.mock('./acceptanceProvider', () => ({
  getAcceptanceProvider: () => ({
    capture: vi.fn(async (input: Record<string, unknown>) => input),
  }),
}));

vi.mock('./contractService', () => ({
  createContractWithLinesDetailed: vi.fn(async () => ({ contract: { id: 'c1' }, lines: [] })),
}));
vi.mock('./quoteToPax8Order', () => ({
  stagePax8OrderFromQuote: vi.fn(async () => ({ orderId: null, lineCount: 0 })),
}));

import { quoteAcceptances } from '../db/schema/quotes';
import { acceptQuote } from './quoteAcceptService';
import { computeQuoteSha256 } from './quoteContentHash';
import { verifyQuoteAcceptanceHash } from './quoteAcceptanceVerify';

const quote = {
  id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent',
  currencyCode: 'USD', subtotal: '100.00', taxTotal: '0.00', total: '100.00',
  oneTimeTotal: '0.00', monthlyRecurringTotal: '100.00', annualRecurringTotal: '0.00',
  acceptedAt: new Date('2026-09-03T12:00:00.000Z'), documentLocale: 'en',
  expiryDate: null, quoteNumber: 'Q-1', taxRate: null, siteId: null,
  billToName: null, billToAddress: null, billToTaxId: null, sellerSnapshot: null,
  termsAndConditions: null, terms: null, depositType: 'none', depositPercent: null,
  depositAmount: null,
};

const descriptorLine = {
  id: 'l1', quoteId: 'q1', orgId: 'org1', description: 'Servers', name: 'Servers',
  quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00', recurrence: 'monthly',
  taxable: false, customerVisible: true, sortOrder: 0, catalogItemId: null, termMonths: null,
  contractLineType: 'per_device_group', deviceRoles: null,
  deviceGroupId: '11111111-1111-4111-8111-111111111111', deviceGroupName: 'VIP',
  siteId: null, siteName: null, includedQuantity: '25.00',
  overageMode: 'bill', overageUnitPrice: '12.00',
};

function queueVerification(hashVersion: number | undefined, storedSha256: string, line: typeof descriptorLine) {
  results.push(
    [{ id: 'a1', quoteId: quote.id, quoteSha256: storedSha256, hashVersion, renderLocale: 'en', signedAt: quote.acceptedAt }],
    [quote],
    [],
    [line],
  );
}

describe('verifyQuoteAcceptanceHash version dispatch (#3205 W05)', () => {
  beforeEach(() => {
    results.length = 0;
    capturedValues.length = 0;
    vi.clearAllMocks();
  });

  it('keeps a pre-W05 v1 acceptance clean before and after its group id is deleted', async () => {
    const stored = computeQuoteSha256(quote as never, [], [descriptorLine] as never, [], 1);
    queueVerification(1, stored, descriptorLine);
    expect(await verifyQuoteAcceptanceHash('a1')).toMatchObject({ matches: true, hashVersion: 1 });

    queueVerification(1, stored, { ...descriptorLine, deviceGroupId: null } as never);
    expect(await verifyQuoteAcceptanceHash('a1')).toMatchObject({ matches: true, hashVersion: 1 });
  });

  it('keeps a v2 descriptor acceptance clean before and after its group id is deleted', async () => {
    const stored = computeQuoteSha256(quote as never, [], [descriptorLine] as never, [], 2);
    queueVerification(2, stored, descriptorLine);
    expect(await verifyQuoteAcceptanceHash('a1')).toMatchObject({ matches: true, hashVersion: 2 });

    queueVerification(2, stored, { ...descriptorLine, deviceGroupId: null } as never);
    expect(await verifyQuoteAcceptanceHash('a1')).toMatchObject({ matches: true, hashVersion: 2 });
  });

  it.each([
    ['device_group_name', { deviceGroupName: 'Edited' }],
    ['included_quantity', { includedQuantity: '30.00' }],
  ])('reports a v2 acceptance as changed when %s is edited', async (_field, patch) => {
    const stored = computeQuoteSha256(quote as never, [], [descriptorLine] as never, [], 2);
    queueVerification(2, stored, { ...descriptorLine, ...patch });
    expect(await verifyQuoteAcceptanceHash('a1')).toMatchObject({ matches: false, hashVersion: 2 });
  });

  it('treats an unstamped acceptance as v1 and the schema default is 1', async () => {
    const stored = computeQuoteSha256(quote as never, [], [descriptorLine] as never, [], 1);
    queueVerification(undefined, stored, descriptorLine);
    expect(await verifyQuoteAcceptanceHash('a1')).toMatchObject({ matches: true, hashVersion: 1 });

    const config = getTableConfig(quoteAcceptances);
    expect(config.columns.find((column) => column.name === 'hash_version')?.default).toBe(1);
  });

  it('rejects an unsupported stored hash version before recomputing', async () => {
    queueVerification(3, 'stored-hash', descriptorLine);
    await expect(verifyQuoteAcceptanceHash('a1')).rejects.toMatchObject({
      status: 500,
      code: 'HASH_VERSION_UNSUPPORTED',
      message: 'Unsupported acceptance hash version 3',
    });
  });
});

describe('acceptQuote hash version write (#3205 W05)', () => {
  beforeEach(() => {
    results.length = 0;
    capturedValues.length = 0;
    vi.clearAllMocks();
  });

  it('writes hashVersion 2 beside the acceptance hash', async () => {
    // A plain recurring line (no descriptor): after Task 9, a group NAME beside a
    // NULL id is the deleted-group orphan state and acceptance refuses it.
    const recurringLine = {
      ...descriptorLine, contractLineType: null, deviceRoles: null, deviceGroupId: null, deviceGroupName: null,
      siteId: null, siteName: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
    };
    results.push(
      [quote], [], [recurringLine], [{ prefix: 'INV', termsDays: 30, settings: {} }],
      [{ id: 'a1' }], [{ id: 'i1' }], [], [], [{ ...quote, status: 'converted' }],
    );

    await acceptQuote({ quoteId: quote.id, signerName: 'Jane', signerEmail: 'jane@example.com' });

    expect(capturedValues[0]).toMatchObject({ hashVersion: 2 });
  });
});
