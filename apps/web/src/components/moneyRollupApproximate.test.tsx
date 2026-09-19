/**
 * ONE table driving EVERY money rollup that carries the reporting-only
 * "≈ approximate" line (multi-currency spec §8, wave 7 / #3779).
 *
 * It lives here — one level above the six components — so that a SINGLE set of
 * `vi.mock` specifiers resolves to the same modules all six import
 * (`src/stores/auth`, `src/components/shared/Toast`, …). Asserting only the
 * surface with a brand-new test file would leave five untested against the
 * failure modes that actually matter, and the five states below are identical
 * for every surface, so duplicating them into six suites would guarantee drift.
 *
 * Every surface is asserted in all five states:
 *   1. mixed book + rates available → segmentation UNCHANGED + the line renders
 *   2. single-currency book         → no line, shipped summary byte-identical
 *   3. a stale leg                  → segmentation + the line SAYS the rate is
 *                                     too old and names the currency
 *   4. an uncovered pair            → segmentation + the line names the
 *                                     currency, and NO 1:1 figure and NO
 *                                     target-currency symbol anywhere
 *   5. endpoint 500                 → segmentation + the line says it could not
 *                                     load rates, and still no toast
 *
 * States 3-5 asserted the OPPOSITE until #4415: the line rendered nothing, so
 * a self-hoster with no exchange-rate feed could not tell a broken conversion
 * from a working one. Suppressing the FIGURE is the contract; suppressing the
 * LINE was the bug — the fourth of its kind on this surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();

vi.mock('../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('./shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import InvoicesPage from './billing/InvoicesPage';
import QuotesPage from './billing/quotes/QuotesPage';
import { ContractsList } from './contracts/ContractsList';
import TicketTimeBilling from './tickets/TicketTimeBilling';
import TimesheetPage from './time/TimesheetPage';
import PartnerDashboard from './partner/PartnerDashboard';
import { resetApproximateTotalCache } from '@/lib/useApproximateTotal';
import type { ReportingTotalResponse } from '@/lib/reporting/approximateTotal';

// ---------------------------------------------------------------------------
// Fixtures — every surface carries the SAME book so one naive-sum guard
// ('16,400' = 12,300 + 4,100 treated as 1:1) covers all of them.
// ---------------------------------------------------------------------------

const USD_AMOUNT = '12300.00';
const EUR_AMOUNT = '4100.00';
const NAIVE_SUM = '16,400';
const TARGET_SYMBOL = 'CA$'; // the reporting currency the server would convert to

type Mode = 'mixed' | 'single';
let mode: Mode = 'mixed';

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload), blob: vi.fn() }) as unknown as Response;

const AVAILABLE: ReportingTotalResponse = {
  status: 'available',
  targetCurrencyCode: 'CAD',
  requestedDate: '2026-08-21',
  maxStalenessDays: 7,
  rateDate: '2026-08-19',
  total: '22940.00',
  groups: [],
  unavailableCurrencyCodes: [],
};

const NOT_NEEDED: ReportingTotalResponse = {
  ...AVAILABLE, status: 'not-needed', targetCurrencyCode: 'USD', total: null, rateDate: null,
};

const unavailable = (reason: 'stale' | 'missing'): ReportingTotalResponse => ({
  ...AVAILABLE,
  status: 'unavailable',
  total: null,
  rateDate: null,
  groups: [
    { currencyCode: 'USD', amount: USD_AMOUNT, convertedAmount: null, rate: null, rateDate: null, source: null },
    { currencyCode: 'EUR', amount: EUR_AMOUNT, convertedAmount: null, rate: null, rateDate: null, source: null, reason },
  ],
  unavailableCurrencyCodes: ['EUR'],
});

/** What `/billing/reporting-totals` answers for the state under test. */
let rates: () => Response = () => json({ data: AVAILABLE });

const money = () => (mode === 'mixed'
  ? [{ code: 'USD', amount: USD_AMOUNT }, { code: 'EUR', amount: EUR_AMOUNT }]
  : [{ code: 'USD', amount: USD_AMOUNT }]);

