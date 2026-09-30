import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ReportBuilder from './ReportBuilder';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { useOrgStore } from '../../stores/orgStore';
import { formatDateTime } from '@/lib/dateTimeFormat';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  // W03: the builder's Covers control reads the partner-wide gate
  // (useJwtClaims → useAuthStore). No token here, so the gate fails closed and
  // the builder offers one organization only — every existing assertion holds.
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({}) },
  ),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn()
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);
const navigateToMock = vi.mocked(navigateTo);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('ReportBuilder filter/grouping selects accessible name (#7156)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { rows: [] } }));
  });

  it('gives the group-by select a real accessible name', async () => {
    render(<ReportBuilder mode="builder" />);
    expect(await screen.findByRole('combobox', { name: 'Group by' })).toBeInTheDocument();
  });

  it('gives the default report type\'s data-source selects a real accessible name', async () => {
    render(<ReportBuilder mode="builder" />);
    expect(await screen.findByRole('combobox', { name: 'Device scope' })).toBeInTheDocument();
  });

  it('gives the aggregation and aggregation-field selects a real accessible name once a numeric aggregation is chosen', async () => {
    render(<ReportBuilder mode="builder" defaultValues={{ aggregation: { type: 'sum', field: 'duration' } }} />);
    expect(await screen.findByRole('combobox', { name: 'Aggregation' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Aggregation field' })).toBeInTheDocument();
  });

  it('gives the weekly schedule day-of-week select a real accessible name', async () => {
    render(<ReportBuilder mode="builder" defaultValues={{ schedule: 'weekly' }} />);
    expect(await screen.findByRole('combobox', { name: 'Day of week' })).toBeInTheDocument();
  });

  it('gives the monthly schedule day-of-month select a real accessible name', async () => {
    render(<ReportBuilder mode="builder" defaultValues={{ schedule: 'monthly' }} />);
    expect(await screen.findByRole('combobox', { name: 'Day of month' })).toBeInTheDocument();
  });

  it('gives the filter-condition logic/field/operator selects a real accessible name', async () => {
    render(
      <ReportBuilder
        mode="builder"
        defaultValues={{
          filterConditions: [
            { id: 'c1', field: 'hostname', operator: 'equals', value: 'a', logic: 'and' },
            { id: 'c2', field: 'hostname', operator: 'equals', value: 'b', logic: 'and' },
          ],
        }}
      />
    );
    expect(await screen.findByRole('combobox', { name: 'Filter logic' })).toBeInTheDocument();
    expect(screen.getAllByRole('combobox', { name: 'Filter field' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('combobox', { name: 'Filter operator' }).length).toBeGreaterThan(0);
  });
});

describe('ReportBuilder live preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The preview needs a known org (it waits while the org list loads).
    useOrgStore.setState({ currentOrgId: 'org-1' });
  });

  afterEach(() => {
    useOrgStore.setState({ currentOrgId: null });
  });

  it('renders live table rows from report API data', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: {
          rows: [
            {
              hostname: 'api-atlas-01',
              osType: 'windows',
              osVersion: '11',
              status: 'online',
              lastSeenAt: '2026-02-09T16:22:00.000Z'
            }
          ]
        }
      })
    );

    render(<ReportBuilder mode="builder" />);

    await screen.findByText('api-atlas-01');
    expect(screen.queryByText('atlas-01')).toBeNull();
  });

  // Pre-release sweep: Last seen printed "2026-09-29T18:28:51.233Z".
  it('formats timestamp cells with the app date formatter, not raw ISO', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: {
          rows: [{ hostname: 'api-atlas-01', osType: 'windows', osVersion: '11', status: 'online', lastSeenAt: '2026-02-09T16:22:00.000Z' }]
        }
      })
    );

    render(<ReportBuilder mode="builder" />);

    await screen.findByText('api-atlas-01');
    expect(screen.queryByText('2026-02-09T16:22:00.000Z')).toBeNull();
    expect(screen.getByText(formatDateTime('2026-02-09T16:22:00.000Z'))).toBeInTheDocument();
  });

  it('groups live API rows when group-by is selected', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: {
          rows: [
            { hostname: 'a-1', status: 'online', osType: 'windows', osVersion: '11' },
            { hostname: 'a-2', status: 'online', osType: 'windows', osVersion: '11' },
            { hostname: 'a-3', status: 'offline', osType: 'macos', osVersion: '14' }
          ]
        }
      })
    );

    render(<ReportBuilder mode="builder" />);

    await screen.findByText('a-1');

    fireEvent.change(screen.getByDisplayValue('No grouping'), {
      target: { value: 'status' }
    });

    await waitFor(() => {
      expect(screen.getAllByText('Count').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('online')).not.toBeNull();
  });

  it('renders chart series from live summary payload', async () => {
    fetchWithAuthMock.mockImplementation(async (_url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { type?: string } : {};

      if (body.type === 'alert_summary') {
        return makeJsonResponse({
          data: {
            rows: [{ severity: 'critical', status: 'open', title: 'CPU spike' }],
            summary: { urgentSpike: 7, triageBacklog: 2 }
          }
        });
      }

      return makeJsonResponse({
        data: {
          rows: [{ hostname: 'seed-device', status: 'online', osType: 'windows', osVersion: '11' }]
        }
      });
    });

    render(<ReportBuilder mode="builder" />);

    await screen.findByText('seed-device');

    fireEvent.click(screen.getByRole('button', { name: /alerts/i }));
    fireEvent.click(screen.getByRole('button', { name: /^bar$/i }));

    await waitFor(() => {
      expect(screen.queryByText('Urgent Spike')).not.toBeNull();
    });
    expect(screen.queryByText('Triage Backlog')).not.toBeNull();
  });
});

