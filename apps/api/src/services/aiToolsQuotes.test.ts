import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./quoteService', () => ({
  createQuote: vi.fn().mockResolvedValue({ id: 'quote-1', status: 'draft' }),
  listQuotes: vi.fn().mockResolvedValue([
    { id: 'quote-1', quoteNumber: 'Q-2026-0001', status: 'draft' },
    { id: 'quote-2', quoteNumber: 'Q-2026-0002', status: 'sent' },
  ]),
  updateQuote: vi.fn().mockResolvedValue({ id: 'quote-1', introNotes: 'Updated' }),
  getQuote: vi.fn().mockResolvedValue({
    quote: {
      id: 'quote-1',
      introNotes: 'Updated',
      depositType: 'percent',
      depositPercent: '30.00',
      depositAmount: '150.00',
      depositDueTotal: '150.00',
      categoryBreakdown: { hardware: '150.00' },
    },
    blocks: [],
    lines: [],
  }),
  deleteDraftQuote: vi.fn().mockResolvedValue(undefined),
  addBlock: vi.fn().mockResolvedValue({ id: 'block-1', quoteId: 'quote-1' }),
  updateBlock: vi.fn().mockResolvedValue({ id: 'block-1', content: { text: 'Updated' } }),
  deleteBlock: vi.fn().mockResolvedValue(undefined),
  reorderBlocks: vi.fn().mockResolvedValue(undefined),
  addManualLine: vi.fn().mockResolvedValue({ id: 'line-1', quoteId: 'quote-1' }),
  addCatalogLine: vi.fn().mockResolvedValue({ id: 'line-2', catalogItemId: 'catalog-1' }),
  updateLine: vi.fn().mockResolvedValue({ id: 'line-1', quantity: '2' }),
  removeLine: vi.fn().mockResolvedValue(undefined),
  moveLineToBlock: vi.fn().mockResolvedValue({ id: 'line-1', blockId: 'block-2', sortOrder: 0 }),
  reorderLines: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./quoteLifecycle', () => ({
  sendQuote: vi.fn().mockResolvedValue({
    quote: { id: 'quote-1', status: 'sent' },
    emailed: false,
    acceptUrl: 'https://example.test/portal/quote/token',
  }),
  declineQuoteByActor: vi.fn().mockResolvedValue({ id: 'quote-1', status: 'declined' }),
}));

vi.mock('./quotePay', () => ({
  createQuotePayLink: vi.fn().mockResolvedValue({ url: 'https://pay.example.test/session' }),
}));

import { registerQuoteTools } from './aiToolsQuotes';
import * as quoteService from './quoteService';
import * as quoteLifecycle from './quoteLifecycle';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import { QuoteServiceError } from './quoteTypes';

const auth: AuthContext = {
  user: { id: 'u-1', email: 'user@example.test', name: 'User', isPlatformAdmin: false },
  token: {
    sub: 'u-1',
    email: 'user@example.test',
    roleId: null,
    orgId: null,
    partnerId: 'p-1',
    scope: 'partner',
    type: 'access',
    mfa: true,
  },
  partnerId: 'p-1',
  orgId: null,
  scope: 'partner',
  accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined,
  canAccessOrg: (orgId) => orgId === 'org-1',
};

const actor = { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: ['org-1'] };

// Payloads are parsed with the shared route schemas, which require real UUIDs.
const ORG_UUID = '11111111-1111-4111-8111-111111111111';
const SITE_UUID = '22222222-2222-4222-8222-222222222222';
const CATALOG_UUID = '33333333-3333-4333-8333-333333333333';
const BLOCK_UUID = '44444444-4444-4444-8444-444444444444';

