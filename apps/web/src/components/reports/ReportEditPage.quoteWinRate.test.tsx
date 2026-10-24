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

import ReportEditPage from './ReportEditPage';
import { useOrgStore } from '../../stores/orgStore';

const baseReport = {
  id: 'rep-1',
  name: 'Quote win rate',
  type: 'quote_win_rate',
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

describe('ReportEditPage — quote_win_rate save path', () => {
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

  it('saves the chosen axis and period, and never writes a refused selector or a stale groupBy', async () => {
    loaded = {
      ...baseReport, orgId: null, partnerId: 'p-1',
      config: {
        dateRange: { preset: 'last_30_days' },
        period: { kind: 'last_30_days' },
        groupBy: 'organization',
      },
    };
    render(<ReportEditPage reportId="rep-1" />);

    const groupBy = await screen.findByTestId('quote-win-rate-group-by');
    expect(groupBy).toHaveValue('organization');
    expect(screen.getByTestId('quote-win-rate-period')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(groupBy, 'author');
    await save();

    const body = putBody();
    expect(body.config).toEqual({ period: { kind: 'last_30_days' }, groupBy: 'author', ...BUILDER_DELIVERY });
    expect(body).toEqual({
      name: 'Quote win rate', type: 'quote_win_rate', schedule: 'monthly', format: 'pdf',
      config: { period: { kind: 'last_30_days' }, groupBy: 'author', ...BUILDER_DELIVERY },
    });
  });

  it('Automatic omits groupBy so the stored row cannot keep a stale axis', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: { groupBy: 'currency' } };
    render(<ReportEditPage reportId="rep-1" />);
    const groupBy = await screen.findByTestId('quote-win-rate-group-by');
    await userEvent.setup().selectOptions(groupBy, '');
    await save();
    expect(putBody().config).toEqual({ period: { kind: 'last_full_month' }, ...BUILDER_DELIVERY });
    expect(putBody().orgId).toBe('org-1');
  });

  it('an unset config saves the defaults', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: {} };
    render(<ReportEditPage reportId="rep-1" />);
    await screen.findByTestId('quote-win-rate-group-by');
    await save();
    expect(putBody().config).toEqual({ period: { kind: 'last_full_month' }, ...BUILDER_DELIVERY });
  });

  it('hides the generic builder sections for this business type', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: {} };
    render(<ReportEditPage reportId="rep-1" />);
    await screen.findByTestId('quote-win-rate-group-by');
    expect(screen.queryByTestId('report-builder-generic-sections')).toBeNull();
  });
});