describe('ReportBuilder a11y (#7158)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { rows: [] } }));
  });

  it('gives the icon-only "remove field" chip button an accessible name', async () => {
    render(<ReportBuilder mode="builder" />);

    // `devices` is the default builder type; its default selected fields
    // include `hostname`, which the chip renders as "Hostname".
    expect(await screen.findByRole('button', { name: 'Remove Hostname' })).toBeInTheDocument();
  });

  it('links the schedule "Run time" input to its label', async () => {
    render(<ReportBuilder mode="builder" />);

    // Delivery/schedule section is shown for every mode except 'adhoc'.
    expect(await screen.findByLabelText('Run time')).toBeInTheDocument();
  });
});

describe('ReportBuilder config preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const putBody = () => {
    const call = fetchWithAuthMock.mock.calls.find(
      ([url, init]) => url === '/reports/report-1' && (init as RequestInit | undefined)?.method === 'PUT'
    );
    expect(call).toBeDefined();
    return JSON.parse(String((call![1] as RequestInit).body)) as {
      config: Record<string, unknown>;
    };
  };

  it('preserves config keys it does not own through an edit save', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: {} }));

    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        baseConfig={{
          backupRequired: false,
          includeCis: false,
          maxLocalAdmins: 4,
          sites: ['11111111-1111-4111-8111-111111111111']
        }}
        defaultValues={{ name: 'Workstation posture', type: 'security_compliance_posture' }}
      />
    );

    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    await waitFor(() => {
      const { config } = putBody();
      expect(config.backupRequired).toBe(false);
      expect(config.includeCis).toBe(false);
      expect(config.maxLocalAdmins).toBe(4);
      expect(config.sites).toEqual(['11111111-1111-4111-8111-111111111111']);
    });
  });

  it('lets current builder state win over stale baseConfig keys', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: {} }));

    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        baseConfig={{ builderType: 'activity', backupRequired: true }}
        defaultValues={{ name: 'Workstation posture', type: 'security_compliance_posture' }}
      />
    );

    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    await waitFor(() => {
      const { config } = putBody();
      // posture key survives, but the builder's own key reflects live state
      expect(config.backupRequired).toBe(true);
      expect(config.builderType).toBe('compliance');
    });
  });
});

