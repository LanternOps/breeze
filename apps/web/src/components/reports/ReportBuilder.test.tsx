import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ReportBuilder from './ReportBuilder';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn()
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

describe('ReportBuilder live preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
