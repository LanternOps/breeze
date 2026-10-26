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
    acceptances: null as null | Record<string, unknown>[],
  },
}));
vi.mock('../../db', async () => {
  const { createTableKeyedDb } = await import('../../__tests__/helpers/tableKeyedDb');
  const { pinQuoteRowsByTable } = await import('../__fixtures__/customerQuotePin');
  state.db = createTableKeyedDb(() => ({
    ...pinQuoteRowsByTable(state.db!.reads.filter((t) => t === 'quotes').length, { quote: state.quote, successor: state.successor }),
    ...(state.acceptances ? { quote_acceptances: state.acceptances } : {}),
  }));
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

const { assembleSpy } = vi.hoisted(() => ({ assembleSpy: vi.fn() }));
vi.mock('../../services/customerQuoteDocument', async (importActual) => {
  const actual = await importActual<typeof import('../../services/customerQuoteDocument')>();
  return {
    ...actual,
    assembleCustomerQuoteDocument: (...args: Parameters<typeof actual.assembleCustomerQuoteDocument>) => {
      assembleSpy(...args);
      return actual.assembleCustomerQuoteDocument(...args);
    },
  };
});

import { quoteRoutes } from './quotes';
import { PIN_QUOTE_ID, PIN_QUOTE_ORG_ID, PIN_QUOTE_ROW } from '../__fixtures__/customerQuotePin';
import PORTAL_PIN from '../__fixtures__/customerQuotePin.portal.json';
import PUBLIC_PIN from '../__fixtures__/customerQuotePin.public.json';
import { stripAdditive } from '../../__tests__/helpers/stripAdditive';

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
  assembleSpy.mockReset();
  state.quote = undefined;
  state.successor = null;
  state.acceptances = null;
  state.db!.reads.length = 0;
  state.db!.selects.length = 0;
});

// Recorded at origin/main 9e0add3cef before the quote assembler existed (the raw
// row spread, D19). Task 5 may only remove the listed raw keys and add the
// declared ones. The JSON file is frozen.
const PIN = PORTAL_PIN;

/**
 * D19: the raw `quotes` columns the portal route stopped sending. Listed
 * literally — the PR body carries this list. Every one is a column of the
 * quote row that is not in the customer header allowlist; `acceptedAt` is
 * the one raw column the portal page reads, so the route keeps it.
 */
const D19_REMOVED_QUOTE_KEYS = [
  'partnerId', 'orgId', 'siteId', 'declinedAt', 'convertedAt', 'depositPercent', 'billToAddress', 'billToTaxId',
  'presentationSnapshot', 'documentLocale', 'declineReason', 'convertedInvoiceId', 'pdfDocumentRef', 'pdfSha256',
  'sentAt', 'sendScheduledAt', 'sendJobId', 'sendEmailReason', 'firstViewedAt', 'viewedAt',
  'acceptTokenJti', 'acceptTokenIssuedAt', 'acceptTokenExpiresAt', 'acceptTokenKid', 'publicTokenVersion',
  'publicResponseJti', 'publicResponseConsumedAt', 'publicResponseOutcome', 'publicLinkRevokedAt',
  'revisionOfQuoteId', 'revisionNumber', 'createdBy', 'createdAt', 'updatedAt',
] as const;
// The ONLY keys the refactor may add (#9418 W2a).
const PORTAL_ADDITIVE = ['data.quote.displayStatus', 'data.documentLocale'] as const;
/** The customer header allowlist + the three portal-route fields the page reads. */
const PORTAL_QUOTE_KEYS = [
  'acceptanceOrigin', 'acceptedAt', 'annualRecurringTotal', 'billToName', 'categoryBreakdown', 'coverPage',
  'currencyCode', 'depositAmount', 'depositDueTotal', 'depositType', 'displayStatus', 'dueOnAcceptanceTotal',
  'expiryDate', 'id', 'introNotes', 'issueDate', 'monthlyRecurringTotal', 'oneTimeTotal', 'quoteNumber',
  'sellerSnapshot', 'status', 'subtotal', 'supersededByQuoteId', 'taxRate', 'taxTotal', 'terms',
  'termsAndConditions', 'title', 'total',
];

/** The pin with the D19 keys removed and the two jsonb columns in their customer
 *  (allowlisted) shape — the shape the public link has always sent. */
