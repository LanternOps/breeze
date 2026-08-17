import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceGroupsPage from './DeviceGroupsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // orgStore registers an orgId provider at module load; the component now
  // pulls in orgStore via useFleetOrgOwner, so this export must exist.
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../../hooks/useFilterPreview', () => ({
  useFilterPreview: () => ({
    preview: null,
    loading: false,
    error: undefined,
    refresh: vi.fn(),
  }),
}));

const mockFetch = vi.mocked(fetchWithAuth);

const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/**
 * The devices list endpoint returns `osType` — there has never been an `os`
 * key on the wire (apps/api/src/routes/devices/core.ts). This page's local
 * `Device` type claimed `os`, which is what made the legacy matcher throw.
 */
const DEVICES = [
  { id: 'device-1', hostname: 'web-01', osType: 'windows', siteId: 'site-1' },
  { id: 'device-2', hostname: 'db-01', osType: 'linux', siteId: 'site-1' },
];

const SUPPORTING_RESPONSES: Record<string, unknown> = {
  '/devices': { data: DEVICES, pagination: { page: 1, limit: 50, total: DEVICES.length } },
  '/orgs/sites': { data: [{ id: 'site-1', name: 'HQ' }], pagination: { page: 1, limit: 50, total: 1 } },
  '/policies': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
  '/scripts': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
};

/** Serve the given groups plus the fixed supporting endpoints. */
const serveGroups = (groups: unknown[]) => {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    if (path === '/device-groups' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse({ data: groups, total: groups.length });
    }
    if (path === '/device-groups') return jsonResponse({ data: { id: 'new-group' } });
    if (path in SUPPORTING_RESPONSES) return jsonResponse(SUPPORTING_RESPONSES[path]);
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
};

/**
 * Matches the <span> whose whitespace-collapsed text is exactly `text`. The
 * tag check keeps a wrapping <div> with the same textContent from making the
 * query ambiguous.
 */
const exactText = (text: string) => (_content: string, element: Element | null) =>
  element?.tagName === 'SPAN' && element.textContent?.replace(/\s+/g, ' ').trim() === text;

beforeEach(() => {
  vi.clearAllMocks();
  // A resolved focused-org scope: no fleet picker, create proceeds normally
  // (the injected ?orgId= supplies the owner).
  useOrgStore.setState({
    currentOrgId: 'org-focused',
    allOrgs: false,
    organizations: [
      {
        id: 'org-focused',
        partnerId: 'p-1',
        name: 'Focused Org',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    organizationsLoaded: true,
    error: null,
  });
});

describe('DeviceGroupsPage dynamic groups', () => {
  it('renders the page when a dynamic group\'s legacy rules name a field the device payload lacks', async () => {
    // Reproduces the live crash: `matchesRule` read `device.os.toLowerCase()`
    // on a payload that only carries `osType`, throwing during render and
    // unmounting the whole island (blank page, persistent across reloads).
    serveGroups([
      {
        id: 'group-1',
        name: 'Windows Fleet',
        type: 'dynamic',
        rules: [{ id: 'rule-1', field: 'os', operator: 'is', value: 'windows' }],
      },
    ]);

    render(<DeviceGroupsPage />);

    expect(await screen.findByText('Windows Fleet')).toBeInTheDocument();
  });

  it('survives rules whose value is missing entirely', async () => {
    serveGroups([
      {
        id: 'group-1',
        name: 'Broken Rule Group',
        type: 'dynamic',
        rules: [{ id: 'rule-1', field: 'hostname', operator: 'contains' }],
      },
    ]);

    render(<DeviceGroupsPage />);

    expect(await screen.findByText('Broken Rule Group')).toBeInTheDocument();
  });

  it('matches devices by the osType field the devices API actually returns', async () => {
    serveGroups([
      {
        id: 'group-1',
        name: 'Windows Fleet',
        type: 'dynamic',
        rules: [{ id: 'rule-1', field: 'os', operator: 'is', value: 'windows' }],
      },
    ]);

    render(<DeviceGroupsPage />);

    await screen.findByText('Windows Fleet');
    // Only device-1 is Windows — a count of 0 would mean the osType read is
    // still wrong, a throw would mean the crash is back.
    expect(screen.getByText(exactText('Matches 1 device'))).toBeInTheDocument();
  });

  it('shows the configured filter conditions instead of a stale legacy rules stub', async () => {
    serveGroups([
      {
        id: 'group-1',
        name: 'Web Servers',
        type: 'dynamic',
        // The phantom stub the create form used to persist alongside the real
        // filter. It must never be what the card describes.
        rules: [{ id: 'rule-1', field: 'os', operator: 'is', value: 'windows' }],
        filterConditions: {
          operator: 'AND',
          conditions: [{ field: 'hostname', operator: 'contains', value: 'web' }],
        },
      },
    ]);

    render(<DeviceGroupsPage />);

    await screen.findByText('Web Servers');
    expect(screen.getByText(exactText('Hostname contains web'))).toBeInTheDocument();
    expect(screen.queryByText(exactText('OS is windows'))).not.toBeInTheDocument();
  });

  it('does not send a legacy rules stub when creating a dynamic group from the filter builder', async () => {
    const user = userEvent.setup();
    serveGroups([
      { id: 'group-1', name: 'Existing', type: 'static', deviceIds: [], deviceCount: 0 },
    ]);

    render(<DeviceGroupsPage />);
    await screen.findByText('Existing');

    await user.click(screen.getByRole('button', { name: 'Create Group' }));
    await user.type(screen.getByPlaceholderText('e.g. Production Linux'), 'Web Servers');
    await user.click(screen.getByRole('button', { name: 'Dynamic' }));
    await user.type(await screen.findByTestId('value-text-input'), 'web');
    await user.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(
          ([url, init]) =>
            String(url) === '/device-groups' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true);
    });

    const post = mockFetch.mock.calls.find(
      ([url, init]) =>
        String(url) === '/device-groups' &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse(String((post?.[1] as RequestInit).body));

    expect(body.filterConditions).toEqual({
      operator: 'AND',
      conditions: [{ field: 'hostname', operator: 'contains', value: 'web' }],
    });
    expect(body).not.toHaveProperty('rules');
  });
});
