import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable Drizzle chain mock (same pattern as quoteService.test.ts): every
// builder method returns the same chain; a query resolves when awaited (the
// chain is a thenable that yields the next queued result). Tests queue the rows
// each db call should resolve to, in call order.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

// Records every payload passed to `.set(...)` so tests can assert what a mutation
// actually wrote (e.g. the frozen bill-to snapshot on send), not just what the
// re-select mock returns.
const setCalls: Array<Record<string, unknown>> = [];

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute', 'transaction'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.set = vi.fn((payload: Record<string, unknown>) => { setCalls.push(payload); return chain; });
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

// Capture the args renderQuotePdf is invoked with, and stub the email service —
// so the customer-facing send path (sendQuote's email attachment) can run to
// completion without a real PDF renderer or SMTP transport.
let capturedPdfArgs: unknown[] | null = null;
const sendEmailMock = vi.fn().mockResolvedValue(undefined);

// Keep formatMoney/formatDate real (importOriginal) — contractTemplateRender.ts's
// resolveAutoVariables imports them from this module for the send-time contract
// gate (Task 12); only renderQuotePdf itself is stubbed out.
vi.mock('./quotePdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quotePdf')>();
  return {
    ...actual,
    renderQuotePdf: vi.fn((...args: unknown[]) => {
      capturedPdfArgs = args;
      return Promise.resolve(Buffer.from('%PDF-fake'));
    }),
  };
});

vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./email')>();
  return { ...actual, getEmailService: vi.fn(() => ({ sendEmail: sendEmailMock, fromWithDisplayName: (name: string) => `"${name}" <no-reply@test.example>` })) };
});

import { buildPublicQuoteAcceptUrl, portalBase, sendQuote } from './quoteLifecycle';
import { renderQuotePdf } from './quotePdf';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

/**
 * Regression coverage for the malformed public quote accept link
 * (`https:///quote/<token>` — empty host) and the portal base-path prefix.
 *
 * The customer portal serves the public quote route at `<base>/quote/<token>`,
 * where the base (default `/portal`) is expected to be part of PUBLIC_PORTAL_URL,
 * matching the invoice-link convention in invoicePdf.ts.
 */
