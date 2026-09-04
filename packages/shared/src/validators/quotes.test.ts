import { describe, it, expect } from 'vitest';
import {
  createQuoteSchema, cloneQuoteSchema, quoteLineInputSchema, quoteBlockInputSchema, listQuotesQuerySchema,
  acceptQuoteSchema, declineQuoteSchema,
  updateQuoteSchema, reorderBlocksSchema, reorderLinesSchema,
  updateQuoteLineSchema, catalogQuoteLineSchema, moveQuoteLineSchema,
  quoteBlockTypeSchema, coverPageSchema,
  createQuoteOrderSchema, updateQuoteOrderSchema, updateQuoteOrderLineSchema,
  quoteLineDeviceSetIssues, mergeQuoteLinePatch, quoteLinePatchHasKey, QUOTE_DEVICE_SET_TYPES,
} from './quotes';
import { ALLOWANCE_LINE_TYPES, contractLineInvariantIssues } from './contracts';

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

// ---------------------------------------------------------------------------
// #3205 W05 — the device-set descriptor on a quote line.
//
// quoteLineDeviceSetIssues does NOT restate the contract rules: it PROJECTS onto
// W03's ContractLineShape and calls contractLineInvariantIssues, so roles /
// group / site / allowance can never diverge between a quote line and the
// contract line it becomes — and #4547's future additions arrive here for free.
// ---------------------------------------------------------------------------
describe('quoteLineDeviceSetIssues (#3205 W05)', () => {
  const GROUP = '33333333-3333-4333-8333-333333333333';
  const SITE = '22222222-2222-4222-8222-222222222222';
  const rec = { recurrence: 'monthly' } as const;
  const paths = (l: Parameters<typeof quoteLineDeviceSetIssues>[0], mode: 'create' | 'persisted') =>
    quoteLineDeviceSetIssues(l, { mode }).map((i) => i.path);

  it('accepts each of the four types with its required fields, in both modes', () => {
    for (const mode of ['create', 'persisted'] as const) {
      expect(paths({ ...rec, contractLineType: 'per_device' }, mode)).toEqual([]);
      expect(paths({ ...rec, contractLineType: 'per_device_role', deviceRoles: ['server'] }, mode)).toEqual([]);
      expect(paths({ ...rec, contractLineType: 'per_seat' }, mode)).toEqual([]);
    }
    expect(paths({ ...rec, contractLineType: 'per_device_group', deviceGroupId: GROUP }, 'create')).toEqual([]);
    expect(paths({ ...rec, contractLineType: 'per_device_group', deviceGroupId: GROUP, deviceGroupName: 'VIP' }, 'persisted')).toEqual([]);
  });

  it('accepts a line with no descriptor at all', () => {
    expect(paths({ recurrence: 'one_time' }, 'create')).toEqual([]);
    expect(paths({ recurrence: 'one_time' }, 'persisted')).toEqual([]);
  });

  it('requires contractLineType when any descriptor column is present', () => {
    expect(paths({ ...rec, deviceRoles: ['server'] }, 'create')).toContain('contractLineType');
    expect(paths({ ...rec, siteName: 'Dallas' }, 'create')).toContain('contractLineType');
    expect(paths({ ...rec, includedQuantity: 25, overageMode: 'flag' }, 'create')).toContain('contractLineType');
  });

  it('rejects a type outside the device-set four', () => {
    for (const t of ['flat', 'manual'] as const) {
      expect(paths({ ...rec, contractLineType: t as never }, 'create')).toContain('contractLineType');
    }
  });

  // A one-time charge has no "each period" for a live count to mean anything;
  // a bundle child's quantity belongs to its parent.
  it('rejects a descriptor on a one_time line and on a bundle component', () => {
    expect(paths({ recurrence: 'one_time', contractLineType: 'per_device' }, 'create')).toContain('recurrence');
    expect(paths({ recurrence: 'one_time', contractLineType: 'per_device' }, 'persisted')).toContain('recurrence');
    expect(paths({ ...rec, contractLineType: 'per_device', parentLineId: 'abc' }, 'create')).toContain('parentLineId');
  });

  // The mode asymmetry, inherited from W03 for the same reason: the orphan state
  // is legal on a stored row and illegal on a new one.
  it('requires deviceGroupId in create and allows the orphan in persisted', () => {
    expect(paths({ ...rec, contractLineType: 'per_device_group' }, 'create')).toContain('deviceGroupId');
    expect(paths({ ...rec, contractLineType: 'per_device_group', deviceGroupName: 'VIP' }, 'persisted')).toEqual([]);
    expect(paths({ ...rec, contractLineType: 'per_device_group', deviceGroupId: GROUP }, 'persisted')).toContain('deviceGroupName');
  });

  it('restricts the site columns to per_device / per_device_role and pairs id with stamp', () => {
    expect(paths({ ...rec, contractLineType: 'per_seat', siteId: SITE, siteName: 'Dallas' }, 'create')).toContain('siteId');
    expect(paths({ ...rec, contractLineType: 'per_device', siteId: SITE }, 'create')).toEqual([]);
    expect(paths({ ...rec, contractLineType: 'per_device', siteId: SITE, siteName: 'Dallas' }, 'create')).toEqual([]);
    // deleted-site state: stamp with no id, legal on a stored row
    expect(paths({ ...rec, contractLineType: 'per_device', siteName: 'Dallas' }, 'persisted')).toEqual([]);
  });

  it('two-way, non-empty, duplicate-free deviceRoles (the DB only checks containment)', () => {
    expect(paths({ ...rec, contractLineType: 'per_device_role' }, 'create')).toContain('deviceRoles');
    expect(paths({ ...rec, contractLineType: 'per_device', deviceRoles: ['server'] }, 'create')).toContain('deviceRoles');
    expect(paths({ ...rec, contractLineType: 'per_device_role', deviceRoles: [] }, 'create')).toContain('deviceRoles');
    expect(paths({ ...rec, contractLineType: 'per_device_role', deviceRoles: ['server', 'server'] }, 'create')).toContain('deviceRoles');
  });

  // THE DELEGATION PROOF. A fixture that fails contractLineInvariantIssues must
  // fail here with the SAME message, so a future contract-side rule is inherited
  // automatically rather than silently skipped on the quote side.
  it('inherits every W04 allowance rule verbatim, by message', () => {
    const cases: Array<[Partial<Parameters<typeof quoteLineDeviceSetIssues>[0]>, Record<string, unknown>]> = [
      [{ includedQuantity: 25 }, { includedQuantity: '25.00' }],
      [{ overageMode: 'flag' }, { overageMode: 'flag' }],
      [{ includedQuantity: 0, overageMode: 'flag' }, { includedQuantity: '0.00', overageMode: 'flag' }],
      [{ includedQuantity: 25.5, overageMode: 'flag' }, { includedQuantity: '25.50', overageMode: 'flag' }],
      [{ includedQuantity: 25, overageMode: 'bill' }, { includedQuantity: '25.00', overageMode: 'bill' }],
      [{ includedQuantity: 25, overageMode: 'flag', overageUnitPrice: 12 }, { includedQuantity: '25.00', overageMode: 'flag', overageUnitPrice: '12.00' }],
    ];
    for (const [quoteFields, contractFields] of cases) {
      const mine = quoteLineDeviceSetIssues({ ...rec, contractLineType: 'per_device', ...quoteFields } as never, { mode: 'create' });
      const theirs = contractLineInvariantIssues({ lineType: 'per_device', ...contractFields } as never, { mode: 'create' });
      expect(theirs.length).toBeGreaterThan(0);
      expect(mine.map((i) => i.message)).toEqual(expect.arrayContaining(theirs.map((i) => i.message)));
    }
  });

  // The divergence tripwire. These are equal TODAY; a future wave that widens
  // one without the other must fail here rather than silently accept a quote
  // line acceptance cannot map.
  it('QUOTE_DEVICE_SET_TYPES equals ALLOWANCE_LINE_TYPES', () => {
    expect([...QUOTE_DEVICE_SET_TYPES]).toEqual([...ALLOWANCE_LINE_TYPES]);
  });
});

