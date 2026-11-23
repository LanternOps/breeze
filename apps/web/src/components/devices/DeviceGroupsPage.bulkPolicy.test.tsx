import '@/lib/i18n';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceGroupsPage from './DeviceGroupsPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

// Device Groups bulk "Apply policy" is one staged Apply (#12467, plan W02c P5).

vi.mock('../../stores/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../stores/auth')>(),
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../hooks/useFilterPreview', () => ({
  useFilterPreview: () => ({ preview: null, loading: false, error: undefined, refresh: vi.fn() }),
}));

const mockFetch = vi.mocked(fetchWithAuth);
const mockToast = vi.mocked(showToast);

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const POLICY = '99999999-9999-4999-8999-999999999999';

const LIST_RESPONSES: Record<string, unknown> = {
  '/device-groups': {
    data: [
      { id: G1, name: 'Servers', type: 'static', deviceCount: 0, deviceIds: [] },
      { id: G2, name: 'Workstations', type: 'static', deviceCount: 0, deviceIds: [] },
    ],
    total: 2,
  },
  '/devices': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
  '/orgs/sites': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
  '/policies': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
  '/configuration-policies': { data: [{ id: POLICY, name: 'Baseline' }], pagination: { page: 1, limit: 100, total: 1 } },
  '/scripts': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
};

let applyResponse: () => Response = () => json({ added: [{}, {}], updated: [], removed: [] }, 201);

beforeEach(() => {
  vi.clearAllMocks();
  applyResponse = () => json({ added: [{}, {}], updated: [], removed: [] }, 201);
  mockFetch.mockImplementation(async (url: string) => {
    const path = url.split('?')[0]!;
    if (path === `/configuration-policies/${POLICY}/assignments/apply`) return applyResponse();
    if (path.endsWith('/devices') && path.startsWith('/device-groups/')) return json({ data: [], total: 0 });
    if (path in LIST_RESPONSES) return json(LIST_RESPONSES[path]);
    return json({ error: 'Not Found', path }, 404);
  });
});

const policyWrites = () =>
  mockFetch.mock.calls.filter(([url, init]) =>
    String(url).startsWith(`/configuration-policies/${POLICY}/`) && (init as RequestInit | undefined)?.method === 'POST');

async function applyToBothGroups() {
  render(<DeviceGroupsPage />);
  await screen.findByText('Servers');
  fireEvent.click(screen.getAllByRole('checkbox')[0]!);
  fireEvent.click(await screen.findByRole('button', { name: /^apply policy$/i }));
  const heading = await screen.findByRole('heading', { name: /apply policy to groups/i });
  const dialog = heading.parentElement as HTMLElement;
  await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Baseline' })).toBeInTheDocument());
  fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: POLICY } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^apply policy$/i }));
  return dialog;
}

describe('DeviceGroupsPage bulk apply policy', () => {
  it('bulk apply sends one apply request with one add per group, through runAction', async () => {
    await applyToBothGroups();
    await waitFor(() => expect(policyWrites()).toHaveLength(1));
    const [url, init] = policyWrites()[0]!;
    expect(String(url)).toBe(`/configuration-policies/${POLICY}/assignments/apply`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      add: [
        { level: 'device_group', targetId: G1, priority: 0 },
        { level: 'device_group', targetId: G2, priority: 0 },
      ],
      update: [],
      remove: [],
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /apply policy to groups/i })).toBeNull());
  });

  it('a 409 names the group that collided', async () => {
    applyResponse = () => json({
      error: 'assignment_conflict',
      message: 'This policy is already assigned to this target at this level',
      entry: { op: 'add', index: 1 },
    }, 409);
    const dialog = await applyToBothGroups();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    const toast = mockToast.mock.calls.find(([arg]) => (arg as { type: string }).type === 'error')![0] as { message: string };
    expect(toast.message).toContain('Workstations');
    // Nothing was applied, so the modal stays open with both groups selected.
    expect(within(dialog).getByRole('heading', { name: /apply policy to groups/i })).toBeInTheDocument();
    expect(policyWrites()).toHaveLength(1);
  });
});
