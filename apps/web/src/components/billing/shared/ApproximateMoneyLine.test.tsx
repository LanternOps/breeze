import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

// Pinning the templates HERE proves the component passes exactly the
// interpolations each catalog entry consumes. The catalogs themselves are
// exercised for real by `moneyRollupApproximate.test.tsx`, which renders the
// seven surfaces against the shipped `en` file, and by the locale parity suite.
const TEMPLATES: Record<string, string> = {
  'money.approximateTotal': '≈ {{amount}} approximate · rates as of {{rateDate}}',
  'money.approximateUnavailableMissing': '≈ total unavailable — no {{target}} exchange rate for {{codes}}',
  'money.approximateUnavailableStale': '≈ total unavailable — {{target}} exchange rate too old for {{codes}}',
  'money.approximateUnavailableMixed': '≈ total unavailable — {{codes}} could not be converted to {{target}}',
  'money.approximateUnavailableCodesOverflow': '{{codes}} and {{more}} more',
  'money.approximateFailed': '≈ total unavailable — could not load exchange rates',
};
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const template = TEMPLATES[key];
      if (!template) return key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars?.[name] ?? ''));
    },
  }),
}));

import { ApproximateMoneyLine } from './ApproximateMoneyLine';
import { resetApproximateTotalCache } from '@/lib/useApproximateTotal';
import type { ReportingTotalResponse } from '@/lib/reporting/approximateTotal';

const jsonRes = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload }) as Response;

const BOOK = [{ code: 'USD', amount: '12300.00' }, { code: 'EUR', amount: '4100.00' }];

const AVAILABLE: ReportingTotalResponse = {
  status: 'available',
  targetCurrencyCode: 'CAD',
  requestedDate: '2026-08-21',
  maxStalenessDays: 7,
  rateDate: '2026-08-21',
  total: '22940.00',
  groups: [],
  unavailableCurrencyCodes: [],
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  resetApproximateTotalCache();
});