function getTool(name = 'manage_quotes'): AiTool {
  const map = new Map<string, AiTool>();
  registerQuoteTools(map);
  const t = map.get(name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}

describe('manage_quotes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create_draft calls createQuote with input payload and actor built from auth', async () => {
    const input = {
      orgId: ORG_UUID,
      siteId: SITE_UUID,
      currencyCode: 'USD',
      introNotes: 'Proposal intro',
    };

    const out = await getTool().handler({ action: 'create_draft', input }, auth);

    expect(quoteService.createQuote).toHaveBeenCalledWith(input, actor);
    expect(JSON.parse(out)).toEqual({ id: 'quote-1', status: 'draft' });
  });

  it('update passes depositType/depositPercent through to updateQuote and re-reads the quote', async () => {
    const patch = { depositType: 'percent', depositPercent: 30 };

    const out = await getTool().handler(
      { action: 'update', quoteId: 'quote-1', patch },
      auth,
    );

    expect(quoteService.updateQuote).toHaveBeenCalledWith('quote-1', patch, actor);
    expect(quoteService.getQuote).toHaveBeenCalledWith('quote-1', actor);
    expect(JSON.parse(out)).toEqual({
      id: 'quote-1',
      introNotes: 'Updated',
      depositType: 'percent',
      depositPercent: '30.00',
      depositAmount: '150.00',
      depositDueTotal: '150.00',
      categoryBreakdown: { hardware: '150.00' },
    });
  });

  it('update_line passes depositEligible through to updateLine', async () => {
    const patch = { depositEligible: true };

    const out = await getTool().handler(
      { action: 'update_line', quoteId: 'quote-1', lineId: 'line-1', patch },
      auth,
    );

    expect(quoteService.updateLine).toHaveBeenCalledWith('quote-1', 'line-1', patch, actor);
    expect(JSON.parse(out)).toEqual({ id: 'line-1', quantity: '2' });
  });

  it('send calls sendQuote with quoteId and actor', async () => {
    const out = await getTool().handler(
      { action: 'send', quoteId: 'quote-1' },
      auth,
    );

    expect(quoteLifecycle.sendQuote).toHaveBeenCalledWith('quote-1', actor);
    expect(JSON.parse(out)).toEqual({
      quote: { id: 'quote-1', status: 'sent' },
      emailed: false,
      acceptUrl: 'https://example.test/portal/quote/token',
    });
  });

  it('update_block calls updateBlock with quoteId, blockId, block payload, and actor', async () => {
    const block = {
      blockType: 'heading',
      content: { text: 'Updated', level: 2 },
    };

    const out = await getTool().handler(
      { action: 'update_block', quoteId: 'quote-1', blockId: 'block-1', block },
      auth,
    );

    expect(quoteService.updateBlock).toHaveBeenCalledWith(
      'quote-1',
      'block-1',
      block,
      actor,
    );
    expect(JSON.parse(out)).toEqual({ id: 'block-1', content: { text: 'Updated' } });
  });

  it('add_catalog_line calls addCatalogLine with quoteId, catalog item, quantity, blockId, actor, and options', async () => {
    const out = await getTool().handler(
      {
        action: 'add_catalog_line',
        quoteId: 'quote-1',
        catalogItemId: CATALOG_UUID,
        quantity: 2,
        blockId: BLOCK_UUID,
        partNumber: 'MPN-42',
      },
      auth,
    );

    expect(quoteService.addCatalogLine).toHaveBeenCalledWith(
      'quote-1',
      CATALOG_UUID,
      2,
      BLOCK_UUID,
      actor,
      { partNumber: 'MPN-42' },
    );
    expect(JSON.parse(out)).toEqual({ id: 'line-2', catalogItemId: 'catalog-1' });
  });

  it('move_line re-parents a line via moveLineToBlock (the orphan repair path, #2553)', async () => {
    const out = await getTool().handler(
      { action: 'move_line', quoteId: 'quote-1', lineId: 'line-1', blockId: 'block-2' },
      auth,
    );

    // Reuses the same service the PATCH /:id/lines/:lineId/move route calls, so
    // its guards (block belongs to the quote, block is line_items, bundle
    // children ride with their parent) all apply to the AI path too.
    expect(quoteService.moveLineToBlock).toHaveBeenCalledWith('quote-1', 'line-1', 'block-2', actor);
    expect(JSON.parse(out)).toEqual({ id: 'line-1', blockId: 'block-2', sortOrder: 0 });
  });

  it('move_line surfaces a service rejection (e.g. non-pricing target block) as a structured error', async () => {
    vi.mocked(quoteService.moveLineToBlock).mockRejectedValueOnce(
      new QuoteServiceError('Target block is not a pricing table', 400, 'BLOCK_NOT_LINE_ITEMS'),
    );

    const out = await getTool().handler(
      { action: 'move_line', quoteId: 'quote-1', lineId: 'line-1', blockId: 'block-2' },
      auth,
    );

    expect(JSON.parse(out)).toEqual({
      error: 'Target block is not a pricing table',
      code: 'BLOCK_NOT_LINE_ITEMS',
    });
  });

  it('returns a JSON error when a service action rejects with QuoteServiceError', async () => {
    vi.mocked(quoteLifecycle.sendQuote).mockRejectedValueOnce(
      new QuoteServiceError('Cannot send a quote in status sent', 409, 'INVALID_STATE'),
    );

    const out = await getTool().handler(
      { action: 'send', quoteId: 'quote-1' },
      auth,
    );

    expect(JSON.parse(out)).toEqual({
      error: 'Cannot send a quote in status sent',
      code: 'INVALID_STATE',
    });
  });

  it('re-throws non-service errors from service actions', async () => {
    const err = new Error('database unavailable');
    vi.mocked(quoteLifecycle.declineQuoteByActor).mockRejectedValueOnce(err);

    await expect(
      getTool().handler({ action: 'decline', quoteId: 'quote-1', reason: 'Too expensive' }, auth),
    ).rejects.toBe(err);
  });

  it('unknown action returns a JSON error', async () => {
    const out = await getTool().handler({ action: 'nope' }, auth);

    expect(JSON.parse(out)).toHaveProperty('error');
  });
});

