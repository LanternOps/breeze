import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
// Org scope, so the fleet-view gate stays open and the data paths under test run.
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => ({ ready: true, status: 'resolved', scope: 'org', orgId: 'org-1', org: null, error: null }),
  getOrgScope: () => ({ ready: true, status: 'resolved', scope: 'org', orgId: 'org-1', org: null, error: null }),
}));
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(), fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const getJwtClaims = vi.fn(() => ({ scope: 'partner', partnerId: 'p-1', orgId: null }));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => getJwtClaims() }));

import SsoProvidersPage from './SsoProvidersPage';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

type Provider = {
  id: string;
  name: string;
  type: 'oidc' | 'saml';
  status: 'active' | 'inactive' | 'testing';
  autoProvision: boolean;
  enforceSSO: boolean;
  createdAt: string;
  partnerId?: string | null;
};

const PARTNER_PROVIDER: Provider = {
  id: 'pp-1',
  name: 'Team Login',
  type: 'oidc',
  status: 'active',
  autoProvision: true,
  enforceSSO: false,
  createdAt: '2026-01-01T00:00:00Z',
  partnerId: 'p-1',
};

/**
 * Route the 4 fetches the page makes on mount. Callers override the two
 * providers responses; presets + roles default to sensible values.
 */
function routes(opts: {
  org?: Response;
  partner?: Response;
  roles?: Response;
}) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/sso/providers') return Promise.resolve(opts.org ?? jsonRes({ data: [] }));
    if (url === '/sso/providers?scope=partner')
      return Promise.resolve(opts.partner ?? jsonRes({ data: [] }));
    if (url === '/sso/presets') return Promise.resolve(jsonRes({ data: [] }));
    if (url === '/roles')
      return Promise.resolve(
        opts.roles ?? jsonRes({ data: [{ id: 'pr-1', name: 'Partner Technician', scope: 'partner' }] })
      );
    return Promise.resolve(jsonRes({ data: [] }));
  });
}

describe('SsoProvidersPage partner-axis behavior', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    getJwtClaims.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
  });

  it('tolerates the expected org-fetch 400 (no org context) and still shows partner rows', async () => {
    routes({
      org: jsonRes({ error: 'Organization ID required' }, false, 400),
      partner: jsonRes({ data: [PARTNER_PROVIDER] }),
    });
    render(<SsoProvidersPage />);

    await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
    // Expected 400 is not a real error — no error banner.
    expect(screen.queryByText(/Failed to fetch SSO providers/)).toBeNull();
  });

  it('surfaces a real org-fetch 500 while still rendering partner rows', async () => {
    routes({
      org: jsonRes({ error: 'boom' }, false, 500),
      partner: jsonRes({ data: [PARTNER_PROVIDER] }),
    });
    render(<SsoProvidersPage />);

    await waitFor(() => expect(screen.getByText(/Failed to fetch SSO providers/)).toBeTruthy());
    // Rows that DID load are still rendered.
    expect(screen.getByText('Team Login')).toBeTruthy();
  });

  it('surfaces a partner-fetch 500', async () => {
    routes({
      org: jsonRes({ data: [] }),
      partner: jsonRes({ error: 'boom' }, false, 500),
    });
    render(<SsoProvidersPage />);

    await waitFor(() => expect(screen.getByText(/Failed to fetch SSO providers/)).toBeTruthy());
  });

  it('hands partner-scoped roles through so the Partner default-role dropdown is non-empty', async () => {
    routes({
      org: jsonRes({ data: [] }),
      partner: jsonRes({ data: [] }),
      roles: jsonRes({ data: [{ id: 'pr-1', name: 'Partner Technician', scope: 'partner' }] }),
    });
    render(<SsoProvidersPage />);

    await waitFor(() => expect(screen.getByText('Add provider')).toBeTruthy());
    fireEvent.click(screen.getByText('Add provider'));

    // Owner selector is shown (partner scope); pick partner ownership.
    const partnerRadio = await screen.findByTestId('sso-provider-owner-partner');
    fireEvent.click(partnerRadio);

    // The partner-scoped role loads into the default-role dropdown.
    expect(screen.getByRole('option', { name: 'Partner Technician' })).toBeTruthy();
  });

  it('PATCHes an edited provider without ownerScope in the body (create-only field)', async () => {
    fetchWithAuth.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === '/sso/providers') return Promise.resolve(jsonRes({ data: [PARTNER_PROVIDER] }));
      if (url === '/sso/providers?scope=partner') return Promise.resolve(jsonRes({ data: [] }));
      if (url === '/sso/presets') return Promise.resolve(jsonRes({ data: [] }));
      if (url === '/roles') return Promise.resolve(jsonRes({ data: [] }));
      if (url === '/sso/providers/pp-1' && (!opts || !opts.method)) {
        return Promise.resolve(
          jsonRes({
            data: {
              name: 'Team Login',
              type: 'oidc',
              preset: '',
              issuer: 'https://idp.example.com',
              clientId: 'client-1',
              scopes: 'openid profile email',
              attributeMapping: { email: 'email', name: 'name' },
              autoProvision: true,
              defaultRoleId: '',
              allowedDomains: '',
              enforceSSO: false,
              hasClientSecret: true,
            },
          })
        );
      }
      if (url === '/sso/providers/pp-1' && opts?.method === 'PATCH') {
        return Promise.resolve(jsonRes({ data: PARTNER_PROVIDER }));
      }
      return Promise.resolve(jsonRes({ data: [] }));
    });

    render(<SsoProvidersPage />);

    await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    await screen.findByRole('button', { name: /save changes/i });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const patchCall = fetchWithAuth.mock.calls.find(
        (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body).not.toHaveProperty('ownerScope');
    });
  });
});
