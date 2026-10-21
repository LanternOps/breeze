/**
 * #9418 W2a characterization pin for the logged-in portal's GET /portal/quotes/:id.
 * The DB is a table-keyed stand-in (`__tests__/helpers/tableKeyedDb.ts`), so the
 * pin survives changes to which queries run and in what order. Today the route
 * spreads the raw quote row (D19); this file records exactly what it sends, so
 * the refactor can prove it removes only the listed raw keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { state } = vi.hoisted(() => ({
  state: {
    db: null as null | import('../../__tests__/helpers/tableKeyedDb').TableKeyedDb,
    quote: undefined as undefined | Record<string, unknown>,
    successor: null as null | Record<string, unknown>,
  },
}));
vi.mock('../../db', async () => {
  const { createTableKeyedDb } = await import('../../__tests__/helpers/tableKeyedDb');
  const { pinQuoteRowsByTable } = await import('../__fixtures__/customerQuotePin');
  state.db = createTableKeyedDb(() =>
    pinQuoteRowsByTable(state.db!.reads.filter((t) => t === 'quotes').length, { quote: state.quote, successor: state.successor }));
  return {
    db: state.db.db,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
const { markViewedMock } = vi.hoisted(() => ({ markViewedMock: vi.fn() }));
vi.mock('../../services/quoteLifecycle', () => ({ markQuoteViewed: markViewedMock, declineQuoteByActor: vi.fn() }));
vi.mock('../../services/quoteOutcomeNotify', () => ({ notifyQuoteOutcome: vi.fn() }));

import { quoteRoutes } from './quotes';
import { PIN_QUOTE_ID, PIN_QUOTE_ORG_ID, PIN_QUOTE_ROW } from '../__fixtures__/customerQuotePin';
import PORTAL_PIN from '../__fixtures__/customerQuotePin.portal.json';

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId: PIN_QUOTE_ORG_ID, email: 'c@example.test', name: 'Customer', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer', timezone: 'UTC',
    });
    await next();
  });
  a.route('/portal', quoteRoutes);
  return a;
}

beforeEach(() => {
  markViewedMock.mockReset();
  state.quote = undefined;
  state.successor = null;
  state.db!.reads.length = 0;
  state.db!.selects.length = 0;
});

// Recorded at origin/main 9e0add3cef before the quote assembler existed (the raw
// row spread, D19). Task 5 may only remove the listed raw keys and add the
// declared ones. The JSON file is frozen.
const PIN = PORTAL_PIN;

describe('GET /portal/quotes/:id — characterization pin (#9418)', () => {
  it("today's payload", async () => {
    const res = await app().request(`/portal/quotes/${PIN_QUOTE_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PIN);
  });

  it('today: a superseded quote is served with its successor id', async () => {
    state.quote = { ...PIN_QUOTE_ROW, status: 'superseded' };
    state.successor = { ...PIN_QUOTE_ROW, id: '11111111-1111-4111-8111-999999999999', status: 'sent' };
    const res = await app().request(`/portal/quotes/${PIN_QUOTE_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.quote).toMatchObject({ status: 'superseded', supersededByQuoteId: '11111111-1111-4111-8111-999999999999' });
  });
});
