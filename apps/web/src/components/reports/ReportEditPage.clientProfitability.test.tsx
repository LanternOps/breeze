import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/usePartnerCurrency', () => ({
  usePartnerCurrency: () => ({ currency: 'USD', loading: false, failed: false, retry: () => {} }),
}));

import ReportEditPage from './ReportEditPage';
import { useOrgStore } from '../../stores/orgStore';

const baseReport = {
  id: 'rep-1',
  name: 'Client profitability',
  type: 'client_profitability',
  schedule: 'monthly',
  format: 'pdf',
  portalSelfService: false,
  lastGeneratedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};
let loaded: Record<string, unknown> | null;
const BUILDER_DELIVERY = { schedule: { time: '09:00', day: 'monday', date: '1' }, emailRecipients: [] };

function putBody(): Record<string, unknown> & { config: Record<string, unknown> } {
  const call = fetchWithAuth.mock.calls.find(
    ([url, init]) => url === '/reports/rep-1' && (init as RequestInit | undefined)?.method === 'PUT',
  );
  expect(call).toBeDefined();
  return JSON.parse(String((call![1] as RequestInit).body));
}
async function save() {
  fireEvent.click(await screen.findByTestId('report-builder-submit'));
  await waitFor(() =>
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true),
  );
}

describe('ReportEditPage — client_profitability save path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' });
    loaded = null;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports/rep-1' && !init?.method) {
        return Promise.resolve(
          loaded
            ? { ok: true, status: 200, json: () => Promise.resolve(loaded) }
            : { ok: false, status: 404, json: () => Promise.resolve({ error: 'Report not found' }) },
        );
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: {} }) });
    });
  });

  it('saves the changed rate and axis, keeps the stored currency, and drops refused selectors', async () => {
    loaded = {
      ...baseReport, orgId: null, partnerId: 'p-1',
      config: {
        dateRange: { preset: 'last_30_days' },
        period: { kind: 'last_30_days' },
        groupBy: 'organization',
        laborCostPerHour: { amount: '45', currencyCode: 'GBP' },
      },
    };
    render(<ReportEditPage reportId="rep-1" />);

    const amount = await screen.findByTestId('client-profitability-labor-amount');
    expect(amount).toHaveValue('45');
    expect(screen.getByTestId('client-profitability-labor-currency')).toHaveValue('GBP');
    const user = userEvent.setup();
    await user.clear(amount);
    await user.type(amount, '50.5');
    await user.selectOptions(screen.getByTestId('client-profitability-group-by'), 'source');
    await save();

    const expected = {
      period: { kind: 'last_30_days' },
      groupBy: 'source',
      laborCostPerHour: { amount: '50.5', currencyCode: 'GBP' },
      ...BUILDER_DELIVERY,
    };
    expect(putBody().config).toEqual(expected);
    expect(putBody()).toEqual({
      name: 'Client profitability', type: 'client_profitability', schedule: 'monthly', format: 'pdf', config: expected,
    });
  });

  it('disabling the labor rate removes laborCostPerHour from the saved config', async () => {
    loaded = {
      ...baseReport, orgId: 'org-1', partnerId: null,
      config: { period: { kind: 'last_full_month' }, laborCostPerHour: { amount: '45', currencyCode: 'USD' } },
    };
    render(<ReportEditPage reportId="rep-1" />);
    await userEvent.setup().click(await screen.findByTestId('client-profitability-labor-enabled'));
    await save();
    expect(putBody().config).toEqual({ period: { kind: 'last_full_month' }, ...BUILDER_DELIVERY });
    expect(putBody().config).not.toHaveProperty('laborCostPerHour');
    expect(putBody().config).not.toHaveProperty('groupBy');
  });

  it('an invalid labor amount disables Save', async () => {
    loaded = {
      ...baseReport, orgId: 'org-1', partnerId: null,
      config: { laborCostPerHour: { amount: '45', currencyCode: 'USD' } },
    };
    render(<ReportEditPage reportId="rep-1" />);
    const amount = await screen.findByTestId('client-profitability-labor-amount');
    await userEvent.setup().type(amount, '.999');
    await waitFor(() => expect(screen.getByTestId('report-builder-submit')).toBeDisabled());
  });

  it('hides the generic builder sections for this business type', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: {} };
    render(<ReportEditPage reportId="rep-1" />);
    await screen.findByTestId('client-profitability-group-by');
    expect(screen.queryByTestId('report-builder-generic-sections')).toBeNull();
  });
});