describe('ReportBuilder business report save path (#3198 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' });
  });

  const putBody = () => {
    const call = fetchWithAuthMock.mock.calls.find(
      ([url, init]) => url === '/reports/report-1' && (init as RequestInit | undefined)?.method === 'PUT'
    );
    expect(call).toBeDefined();
    return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown> & {
      config: Record<string, unknown>;
    };
  };

  it('sends no dateRange/legacyFilters/refused selectors and keeps the baseConfig groupBy', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: {} }));

    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        baseConfig={{ groupBy: 'currency', asOf: '2026-08-31', filters: { siteIds: ['s-1'] } }}
        defaultValues={{
          name: 'AR',
          type: 'ar_aging',
          dateRange: { preset: 'last_30_days' },
          filters: { siteIds: ['s-1'] }
        }}
      />
    );

    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    // Exact: the business options from baseConfig (refused selectors dropped)
    // plus only the delivery keys the builder owns — none of its presentation
    // state (builderType, columns, dataSource, …), selectors or groupBy.
    await waitFor(() => expect(putBody()).toBeDefined());
    const body = putBody();
    const config = {
      groupBy: 'currency',
      asOf: '2026-08-31',
      schedule: { time: '09:00', day: 'monday', date: '1' },
      emailRecipients: [],
    };
    expect(body.config).toEqual(config);
    // schedule: the builder's default cadence when defaultValues carries none.
    expect(body).toEqual({ name: 'AR', type: 'ar_aging', schedule: 'weekly', format: 'pdf', orgId: 'org-1', config });
  });

  it('omits orgId entirely for a partner-owned report', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: {} }));

    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        partnerOwned
        baseConfig={{ groupBy: 'organization' }}
        defaultValues={{ name: 'AR', type: 'ar_aging' }}
      />
    );

    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    await waitFor(() => expect(putBody()).toBeDefined());
    expect(putBody()).toEqual({
      name: 'AR',
      type: 'ar_aging',
      schedule: 'weekly',
      format: 'pdf',
      config: { groupBy: 'organization', schedule: { time: '09:00', day: 'monday', date: '1' }, emailRecipients: [] },
    });
  });

  it('disables submit and sends nothing while submitBlocked', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: {} }));

    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        submitBlocked
        baseConfig={{}}
        defaultValues={{ name: 'SLA', type: 'ticket_sla_attainment' }}
      />
    );

    const submit = await screen.findByTestId('report-builder-submit');
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      fetchWithAuthMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    ).toBe(false);
  });
});

describe('ReportBuilder save feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts success and navigates to /reports on a 201 create with no onSubmit (the /reports/builder mount)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ data: { id: 'report-9' } }, true, 201)
    );

    render(<ReportBuilder mode="builder" defaultValues={{ name: 'Fleet health' }} />);

    fireEvent.change(screen.getByLabelText(/report name/i), {
      target: { value: 'Fleet health' }
    });
    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success' })
      );
    });
    expect(navigateToMock).toHaveBeenCalledWith('/reports');
  });

  it('does not navigate and shows no success toast when the save fails', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ error: 'boom' }, false, 500)
    );

    render(<ReportBuilder mode="builder" defaultValues={{ name: 'Fleet health' }} />);

    fireEvent.change(screen.getByLabelText(/report name/i), {
      target: { value: 'Fleet health' }
    });
    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      );
    });
    expect(navigateToMock).not.toHaveBeenCalledWith('/reports');
  });

  it('calls onSubmit instead of navigating when a caller provides it (create/edit pages)', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { id: 'report-9' } }, true, 201));
    const onSubmit = vi.fn();

    render(<ReportBuilder mode="create" defaultValues={{ name: 'Fleet health' }} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/report name/i), {
      target: { value: 'Fleet health' }
    });
    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(navigateToMock).not.toHaveBeenCalledWith('/reports');
  });
});

describe('ReportBuilder recipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' });
  });

  it('adds a contact and explicitly converts a legacy address', async () => {
    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url.includes('/orgs/organizations/org-1/contacts')) {
        return makeJsonResponse({
          data: [{
            id: 'contact-1',
            name: 'Alex Customer',
            email: 'alex@example.test'
          }]
        });
      }
      if (url.endsWith('/reports/report-1/recipients')) {
        if (init?.method === 'POST') {
          return makeJsonResponse({ data: { id: 'recipient-1' } }, true, 201);
        }
        return makeJsonResponse({ data: [] });
      }
      if (url.endsWith('/reports/report-1/recipients/convert')) {
        return makeJsonResponse({
          data: {
            id: 'contact-2',
            name: null,
            email: 'legacy@example.test'
          }
        }, true, 201);
      }
      return makeJsonResponse({});
    });

    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        defaultValues={{
          type: 'executive_summary',
          schedule: 'monthly',
          emailRecipients: ['legacy@example.test']
        }}
      />
    );

    await userEvent.click(
      await screen.findByTestId('report-recipient-contact-contact-1')
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      expect.stringContaining('/reports/report-1/recipients'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ contactId: 'contact-1' })
      })
    );

    await userEvent.click(
      screen.getByTestId('report-recipient-convert-legacy@example.test')
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      expect.stringContaining('/reports/report-1/recipients/convert'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'legacy@example.test' })
      })
    );
  });

  it('shows an error when contacts or recipients cannot be loaded', async () => {
    fetchWithAuthMock.mockImplementation(async url => {
      if (url.includes('/orgs/organizations/org-1/contacts')) {
        throw new Error('network unavailable');
      }
      if (url.endsWith('/reports/report-1/recipients')) {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({});
    });

    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        defaultValues={{ schedule: 'monthly' }}
      />
    );

    expect(
      await screen.findByText('Could not load the report recipients')
    ).toBeInTheDocument();
  });

  it('explains that MFA is required when legacy recipient conversion is rejected', async () => {
    fetchWithAuthMock.mockImplementation(async url => {
      if (url.includes('/orgs/organizations/org-1/contacts')) {
        return makeJsonResponse({ data: [] });
      }
      if (url.endsWith('/reports/report-1/recipients')) {
        return makeJsonResponse({ data: [] });
      }
      if (url.endsWith('/reports/report-1/recipients/convert')) {
        return makeJsonResponse(
          { error: 'MFA required', code: 'MFA_REQUIRED' },
          false,
          403
        );
      }
      return makeJsonResponse({});
    });

    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        defaultValues={{
          schedule: 'monthly',
          emailRecipients: ['legacy@example.test']
        }}
      />
    );

    await userEvent.click(
      await screen.findByTestId('report-recipient-convert-legacy@example.test')
    );

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith({
        type: 'error',
        message: 'Converting a recipient requires multi-factor authentication. Enable MFA in your profile and try again.'
      });
    });
  });
});

