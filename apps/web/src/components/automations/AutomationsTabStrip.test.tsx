import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { i18n } from '@/lib/i18n';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (s: { user: null }) => unknown) => selector({ user: null }),
    { getState: () => ({ tokens: null }) },
  ),
}));

import AutomationsTabStrip from './AutomationsTabStrip';
import { useFeaturesStore } from '../../stores/featuresStore';

function mockApi(opts: { flows: boolean; list?: unknown; listOk?: boolean }) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/config') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ features: { flows: opts.flows } }) } as Response);
    }
    if (url === '/automations?limit=1') {
      return Promise.resolve({
        ok: opts.listOk ?? true,
        status: opts.listOk === false ? 500 : 200,
        json: async () => opts.list ?? { data: [] },
      } as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  });
}

describe('AutomationsTabStrip', () => {
  beforeEach(async () => {
    fetchWithAuthMock.mockReset();
    useFeaturesStore.setState({
      features: { ...useFeaturesStore.getState().features, flows: false },
      loaded: false,
    });
    window.history.replaceState(null, '', '/');
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    // replaceState, not `location.hash =`: assigning the hash emits a popstate
    // that would reset the strip's path mid-test.
    window.history.replaceState(null, '', '/');
  });

  it('the strip marks /jobs active and keeps the Jobs page hash', async () => {
    window.history.replaceState(null, '', '/#convert-abc');
    mockApi({ flows: true });
    render(<AutomationsTabStrip currentPath="/jobs" />);
    const jobs = await screen.findByTestId('automations-tab-jobs');
    expect(jobs.getAttribute('aria-current')).toBe('page');
    expect(jobs.getAttribute('href')).toBe('/jobs');
    expect(screen.getByTestId('automations-tab-flows').getAttribute('aria-current')).toBeNull();
    // The strip never touches the Jobs page's own hash tabs or #convert-<id>.
    expect(window.location.hash).toBe('#convert-abc');
  });

  it('marks Flows active on /flows and on its sub-pages, Flows tab first', async () => {
    mockApi({ flows: true });
    render(<AutomationsTabStrip currentPath="/flows/runs/abc" />);
    const flows = await screen.findByTestId('automations-tab-flows');
    expect(flows.getAttribute('aria-current')).toBe('page');
    expect(flows.getAttribute('href')).toBe('/flows');
    expect(screen.getByTestId('automations-tab-jobs').getAttribute('aria-current')).toBeNull();
    const order = screen.getAllByRole('link').map((a) => a.getAttribute('data-testid'));
    expect(order.slice(0, 2)).toEqual(['automations-tab-flows', 'automations-tab-jobs']);
  });

  it('the Flows tab is hidden when Flows is off', async () => {
    mockApi({ flows: false });
    render(<AutomationsTabStrip currentPath="/jobs" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/config', expect.anything()));
    expect(await screen.findByTestId('automations-tab-jobs')).toBeTruthy();
    expect(screen.queryByTestId('automations-tab-flows')).toBeNull();
    expect(screen.queryByTestId('automations-tab-preview')).toBeNull();
  });

  it('the Flows tab is hidden until the gate has loaded (fails closed)', async () => {
    // Hold /config open. The store keeps one in-flight load across tests, so
    // the request is released at the end rather than left pending.
    let release: (r: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => { release = resolve; });
    fetchWithAuthMock.mockImplementation((url: string) =>
      url === '/config'
        ? held
        : Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response),
    );
    render(<AutomationsTabStrip currentPath="/jobs" />);
    expect(screen.queryByTestId('automations-tab-flows')).toBeNull();
    expect(screen.getByTestId('automations-tab-jobs')).toBeTruthy();
    release({ ok: true, status: 200, json: async () => ({ features: { flows: false } }) } as Response);
    await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
  });

  it('the Flows tab carries the Preview tag, and the Jobs tab does not', async () => {
    mockApi({ flows: true });
    render(<AutomationsTabStrip currentPath="/flows" />);
    const tag = await screen.findByTestId('automations-tab-preview');
    expect(tag.textContent).toBe('Preview');
    expect(screen.getByTestId('automations-tab-flows').contains(tag)).toBe(true);
    expect(screen.getByTestId('automations-tab-jobs').querySelector('[data-testid="automations-tab-preview"]')).toBeNull();
  });

  it('the Jobs tab shows the not-moved count when the API sends it and no count otherwise', async () => {
    mockApi({ flows: true, list: { data: [], jobCounts: { notMoved: 7 } } });
    const first = render(<AutomationsTabStrip currentPath="/jobs" />);
    await waitFor(() => expect(screen.getByTestId('automations-tab-jobs-count').textContent).toBe('7'));
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/automations?limit=1');
    first.unmount();

    mockApi({ flows: true, list: { data: [] } });
    render(<AutomationsTabStrip currentPath="/jobs" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/automations?limit=1'));
    await screen.findByTestId('automations-tab-jobs');
    expect(screen.queryByTestId('automations-tab-jobs-count')).toBeNull();
  });

  it('renders no count when the list request fails or the field is malformed', async () => {
    mockApi({ flows: true, listOk: false });
    const first = render(<AutomationsTabStrip currentPath="/jobs" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/automations?limit=1'));
    await screen.findByTestId('automations-tab-jobs');
    expect(screen.queryByTestId('automations-tab-jobs-count')).toBeNull();
    first.unmount();

    mockApi({ flows: true, list: { data: [], jobCounts: { notMoved: 'many' } } });
    render(<AutomationsTabStrip currentPath="/jobs" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith('/automations?limit=1'));
    await screen.findByTestId('automations-tab-jobs');
    expect(screen.queryByTestId('automations-tab-jobs-count')).toBeNull();
  });

  it('labels the strip with the new section label', async () => {
    mockApi({ flows: true });
    render(<AutomationsTabStrip currentPath="/jobs" />);
    expect(await screen.findByRole('navigation', { name: 'Automations sections' })).toBeTruthy();
  });
});