const invoice = (id: string, currencyCode: string, balance: string) => ({
  id, invoiceNumber: id.toUpperCase(), orgId: 'org-1', siteId: null, status: 'sent',
  currencyCode, issueDate: '2026-05-01', dueDate: '2026-05-31', sentAt: '2026-05-01T00:00:00Z',
  subtotal: balance, taxRate: '0.000', taxTotal: '0.00', total: balance, amountPaid: '0.00',
  balance, billToName: 'Acme', notes: null, termsAndConditions: null, sellerSnapshot: null,
  createdAt: '2026-05-01T00:00:00Z',
});

const quote = (id: string, currencyCode: string, total: string) => ({
  id, quoteNumber: id.toUpperCase(), partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'sent',
  currencyCode, issueDate: null, expiryDate: null, subtotal: total, taxRate: null, taxTotal: '0.00',
  total, oneTimeTotal: total, monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00',
  billToName: null, introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
  acceptedAt: null, declinedAt: null, convertedAt: null, convertedInvoiceId: null,
  sentAt: '2026-06-01T00:00:00Z', viewedAt: null, createdBy: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
});

const contract = (id: string, orgId: string, currencyCode: string, value: string) => ({
  id, partnerId: 'p1', orgId, name: `Contract ${id}`, status: 'active' as const,
  billingTiming: 'advance' as const, currencyCode, intervalMonths: 1, estimatedPeriodValue: value,
  startDate: '2026-01-01', endDate: null, nextBillingAt: '2026-02-01', autoIssue: false,
  autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null, createdBy: null,
  notes: null, terms: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
});

const currencyAmounts = () => money().map((g) => ({ currencyCode: g.code, amount: g.amount }));

const TIMESHEET_WEEK = {
  weekStart: '2026-06-08',
  days: [
    { date: '2026-06-08', totalMinutes: 90, billableMinutes: 90, entries: [] },
    ...['09', '10', '11', '12', '13', '14'].map((d) => ({ date: `2026-06-${d}`, totalMinutes: 0, billableMinutes: 0, entries: [] })),
  ],
  totals: { totalMinutes: 90, billableMinutes: 90, billableAmounts: currencyAmounts() },
};

/** One router for all six surfaces; the reporting route delegates to `rates`. */
function wire() {
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.startsWith('/billing/reporting-totals')) return rates();
    if (url.startsWith('/orgs/organizations')) return json({ data: [{ id: 'org-1', name: 'Acme Corp' }, { id: 'org-2', name: 'Globex' }] });
    if (url.startsWith('/orgs/sites')) return json({ data: [] });
    if (url.startsWith('/invoices')) {
      return json({ data: mode === 'mixed'
        ? [invoice('inv-1', 'USD', USD_AMOUNT), invoice('inv-2', 'EUR', EUR_AMOUNT)]
        : [invoice('inv-1', 'USD', USD_AMOUNT)] });
    }
    if (url.startsWith('/quotes')) {
      return json({ data: mode === 'mixed'
        ? [quote('q-1', 'USD', USD_AMOUNT), quote('q-2', 'EUR', EUR_AMOUNT)]
        : [quote('q-1', 'USD', USD_AMOUNT)] });
    }
    if (url.startsWith('/contracts')) {
      return json({ data: mode === 'mixed'
        ? [contract('c-1', 'org-1', 'USD', USD_AMOUNT), contract('c-2', 'org-2', 'EUR', EUR_AMOUNT)]
        : [contract('c-1', 'org-1', 'USD', USD_AMOUNT)] });
    }
    if (url.startsWith('/tickets/tk-1/billing-summary')) {
      return json({ data: {
        time: { totalMinutes: 90, billableMinutes: 60, billableAmounts: currencyAmounts() },
        parts: { partsCount: 2, billableTotals: currencyAmounts() },
      } });
    }
    if (url.startsWith('/tickets/tk-1/time-entries')) return json({ data: [], total: 0 });
    if (url.startsWith('/time-entries/timesheet')) {
      // Echo the requested week so a navigated/future week isn't discarded as a
      // stale response by the page's own weekStart guard.
      const requested = new URLSearchParams(url.split('?')[1] ?? '').get('weekStart');
      return json({ data: { ...TIMESHEET_WEEK, weekStart: requested ?? TIMESHEET_WEEK.weekStart } });
    }
    if (url.startsWith('/users')) return json({ data: [{ id: 'u-1', name: 'Todd', email: 't@x' }] });
    if (url.startsWith('/partner/dashboard')) {
      const org = (id: string, name: string, groups: { code: string; amount: string }[]) => ({
        id, name, healthScore: 90, deviceCount: 1, alertCount: 0, compliancePercent: 100,
        mrr: 0, mrrByCurrency: groups.map((g) => ({ currencyCode: g.code, amount: g.amount })), devices: [],
      });
      return json({ data: { customers: mode === 'mixed'
        ? [org('o1', 'Acme', [{ code: 'USD', amount: USD_AMOUNT }]), org('o2', 'Globex', [{ code: 'EUR', amount: EUR_AMOUNT }])]
        : [org('o1', 'Acme', [{ code: 'USD', amount: USD_AMOUNT }])] } });
    }
    return json({}, false, 404);
  });
}

