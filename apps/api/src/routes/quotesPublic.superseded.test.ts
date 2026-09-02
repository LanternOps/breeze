import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// DB mock: select().from().where().limit()/orderBy() resolves to the next queued
// row set, consumed FIFO in call order. Keep each test's queue aligned with the
// literal query order in quotesPublic.ts.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'update', 'set', 'returning', 'for']) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (resolve: (value: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  return {
    db: makeChain(),
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

vi.mock('../services/quoteAcceptToken', () => ({
  verifyQuoteAcceptToken: vi.fn(),
  isQuoteAcceptJtiRevoked: vi.fn(),
  revokeQuoteAcceptJti: vi.fn(),
}));
vi.mock('../services/quoteLifecycle', () => ({ markQuoteViewed: vi.fn() }));
vi.mock('../services/quoteOutcomeNotify', () => ({
  notifyQuoteOutcome: vi.fn().mockResolvedValue(undefined),
}));
// Merge-chain resolution (Task 6) is exercised for real in
// orgMergeQuoteContinuity.integration.test.ts; here it's a pure passthrough
// so this file stays focused on the serialization path, same rationale as
// the quoteAcceptToken/quoteLifecycle stubs above.
vi.mock('../services/orgMerge', () => ({ resolveMergedOrgIds: vi.fn(async (orgId: string) => [orgId]) }));
// Org-lifecycle gate (Wave 4 review fix C-A.1) runs its own system-context
// query in resolve(); stubbed OPEN here so the queued dbResults stay aligned
// with the superseded-path queries this file is about. The gate's own
// behaviour is covered by publicLinkOrgGate.test.ts + quotesPublic.test.ts.
vi.mock('../services/publicLinkOrgGate', async (importActual) => {
  const actual = await importActual<typeof import('../services/publicLinkOrgGate')>();
  return {
    ...actual,
    resolveQuoteLinkOrgGate: vi.fn(async () => actual.PUBLIC_LINK_ORG_GATE_OPEN),
  };
});

import { db } from '../db';
import {
  isQuoteAcceptJtiRevoked,
  revokeQuoteAcceptJti,
  verifyQuoteAcceptToken,
} from '../services/quoteAcceptToken';
import { markQuoteViewed } from '../services/quoteLifecycle';
import { quotesPublicRoutes } from './quotesPublic';

const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const IMAGE_ID = '44444444-4444-4444-4444-444444444444';
const LINE_ID = '55555555-5555-5555-5555-555555555555';
const BLOCK_ID = '66666666-6666-6666-6666-666666666666';
const TEMPLATE_ID = '77777777-7777-7777-7777-777777777777';
const VERSION_ID = '88888888-8888-8888-8888-888888888888';
const TOKEN = 'a-valid-looking-token-1234567890';
const REVOKED_AT = new Date('2026-08-23T12:00:00.000Z');

function app() {
  const instance = new Hono();
  instance.route('/quotes/public', quotesPublicRoutes);
  return instance;
}

function quoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: QUOTE_ID,
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    status: 'sent',
    publicLinkRevokedAt: null,
    revisionOfQuoteId: null,
    revisionNumber: 1,
    quoteNumber: 'Q-2026-0001',
    title: 'Managed Services',
    currencyCode: 'USD',
    taxRate: null,
    expiryDate: null,
    depositType: 'none',
    depositPercent: null,
    presentationSnapshot: null,
    documentLocale: null,
    ...overrides,
  };
}

const partnerRow = {
  name: 'Acme MSP',
  documentTheme: null,
  documentPageSize: null,
  settings: {},
};

const imageRow = {
  data: Buffer.from('PNGDATA'),
  mime: 'image/png',
  byteSize: 7,
};

const contractBlock = {
  id: BLOCK_ID,
  quoteId: QUOTE_ID,
  orgId: ORG_ID,
  blockType: 'contract',
  content: {
    templateId: TEMPLATE_ID,
    templateVersionId: VERSION_ID,
    variableValues: {},
  },
  sortOrder: 0,
};

const contractVersion = {
  id: VERSION_ID,
  templateId: TEMPLATE_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  versionNumber: 1,
  status: 'published',
  sourceType: 'uploaded',
  bodyHtml: null,
  fileData: Buffer.from('%PDF-1.4'),
  mime: 'application/pdf',
  byteSize: 8,
  sha256: 'sha',
  declaredVariables: [],
  publishedAt: new Date('2026-07-01T00:00:00.000Z'),
  createdBy: 'user-1',
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
};