describe('manage_quotes input validation (#2362)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('update without quoteId returns a structured VALIDATION_ERROR instead of throwing', async () => {
    const out = await getTool().handler({ action: 'update', patch: {} }, auth);

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('quoteId');
    expect(quoteService.updateQuote).not.toHaveBeenCalled();
  });

  it('update without patch returns a structured VALIDATION_ERROR', async () => {
    const out = await getTool().handler({ action: 'update', quoteId: 'quote-1' }, auth);

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('patch');
    expect(quoteService.updateQuote).not.toHaveBeenCalled();
  });

  it('create_draft without input returns a structured VALIDATION_ERROR', async () => {
    const out = await getTool().handler({ action: 'create_draft' }, auth);

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('input');
    expect(quoteService.createQuote).not.toHaveBeenCalled();
  });

  it('add_manual_line missing sourceType/taxable returns a VALIDATION_ERROR naming the fields', async () => {
    const out = await getTool().handler(
      {
        action: 'add_manual_line',
        quoteId: 'quote-1',
        line: { name: 'Onsite labor', description: 'Two hours', quantity: 2, unitPrice: 150 },
      },
      auth,
    );

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('line.sourceType');
    expect(parsed.error).toContain('line.taxable');
    expect(quoteService.addManualLine).not.toHaveBeenCalled();
  });

  it('add_manual_line with a valid line passes the parsed line (with schema defaults) to the service', async () => {
    const out = await getTool().handler(
      {
        action: 'add_manual_line',
        quoteId: 'quote-1',
        line: { sourceType: 'manual', name: 'Onsite labor', quantity: 2, unitPrice: 150, taxable: false },
      },
      auth,
    );

    expect(quoteService.addManualLine).toHaveBeenCalledWith(
      'quote-1',
      expect.objectContaining({
        sourceType: 'manual',
        name: 'Onsite labor',
        quantity: 2,
        unitPrice: 150,
        taxable: false,
        // Defaults applied by quoteLineInputSchema
        customerVisible: true,
        recurrence: 'one_time',
        depositEligible: false,
      }),
      actor,
    );
    expect(JSON.parse(out)).toEqual({ id: 'line-1', quoteId: 'quote-1' });
  });

  it('add_catalog_line with partNumber but no catalogItemId returns a VALIDATION_ERROR, not a throw', async () => {
    const out = await getTool().handler(
      { action: 'add_catalog_line', quoteId: 'quote-1', partNumber: 'MPN-42' },
      auth,
    );

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('catalogItemId');
    expect(quoteService.addCatalogLine).not.toHaveBeenCalled();
  });

  it('add_catalog_line with a non-UUID catalogItemId returns a VALIDATION_ERROR with the field path', async () => {
    const out = await getTool().handler(
      { action: 'add_catalog_line', quoteId: 'quote-1', catalogItemId: 'not-a-uuid', quantity: 1 },
      auth,
    );

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('catalogItemId');
    expect(quoteService.addCatalogLine).not.toHaveBeenCalled();
  });

  it('add_block with a mismatched content shape returns a VALIDATION_ERROR', async () => {
    const out = await getTool().handler(
      { action: 'add_block', quoteId: 'quote-1', block: { blockType: 'heading', content: {} } },
      auth,
    );

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('block.');
    expect(quoteService.addBlock).not.toHaveBeenCalled();
  });

  it('move_line without blockId returns a structured VALIDATION_ERROR', async () => {
    const out = await getTool().handler(
      { action: 'move_line', quoteId: 'quote-1', lineId: 'line-1' },
      auth,
    );

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('blockId');
    expect(quoteService.moveLineToBlock).not.toHaveBeenCalled();
  });

  it('move_line without lineId returns a structured VALIDATION_ERROR', async () => {
    const out = await getTool().handler(
      { action: 'move_line', quoteId: 'quote-1', blockId: 'block-2' },
      auth,
    );

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('lineId');
    expect(quoteService.moveLineToBlock).not.toHaveBeenCalled();
  });

  it('remove_line without lineId returns a structured VALIDATION_ERROR', async () => {
    const out = await getTool().handler({ action: 'remove_line', quoteId: 'quote-1' }, auth);

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('lineId');
    expect(quoteService.removeLine).not.toHaveBeenCalled();
  });
});

