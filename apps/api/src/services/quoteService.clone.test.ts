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
// For retarget tests: may clone INTO org-2 (source stays org-1).
const retargetActor = { userId: 'user-1', partnerId: 'partner-1', accessibleOrgIds: ['org-1', 'org-2'] };

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
    coverPage: { enabled: true, title: 'Cover', coverImageId: null, preparedForName: 'Jane', showPreparedBy: true },
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
      // getQuote() also looks up a staged Pax8 order for this quote (#2501); empty
      // here means "no staged order", which short-circuits the pax8OrderLineSummary
      // query below it so no extra select is consumed from this queue.
      [],
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
      // Cover page carries over verbatim — it's not org/site-specific.
      coverPage: { enabled: true, title: 'Cover', coverImageId: null, preparedForName: 'Jane', showPreparedBy: true },
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

  it('retargets a clone to another company: new org on all rows, site/bill-to reset, tax re-resolved', async () => {
    state.selectResults.push(
      [sourceQuote()],
      [{ id: 'block-lines', quoteId: 'quote-1', orgId: 'org-1', blockType: 'line_items', content: { label: 'Services' }, sortOrder: 0, createdAt: new Date() }],
      [{ id: 'line-1', quoteId: 'quote-1', blockId: 'block-lines', orgId: 'org-1', sourceType: 'manual', catalogItemId: null, parentLineId: null, name: 'Server', description: null, quantity: '1.00', unitPrice: '100.00', taxable: true, customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null, billingFrequency: null, unitCost: null, depositEligible: true, itemType: 'hardware', sku: null, partNumber: null, imageId: 'image-1', sortOrder: 0, createdAt: new Date() }],
      [], // no staged Pax8 order
      [{ id: 'image-1', quoteId: 'quote-1', orgId: 'org-1', imageData: Buffer.from('image'), mime: 'image/png', byteSize: 5, sha256: 'hash', createdAt: new Date() }],
      [{ id: 'org-2' }], // target org same-partner membership check
      // resolveQuoteTaxRate for the NEW org: 8% org rate, no partner default
      [{ taxExempt: false, taxRate: '0.08000' }],
      [{ defaultTaxRate: null }],
    );

    const cloned = await cloneQuote('quote-1', retargetActor, { orgId: 'org-2', title: 'Beta rollout' });

    expect(state.transactionCalls).toBe(1);
    const [quoteInsert, imageInsert, blockInsert, lineInsert] = state.insertedValues as [
      Record<string, unknown>, Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>,
    ];
    expect(quoteInsert).toMatchObject({
      id: cloned.id,
      orgId: 'org-2',
      // The site and bill-to override belonged to the OLD customer.
      siteId: null,
      billToName: null,
      title: 'Beta rollout',
      status: 'draft',
      // Re-resolved for the new org, not the source's 5%.
      taxRate: '0.08000',
    });
    // Denormalized org_id on EVERY child row follows the new company — a stray
    // source.orgId on images would RLS-hide them from the new org's readers.
    expect(imageInsert.every((i) => i.orgId === 'org-2')).toBe(true);
    expect(blockInsert.every((b) => b.orgId === 'org-2')).toBe(true);
    expect(lineInsert.every((l) => l.orgId === 'org-2')).toBe(true);
  });

  it('rejects a retarget by a site-restricted actor (the clone would land site-less)', async () => {
    // The actor CAN see the source quote (site-1 is allowlisted) but retargeting
    // clears the site — mirroring updateQuote, that must be denied.
    state.selectResults.push([sourceQuote()], [], [], [], []);
    const siteRestricted = { ...retargetActor, allowedSiteIds: ['site-1'] };

    await expect(cloneQuote('quote-1', siteRestricted, { orgId: 'org-2' })).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
    expect(state.transactionCalls).toBe(0);
    expect(state.insertedValues).toEqual([]);
  });

  it('rejects retargeting to an org outside the actor scope', async () => {
    state.selectResults.push([sourceQuote()], [], [], [], []);

    await expect(cloneQuote('quote-1', actor, { orgId: 'org-2' })).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
    expect(state.transactionCalls).toBe(0);
    expect(state.insertedValues).toEqual([]);
  });

  it('rejects retargeting to an org of another partner (membership lookup misses)', async () => {
    state.selectResults.push(
      [sourceQuote()], [], [], [], [],
      [], // membership check finds no org-2 row under partner-1
    );

    await expect(cloneQuote('quote-1', retargetActor, { orgId: 'org-2' })).rejects.toMatchObject({ code: 'ORG_NOT_FOUND', status: 404 });
    expect(state.transactionCalls).toBe(0);
    expect(state.insertedValues).toEqual([]);
  });

  it('rejects a cross-organization clone before creating anything', async () => {
    state.selectResults.push([{ ...sourceQuote(), orgId: 'org-2' }]);

    await expect(cloneQuote('quote-1', actor)).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
    expect(state.transactionCalls).toBe(0);
    expect(state.insertedValues).toEqual([]);
  });

  it('carries a contract block\'s content verbatim (template/version references, no remapping)', async () => {
    const contractContent = { templateId: 'tpl-1', templateVersionId: 'ver-1', variableValues: { 'client.name': 'Acme' }, label: 'MSA' };
    state.selectResults.push(
      [sourceQuote()],
      [{ id: 'block-contract', quoteId: 'quote-1', orgId: 'org-1', blockType: 'contract', content: contractContent, sortOrder: 0, createdAt: new Date() }],
      [], // no lines
      [], // no staged Pax8 order
      [], // no images
    );

    const cloned = await cloneQuote('quote-1', actor);

    // No images and no lines here, so insertedValues is just [quoteInsert, blockInsert].
    const [, blockInsert] = state.insertedValues as [
      Record<string, unknown>, Array<Record<string, unknown>>,
    ];
    const clonedContractBlock = blockInsert.find((b) => b.blockType === 'contract')!;
    // A fresh block id, but the referenced template/version and variable fill-ins
    // are untouched — contract templates aren't per-quote owned data to remap.
    expect(clonedContractBlock.id).not.toBe('block-contract');
    expect(clonedContractBlock.quoteId).toBe(cloned.id);
    expect(clonedContractBlock.content).toEqual(contractContent);
  });

  it('rejects a cross-org clone that carries an org-owned contract block (422, nothing created)', async () => {
    const contractContent = { templateId: 'tpl-1', templateVersionId: 'ver-1', variableValues: {}, label: 'MSA' };
    state.selectResults.push(
      [sourceQuote()],
      [{ id: 'block-contract', quoteId: 'quote-1', orgId: 'org-1', blockType: 'contract', content: contractContent, sortOrder: 0, createdAt: new Date() }],
      [], // no lines
      [], // no staged Pax8 order
      [], // no images
      [{ id: 'org-2' }], // target org same-partner membership check
      // assertContractBlockValid: version published + matching template
      [{ templateId: 'tpl-1', status: 'published' }],
      // template is OWNED BY THE SOURCE ORG (org-1) — invalid for target org-2
      [{ status: 'active', orgId: 'org-1', partnerId: 'partner-1' }],
    );

    await expect(cloneQuote('quote-1', retargetActor, { orgId: 'org-2' }))
      .rejects.toMatchObject({ code: 'INVALID_CONTRACT_TEMPLATE', status: 422 });
    expect(state.transactionCalls).toBe(0);
    expect(state.insertedValues).toEqual([]);
  });

  it('allows a cross-org clone carrying a PARTNER-WIDE contract block (org_id NULL passes)', async () => {
    const contractContent = { templateId: 'tpl-1', templateVersionId: 'ver-1', variableValues: {}, label: 'MSA' };
    state.selectResults.push(
      [sourceQuote()],
      [{ id: 'block-contract', quoteId: 'quote-1', orgId: 'org-1', blockType: 'contract', content: contractContent, sortOrder: 0, createdAt: new Date() }],
      [], // no lines
      [], // no staged Pax8 order
      [], // no images
      [{ id: 'org-2' }], // target org same-partner membership check
      [{ templateId: 'tpl-1', status: 'published' }], // version published
      [{ status: 'active', orgId: null, partnerId: 'partner-1' }], // PARTNER-WIDE template — visible to every org of the partner
      // resolveQuoteTaxRate for the new org
      [{ taxExempt: false, taxRate: '0.08000' }],
      [{ defaultTaxRate: null }],
    );

    const cloned = await cloneQuote('quote-1', retargetActor, { orgId: 'org-2' });

    expect(state.transactionCalls).toBe(1);
    const [, blockInsert] = state.insertedValues as [Record<string, unknown>, Array<Record<string, unknown>>];
    const clonedContractBlock = blockInsert.find((b) => b.blockType === 'contract')!;
    expect(clonedContractBlock.orgId).toBe('org-2');
    expect(clonedContractBlock.content).toEqual(contractContent);
    expect(cloned.orgId).toBe('org-2');
  });

  it('remaps coverPage.coverImageId onto the freshly-cloned image id (the old id no longer exists under the new quote)', async () => {
    state.selectResults.push(
      [{ ...sourceQuote(), coverPage: { enabled: true, title: 'Cover', coverImageId: 'image-1', preparedForName: 'Jane', showPreparedBy: true } }],
      [], // no blocks
      [], // no lines
      [], // no staged Pax8 order
      [{ id: 'image-1', quoteId: 'quote-1', orgId: 'org-1', imageData: Buffer.from('image'), mime: 'image/png', byteSize: 5, sha256: 'hash', createdAt: new Date() }],
    );

    const cloned = await cloneQuote('quote-1', actor);

    const [quoteInsert, imageInsert] = state.insertedValues as [
      Record<string, unknown>, Array<Record<string, unknown>>,
    ];
    const clonedImageId = imageInsert[0]!.id as string;
    expect(clonedImageId).not.toBe('image-1');
    expect(quoteInsert.coverPage).toMatchObject({ coverImageId: clonedImageId, title: 'Cover' });
    expect((quoteInsert.coverPage as { coverImageId: string }).coverImageId).not.toBe('image-1');
  });

  it('rejects a clone outside the actor site scope', async () => {
    state.selectResults.push([sourceQuote()]);
    const siteRestrictedActor = { ...actor, allowedSiteIds: ['site-2'] };

    await expect(cloneQuote('quote-1', siteRestrictedActor)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
    expect(state.transactionCalls).toBe(0);
    expect(state.insertedValues).toEqual([]);
  });
});
