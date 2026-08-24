import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

// The en catalog entry lands with the rest of the locales in the wiring task;
// pinning the template HERE proves the component passes exactly the
// interpolations that entry consumes ({{amount}} and {{rateDate}}).
const TEMPLATES: Record<string, string> = {
  'money.approximateTotal': '≈ {{amount}} approximate · rates as of {{rateDate}}',
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
  });

  it('renders NOTHING while the request is in flight', async () => {
    fetchWithAuth.mockReturnValue(new Promise<Response>(() => {}));
    const { container } = render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('approximate-money-line')).toBeNull();
  });

  it('renders NOTHING when the request fails — the segmentation above it is the answer', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: { code: 'BOOM' } }, 500));
    const { container } = render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('renders NOTHING for a 409 NO_REPORTING_CURRENCY partner', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: { code: 'NO_REPORTING_CURRENCY' } }, 409));
    const { container } = render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.innerHTML).toBe(''));
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

  it('renders NOTHING when the server reports `unavailable` — no placeholder, no partial total, no 1:1', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({
      data: {
        ...AVAILABLE,
        status: 'unavailable',
        total: null,
        rateDate: null,
        unavailableCurrencyCodes: ['EUR'],
      },
    }));
    const { container } = render(<ApproximateMoneyLine byCurrency={BOOK} date="2026-08-21" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.innerHTML).toBe(''));
    expect(container.textContent).not.toContain('22940');
    expect(container.textContent).not.toContain('≈');
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
});
