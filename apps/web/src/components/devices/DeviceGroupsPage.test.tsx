import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceGroupsPage from './DeviceGroupsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// The preview hook fires its own request; the page's unwrap logic is what's
// under test here, so keep it inert.
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
 * Every list endpoint this page consumes, in the envelope the API actually
 * returns — `{ data, total }` for device-groups, `{ data, pagination }` for the
 * rest. Regression guard for the blank-page bug: the page used to fall through
 * to the envelope object itself, then crash on `devices.map is not a function`.
 */
const ENVELOPE_RESPONSES: Record<string, unknown> = {
  '/device-groups': {
    data: [
      {
        id: 'group-1',
        name: 'Servers',
        description: 'All production servers',
        type: 'static',
        deviceCount: 1,
        deviceIds: ['device-1'],
      },
    ],
    total: 1,
  },
  '/devices': {
    data: [{ id: 'device-1', hostname: 'web-01', os: 'windows' }],
    pagination: { page: 1, limit: 50, total: 1 },
  },
  '/orgs/sites': {
    data: [{ id: 'site-1', name: 'HQ' }],
    pagination: { page: 1, limit: 50, total: 1 },
  },
  '/policies': {
    data: [{ id: 'policy-1', name: 'Baseline' }],
    pagination: { page: 1, limit: 50, total: 1 },
  },
  '/scripts': {
    data: [{ id: 'script-1', name: 'Restart service' }],
    pagination: { page: 1, limit: 50, total: 1 },
  },
};

const requestedPaths = () => mockFetch.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockImplementation(async (url: string) => {
    const path = url.split('?')[0];
    if (path in ENVELOPE_RESPONSES) return jsonResponse(ENVELOPE_RESPONSES[path]);
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
});

describe('DeviceGroupsPage list unwrapping', () => {
  it('renders groups from the { data, total } envelope', async () => {
    render(<DeviceGroupsPage />);

    expect(await screen.findByText('Servers')).toBeInTheDocument();
    // The card resolves member hostnames through the devices state, so this
    // also proves `/devices` was unwrapped rather than stored as the envelope.
    expect(screen.getByText('web-01')).toBeInTheDocument();
    expect(screen.queryByText(/is not a function/i)).not.toBeInTheDocument();
  });

  it('fetches sites from /orgs/sites, not the non-existent /sites', async () => {
    render(<DeviceGroupsPage />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await waitFor(() => expect(requestedPaths()).toContain('/orgs/sites'));
    expect(requestedPaths()).not.toContain('/sites');
  });

  it('shows the empty state when the envelope carries no groups', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const path = url.split('?')[0];
      if (path === '/device-groups') return jsonResponse({ data: [], total: 0 });
      if (path in ENVELOPE_RESPONSES) return jsonResponse(ENVELOPE_RESPONSES[path]);
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });

    render(<DeviceGroupsPage />);

    expect(
      await screen.findByRole('button', { name: /create your first group/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Servers')).not.toBeInTheDocument();
  });

  it('does not crash when an endpoint answers an unexpected shape', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const path = url.split('?')[0];
      if (path === '/device-groups') return jsonResponse(ENVELOPE_RESPONSES['/device-groups']);
      // No `data` key and no plural key — must collapse to [], not be stored.
      return jsonResponse({ unexpected: true });
    });

    render(<DeviceGroupsPage />);

    expect(await screen.findByText('Servers')).toBeInTheDocument();
  });

  it('surfaces an error when the groups request fails', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const path = url.split('?')[0];
      if (path === '/device-groups') {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      return jsonResponse(ENVELOPE_RESPONSES[path] ?? { data: [] });
    });

    render(<DeviceGroupsPage />);

    expect(await screen.findByText(/failed to fetch device groups/i)).toBeInTheDocument();
  });
});
