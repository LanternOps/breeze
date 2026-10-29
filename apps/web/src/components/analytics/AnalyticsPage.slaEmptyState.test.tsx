import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AnalyticsPage from './AnalyticsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

type Grant = { resource: string; action: string };
let grants: Grant[] | undefined = [];

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { permissions: grants } })
}));

const fetchMock = vi.mocked(fetchWithAuth);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const respond = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? 'Created' : 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body
  }) as unknown as Response;

let routes: Record<string, unknown> = {};
let posts: Array<{ url: string; body: Record<string, unknown> }> = [];

const ORG_WRITE: Grant = { resource: 'organizations', action: 'write' };

beforeEach(() => {
  routes = {};
  posts = [];
  grants = [ORG_WRITE];
  window.location.hash = 'sla';
  useOrgStore.setState({ currentOrgId: null, organizations: [] });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => {
    const path = String(input).split('?')[0]!;
    if (init?.method === 'POST' && path === '/analytics/sla') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url: String(input), body });
      // The created definition is what the next listing returns.
      routes['/analytics/sla'] = { data: [{ id: 'sla-new', name: body.name, uptimeTarget: body.uptimeTarget }] };
      routes['/analytics/sla/sla-new/compliance'] = {
        liveUptime: 100,
        uptimeTarget: body.uptimeTarget,
        exclusions: { weekends: body.excludeWeekends, maintenanceWindows: 'not_requested', excludedDevices: 0 }
      };
      return respond({ id: 'sla-new', name: body.name }, 201);
    }
    return respond(path in routes ? routes[path] : {});
  });
});

const settle = () => screen.findByText(/^Updated /);

