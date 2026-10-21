/**
 * #9418 W2a characterization pin for GET /quotes/public/:token. The DB is a
 * table-keyed stand-in (`__tests__/helpers/tableKeyedDb.ts`), so this pin
 * survives changes to which queries run and in what order; the serialization
 * boundaries (`toPublicQuoteHeader`, `toCustomerLines`,
 * `attachCustomerLineImages`, the block read sanitizer) are REAL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { state } = vi.hoisted(() => ({
  state: {
    db: null as null | import('../__tests__/helpers/tableKeyedDb').TableKeyedDb,
    quote: undefined as undefined | Record<string, unknown>,
  },
}));
vi.mock('../db', async () => {
  const { createTableKeyedDb } = await import('../__tests__/helpers/tableKeyedDb');
  const { pinQuoteRowsByTable } = await import('./__fixtures__/customerQuotePin');
  state.db = createTableKeyedDb(() =>
    pinQuoteRowsByTable(state.db!.reads.filter((t) => t === 'quotes').length, { quote: state.quote }));
  return {
    db: state.db.db,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/quoteAcceptToken', () => ({
  verifyQuoteAcceptToken: vi.fn(async () => ({
    quoteId: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222',
    partnerId: '33333333-3333-4333-8333-333333333333', jti: 'jti-pin',
  })),
  isQuoteAcceptJtiRevoked: vi.fn(async () => false),
  revokeQuoteAcceptJti: vi.fn(),
}));
vi.mock('../services/orgMerge', () => ({ resolveMergedOrgIds: vi.fn(async (orgId: string) => [orgId]) }));
vi.mock('../services/publicLinkOrgGate', async (importActual) => {
  const actual = await importActual<typeof import('../services/publicLinkOrgGate')>();
  return { ...actual, resolveQuoteLinkOrgGate: vi.fn(async () => actual.PUBLIC_LINK_ORG_GATE_OPEN) };
});
const { markViewedMock } = vi.hoisted(() => ({ markViewedMock: vi.fn() }));
vi.mock('../services/quoteLifecycle', () => ({ markQuoteViewed: markViewedMock }));
vi.mock('../services/quoteAcceptCheckout', () => ({
  isPayOnAcceptAvailable: vi.fn(async () => false),
  resolveAcceptCheckoutUrl: vi.fn(),
}));
vi.mock('../services/quoteOutcomeNotify', () => ({ notifyQuoteOutcome: vi.fn() }));

import { quotesPublicRoutes } from './quotesPublic';
import { PIN_QUOTE_ROW, PIN_QUOTE_TOKEN } from './__fixtures__/customerQuotePin';
import PUBLIC_PIN from './__fixtures__/customerQuotePin.public.json';

function app() {
  const a = new Hono();
  a.route('/quotes/public', quotesPublicRoutes);
  return a;
}

beforeEach(() => {
  markViewedMock.mockReset();
  state.quote = undefined;
  state.db!.reads.length = 0;
  state.db!.selects.length = 0;
});

// Recorded at origin/main 9e0add3cef before the quote assembler existed. Task 5
// may only ADD the declared keys. The JSON file is frozen.
const PIN = PUBLIC_PIN;

describe('GET /quotes/public/:token — characterization pin (#9418)', () => {
  it("today's live payload", async () => {
    const res = await app().request(`/quotes/public/${PIN_QUOTE_TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(PIN);
  });

  it("today's superseded payload (410, no document)", async () => {
    state.quote = { ...PIN_QUOTE_ROW, status: 'superseded', publicLinkRevokedAt: new Date('2026-03-05T00:00:00.000Z') };
    const res = await app().request(`/quotes/public/${PIN_QUOTE_TOKEN}`);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: 'This proposal has been replaced by an updated version — please use the link in the latest email.',
      code: 'QUOTE_SUPERSEDED',
      data: { branding: { partnerName: 'Example MSP' } },
    });
  });
});
