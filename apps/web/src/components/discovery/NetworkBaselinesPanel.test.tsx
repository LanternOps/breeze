import '@/lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import NetworkBaselinesPanel from './NetworkBaselinesPanel';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const BASELINE = {
  id: 'bl-1',
  orgId: 'org-1',
  siteId: 'site-1',
  subnet: '192.0.2.0/24',
  knownDevices: [],
  scanSchedule: { enabled: true, intervalHours: 24 },
  alertSettings: { newDevice: true, disappeared: true, changed: true, rogueDevice: false },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function routeFetch(del: { status: number; payload: unknown }) {
  fetchMock.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);
    if (!init?.method && url.startsWith('/network/baselines?')) {
      return jsonRes({ data: [BASELINE] });
    }
    if (init?.method === 'DELETE' && url.startsWith('/network/baselines/bl-1')) {
      return jsonRes(del.payload, del.status);
    }
    return jsonRes({});
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/network/baselines?') && !init?.method).length;

async function openDeleteDialog() {
  render(
    <NetworkBaselinesPanel
      currentOrgId="org-1"
      currentSiteId="site-1"
      siteOptions={[{ id: 'site-1', name: 'HQ' }]}
      onViewChanges={vi.fn()}
    />,
  );
  await screen.findAllByText('192.0.2.0/24');
  fireEvent.click(screen.getAllByTitle('Delete')[0]);
  return screen.findByRole('button', { name: 'Delete Baseline' });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('NetworkBaselinesPanel delete confirmation (#3531)', () => {
  it('delete failure: toasts, keeps the dialog open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Delete blew up' } });
    const confirm = await openDeleteDialog();
    expect(listFetches()).toBe(1);

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Delete blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/network/baselines/bl-1?deleteChanges=true',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(screen.getByText('Delete Network Baseline')).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('delete success: refetches and closes the dialog', async () => {
    routeFetch({ status: 200, payload: { success: true } });
    fireEvent.click(await openDeleteDialog());

    await waitFor(() => expect(screen.queryByText('Delete Network Baseline')).toBeNull());
    expect(listFetches()).toBe(2);
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
