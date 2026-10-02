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
  name: 'AI usage',
  type: 'ai_usage_by_client',
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

describe('ReportEditPage — ai_usage_by_client save path (#7608 W10)', () => {
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

  it('partner-owned report: the form axis wins, the PUT carries no orgId and no refused selector', async () => {
    loaded = {
      ...baseReport, orgId: null, partnerId: 'p-1',
      config: { dateRange: { preset: 'last_30_days' }, period: { kind: 'last_30_days' }, groupBy: 'organization' },
    };
    render(<ReportEditPage reportId="rep-1" />);

    const groupBy = await screen.findByTestId('ai-usage-by-client-group-by');
    expect(groupBy).toHaveValue('organization');
    await userEvent.setup().selectOptions(groupBy, 'model');
    await save();

    const body = putBody();
    expect(body.config).toEqual({ period: { kind: 'last_30_days' }, groupBy: 'model', ...BUILDER_DELIVERY });
    expect(body).toEqual({
      name: 'AI usage', type: 'ai_usage_by_client', schedule: 'monthly', format: 'pdf',
      config: { period: { kind: 'last_30_days' }, groupBy: 'model', ...BUILDER_DELIVERY },
    });
  });

  it('Automatic drops a previously stored groupBy instead of letting it survive', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: { groupBy: 'model' } };
    render(<ReportEditPage reportId="rep-1" />);

    await userEvent.setup().selectOptions(await screen.findByTestId('ai-usage-by-client-group-by'), '');
    await save();

    expect(putBody().config).toEqual({ period: { kind: 'last_full_month' }, ...BUILDER_DELIVERY });
    expect(putBody().orgId).toBe('org-1');
  });

  it('blocks the save while the custom period is half-filled; no PUT reaches the API', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: {} };
    render(<ReportEditPage reportId="rep-1" />);

    await userEvent.setup().selectOptions(await screen.findByTestId('report-period-kind'), 'custom');
    fireEvent.change(screen.getByTestId('report-period-start'), { target: { value: '2026-08-01' } });

    const submit = await screen.findByTestId('report-builder-submit');
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  it('hides the generic builder sections for this business type', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: {} };
    render(<ReportEditPage reportId="rep-1" />);
    await screen.findByTestId('ai-usage-by-client-group-by');
    expect(screen.queryByTestId('report-builder-generic-sections')).toBeNull();
  });
});
