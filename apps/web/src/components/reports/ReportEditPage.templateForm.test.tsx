import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #8796: a report created from a curated template opens on its edit page as
// that template's own form (its options panel) plus the delivery section, not
// the custom report builder (report type tiles, data source, columns, filters,
// grouping, chart type and the builder's device-summary live preview).
// The REAL ReportBuilder is rendered so the assertion is about what the user
// actually sees.
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

const OPTION_FIELD: Record<string, string> = {
  security_compliance_posture: 'posture-backup-required',
  hardware_lifecycle: 'lifecycle-replace-age-years',
  backup_status: 'backup-status-include-without-backup',
  threat_detection_review: 'threat-detection-top-incidents',
  endpoint_management_review: 'endpoint-management-stale-enrolment-days',
  vulnerability_management: 'vulnerability-severity-floor',
  identity_access_review: 'identity-access-dormant-days',
};

let loaded: Record<string, unknown>;

function storedReport(type: string, schedule = 'monthly') {
  return {
    id: 'rep-1',
    name: `${type} report`,
    type,
    schedule,
    format: 'pdf',
    orgId: 'org-7',
    partnerId: null,
    config: { dateRange: { preset: 'last_30_days' } },
    lastGeneratedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('ReportEditPage — template-born reports render their own form (#8796)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: null });
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports/rep-1' && !init?.method) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(loaded) });
      }
      if (url === '/orgs/organizations/org-7/contacts') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ id: 'c-1', name: 'Pat Owner', email: 'pat@acme.test' }] }),
        });
      }
      if (url === '/reports/rep-1/recipients') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [{ contactId: 'c-1' }] }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    });
  });

  it.each(Object.entries(OPTION_FIELD))('%s: options panel and delivery, no custom builder', async (type, optionTestId) => {
    loaded = storedReport(type);
    render(<ReportEditPage reportId="rep-1" />);

    expect(await screen.findByTestId(optionTestId)).toBeInTheDocument();
    expect(screen.queryByTestId('report-builder-generic-sections')).toBeNull();
    expect(screen.queryByTestId('report-builder-live-preview')).toBeNull();
    // The delivery section stays: the report's org contacts, ticked as stored.
    const contact = await screen.findByTestId('report-recipient-contact-c-1');
    expect(contact.querySelector('input')).toBeChecked();
    expect(screen.getByTestId('report-builder-submit')).toBeEnabled();
    // Nor is the hidden builder preview generated behind the user's back. The
    // builder debounces it by 300 ms; wait past that before asserting.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(fetchWithAuth.mock.calls.some(([url]) => url === '/reports/generate')).toBe(false);
  });

  it('saving still carries the template options under their own keys', async () => {
    loaded = storedReport('endpoint_management_review');
    render(<ReportEditPage reportId="rep-1" />);

    await screen.findByTestId('endpoint-management-stale-enrolment-days');
    fireEvent.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() =>
      expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true),
    );
    const put = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    const body = JSON.parse(String((put[1] as RequestInit).body));
    expect(body).toMatchObject({
      type: 'endpoint_management_review',
      schedule: 'monthly',
      orgId: 'org-7',
      config: { staleEnrolmentDays: 14, trendDays: 30, includeLicences: true, dateRange: { preset: 'last_30_days' } },
    });
  });

  it('a builder-representable report keeps the custom builder', async () => {
    loaded = storedReport('device_inventory');
    render(<ReportEditPage reportId="rep-1" />);

    expect(await screen.findByTestId('report-builder-generic-sections')).toBeInTheDocument();
    // The control for the no-generate assertion above: this one previews.
    await waitFor(() => expect(fetchWithAuth.mock.calls.some(([url]) => url === '/reports/generate')).toBe(true));
  });
});