function expectedPortalBody() {
  const body = JSON.parse(JSON.stringify(PIN)) as { data: { quote: Record<string, unknown> } };
  for (const k of D19_REMOVED_QUOTE_KEYS) {
    if (!(k in body.data.quote)) throw new Error(`D19 key ${k} is not in the pin`);
    delete body.data.quote[k];
  }
  body.data.quote.coverPage = PUBLIC_PIN.data.quote.coverPage;
  body.data.quote.sellerSnapshot = PUBLIC_PIN.data.quote.sellerSnapshot;
  return body;
}

describe('GET /portal/quotes/:id — characterization pin (#9418)', () => {
  it('the payload is the pin minus the D19 raw keys, plus only the declared additive keys', async () => {
    const res = await app().request(`/portal/quotes/${PIN_QUOTE_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(stripAdditive(body, PORTAL_ADDITIVE)).toEqual(expectedPortalBody());
    expect(Object.keys(body.data.quote).sort()).toEqual(PORTAL_QUOTE_KEYS);
    // The portal keeps the raw status; displayStatus is the public link's pill.
    expect(body.data.quote).toMatchObject({ status: 'sent', displayStatus: 'viewed' });
    expect(body.data.documentLocale).toBe('en');
    expect(JSON.stringify(body)).not.toMatch(/INTERNAL-/);
    expect(assembleSpy).toHaveBeenCalledTimes(1);
    expect(assembleSpy.mock.calls[0]![1]).toBe('portal');
    expect(markViewedMock).toHaveBeenCalledTimes(1);
  });

  it('the document fields equal the public link payload except the host asset paths and the status', async () => {
    const body = await (await app().request(`/portal/quotes/${PIN_QUOTE_ID}`)).json();
    const { supersededByQuoteId: _s, acceptanceOrigin: _a, acceptedAt: _t, status, displayStatus, ...header } = body.data.quote;
    const { status: publicStatus, ...publicHeader } = PUBLIC_PIN.data.quote;
    expect(header).toEqual(publicHeader);
    expect([status, publicStatus, displayStatus]).toEqual(['sent', 'viewed', 'viewed']);
    expect(body.data.blocks).toEqual(PUBLIC_PIN.data.blocks);
    const pathless = (ls: { imageUrl: string | null }[]) => ls.map((l) => ({ ...l, imageUrl: l.imageUrl != null }));
    expect(pathless(body.data.lines)).toEqual(pathless(PUBLIC_PIN.data.lines));
    expect(body.data.lines[0].imageUrl).toBe(`/portal/quotes/${PIN_QUOTE_ID}/line-image/${body.data.lines[0].id}`);
    expect(body.data.branding).toEqual(PUBLIC_PIN.data.branding);
    expect(body.data.presentation).toEqual(PUBLIC_PIN.data.presentation);
  });

  it('a superseded quote is still served (the "Replaced" notice), with its successor id', async () => {
    state.quote = { ...PIN_QUOTE_ROW, status: 'superseded' };
    state.successor = { ...PIN_QUOTE_ROW, id: '11111111-1111-4111-8111-999999999999', status: 'sent' };
    const res = await app().request(`/portal/quotes/${PIN_QUOTE_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.quote).toMatchObject({
      status: 'superseded', displayStatus: 'superseded', supersededByQuoteId: '11111111-1111-4111-8111-999999999999',
    });
    expect(body.data.lines).toHaveLength(2);
  });

  it('an accepted quote carries acceptedAt and the acceptance origin only', async () => {
    state.quote = { ...PIN_QUOTE_ROW, status: 'converted', acceptedAt: new Date('2026-03-04T10:00:00.000Z') };
    state.acceptances = [{ origin: 'on_behalf' }];
    const body = await (await app().request(`/portal/quotes/${PIN_QUOTE_ID}`)).json();
    expect(body.data.quote).toMatchObject({ acceptedAt: '2026-03-04T10:00:00.000Z', acceptanceOrigin: 'on_behalf', displayStatus: 'converted' });
  });

  it('a draft is 404 and never reaches the assembler', async () => {
    state.quote = { ...PIN_QUOTE_ROW, status: 'draft' };
    const res = await app().request(`/portal/quotes/${PIN_QUOTE_ID}`);
    expect(res.status).toBe(404);
    expect(assembleSpy).not.toHaveBeenCalled();
    expect(markViewedMock).not.toHaveBeenCalled();
  });
});