// Pre-release sweep: the edit page listed the HEADER org's contacts, so under
// All organizations it listed none (and under another org, the wrong org's).
describe('ReportBuilder edit: contacts come from the report\'s own org', () => {
  const contactsUrls = () =>
    fetchWithAuthMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/contacts'));

  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async url => {
      if (url.includes('/orgs/organizations/org-7/contacts')) {
        return makeJsonResponse({ data: [{ id: 'contact-7', name: 'Nora Northwind', email: 'nora@northwind.test' }] });
      }
      if (url.includes('/contacts')) return makeJsonResponse({ data: [] });
      if (url.endsWith('/reports/report-1/recipients')) return makeJsonResponse({ data: [] });
      return makeJsonResponse({ data: { rows: [] } });
    });
  });

  afterEach(() => {
    useOrgStore.setState({ currentOrgId: null });
  });

  it.each([
    ['All organizations', null],
    ['another org in the switcher', 'org-1'],
  ])('lists the report org\'s contacts under %s', async (_label, headerOrgId) => {
    useOrgStore.setState({ currentOrgId: headerOrgId });
    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        reportOrgId="org-7"
        defaultValues={{ type: 'device_inventory', schedule: 'monthly' }}
      />
    );

    expect(await screen.findByTestId('report-recipient-contact-contact-7')).toHaveTextContent('Nora Northwind');
    expect(contactsUrls()).toEqual(['/orgs/organizations/org-7/contacts']);
    const [, init] = fetchWithAuthMock.mock.calls.find(([url]) => String(url).includes('/contacts'))!;
    expect(init).toMatchObject({ orgIdOverride: 'org-7' });
  });
});

describe('ReportBuilder contact recipients refusal (#3198 W03, ruling W5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' });
    fetchWithAuthMock.mockImplementation(async url => {
      if (url.includes('/contacts')) {
        return makeJsonResponse({ data: [{ id: 'contact-1', name: 'Alex', email: 'alex@example.test' }] });
      }
      if (url.endsWith('/reports/report-1/recipients')) return makeJsonResponse({ data: [] });
      return makeJsonResponse({ data: { rows: [] } });
    });
  });

  const contactsFetched = () =>
    fetchWithAuthMock.mock.calls.some(([url]) => String(url).includes('/contacts') || String(url).endsWith('/recipients'));

  it('skips the contact fetch and explains email-only delivery for a business report type', async () => {
    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        defaultValues={{ type: 'ar_aging', schedule: 'monthly', emailRecipients: ['cfo@example.test'] }}
      />
    );

    const note = await screen.findByTestId('report-partner-recipients-note');
    expect(note).toHaveTextContent('Business reports are delivered only to the email addresses below');
    expect(contactsFetched()).toBe(false);
    expect(screen.queryByTestId('report-recipient-contact-contact-1')).toBeNull();
    // The contact convert action would 409 too; the free-text list stays.
    expect(screen.queryByTestId('report-recipient-convert-cfo@example.test')).toBeNull();
    expect(screen.getByText('cfo@example.test')).toBeInTheDocument();
  });

  it('skips the contact fetch and explains email-only delivery for a partner-owned report', async () => {
    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        partnerOwned
        defaultValues={{ type: 'executive_summary', schedule: 'monthly' }}
      />
    );

    const note = await screen.findByTestId('report-partner-recipients-note');
    expect(note).toHaveTextContent(/covers all organizations/);
    expect(note).not.toHaveTextContent('Business reports');
    expect(contactsFetched()).toBe(false);
  });

  it('still adds free-text email recipients when contacts are refused', async () => {
    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        defaultValues={{ type: 'ticket_sla_attainment', schedule: 'monthly' }}
      />
    );
    await screen.findByTestId('report-partner-recipients-note');
    await userEvent.type(screen.getByPlaceholderText(/@/), 'ops@example.test');
    await userEvent.click(screen.getByRole('button', { name: /add recipient/i }));
    expect(await screen.findByText('ops@example.test')).toBeInTheDocument();
  });

  it('still fetches contacts for an org-owned non-business report', async () => {
    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        defaultValues={{ type: 'executive_summary', schedule: 'monthly' }}
      />
    );
    expect(await screen.findByTestId('report-recipient-contact-contact-1')).toBeInTheDocument();
    expect(contactsFetched()).toBe(true);
    expect(screen.queryByTestId('report-partner-recipients-note')).toBeNull();
  });
});