describe('ApproximateMoneyLine', () => {
  it('renders the approximate total with its rate date once the server answers', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    await waitFor(() => expect(screen.getByTestId('approximate-money-line')).toBeInTheDocument());
    expect(screen.getByTestId('approximate-money-line').textContent)
      .toBe('≈ CA$22,940.00 approximate · rates as of 2026-08-21');
    expect(screen.getByTestId('approximate-money-line').dataset.approxState).toBe('available');
  });

  it('renders NOTHING while the request is in flight', async () => {
    fetchWithAuth.mockReturnValue(new Promise<Response>(() => {}));
    const { container } = render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('approximate-money-line')).toBeNull();
  });

  // #4415: a failed request used to render nothing, so a self-hoster with no
  // exchange-rate feed saw an approximate line that simply never appeared and
  // had no way to learn why. The line must SAY it could not be produced.
  it('renders a VISIBLE failure state when the request fails — never silence', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: { code: 'BOOM' } }, 500));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    const line = await screen.findByTestId('approximate-money-line');
    expect(line.textContent).toBe('≈ total unavailable — could not load exchange rates');
    expect(line.dataset.approxState).toBe('failed');
  });

  it('never presents a figure in the failure state — no total, no naive 1:1 sum', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: { code: 'BOOM' } }, 500));
    const { container } = render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    await screen.findByTestId('approximate-money-line');
    expect(container.textContent).not.toMatch(/\d/);
  });

  it('renders NOTHING for a `not-needed` single-currency book — no shipped summary strip moves', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({
      data: { ...AVAILABLE, status: 'not-needed', targetCurrencyCode: 'USD', total: null, rateDate: null },
    }));
    const { container } = render(
      <ApproximateMoneyLine byCurrency={[{ code: 'USD', amount: '12300.00' }]} date="2026-08-21" />,
    );
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  const unavailableBody = (
    groups: { currencyCode: string; reason?: 'missing' | 'stale' }[],
    unavailableCurrencyCodes: string[],
  ) => ({
    data: {
      ...AVAILABLE,
      status: 'unavailable',
      total: null,
      rateDate: null,
      groups: groups.map((g) => ({
        currencyCode: g.currencyCode, amount: '1.00', convertedAmount: null,
        rate: null, rateDate: null, source: null, ...(g.reason ? { reason: g.reason } : {}),
      })),
      unavailableCurrencyCodes,
    },
  });

  it('NAMES the currency the server could not convert when it reports `unavailable`', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(unavailableBody(
      [{ currencyCode: 'USD' }, { currencyCode: 'NGN', reason: 'missing' }],
      ['NGN'],
    )));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    const line = await screen.findByTestId('approximate-money-line');
    expect(line.textContent).toBe('≈ total unavailable — no CAD exchange rate for NGN');
    expect(line.dataset.approxState).toBe('unavailable');
  });

  it('says the rate is STALE rather than missing when that is what the server reported', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(unavailableBody([{ currencyCode: 'EUR', reason: 'stale' }], ['EUR'])));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    const line = await screen.findByTestId('approximate-money-line');
    expect(line.textContent).toBe('≈ total unavailable — CAD exchange rate too old for EUR');
  });

  it('lists every uncoverable currency, not just the first', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(unavailableBody(
      [{ currencyCode: 'EUR', reason: 'stale' }, { currencyCode: 'NGN', reason: 'missing' }],
      ['EUR', 'NGN'],
    )));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    const line = await screen.findByTestId('approximate-money-line');
    expect(line.textContent).toBe('≈ total unavailable — EUR, NGN could not be converted to CAD');
  });

  it('caps a long list and COUNTS the remainder — never elides it into an ellipsis', async () => {
    const codes = ['AED', 'BRL', 'CHF', 'EUR', 'NGN', 'ZAR'];
    fetchWithAuth.mockResolvedValue(jsonRes(unavailableBody(
      codes.map((currencyCode) => ({ currencyCode, reason: 'missing' as const })),
      codes,
    )));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    const line = await screen.findByTestId('approximate-money-line');
    expect(line.textContent)
      .toBe('≈ total unavailable — no CAD exchange rate for AED, BRL, CHF, EUR and 2 more');
  });

  // The other half of the same defect class: a book this client cannot even
  // encode (a credit note pushing one currency negative) used to make the line
  // vanish with no request and no trace.
  it('reports a book it could not encode instead of vanishing — and asks the server nothing', async () => {
    render(<ApproximateMoneyLine byCurrency={[{ code: 'USD', amount: '100.00' }, { code: 'EUR', amount: -5 }]} />);
    const line = await screen.findByTestId('approximate-money-line');
    expect(line.textContent).toBe('≈ total unavailable — could not load exchange rates');
    expect(line.dataset.approxState).toBe('failed');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  // Both of these bodies PASS `useApproximateTotal.validate` — an empty array is
  // still an array, a whitespace code is still a non-empty string — so they
  // reach the component for real. The line must fall back to what it can prove
  // rather than rendering "no  exchange rate for " (or nothing at all).
  it('falls back to the generic failure when the server names NO codes', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(unavailableBody([], [])));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    const line = await screen.findByTestId('approximate-money-line');
    expect(line.textContent).toBe('≈ total unavailable — could not load exchange rates');
    expect(line.dataset.approxState).toBe('unavailable');
  });

  it('falls back to the generic failure when the target currency is unusable', async () => {
    const body = unavailableBody([{ currencyCode: 'NGN', reason: 'missing' }], ['NGN']);
    fetchWithAuth.mockResolvedValue(jsonRes({ data: { ...body.data, targetCurrencyCode: '   ' } }));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    const line = await screen.findByTestId('approximate-money-line');
    // Never "no  exchange rate for NGN": half a pair is not a fact.
    expect(line.textContent).toBe('≈ total unavailable — could not load exchange rates');
  });

  it('still shows NO figure in the unavailable state — no partial total, no 1:1', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(unavailableBody([{ currencyCode: 'EUR', reason: 'missing' }], ['EUR'])));
    const { container } = render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    await screen.findByTestId('approximate-money-line');
    expect(container.textContent).not.toContain('22940');
    expect(container.textContent).not.toContain('CA$');
    expect(container.textContent).not.toMatch(/\d/);
  });

  it('keeps the failure state as quiet visually as the total it replaces', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(unavailableBody([{ currencyCode: 'EUR', reason: 'missing' }], ['EUR'])));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    const line = await screen.findByTestId('approximate-money-line');
    expect(line.className).toContain('text-xs');
    expect(line.className).toContain('text-muted-foreground');
  });

  it('renders nothing and asks the server nothing for an empty book', async () => {
    const { container } = render(<ApproximateMoneyLine byCurrency={[]} />);
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('carries an overridable, stable data-testid so page suites can assert it', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: AVAILABLE }));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" testId="invoices-approx" />);
    await waitFor(() => expect(screen.getByTestId('invoices-approx')).toBeInTheDocument());
    expect(screen.queryByTestId('approximate-money-line')).toBeNull();
  });

  // A page suite asserting the line exists must not be able to pass on a
  // failure state and vice versa: same testId, different `data-approx-state`.
  it('keeps the overridden testId in the failure states, distinguished by data-approx-state', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(unavailableBody([{ currencyCode: 'NGN', reason: 'missing' }], ['NGN'])));
    render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" testId="invoices-approx" />);
    const line = await screen.findByTestId('invoices-approx');
    expect(line.dataset.approxState).toBe('unavailable');
    expect(line.textContent).toContain('NGN');
  });
});