describe('SLA tab without a definition (#9940)', () => {
  it('explains that no SLA definition exists instead of rendering nothing', async () => {
    routes['/analytics/sla'] = { data: [] };
    render(<AnalyticsPage />);
    await settle();
    const empty = screen.getByTestId('analytics-sla-empty');
    expect(within(empty).getByText('No SLA definition yet')).toBeInTheDocument();
    expect(screen.queryByText('SLA Compliance', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('does not show the empty state when the SLA listing failed to load', async () => {
    fetchMock.mockImplementation(async (input) => {
      const path = String(input).split('?')[0]!;
      if (path === '/analytics/sla') return respond({ error: 'boom' }, 500);
      return respond({});
    });
    render(<AnalyticsPage />);
    await settle();
    expect(screen.queryByTestId('analytics-sla-empty')).not.toBeInTheDocument();
  });

  it('creates an org-wide SLA definition from the empty state and then shows its card', async () => {
    routes['/analytics/sla'] = { data: [] };
    render(<AnalyticsPage />);
    await settle();

    fireEvent.click(screen.getByTestId('analytics-sla-create-open'));
    const form = screen.getByTestId('analytics-sla-create-form');
    fireEvent.change(within(form).getByTestId('analytics-sla-name'), { target: { value: '  Gold support ' } });
    fireEvent.change(within(form).getByTestId('analytics-sla-uptime-target'), { target: { value: '99.5' } });
    fireEvent.change(within(form).getByTestId('analytics-sla-window'), { target: { value: 'weekly' } });
    fireEvent.click(within(form).getByTestId('analytics-sla-exclude-weekends'));
    fireEvent.click(within(form).getByTestId('analytics-sla-create-submit'));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toEqual({
      name: 'Gold support',
      uptimeTarget: 99.5,
      measurementWindow: 'weekly',
      targetType: 'organization',
      excludeWeekends: true,
      excludeMaintenanceWindows: false
    });

    expect(await screen.findByText('SLA Compliance', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('Gold support')).toBeInTheDocument();
    expect(screen.queryByTestId('analytics-sla-empty')).not.toBeInTheDocument();
  });

  it('sends the selected org when the partner is scoped to one', async () => {
    routes['/analytics/sla'] = { data: [] };
    useOrgStore.setState({ currentOrgId: 'org-1', organizations: [] });
    render(<AnalyticsPage />);
    await settle();

    fireEvent.click(screen.getByTestId('analytics-sla-create-open'));
    expect(screen.queryByTestId('analytics-sla-org')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('analytics-sla-name'), { target: { value: 'Silver' } });
    fireEvent.click(screen.getByTestId('analytics-sla-create-submit'));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.orgId).toBe('org-1');
  });

  it('asks which organization when several are reachable and none is selected', async () => {
    routes['/analytics/sla'] = { data: [] };
    useOrgStore.setState({
      currentOrgId: null,
      organizations: [
        { id: 'org-a', name: 'Acme' },
        { id: 'org-b', name: 'Beta' }
      ] as never
    });
    render(<AnalyticsPage />);
    await settle();

    fireEvent.click(screen.getByTestId('analytics-sla-create-open'));
    fireEvent.change(screen.getByTestId('analytics-sla-name'), { target: { value: 'Silver' } });
    const submit = screen.getByTestId('analytics-sla-create-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('analytics-sla-org'), { target: { value: 'org-b' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body.orgId).toBe('org-b');
  });

  it('keeps the form open with what was typed when the create call fails', async () => {
    routes['/analytics/sla'] = { data: [] };
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'POST') {
        posts.push({ url: String(input), body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return respond({ error: 'MFA required' }, 403);
      }
      return base(input, init);
    });
    render(<AnalyticsPage />);
    await settle();
    const listingCalls = () =>
      fetchMock.mock.calls.filter(([u, i]) => String(u).split('?')[0] === '/analytics/sla' && !i?.method).length;
    const before = listingCalls();

    fireEvent.click(screen.getByTestId('analytics-sla-create-open'));
    fireEvent.change(screen.getByTestId('analytics-sla-name'), { target: { value: 'Gold' } });
    fireEvent.click(screen.getByTestId('analytics-sla-create-submit'));

    await waitFor(() => expect(posts).toHaveLength(1));
    // Submitting resets, so a retry is possible; nothing was reloaded.
    await waitFor(() => expect(screen.getByTestId('analytics-sla-create-submit')).not.toBeDisabled());
    expect(screen.getByTestId('analytics-sla-create-form')).toBeInTheDocument();
    expect(screen.getByTestId('analytics-sla-name')).toHaveValue('Gold');
    expect(listingCalls()).toBe(before);
  });

  it('blocks an out-of-range uptime target and omits a blank one', async () => {
    routes['/analytics/sla'] = { data: [] };
    render(<AnalyticsPage />);
    await settle();

    fireEvent.click(screen.getByTestId('analytics-sla-create-open'));
    fireEvent.change(screen.getByTestId('analytics-sla-name'), { target: { value: 'Gold' } });
    const target = screen.getByTestId('analytics-sla-uptime-target');
    const submit = screen.getByTestId('analytics-sla-create-submit');

    fireEvent.change(target, { target: { value: '101' } });
    expect(submit).toBeDisabled();
    expect(screen.getByTestId('analytics-sla-uptime-target-error')).toBeInTheDocument();
    expect(target).toHaveAttribute('aria-describedby', 'analytics-sla-uptime-target-error');

    fireEvent.change(target, { target: { value: '' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).not.toHaveProperty('uptimeTarget');
  });

  it('does not submit a whitespace-only name', async () => {
    routes['/analytics/sla'] = { data: [] };
    render(<AnalyticsPage />);
    await settle();

    fireEvent.click(screen.getByTestId('analytics-sla-create-open'));
    fireEvent.change(screen.getByTestId('analytics-sla-name'), { target: { value: '   ' } });
    expect(screen.getByTestId('analytics-sla-create-submit')).toBeDisabled();
  });

  it('keeps the create action out of reach without organization write access', async () => {
    routes['/analytics/sla'] = { data: [] };
    grants = [{ resource: 'devices', action: 'read' }];
    render(<AnalyticsPage />);
    await settle();

    expect(screen.getByTestId('analytics-sla-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('analytics-sla-create-open')).not.toBeInTheDocument();
    expect(screen.getByTestId('analytics-sla-no-permission')).toBeInTheDocument();
  });
});

describe('SLA card details (#9940)', () => {
  it('lists the exclusions the definition applies', async () => {
    routes['/analytics/sla'] = { data: [{ id: 'sla-1', name: 'Gold support', uptimeTarget: 99.5 }] };
    routes['/analytics/sla/sla-1/compliance'] = {
      liveUptime: 99.9,
      uptimeTarget: 99.5,
      exclusions: { weekends: true, maintenanceWindows: 'applied', excludedDevices: 2 }
    };
    render(<AnalyticsPage />);
    const list = await screen.findByTestId('analytics-sla-exclusions');
    expect(within(list).getByText('Weekends excluded')).toBeInTheDocument();
    expect(within(list).getByText('Maintenance windows excluded')).toBeInTheDocument();
  });

  it('says so when the definition applies no exclusions', async () => {
    routes['/analytics/sla'] = { data: [{ id: 'sla-1', name: 'Gold support', uptimeTarget: 99.5 }] };
    routes['/analytics/sla/sla-1/compliance'] = {
      liveUptime: 99.9,
      uptimeTarget: 99.5,
      exclusions: { weekends: false, maintenanceWindows: 'not_requested', excludedDevices: 0 }
    };
    render(<AnalyticsPage />);
    const list = await screen.findByTestId('analytics-sla-exclusions');
    expect(within(list).getByText('No exclusions')).toBeInTheDocument();
  });

  it('reports a maintenance exclusion the API could not apply', async () => {
    routes['/analytics/sla'] = { data: [{ id: 'sla-1', name: 'Gold support', uptimeTarget: 99.5 }] };
    routes['/analytics/sla/sla-1/compliance'] = {
      liveUptime: 99.9,
      uptimeTarget: 99.5,
      exclusions: { weekends: false, maintenanceWindows: 'skipped_too_many_devices', excludedDevices: 0 }
    };
    render(<AnalyticsPage />);
    const list = await screen.findByTestId('analytics-sla-exclusions');
    expect(within(list).getByText(/too many devices/i)).toBeInTheDocument();
  });

  it('does not claim exclusions the compliance route did not report', async () => {
    // The listing carries a figure; the live compliance call fails.
    routes['/analytics/sla'] = {
      data: [{ id: 'sla-1', name: 'Gold support', compliancePercentage: 99.9, uptimeTarget: 99.5, excludeMaintenanceWindows: true }]
    };
    fetchMock.mockImplementation(async (input) => {
      const path = String(input).split('?')[0]!;
      if (path === '/analytics/sla/sla-1/compliance') return respond({ error: 'boom' }, 500);
      return respond(path in routes ? routes[path] : {});
    });
    render(<AnalyticsPage />);
    expect(await screen.findByText('SLA Compliance', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByTestId('analytics-sla-exclusions')).not.toBeInTheDocument();
    expect(screen.queryByText('Maintenance windows excluded')).not.toBeInTheDocument();
  });

  it('reports a load failure, not nothing, when a definition yields no figure', async () => {
    routes['/analytics/sla'] = { data: [{ id: 'sla-1', name: 'Gold support', uptimeTarget: 99.5 }] };
    // 200 without a liveUptime field at all.
    routes['/analytics/sla/sla-1/compliance'] = { uptimeTarget: 99.5 };
    render(<AnalyticsPage />);
    await settle();
    expect(screen.getByText('Unable to load: sla')).toBeInTheDocument();
    expect(screen.queryByTestId('analytics-sla-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('analytics-sla-card')).not.toBeInTheDocument();
  });

  it('shows the definition card when it has no devices to measure yet', async () => {
    routes['/analytics/sla'] = { data: [{ id: 'sla-1', name: 'Gold support', uptimeTarget: 99.5 }] };
    routes['/analytics/sla/sla-1/compliance'] = {
      liveUptime: null,
      uptimeTarget: 99.5,
      exclusions: { weekends: false, maintenanceWindows: 'not_requested', excludedDevices: 0 }
    };
    render(<AnalyticsPage />);
    expect(await screen.findByText('Gold support')).toBeInTheDocument();
    expect(screen.getByText('No devices measured yet')).toBeInTheDocument();
    expect(screen.queryByTestId('analytics-sla-empty')).not.toBeInTheDocument();
    expect(screen.queryByText('Breach')).not.toBeInTheDocument();
  });
});
