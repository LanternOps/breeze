import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MigrationRequiredBanner from './MigrationRequiredBanner';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('@/lib/i18n', () => ({ default: {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count != null ? `${key}:${options.count}` : key,
  }),
}));

// Mutable gate state the mocked stores read from, so each test flips exactly
// one gate. usePermissions() (the real implementation) reads `user.permissions`
// off the auth store via the selector form.
type Perm = { resource: string; action: string };
const gates = vi.hoisted(() => ({
  permissions: [] as Perm[],
  features: { billing: false, support: false },
  featuresLoaded: true,
}));

const authUser = () => ({ id: 'user-1', permissions: gates.permissions });

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector?: (s: { user: ReturnType<typeof authUser> }) => unknown) => {
      const s = { user: authUser() };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ user: authUser() }) },
  ),
}));

// useDashboardQuery (real) re-fetches on org-scope changes; pin the scope.
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: { currentOrgId: string | null }) => unknown) => {
      const s = { currentOrgId: 'org-1' };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ currentOrgId: 'org-1' }) },
  ),
}));

const loadFeatures = vi.fn().mockResolvedValue(undefined);
vi.mock('../../stores/featuresStore', () => {
  const state = () => ({
    features: gates.features,
    loaded: gates.featuresLoaded,
    load: loadFeatures,
  });
  return {
    useFeaturesStore: Object.assign(
      (selector?: (s: ReturnType<typeof state>) => unknown) => {
        const s = state();
        return selector ? selector(s) : s;
      },
      { getState: state },
    ),
  };
});

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const statsResponse = (migrationRequiredCount: number): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      data: { total: 10, online: 8, offline: 2, byStatus: {}, migrationRequiredCount },
    }),
  }) as unknown as Response;

beforeEach(() => {
  // Default: every gate open — self-hosted, admin, three devices to migrate.
  gates.permissions = [{ resource: '*', action: '*' }];
  gates.features = { billing: false, support: false };
  gates.featuresLoaded = true;
  fetchWithAuthMock.mockResolvedValue(statsResponse(3));
});

describe('MigrationRequiredBanner', () => {
  it('renders when self-hosted + admin + migrationRequiredCount > 0', async () => {
    render(<MigrationRequiredBanner />);

    expect(await screen.findByText('migrationBanner.message:3')).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/stats');
    expect(screen.getByRole('link', { name: 'migrationBanner.cta' })).toHaveAttribute(
      'href',
      'https://docs.breezermm.com/agents/self-host-migration/',
    );
  });

  it('renders nothing when count is 0', async () => {
    fetchWithAuthMock.mockResolvedValue(statsResponse(0));

    const { container } = render(<MigrationRequiredBanner />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing (and never fetches stats) when not self-hosted', async () => {
    gates.features = { billing: true, support: true };

    const { container } = render(<MigrationRequiredBanner />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing (and never fetches stats) for a non-admin', async () => {
    gates.permissions = [{ resource: 'devices', action: 'read' }];

    const { container } = render(<MigrationRequiredBanner />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing until /config has resolved, so hosted users never flash it', async () => {
    gates.featuresLoaded = false;

    const { container } = render(<MigrationRequiredBanner />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });
});
