import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AlertsPage from './AlertsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (select: (state: { user: { canManagePartnerWide: boolean } }) => unknown) => select({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => <div data-testid="device-filter-stub" /> }));
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));
const h = vi.hoisted(() => ({ mode: 'native' as string }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      orgScope: 'current', currentOrgId: 'org-1', allOrgs: false, error: null,
      organizationsLoaded: true, organizations: [], serviceManagementMode: h.mode,
    }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const ID = '5d4c3b2a-1111-4222-8333-444455556666';
const json = (payload: unknown, ok = true, status = 200) =>
  ({ ok, status, statusText: '', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = { id: ID, title: 'High CPU on SRV-01', message: 'm', severity: 'critical', status: 'active', deviceId: 'd1', deviceName: 'SRV-01', triggeredAt: new Date().toISOString() };

function route(detail: unknown, tickets: Response | unknown = { data: [] }, listRow: Record<string, unknown> = row) {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith('/alerts?')) return Promise.resolve(json({ data: [listRow] }));
    if (url === `/alerts/${ID}`) return Promise.resolve(json(detail));
    if (url === `/alerts/${ID}/tickets`) return Promise.resolve(tickets instanceof Object && 'ok' in (tickets as object) ? (tickets as Response) : json(tickets));
    if (url.startsWith('/devices/options?')) return Promise.resolve(json({ data: [] }));
    if (url === '/config/ml-feature-flags') return Promise.resolve(json({}));
    return Promise.resolve(json({ data: [] }));
  });
}

describe('AlertsPage drawer data (#9623, #9624)', () => {
  beforeEach(() => { h.mode = 'native'; fetchMock.mockReset(); });

  it.each(['off', 'external'])('does not fetch linked tickets or offer Create ticket in %s mode', async (mode) => {
    h.mode = mode;
    route({ id: ID, notifications: [] });
    render(<AlertsPage />);
    fireEvent.click(await screen.findByText('High CPU on SRV-01'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('alert-create-ticket-button')).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === `/alerts/${ID}/tickets`)).toBe(false);
  });

  it('renders Notifications Sent from the GET /alerts/:id `notifications` array', async () => {
    route({
      id: ID,
      notifications: [
        { id: 'n1', channelId: 'c1', status: 'sent', sentAt: '2026-08-24T16:01:00Z', errorMessage: null, createdAt: '2026-08-24T16:00:59Z', channelName: 'Ops Slack', channelType: 'slack' },
        { id: 'n2', channelId: null, status: 'failed', sentAt: null, errorMessage: 'smtp 550', createdAt: '2026-08-24T16:00:59Z', channelName: null, channelType: null },
      ],
    });
    render(<AlertsPage />);
    fireEvent.click(await screen.findByText('High CPU on SRV-01'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Notifications Sent')).toBeInTheDocument();
    expect(within(dialog).getByText('Ops Slack')).toBeInTheDocument();
    expect(within(dialog).getByText('smtp 550')).toBeInTheDocument();
    expect(within(dialog).queryByText('Status History')).toBeNull();
  });

  it('shows a link to the already-linked open ticket instead of Create ticket', async () => {
    route({ id: ID, notifications: [] }, { data: [{ id: 't1', internalNumber: 'TKT-7', subject: 's', status: 'open' }] });
    render(<AlertsPage />);
    fireEvent.click(await screen.findByText('High CPU on SRV-01'));
    const dialog = await screen.findByRole('dialog');
    const link = await within(dialog).findByTestId('alert-view-ticket');
    expect(link).toHaveAttribute('href', '/tickets#TKT-7');
    expect(within(dialog).queryByTestId('alert-create-ticket-button')).toBeNull();
  });

  it('treats a failed linked-tickets lookup as unknown and warns in the dialog', async () => {
    route({ id: ID, notifications: [] }, json({ error: 'x' }, false, 500));
    render(<AlertsPage />);
    fireEvent.click(await screen.findByText('High CPU on SRV-01'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByTestId('alert-create-ticket-button'));
    expect(await screen.findByTestId('alert-ticket-duplicate-check-failed')).toBeInTheDocument();
  });
});


it('renders workload list and drawer subjects without device links or filters', async () => {
  const workload = { ...row, deviceId: null, deviceName: null, title: '{{device}} failed', ownerKind: 'backup_workload', subjectName: 'Microsoft 365 mail backup · Example organization', context: { source: 'metric_anomaly', metricName: 'cpu' } };
  route({ ...workload, notifications: [] }, { data: [] }, workload);
  const { container } = render(<AlertsPage />);
  fireEvent.click(await screen.findByText(`${workload.subjectName} failed`));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByTestId('alert-subject-chip')).toHaveAttribute('href', '/backup#health');
  expect(screen.queryByTestId('device-filter-stub')).toBeNull();
  expect(container.querySelector('a[href*="/devices/"]')).toBeNull();
});
