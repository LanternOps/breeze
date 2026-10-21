/**
 * #9418 W2a — GET /quotes/:id/customer-view, the staff Preview's read of the
 * customer quote document. Mounted through the real quotes router (so no
 * sibling route can shadow it), with the real quote service, assembler and
 * requireScope; the DB is the table-keyed stand-in, whose writes throw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

type Actor = { scope: 'partner' | 'organization' | 'system'; accessibleOrgIds: string[] | null; allowedSiteIds?: string[]; perms: string[] };
const { state } = vi.hoisted(() => ({
  state: {
    actor: null as null | Actor,
    quote: undefined as undefined | Record<string, unknown>,
    quotesTable: null as null | readonly Record<string, unknown>[],
    db: null as null | import('../../__tests__/helpers/tableKeyedDb').TableKeyedDb,
  },
}));
vi.mock('../../db', async () => {
  const { createTableKeyedDb } = await import('../../__tests__/helpers/tableKeyedDb');
  const { pinQuoteRowsByTable } = await import('../__fixtures__/customerQuotePin');
  state.db = createTableKeyedDb(() => ({
    ...pinQuoteRowsByTable(state.db!.reads.filter((t) => t === 'quotes').length, { quote: state.quote }),
    ...(state.quotesTable ? { quotes: state.quotesTable } : {}),
  }));
  return {
    db: state.db.db,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('../../middleware/auth', async (importActual) => {
  const actual = await importActual<typeof import('../../middleware/auth')>();
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    // Inject the test's actor exactly where the real authMiddleware puts it.
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      const a = state.actor!;
      c.set('auth', {
        user: { id: '77777777-7777-4777-8777-777777777777' }, scope: a.scope,
        partnerId: a.scope === 'partner' ? '33333333-3333-4333-8333-333333333333' : null, orgId: null,
        accessibleOrgIds: a.accessibleOrgIds, allowedSiteIds: a.allowedSiteIds, perms: a.perms,
      });
      await next();
    },
    // requireScope stays REAL. requirePermission keeps its contract (403 when the
    // caller lacks resource:action) without the DB-backed permission resolver.
    requirePermission: (resource: string, action: string) =>
      async (c: { get: (k: string) => { perms: string[] } }, next: () => Promise<void>) => {
        if (!c.get('auth').perms.includes(`${resource}:${action}`)) throw new HTTPException(403, { message: 'Permission denied' });
        await next();
      },
  };
});
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
const { markViewedMock } = vi.hoisted(() => ({ markViewedMock: vi.fn() }));
vi.mock('../../services/quoteLifecycle', async (importActual) => ({
  ...(await importActual<typeof import('../../services/quoteLifecycle')>()),
  markQuoteViewed: markViewedMock,
}));
const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('../../services/quoteService', async (importActual) => {
  const actual = await importActual<typeof import('../../services/quoteService')>();
  return {
    ...actual,
    refreshDraftQuoteTaxRate: (...args: Parameters<typeof actual.refreshDraftQuoteTaxRate>) => {
      refreshSpy(...args);
      return actual.refreshDraftQuoteTaxRate(...args);
    },
  };
});

const { auditSpy, billingAuditSpy, mintTokenSpy } = vi.hoisted(() => ({
  auditSpy: vi.fn(), billingAuditSpy: vi.fn(), mintTokenSpy: vi.fn(),
}));
vi.mock('../../services/auditEvents', async (importActual) => ({
  ...(await importActual<typeof import('../../services/auditEvents')>()),
  writeRouteAudit: auditSpy,
}));
vi.mock('../../services/billingDocumentAudit', async (importActual) => ({
  ...(await importActual<typeof import('../../services/billingDocumentAudit')>()),
  auditBillingDocument: billingAuditSpy,
}));
vi.mock('../../services/quoteAcceptToken', async (importActual) => ({
  ...(await importActual<typeof import('../../services/quoteAcceptToken')>()),
  createQuoteAcceptToken: mintTokenSpy,
  regenerateQuoteAcceptToken: mintTokenSpy,
}));

import { quoteRoutes } from './index';
import { quoteRoutes as portalQuoteRoutes } from '../portal/quotes';
import { MCP_COVERAGE } from '../../services/mcpCoverage';
import {
  PIN_QUOTE_ID, PIN_QUOTE_ORG_ID, PIN_QUOTE_SITE_ID, PIN_QUOTE_ROW, PIN_QUOTE_LINE_IDS,
} from '../__fixtures__/customerQuotePin';

const READ = ['quotes:read'];
const ACTORS = {
  partner: { scope: 'partner', accessibleOrgIds: [PIN_QUOTE_ORG_ID], perms: READ },
  siteRestricted: { scope: 'partner', accessibleOrgIds: [PIN_QUOTE_ORG_ID], allowedSiteIds: ['88888888-8888-4888-8888-888888888888'], perms: READ },
  siteAllowed: { scope: 'partner', accessibleOrgIds: [PIN_QUOTE_ORG_ID], allowedSiteIds: [PIN_QUOTE_SITE_ID], perms: READ },
  foreignOrg: { scope: 'partner', accessibleOrgIds: ['99999999-9999-4999-8999-999999999999'], perms: READ },
  noReadPerm: { scope: 'partner', accessibleOrgIds: [PIN_QUOTE_ORG_ID], perms: [] },
  orgScoped: { scope: 'organization', accessibleOrgIds: [PIN_QUOTE_ORG_ID], perms: READ },
} satisfies Record<string, Actor>;

/** CustomerQuoteHeaderDto, listed literally: a new header key is a visibility decision. */
const HEADER_DTO_KEYS = [
  'annualRecurringTotal', 'billToName', 'categoryBreakdown', 'coverPage', 'currencyCode', 'depositAmount',
  'depositDueTotal', 'depositType', 'displayStatus', 'dueOnAcceptanceTotal', 'expiryDate', 'id', 'introNotes',
  'issueDate', 'monthlyRecurringTotal', 'oneTimeTotal', 'quoteNumber', 'sellerSnapshot', 'status', 'subtotal',
  'taxRate', 'taxTotal', 'terms', 'termsAndConditions', 'title', 'total',
];
/** CustomerQuoteLineDto — the CUSTOMER_LINE_FIELDS allowlist minus the image ids, plus imageUrl. */
const LINE_DTO_KEYS = [
  'billingFrequency', 'blockId', 'contractLineType', 'createdAt', 'customerVisible', 'depositEligible', 'description',
  'deviceGroupName', 'deviceRoles', 'id', 'imageUrl', 'includedQuantity', 'itemType', 'lineTotal', 'name',
  'orgId', 'overageMode', 'overageUnitPrice', 'parentLineId', 'partNumber', 'quantity', 'quoteId', 'recurrence',
  'siteName', 'sku', 'sortOrder', 'sourceType', 'taxable', 'termMonths', 'unitPrice',
];
const BRANDING_KEYS = ['logoUrl', 'pageSize', 'partnerName', 'primaryColor', 'secondaryColor', 'supportEmail', 'supportPhone', 'theme'];

