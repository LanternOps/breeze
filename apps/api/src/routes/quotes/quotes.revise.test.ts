import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Drive the real mounted router and real auth middleware. Only the DB-backed
// permission lookup is controlled so a missing or incorrect route gate produces
// a real HTTP response rather than a vacuous permission-constant comparison.
const permState = vi.hoisted(() => ({ perms: ['quotes:read', 'quotes:write'] }));

vi.mock('../../services/permissions', async (importActual) => {
  const actual = await importActual<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: permState.perms.map((p) => {
        const [resource, action] = p.split(':');
        return { resource, action };
      }),
      partnerId: 'p1', orgId: null, roleId: 'r1', scope: 'partner' as const,
    })),
  };
});

vi.mock('../../services/quoteService', () => ({
  createQuote: vi.fn(), cloneQuote: vi.fn(), reviseQuote: vi.fn(), getQuote: vi.fn(),
  listQuotes: vi.fn(), updateQuote: vi.fn(), deleteDraftQuote: vi.fn(),
  addBlock: vi.fn(), updateBlock: vi.fn(), deleteBlock: vi.fn(),
  addManualLine: vi.fn(), addCatalogLine: vi.fn(), updateLine: vi.fn(), removeLine: vi.fn(),
  reorderBlocks: vi.fn(), reorderLines: vi.fn(), moveLineToBlock: vi.fn(),
  changeQuoteCurrency: vi.fn(),
}));
vi.mock('../../services/quoteOrderService', () => ({
  createQuoteOrder: vi.fn(), updateQuoteOrder: vi.fn(), updateQuoteOrderLine: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) },
}));
vi.mock('../../services/catalogImageStorage', () => ({ readCatalogItemImage: vi.fn() }));
vi.mock('../../services/quoteBranding', () => ({ resolveQuoteBranding: vi.fn() }));
vi.mock('../../services/quoteLifecycle', () => ({ getQuoteRecipients: vi.fn() }));
vi.mock('../../services/contractTemplateRender', () => ({
  renderContractBlocksForClient: vi.fn(), loadContractPdfInputs: vi.fn(),
  loadContractBlockAuthoring: vi.fn(), attachContractAuthoring: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: audit.writeRouteAudit }));

import { quoteCrudRoutes } from './quotes';
import { getQuote, reviseQuote } from '../../services/quoteService';
import { QuoteServiceError } from '../../services/quoteTypes';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';
const actor = {
  userId: 'u1', partnerId: 'p1', accessibleOrgIds: null, allowedSiteIds: undefined,
};
const parent = { id: QUOTE_ID, orgId: 'org1', status: 'sent', revisionNumber: 1 };
const revision = {
  id: REVISION_ID,
  orgId: 'org1',
  status: 'draft',
  quoteNumber: 'Q-2026-0042-R2',
  revisionOfQuoteId: QUOTE_ID,
  revisionNumber: 2,
};

function appWith(perms: string[]) {
  permState.perms = perms;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner',
      accessibleOrgIds: null,
    } as never);
    await next();
  });
  app.route('/', quoteCrudRoutes);
  return app;
}

describe('POST /:id/revise', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQuote).mockResolvedValue({ quote: parent } as never);
    vi.mocked(reviseQuote).mockResolvedValue(revision as never);
  });

  it('returns the new draft and revises with the authenticated actor', async () => {
    const res = await appWith(['quotes:read', 'quotes:write'])
      .request(`/${QUOTE_ID}/revise`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: revision });
    expect(reviseQuote).toHaveBeenCalledWith(QUOTE_ID, actor);
  });

  it('returns HTTP 403 without quotes:write', async () => {
    const res = await appWith(['quotes:read'])
      .request(`/${QUOTE_ID}/revise`, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(getQuote).not.toHaveBeenCalled();
    expect(reviseQuote).not.toHaveBeenCalled();
  });

  it('serializes REVISION_IN_PROGRESS metadata', async () => {
    vi.mocked(reviseQuote).mockRejectedValue(new QuoteServiceError(
      'A revision of this quote is already in progress',
      409,
      'REVISION_IN_PROGRESS',
      { revisionQuoteId: REVISION_ID },
    ));

    const res = await appWith(['quotes:read', 'quotes:write'])
      .request(`/${QUOTE_ID}/revise`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'A revision of this quote is already in progress',
      code: 'REVISION_IN_PROGRESS',
      meta: { revisionQuoteId: REVISION_ID },
    });
    expect(audit.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('audits the parent lineage and status', async () => {
    await appWith(['quotes:read', 'quotes:write'])
      .request(`/${QUOTE_ID}/revise`, { method: 'POST' });

    expect(audit.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org1',
      action: 'quote.revised',
      resourceType: 'quote',
      resourceId: REVISION_ID,
      result: 'success',
      details: { parentQuoteId: QUOTE_ID, revisionNumber: 2, parentStatus: 'sent' },
    });
  });
});
