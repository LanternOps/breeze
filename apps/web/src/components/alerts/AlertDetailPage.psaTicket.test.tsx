import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/i18n';

const h = vi.hoisted(() => ({
  mode: 'external' as string | undefined,
  ticketsWrite: true,
  fetch: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: (resource: string, action: string) => resource === 'tickets' && action === 'write' && h.ticketsWrite }),
  hasPermission: () => false,
}));
vi.mock('@/stores/orgStore', () => ({ useOrgStore: (selector: (state: unknown) => unknown) => selector({ serviceManagementMode: h.mode }) }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => h.fetch(...args), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: h.toast }));
vi.mock('@/lib/navigation', () => ({ navigateTo: h.navigate }));
import AlertDetailPage from './AlertDetailPage';

const alert = { id: 'alert-1', orgId: 'org-1', title: 'CPU high', message: 'CPU over 90%', severity: 'critical', status: 'acknowledged', deviceId: 'device-1', deviceName: 'web-01', triggeredAt: '2026-10-29T00:00:00Z' };
const psaTicket = { source: 'psa', partnerServicePrincipalId: null, externalId: '42', externalNumber: 'CW-42', externalUrl: 'https://psa.example/42', state: 'created' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let refs: unknown[];
let post: () => Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  h.mode = 'external';
  h.ticketsWrite = true;
  refs = [];
  post = async () => { refs = [psaTicket]; return response({ status: 'admitted' }, 202); };
  h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return post();
    if (url.endsWith('/external-tickets')) return response({ data: refs });
    if (url.endsWith('/tickets')) return response({ data: [] });
    return response(alert);
  });
});

describe('AlertDetailPage manual PSA ticket', () => {
  it.each(['native', 'off', undefined])('hides the action in %s mode', async mode => {
    h.mode = mode;
    render(<AlertDetailPage alertId={alert.id} />);
    await screen.findByRole('heading', { name: alert.title });
    expect(screen.queryByTestId('alert-create-psa-ticket')).toBeNull();
  });

  it('requires tickets:write in external mode', async () => {
    h.ticketsWrite = false;
    render(<AlertDetailPage alertId={alert.id} />);
    await screen.findByRole('heading', { name: alert.title });
    expect(screen.queryByTestId('alert-create-psa-ticket')).toBeNull();
  });

  it('requests a PSA ticket and refreshes the existing chip with its number and link', async () => {
    render(<AlertDetailPage alertId={alert.id} />);
    fireEvent.click(await screen.findByTestId('alert-create-psa-ticket'));
    await waitFor(() => expect(h.fetch).toHaveBeenCalledWith('/alerts/alert-1/psa-ticket', { method: 'POST' }));
    const chip = await screen.findByTestId('alert-external-ticket-link');
    expect(chip).toHaveTextContent('CW-42');
    expect(chip).toHaveAttribute('href', psaTicket.externalUrl);
    expect(screen.getByTestId('alert-external-ticket-state')).toHaveTextContent('Created');
    expect(h.fetch.mock.calls.filter(([url]) => url === '/alerts/alert-1/external-tickets')).toHaveLength(2);
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('disables the button while admission is pending', async () => {
    let finish!: (value: Response) => void;
    post = () => new Promise(resolve => { finish = resolve; });
    render(<AlertDetailPage alertId={alert.id} />);
    const button = await screen.findByTestId('alert-create-psa-ticket');
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(h.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    finish(response({ status: 'exists' }));
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('toasts a conflict once without refreshing the chip', async () => {
    post = async () => response({ error: 'Alert ticketing is inactive' }, 409);
    render(<AlertDetailPage alertId={alert.id} />);
    fireEvent.click(await screen.findByTestId('alert-create-psa-ticket'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith({ message: 'Alert ticketing is inactive', type: 'error' }));
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls.filter(([url]) => url === '/alerts/alert-1/external-tickets')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: alert.title })).toBeInTheDocument();
  });

  it('redirects on 401 without an error toast', async () => {
    post = async () => response({ error: 'Unauthorized' }, 401);
    render(<AlertDetailPage alertId={alert.id} />);
    fireEvent.click(await screen.findByTestId('alert-create-psa-ticket'));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/login', { replace: true }));
    expect(h.toast).not.toHaveBeenCalled();
  });
});