const staffApp = () => { const a = new Hono(); a.route('/quotes', quoteRoutes); return a; };
const get = (path: string, actor: Actor) => {
  state.actor = actor;
  state.db!.reads.length = 0;
  return staffApp().request(path);
};
function portalGet(path: string) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId: PIN_QUOTE_ORG_ID, email: 'c@example.test', name: 'Customer', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer', timezone: 'UTC',
    });
    await next();
  });
  a.route('/portal', portalQuoteRoutes);
  state.db!.reads.length = 0;
  return a.request(path);
}
const VIEW = `/quotes/${PIN_QUOTE_ID}/customer-view`;
const DETAIL = `/quotes/${PIN_QUOTE_ID}`;

beforeEach(() => {
  markViewedMock.mockReset();
  refreshSpy.mockReset();
  auditSpy.mockReset();
  billingAuditSpy.mockReset();
  mintTokenSpy.mockReset();
  state.quote = undefined;
  state.quotesTable = null;
  state.db!.reads.length = 0;
  state.db!.selects.length = 0;
});

describe('GET /quotes/:id/customer-view', () => {
  it('serves an issued quote as { data: CustomerQuoteDocument }', async () => {
    const res = await get(VIEW, ACTORS.partner);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['data']);
    // Staff mode keeps the raw status; the pill is the customer's.
    expect(body.data.quote).toMatchObject({ id: PIN_QUOTE_ID, status: 'sent', displayStatus: 'viewed' });
    expect(body.data.lines.map((l: { id: string }) => l.id)).toEqual([PIN_QUOTE_LINE_IDS.firewall, PIN_QUOTE_LINE_IDS.monitoring]);
  });

  it('serves a draft (displayStatus null) and never refreshes its tax rate', async () => {
    state.quote = { ...PIN_QUOTE_ROW, status: 'draft', quoteNumber: null, sellerSnapshot: null, presentationSnapshot: null, documentLocale: null };
    const res = await get(VIEW, ACTORS.partner);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.quote).toMatchObject({ status: 'draft', displayStatus: null, quoteNumber: null, taxRate: PIN_QUOTE_ROW.taxRate });
    expect(refreshSpy).not.toHaveBeenCalled();
    // The seller sending will freeze (from the partner).
    expect(body.data.quote.sellerSnapshot).toMatchObject({ name: 'Example MSP LLC' });
  });

  it('serves a superseded quote (Review Focus 1, staff mode)', async () => {
    state.quote = { ...PIN_QUOTE_ROW, status: 'superseded' };
    const body = await (await get(VIEW, ACTORS.partner)).json();
    expect(body.data.quote).toMatchObject({ status: 'superseded', displayStatus: 'superseded' });
    expect(body.data.lines).toHaveLength(2);
  });

  it('never stamps the view and writes nothing', async () => {
    const res = await get(VIEW, ACTORS.partner);
    expect(res.status).toBe(200);
    expect(markViewedMock).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();         // no audit row: it reads what the caller can read
    expect(billingAuditSpy).not.toHaveBeenCalled();
    expect(mintTokenSpy).not.toHaveBeenCalled();     // no accept token minted
    // The table-keyed db throws on any write, and the route answered 200.
    expect(state.db!.reads.every((t) => ['quotes', 'quote_blocks', 'quote_lines', 'partners', 'portal_branding'].includes(t))).toBe(true);
  });

  it('returns exactly the allowlisted keys (no token, no internal field)', async () => {
    const body = await (await get(VIEW, ACTORS.partner)).json();
    expect(Object.keys(body.data).sort()).toEqual(['blocks', 'branding', 'documentLocale', 'lines', 'quote']);
    expect(Object.keys(body.data.quote).sort()).toEqual(HEADER_DTO_KEYS);
    for (const l of body.data.lines) expect(Object.keys(l).sort()).toEqual(LINE_DTO_KEYS);
    expect(Object.keys(body.data.branding).sort()).toEqual(BRANDING_KEYS);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/INTERNAL-/);           // accept-token jti/kid, send job, pdf ref, decline reason, procurement…
    expect(text).not.toContain('acceptToken');
    expect(text).not.toContain('unitCost');
    // Hidden-line ABSENCE is not provable here (the mocked quote_lines table only
    // holds visible rows; the filter is SQL). customerDocument.quote.test.ts pins
    // the WHERE clause and customerDocument.quote.integration.test.ts proves it on Postgres.
  });

  it('asset paths are the staff routes (authed quote image, catalog image)', async () => {
    const body = await (await get(VIEW, ACTORS.partner)).json();
    expect(body.data.lines.map((l: { imageUrl: string | null }) => l.imageUrl)).toEqual([
      `/quotes/${PIN_QUOTE_ID}/images/99999999-0000-4000-8000-000000000002`,
      '/catalog/99999999-0000-4000-8000-000000000003/image',
    ]);
  });

  it.each([
    ['a site-restricted caller outside the quote site', ACTORS.siteRestricted, 403],
    ['a caller whose accessible orgs exclude the quote org', ACTORS.foreignOrg, 403],
    ['a caller without quotes:read', ACTORS.noReadPerm, 403],
    ['an organization-scoped token', ACTORS.orgScoped, 403],
  ] as const)('%s is rejected exactly as GET /quotes/:id rejects it', async (_n, actor, status) => {
    const view = await get(VIEW, actor);
    expect(refreshSpy).not.toHaveBeenCalled(); // the customer view never takes the detail route's refresh path
    const detail = await get(DETAIL, actor);
    expect(detail.status).toBe(status); // guards against a mis-built actor making both 200
    expect(view.status).toBe(status);
    expect(await view.text()).toBe(await detail.text());
  });

  it('a site miss carries SITE_DENIED; a foreign org carries ORG_DENIED (same as the detail route)', async () => {
    expect((await (await get(VIEW, ACTORS.siteRestricted)).json()).code).toBe('SITE_DENIED');
    expect((await (await get(DETAIL, ACTORS.siteRestricted)).json()).code).toBe('SITE_DENIED');
    expect((await (await get(VIEW, ACTORS.foreignOrg)).json()).code).toBe('ORG_DENIED');
    expect((await (await get(DETAIL, ACTORS.foreignOrg)).json()).code).toBe('ORG_DENIED');
  });

  it('a rejected caller reads only the quotes table', async () => {
    await get(VIEW, ACTORS.siteRestricted);
    expect(state.db!.reads).toEqual(['quotes']);
  });

  it('a caller whose site allowlist includes the quote site is served', async () => {
    expect((await get(VIEW, ACTORS.siteAllowed)).status).toBe(200);
  });

  it('a missing quote is the same 404 as the detail route', async () => {
    state.quotesTable = [];
    const detail = await get(DETAIL, ACTORS.partner);
    const view = await get(VIEW, ACTORS.partner);
    expect(detail.status).toBe(404);
    expect(view.status).toBe(404);
    expect(await view.json()).toEqual(await detail.json());
  });

  it('a non-uuid id fails validation like the detail route', async () => {
    const view = await get('/quotes/not-a-uuid/customer-view', ACTORS.partner);
    const detail = await get('/quotes/not-a-uuid', ACTORS.partner);
    expect(view.status).toBe(400);
    expect(view.status).toBe(detail.status);
  });

  it("an issued quote equals the portal route's document fields (spec §8.1)", async () => {
    const portalRes = await portalGet(`/portal/quotes/${PIN_QUOTE_ID}`);
    expect(portalRes.status).toBe(200);
    const { quote, blocks, lines, branding, documentLocale } = (await portalRes.json()).data;
    const { supersededByQuoteId: _s, acceptanceOrigin: _a, acceptedAt: _t, ...portalHeader } = quote;
    const body = await (await get(VIEW, ACTORS.partner)).json();
    // Host asset paths differ by design (portal vs staff routes); compare their presence.
    const pathless = (ls: { imageUrl: string | null }[]) => ls.map((l) => ({ ...l, imageUrl: l.imageUrl != null }));
    // Raw status and displayStatus are equal in both modes.
    expect({ ...body.data, lines: pathless(body.data.lines) }).toEqual({
      quote: portalHeader, blocks, lines: pathless(lines), branding, documentLocale,
    });
  });

  it('lives in a route file mcpCoverage already covers (keyed by file; no entry change)', () => {
    expect(MCP_COVERAGE['quotes/quotes.ts']).toBeDefined();
  });
});