describe('quoteLineInputSchema — device set and the server-derived quantity (#3205 W05)', () => {
  const GROUP = '33333333-3333-4333-8333-333333333333';
  const base = { sourceType: 'manual' as const, name: 'Servers', unitPrice: 40, taxable: true, recurrence: 'monthly' as const };
  const parse = (v: unknown) => quoteLineInputSchema.safeParse(v);

  // Decision 5, the whole reason the rule is stateful rather than a row invariant.
  it('requires quantity WITHOUT a descriptor and rejects it WITH one', () => {
    expect(parse({ ...base, quantity: 3 }).success).toBe(true);
    expect(parse({ ...base }).success).toBe(false);
    expect(parse({ ...base, contractLineType: 'per_device' }).success).toBe(true);
    const withBoth = parse({ ...base, contractLineType: 'per_device', quantity: 3 });
    expect(withBoth.success).toBe(false);
    expect(withBoth.error!.issues.map((i) => i.path.join('.'))).toContain('quantity');
  });

  it('accepts each type with its fields and an allowance', () => {
    expect(parse({ ...base, contractLineType: 'per_device_role', deviceRoles: ['server'] }).success).toBe(true);
    expect(parse({ ...base, contractLineType: 'per_device_group', deviceGroupId: GROUP }).success).toBe(true);
    expect(parse({ ...base, contractLineType: 'per_seat', includedQuantity: 25, overageMode: 'bill', overageUnitPrice: 12 }).success).toBe(true);
  });

  it('rejects a one_time descriptor, an unknown role, and a bad group id', () => {
    expect(parse({ ...base, recurrence: 'one_time', contractLineType: 'per_device' }).success).toBe(false);
    expect(parse({ ...base, contractLineType: 'per_device_role', deviceRoles: ['unknown'] }).success).toBe(false);
    expect(parse({ ...base, contractLineType: 'per_device_group', deviceGroupId: 'nope' }).success).toBe(false);
  });

  // The server stamps the names; a client that sends one is confused about who
  // owns the value, and silently ignoring it would let a forged document name
  // a group the line does not reference.
  it('does not accept deviceGroupName or siteName as input', () => {
    const r = parse({ ...base, contractLineType: 'per_device_group', deviceGroupId: GROUP, deviceGroupName: 'Forged' });
    expect(r.success && (r.data as Record<string, unknown>).deviceGroupName).toBeUndefined();
  });
});

