/**
 * #9402 W1b — GET /invoices/:id/customer-view, the staff Preview's read of the
 * customer document. Mounted through the real invoices router (so no sibling
 * route can shadow it), with the real invoice service, assembler and
 * requireScope; the DB is the table-keyed stand-in, whose writes throw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

type Actor = { scope: 'partner' | 'organization' | 'system'; accessibleOrgIds: string[] | null; allowedSiteIds?: string[]; perms: string[] };
const { state } = vi.hoisted(() => ({
  state: {
    rows: {} as Record<string, readonly Record<string, unknown>[] | Error>,
    actor: null as null | Actor,
    db: null as null | import('../../__tests__/helpers/tableKeyedDb').TableKeyedDb,
  },
}));
vi.mock('../../db', async () => {
  const { createTableKeyedDb } = await import('../../__tests__/helpers/tableKeyedDb');
  state.db = createTableKeyedDb(() => state.rows);
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
vi.mock('../../services/invoiceService', async (importActual) => ({
  ...(await importActual<typeof import('../../services/invoiceService')>()),
  markViewed: markViewedMock,
}));
vi.mock('../../services/partnerStripe', async (importActual) => ({
  ...(await importActual<typeof import('../../services/partnerStripe')>()),
  isPartnerOnlinePaymentAvailable: vi.fn(async () => true),
}));
vi.mock('../../services/autopay/customerInvoiceStatus', () => ({ getCustomerInvoiceAutopay: vi.fn(async () => ({ enrolled: false, status: null })) }));
vi.mock('../../services/autopay/reservation', async (importActual) => ({
  ...(await importActual<typeof import('../../services/autopay/reservation')>()),
  readInFlightCollection: vi.fn(async () => ({ inProgress: false, amount: '0.00' })),
}));
vi.mock('../../services/autopay/payAndSave', async (importActual) => ({
  ...(await importActual<typeof import('../../services/autopay/payAndSave')>()),
  getInvoiceAutopayOffer: vi.fn(async () => null),
}));
vi.mock('../../services/autopay/bankPayment', async (importActual) => ({
  ...(await importActual<typeof import('../../services/autopay/bankPayment')>()),
  getBankAutopayOffer: vi.fn(async () => null),
}));

import { invoiceRoutes } from './index';
import { invoiceRoutes as portalInvoiceRoutes } from '../portal/invoices';
import { MCP_COVERAGE } from '../../services/mcpCoverage';
import {
  PIN_INVOICE_ID, PIN_INVOICE_ROW, PIN_ORG_ID, PIN_SITE_ID, PIN_PUBLIC_TOKEN, PIN_LINE_IDS,
  PIN_PARTNER_ROW, PIN_BRANDING_ROW, PIN_VISIBLE_LINE_ROWS,
} from '../__fixtures__/customerInvoicePin';

const READ = ['invoices:read'];
const ACTORS = {
  partner: { scope: 'partner', accessibleOrgIds: [PIN_ORG_ID], perms: READ },
  siteRestricted: { scope: 'partner', accessibleOrgIds: [PIN_ORG_ID], allowedSiteIds: ['88888888-8888-4888-8888-888888888888'], perms: READ },
  siteAllowed: { scope: 'partner', accessibleOrgIds: [PIN_ORG_ID], allowedSiteIds: [PIN_SITE_ID], perms: READ },
  foreignOrg: { scope: 'partner', accessibleOrgIds: ['99999999-9999-4999-8999-999999999999'], perms: READ },
  noReadPerm: { scope: 'partner', accessibleOrgIds: [PIN_ORG_ID], perms: [] },
  orgScoped: { scope: 'organization', accessibleOrgIds: [PIN_ORG_ID], perms: READ },
} satisfies Record<string, Actor>;

/** CustomerInvoiceHeaderDto, listed literally: a new header key is a visibility decision. */
const HEADER_DTO_KEYS = [
  'amountPaid', 'balance', 'billToAddress', 'billToName', 'billToTaxId', 'currencyCode', 'depositDue', 'displayStatus',
  'dueDate', 'id', 'invoiceNumber', 'issueDate', 'lineGrouping', 'notes', 'sellerSnapshot', 'status', 'subtotal',
  'taxRate', 'taxTotal', 'terms', 'termsAndConditions', 'total',
];
const LINE_DTO_KEYS = [
  'description', 'id', 'lineTotal', 'name', 'quantity', 'taxable', 'ticketCategory', 'ticketNumber',
  'unitPrice', 'workDate', 'workedMinutes',
];
const TECH_NOTE = 'Diagnosed the print spooler';