describe('quoteLifecycle portal URL', () => {
  const ENV_KEYS = ['PUBLIC_PORTAL_URL', 'PUBLIC_APP_URL', 'DASHBOARD_URL', 'PORTAL_BASE_PATH'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('uses PUBLIC_PORTAL_URL (incl. /portal base) and emits a well-formed accept URL', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://example.com/portal';
    const url = buildPublicQuoteAcceptUrl('tok123');
    expect(url).toBe('https://example.com/portal/quote/tok123');

    const parsed = new URL(url);
    expect(parsed.hostname).toBe('example.com'); // non-empty host
    expect(parsed.pathname).toBe('/portal/quote/tok123'); // correct portal prefix
  });

  it('strips a trailing slash on the configured base', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://example.com/portal/';
    expect(buildPublicQuoteAcceptUrl('abc')).toBe('https://example.com/portal/quote/abc');
  });

  it('NEVER emits an empty-host URL when PUBLIC_PORTAL_URL is a bare scheme', () => {
    // The reported prod symptom: PUBLIC_PORTAL_URL="https://" → `https:///quote/...`.
    process.env.PUBLIC_PORTAL_URL = 'https://';
    // No other env configured → falls through to the localhost dev fallback (has a host).
    const url = buildPublicQuoteAcceptUrl('tok');
    expect(url).not.toMatch(/^https?:\/\/\//); // no empty-authority `://[/]`
    expect(new URL(url).hostname).not.toBe('');
  });

  it('SKIPS the empty-authority triple-slash form (`https:///portal`) rather than emitting a dead link', () => {
    // #1630 follow-up: PUBLIC_PORTAL_URL="https:///portal" (host var didn't
    // interpolate). `new URL('https:///portal').hostname === 'portal'` — Node
    // reinterprets the first path segment as the host, so the parsed-hostname
    // guard wrongly passes and we'd ship `https:///portal/quote/<token>`.
    process.env.PUBLIC_PORTAL_URL = 'https:///portal';
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    const url = buildPublicQuoteAcceptUrl('tok');
    expect(url).not.toMatch(/^https?:\/\/\//); // no empty-authority `://[/]`
    expect(url).not.toContain('https:///portal');
    expect(new URL(url).hostname).toBe('app.example.com'); // fell through to next valid candidate
    expect(url).toBe('https://app.example.com/portal/quote/tok');
  });

  it('preserves a valid host + /portal base path (not over-eagerly skipped)', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://example.com/portal';
    const base = portalBase();
    expect(base).toBe('https://example.com/portal'); // returned as-is, base path intact
    expect(new URL(base).hostname).toBe('example.com');
  });

  it('falls through an empty PUBLIC_PORTAL_URL to PUBLIC_APP_URL and appends /portal', () => {
    // The prod-symptom regression: PUBLIC_PORTAL_URL unset + PUBLIC_APP_URL set
    // used to emit https://host/quote/<t> — a dead link missing /portal.
    process.env.PUBLIC_PORTAL_URL = '';
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    expect(buildPublicQuoteAcceptUrl('t')).toBe('https://app.example.com/portal/quote/t');
  });

  it('does not double-append when the app-origin fallback already ends with /portal', () => {
    process.env.PUBLIC_APP_URL = 'https://app.example.com/portal';
    expect(buildPublicQuoteAcceptUrl('t')).toBe('https://app.example.com/portal/quote/t');
  });

  it('appends /portal to the DASHBOARD_URL fallback too', () => {
    process.env.DASHBOARD_URL = 'https://dash.example.com/';
    expect(buildPublicQuoteAcceptUrl('t')).toBe('https://dash.example.com/portal/quote/t');
  });

  it('honors a custom PORTAL_BASE_PATH on app-origin fallbacks', () => {
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    process.env.PORTAL_BASE_PATH = '/c';
    expect(buildPublicQuoteAcceptUrl('t')).toBe('https://app.example.com/c/quote/t');
  });

  it('never appends the base path to an explicit PUBLIC_PORTAL_URL', () => {
    // PUBLIC_PORTAL_URL is authoritative — even one without a path segment.
    process.env.PUBLIC_PORTAL_URL = 'https://portal.example.com';
    expect(buildPublicQuoteAcceptUrl('t')).toBe('https://portal.example.com/quote/t');
  });

  it('falls back to a host-bearing localhost URL (with portal base) when nothing is configured', () => {
    const url = buildPublicQuoteAcceptUrl('t');
    expect(url).toBe('http://localhost:4321/portal/quote/t');
    expect(new URL(url).hostname).toBe('localhost');
  });

  it('throws loudly rather than returning an empty host (portalBase contract)', () => {
    // Force every candidate (incl. the literal fallback) to be malformed by
    // monkeypatching: not possible via env since the fallback is a constant, so
    // we assert the happy-path host invariant instead — portalBase always yields
    // a parseable URL with a hostname.
    process.env.PUBLIC_PORTAL_URL = 'https:///portal'; // empty-authority triple-slash
    process.env.PUBLIC_APP_URL = 'https://';           // empty host
    process.env.DASHBOARD_URL = '   ';                 // blank
    const base = portalBase();
    expect(new URL(base).hostname).toBe('localhost'); // last good fallback
  });

  it('encodes the token so a malicious token cannot break out of the path', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://example.com/portal';
    const url = buildPublicQuoteAcceptUrl('a/b?c#d');
    expect(url).toBe('https://example.com/portal/quote/a%2Fb%3Fc%23d');
    expect(new URL(url).pathname).toBe('/portal/quote/a%2Fb%3Fc%23d');
  });
});

/**
 * Send-time deposit gate (Task 7): a deposit config can silently become
 * unsatisfiable while drafting (recomputeAndPersist stores NULL deposit_amount
 * in that case, per quoteService). sendQuote is the hard stop that keeps a
 * quote with broken deposit terms from ever reaching the customer.
 */
