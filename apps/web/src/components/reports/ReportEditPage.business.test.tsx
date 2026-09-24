import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The REAL ReportBuilder is rendered here (unlike ReportEditPage.posture.test,
// which stubs it): the bug this file pins is the builder's own save path
// overwriting the business options with builder state (#3198 W03 ruling W4).
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportEditPage from './ReportEditPage';
import { useOrgStore } from '../../stores/orgStore';

type StoredReport = {
  id: string;
  name: string;
  type: string;
  schedule: string;
  format: string;
  orgId: string | null;
  partnerId: string | null;
  config: Record<string, unknown>;
  portalSelfService: boolean;
  lastGeneratedAt: null;
  createdAt: string;
  updatedAt: string;
};

const baseReport = {
  id: 'rep-1',
  schedule: 'monthly',
  format: 'pdf',
  portalSelfService: false,
  lastGeneratedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
} as const;

let loaded: StoredReport | null;

/** The two keys the builder legitimately contributes to a business config:
 *  the cadence detail the schedule worker reads, and the free-text email
 *  recipients (the only delivery path for business types). Defaults here. */
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
    expect(
      fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT'),
    ).toBe(true),
  );
}

describe('ReportEditPage — business report save path (#3198 W03)', () => {
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

  it('org-owned SLA report: the form axis wins, no dateRange/legacyFilters, orgId allowed', async () => {
    loaded = {
      ...baseReport,
      name: 'SLA',
      type: 'ticket_sla_attainment',
      orgId: 'org-1',
      partnerId: null,
      config: { period: { kind: 'last_30_days' }, groupBy: 'category', includeNoSla: false },
    };
    render(<ReportEditPage reportId="rep-1" />);

    const groupBy = await screen.findByTestId('ticket-sla-group-by');
    expect(groupBy).toHaveValue('category');
    await userEvent.setup().selectOptions(groupBy, 'technician');
    await save();

    // Exact body: an allowlist, not a denylist — any key the builder leaks
    // (dateRange, legacyFilters, a builder groupBy, …) fails here.
    const body = putBody();
    expect(body.config).toEqual({ period: { kind: 'last_30_days' }, groupBy: 'technician', includeNoSla: false, ...BUILDER_DELIVERY });
    expect(body).toEqual({
      name: 'SLA',
      type: 'ticket_sla_attainment',
      schedule: 'monthly',
      format: 'pdf',
      orgId: 'org-1',
      config: { period: { kind: 'last_30_days' }, groupBy: 'technician', includeNoSla: false, ...BUILDER_DELIVERY },
    });
  });

  it('Automatic SLA axis drops a previously stored groupBy instead of letting it survive', async () => {
    loaded = {
      ...baseReport,
      name: 'SLA',
      type: 'ticket_sla_attainment',
      orgId: 'org-1',
      partnerId: null,
      config: { groupBy: 'priority' },
    };
    render(<ReportEditPage reportId="rep-1" />);

    await userEvent.setup().selectOptions(await screen.findByTestId('ticket-sla-group-by'), '');
    await save();

    expect(putBody().config).toEqual({ period: { kind: 'last_full_month' }, includeNoSla: true, ...BUILDER_DELIVERY });
  });

  it('strips a legacy selector stored on a business report so the save does not 400', async () => {
    loaded = {
      ...baseReport,
      name: 'Tech time',
      type: 'technician_time_billability',
      orgId: 'org-1',
      partnerId: null,
      config: { dateRange: { preset: 'last_30_days' }, filters: { siteIds: ['s-1'] }, weeklyCapacityHours: 37.5 },
    };
    render(<ReportEditPage reportId="rep-1" />);

    expect(await screen.findByTestId('technician-time-capacity-hours')).toHaveValue(37.5);
    await save();

    const body = putBody();
    expect(body.config).toEqual({ period: { kind: 'last_full_month' }, groupBy: 'technician', weeklyCapacityHours: 37.5, ...BUILDER_DELIVERY });
    expect(body).toEqual({
      name: 'Tech time',
      type: 'technician_time_billability',
      schedule: 'monthly',
      format: 'pdf',
      orgId: 'org-1',
      config: { period: { kind: 'last_full_month' }, groupBy: 'technician', weeklyCapacityHours: 37.5, ...BUILDER_DELIVERY },
    });
  });

  it('partner-owned AR report: the PUT carries NO orgId key at all (any orgId is 400 report_ownership_immutable)', async () => {
    loaded = {
      ...baseReport,
      name: 'AR',
      type: 'ar_aging',
      orgId: null,
      partnerId: 'p-1',
      config: { asOf: '2026-08-31', groupBy: 'currency' },
    };
    render(<ReportEditPage reportId="rep-1" />);

    expect(await screen.findByTestId('ar-aging-as-of')).toHaveValue('2026-08-31');
    await save();

    const body = putBody();
    expect(body.config).toEqual({ asOf: '2026-08-31', groupBy: 'currency', includePaidInPeriod: false, ...BUILDER_DELIVERY });
    // No orgId key at all.
    expect(body).toEqual({
      name: 'AR',
      type: 'ar_aging',
      schedule: 'monthly',
      format: 'pdf',
      config: { asOf: '2026-08-31', groupBy: 'currency', includePaidInPeriod: false, ...BUILDER_DELIVERY },
    });
  });

  it('blocks the save while a business option is invalid: a half-filled custom period sends no PUT', async () => {
    loaded = {
      ...baseReport,
      name: 'SLA',
      type: 'ticket_sla_attainment',
      orgId: 'org-1',
      partnerId: null,
      config: {},
    };
    render(<ReportEditPage reportId="rep-1" />);

    await userEvent.setup().selectOptions(await screen.findByTestId('report-period-kind'), 'custom');
    fireEvent.change(screen.getByTestId('report-period-start'), { target: { value: '2026-08-01' } });

    const submit = await screen.findByTestId('report-builder-submit');
    expect(submit).toBeDisabled();
    // Even a forced form submission must not reach the API.
    fireEvent.submit(submit.closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT'),
    ).toBe(false);

    fireEvent.change(screen.getByTestId('report-period-end'), { target: { value: '2026-08-31' } });
    expect(screen.getByTestId('report-builder-submit')).toBeEnabled();
  });

  it('hides the generic builder sections (report type/data source/columns/filters/grouping/chart) for a business type (sweep B1)', async () => {
    loaded = {
      ...baseReport,
      name: 'AR',
      type: 'ar_aging',
      orgId: 'org-1',
      partnerId: null,
      config: { asOf: '2026-08-31', groupBy: 'currency' },
    };
    render(<ReportEditPage reportId="rep-1" />);

    await screen.findByTestId('ar-aging-as-of');
    expect(screen.queryByTestId('report-builder-generic-sections')).toBeNull();
  });

  it('renders a not-found state when GET /reports/:id is a 404 (hidden type or missing permission)', async () => {
    loaded = null;
    render(<ReportEditPage reportId="rep-1" />);

    const notFound = await screen.findByTestId('report-edit-not-found');
    expect(notFound).toHaveTextContent(/not found/i);
    expect(screen.getByTestId('report-edit-back')).toHaveAttribute('href', '/reports');
    expect(screen.queryByTestId('report-builder-submit')).toBeNull();
  });
});