const staffApp = () => { const a = new Hono(); a.route('/invoices', invoiceRoutes); return a; };
const get = (path: string, actor: Actor) => { state.actor = actor; return staffApp().request(path); };
function portalGet(path: string) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId: PIN_ORG_ID, email: 'c@example.test', name: 'Customer', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer', timezone: 'UTC',
    });
    await next();
  });
  a.route('/portal', portalInvoiceRoutes);
  return a.request(path);
}
const VIEW = `/invoices/${PIN_INVOICE_ID}/customer-view`;
const DETAIL = `/invoices/${PIN_INVOICE_ID}`;

function setRows(invoicePatch: Record<string, unknown> = {}) {
  state.rows = {
    invoices: [{ ...PIN_INVOICE_ROW, ...invoicePatch }],
    invoice_lines: PIN_VISIBLE_LINE_ROWS,
    partners: [PIN_PARTNER_ROW],
    portal_branding: [PIN_BRANDING_ROW],
  };
}

beforeEach(() => {
  markViewedMock.mockReset();
  state.db!.reads.length = 0;
  state.db!.selects.length = 0;
  setRows();
});

describe('GET /invoices/:id/customer-view', () => {
  it('serves an issued invoice as { data: CustomerInvoiceDocument }', async () => {
    const res = await get(VIEW, ACTORS.partner);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.invoice).toMatchObject({ id: PIN_INVOICE_ID, status: 'sent', displayStatus: 'sent' });
    expect(body.data.lines.map((l: { id: string }) => l.id)).toEqual([PIN_LINE_IDS.part, PIN_LINE_IDS.timeEntry]);
  });

  it('serves a draft (displayStatus null)', async () => {
    setRows({ status: 'draft', invoiceNumber: null, lineGrouping: null, lineShowDate: null, lineShowNote: null, lineShowWorkedTime: null });
    const res = await get(VIEW, ACTORS.partner);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.invoice).toMatchObject({ status: 'draft', displayStatus: null, invoiceNumber: null });
  });

  it('serves a void invoice with its lines (Review Focus 3, staff mode)', async () => {
    setRows({ status: 'void' });
    const body = await (await get(VIEW, ACTORS.partner)).json();
    expect(body.data.invoice.displayStatus).toBe('void');
    expect(body.data.lines).toHaveLength(2);
  });

  it('never stamps the view and writes nothing', async () => {
    const res = await get(VIEW, ACTORS.partner);
    expect(res.status).toBe(200);
    expect(markViewedMock).not.toHaveBeenCalled();
    // The table-keyed db throws on any write, and the route answered 200.
    expect(state.db!.reads.every((t) => ['invoices', 'invoice_lines', 'partners', 'portal_branding'].includes(t))).toBe(true);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('viewedAt');
    expect(body).not.toContain('firstViewedAt');
  });

  it('returns exactly the allowlisted keys (no token, no internal field)', async () => {
    const res = await get(VIEW, ACTORS.partner);
    const body = await res.json();
    expect(Object.keys(body.data).sort()).toEqual(['branding', 'documentLocale', 'invoice', 'lines']);
    expect(Object.keys(body.data.invoice).sort()).toEqual(HEADER_DTO_KEYS);
    for (const l of body.data.lines) expect(Object.keys(l).sort()).toEqual(LINE_DTO_KEYS);
    expect(Object.keys(body.data.branding).sort()).toEqual(['contactEmail', 'logoUrl', 'pageSize', 'partnerName', 'primaryColor', 'theme']);
    const text = JSON.stringify(body);
    expect(text).not.toContain(PIN_PUBLIC_TOKEN);
    expect(text).not.toContain('pin-token');
    expect(text).not.toContain('INTERNAL-ONLY');
    expect(text).not.toContain('HIDDEN-LINE');
    expect(text).not.toContain(PIN_ORG_ID);
    expect(text).not.toContain(PIN_SITE_ID);
  });

  it.each([
    ['a site-restricted caller outside the invoice site', ACTORS.siteRestricted, 403],
    ['a caller whose accessible orgs exclude the invoice org', ACTORS.foreignOrg, 403],
    ['a caller without invoices:read', ACTORS.noReadPerm, 403],
    ['an organization-scoped token', ACTORS.orgScoped, 403],
  ] as const)('%s is rejected exactly as GET /invoices/:id rejects it', async (_n, actor, status) => {
    const detail = await get(DETAIL, actor);
    const view = await get(VIEW, actor);
    expect(detail.status).toBe(status); // guards against a mis-built actor making both 200
    expect(view.status).toBe(status);
    expect(await view.text()).toBe(await detail.text());
  });

  it('a site miss carries SITE_DENIED; a foreign org carries ORG_DENIED (same as the detail route)', async () => {
    const site = await (await get(VIEW, ACTORS.siteRestricted)).json();
    expect(site.code).toBe('SITE_DENIED');
    expect((await (await get(DETAIL, ACTORS.siteRestricted)).json()).code).toBe('SITE_DENIED');
    const org = await (await get(VIEW, ACTORS.foreignOrg)).json();
    expect(org.code).toBe('ORG_DENIED');
    expect((await (await get(DETAIL, ACTORS.foreignOrg)).json()).code).toBe('ORG_DENIED');
  });

  it('a rejected caller reads no lines, partner or branding rows', async () => {
    await get(VIEW, ACTORS.siteRestricted);
    expect(state.db!.reads).toEqual(['invoices']);
  });

  it('a caller whose site allowlist includes the invoice site is served', async () => {
    expect((await get(VIEW, ACTORS.siteAllowed)).status).toBe(200);
  });

  it('a missing invoice is the same 404 as the detail route', async () => {
    state.rows = { ...state.rows, invoices: [] };
    const detail = await get(DETAIL, ACTORS.partner);
    const view = await get(VIEW, ACTORS.partner);
    expect(detail.status).toBe(404);
    expect(view.status).toBe(404);
    expect(await view.json()).toEqual(await detail.json());
  });

  it('a non-uuid id fails validation like the detail route', async () => {
    const view = await get('/invoices/not-a-uuid/customer-view', ACTORS.partner);
    const detail = await get('/invoices/not-a-uuid', ACTORS.partner);
    expect(view.status).toBe(400);
    expect(view.status).toBe(detail.status);
  });

  it("an issued invoice equals the portal route's document fields (spec §8.1)", async () => {
    const portalRes = await portalGet(`/portal/invoices/${PIN_INVOICE_ID}`);
    expect(portalRes.status).toBe(200);
    const { invoice, lines, branding, documentLocale } = await portalRes.json();
    const body = await (await get(VIEW, ACTORS.partner)).json();
    // Raw status and displayStatus are equal in both modes.
    expect(body.data).toEqual({ invoice, lines, branding, documentLocale });
  });

  it('withheld note on an issued invoice never appears in the body (Review Focus 4)', async () => {
    setRows({ lineShowNote: false });
    const res = await get(VIEW, ACTORS.partner);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TECH_NOTE);
    const te = JSON.parse(text).data.lines.find((l: { id: string }) => l.id === PIN_LINE_IDS.timeEntry);
    expect(te).toMatchObject({ name: 'Labor', description: '' });
  });

  it('lives in a route file mcpCoverage already covers (keyed by file; no entry change)', () => {
    expect(MCP_COVERAGE['invoices/invoices.ts']).toBeDefined();
  });
});
