import { describe, it, expect } from 'vitest';
import {
  createQuoteSchema, cloneQuoteSchema, quoteLineInputSchema, quoteBlockInputSchema, listQuotesQuerySchema,
  acceptQuoteSchema, declineQuoteSchema,
  updateQuoteSchema, reorderBlocksSchema, reorderLinesSchema,
  updateQuoteLineSchema, catalogQuoteLineSchema, moveQuoteLineSchema,
  quoteBlockTypeSchema, coverPageSchema,
} from './quotes';

describe('quote validators', () => {
  it('accepts a minimal create payload', () => {
    const q = createQuoteSchema.parse({ orgId: '11111111-1111-1111-1111-111111111111' });
    expect(q.currencyCode).toBe('USD');
  });

  it('parses a recurring catalog line with term', () => {
    const line = quoteLineInputSchema.parse({
      sourceType: 'catalog', catalogItemId: '22222222-2222-2222-2222-222222222222',
      description: 'M365', quantity: 10, unitPrice: 22, taxable: true,
      recurrence: 'monthly', termMonths: 12,
    });
    expect(line.recurrence).toBe('monthly');
  });

  it('accepts a line with only a name (no description)', () => {
    const line = quoteLineInputSchema.parse({
      sourceType: 'manual', name: 'Onsite setup', quantity: 1, unitPrice: 250, taxable: false,
    });
    expect(line.name).toBe('Onsite setup');
    expect(line.description ?? null).toBeNull();
  });

  it('line update accepts an imageId guid, an explicit null, and rejects a non-guid', () => {
    expect(updateQuoteLineSchema.parse({ imageId: '33333333-3333-3333-3333-333333333333' }).imageId)
      .toBe('33333333-3333-3333-3333-333333333333');
    expect(updateQuoteLineSchema.parse({ imageId: null }).imageId).toBeNull();
    expect(updateQuoteLineSchema.safeParse({ imageId: 'not-a-guid' }).success).toBe(false);
  });

  it('clone options accept orgId/title, tolerate an empty body, and reject unknown keys', () => {
    expect(cloneQuoteSchema.parse({})).toEqual({});
    expect(cloneQuoteSchema.parse({ orgId: '11111111-1111-1111-1111-111111111111', title: 'Clone of Q-1' }))
      .toEqual({ orgId: '11111111-1111-1111-1111-111111111111', title: 'Clone of Q-1' });
    expect(cloneQuoteSchema.safeParse({ orgId: 'not-a-guid' }).success).toBe(false);
    expect(cloneQuoteSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
    // strict: a mis-keyed field is a 400, not a silent same-org clone
    expect(cloneQuoteSchema.safeParse({ orgID: '11111111-1111-1111-1111-111111111111' }).success).toBe(false);
  });

  it('update accepts an orgId reassignment guid and rejects a non-guid', () => {
    expect(updateQuoteSchema.parse({ orgId: '22222222-2222-2222-2222-222222222222' }).orgId)
      .toBe('22222222-2222-2222-2222-222222222222');
    expect(updateQuoteSchema.safeParse({ orgId: 'not-a-guid' }).success).toBe(false);
    expect(updateQuoteSchema.safeParse({ orgId: null }).success).toBe(false); // a quote always has an org
  });

  it('update strips unknown keys (non-strict) — a mis-keyed orgID is a no-op, unlike the strict clone body', () => {
    // Documented asymmetry: updateQuoteSchema predates orgId and stays
    // non-strict for existing callers, so { orgID } parses to an empty patch
    // (200, nothing reassigned) rather than a 400. cloneQuoteSchema is strict
    // because its only purpose is retarget/rename.
    const parsed = updateQuoteSchema.parse({ orgID: '22222222-2222-2222-2222-222222222222' });
    expect(parsed).toEqual({});
    expect('orgId' in parsed).toBe(false);
  });

  it('create/update accept a bounded title and reject an oversized one', () => {
    expect(createQuoteSchema.parse({ orgId: '11111111-1111-1111-1111-111111111111', title: 'Office refresh' }).title)
      .toBe('Office refresh');
    expect(updateQuoteSchema.parse({ title: null }).title).toBeNull();
    expect(createQuoteSchema.safeParse({ orgId: '11111111-1111-1111-1111-111111111111', title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('rejects a line with neither a name nor a description', () => {
    expect(quoteLineInputSchema.safeParse({
      sourceType: 'manual', quantity: 1, unitPrice: 10, taxable: false,
    }).success).toBe(false);
    // blank/whitespace-only also fails the refine
    expect(quoteLineInputSchema.safeParse({
      sourceType: 'manual', name: '   ', description: '', quantity: 1, unitPrice: 10, taxable: false,
    }).success).toBe(false);
  });

  it('rejects a heading block with no text', () => {
    expect(() => quoteBlockInputSchema.parse({ blockType: 'heading', content: {} })).toThrow();
  });

  it('defaults list limit to 50', () => {
    expect(listQuotesQuerySchema.parse({}).limit).toBe(50);
  });
});

describe('acceptQuoteSchema', () => {
  it('requires a non-empty signer name', () => {
    expect(acceptQuoteSchema.safeParse({ signerName: '' }).success).toBe(false);
    expect(acceptQuoteSchema.safeParse({ signerName: 'Jane Buyer' }).success).toBe(true);
  });
  it('accepts an optional email and rejects a malformed one', () => {
    expect(acceptQuoteSchema.safeParse({ signerName: 'Jane', signerEmail: 'jane@x.com' }).success).toBe(true);
    expect(acceptQuoteSchema.safeParse({ signerName: 'Jane', signerEmail: 'not-an-email' }).success).toBe(false);
  });
});

describe('declineQuoteSchema', () => {
  it('allows an optional bounded reason', () => {
    expect(declineQuoteSchema.safeParse({}).success).toBe(true);
    expect(declineQuoteSchema.safeParse({ reason: 'Too expensive' }).success).toBe(true);
    expect(declineQuoteSchema.safeParse({ reason: 'x'.repeat(5001) }).success).toBe(false);
  });
});


describe('reorder schemas', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  it('accepts a non-empty list of unique guids', () => {
    expect(reorderBlocksSchema.safeParse({ blockIds: [A, B] }).success).toBe(true);
    expect(reorderLinesSchema.safeParse({ lineIds: [A, B] }).success).toBe(true);
  });
  it('rejects an empty list', () => {
    expect(reorderBlocksSchema.safeParse({ blockIds: [] }).success).toBe(false);
  });
  it('rejects duplicate ids (would corrupt sort_order)', () => {
    // [A, A] for blocks [A, B] would otherwise pass a length+membership check,
    // renumber A twice, and orphan B's sort_order.
    expect(reorderBlocksSchema.safeParse({ blockIds: [A, A] }).success).toBe(false);
    expect(reorderLinesSchema.safeParse({ lineIds: [A, A] }).success).toBe(false);
  });
  it('rejects non-guid ids', () => {
    expect(reorderBlocksSchema.safeParse({ blockIds: ['not-a-guid'] }).success).toBe(false);
  });
});

describe('quote T&C field', () => {
  it('create accepts termsAndConditions', () => {
    const p = createQuoteSchema.parse({ orgId: '00000000-0000-0000-0000-000000000000', termsAndConditions: 'Valid 30 days' });
    expect(p.termsAndConditions).toBe('Valid 30 days');
  });
  it('update accepts termsAndConditions (nullable to clear)', () => {
    expect(updateQuoteSchema.parse({ termsAndConditions: null }).termsAndConditions).toBeNull();
  });
});

describe('quote line cost/sku/partNumber', () => {
  it('manual line accepts cost/sku/partNumber', () => {
    const r = quoteLineInputSchema.safeParse({
      sourceType: 'manual', name: 'Widget', quantity: 1, unitPrice: 10, taxable: false,
      unitCost: 6.5, sku: 'WID-1', partNumber: 'MPN-9',
    });
    expect(r.success).toBe(true);
  });
  it('update line accepts cost/sku/partNumber and rejects negative cost', () => {
    expect(updateQuoteLineSchema.safeParse({ unitCost: 6.5, sku: 'X', partNumber: 'Y' }).success).toBe(true);
    expect(updateQuoteLineSchema.safeParse({ unitCost: -1 }).success).toBe(false);
  });
  it('catalog line accepts an optional partNumber override', () => {
    expect(catalogQuoteLineSchema.safeParse({ catalogItemId: '00000000-0000-0000-0000-000000000001', quantity: 1, partNumber: 'MPN-1' }).success).toBe(true);
  });
});

describe('moveQuoteLineSchema', () => {
  const BLOCK_ID = '33333333-3333-3333-3333-333333333333';

  it('accepts a guid blockId', () => {
    const r = moveQuoteLineSchema.safeParse({ blockId: BLOCK_ID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.blockId).toBe(BLOCK_ID);
  });

  it('rejects a non-guid blockId', () => {
    expect(moveQuoteLineSchema.safeParse({ blockId: 'not-a-guid' }).success).toBe(false);
  });

  it('rejects a missing blockId', () => {
    expect(moveQuoteLineSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a null blockId (moving to "no panel" is not supported)', () => {
    expect(moveQuoteLineSchema.safeParse({ blockId: null }).success).toBe(false);
  });
});

describe('deposit validator fields', () => {
  it('accepts deposit config on quote update', () => {
    expect(updateQuoteSchema.parse({ depositType: 'percent', depositPercent: 30 }))
      .toMatchObject({ depositType: 'percent', depositPercent: 30 });
    expect(updateQuoteSchema.parse({ depositType: 'none', depositPercent: null }))
      .toMatchObject({ depositType: 'none', depositPercent: null });
  });
  it('rejects out-of-range percent', () => {
    expect(updateQuoteSchema.safeParse({ depositPercent: 0 }).success).toBe(false);
    expect(updateQuoteSchema.safeParse({ depositPercent: 100 }).success).toBe(false);
    expect(updateQuoteSchema.safeParse({ depositPercent: 12.345 }).success).toBe(false);
  });
  it('rejects a percent value paired with a non-percent deposit type', () => {
    // The contradiction (percent is meaningless for none/selected_lines) is caught
    // at the boundary rather than silently nulled by the service.
    expect(updateQuoteSchema.safeParse({ depositType: 'none', depositPercent: 30 }).success).toBe(false);
    expect(updateQuoteSchema.safeParse({ depositType: 'selected_lines', depositPercent: 30 }).success).toBe(false);
    // A bare percent patch is still allowed — the service derives the type from the stored quote.
    expect(updateQuoteSchema.safeParse({ depositPercent: 30 }).success).toBe(true);
    // Clearing the percent alongside a non-percent type is fine.
    expect(updateQuoteSchema.safeParse({ depositType: 'selected_lines', depositPercent: null }).success).toBe(true);
  });
  it('accepts depositEligible on line create and update', () => {
    const base = { sourceType: 'manual', name: 'x', quantity: 1, unitPrice: 5, taxable: false };
    expect(quoteLineInputSchema.parse({ ...base, depositEligible: true })).toMatchObject({ depositEligible: true });
    expect(quoteLineInputSchema.parse(base)).toMatchObject({ depositEligible: false }); // default
    expect(updateQuoteLineSchema.parse({ depositEligible: true })).toMatchObject({ depositEligible: true });
  });
});

describe('contract block type', () => {
  const TEMPLATE_ID = '11111111-1111-1111-1111-111111111111';
  const VERSION_ID = '22222222-2222-2222-2222-222222222222';

  it('quoteBlockTypeSchema includes contract', () => {
    expect(quoteBlockTypeSchema.safeParse('contract').success).toBe(true);
    expect(quoteBlockTypeSchema.options).toContain('contract');
  });

  it('round-trips a contract block: templateId/templateVersionId required, variableValues defaults to {}, label optional', () => {
    const parsed = quoteBlockInputSchema.parse({
      blockType: 'contract',
      content: { templateId: TEMPLATE_ID, templateVersionId: VERSION_ID },
    });
    if (parsed.blockType !== 'contract') throw new Error('expected contract block');
    expect(parsed.content).toEqual({
      templateId: TEMPLATE_ID, templateVersionId: VERSION_ID, variableValues: {},
    });

    const withValues = quoteBlockInputSchema.parse({
      blockType: 'contract',
      content: {
        templateId: TEMPLATE_ID, templateVersionId: VERSION_ID,
        variableValues: { 'client.name': 'Acme Co' }, label: 'Master Services Agreement',
      },
    });
    if (withValues.blockType !== 'contract') throw new Error('expected contract block');
    expect(withValues.content.variableValues).toEqual({ 'client.name': 'Acme Co' });
    expect(withValues.content.label).toBe('Master Services Agreement');
  });

  it('rejects a contract block missing templateId/templateVersionId', () => {
    expect(quoteBlockInputSchema.safeParse({
      blockType: 'contract', content: {},
    }).success).toBe(false);
    expect(quoteBlockInputSchema.safeParse({
      blockType: 'contract', content: { templateId: TEMPLATE_ID },
    }).success).toBe(false);
  });

  it('rejects an oversized variable value', () => {
    expect(quoteBlockInputSchema.safeParse({
      blockType: 'contract',
      content: {
        templateId: TEMPLATE_ID, templateVersionId: VERSION_ID,
        variableValues: { note: 'x'.repeat(2001) },
      },
    }).success).toBe(false);
  });
});

describe('coverPageSchema', () => {
  it('accepts a minimal disabled cover page', () => {
    const parsed = coverPageSchema.parse({ enabled: false });
    expect(parsed.enabled).toBe(false);
    expect(parsed.showPreparedBy).toBe(true); // default
  });

  it('accepts a fully populated cover page', () => {
    const parsed = coverPageSchema.parse({
      enabled: true,
      title: 'Proposal for Acme Co',
      coverImageId: '33333333-3333-3333-3333-333333333333',
      preparedForName: 'Jane Buyer',
      showPreparedBy: false,
    });
    expect(parsed.title).toBe('Proposal for Acme Co');
    expect(parsed.showPreparedBy).toBe(false);
  });

  it('rejects a title over 200 chars', () => {
    expect(coverPageSchema.safeParse({ enabled: true, title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('rejects a malformed coverImageId but allows an explicit null', () => {
    expect(coverPageSchema.safeParse({ enabled: true, coverImageId: 'not-a-guid' }).success).toBe(false);
    expect(coverPageSchema.parse({ enabled: true, coverImageId: null }).coverImageId).toBeNull();
  });

  it('is accepted on updateQuoteSchema as nullable/optional', () => {
    expect(updateQuoteSchema.parse({ coverPage: { enabled: false } }).coverPage).toEqual({ enabled: false, showPreparedBy: true });
    expect(updateQuoteSchema.parse({ coverPage: null }).coverPage).toBeNull();
    expect(updateQuoteSchema.parse({}).coverPage).toBeUndefined();
  });
});
