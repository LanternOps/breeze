import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  insertedValues: [] as unknown[],
  transactionCalls: 0,
}));

vi.mock('../db', () => {
  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit', 'orderBy']) {
      chain[method] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(state.selectResults.shift() ?? []).then(resolve);
    return chain;
  };

  const makeInsertChain = () => {
    let value: unknown;
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn((next: unknown) => {
      value = next;
      state.insertedValues.push(next);
      return chain;
    });
    chain.returning = vi.fn(() => Promise.resolve([value]));
    (chain as { then: unknown }).then = (resolve: (result: unknown) => unknown) =>
      Promise.resolve([]).then(resolve);
    return chain;
  };

  const tx = { insert: vi.fn(() => makeInsertChain()) };
  return {
    db: {
      select: vi.fn(() => makeSelectChain()),
      transaction: vi.fn(async (run: (transaction: typeof tx) => unknown) => {
        state.transactionCalls += 1;
        return run(tx);
      }),
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

vi.mock('./quoteNumbers', () => ({
  allocateQuoteCounter: vi.fn().mockResolvedValue(42),
  formatQuoteNumber: vi.fn().mockReturnValue('Q-2026-000042'),
}));

import { cloneQuote } from './quoteService';

const actor = { userId: 'user-1', partnerId: 'partner-1', accessibleOrgIds: ['org-1'] };

function sourceQuote() {
  return {
    id: 'quote-1', partnerId: 'partner-1', orgId: 'org-1', siteId: 'site-1',
    quoteNumber: 'Q-2025-000010', title: 'Managed services', status: 'accepted',
    currencyCode: 'USD', issueDate: '2025-01-01', expiryDate: '2025-02-01',
    acceptedAt: new Date('2025-01-10'), declinedAt: null, convertedAt: new Date('2025-01-10'),
    subtotal: '100.00', taxRate: '0.05000', taxTotal: '5.00', total: '105.00',
    oneTimeTotal: '105.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
    depositType: 'percent', depositPercent: '25.00', depositAmount: '26.25',
    billToName: 'Acme', billToAddress: { city: 'Denver' }, billToTaxId: 'TAX-1',
    introNotes: 'Hello', terms: 'Net 30', sellerSnapshot: { name: 'Old seller' },
    termsAndConditions: 'Terms', declineReason: null, convertedInvoiceId: 'invoice-1',
    pdfDocumentRef: 'quote.pdf', pdfSha256: 'abc', sentAt: new Date('2025-01-02'),
    firstViewedAt: new Date('2025-01-03'), viewedAt: new Date('2025-01-03'),
    createdBy: 'user-old', createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-10'),
  };
}

describe('cloneQuote', () => {
  beforeEach(() => {
    state.selectResults.length = 0;
    state.insertedValues.length = 0;
    state.transactionCalls = 0;
    vi.clearAllMocks();
  });

  it('copies quote content and remaps aggregate IDs into a fresh draft', async () => {
    state.selectResults.push(
      [sourceQuote()],
      [
        { id: 'block-image', quoteId: 'quote-1', orgId: 'org-1', blockType: 'image', content: { imageId: 'image-1', caption: 'Rack' }, sortOrder: 0, createdAt: new Date() },
        { id: 'block-lines', quoteId: 'quote-1', orgId: 'org-1', blockType: 'line_items', content: { label: 'Services' }, sortOrder: 1, createdAt: new Date() },
      ],
      [
        { id: 'line-parent', quoteId: 'quote-1', blockId: 'block-lines', orgId: 'org-1', sourceType: 'manual', catalogItemId: null, parentLineId: null, name: 'Server', description: null, quantity: '1.00', unitPrice: '100.00', taxable: true, customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null, billingFrequency: null, unitCost: '50.00', depositEligible: true, itemType: 'hardware', sku: 'SKU-1', partNumber: 'PN-1', imageId: 'image-1', sortOrder: 0, createdAt: new Date() },
        { id: 'line-child', quoteId: 'quote-1', blockId: 'block-lines', orgId: 'org-1', sourceType: 'manual', catalogItemId: null, parentLineId: 'line-parent', name: 'Setup', description: null, quantity: '1.00', unitPrice: '0.00', taxable: false, customerVisible: true, lineTotal: '0.00', recurrence: 'one_time', termMonths: null, billingFrequency: null, unitCost: null, depositEligible: false, itemType: 'service', sku: null, partNumber: null, imageId: null, sortOrder: 1, createdAt: new Date() },
      ],
      [{ id: 'image-1', quoteId: 'quote-1', orgId: 'org-1', imageData: Buffer.from('image'), mime: 'image/png', byteSize: 5, sha256: 'hash', createdAt: new Date() }],
    );

    const cloned = await cloneQuote('quote-1', actor);

    expect(cloned).toMatchObject({ status: 'draft', quoteNumber: 'Q-2026-000042', title: 'Managed services' });
    expect(cloned.id).not.toBe('quote-1');
    expect(state.transactionCalls).toBe(1);

    const [quoteInsert, imageInsert, blockInsert, lineInsert] = state.insertedValues as [
      Record<string, unknown>, Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>,
    ];
    expect(quoteInsert).toMatchObject({
      id: cloned.id, orgId: 'org-1', siteId: 'site-1', status: 'draft',
      issueDate: null, acceptedAt: null, convertedInvoiceId: null, pdfDocumentRef: null,
      sellerSnapshot: null, createdBy: 'user-1', expiryDate: null,
    });

    const clonedImage = imageInsert[0]!;
    expect(clonedImage.id).not.toBe('image-1');
    expect(clonedImage.quoteId).toBe(cloned.id);

    const clonedImageBlock = blockInsert.find((block) => block.blockType === 'image')!;
    const clonedLinesBlock = blockInsert.find((block) => block.blockType === 'line_items')!;
    expect(clonedImageBlock.content).toMatchObject({ imageId: clonedImage.id, caption: 'Rack' });

    const clonedParent = lineInsert.find((line) => line.name === 'Server')!;
    const clonedChild = lineInsert.find((line) => line.name === 'Setup')!;
    expect(clonedParent).toMatchObject({ quoteId: cloned.id, blockId: clonedLinesBlock.id, imageId: clonedImage.id });
    expect(clonedChild.parentLineId).toBe(clonedParent.id);
  });

  it('rejects a cross-organization clone before creating anything', async () => {
    state.selectResults.push([{ ...sourceQuote(), orgId: 'org-2' }]);

    await expect(cloneQuote('quote-1', actor)).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
    expect(state.transactionCalls).toBe(0);
    expect(state.insertedValues).toEqual([]);
  });

  it('rejects a clone outside the actor site scope', async () => {
    state.selectResults.push([sourceQuote()]);
    const siteRestrictedActor = { ...actor, allowedSiteIds: ['site-2'] };

    await expect(cloneQuote('quote-1', siteRestrictedActor)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
    expect(state.transactionCalls).toBe(0);
    expect(state.insertedValues).toEqual([]);
  });
});