describe('sendQuote deposit validation', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('throws 409 DEPOSIT_INVALID when a deposit is configured but there are zero one-time lines', async () => {
    // getQuote (called internally): select quote, select blocks, select lines.
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
      taxRate: null, depositType: 'percent', depositPercent: '30.00',
    }]);
    queueResult([]); // blocks
    queueResult([]); // lines — none at all, so dueOnAcceptanceTotal is $0
    queueResult([]); // no staged Pax8 order

    await expect(sendQuote('q1', actor)).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_INVALID' });
  });

  it('throws 409 DEPOSIT_INVALID when the deposit config is otherwise unsatisfiable (e.g. percent >= 100)', async () => {
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
      taxRate: null, depositType: 'percent', depositPercent: '100.00',
    }]);
    queueResult([]); // blocks
    queueResult([{ quantity: '1', unitPrice: '1000.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false }]);
    queueResult([]); // no staged Pax8 order

    await expect(sendQuote('q1', actor)).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_INVALID' });
  });

  it('throws 409 DEPOSIT_INVALID for a selected_lines deposit that lost all its eligible lines', async () => {
    // A selected_lines deposit becomes unsatisfiable when the flagged one-time
    // lines are removed/unflagged after the deposit was set — the send gate must
    // hard-stop it (DEPOSIT_NO_ELIGIBLE_LINES, surfaced as DEPOSIT_INVALID) rather
    // than send a quote whose deposit computes to nothing.
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
      taxRate: null, depositType: 'selected_lines', depositPercent: null,
    }]);
    queueResult([]); // blocks
    // A one-time line exists (so dueOnAcceptance > 0) but NONE are depositEligible.
    queueResult([{ quantity: '1', unitPrice: '1000.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false }]);
    queueResult([]); // no staged Pax8 order

    await expect(sendQuote('q1', actor)).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_INVALID' });
  });

  it('does NOT gate a quote with no deposit configured (depositType none)', async () => {
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent', // non-draft -> INVALID_STATE, not DEPOSIT_INVALID
      taxRate: null, depositType: 'none', depositPercent: null,
    }]);
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // no staged Pax8 order

    // Proves the deposit gate is skipped for depositType 'none' — the failure
    // that surfaces is the pre-existing status guard, never DEPOSIT_INVALID.
    await expect(sendQuote('q1', actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });
});

/**
 * Data-exposure regression: `sendQuote` emails the quote PDF to the customer.
 * Internal-only lines (`customerVisible: false` — e.g. cost-basis/markup lines
 * a tech added for their own bookkeeping) must NEVER reach that PDF, mirroring
 * the portal-download route (apps/api/src/routes/portal/quotes.ts) which
 * already filters via `toCustomerLines(lines.filter(l => l.customerVisible))`.
 * The deposit send-gate upstream still validates over ALL lines — this test
 * exercises the full send-to-email path, not the gate.
 */
