import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AlertsPage from './AlertsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (select: (state: { user: { canManagePartnerWide: boolean } }) => unknown) => select({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => null }));
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      orgScope: 'current', currentOrgId: 'org-1', allOrgs: false, error: null,
      organizationsLoaded: true, organizations: [], serviceManagementMode: 'off',
    }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const ID = '5d4c3b2a-1111-4222-8333-444455556666';
const json = (payload: unknown, ok = true, status = 200) =>
  ({ ok, status, statusText: '', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const row = { id: ID, title: 'High CPU on SRV-01', message: 'm', severity: 'critical', status: 'active', deviceId: 'd1', deviceName: 'SRV-01', triggeredAt: new Date().toISOString() };

function route(rows: unknown[], listOverride?: () => Promise<Response>) {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith('/alerts?')) return listOverride ? listOverride() : Promise.resolve(json({ data: rows }));
    if (url === `/alerts/${ID}`) return Promise.resolve(json({ id: ID, notifications: [] }));
    if (url === `/alerts/${ID}/acknowledge`) return Promise.resolve(json({ success: true }));
    if (url.startsWith('/devices/options?')) return Promise.resolve(json({ data: [{ id: 'd1', label: 'SRV-01' }], page: { hasMore: false, total: 1 } }));
    if (url === '/config/ml-feature-flags') return Promise.resolve(json({}));
    return Promise.resolve(json({ data: [] }));
  });
}

describe('AlertsPage papercuts (#9625)', () => {
  beforeEach(() => { fetchMock.mockReset(); window.location.hash = ''; });
  afterEach(() => { window.location.hash = ''; });

  it('keeps the list and open drawer mounted while the post-action refetch is in flight', async () => {
    let calls = 0;
    let release!: (r: Response) => void;
    route([row], () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(json({ data: [row] }));
      return new Promise<Response>((res) => { release = res; });
    });
    render(<AlertsPage />);
    fireEvent.click(await screen.findByText('High CPU on SRV-01'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^acknowledge$/i }));
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.queryByText('Loading alerts...')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByText('High CPU on SRV-01').length).toBeGreaterThan(0);
    await act(async () => { release(json({ data: [{ ...row, status: 'acknowledged' }] })); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('subtitle points at Monitors (thresholds) and mentions Configuration Policies for deployment', async () => {
    route([row]);
    render(<AlertsPage />);
    await screen.findByText('High CPU on SRV-01');
    const subtitle = within(screen.getByTestId('alerts-subtitle'));
    expect(subtitle.getByRole('link', { name: 'Monitors' })).toHaveAttribute('href', '/alerts/monitors');
    expect(subtitle.getByRole('link', { name: 'Configuration Policies' })).toHaveAttribute('href', '/configuration-policies');
  });

  it('the all-clear "Set up alert rules" CTA goes to /alerts/monitors', async () => {
    route([]);
    render(<AlertsPage />);
    const cta = await screen.findByRole('link', { name: /set up alert rules/i });
    expect(cta).toHaveAttribute('href', '/alerts/monitors');
  });

  it("#<alertId> opens that alert's drawer", async () => {
    window.location.hash = ID;
    route([row]);
    render(<AlertsPage />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('High CPU on SRV-01').length).toBeGreaterThan(0);
  });

  it('following the same #<alertId> link again after closing re-opens the drawer', async () => {
    window.location.hash = ID;
    route([row]);
    render(<AlertsPage />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getAllByRole('button', { name: /close/i })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => { window.location.hash = ID; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('an unknown #<alertId> leaves the plain list with no drawer', async () => {
    window.location.hash = '00000000-0000-4000-8000-000000000000';
    route([row]);
    render(<AlertsPage />);
    await screen.findByText('High CPU on SRV-01');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a background refetch after closing does not re-open the hash alert', async () => {
    window.location.hash = ID;
    route([row]);
    render(<AlertsPage />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getAllByRole('button', { name: /close/i })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closing the drawer clears the alert id from the hash', async () => {
    window.location.hash = ID;
    route([row]);
    render(<AlertsPage />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getAllByRole('button', { name: /close/i })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.hash).toBe('');
  });
});
