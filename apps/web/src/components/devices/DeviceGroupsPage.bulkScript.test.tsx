import '@/lib/i18n';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceGroupsPage from './DeviceGroupsPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../hooks/useFilterPreview', () => ({
  useFilterPreview: () => ({ preview: null, loading: false, error: undefined, refresh: vi.fn() }),
}));

const mockFetch = vi.mocked(fetchWithAuth);
const mockToast = vi.mocked(showToast);

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const DEV_A = '11111111-1111-4111-8111-111111111111';
const DEV_B = '22222222-2222-4222-8222-222222222222';
const DEV_C = '33333333-3333-4333-8333-333333333333';

const LIST_RESPONSES: Record<string, unknown> = {
  '/device-groups': {
    data: [
      { id: 'group-1', name: 'Servers', type: 'static', deviceCount: 2, deviceIds: [DEV_A, DEV_B] },
      { id: 'group-2', name: 'Workstations', type: 'static', deviceCount: 2, deviceIds: [DEV_B, DEV_C] },
    ],
    total: 2,
  },
  '/devices': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
  '/orgs/sites': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
  '/policies': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
  '/configuration-policies': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
  '/scripts': { data: [{ id: 'script-1', name: 'Restart service' }], pagination: { page: 1, limit: 50, total: 1 } },
};

type Handler = (url: string, init?: RequestInit) => Response | undefined;
let override: Handler = () => undefined;

const membersOf = (ids: string[]) => ({ data: ids.map((deviceId) => ({ deviceId })), total: ids.length });

beforeEach(() => {
  vi.clearAllMocks();
  override = () => undefined;
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const custom = override(url, init);
    if (custom) return custom;
    const path = url.split('?')[0];
    if (path === '/device-groups/group-1/devices') return json(membersOf([DEV_A, DEV_B]));
    if (path === '/device-groups/group-2/devices') return json(membersOf([DEV_B, DEV_C]));
    if (path in LIST_RESPONSES) return json(LIST_RESPONSES[path]);
    return json({ error: 'Not Found', path }, 404);
  });
});

const calls = () => mockFetch.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit | undefined }));
const executeCalls = () => calls().filter((c) => c.url === '/scripts/script-1/execute');

async function openBulkScriptAndRun() {
  render(<DeviceGroupsPage />);
  await screen.findByText('Servers');
  // First checkbox is "select all groups".
  fireEvent.click(screen.getAllByRole('checkbox')[0]);
  fireEvent.click(await screen.findByRole('button', { name: /^run script$/i }));
  const heading = await screen.findByRole('heading', { name: /run script on groups/i });
  const dialog = heading.parentElement as HTMLElement;
  fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'script-1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^run script$/i }));
  return dialog;
}

describe('DeviceGroupsPage bulk run-script (#3429)', () => {
  it('resolves members per group and executes once on the de-duplicated device set', async () => {
    override = (url, init) =>
      url === '/scripts/script-1/execute' && init?.method === 'POST'
        ? json({
            requestId: 'r1',
            status: 'queued',
            targets: [DEV_A, DEV_B, DEV_C].map((id) => ({ requestedDeviceId: id, admission: 'admitted' })),
          }, 201)
        : undefined;

    await openBulkScriptAndRun();

    await waitFor(() => expect(executeCalls()).toHaveLength(1));
    const body = JSON.parse(String(executeCalls()[0].init?.body));
    expect([...body.deviceIds].sort()).toEqual([DEV_A, DEV_B, DEV_C]);
    expect(executeCalls()[0].init?.method).toBe('POST');

    // Membership came from the per-group, access-checked endpoint.
    const paths = calls().map((c) => c.url.split('?')[0]);
    expect(paths).toContain('/device-groups/group-1/devices');
    expect(paths).toContain('/device-groups/group-2/devices');
    // The never-implemented route is gone.
    expect(paths).not.toContain('/device-groups/bulk');

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /run script on groups/i })).not.toBeInTheDocument(),
    );
  });

  it('does not execute on a partial set when a group membership read fails', async () => {
    override = (url) =>
      url.split('?')[0] === '/device-groups/group-2/devices'
        ? json({ error: 'Access to this site denied' }, 403)
        : undefined;

    await openBulkScriptAndRun();

    await waitFor(() => expect(screen.getByText(/Access to this site denied/)).toBeInTheDocument());
    expect(executeCalls()).toHaveLength(0);
  });

  it('does not execute when the selected groups have no devices', async () => {
    override = (url) =>
      /^\/device-groups\/group-[12]\/devices/.test(url) ? json(membersOf([])) : undefined;

    await openBulkScriptAndRun();

    await waitFor(() => expect(screen.getByText(/have no devices you can run a script on/)).toBeInTheDocument());
    expect(executeCalls()).toHaveLength(0);
  });

  it('surfaces targets the server did not admit instead of reporting success', async () => {
    override = (url, init) =>
      url === '/scripts/script-1/execute' && init?.method === 'POST'
        ? json({
            requestId: 'r2',
            status: 'partially_queued',
            targets: [
              { requestedDeviceId: DEV_A, admission: 'admitted' },
              { requestedDeviceId: DEV_B, admission: 'excluded', reasonCode: 'os_incompatible' },
              { requestedDeviceId: DEV_C, admission: 'denied', reasonCode: 'site_access_denied' },
            ],
          }, 201)
        : undefined;

    await openBulkScriptAndRun();

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          message: expect.stringMatching(/1 of 3.*os_incompatible.*site_access_denied/),
        }),
      ),
    );
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});
