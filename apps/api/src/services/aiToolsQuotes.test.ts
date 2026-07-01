import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./quoteService', () => ({
  createQuote: vi.fn().mockResolvedValue({ id: 'quote-1', status: 'draft' }),
  updateQuote: vi.fn().mockResolvedValue({ id: 'quote-1', introNotes: 'Updated' }),
  deleteDraftQuote: vi.fn().mockResolvedValue(undefined),
  addBlock: vi.fn().mockResolvedValue({ id: 'block-1', quoteId: 'quote-1' }),
  updateBlock: vi.fn().mockResolvedValue({ id: 'block-1', content: { text: 'Updated' } }),
  deleteBlock: vi.fn().mockResolvedValue(undefined),
  reorderBlocks: vi.fn().mockResolvedValue(undefined),
  addManualLine: vi.fn().mockResolvedValue({ id: 'line-1', quoteId: 'quote-1' }),
  addCatalogLine: vi.fn().mockResolvedValue({ id: 'line-2', catalogItemId: 'catalog-1' }),
  updateLine: vi.fn().mockResolvedValue({ id: 'line-1', quantity: '2' }),
  removeLine: vi.fn().mockResolvedValue(undefined),
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

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerQuoteTools(map);
  const t = map.get('manage_quotes');
  if (!t) throw new Error('manage_quotes not registered');
  return t;
}

describe('manage_quotes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('create_draft calls createQuote with input payload and actor built from auth', async () => {
    const input = {
      orgId: 'org-1',
      siteId: 'site-1',
      currencyCode: 'USD',
      introNotes: 'Proposal intro',
    };

    const out = await getTool().handler({ action: 'create_draft', input }, auth);

    expect(quoteService.createQuote).toHaveBeenCalledWith(input, actor);
    expect(JSON.parse(out)).toEqual({ id: 'quote-1', status: 'draft' });
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
        catalogItemId: 'catalog-1',
        quantity: 2,
        blockId: 'block-1',
        partNumber: 'MPN-42',
      },
      auth,
    );

    expect(quoteService.addCatalogLine).toHaveBeenCalledWith(
      'quote-1',
      'catalog-1',
      2,
      'block-1',
      actor,
      { partNumber: 'MPN-42' },
    );
    expect(JSON.parse(out)).toEqual({ id: 'line-2', catalogItemId: 'catalog-1' });
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