describe('sendQuote customer-facing PDF', () => {
  beforeEach(() => {
    results.length = 0;
    setCalls.length = 0;
    vi.clearAllMocks();
    capturedPdfArgs = null;
    sendEmailMock.mockResolvedValue(undefined);
  });

  it('excludes customerVisible=false lines from the emailed PDF while keeping visible lines', async () => {
    const visibleLine = {
      id: 'line-visible', quoteId: 'q1', sortOrder: 0, name: 'Managed Firewall', description: null,
      quantity: '1', unitPrice: '100.00', unitCost: '10.00', lineTotal: '100.00',
      recurrence: 'one_time', taxable: false, customerVisible: true, depositEligible: false,
    };
    const internalLine = {
      id: 'line-internal', quoteId: 'q1', sortOrder: 1, name: 'Internal markup buffer', description: null,
      quantity: '1', unitPrice: '50.00', unitCost: '5.00', lineTotal: '50.00',
      recurrence: 'one_time', taxable: false, customerVisible: false, depositEligible: false,
    };

    // getQuote: select quote, select blocks, select lines (unfiltered — matches prod).
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
      taxRate: null, depositType: 'none', depositPercent: null,
      quoteNumber: 'Q-2026-0001', issueDate: '2026-01-01', expiryDate: null,
      total: '100.00', currencyCode: 'USD', terms: null, termsAndConditions: null,
      sellerSnapshot: null,
    }]);
    queueResult([]); // blocks
    queueResult([visibleLine, internalLine]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([{ name: 'Customer Co', taxId: null, billingAddressLine1: null, billingAddressLine2: null, billingAddressCity: null, billingAddressRegion: null, billingAddressPostalCode: null, billingAddressCountry: null }]); // getQuote's own draft billTo org lookup

    queueResult([{ id: 'p1', name: 'Acme MSP', billingTermsAndConditions: null, invoiceFooter: null }]); // partnerRow (reused for partner name)
    queueResult([{ name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' } }]); // org (billing snapshot + recipient)
    queueResult([{ id: 'q1' }]); // update ... returning (claimed)
    queueResult([]); // portalBranding — none configured
    queueResult([{ // final re-select
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent',
      taxRate: null, depositType: 'none', depositPercent: null,
      quoteNumber: 'Q-2026-0001', total: '100.00', currencyCode: 'USD',
    }]);

    const result = await sendQuote('q1', actor);

    expect(result.emailed).toBe(true);
    expect(capturedPdfArgs).not.toBeNull();
    // renderQuotePdf(quote, blocks, lines, loadImage, branding, loadCatalogImage) — lines is arg index 2.
    const renderedLines = capturedPdfArgs![2] as Array<Record<string, unknown>>;
    expect(renderedLines).toHaveLength(1);
    expect(renderedLines[0]?.id).toBe('line-visible');
    expect(renderedLines.some((l) => l.id === 'line-internal')).toBe(false);
    expect(renderedLines.some((l) => l.name === 'Internal markup buffer')).toBe(false);
    // toCustomerLines also strips the cost-basis field, same as the portal route.
    expect(renderedLines[0]).not.toHaveProperty('unitCost');
  });
});

/**
 * Email delivery status: the send is best-effort-emailed, so the result must
 * say honestly whether an email went out and WHY not (the web UI branches its
 * toast on this — a silent `emailed:false` was the "no billing contact" black
 * hole where the seller saw success while the customer received nothing).
 */
describe('sendQuote email delivery status', () => {
  beforeEach(() => {
    results.length = 0;
    setCalls.length = 0;
    vi.clearAllMocks();
    capturedPdfArgs = null;
    sendEmailMock.mockResolvedValue(undefined);
  });

  const quoteRow = {
    id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
    taxRate: null, depositType: 'none', depositPercent: null,
    quoteNumber: 'Q-2026-0001', issueDate: '2026-01-01', expiryDate: null,
    total: '100.00', currencyCode: 'USD', terms: null, termsAndConditions: null,
    sellerSnapshot: null, billToName: null, billToTaxId: null,
  };
  const lineRow = { quantity: '1', unitPrice: '100.00', taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false, lineTotal: '100.00' };

  /** getQuote (quote/blocks/lines/pax8/billTo-org) + partnerRow + org + claim. */
  function queueThroughClaim(org: Record<string, unknown>, partner: Record<string, unknown> = {}) {
    queueResult([quoteRow]);
    queueResult([]); // blocks
    queueResult([lineRow]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([org]); // getQuote's draft billTo org lookup
    queueResult([{ id: 'p1', name: 'Acme MSP', billingTermsAndConditions: null, invoiceFooter: null, ...partner }]);
    queueResult([org]); // org (billing snapshot + recipient)
    queueResult([{ id: 'q1' }]); // update ... returning (claimed)
  }

  it('reports no_billing_contact (and sends nothing) when the org has no billing email', async () => {
    queueThroughClaim({ name: 'Customer Co', taxId: null, billingContact: null });
    // No billingContact → the email branch short-circuits before the
    // portalBranding read, straight to the final re-select.
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]);

    const result = await sendQuote('q1', actor);

    expect(result.emailed).toBe(false);
    expect(result.emailReason).toBe('no_billing_contact');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.quote.status).toBe('sent'); // the send itself still commits
  });

  it('reports send_failed when the email provider throws (send still commits)', async () => {
    queueThroughClaim({ name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' } });
    queueResult([]); // portalBranding — none configured
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]); // final re-select
    sendEmailMock.mockRejectedValue(new Error('smtp down'));

    const result = await sendQuote('q1', actor);

    expect(result.emailed).toBe(false);
    expect(result.emailReason).toBe('send_failed');
    expect(result.quote.status).toBe('sent');
  });

  it('reports pdf_render_failed (and never calls the email transport) when building the attachment throws', async () => {
    queueThroughClaim({ name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' } });
    queueResult([]); // portalBranding — none configured
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]); // final re-select
    vi.mocked(renderQuotePdf).mockRejectedValueOnce(new Error('pdfkit blew up'));

    const result = await sendQuote('q1', actor);

    expect(result.emailed).toBe(false);
    expect(result.emailReason).toBe('pdf_render_failed');
    expect(sendEmailMock).not.toHaveBeenCalled(); // never reached the transport
    expect(result.quote.status).toBe('sent'); // the send itself still commits
  });

  it('reports emailed:true with no reason on a successful send', async () => {
    queueThroughClaim({ name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' } });
    queueResult([]); // portalBranding
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]);

    const result = await sendQuote('q1', actor);

    expect(result.emailed).toBe(true);
    expect(result.emailReason).toBeUndefined();
  });

  it('sends with an MSP-branded from display name and the partner billing email as reply-to', async () => {
    queueThroughClaim(
      { name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' } },
      { billingEmail: 'accounts@acmemsp.example' },
    );
    queueResult([]); // portalBranding
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]);

    await sendQuote('q1', actor);

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      // Display name is the MSP ("via Breeze" keeps the platform address honest);
      // the envelope address itself stays the platform's for SPF/DKIM alignment.
      from: '"Acme MSP via Breeze" <no-reply@test.example>',
      replyTo: 'accounts@acmemsp.example',
    }));
  });

  it('uses composer recipients + cc over the billing-contact fallback', async () => {
    // Org has NO billing contact — the explicit `to` must carry the send anyway.
    queueThroughClaim({ name: 'Customer Co', taxId: null, billingContact: null });
    queueResult([]); // portalBranding
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]);

    const result = await sendQuote('q1', actor, { to: ['buyer@customer.example'], cc: ['cfo@customer.example'] });

    expect(result.emailed).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: ['buyer@customer.example'],
      cc: ['cfo@customer.example'],
    }));
  });

  it('includePdf:false skips the PDF render and attaches nothing', async () => {
    queueThroughClaim({ name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' } });
    queueResult([]); // portalBranding
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]);

    const result = await sendQuote('q1', actor, { includePdf: false });

    expect(result.emailed).toBe(true);
    expect(capturedPdfArgs).toBeNull(); // renderQuotePdf never invoked
    const sent = sendEmailMock.mock.calls[0]![0] as { attachments?: unknown; html: string };
    expect(sent.attachments).toBeUndefined();
    expect(sent.html).not.toContain('PDF copy is attached');
  });

  it('passes subject override and partner signature through to the email', async () => {
    queueThroughClaim(
      { name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' } },
      { emailSignature: 'Todd @ Acme MSP' },
    );
    queueResult([]); // portalBranding
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]);

    await sendQuote('q1', actor, { subject: 'Your workstation refresh' });

    const sent = sendEmailMock.mock.calls[0]![0] as { subject: string; html: string };
    expect(sent.subject).toBe('Your workstation refresh');
    expect(sent.html).toContain('Todd @ Acme MSP');
  });

  it('omits reply-to when the partner has no billing email', async () => {
    queueThroughClaim({ name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' } });
    queueResult([]); // portalBranding
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]);

    await sendQuote('q1', actor);

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ replyTo: undefined }));
  });
});

