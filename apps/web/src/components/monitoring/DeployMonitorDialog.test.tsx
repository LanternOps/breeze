import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeployMonitorDialog from './DeployMonitorDialog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-store-1' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('DeployMonitorDialog (#5289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/configuration-policies')) return json({ data: [{ id: 'cp1', name: 'Site Policy' }] });
      if (input.startsWith('/orgs/sites')) return json({ data: [{ id: 'site-1', name: 'HQ' }] });
      if (input.startsWith('/groups')) return json({ data: [{ id: 'group-1', name: 'Workstations' }] });
      return json({ data: [] });
    });
  });

  it('posts { configPolicyId } for the existing-policy path', async () => {
    const onDeployed = vi.fn();
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json({}, true, 201);
      if (input.startsWith('/configuration-policies')) return json({ data: [{ id: 'cp1', name: 'Site Policy' }] });
      return json({ data: [] });
    });
    render(<DeployMonitorDialog monitorId="m1" open onClose={vi.fn()} onDeployed={onDeployed} />);
    await waitFor(() => expect(screen.getByTestId('deploy-monitor-existing-select')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('deploy-monitor-existing-select'), { target: { value: 'cp1' } });
    fireEvent.click(screen.getByTestId('deploy-monitor-submit'));

    await waitFor(() => expect(onDeployed).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toEqual({ configPolicyId: 'cp1' });
  });

  it('posts { createPolicyFor } for the create-new-policy path', async () => {
    const onDeployed = vi.fn();
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json({}, true, 201);
      if (input.startsWith('/orgs/sites')) return json({ data: [{ id: 'site-1', name: 'HQ' }] });
      return json({ data: [] });
    });
    render(<DeployMonitorDialog monitorId="m1" open onClose={vi.fn()} onDeployed={onDeployed} />);
    await waitFor(() => expect(screen.getByTestId('deploy-monitor-mode-new')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('deploy-monitor-mode-new'));
    fireEvent.change(screen.getByTestId('deploy-monitor-level-select'), { target: { value: 'site' } });
    fireEvent.change(screen.getByTestId('deploy-monitor-target-select'), { target: { value: 'site-1' } });
    fireEvent.click(screen.getByTestId('deploy-monitor-submit'));

    await waitFor(() => expect(onDeployed).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.createPolicyFor).toEqual({ level: 'site', targetId: 'site-1', name: 'Monitors — HQ' });
  });

  it('sends the monitor org id as targetId at organization level for an org-owned monitor', async () => {
    const onDeployed = vi.fn();
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json({}, true, 201);
      return json({ data: [] });
    });
    render(<DeployMonitorDialog monitorId="m1" orgId="monitor-org-1" open onClose={vi.fn()} onDeployed={onDeployed} />);
    await waitFor(() => expect(screen.getByTestId('deploy-monitor-mode-new')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('deploy-monitor-mode-new'));
    // Level defaults to 'organization' — submit without touching the target select.
    fireEvent.click(screen.getByTestId('deploy-monitor-submit'));

    await waitFor(() => expect(onDeployed).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.createPolicyFor.targetId).toBe('monitor-org-1');
    expect(body.createPolicyFor.targetId).toMatch(/./); // non-empty — regression for the 400 Invalid UUID bug
  });

  it('falls back to the selected org from the store for a partner-wide monitor', async () => {
    const onDeployed = vi.fn();
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json({}, true, 201);
      return json({ data: [] });
    });
    render(<DeployMonitorDialog monitorId="m1" orgId={null} open onClose={vi.fn()} onDeployed={onDeployed} />);
    await waitFor(() => expect(screen.getByTestId('deploy-monitor-mode-new')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('deploy-monitor-mode-new'));
    fireEvent.click(screen.getByTestId('deploy-monitor-submit'));

    await waitFor(() => expect(onDeployed).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.createPolicyFor.targetId).toBe('org-store-1');
  });
});
