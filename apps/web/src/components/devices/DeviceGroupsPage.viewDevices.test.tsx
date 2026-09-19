import { i18n } from '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceGroupsPage from './DeviceGroupsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { decodeFilterFromHash } from './filterUrl';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../../hooks/useFilterPreview', () => ({
  useFilterPreview: () => ({ preview: null, loading: false, error: undefined, refresh: vi.fn() }),
}));

const mockFetch = vi.mocked(fetchWithAuth);
const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const GROUP = { id: 'group-1', name: 'Domain Controllers', type: 'static', deviceIds: [], deviceCount: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  useOrgStore.setState({
    currentOrgId: 'org-focused',
    allOrgs: false,
    organizations: [{ id: 'org-focused', partnerId: 'p-1', name: 'Focused Org', status: 'active', createdAt: '2026-01-01T00:00:00Z' }],
    organizationsLoaded: true,
    error: null,
  });
  mockFetch.mockImplementation(async (url: string) => {
    const path = String(url).split('?')[0];
    if (path === '/device-groups') return jsonResponse({ data: [GROUP], total: 1 });
    if (/^\/device-groups\/[^/]+\/devices$/.test(path)) return jsonResponse({ data: [], total: 0 });
    return jsonResponse({ data: [], pagination: { page: 1, limit: 50, total: 0 } });
  });
});

// Groups were only usable as a device-list filter by hand-pasting a UUID. Each
// group card now deep-links into /devices with the group pre-applied as a chip.
describe('DeviceGroupsPage — view devices link', () => {
  it('links each group card to the device list with a groupId filter in the hash', async () => {
    await i18n.changeLanguage('en');
    render(<DeviceGroupsPage />);
    const link = await waitFor(() => screen.getByTestId('group-view-devices-group-1'));
    expect(link.tagName).toBe('A');
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('/devices#filtersV2=')).toBe(true);
    const group = decodeFilterFromHash(href.slice('/devices#'.length));
    expect(group).toEqual({
      operator: 'AND',
      conditions: [{ field: 'groupId', operator: 'in', value: ['group-1'] }],
    });
  });
});
