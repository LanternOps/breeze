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
  name: 'MRR & renewals',
  type: 'mrr_renewals',
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

describe('ReportEditPage — mrr_renewals save path', () => {
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

  it('saves the chosen horizon and axis, and never writes asOf, period or a refused selector', async () => {
    loaded = {
      ...baseReport, orgId: null, partnerId: 'p-1',
      config: {
        dateRange: { preset: 'last_30_days' },
        period: { kind: 'last_30_days' },
        asOf: '2026-01-01',
        groupBy: 'organization',
        renewalHorizonDays: 90,
      },
    };
    render(<ReportEditPage reportId="rep-1" />);

    const horizon = await screen.findByTestId('mrr-renewals-horizon');
    expect(horizon).toHaveValue('90');
    const user = userEvent.setup();
    await user.selectOptions(horizon, '180');
    await user.selectOptions(screen.getByTestId('mrr-renewals-group-by'), 'contract');
    await save();

    const body = putBody();
    expect(body.config).toEqual({ groupBy: 'contract', renewalHorizonDays: 180, ...BUILDER_DELIVERY });
    expect(body).toEqual({
      name: 'MRR & renewals', type: 'mrr_renewals', schedule: 'monthly', format: 'pdf',
      config: { groupBy: 'contract', renewalHorizonDays: 180, ...BUILDER_DELIVERY },
    });
  });

  it('an unset config saves the defaults', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: {} };
    render(<ReportEditPage reportId="rep-1" />);
    await screen.findByTestId('mrr-renewals-horizon');
    await save();
    expect(putBody().config).toEqual({ groupBy: 'organization', renewalHorizonDays: 90, ...BUILDER_DELIVERY });
    expect(putBody().orgId).toBe('org-1');
  });

  it('hides the generic builder sections for this business type', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: {} };
    render(<ReportEditPage reportId="rep-1" />);
    await screen.findByTestId('mrr-renewals-group-by');
    expect(screen.queryByTestId('report-builder-generic-sections')).toBeNull();
  });
});
