import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
// Org scope, so the fleet-view gate stays open and the data paths under test run.
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => ({ ready: true, status: 'resolved', scope: 'org', orgId: 'org-1', org: null, error: null }),
  getOrgScope: () => ({ ready: true, status: 'resolved', scope: 'org', orgId: 'org-1', org: null, error: null }),
}));
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(), fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

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
    showToastMock.mockClear();
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

  // #4018: sso_providers.trustsIdpMfa lets an org opt into treating the IdP's
  // own MFA assertion as satisfying Breeze's MFA-gated routes. Off by default.
  function routeEditableProvider(trustsIdpMfa: boolean) {
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
              trustsIdpMfa,
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
  }

  it('renders the trust-IdP-MFA toggle reflecting the provider value', async () => {
    routeEditableProvider(false);
    render(<SsoProvidersPage />);

    await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const toggle = await screen.findByTestId('provider-trusts-idp-mfa');
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });

  it('PATCHes trustsIdpMfa when the toggle is turned on', async () => {
    routeEditableProvider(false);
    render(<SsoProvidersPage />);

    await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const toggle = await screen.findByTestId('provider-trusts-idp-mfa');
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('provider-save'));

    await waitFor(() => {
      const patchCall = fetchWithAuth.mock.calls.find(
        (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.trustsIdpMfa).toBe(true);
    });
  });

  // The `false` cases above are indistinguishable from the form's own fallback
  // (`selectedProviderDetails.trustsIdpMfa ?? false`), so deleting the mapping
  // at SsoProvidersPage.tsx failed nothing. Only a `true` provider proves the
  // stored value is actually threaded into the form — and getting this wrong is
  // a SECURITY regression in the quiet direction: the toggle would read "off"
  // for an org whose IdP MFA assertion is in fact being trusted.
  it('reflects a provider that ALREADY trusts IdP MFA', async () => {
    routeEditableProvider(true);
    render(<SsoProvidersPage />);

    await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const toggle = await screen.findByTestId('provider-trusts-idp-mfa');
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  // #4068: enabling Enforce SSO preflights the lockout population and demands
  // an explicit acknowledged confirmation naming the users who lose access.
  describe('enforce-SSO lockout confirm-through', () => {
    const PREFLIGHT_URL = '/sso/providers/enforcement-preflight';

    const preflightPayload = (unlinked: Array<{ id: string; email: string; name: string; isSelf?: boolean; hasPasskey?: boolean }>) => ({
      data: {
        totalActiveUsers: 5,
        unlinkedCount: unlinked.length,
        selfLockedOut: unlinked.some(u => u.isSelf),
        truncated: false,
        loginProvider: { id: 'pp-1', name: 'Team Login', type: 'oidc' },
        unlinked: unlinked.map(u => ({ isSelf: false, hasPasskey: false, ...u }))
      }
    });

    function routeWithPreflight(opts: {
      provider?: Partial<Provider> & { enforceSSO: boolean };
      preflight: ReturnType<typeof preflightPayload>;
    }) {
      const provider = { ...PARTNER_PROVIDER, ...opts.provider };
      fetchWithAuth.mockImplementation((url: string, reqOpts?: { method?: string }) => {
        if (url === '/sso/providers') return Promise.resolve(jsonRes({ data: [provider] }));
        if (url === '/sso/providers?scope=partner') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/presets') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/roles') return Promise.resolve(jsonRes({ data: [] }));
        if (url === PREFLIGHT_URL) return Promise.resolve(jsonRes(opts.preflight));
        if (url === '/sso/providers/pp-1' && (!reqOpts || !reqOpts.method)) {
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
                enforceSSO: provider.enforceSSO,
                status: provider.status,
                hasClientSecret: true,
              },
            })
          );
        }
        if (url === '/sso/providers/pp-1' && reqOpts?.method === 'PATCH') {
          return Promise.resolve(jsonRes({ data: provider }));
        }
        if (url === '/sso/providers/pp-1/status' && reqOpts?.method === 'POST') {
          return Promise.resolve(jsonRes({ data: provider }));
        }
        return Promise.resolve(jsonRes({ data: [] }));
      });
    }

    const enforceToggle = () => screen.getByTestId('provider-enforce-sso') as HTMLInputElement;

    it('shows the lockout confirm with the unlinked users, gates on the checkbox, then PATCHes with acknowledgeLockout', async () => {
      routeWithPreflight({
        provider: { enforceSSO: false },
        preflight: preflightPayload([
          { id: 'u-1', email: 'a@example.com', name: 'A', isSelf: true },
          { id: 'u-2', email: 'b@example.com', name: 'B', hasPasskey: true }
        ])
      });
      render(<SsoProvidersPage />);

      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const toggle = await waitFor(() => enforceToggle());
      fireEvent.click(toggle);
      fireEvent.click(screen.getByTestId('provider-save'));

      // The confirm overlay names both users; no PATCH yet.
      const modal = await screen.findByTestId('enforce-lockout-modal');
      expect(modal.textContent).toContain('a@example.com');
      expect(modal.textContent).toContain('b@example.com');
      const patchBefore = fetchWithAuth.mock.calls.find(
        (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
      );
      expect(patchBefore).toBeUndefined();

      // Confirm is disabled until acknowledged.
      const confirm = screen.getByTestId('enforce-lockout-confirm') as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      fireEvent.click(screen.getByTestId('enforce-lockout-ack'));
      expect(confirm.disabled).toBe(false);
      fireEvent.click(confirm);

      await waitFor(() => {
        const patchCall = fetchWithAuth.mock.calls.find(
          (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
        );
        expect(patchCall).toBeTruthy();
        const body = JSON.parse((patchCall![1] as { body: string }).body);
        expect(body.enforceSSO).toBe(true);
        expect(body.acknowledgeLockout).toBe(true);
      });
    });

    it('saves straight through (no modal, no acknowledgeLockout) when nobody would be locked out', async () => {
      routeWithPreflight({ provider: { enforceSSO: false }, preflight: preflightPayload([]) });
      render(<SsoProvidersPage />);

      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const toggle = await waitFor(() => enforceToggle());
      fireEvent.click(toggle);
      fireEvent.click(screen.getByTestId('provider-save'));

      await waitFor(() => {
        const patchCall = fetchWithAuth.mock.calls.find(
          (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
        );
        expect(patchCall).toBeTruthy();
        const body = JSON.parse((patchCall![1] as { body: string }).body);
        expect(body).not.toHaveProperty('acknowledgeLockout');
      });
      expect(screen.queryByTestId('enforce-lockout-modal')).toBeNull();
    });

    it('cancel closes the overlay, fires no mutation, and keeps the edit form (with its state) open', async () => {
      routeWithPreflight({
        provider: { enforceSSO: false },
        preflight: preflightPayload([{ id: 'u-1', email: 'a@example.com', name: 'A' }])
      });
      render(<SsoProvidersPage />);

      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const toggle = await waitFor(() => enforceToggle());
      fireEvent.click(toggle);
      fireEvent.click(screen.getByTestId('provider-save'));

      await screen.findByTestId('enforce-lockout-modal');
      fireEvent.click(screen.getByTestId('enforce-lockout-cancel'));

      // Overlay gone; NO PATCH fired; the edit form is still mounted and the
      // toggle still reflects the admin's in-progress change.
      expect(screen.queryByTestId('enforce-lockout-modal')).toBeNull();
      expect(fetchWithAuth.mock.calls.find(
        (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
      )).toBeUndefined();
      expect(enforceToggle().checked).toBe(true);
    });

    it('opens the confirm from the SERVER 409 payload when the preflight read fails (backstop path)', async () => {
      const provider = { ...PARTNER_PROVIDER, enforceSSO: false };
      const serverPreflight = preflightPayload([{ id: 'u-9', email: 'server@example.com', name: 'S' }]);
      let patchCount = 0;
      fetchWithAuth.mockImplementation((url: string, reqOpts?: { method?: string }) => {
        if (url === '/sso/providers') return Promise.resolve(jsonRes({ data: [provider] }));
        if (url === '/sso/providers?scope=partner') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/presets') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/roles') return Promise.resolve(jsonRes({ data: [] }));
        // Preflight endpoint is down.
        if (url === '/sso/providers/enforcement-preflight') return Promise.resolve(jsonRes({ error: 'boom' }, false, 500));
        if (url === '/sso/providers/pp-1' && (!reqOpts || !reqOpts.method)) {
          return Promise.resolve(jsonRes({
            data: {
              name: 'Team Login', type: 'oidc', preset: '', issuer: 'https://idp.example.com',
              clientId: 'client-1', scopes: 'openid profile email',
              attributeMapping: { email: 'email', name: 'name' },
              autoProvision: true, defaultRoleId: '', allowedDomains: '',
              enforceSSO: false, hasClientSecret: true
            }
          }));
        }
        if (url === '/sso/providers/pp-1' && reqOpts?.method === 'PATCH') {
          patchCount += 1;
          if (patchCount === 1) {
            // Server backstop refuses the unacknowledged lockout.
            return Promise.resolve(jsonRes({
              error: 'would lock out 1 user(s)',
              code: 'sso_enforcement_lockout_confirmation_required',
              preflight: serverPreflight.data
            }, false, 409));
          }
          return Promise.resolve(jsonRes({ data: provider }));
        }
        return Promise.resolve(jsonRes({ data: [] }));
      });

      render(<SsoProvidersPage />);
      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const toggle = await waitFor(() => enforceToggle());
      fireEvent.click(toggle);
      fireEvent.click(screen.getByTestId('provider-save'));

      // The 409's own payload feeds the confirm dialog.
      const modal = await screen.findByTestId('enforce-lockout-modal');
      expect(modal.textContent).toContain('server@example.com');

      fireEvent.click(screen.getByTestId('enforce-lockout-ack'));
      fireEvent.click(screen.getByTestId('enforce-lockout-confirm'));

      await waitFor(() => {
        expect(patchCount).toBe(2);
        const secondPatch = fetchWithAuth.mock.calls.filter(
          (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
        )[1];
        const body = JSON.parse((secondPatch![1] as { body: string }).body);
        expect(body.acknowledgeLockout).toBe(true);
      });
    });

    it('opens the confirm from the status route 409 when activating with the preflight down', async () => {
      const provider = { ...PARTNER_PROVIDER, enforceSSO: true, status: 'inactive' as const };
      const serverPreflight = preflightPayload([{ id: 'u-9', email: 'server@example.com', name: 'S' }]);
      let statusCount = 0;
      fetchWithAuth.mockImplementation((url: string, reqOpts?: { method?: string }) => {
        if (url === '/sso/providers') return Promise.resolve(jsonRes({ data: [provider] }));
        if (url === '/sso/providers?scope=partner') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/presets') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/roles') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/providers/enforcement-preflight') return Promise.resolve(jsonRes({ error: 'boom' }, false, 500));
        if (url === '/sso/providers/pp-1/status' && reqOpts?.method === 'POST') {
          statusCount += 1;
          if (statusCount === 1) {
            return Promise.resolve(jsonRes({
              error: 'would lock out 1 user(s)',
              code: 'sso_enforcement_lockout_confirmation_required',
              preflight: serverPreflight.data
            }, false, 409));
          }
          return Promise.resolve(jsonRes({ data: provider }));
        }
        return Promise.resolve(jsonRes({ data: [] }));
      });

      render(<SsoProvidersPage />);
      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Activate' }));

      const modal = await screen.findByTestId('enforce-lockout-modal');
      expect(modal.textContent).toContain('server@example.com');

      fireEvent.click(screen.getByTestId('enforce-lockout-ack'));
      fireEvent.click(screen.getByTestId('enforce-lockout-confirm'));

      await waitFor(() => {
        expect(statusCount).toBe(2);
        const second = fetchWithAuth.mock.calls.filter(
          (c) => c[0] === '/sso/providers/pp-1/status' && (c[1] as { method?: string })?.method === 'POST'
        )[1];
        const body = JSON.parse((second![1] as { body: string }).body);
        expect(body).toMatchObject({ status: 'active', acknowledgeLockout: true });
      });
    });

    it('does not preflight or warn on CREATE (providers are born inactive — activation is the guarded moment)', async () => {
      routes({ org: jsonRes({ data: [] }), partner: jsonRes({ data: [] }) });
      fetchWithAuth.mockImplementation((url: string, reqOpts?: { method?: string }) => {
        if (url === '/sso/providers' && reqOpts?.method === 'POST') return Promise.resolve(jsonRes({ data: { id: 'new-1' } }));
        if (url === '/sso/providers') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/providers?scope=partner') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/presets') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/roles') return Promise.resolve(jsonRes({ data: [] }));
        return Promise.resolve(jsonRes({ data: [] }));
      });
      render(<SsoProvidersPage />);

      await waitFor(() => expect(screen.getByText('Add provider')).toBeTruthy());
      fireEvent.click(screen.getByText('Add provider'));

      const nameInput = await screen.findByLabelText(/provider name/i);
      fireEvent.change(nameInput, { target: { value: 'New IdP' } });
      fireEvent.click(enforceToggle());
      fireEvent.click(screen.getByTestId('provider-save'));

      await waitFor(() => {
        const createCall = fetchWithAuth.mock.calls.find(
          (c) => c[0] === '/sso/providers' && (c[1] as { method?: string })?.method === 'POST'
        );
        expect(createCall).toBeTruthy();
      });
      expect(fetchWithAuth.mock.calls.find((c) => c[0] === PREFLIGHT_URL)).toBeUndefined();
      expect(screen.queryByTestId('enforce-lockout-modal')).toBeNull();
    });

    it('does not preflight or warn when enabling enforcement on an INACTIVE provider (activation is the guarded moment)', async () => {
      routeWithPreflight({
        provider: { enforceSSO: false, status: 'inactive' },
        preflight: preflightPayload([{ id: 'u-1', email: 'a@example.com', name: 'A' }])
      });
      render(<SsoProvidersPage />);

      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const toggle = await waitFor(() => enforceToggle());
      fireEvent.click(toggle);
      fireEvent.click(screen.getByTestId('provider-save'));

      await waitFor(() => {
        const patchCall = fetchWithAuth.mock.calls.find(
          (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
        );
        expect(patchCall).toBeTruthy();
        const body = JSON.parse((patchCall![1] as { body: string }).body);
        expect(body).not.toHaveProperty('acknowledgeLockout');
      });
      expect(fetchWithAuth.mock.calls.find((c) => c[0] === PREFLIGHT_URL)).toBeUndefined();
      expect(screen.queryByTestId('enforce-lockout-modal')).toBeNull();
    });

    it('does not preflight an edit that keeps enforcement already on', async () => {
      routeWithPreflight({
        provider: { enforceSSO: true },
        preflight: preflightPayload([{ id: 'u-1', email: 'a@example.com', name: 'A' }])
      });
      render(<SsoProvidersPage />);

      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      await screen.findByRole('button', { name: /save changes/i });
      fireEvent.click(screen.getByTestId('provider-save'));

      await waitFor(() => {
        const patchCall = fetchWithAuth.mock.calls.find(
          (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
        );
        expect(patchCall).toBeTruthy();
      });
      expect(fetchWithAuth.mock.calls.find((c) => c[0] === PREFLIGHT_URL)).toBeUndefined();
    });

    it('activating an enforcing provider preflights and sends acknowledgeLockout on confirm', async () => {
      routeWithPreflight({
        provider: { enforceSSO: true, status: 'inactive' },
        preflight: preflightPayload([{ id: 'u-1', email: 'a@example.com', name: 'A' }])
      });
      render(<SsoProvidersPage />);

      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Activate' }));

      await screen.findByTestId('enforce-lockout-modal');
      fireEvent.click(screen.getByTestId('enforce-lockout-ack'));
      fireEvent.click(screen.getByTestId('enforce-lockout-confirm'));

      await waitFor(() => {
        const statusCall = fetchWithAuth.mock.calls.find(
          (c) => c[0] === '/sso/providers/pp-1/status' && (c[1] as { method?: string })?.method === 'POST'
        );
        expect(statusCall).toBeTruthy();
        const body = JSON.parse((statusCall![1] as { body: string }).body);
        expect(body).toMatchObject({ status: 'active', acknowledgeLockout: true });
      });
    });
  });

  it('PATCHes trustsIdpMfa=false when an already-trusting provider is turned OFF', async () => {
    routeEditableProvider(true);
    render(<SsoProvidersPage />);

    await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const toggle = await screen.findByTestId('provider-trusts-idp-mfa');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('provider-save'));

    await waitFor(() => {
      const patchCall = fetchWithAuth.mock.calls.find(
        (c) => c[0] === '/sso/providers/pp-1' && (c[1] as { method?: string })?.method === 'PATCH'
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as { body: string }).body);
      expect(body.trustsIdpMfa).toBe(false);
    });
  });

  // 2026-08-28 pre-release sweep: save/delete/toggle all succeeded at the API
  // with no visible confirmation, and delete/toggle bypassed runAction
  // entirely. Every mutation must surface its outcome via a toast.
  describe('outcome toasts', () => {
    it('shows a success toast after saving an edited provider', async () => {
      fetchWithAuth.mockImplementation((url: string, opts?: { method?: string }) => {
        if (url === '/sso/providers') return Promise.resolve(jsonRes({ data: [PARTNER_PROVIDER] }));
        if (url === '/sso/providers?scope=partner') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/presets') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/roles') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/providers/pp-1' && (!opts || !opts.method)) {
          return Promise.resolve(jsonRes({
            data: {
              name: 'Team Login', type: 'oidc', preset: '', issuer: 'https://idp.example.com',
              clientId: 'client-1', scopes: 'openid profile email',
              attributeMapping: { email: 'email', name: 'name' },
              autoProvision: true, defaultRoleId: '', allowedDomains: '',
              enforceSSO: false, hasClientSecret: true
            }
          }));
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
        expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
      });
    });

    it('shows a success toast after deleting a provider', async () => {
      fetchWithAuth.mockImplementation((url: string, opts?: { method?: string }) => {
        if (url === '/sso/providers') return Promise.resolve(jsonRes({ data: [PARTNER_PROVIDER] }));
        if (url === '/sso/providers?scope=partner') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/presets') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/roles') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/providers/pp-1' && opts?.method === 'DELETE') {
          return Promise.resolve(jsonRes({ data: { success: true } }));
        }
        return Promise.resolve(jsonRes({ data: [] }));
      });

      render(<SsoProvidersPage />);
      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete provider' }));

      await waitFor(() => {
        expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
      });
    });

    it('shows a success toast after toggling a provider status', async () => {
      fetchWithAuth.mockImplementation((url: string, opts?: { method?: string }) => {
        if (url === '/sso/providers') return Promise.resolve(jsonRes({ data: [PARTNER_PROVIDER] }));
        if (url === '/sso/providers?scope=partner') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/presets') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/roles') return Promise.resolve(jsonRes({ data: [] }));
        if (url === '/sso/providers/pp-1/status' && opts?.method === 'POST') {
          return Promise.resolve(jsonRes({ data: { ...PARTNER_PROVIDER, status: 'inactive' } }));
        }
        return Promise.resolve(jsonRes({ data: [] }));
      });

      render(<SsoProvidersPage />);
      await waitFor(() => expect(screen.getByText('Team Login')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));

      await waitFor(() => {
        expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
      });
    });
  });
});