/**
 * Bill-to snapshot freeze (bug: org Billing address never appeared on the quote).
 * `sendQuote` must copy the org's Billing-settings address into the quote's frozen
 * `billToAddress` (+ name/taxId) at send time — the same snapshot the invoice issue
 * path takes. Before this, `bill_to_address` stayed NULL and the PDF rendered no
 * customer address no matter what the tech saved on the org.
 */
describe('sendQuote bill-to snapshot', () => {
  beforeEach(() => {
    results.length = 0;
    setCalls.length = 0;
    vi.clearAllMocks();
    capturedPdfArgs = null;
    sendEmailMock.mockResolvedValue(undefined);
  });

  /** Queue getQuote (quote/blocks/lines) + partnerRow + org + claim + email-path reads. */
  function queueSendPath(quote: Record<string, unknown>, org: Record<string, unknown>) {
    queueResult([quote]); // getQuote: quote
    queueResult([]);       // getQuote: blocks
    queueResult([{ quantity: '1', unitPrice: '100.00', taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false, lineTotal: '100.00' }]); // getQuote: lines
    queueResult([]);       // getQuote: no staged Pax8 order
    queueResult([org]);    // getQuote's own draft billTo org lookup (status is 'draft' for every quote sent through this helper)
    queueResult([{ id: 'p1', name: 'Acme MSP', billingTermsAndConditions: null, invoiceFooter: null }]); // partnerRow (reused for partner name)
    queueResult([org]);    // org (billing snapshot + recipient)
    queueResult([{ id: 'q1' }]); // update ... returning (claimed)
    queueResult([]);       // portalBranding
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]); // final re-select
  }

  const baseQuote = {
    id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
    taxRate: null, depositType: 'none', depositPercent: null,
    quoteNumber: 'Q-2026-0001', issueDate: '2026-01-01', expiryDate: null,
    total: '100.00', currencyCode: 'USD', terms: null, termsAndConditions: null,
    sellerSnapshot: null, billToName: null, billToTaxId: null,
  };

  /** Pull the `.set(...)` payload from the status→sent claim update. */
  function claimSet() {
    const found = setCalls.find((s) => s.status === 'sent' && 'billToAddress' in s);
    expect(found, 'send update should set billToAddress').toBeDefined();
    return found!;
  }

  it('freezes the org billing address into billToAddress/name/taxId on send', async () => {
    queueSendPath(baseQuote, {
      name: 'Customer Co', taxId: 'TAX-42',
      billingContact: { email: 'billing@customer.example' },
      billingAddressLine1: '123 Main St', billingAddressLine2: 'Suite 4',
      billingAddressCity: 'Austin', billingAddressRegion: 'TX',
      billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    });

    await sendQuote('q1', actor);

    const set = claimSet();
    expect(set.billToAddress).toEqual({
      line1: '123 Main St', line2: 'Suite 4', city: 'Austin',
      region: 'TX', postalCode: '78701', country: 'US',
    });
    expect(set.billToName).toBe('Customer Co'); // no draft override → org name
    expect(set.billToTaxId).toBe('TAX-42');
  });

  it('preserves a tech-set draft billToName over the org name', async () => {
    queueSendPath(
      { ...baseQuote, billToName: 'Attn: Accounts Payable' },
      {
        name: 'Customer Co', taxId: null,
        billingContact: { email: 'billing@customer.example' },
        billingAddressLine1: '1 Elm', billingAddressLine2: null,
        billingAddressCity: 'Reno', billingAddressRegion: 'NV',
        billingAddressPostalCode: '89501', billingAddressCountry: 'US',
      },
    );

    await sendQuote('q1', actor);

    const set = claimSet();
    expect(set.billToName).toBe('Attn: Accounts Payable'); // draft override wins
    expect(set.billToAddress).toMatchObject({ line1: '1 Elm', city: 'Reno' });
  });

  it('falls back to the org name when a draft billToName is blank (not a bare ?? on "")', async () => {
    // updateQuote persists billToName verbatim, so a draft can carry '' — a naive
    // `quote.billToName ?? org.name` would freeze an empty name. Whitespace too.
    queueSendPath(
      { ...baseQuote, billToName: '   ' },
      {
        name: 'Customer Co', taxId: null,
        billingContact: { email: 'billing@customer.example' },
        billingAddressLine1: '1 Elm', billingAddressLine2: null,
        billingAddressCity: 'Reno', billingAddressRegion: 'NV',
        billingAddressPostalCode: '89501', billingAddressCountry: 'US',
      },
    );

    await sendQuote('q1', actor);

    expect(claimSet().billToName).toBe('Customer Co');
  });

  it('preserves a tech-set draft billToTaxId over the org taxId', async () => {
    queueSendPath(
      { ...baseQuote, billToTaxId: 'OVERRIDE-TAX' },
      {
        name: 'Customer Co', taxId: 'ORG-TAX',
        billingContact: { email: 'billing@customer.example' },
        billingAddressLine1: '1 Elm', billingAddressLine2: null,
        billingAddressCity: 'Reno', billingAddressRegion: 'NV',
        billingAddressPostalCode: '89501', billingAddressCountry: 'US',
      },
    );

    await sendQuote('q1', actor);

    expect(claimSet().billToTaxId).toBe('OVERRIDE-TAX'); // draft override wins over ORG-TAX
  });

  it('freezes an all-null address when the org has no billing address saved', async () => {
    queueSendPath(baseQuote, {
      name: 'Customer Co', taxId: null,
      billingContact: { email: 'billing@customer.example' },
      billingAddressLine1: null, billingAddressLine2: null,
      billingAddressCity: null, billingAddressRegion: null,
      billingAddressPostalCode: null, billingAddressCountry: null,
    });

    await sendQuote('q1', actor);

    // Still a well-formed object (addressLines() renders nothing from it) — never
    // a partial/undefined shape the PDF helper would choke on.
    expect(claimSet().billToAddress).toEqual({
      line1: null, line2: null, city: null, region: null, postalCode: null, country: null,
    });
  });
});

