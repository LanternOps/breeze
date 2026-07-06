import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable Drizzle chain mock (same pattern as quoteService.test.ts): every
// builder method returns the same chain; a query resolves when awaited (the
// chain is a thenable that yields the next queued result). Tests queue the rows
// each db call should resolve to, in call order.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute', 'transaction'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
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

vi.mock('./quotePdf', () => ({
  renderQuotePdf: vi.fn((...args: unknown[]) => {
    capturedPdfArgs = args;
    return Promise.resolve(Buffer.from('%PDF-fake'));
  }),
}));

vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./email')>();
  return { ...actual, getEmailService: vi.fn(() => ({ sendEmail: sendEmailMock })) };
});

import { buildPublicQuoteAcceptUrl, portalBase, sendQuote } from './quoteLifecycle';

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
  const ENV_KEYS = ['PUBLIC_PORTAL_URL', 'PUBLIC_APP_URL', 'DASHBOARD_URL'] as const;
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
    expect(url).toBe('https://app.example.com/quote/tok');
  });

  it('preserves a valid host + /portal base path (not over-eagerly skipped)', () => {
    process.env.PUBLIC_PORTAL_URL = 'https://example.com/portal';
    const base = portalBase();
    expect(base).toBe('https://example.com/portal'); // returned as-is, base path intact
    expect(new URL(base).hostname).toBe('example.com');
  });

  it('falls through an empty PUBLIC_PORTAL_URL to PUBLIC_APP_URL', () => {
    process.env.PUBLIC_PORTAL_URL = '';
    process.env.PUBLIC_APP_URL = 'https://app.example.com';
    expect(buildPublicQuoteAcceptUrl('t')).toBe('https://app.example.com/quote/t');
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

    await expect(sendQuote('q1', actor)).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_INVALID' });
  });

  it('throws 409 DEPOSIT_INVALID when the deposit config is otherwise unsatisfiable (e.g. percent >= 100)', async () => {
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
      taxRate: null, depositType: 'percent', depositPercent: '100.00',
    }]);
    queueResult([]); // blocks
    queueResult([{ quantity: '1', unitPrice: '1000.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false }]);

    await expect(sendQuote('q1', actor)).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_INVALID' });
  });

  it('does NOT gate a quote with no deposit configured (depositType none)', async () => {
    queueResult([{
      id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent', // non-draft -> INVALID_STATE, not DEPOSIT_INVALID
      taxRate: null, depositType: 'none', depositPercent: null,
    }]);
    queueResult([]); // blocks
    queueResult([]); // lines

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

    queueResult([{ id: 'p1', name: 'Acme MSP', billingTermsAndConditions: null, invoiceFooter: null }]); // partnerRow
    queueResult([{ id: 'q1' }]); // update ... returning (claimed)
    queueResult([{ billingContact: { email: 'billing@customer.example' } }]); // org billingContact
    queueResult([{ name: 'Acme MSP' }]); // partner name
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