describe('ReportBuilder org picker under All organizations (multi-org series W01)', () => {
  const orgs = [
    { id: 'org-a', partnerId: 'p-1', name: 'Acme Dental', status: 'active' as const, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'org-b', partnerId: 'p-1', name: 'Bravo Law', status: 'active' as const, createdAt: '2026-01-01T00:00:00Z' },
  ];
  const postCalls = () =>
    fetchWithAuthMock.mock.calls.filter(
      ([url, init]) => url === '/reports' && (init as RequestInit | undefined)?.method === 'POST'
    );

  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: null, organizations: orgs });
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { id: 'report-9' } }, true, 201));
  });

  afterEach(() => {
    useOrgStore.setState({ currentOrgId: null, organizations: [] });
  });

  it('blocks submit client-side with no org chosen: no POST /reports and no preview request (no 400 is reached)', async () => {
    render(<ReportBuilder mode="create" defaultValues={{ name: 'Fleet health' }} onSubmit={vi.fn()} />);

    expect(await screen.findByTestId('report-org-picker')).toBeInTheDocument();
    expect(await screen.findByText('Choose an organization to see a live preview.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('report-builder-submit'));

    expect(await screen.findByText('Choose an organization before saving this report.')).toBeInTheDocument();
    // Past the live preview's 300 ms debounce: it was never scheduled.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(postCalls()).toHaveLength(0);
    expect(fetchWithAuthMock.mock.calls.some(([url]) => url === '/reports/generate')).toBe(false);
  });

  it('posts the picked org in the body — the only org carrier for a create', async () => {
    render(<ReportBuilder mode="create" defaultValues={{ name: 'Fleet health' }} onSubmit={vi.fn()} />);

    await userEvent.setup().selectOptions(await screen.findByTestId('report-org-picker-select'), 'org-b');
    fireEvent.click(screen.getByTestId('report-builder-submit'));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [, init] = postCalls()[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ orgId: 'org-b' });
    // No pin/skip flag: fetchWithAuth's ambient ?orgId= is absent under All
    // organizations and the create route reads the JSON body only.
    expect(init).not.toHaveProperty('orgIdOverride');
    expect(init).not.toHaveProperty('skipOrgIdInjection');
  });

  it('hides the picker and uses the focused org when the switcher names one', async () => {
    useOrgStore.setState({ currentOrgId: 'org-a' });
    render(<ReportBuilder mode="create" defaultValues={{ name: 'Fleet health' }} onSubmit={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(screen.queryByTestId('report-org-picker')).toBeNull();
    expect(JSON.parse(String((postCalls()[0]![1] as RequestInit).body))).toMatchObject({ orgId: 'org-a' });
  });

  it('never shows the picker when editing an existing report', async () => {
    render(<ReportBuilder mode="edit" reportId="rep-1" defaultValues={{ name: 'Fleet health' }} onSubmit={vi.fn()} />);

    expect(await screen.findByTestId('report-builder-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('report-org-picker')).toBeNull();
  });
});

// Pre-release sweep: on first load under All organizations the live preview
// POSTed /reports/generate with no org before the org list arrived (400
// "orgId is required when partner has multiple organizations"), and the edit
// page previewed the header org instead of the report's own.
describe('ReportBuilder live preview waits until the org is known', () => {
  const orgA = { id: 'org-a', partnerId: 'p-1', name: 'Acme Dental', status: 'active' as const, createdAt: '2026-01-01T00:00:00Z' };
  const orgB = { id: 'org-b', partnerId: 'p-1', name: 'Bravo Law', status: 'active' as const, createdAt: '2026-01-01T00:00:00Z' };
  const generateBodies = () =>
    fetchWithAuthMock.mock.calls
      .filter(([url]) => url === '/reports/generate')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { rows: [] } }));
    useOrgStore.setState({ currentOrgId: null, organizations: [], organizationsLoaded: false, error: null });
  });

  afterEach(() => {
    useOrgStore.setState({ currentOrgId: null, organizations: [], organizationsLoaded: false, error: null });
  });

  it('sends no preview before the org list arrives, then previews the org it resolves to', async () => {
    render(<ReportBuilder mode="create" defaultValues={{ name: 'Fleet health' }} onSubmit={vi.fn()} />);

    // Past the 300 ms debounce: nothing was sent with an unknown org.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(generateBodies()).toHaveLength(0);

    act(() => useOrgStore.setState({ organizations: [orgA], organizationsLoaded: true }));

    await waitFor(() => expect(generateBodies()).toHaveLength(1));
    expect(generateBodies()[0]).toMatchObject({ orgId: 'org-a' });
  });

  it("previews an edited report for its own org under All organizations, without waiting for the org list", async () => {
    useOrgStore.setState({ organizations: [orgA, orgB] });
    render(
      <ReportBuilder mode="edit" reportId="report-1" reportOrgId="org-b" defaultValues={{ name: 'Fleet health', schedule: 'monthly' }} />
    );

    await waitFor(() => expect(generateBodies()).toHaveLength(1));
    expect(generateBodies()[0]).toMatchObject({ orgId: 'org-b' });
  });
});

