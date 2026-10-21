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
const { assembleSpy } = vi.hoisted(() => ({ assembleSpy: vi.fn() }));
vi.mock('../services/customerQuoteDocument', async (importActual) => {
  const actual = await importActual<typeof import('../services/customerQuoteDocument')>();
  return {
    ...actual,
    assembleCustomerQuoteDocument: (...args: Parameters<typeof actual.assembleCustomerQuoteDocument>) => {
      assembleSpy(...args);
      return actual.assembleCustomerQuoteDocument(...args);
    },
  };
});

import { quotesPublicRoutes } from './quotesPublic';
import { PIN_QUOTE_ROW, PIN_QUOTE_TOKEN, PIN_QUOTE_LINE_IDS } from './__fixtures__/customerQuotePin';
import PUBLIC_PIN from './__fixtures__/customerQuotePin.public.json';
import { stripAdditive } from '../__tests__/helpers/stripAdditive';

// The ONLY keys the assembler refactor may add to this response (#9418 W2a).
const PUBLIC_ADDITIVE = ['data.quote.displayStatus', 'data.documentLocale'] as const;

function app() {
  const a = new Hono();
  a.route('/quotes/public', quotesPublicRoutes);
  return a;
}

beforeEach(() => {
  markViewedMock.mockReset();
  assembleSpy.mockReset();
  state.quote = undefined;
  state.db!.reads.length = 0;
  state.db!.selects.length = 0;
});

// Recorded at origin/main 9e0add3cef before the quote assembler existed. Task 5
// may only ADD the declared keys. The JSON file is frozen.
const PIN = PUBLIC_PIN;

describe('GET /quotes/public/:token — characterization pin (#9418)', () => {
  it('the live payload is the pin plus only the declared additive keys', async () => {
    const res = await app().request(`/quotes/public/${PIN_QUOTE_TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(stripAdditive(body, PUBLIC_ADDITIVE)).toEqual(PIN);
    expect(body.data.quote.displayStatus).toBe('viewed');
    expect(body.data.documentLocale).toBe('en');
    expect(body.data.lines.map((l: { id: string }) => l.id)).toEqual([PIN_QUOTE_LINE_IDS.firewall, PIN_QUOTE_LINE_IDS.monitoring]);
    expect(assembleSpy).toHaveBeenCalledTimes(1);
    expect(assembleSpy.mock.calls[0]![1]).toBe('public');
    expect(markViewedMock).toHaveBeenCalledTimes(1);
  });

  it('a failing view stamp never fails the render', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      markViewedMock.mockRejectedValueOnce(new Error('stamp down'));
      const res = await app().request(`/quotes/public/${PIN_QUOTE_TOKEN}`);
      expect(res.status).toBe(200);
      expect(stripAdditive(await res.json(), PUBLIC_ADDITIVE)).toEqual(PIN);
    } finally {
      err.mockRestore();
    }
  });

  it('a dead (superseded) link answers its 410 without reaching the assembler', async () => {
    state.quote = { ...PIN_QUOTE_ROW, status: 'superseded', publicLinkRevokedAt: new Date('2026-03-05T00:00:00.000Z') };
    const res = await app().request(`/quotes/public/${PIN_QUOTE_TOKEN}`);
    expect(res.status).toBe(410);
    expect(assembleSpy).not.toHaveBeenCalled();
    expect(markViewedMock).not.toHaveBeenCalled();
  });

  it('a draft behind a token is 404 and never reaches the assembler or the view stamp', async () => {
    state.quote = { ...PIN_QUOTE_ROW, status: 'draft' };
    const res = await app().request(`/quotes/public/${PIN_QUOTE_TOKEN}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Quote not found', code: 'NOT_FOUND' });
    expect(assembleSpy).not.toHaveBeenCalled();
    expect(markViewedMock).not.toHaveBeenCalled();
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
