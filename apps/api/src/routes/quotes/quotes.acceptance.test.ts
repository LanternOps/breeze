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
//
// orderBy's direction is made observable: it inspects the drizzle `desc()`/
// `asc()` SQL wrapper (its `queryChunks` contain a trailing " desc" value
// chunk) and, if descending, sorts the queued rows by `signedAt` before
// resolving — so a test that queues rows in ascending signedAt order and
// asserts the LATEST one wins actually exercises the route's `desc(...)` call
// rather than trusting insertion order.
const isDescOrderBy = (arg: unknown): boolean => {
  const chunks = (arg as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return false;
  return chunks.some((chunk) => {
    const value = (chunk as { value?: unknown })?.value;
    return Array.isArray(value) && value.some((v) => typeof v === 'string' && v.includes('desc'));
  });
};
const dbRows = vi.hoisted(() => ({ next: [] as any[][], i: 0, selects: [] as Array<Record<string, unknown> | undefined> }));
vi.mock('../../db', () => {
  const builder = () => {
    let descending = false;
    const chain: any = {
      from: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      orderBy: (arg: unknown) => { descending = isDescOrderBy(arg); return chain; },
      limit: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const rows = dbRows.next[dbRows.i++] ?? [];
        const ordered = descending && rows.every((r) => 'signedAt' in r)
          ? [...rows].sort((a, b) => (a.signedAt < b.signedAt ? 1 : a.signedAt > b.signedAt ? -1 : 0))
          : rows;
        return Promise.resolve(ordered).then(resolve, reject);
      },
    };
    return chain;
  };
  return { db: { select: (cols?: Record<string, unknown>) => { dbRows.selects.push(cols); return builder(); } } };
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
    dbRows.selects = [];
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

  it('picks the LATEST acceptance by signedAt when more than one row exists', async () => {
    // Queued in ascending signedAt order (earliest first) — a wrong (ascending)
    // orderBy would hand back the earlier row's id. The mock only sorts
    // descending when it observes the route's actual `desc(...)` SQL wrapper,
    // so this proves the query itself, not the test's row order.
    dbRows.next = [
      [], // resolveQuoteBranding: partners
      [], // resolveQuoteBranding: portalBranding
      [], // recipients
      [
        {
          id: 'earlier-acceptance', signerName: 'First Buyer', signerEmail: 'first@example.test',
          signedAt: '2026-09-19T00:00:00.000Z', origin: 'customer', method: null, reference: null,
          recordedByUserId: null, recordedByName: null,
        },
        {
          id: ACCEPTANCE_ID, signerName: 'Dana Buyer', signerEmail: 'dana@example.test',
          signedAt: '2026-09-20T00:00:00.000Z', origin: 'on_behalf', method: 'purchase_order', reference: 'PO 4471',
          recordedByUserId: 'tech-1', recordedByName: 'Sam Tech',
        },
      ],
    ];
    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    const body = await res.json();
    expect(body.data.acceptance.id).toBe(ACCEPTANCE_ID);
  });

  // #6633 — the evidence file's METADATA rides on the acceptance; the bytes and
  // the storage locator never do.
  it('exposes evidence metadata (never the storage key or bytes) for an on-behalf acceptance', async () => {
    dbRows.next = [[], [], [], [{
      id: ACCEPTANCE_ID, signerName: 'Dana Buyer', signerEmail: 'dana@example.test',
      signedAt: '2026-09-20T00:00:00.000Z', origin: 'on_behalf', method: 'purchase_order', reference: 'PO 4471',
      recordedByUserId: 'tech-1', recordedByName: 'Sam Tech',
      evidenceStorageBackend: 's3', evidenceStorageKey: 'quote-acceptance-evidence/k1',
      evidenceFilename: 'PO-4471.pdf', evidenceContentType: 'application/pdf', evidenceSizeBytes: 2048,
      evidenceSha256: 'ab'.repeat(32), evidenceUploadedAt: new Date('2026-09-21T10:00:00.000Z'),
    }]];
    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    const body = await res.json();
    expect(body.data.acceptance.evidence).toEqual({
      filename: 'PO-4471.pdf', contentType: 'application/pdf', sizeBytes: 2048,
      uploadedAt: '2026-09-21T10:00:00.000Z',
    });
    expect(JSON.stringify(body)).not.toContain('quote-acceptance-evidence/k1');
    // The acceptance read must not drag the inline bytes up.
    const acceptanceSelect = dbRows.selects.find((cols) => cols && 'recordedByName' in cols);
    expect(acceptanceSelect).toBeDefined();
    expect(acceptanceSelect).not.toHaveProperty('evidenceData');
  });

  it('returns evidence: null for an acceptance without a file', async () => {
    dbRows.next = [[], [], [], [{
      id: ACCEPTANCE_ID, signerName: 'Dana Buyer', signerEmail: null,
      signedAt: '2026-09-20T00:00:00.000Z', origin: 'on_behalf', method: 'verbal', reference: 'call',
      recordedByUserId: 'tech-1', recordedByName: 'Sam Tech',
      evidenceStorageBackend: null, evidenceStorageKey: null, evidenceFilename: null,
      evidenceContentType: null, evidenceSizeBytes: null, evidenceSha256: null, evidenceUploadedAt: null,
    }]];
    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    const body = await res.json();
    expect(body.data.acceptance.evidence).toBeNull();
  });
});
