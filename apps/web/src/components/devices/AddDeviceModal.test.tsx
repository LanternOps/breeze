import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force a deterministic navigator.userAgent BEFORE importing the component,
// so `detectUserOS()` resolves to 'windows' regardless of host OS. On macOS
// jsdom's default UA contains "darwin" (which includes "win"), but on Linux
// CI it contains "linux" — without this override, the installer tab would
// not be the default and the UI-level assertions below would all fail.
Object.defineProperty(window.navigator, 'userAgent', {
  configurable: true,
  value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 jsdom/test',
});

import AddDeviceModal from './AddDeviceModal';
import { fetchWithAuth } from '../../stores/auth';

// --- Mocks ---

// #4018: the modal reads `user.hasPassword` off the auth store to choose the
// MFA_REQUIRED copy. Kept as a MUTABLE hoisted object so a test can flip the
// flag between renders without re-mocking the module.
const { authState } = vi.hoisted(() => ({
  authState: { user: null as { hasPassword?: boolean } | null },
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

import { useOrgStore } from '../../stores/orgStore';
const useOrgStoreMock = vi.mocked(useOrgStore);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
    blob: vi.fn().mockResolvedValue(new Blob(['binary'])),
  }) as unknown as Response;

const SITE_A = { id: 'site-aaa-111', orgId: 'org-111', name: 'HQ Office', createdAt: '2026-01-01', deviceCount: 5 };
const SITE_B = { id: 'site-bbb-222', orgId: 'org-111', name: 'Branch Office', createdAt: '2026-01-02', deviceCount: 3 };

function setOrgStore(overrides: Partial<ReturnType<typeof useOrgStore>> = {}) {
  useOrgStoreMock.mockReturnValue({
    currentPartnerId: 'partner-1',
    currentOrgId: 'org-111',
    currentSiteId: 'site-aaa-111',
    partners: [],
    organizations: [],
    sites: [SITE_A, SITE_B],
    isLoading: false,
    error: null,
    setPartner: vi.fn(),
    setOrganization: vi.fn(),
    setSite: vi.fn(),
    fetchPartners: vi.fn(),
    fetchOrganizations: vi.fn(),
    fetchSites: vi.fn(),
    clearOrgContext: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useOrgStore>);
}

// Mock clipboard
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

// Mock URL.createObjectURL / revokeObjectURL
global.URL.createObjectURL = vi.fn(() => 'blob:http://localhost/fake');
global.URL.revokeObjectURL = vi.fn();

// NOTE: jsdom on macOS reports UA "Mozilla/5.0 (darwin) ..." — "darwin"
// contains the substring "win", so detectUserOS() returns 'windows'.
// This means the installer tab is active by default and selectedPlatform is 'windows'.

/** Find the action button labelled "Download Installer" (not the tab). */
function getDownloadButton(): HTMLElement {
  // The tab button and the action button both contain text "Download Installer".
  // The action button has the wider/primary class; use getAllByText and pick the
  // one inside the form area (the one with the download icon / w-full class).
  const all = screen.getAllByText(/Download Installer/);
  // Action button has class 'w-full'; tab button does not.
  const actionBtn = all.find((el) => el.className.includes('w-full'));
  if (actionBtn) return actionBtn;
  // Fallback: return the last one (action button comes after tab button in DOM)
  return all[all.length - 1];
}

describe('AddDeviceModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOrgStore();
    authState.user = { hasPassword: true };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders site selector with org sites', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const select = screen.getByLabelText('Site');
    expect(select).toBeDefined();

    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toBe('HQ Office');
    expect(options[1].textContent).toBe('Branch Office');
  });

  it('shows no-sites warning when org has no sites', () => {
    setOrgStore({ sites: [] });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    expect(screen.getByText(/No sites available/)).toBeDefined();
  });

  it('does not render content when modal is closed', () => {
    render(<AddDeviceModal isOpen={false} onClose={vi.fn()} />);

    expect(screen.queryByText('Add New Device')).toBeNull();
  });

  it('links to one public uninstall script and shows platform-specific verify commands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('abc123  uninstall.sh\n', {
        headers: { 'content-type': 'text/plain' },
      }),
    ));

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const link = screen.getByText('Linux/macOS').closest('a');
    expect(link?.getAttribute('href')).toBe('/api/v1/agents/uninstall.sh');
    expect(link?.getAttribute('download')).toBe('uninstall.sh');

    await waitFor(() => {
      expect(screen.getByText(/SHA256: abc123/)).toBeDefined();
    });
    expect(screen.getByText('shasum -a 256 uninstall.sh')).toBeDefined();
    expect(screen.getByText('sha256sum uninstall.sh')).toBeDefined();
  });

  it('switches platform when platform buttons are clicked', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const macosButton = screen.getByText('macOS (.zip)');
    fireEvent.click(macosButton);

    expect(macosButton.className).toContain('bg-primary');

    const windowsButton = screen.getByText('Windows (.msi)');
    expect(windowsButton.className).not.toContain('bg-primary');
  });

  it('clamps device count between 1 and 1000', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const input = screen.getByLabelText('Number of devices') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '5000' } });
    expect(input.value).toBe('1000');

    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('1');
  });

  it('downloads installer on button click', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-123', key: 'raw-key-abc' }, true, 201);
      }
      if (url.startsWith('/enrollment-keys/key-123/installer/')) {
        return makeJsonResponse(null, true);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const createCall = fetchWithAuthMock.mock.calls[0];
    expect(String(createCall[0])).toBe('/enrollment-keys');
    const createBody = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(createBody.siteId).toBe('site-aaa-111');
    // ttlMinutes drives the *child* key now, not the transient parent —
    // the parent POST must NOT carry it (PR #739 review finding #1).
    expect(createBody.ttlMinutes).toBeUndefined();

    // Default 30 days (43200) flows to the installer (child) download URL.
    const dlCall = fetchWithAuthMock.mock.calls[1];
    expect(String(dlCall[0])).toContain('ttlMinutes=43200');
  });

  // #2992 — the parent key must NOT carry the device count. max_usage is an
  // enforced enrollment budget (/agents/enroll matches on
  // usage_count < max_usage; the short-link and MCP-invite paths atomically
  // claim it), so writing the device count there would widen a live credential
  // to fix a display string. The count belongs on the bootstrap token, which
  // the Enrollment Keys list now reads. Pinned so the tempting one-line "fix"
  // can't come back.
  it('does NOT write the device count into the parent key budget', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-123', key: 'raw-key-abc' }, true, 201);
      }
      if (url.startsWith('/enrollment-keys/key-123/installer/')) {
        return makeJsonResponse(null, true);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('device-count'), { target: { value: '7' } });
    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const createBody = JSON.parse(
      (fetchWithAuthMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(createBody.maxUsage).toBeUndefined();

    // The count drives the installer (bootstrap token) cap, and only that.
    expect(String(fetchWithAuthMock.mock.calls[1][0])).toContain('count=7');
  });

  // A fractional count is reachable (the input has no `step` and isn't inside
  // a <form>). The download route bounds `count` to an int, so round before
  // sending — otherwise the operator gets an opaque 400 naming a wire field.
  it('rounds a fractional device count before it reaches the mint route', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-123', key: 'raw-key-abc' }, true, 201);
      }
      if (url.startsWith('/enrollment-keys/key-123/installer/')) {
        return makeJsonResponse(null, true);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('device-count'), { target: { value: '2.5' } });
    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    expect(String(fetchWithAuthMock.mock.calls[1][0])).toContain('count=3');
  });

  it('sends the selected expiry to the installer download URL', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-123', key: 'raw-key-abc' }, true, 201);
      }
      if (url.startsWith('/enrollment-keys/key-123/installer/')) {
        return makeJsonResponse(null, true);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('link-ttl'), { target: { value: '10080' } });
    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });

    const dlCall = fetchWithAuthMock.mock.calls[1];
    expect(String(dlCall[0])).toContain('ttlMinutes=10080');
  });

  it('generates a public link on button click', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-456', key: 'raw-key-def' }, true, 201);
      }
      if (url === '/enrollment-keys/key-456/installer-link') {
        return makeJsonResponse({
          url: 'https://api.example.com/api/v1/enrollment-keys/public-download/windows?h=dlh_abc123',
          expiresAt: '2026-04-14T00:00:00Z',
          maxUsage: 1,
          platform: 'windows',
          childKeyId: 'child-key-789',
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('link-ttl'), { target: { value: '43200' } });
    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => {
      expect(screen.getByDisplayValue(/public-download/)).toBeDefined();
    });

    expect(screen.getByText(/Valid for 50 downloads/)).toBeDefined();

    // ttlMinutes goes on the installer-link (child) body, not the parent POST.
    const createCall = fetchWithAuthMock.mock.calls[0];
    const createBody = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(createBody.ttlMinutes).toBeUndefined();
    // Like the download path (#2992), the link path leaves maxUsage off its
    // parent — max_usage is an enforced enrollment budget, not a display label.
    expect(createBody.maxUsage).toBeUndefined();
    const linkCall = fetchWithAuthMock.mock.calls[1];
    expect(String(linkCall[0])).toBe('/enrollment-keys/key-456/installer-link');
    expect(JSON.parse((linkCall[1] as RequestInit).body as string).ttlMinutes)
      .toBe(43200);
  });

  it('copies generated link to clipboard', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-456' }, true, 201);
      }
      if (url.includes('/installer-link')) {
        return makeJsonResponse({
          url: 'https://api.example.com/public-download/windows?h=dlh_abc',
          expiresAt: null,
          maxUsage: 1,
          platform: 'windows',
          childKeyId: 'child-1',
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Generate Link'));

    const copyButton = await screen.findByText('Copy');
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('public-download')
      );
    });
  });

  it('shows error when download fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-err' }, true, 201);
      }
      if (url.includes('/installer/')) {
        return makeJsonResponse({ error: 'Template MSI not available' }, false, 503);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(screen.getByText(/Template MSI not available/)).toBeDefined();
    });
  });

  it('shows MFA warning when enrollment key creation returns 403 mfa required', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ error: 'MFA required' }, false, 403)
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(getDownloadButton());

    await waitFor(() => {
      expect(screen.getByText(/Multi-factor authentication is required/)).toBeDefined();
    });
  });

  // #4018: "set up MFA in your profile settings and sign in again" is a DEAD
  // END for an SSO-provisioned account — it has no password, so the profile
  // enrollment flow rejects it. Those users get the identity-provider road.
  describe('MFA_REQUIRED copy for a passwordless SSO account (#4018)', () => {
    async function failWithMfaRequired(trigger: () => void) {
      fetchWithAuthMock.mockResolvedValue(
        makeJsonResponse({ error: 'MFA required' }, false, 403)
      );
      render(<AddDeviceModal isOpen onClose={vi.fn()} />);
      trigger();
    }

    it('points the installer download at the identity provider, not the password flow', async () => {
      authState.user = { hasPassword: false };
      await failWithMfaRequired(() => fireEvent.click(getDownloadButton()));

      const banner = await screen.findByTestId('download-mfa-required');
      expect(banner.textContent).toContain('signs you in through an identity provider');
      // The dead-end instruction must be GONE, not merely supplemented.
      expect(banner.textContent).not.toContain('and sign in again');
      expect(banner.querySelector('a')).toBeNull();
    });

    it('points link generation at the identity provider', async () => {
      authState.user = { hasPassword: false };
      await failWithMfaRequired(() => fireEvent.click(screen.getByText('Generate Link')));

      const banner = await screen.findByTestId('link-mfa-required');
      expect(banner.textContent).toContain('required to generate links');
      expect(banner.textContent).toContain('signs you in through an identity provider');
      expect(banner.textContent).not.toContain('and sign in again');
    });

    it('points CLI token generation at the identity provider', async () => {
      authState.user = { hasPassword: false };
      fetchWithAuthMock.mockResolvedValue(
        makeJsonResponse({ error: 'MFA required' }, false, 403)
      );
      render(<AddDeviceModal isOpen onClose={vi.fn()} />);
      fireEvent.click(screen.getByText('CLI Commands'));

      const banner = await screen.findByTestId('token-mfa-required');
      expect(banner.textContent).toContain('required to generate installation tokens');
      expect(banner.textContent).toContain('signs you in through an identity provider');
    });

    it('keeps the password-account copy when hasPassword is true', async () => {
      authState.user = { hasPassword: true };
      await failWithMfaRequired(() => fireEvent.click(getDownloadButton()));

      const banner = await screen.findByTestId('download-mfa-required');
      expect(banner.textContent).toContain('Set up MFA in your profile settings');
      expect(banner.textContent).not.toContain('identity provider');
      expect(banner.querySelector('a')?.getAttribute('href')).toBe('/settings/profile');
    });

    // Absent is UNKNOWN (a session persisted before /users/me carried the
    // field), and unknown must NOT silently take the SSO road — a password
    // user would then be told to go ask their admin about an IdP they don't use.
    it('keeps the password-account copy when hasPassword is absent', async () => {
      authState.user = {};
      await failWithMfaRequired(() => fireEvent.click(getDownloadButton()));

      const banner = await screen.findByTestId('download-mfa-required');
      expect(banner.textContent).toContain('Set up MFA in your profile settings');
      expect(banner.textContent).not.toContain('identity provider');
    });
  });

  it('shows error when link generation fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-link-err' }, true, 201);
      }
      if (url.includes('/installer-link')) {
        return makeJsonResponse({ error: 'macOS PKG not available' }, false, 503);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => {
      expect(screen.getByText(/macOS PKG not available/)).toBeDefined();
    });
  });

  it('fetches onboarding token when CLI tab is clicked', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'test-token-xyz', enrollmentSecret: 'secret-abc' })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    // Installer tab is active by default (jsdom UA "darwin" contains "win")
    // Click CLI Commands tab to trigger lazy-load
    fireEvent.click(screen.getByText('CLI Commands'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/devices/onboarding-token',
        // #1108: the request now carries a device count → maxUsage.
        // #2777: …and an explicit TTL (default 30 days) with the JSON content type
        // the route's strict validator requires.
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 50, ttlMinutes: 43200 }),
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText('test-token-xyz')).toBeDefined();
    });
  });

  it('groups the shared install.sh command under one Linux/macOS option', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'test-token-xyz', enrollmentSecret: 'secret-abc' })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('CLI Commands'));

    await waitFor(() => {
      expect(screen.getByText('test-token-xyz')).toBeDefined();
    });

    expect(screen.getByRole('button', { name: 'Windows' })).toBeDefined();
    const unixButton = screen.getByRole('button', { name: 'Linux/macOS' });
    expect(unixButton).toBeDefined();
    expect(screen.queryByRole('button', { name: 'macOS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Linux' })).toBeNull();

    fireEvent.click(unixButton);

    expect(screen.getByText(/\/api\/v1\/agents\/install\.sh/)).toBeDefined();
    expect(screen.getByText('Run in Terminal')).toBeDefined();
  });

  it('requests a multi-use token after the operator raises the device count (#1108)', async () => {
    // Initial single-device fetch on tab open.
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'token-single', maxUsage: 1, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('CLI Commands'));

    await waitFor(() => {
      expect(screen.getByText('token-single')).toBeDefined();
    });

    // Operator bumps the count and regenerates → server returns a 5-use token.
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'token-multi', maxUsage: 5, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    );

    const countInput = screen.getByLabelText('Number of devices') as HTMLInputElement;
    fireEvent.change(countInput, { target: { value: '5' } });
    fireEvent.click(screen.getByText('Generate new token'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenLastCalledWith(
        '/devices/onboarding-token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 5, ttlMinutes: 43200 }),
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText('token-multi')).toBeDefined();
      expect(screen.getByText(/Valid for 5 device enrollments/)).toBeDefined();
    });
  });

  it('shows the real token expiry instead of a hard-coded "24 hours" (#1108)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        token: 'token-exp',
        maxUsage: 1,
        // ~1 hour out → formatTokenExpiry renders "in about 1 hour".
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('CLI Commands'));

    await waitFor(() => {
      expect(screen.getByText('token-exp')).toBeDefined();
    });

    // The corrected, server-derived copy is shown…
    expect(screen.getByText(/expires in about 1 hour/)).toBeDefined();
    // …and the old misleading hard-coded string is gone.
    expect(screen.queryByText(/expires in 24 hours/)).toBeNull();
  });

  it('sends the selected expiry on the CLI onboarding-token request', async () => {
    fetchWithAuthMock.mockImplementation(async () =>
      new Response(JSON.stringify({
        token: 'enroll_abc', maxUsage: 1,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        enrollmentSecretMode: 'none', additionalSecretRequired: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    render(<AddDeviceModal isOpen onClose={() => {}} />);
    await userEvent.click(screen.getByTestId('tab-cli'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    fetchWithAuthMock.mockClear();

    await userEvent.selectOptions(screen.getByTestId('cli-link-ttl'), '10080');
    await userEvent.click(screen.getByTestId('cli-regenerate-token'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const call = fetchWithAuthMock.mock.calls[0];
    expect(String(call[0])).toBe('/devices/onboarding-token');
    const init = call[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({ ttlMinutes: 10080 });
    expect((init.headers as Record<string, string>)['Content-Type'])
      .toBe('application/json');
  });
});

describe('AddDeviceModal — resolved enrollment defaults (#2776)', () => {
  const optionLabels = (testId: string): (string | null)[] =>
    Array.from((screen.getByTestId(testId) as HTMLSelectElement).options).map(
      (o) => o.textContent,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    setOrgStore();
    authState.user = { hasPassword: true };
  });

  it('pre-selects the partner/org default TTL and count, and hides options above the cap', async () => {
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 10080, deviceCount: 25, maxTtlMinutes: 43200 },
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect((screen.getByTestId('link-ttl') as HTMLSelectElement).value).toBe('10080');
    });
    expect((screen.getByTestId('device-count') as HTMLInputElement).value).toBe('25');

    // 90 days and 1 year are above the 30-day cap and must not be offerable.
    expect(optionLabels('link-ttl')).toEqual(['1 hour', '24 hours', '7 days', '30 days']);
  });

  it('falls back to the product defaults when the store has not resolved them yet', () => {
    setOrgStore({ enrollmentDefaults: null });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    expect((screen.getByTestId('link-ttl') as HTMLSelectElement).value).toBe('43200');
    expect((screen.getByTestId('device-count') as HTMLInputElement).value).toBe('50');
    expect(optionLabels('link-ttl')).toEqual([
      '1 hour',
      '24 hours',
      '7 days',
      '30 days',
      '90 days',
      '1 year',
    ]);
  });

  it('clamps a resolved default that sits above the cap instead of submitting a 400', async () => {
    // The server resolver clamps, but a tab left open across a cap change (or
    // any future resolver bug) must not put an over-cap value on the wire.
    // Cap deliberately != the old hard-coded 1440, so this cannot pass on the
    // pre-change component.
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 525600, deviceCount: 1, maxTtlMinutes: 10080 },
    });

    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-cap', key: 'raw' }, true, 201);
      }
      return makeJsonResponse(null, true);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect((screen.getByTestId('link-ttl') as HTMLSelectElement).value).toBe('10080');
    });

    fireEvent.click(getDownloadButton());
    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });
    expect(String(fetchWithAuthMock.mock.calls[1][0])).toContain('ttlMinutes=10080');
  });

  it('seeds the CLI tab from the same defaults while keeping its state independent', async () => {
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 10080, deviceCount: 25, maxTtlMinutes: 43200 },
    });
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ token: 'cli-token', maxUsage: 25 }),
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));

    await waitFor(() => {
      expect(screen.getByText('cli-token')).toBeDefined();
    });

    expect((screen.getByTestId('cli-link-ttl') as HTMLSelectElement).value).toBe('10080');
    expect((screen.getByTestId('cli-device-count') as HTMLInputElement).value).toBe('25');
    expect(optionLabels('cli-link-ttl')).toEqual(['1 hour', '24 hours', '7 days', '30 days']);

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/devices/onboarding-token',
      expect.objectContaining({
        body: JSON.stringify({ count: 25, ttlMinutes: 10080 }),
      }),
    );

    // Seeded from the same resolved default, but still its own state: changing
    // the CLI expiry must not move the installer tab's.
    fireEvent.change(screen.getByTestId('cli-link-ttl'), { target: { value: '60' } });
    fireEvent.click(screen.getByTestId('tab-installer'));
    expect((screen.getByTestId('link-ttl') as HTMLSelectElement).value).toBe('10080');
  });

  it('renders a non-canonical resolved default as its own option so display matches what is submitted', async () => {
    // 20000 is under the 43200 cap but is not a canonical option. Filtering it
    // out would leave the select matching nothing — the browser shows "1 hour"
    // while the download URL still carries 20000.
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 20000, deviceCount: 1, maxTtlMinutes: 43200 },
    });

    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-nc', key: 'raw' }, true, 201);
      }
      return makeJsonResponse(null, true);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect((screen.getByTestId('link-ttl') as HTMLSelectElement).value).toBe('20000');
    });
    expect(
      [...(screen.getByTestId('link-ttl') as HTMLSelectElement).options].map(o => o.value),
    ).toEqual(['60', '1440', '10080', '20000', '43200']);

    // What is displayed is what goes on the wire.
    fireEvent.click(getDownloadButton());
    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    });
    expect(String(fetchWithAuthMock.mock.calls[1][0])).toContain('ttlMinutes=20000');
  });

  it('offers the cap itself when it sits below every canonical option', async () => {
    setOrgStore({
      enrollmentDefaults: { ttlMinutes: 30, deviceCount: 1, maxTtlMinutes: 30 },
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect((screen.getByTestId('link-ttl') as HTMLSelectElement).value).toBe('30');
    });
    expect(optionLabels('link-ttl')).toEqual(['in about 30 minutes']);
  });
});