const contractTemplate = {
  id: TEMPLATE_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  name: 'MSA',
  description: null,
  status: 'active',
  createdBy: 'user-1',
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
};

function resetTokenMocks() {
  (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue({
    quoteId: QUOTE_ID,
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    jti: 'jti-1',
  });
  (isQuoteAcceptJtiRevoked as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  (revokeQuoteAcceptJti as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (markQuoteViewed as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [key, ...collectKeys(nested)]);
}

async function expectSupersededTombstone(response: Response) {
  expect(response.status).toBe(410);
  const body = await response.json();
  expect(body).toMatchObject({
    code: 'QUOTE_SUPERSEDED',
    data: { branding: { partnerName: 'Acme MSP' } },
  });

  expect(body.data).not.toHaveProperty('blocks');
  expect(body.data).not.toHaveProperty('lines');
  expect(body.data).not.toHaveProperty('quote');
  expect(body.data).not.toHaveProperty('totals');
  expect(body.data).not.toHaveProperty('subtotal');
  expect(body.data).not.toHaveProperty('total');
  expect(body.data).not.toHaveProperty('dueOnAcceptanceTotal');

  const exposedRevisionIdentifiers = collectKeys(body).filter((key) =>
    /(?:successor|revision|replacement|supersededBy).*(?:id|token)|(?:id|token).*(?:successor|revision|replacement|supersededBy)/i.test(key),
  );
  expect(exposedRevisionIdentifiers).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  resetTokenMocks();
});

describe('quotesPublic retired-link tombstone', () => {
  it('GET /:token returns a branded, content-free 410 for a superseded quote', async () => {
    dbResults.push([quoteRow({ status: 'superseded' })]);
    dbResults.push([{ name: 'Acme MSP' }]);

    const response = await app().request(`/quotes/public/${TOKEN}`);

    await expectSupersededTombstone(response);
  });

  it('GET /:token returns the same branded, content-free 410 when only publicLinkRevokedAt is set', async () => {
    dbResults.push([quoteRow({ status: 'sent', publicLinkRevokedAt: REVOKED_AT })]);
    dbResults.push([{ name: 'Acme MSP' }]);

    const response = await app().request(`/quotes/public/${TOKEN}`);

    await expectSupersededTombstone(response);
  });

  it('GET /:token still returns 200 for a live sent quote', async () => {
    dbResults.push([quoteRow({ status: 'sent', publicLinkRevokedAt: null })]);
    dbResults.push([]); // quoteBlocks SELECT
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([partnerRow]); // partners SELECT
    dbResults.push([]); // portalBranding SELECT

    const response = await app().request(`/quotes/public/${TOKEN}`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.quote.id).toBe(QUOTE_ID);
    expect(body.data.branding.partnerName).toBe('Acme MSP');
  });
});

type AssetCase = {
  name: string;
  path: string;
  error: string;
  queuedReads: (quote: Record<string, unknown>) => unknown[][];
};

const assetCases: AssetCase[] = [
  {
    name: 'GET /:token/images/:imageId',
    path: `/quotes/public/${TOKEN}/images/${IMAGE_ID}`,
    error: 'Image not found',
    queuedReads: (quote) => [[quote], [imageRow]],
  },
  {
    name: 'GET /:token/line-image/:lineId',
    path: `/quotes/public/${TOKEN}/line-image/${LINE_ID}`,
    error: 'Image not found',
    queuedReads: (quote) => [
      [quote],
      [{ imageId: IMAGE_ID, catalogItemId: null, customerVisible: true }],
      [imageRow],
    ],
  },
  {
    name: 'GET /:token/contract-file/:blockId',
    path: `/quotes/public/${TOKEN}/contract-file/${BLOCK_ID}`,
    error: 'Contract file not found',
    queuedReads: (quote) => [[quote], [contractBlock], [contractVersion], [contractTemplate]],
  },
];

describe('quotesPublic retired-link assets', () => {
  it.each(assetCases)('$name returns 404 for a superseded quote', async ({ path, error, queuedReads }) => {
    dbResults.push(...queuedReads(quoteRow({ status: 'superseded' })));

    const response = await app().request(path);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error });
  });

  it.each(assetCases)('$name returns 404 when publicLinkRevokedAt is set', async ({ path, error, queuedReads }) => {
    dbResults.push(...queuedReads(quoteRow({ status: 'sent', publicLinkRevokedAt: REVOKED_AT })));

    const response = await app().request(path);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error });
  });
});