// ---------------------------------------------------------------------------
// The surface table
// ---------------------------------------------------------------------------

interface Surface {
  name: string;
  testId: string;
  render: () => void;
  /** Resolves the element holding the authoritative per-currency segmentation. */
  total: () => Promise<HTMLElement>;
  /** Exact shipped summary text per mode — asserted byte-for-byte. */
  expected: Record<Mode, string[]>;
}

const byTestId = (id: string) => async () => screen.findByTestId(id);

const SURFACES: Surface[] = [
  {
    name: 'partner dashboard MRR',
    testId: 'partner-dashboard-mrr-approx',
    render: () => { render(<PartnerDashboard />); },
    total: byTestId('partner-dashboard-total-mrr'),
    expected: { mixed: ['$12,300.00 + €4,100.00'], single: ['$12,300.00'] },
  },
  {
    name: 'invoices outstanding',
    testId: 'invoices-outstanding-approx',
    render: () => { window.location.hash = ''; render(<InvoicesPage />); },
    total: byTestId('invoices-outstanding-card'),
    expected: { mixed: ['$12,300.00 + €4,100.00'], single: ['$12,300.00'] },
  },
  {
    name: 'quotes out for signature',
    testId: 'quotes-signature-approx',
    render: () => { window.location.hash = ''; render(<QuotesPage />); },
    total: byTestId('quotes-signature-card'),
    expected: { mixed: ['$12,300.00 + €4,100.00'], single: ['$12,300.00'] },
  },
  {
    name: 'contracts MRR',
    testId: 'contracts-mrr-approx',
    render: () => { window.location.hash = ''; render(<ContractsList />); },
    total: byTestId('contracts-mrr-strip'),
    expected: { mixed: ['$12,300.00 + €4,100.00'], single: ['$12,300.00'] },
  },
  {
    name: 'ticket labor',
    testId: 'ticket-labor-approx',
    render: () => { render(<TicketTimeBilling ticketId="tk-1" />); },
    total: byTestId('ticket-billing-amount'),
    expected: { mixed: ['$12,300.00', '€4,100.00'], single: ['$12,300.00'] },
  },
  {
    name: 'ticket parts',
    testId: 'ticket-parts-approx',
    render: () => { render(<TicketTimeBilling ticketId="tk-1" />); },
    total: byTestId('ticket-billing-parts-total'),
    expected: { mixed: ['$12,300.00', '€4,100.00'], single: ['$12,300.00'] },
  },
  {
    name: 'timesheet footer',
    testId: 'timesheet-total-approx',
    render: () => { window.location.hash = '#week=2026-06-08'; render(<TimesheetPage />); },
    total: byTestId('timesheet-billable-amounts'),
    expected: { mixed: ['$12,300.00', '€4,100.00'], single: ['$12,300.00'] },
  },
];

async function assertSegmentation(surface: Surface): Promise<HTMLElement> {
  const total = await surface.total();
  for (const text of surface.expected[mode]) {
    expect(within(total).getByText(text)).toBeInTheDocument();
  }
  // Never a blind 1:1 sum of a mixed book.
  expect(total.textContent).not.toContain(NAIVE_SUM);
  return total;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetApproximateTotalCache();
  window.location.hash = '';
  mode = 'mixed';
  rates = () => json({ data: AVAILABLE });
  wire();
});

