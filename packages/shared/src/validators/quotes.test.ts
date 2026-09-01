import { describe, it, expect } from 'vitest';
import {
  createQuoteSchema, cloneQuoteSchema, quoteLineInputSchema, quoteBlockInputSchema, listQuotesQuerySchema,
  acceptQuoteSchema, declineQuoteSchema,
  updateQuoteSchema, reorderBlocksSchema, reorderLinesSchema,
  updateQuoteLineSchema, catalogQuoteLineSchema, moveQuoteLineSchema,
  quoteBlockTypeSchema, coverPageSchema,
  createQuoteOrderSchema, updateQuoteOrderSchema, updateQuoteOrderLineSchema,
} from './quotes';

describe('quote validators', () => {
  it('accepts a minimal create payload and leaves currencyCode unset', () => {
    // currencyCode is optional now (#3200): omitting it lets createQuote inherit
    // the partner's currency server-side, instead of the schema forcing 'USD'.
    const q = createQuoteSchema.parse({ orgId: '11111111-1111-1111-1111-111111111111' });
    expect(q.currencyCode).toBeUndefined();
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
  it('accepts vendor snapshot fields on manual lines and clamps lengths', () => {
    const ok = quoteLineInputSchema.safeParse({
      sourceType: 'manual', name: 'Switch', quantity: 1, unitPrice: 100, taxable: false,
      procurementSource: 'td_synnex', vendorSku: '7724459', manufacturer: 'HPE Aruba',
    });
    expect(ok.success).toBe(true);
    expect((ok as any).data.procurementSource).toBe('td_synnex');
    const tooLong = quoteLineInputSchema.safeParse({
      sourceType: 'manual', name: 'Switch', quantity: 1, unitPrice: 100, taxable: false,
      procurementSource: 'x'.repeat(41),
    });
    expect(tooLong.success).toBe(false);
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

describe('table block content', () => {
  const valid = { blockType: 'table', content: { columns: [{ label: 'Item' }, { label: 'Better', align: 'center', weight: 2 }], rows: [{ cells: ['<strong>EDR</strong>', 'Included'] }] } };
  it('accepts a valid table', () => { expect(quoteBlockInputSchema.safeParse(valid).success).toBe(true); });
  it('rejects cells.length !== columns.length', () => {
    const bad = structuredClone(valid); bad.content.rows[0].cells.push('extra');
    expect(quoteBlockInputSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects >8 columns, >100 rows, oversized cells, bad weight', () => {
    // A real row with 9 cells matching the 9 columns — cells.length ===
    // columns.length, and rows.min(1) is satisfied — so the only remaining
    // violation is columns.max(8). An empty `rows: []` here would fail
    // rows.min(1) first, passing this assertion even if columns.max(8) were
    // deleted from the schema.
    const cols9 = {
      ...valid,
      content: {
        ...valid.content,
        columns: Array.from({ length: 9 }, () => ({ label: 'c' })),
        rows: [{ cells: Array.from({ length: 9 }, () => 'x') }],
      },
    };
    expect(quoteBlockInputSchema.safeParse(cols9).success).toBe(false);
    // Same discipline for the row cap: 101 rows of 2 cells each (matching
    // `valid`'s 2 columns), so the only violation is rows.max(100).
    const rows101 = { ...valid, content: { ...valid.content, rows: Array.from({ length: 101 }, () => ({ cells: ['a', 'b'] })) } };
    expect(quoteBlockInputSchema.safeParse(rows101).success).toBe(false);
    const bigCell = structuredClone(valid); bigCell.content.rows[0].cells[0] = 'x'.repeat(2001);
    expect(quoteBlockInputSchema.safeParse(bigCell).success).toBe(false);
    for (const weight of [0, -1, 1.5, Infinity, 11]) {
      const w = structuredClone(valid); w.content.columns[0] = { label: 'c', weight };
      expect(quoteBlockInputSchema.safeParse(w).success).toBe(false);
    }
  });
});
describe('callout block content', () => {
  it('accepts valid, rejects bad variant and oversized html', () => {
    expect(quoteBlockInputSchema.safeParse({ blockType: 'callout', content: { variant: 'accent', title: 'Why this matters', html: '<p>Because.</p>' } }).success).toBe(true);
    expect(quoteBlockInputSchema.safeParse({ blockType: 'callout', content: { variant: 'loud', html: '<p>x</p>' } }).success).toBe(false);
    expect(quoteBlockInputSchema.safeParse({ blockType: 'callout', content: { variant: 'info', html: 'x'.repeat(50_001) } }).success).toBe(false);
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

describe('createQuoteOrderSchema', () => {
  const quoteLineId = '11111111-1111-1111-1111-111111111111';
  const clientRequestId = '22222222-2222-2222-2222-222222222222';

  it('accepts a happy-path payload with required fields', () => {
    const parsed = createQuoteOrderSchema.parse({
      clientRequestId,
      lines: [{ quoteLineId, orderedQty: 5.5 }],
    });
    expect(parsed.clientRequestId).toBe(clientRequestId);
    expect(parsed.lines).toHaveLength(1);
  });

  it('rejects an empty lines array', () => {
    expect(createQuoteOrderSchema.safeParse({
      clientRequestId,
      lines: [],
    }).success).toBe(false);
  });

  it('rejects a missing clientRequestId', () => {
    expect(createQuoteOrderSchema.safeParse({
      lines: [{ quoteLineId, orderedQty: 5 }],
    }).success).toBe(false);
  });

  it('accepts optional fields like vendorName, orderRef, notes, trackingNumber, eta, procurementSource', () => {
    const parsed = createQuoteOrderSchema.parse({
      clientRequestId,
      lines: [{ quoteLineId, orderedQty: 10 }],
      vendorName: 'Acme Distributor',
      orderRef: 'PO-12345',
      notes: 'Rush delivery requested',
      trackingNumber: 'TRACK-001',
      eta: '2026-08-15',
      procurementSource: 'td_synnex',
    });
    expect(parsed.vendorName).toBe('Acme Distributor');
    expect(parsed.orderRef).toBe('PO-12345');
    expect(parsed.notes).toBe('Rush delivery requested');
    expect(parsed.trackingNumber).toBe('TRACK-001');
    expect(parsed.eta).toBe('2026-08-15');
    expect(parsed.procurementSource).toBe('td_synnex');
  });
});

describe('updateQuoteOrderSchema', () => {
  it('accepts optional vendorName, orderRef, and notes', () => {
    const parsed = updateQuoteOrderSchema.parse({
      vendorName: 'New Vendor',
      orderRef: 'PO-54321',
      notes: 'Updated notes',
    });
    expect(parsed.vendorName).toBe('New Vendor');
    expect(parsed.orderRef).toBe('PO-54321');
    expect(parsed.notes).toBe('Updated notes');
  });

  it('accepts an empty update payload', () => {
    const parsed = updateQuoteOrderSchema.parse({});
    expect(parsed).toEqual({});
  });
});

describe('updateQuoteOrderLineSchema', () => {
  it('accepts { cancelled: true }', () => {
    const parsed = updateQuoteOrderLineSchema.parse({ cancelled: true });
    expect(parsed.cancelled).toBe(true);
  });

  it('accepts optional receivedQty, trackingNumber, eta, and cancelled', () => {
    const parsed = updateQuoteOrderLineSchema.parse({
      receivedQty: 8.25,
      trackingNumber: 'TRACK-002',
      eta: '2026-08-18',
      cancelled: false,
    });
    expect(parsed.receivedQty).toBe(8.25);
    expect(parsed.trackingNumber).toBe('TRACK-002');
    expect(parsed.eta).toBe('2026-08-18');
    expect(parsed.cancelled).toBe(false);
  });

  it('accepts an empty update payload', () => {
    const parsed = updateQuoteOrderLineSchema.parse({});
    expect(parsed).toEqual({});
  });

  it('accepts { receivedQty: 0 } — a correction back to zero, unlike positiveQty elsewhere', () => {
    const result = updateQuoteOrderLineSchema.safeParse({ receivedQty: 0 });
    expect(result.success).toBe(true);
    expect(result.success && result.data.receivedQty).toBe(0);
  });

  it('rejects a negative receivedQty', () => {
    expect(updateQuoteOrderLineSchema.safeParse({ receivedQty: -1 }).success).toBe(false);
  });
});