describe('updateQuoteLineSchema is .strict() (#3205 W05)', () => {
  const parse = (v: unknown) => updateQuoteLineSchema.safeParse(v);

  // Decision 20's anchor. A NON-strict schema ACCEPTS this and silently drops
  // it: 200 OK, nothing changed, and the operator believes the line is now
  // per_seat. contractLineType is not patchable at all — remove and re-add.
  it('rejects contractLineType with the exact unrecognized-key message', () => {
    const r = parse({ contractLineType: 'per_seat' });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toContain('Unrecognized key: "contractLineType"');
  });

  it('rejects a mis-keyed field', () => {
    expect(parse({ deviceGroupID: '33333333-3333-4333-8333-333333333333' }).success).toBe(false);
  });

  // W03's nullability rule, applied unchanged: clearing deviceRoles or
  // deviceGroupId leaves a row the CHECK rejects; clearing the others does not.
  it('accepts null for siteId and the three allowance fields, not for roles or group', () => {
    expect(parse({ siteId: null }).success).toBe(true);
    expect(parse({ includedQuantity: null, overageMode: null, overageUnitPrice: null }).success).toBe(true);
    expect(parse({ deviceRoles: null }).success).toBe(false);
    expect(parse({ deviceGroupId: null }).success).toBe(false);
    expect(parse({ deviceRoles: ['server'] }).success).toBe(true);
  });

  it('preserves key ABSENCE so an omitted field is unchanged', () => {
    const out = parse({ siteId: null });
    expect(Object.prototype.hasOwnProperty.call(out.data!, 'includedQuantity')).toBe(false);
    expect(quoteLinePatchHasKey(out.data!, 'siteId')).toBe(true);
  });

  // THE STANDING GUARD. Every key of the web editor's LineUpdate type must still
  // parse, or the editor 400s on a field it has always sent. Adding a field to
  // LineUpdate without declaring it here now fails HERE instead of in production.
  it.each([
    ['name', { name: 'x' }], ['description', { description: 'x' }], ['quantity', { quantity: 2 }],
    ['unitPrice', { unitPrice: 10 }], ['taxable', { taxable: true }], ['recurrence', { recurrence: 'monthly' }],
    ['unitCost', { unitCost: 5 }], ['sku', { sku: 'S' }], ['partNumber', { partNumber: 'P' }],
    ['imageId', { imageId: '11111111-1111-4111-8111-111111111111' }], ['depositEligible', { depositEligible: true }],
  ])('still accepts LineUpdate key %s', (_k, body) => {
    expect(parse(body).success).toBe(true);
  });
});

describe('mergeQuoteLinePatch (#3205 W05)', () => {
  const current = {
    contractLineType: 'per_device_group', recurrence: 'monthly', parentLineId: null,
    deviceRoles: null, deviceGroupId: '33333333-3333-4333-8333-333333333333', deviceGroupName: 'VIP',
    siteId: null, siteName: null, includedQuantity: 25, overageMode: 'bill', overageUnitPrice: 12,
  } as never;

  it('leaves an omitted key unchanged', () => {
    expect(mergeQuoteLinePatch(current, {} as never)).toMatchObject({ includedQuantity: 25, overageMode: 'bill', deviceGroupName: 'VIP' });
  });

  it('clears a nullable key and keeps the merged row valid', () => {
    const merged = mergeQuoteLinePatch(current, { includedQuantity: null, overageMode: null, overageUnitPrice: null } as never);
    expect(merged).toMatchObject({ includedQuantity: null, overageMode: null, overageUnitPrice: null });
    expect(quoteLineDeviceSetIssues(merged, { mode: 'persisted' })).toEqual([]);
  });

  it('clearing only includedQuantity leaves a row the persisted rules reject', () => {
    const merged = mergeQuoteLinePatch(current, { includedQuantity: null } as never);
    expect(quoteLineDeviceSetIssues(merged, { mode: 'persisted' }).map((i) => i.path)).toContain('overageMode');
  });

  it('patching recurrence to one_time on a descriptor line is caught by the merged row, not the DB', () => {
    const merged = mergeQuoteLinePatch(current, { recurrence: 'one_time' } as never);
    expect(quoteLineDeviceSetIssues(merged, { mode: 'persisted' }).map((i) => i.path)).toContain('recurrence');
  });
});
