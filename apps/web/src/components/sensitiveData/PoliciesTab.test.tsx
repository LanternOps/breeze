import '@/lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: false, defaultOwnerScope: 'organization' }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import PoliciesTab from './PoliciesTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const POLICY = {
  id: 'sdp-1',
  orgId: 'org-1',
  name: 'Find credentials',
  detectionClasses: ['credential'],
  isActive: true,
  schedule: { type: 'manual' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function routeFetch(del: { status: number; payload: unknown }) {
  fetchMock.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);
    if (!init?.method && url === '/sensitive-data/policies') return jsonRes({ data: [POLICY] });
    if (init?.method === 'DELETE' && url === '/sensitive-data/policies/sdp-1') return jsonRes(del.payload, del.status);
    return jsonRes({});
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/sensitive-data/policies' && !init?.method).length;

async function openDeleteDialog() {
  render(<PoliciesTab />);
  const nameCell = await screen.findByText('Find credentials');
  const row = nameCell.closest('tr') as HTMLElement;
  const buttons = row.querySelectorAll('button');
  fireEvent.click(buttons[buttons.length - 1]);
  return screen.findByRole('button', { name: 'Delete Policy' });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

function routeList(policies: unknown[], listStatus = 200) {
  fetchMock.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);
    if (!init?.method && url === '/sensitive-data/policies') {
      return listStatus === 200 ? jsonRes({ data: policies }) : jsonRes({ error: 'denied' }, listStatus);
    }
    return jsonRes({ success: true });
  });
}

describe('sensitive-data PoliciesTab (#9697, #9683)', () => {
  it('shows the no-access state on a 403', async () => {
    routeList([], 403);
    render(<PoliciesTab />);
    expect(await screen.findByText(/You don't have access to this organization/i)).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch policies')).not.toBeInTheDocument();
  });

  it('labels the cron field UTC and previews the next run', async () => {
    routeList([{ ...POLICY, schedule: { type: 'cron', cron: '0 2 * * *' } }]);
    render(<PoliciesTab />);
    const row = (await screen.findByText('Find credentials')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('0 2 * * * (UTC)');
    fireEvent.click(row.querySelectorAll('button')[1]); // edit

    expect(await screen.findByText('Cron Expression (UTC)')).toBeInTheDocument();
    expect(screen.getByTestId('sensitive-policy-cron-next-run')).toHaveTextContent(/Next run/);
  });

  it('shows a paused badge when schedule.enabled is false', async () => {
    routeList([{ ...POLICY, schedule: { type: 'cron', cron: '0 2 * * *', enabled: false } }]);
    render(<PoliciesTab />);
    const row = (await screen.findByText('Find credentials')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Paused');
  });

  it('does not show a paused badge for a running schedule', async () => {
    routeList([{ ...POLICY, schedule: { type: 'cron', cron: '0 2 * * *' } }]);
    render(<PoliciesTab />);
    const row = (await screen.findByText('Find credentials')).closest('tr') as HTMLElement;
    expect(row).not.toHaveTextContent('Paused');
  });

  it('preserves schedule.enabled=false when the policy is edited and saved', async () => {
    routeList([{ ...POLICY, schedule: { type: 'cron', cron: '0 2 * * *', enabled: false } }]);
    render(<PoliciesTab />);
    const row = (await screen.findByText('Find credentials')).closest('tr') as HTMLElement;
    fireEvent.click(row.querySelectorAll('button')[1]); // edit
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]?.body)).schedule).toMatchObject({ type: 'cron', cron: '0 2 * * *', enabled: false });
  });

  it('preserves a stored timezone and deviceIds on edit and previews in that zone', async () => {
    const deviceId = '11111111-1111-4111-8111-111111111111';
    routeList([{
      ...POLICY,
      schedule: { type: 'cron', cron: '0 2 * * *', timezone: 'America/Chicago', deviceIds: [deviceId] },
    }]);
    render(<PoliciesTab />);
    const row = (await screen.findByText('Find credentials')).closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('0 2 * * * (America/Chicago)');
    fireEvent.click(row.querySelectorAll('button')[1]);

    expect(await screen.findByText('Cron Expression (America/Chicago)')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]?.body)).schedule).toMatchObject({
      timezone: 'America/Chicago',
      deviceIds: [deviceId],
    });
  });

  it('clears rows when a refetch after load is denied', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      if (!init?.method && String(rawUrl) === '/sensitive-data/policies') {
        calls += 1;
        return calls === 1 ? jsonRes({ data: [POLICY] }) : jsonRes({ error: 'denied' }, 403);
      }
      return jsonRes({ success: true });
    });
    render(<PoliciesTab />);
    const row = (await screen.findByText('Find credentials')).closest('tr') as HTMLElement;
    fireEvent.click(row.querySelectorAll('button')[0]); // active toggle → refetch
    expect(await screen.findByText(/You don't have access to this organization/i)).toBeInTheDocument();
    expect(screen.queryByText('Find credentials')).not.toBeInTheDocument();
  });

  it('does not invent schedule.enabled for a policy that never had it', async () => {
    routeList([{ ...POLICY, schedule: { type: 'cron', cron: '0 2 * * *' } }]);
    render(<PoliciesTab />);
    const row = (await screen.findByText('Find credentials')).closest('tr') as HTMLElement;
    fireEvent.click(row.querySelectorAll('button')[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(put[1]?.body)).schedule).not.toHaveProperty('enabled');
  });
});

describe('sensitive-data PoliciesTab delete confirmation (#3531)', () => {
  it('delete failure: toasts, keeps the dialog open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Delete blew up' } });
    const confirm = await openDeleteDialog();
    expect(listFetches()).toBe(1);

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Delete blew up' })),
    );
    expect(screen.getByText('Delete Scan Policy')).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('delete success: refetches, closes the dialog and toasts success', async () => {
    routeFetch({ status: 200, payload: { success: true } });
    fireEvent.click(await openDeleteDialog());

    await waitFor(() => expect(screen.queryByText('Delete Scan Policy')).toBeNull());
    expect(listFetches()).toBe(2);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