describe.each(SURFACES)('$name — reporting-only approximate line', (surface) => {
  it('1. mixed book + rates available: segmentation unchanged AND the line renders', async () => {
    surface.render();
    await assertSegmentation(surface);

    const line = await screen.findByTestId(surface.testId);
    expect(line.textContent).toContain('CA$22,940.00');
    expect(line.textContent).toContain('2026-08-19');
  });

  it('2. single-currency book: no line at all, shipped summary byte-identical', async () => {
    mode = 'single';
    rates = () => json({ data: NOT_NEEDED });
    surface.render();
    const total = await assertSegmentation(surface);

    await waitFor(() => expect(fetchWithAuth)
      .toHaveBeenCalledWith(expect.stringContaining('/billing/reporting-totals'), { skipOrgIdInjection: true }));
    await waitFor(() => expect(screen.queryByTestId(surface.testId)).toBeNull());
    expect(total.textContent).not.toContain('≈');
  });

  it('3. a stale leg: segmentation kept AND the line says the rate is too old', async () => {
    rates = () => json({ data: unavailable('stale') });
    surface.render();
    await assertSegmentation(surface);

    await waitFor(() => expect(fetchWithAuth)
      .toHaveBeenCalledWith(expect.stringContaining('/billing/reporting-totals'), { skipOrgIdInjection: true }));
    const line = await screen.findByTestId(surface.testId);
    // Resolved through the SHIPPED en catalog, not a mocked template.
    expect(line.textContent).toBe('≈ total unavailable — CAD exchange rate too old for EUR');
    expect(line.dataset.approxState).toBe('unavailable');
  });

  it('4. an uncovered pair: the line names the currency, and still no 1:1 figure anywhere', async () => {
    rates = () => json({ data: unavailable('missing') });
    surface.render();
    await assertSegmentation(surface);

    await waitFor(() => expect(fetchWithAuth)
      .toHaveBeenCalledWith(expect.stringContaining('/billing/reporting-totals'), { skipOrgIdInjection: true }));
    const line = await screen.findByTestId(surface.testId);
    expect(line.textContent).toBe('≈ total unavailable — no CAD exchange rate for EUR');
    // The no-silent-1:1 guard, unchanged in substance: the foreign group is
    // neither converted at 1.0 nor relabelled with the reporting currency. The
    // explanation carries no figure at all, so it cannot be mistaken for one.
    expect(document.body.textContent).not.toContain(TARGET_SYMBOL);
    expect(document.body.textContent).not.toContain(NAIVE_SUM);
    expect(line.textContent).not.toMatch(/\d/);
  });

  it('5. endpoint failure: segmentation unchanged, the line says so, still no toast', async () => {
    rates = () => json({ error: { code: 'BOOM' } }, false, 500);
    surface.render();
    await assertSegmentation(surface);

    await waitFor(() => expect(fetchWithAuth)
      .toHaveBeenCalledWith(expect.stringContaining('/billing/reporting-totals'), { skipOrgIdInjection: true }));
    const line = await screen.findByTestId(surface.testId);
    expect(line.textContent).toBe('≈ total unavailable — could not load exchange rates');
    expect(line.dataset.approxState).toBe('failed');
    // Still inline and muted: an optional companion line never escalates to a
    // toast, on seven surfaces that may each render several of them.
    expect(line.className).toContain('text-muted-foreground');
    expect(showToast).not.toHaveBeenCalled();
  });
});

/** The timesheet is the one surface that must NOT ask for today's rates. */
describe('timesheet footer — historical rate date', () => {
  const reportingDates = (): (string | null)[] => (fetchWithAuth.mock.calls as unknown[][])
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith('/billing/reporting-totals'))
    .map((url) => new URLSearchParams(url.split('?')[1] ?? '').get('date'));

  it('asks for the displayed week END, not today, for a past week', async () => {
    window.location.hash = '#week=2026-06-08';
    render(<TimesheetPage />);
    await screen.findByTestId('timesheet-total-approx');
    expect(reportingDates()).toEqual(['2026-06-14']);
  });

  it('never asks for a FUTURE date — a week ending after today clamps to today (UTC)', async () => {
    window.location.hash = '#week=2099-01-05';
    render(<TimesheetPage />);
    await waitFor(() => expect(reportingDates().length).toBe(1));
    const today = new Date().toISOString().slice(0, 10);
    expect(reportingDates()).toEqual([today]);
  });
});