describe('list_quotes / get_quote read tools (#2361)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('list_quotes with no filters lists quotes with the default limit', async () => {
    const out = await getTool('list_quotes').handler({}, auth);

    expect(quoteService.listQuotes).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
      actor,
    );
    const parsed = JSON.parse(out);
    expect(parsed.showing).toBe(2);
    expect(parsed.quotes).toHaveLength(2);
    expect(parsed.quotes[0].id).toBe('quote-1');
  });

  it('list_quotes forwards org/status filters and clamps limit via the shared schema', async () => {
    await getTool('list_quotes').handler({ orgId: ORG_UUID, status: 'sent', limit: 10 }, auth);

    expect(quoteService.listQuotes).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_UUID, status: 'sent', limit: 10 }),
      actor,
    );
  });

  it('list_quotes with an invalid status returns a structured VALIDATION_ERROR', async () => {
    const out = await getTool('list_quotes').handler({ status: 'bogus' }, auth);

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('status');
    expect(quoteService.listQuotes).not.toHaveBeenCalled();
  });

  it('get_quote returns the full view (header + blocks + lines) from getQuote', async () => {
    const out = await getTool('get_quote').handler({ quoteId: 'quote-1' }, auth);

    expect(quoteService.getQuote).toHaveBeenCalledWith('quote-1', actor);
    const parsed = JSON.parse(out);
    expect(parsed.quote.id).toBe('quote-1');
    expect(parsed).toHaveProperty('blocks');
    expect(parsed).toHaveProperty('lines');
  });

  it('get_quote without quoteId returns a structured VALIDATION_ERROR', async () => {
    const out = await getTool('get_quote').handler({}, auth);

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('quoteId');
    expect(quoteService.getQuote).not.toHaveBeenCalled();
  });

  it('get_quote maps QuoteServiceError (e.g. QUOTE_NOT_FOUND) to a structured error', async () => {
    vi.mocked(quoteService.getQuote).mockRejectedValueOnce(
      new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND'),
    );

    const out = await getTool('get_quote').handler({ quoteId: 'missing' }, auth);

    expect(JSON.parse(out)).toEqual({ error: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
  });

  it('update with an empty patch is rejected with VALIDATION_ERROR and does not touch the quote (#2361)', async () => {
    const out = await getTool().handler({ action: 'update', quoteId: 'quote-1', patch: {} }, auth);

    const parsed = JSON.parse(out);
    expect(parsed.code).toBe('VALIDATION_ERROR');
    expect(parsed.error).toContain('get_quote');
    // No UPDATE runs, so updatedAt cannot be bumped by an empty patch.
    expect(quoteService.updateQuote).not.toHaveBeenCalled();
    expect(quoteService.getQuote).not.toHaveBeenCalled();
  });
});