// Pre-release sweep: the builder had no one-time option and silently turned a
// one-time report Weekly (`schedule: 'weekly'` in the PUT) the first time its
// edit page was saved. The loaded schedule is kept unless the user changes it.
describe('ReportBuilder keeps a one-time schedule', () => {
  const putBody = () => {
    const call = fetchWithAuthMock.mock.calls.find(
      ([url, init]) => url === '/reports/report-1' && (init as RequestInit | undefined)?.method === 'PUT'
    );
    expect(call).toBeDefined();
    return JSON.parse(String((call![1] as RequestInit).body)) as Record<string, unknown>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' });
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { rows: [] } }));
  });

  afterEach(() => {
    useOrgStore.setState({ currentOrgId: null });
  });

  const renderOneTime = () =>
    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        reportOrgId="org-1"
        defaultValues={{ name: 'Backups', type: 'backup_status', schedule: 'one_time' }}
      />
    );

  it('saves an untouched one-time report as one-time', async () => {
    renderOneTime();

    fireEvent.click(await screen.findByTestId('report-builder-submit'));

    await waitFor(() => expect(putBody()).toMatchObject({ schedule: 'one_time' }));
  });

  it('shows the one-time option selected', async () => {
    renderOneTime();

    expect(await screen.findByRole('button', { name: 'One-time' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Weekly' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('saves the recurring schedule the user picks instead', async () => {
    renderOneTime();

    fireEvent.click(await screen.findByRole('button', { name: 'Monthly' }));
    fireEvent.click(screen.getByTestId('report-builder-submit'));

    await waitFor(() => expect(putBody()).toMatchObject({ schedule: 'monthly' }));
  });

  // Review follow-up: the contacts load skips one-time reports (they are never
  // emailed), which left an empty "Organization contacts" list.
  it('says a one-time report is not emailed instead of showing an empty contacts list', async () => {
    renderOneTime();

    expect(await screen.findByTestId('report-one-time-recipients-note'))
      .toHaveTextContent("One-time reports aren't emailed. Choose a recurring schedule to send this report to contacts.");
    expect(screen.queryByText('Organization contacts')).toBeNull();
    expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url).includes('/contacts'))).toBe(false);
  });

  it('offers no one-time option to a recurring report', async () => {
    render(
      <ReportBuilder
        mode="edit"
        reportId="report-1"
        reportOrgId="org-1"
        defaultValues={{ name: 'Weekly devices', type: 'device_inventory', schedule: 'weekly' }}
      />
    );

    expect(await screen.findByRole('button', { name: 'Weekly' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'One-time' })).toBeNull();
  });
});