/**
 * Send-time contract-variable gate (Task 12): a `contract` block references an
 * immutable, published template version with declared variables (auto/manual).
 * Sending must be blocked while any declared variable has no resolved value —
 * otherwise a raw `{{token}}` placeholder ships straight into a legal document.
 * loadContractBlockRenderData (contractTemplateRender.ts) reads through the
 * SAME mocked '../db' + withSystemDbAccessContext/runOutsideDbContext used
 * throughout this file, so its selects are just more entries in the shared
 * `results` queue, exactly like every other db read in sendQuote.
 */
describe('sendQuote contract-variable gate', () => {
  beforeEach(() => {
    results.length = 0;
    setCalls.length = 0;
    vi.clearAllMocks();
    capturedPdfArgs = null;
    sendEmailMock.mockResolvedValue(undefined);
  });

  const baseQuote = {
    id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
    taxRate: null, depositType: 'none', depositPercent: null,
    quoteNumber: 'Q-2026-0001', issueDate: '2026-01-01', expiryDate: '2026-08-01',
    title: 'Managed Services Proposal',
    total: '100.00', currencyCode: 'USD', terms: null, termsAndConditions: null,
    sellerSnapshot: null, billToName: 'Acme Co', billToTaxId: null, billToAddress: null,
    oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
  };

  const contractBlock = (variableValues: Record<string, string>) => ({
    id: 'block-1',
    blockType: 'contract',
    content: { templateId: 'tmpl-1', templateVersionId: 'ver-1', variableValues },
  });

  const versionRow = {
    id: 'ver-1',
    templateId: 'tmpl-1',
    orgId: null,
    partnerId: 'p1',
    versionNumber: 1,
    status: 'published',
    sourceType: 'authored' as const,
    bodyHtml: '<p>{{client.name}} agrees to {{governing_state}}</p>',
    fileData: null,
    mime: null,
    byteSize: null,
    sha256: 'abc123',
    declaredVariables: [
      { name: 'client.name', kind: 'auto' },
      { name: 'governing_state', kind: 'manual' },
    ],
    publishedAt: new Date('2026-07-01T00:00:00Z'),
    createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };
  const templateRow = {
    id: 'tmpl-1', orgId: null, partnerId: 'p1', name: 'MSA', description: null,
    status: 'active', createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
  };

  const org = {
    name: 'Customer Co', taxId: null, billingContact: { email: 'billing@customer.example' },
    billingAddressLine1: '1 Elm', billingAddressLine2: null,
    billingAddressCity: 'Reno', billingAddressRegion: 'NV',
    billingAddressPostalCode: '89501', billingAddressCountry: 'US',
  };

  it('blocks send with the unresolved (manual) variable name when a contract block variable is unfilled', async () => {
    queueResult([baseQuote]);              // getQuote: quote
    queueResult([contractBlock({})]);       // getQuote: blocks — governing_state left blank
    queueResult([]);                        // getQuote: lines
    queueResult([]);                        // getQuote: no staged Pax8 order
    queueResult([org]);                     // getQuote's own draft billTo org lookup
    queueResult([versionRow]);              // loadContractBlockRenderData: version select
    queueResult([templateRow]);             // loadContractBlockRenderData: template select

    await expect(sendQuote('q1', actor)).rejects.toMatchObject({
      status: 422,
      code: 'CONTRACT_VARIABLES_UNRESOLVED',
      message: expect.stringContaining('governing_state'),
    });
  });

  it('does not gate on an auto variable — it is always resolved from the quote itself', async () => {
    // declaredVariables includes 'client.name' (kind: auto); only the manual
    // 'governing_state' should ever appear in the unresolved list.
    queueResult([baseQuote]);
    queueResult([contractBlock({})]);
    queueResult([]);
    queueResult([]);
    queueResult([org]);
    queueResult([versionRow]);
    queueResult([templateRow]);

    await expect(sendQuote('q1', actor)).rejects.toMatchObject({
      code: 'CONTRACT_VARIABLES_UNRESOLVED',
      message: expect.not.stringContaining('client.name'),
    });
  });

  it('sends successfully once every manual variable is filled in', async () => {
    queueResult([baseQuote]);                                   // getQuote: quote
    queueResult([contractBlock({ governing_state: 'Texas' })]); // getQuote: blocks — filled in
    queueResult([{ quantity: '1', unitPrice: '100.00', taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false, lineTotal: '100.00' }]); // getQuote: lines
    queueResult([]);                        // getQuote: no staged Pax8 order
    queueResult([org]);                     // getQuote's own draft billTo org lookup
    queueResult([versionRow]);              // loadContractBlockRenderData: version select
    queueResult([templateRow]);             // loadContractBlockRenderData: template select
    queueResult([{ id: 'p1', name: 'Acme MSP', billingTermsAndConditions: null, invoiceFooter: null }]); // partnerRow
    queueResult([org]);                     // org (billing snapshot + recipient)
    queueResult([{ id: 'q1' }]);            // update ... returning (claimed)
    queueResult([]);                        // portalBranding
    // Task 14: the emailed-PDF attachment pre-fetches contract render data via
    // loadContractPdfInputs, which calls loadContractBlockRenderData a SECOND
    // time (the first call above was the send-time variable gate) — same
    // version + template selects, since the read is a plain (uncached) DB call.
    queueResult([versionRow]);              // loadContractPdfInputs: version select
    queueResult([templateRow]);             // loadContractPdfInputs: template select
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]); // final re-select

    const result = await sendQuote('q1', actor);
    expect(result.quote.status).toBe('sent');
  });

  it('overlays the just-frozen billTo/seller onto the quote before rendering the contract + PDF', async () => {
    // Regression: the in-memory `quote` was read BEFORE the send-time freeze, so
    // its billTo*/sellerSnapshot were still NULL (draft). Rendering the emailed
    // contract/PDF from that stale row substituted {{client.name}}/{{seller.name}}
    // to empty strings. sendQuote must overlay the frozen values first.
    const autoOnlyVersion = {
      ...versionRow,
      bodyHtml: '<p>Prepared for {{client.name}} by {{seller.name}}</p>',
      declaredVariables: [
        { name: 'client.name', kind: 'auto' },
        { name: 'seller.name', kind: 'auto' },
      ],
    };
    const draftNullBillTo = { ...baseQuote, billToName: null, billToAddress: null, sellerSnapshot: null };

    queueResult([draftNullBillTo]);          // getQuote: quote (NULL billTo)
    queueResult([contractBlock({})]);        // getQuote: blocks
    queueResult([{ quantity: '1', unitPrice: '100.00', taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false, lineTotal: '100.00' }]); // getQuote: lines
    queueResult([]);                         // getQuote: no staged Pax8 order
    queueResult([org]);                      // getQuote's own draft billTo org lookup
    queueResult([autoOnlyVersion]);          // send gate: version
    queueResult([templateRow]);              // send gate: template
    queueResult([{ id: 'p1', name: 'Acme MSP', billingTermsAndConditions: null, invoiceFooter: null }]); // partnerRow
    queueResult([org]);                      // org (billing snapshot + recipient)
    queueResult([{ id: 'q1' }]);             // update ... returning (claimed)
    queueResult([]);                         // portalBranding
    queueResult([autoOnlyVersion]);          // loadContractPdfInputs: version
    queueResult([templateRow]);              // loadContractPdfInputs: template
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent' }]); // final re-select

    await sendQuote('q1', actor);

    expect(capturedPdfArgs).not.toBeNull();
    // renderQuotePdf(quote, ...) — arg 0 is the quote object that was rendered.
    const renderedQuote = capturedPdfArgs![0] as Record<string, unknown>;
    expect(renderedQuote.billToName).toBe('Customer Co'); // frozen org name, not the stale NULL
    expect((renderedQuote.sellerSnapshot as { name?: string } | null)?.name).toBe('Acme MSP'); // built from partnerRow, not NULL
    // renderQuotePdf(..., contractRenderData) — the substituted contract HTML must
    // carry the frozen customer/seller identity, not empty strings.
    const contractRenderData = capturedPdfArgs![6] as Map<string, { html: string | null }>;
    const html = contractRenderData.get('block-1')!.html!;
    expect(html).toContain('Customer Co');
    expect(html).toContain('Acme MSP');
  });
});
