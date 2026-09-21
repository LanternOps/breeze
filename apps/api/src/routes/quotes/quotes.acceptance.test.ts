import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring only.
vi.mock('../../services/quoteService', () => ({
  createQuote: vi.fn(),
  cloneQuote: vi.fn(),
  getQuote: vi.fn(),
  listQuotes: vi.fn(),
  updateQuote: vi.fn(),
  deleteDraftQuote: vi.fn(),
  addBlock: vi.fn(),
  updateBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  moveLineToBlock: vi.fn(),
}));

vi.mock('../../services/quoteTypes', () => ({
  QuoteServiceError: class QuoteServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

vi.mock('../../services/stripeConnectService', () => ({ getConnection: vi.fn() }));

vi.mock('../../services/contractTemplateRender', () => ({
  renderContractBlocksForClient: vi.fn(async (blocks: unknown[]) => blocks),
  loadContractPdfInputs: vi.fn(async () => ({ contractRenderData: new Map(), uploads: [] })),
  loadContractBlockAuthoring: vi.fn(async () => new Map()),
  attachContractAuthoring: vi.fn((blocks: unknown[]) => blocks),
}));

vi.mock('../../services/quotePdf', () => ({ renderQuotePdf: vi.fn() }));

// db mock: select().from().leftJoin().where().orderBy()/.limit() resolves the
// next queued rows array. leftJoin is a no-op passthrough on the chain — the
// acceptance query is the only caller that uses it in this route.
const dbRows = vi.hoisted(() => ({ next: [] as any[][], i: 0 }));
vi.mock('../../db', () => {
  const builder = () => {
    const chain: any = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(dbRows.next[dbRows.i++] ?? []).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select: () => builder() } };
});

const gate = vi.hoisted(() => ({ permGate: async (_c: any, next: any) => next() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (c: any, next: any) => gate.permGate(c, next),
  requirePermission: () => async (c: any, next: any) => gate.permGate(c, next),
}));

import { quoteRoutes } from './index';
import * as svc from '../../services/quoteService';
import { getConnection } from '../../services/stripeConnectService';

function app() { return quoteRoutes; }

const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const ACCEPTANCE_ID = '44444444-4444-4444-4444-444444444444';

describe('GET /:id acceptance record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.permGate = async (_c: any, next: any) => next();
    dbRows.next = [];
    dbRows.i = 0;
    vi.mocked(getConnection).mockResolvedValue(null);
    (svc.getQuote as any).mockResolvedValue({ quote: { id: QUOTE_ID }, blocks: [], lines: [] });
  });

  it('returns the acceptance record with its provenance and the recorder name', async () => {
    dbRows.next = [
      [], // resolveQuoteBranding: partners
      [], // resolveQuoteBranding: portalBranding
      [], // recipients (getQuoteRecipients — real service, own db import not mocked here; falls back to [])
      [{
        id: ACCEPTANCE_ID,
        signerName: 'Dana Buyer',
        signerEmail: 'dana@example.test',
        signedAt: '2026-09-20T00:00:00.000Z',
        origin: 'on_behalf',
        method: 'purchase_order',
        reference: 'PO 4471',
        recordedByUserId: 'tech-1',
        recordedByName: 'Sam Tech',
      }],
    ];
    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.acceptance).toMatchObject({
      origin: 'on_behalf', method: 'purchase_order', reference: 'PO 4471',
      signerName: 'Dana Buyer',
      recordedBy: { id: 'tech-1', name: 'Sam Tech' },
    });
  });

  it('returns null acceptance for a quote nobody has accepted', async () => {
    dbRows.next = [[], [], [], []];
    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    const body = await res.json();
    expect(body.data.acceptance).toBeNull();
  });

  it('survives a deleted recorder', async () => {
    dbRows.next = [
      [], // resolveQuoteBranding: partners
      [], // resolveQuoteBranding: portalBranding
      [], // recipients
      [{
        id: ACCEPTANCE_ID,
        signerName: 'Dana Buyer',
        signerEmail: 'dana@example.test',
        signedAt: '2026-09-20T00:00:00.000Z',
        origin: 'on_behalf',
        method: 'purchase_order',
        reference: 'PO 4471',
        recordedByUserId: null,
        recordedByName: null,
      }],
    ];
    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    const body = await res.json();
    expect(body.data.acceptance.recordedBy).toBeNull();
  });
});