describe('quotesPublic retired-link decline', () => {
  async function decline(quote: Record<string, unknown>) {
    dbResults.push([quote]);
    return app().request(`/quotes/public/${TOKEN}/decline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Using the revised proposal' }),
    });
  }

  it('POST /:token/decline returns 410 QUOTE_SUPERSEDED for a superseded quote', async () => {
    const response = await decline(quoteRow({ status: 'superseded' }));

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: 'QUOTE_SUPERSEDED' });
  });

  it('POST /:token/decline returns 410 QUOTE_SUPERSEDED when publicLinkRevokedAt is set', async () => {
    const response = await decline(quoteRow({ status: 'sent', publicLinkRevokedAt: REVOKED_AT }));

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: 'QUOTE_SUPERSEDED' });
  });
});

describe('quotesPublic Redis-revoked token ordering', () => {
  const tokenGateCases = [
    { name: 'GET /:token', path: `/quotes/public/${TOKEN}` },
    { name: 'GET /:token/images/:imageId', path: `/quotes/public/${TOKEN}/images/${IMAGE_ID}` },
    { name: 'GET /:token/line-image/:lineId', path: `/quotes/public/${TOKEN}/line-image/${LINE_ID}` },
    { name: 'GET /:token/contract-file/:blockId', path: `/quotes/public/${TOKEN}/contract-file/${BLOCK_ID}` },
  ];

  it.each(tokenGateCases)('$name returns 401 before any quote liveness read', async ({ path }) => {
    (isQuoteAcceptJtiRevoked as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const response = await app().request(path);

    expect(response.status).toBe(401);
    expect((db as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });
});

type TokenRouteCase = {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  queuedReads: unknown[][];
};

function materializePath(path: string) {
  return path
    .replace(':token', TOKEN)
    .replace(':imageId', IMAGE_ID)
    .replace(':lineId', LINE_ID)
    .replace(':blockId', BLOCK_ID);
}

describe('quotesPublic token-route liveness enumeration', () => {
  it('keeps every token-authenticated route non-2xx after the quote link is revoked', async () => {
    const revokedQuote = quoteRow({ status: 'sent', publicLinkRevokedAt: REVOKED_AT });
    // Enumeration guard: this list must be kept in sync with quotesPublic.ts.
    // Adding a token-authenticated route without a liveness check must make this
    // test fail, so the registered route inventory comparison is intentionally strict.
    const tokenRoutes: TokenRouteCase[] = [
      {
        name: 'view quote',
        method: 'GET',
        path: '/:token',
        queuedReads: [[revokedQuote], [], [], [partnerRow], []],
      },
      {
        name: 'quote image',
        method: 'GET',
        path: '/:token/images/:imageId',
        queuedReads: [[revokedQuote], [imageRow]],
      },
      {
        name: 'line image',
        method: 'GET',
        path: '/:token/line-image/:lineId',
        queuedReads: [
          [revokedQuote],
          [{ imageId: IMAGE_ID, catalogItemId: null, customerVisible: true }],
          [imageRow],
        ],
      },
      {
        name: 'contract file',
        method: 'GET',
        path: '/:token/contract-file/:blockId',
        queuedReads: [[revokedQuote], [contractBlock], [contractVersion], [contractTemplate]],
      },
      {
        name: 'accept quote',
        method: 'POST',
        path: '/:token/accept',
        queuedReads: [[], [revokedQuote]],
      },
      {
        name: 'decline quote',
        method: 'POST',
        path: '/:token/decline',
        queuedReads: [[revokedQuote], [{ id: QUOTE_ID }]],
      },
    ];

    const registeredRoutes = Array.from(new Set(
      (quotesPublicRoutes as unknown as { routes: Array<{ method: string; path: string }> }).routes
        .map((route) => `${route.method} ${route.path}`),
    )).sort();
    const enumeratedRoutes = tokenRoutes.map((route) => `${route.method} ${route.path}`).sort();
    expect(registeredRoutes).toEqual(enumeratedRoutes);

    for (const route of tokenRoutes) {
      vi.clearAllMocks();
      dbResults.length = 0;
      resetTokenMocks();
      dbResults.push(...route.queuedReads);

      const requestPath = `/quotes/public${materializePath(route.path)}`;
      const init = route.method === 'POST'
        ? {
            method: route.method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(route.path.endsWith('/accept')
              ? { signerName: 'Customer Signer' }
              : { reason: 'Using the revision' }),
          }
        : { method: route.method };
      const response = await app().request(requestPath, init);

      expect(
        response.status < 200 || response.status >= 300,
        `${route.name} returned ${response.status} for a revoked public link`,
      ).toBe(true);
    }
  });
});
