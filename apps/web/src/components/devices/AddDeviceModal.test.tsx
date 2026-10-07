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

  it('D14: top-aligns and scrolls the backdrop so the Done button is always reachable', () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    const backdrop = document.querySelector('.dialog-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveClass('items-start', 'overflow-y-auto');
    expect(backdrop).not.toHaveClass('items-center');
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
      if (url === '/enrollment-keys/add-device-parent') {
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
    expect(String(createCall[0])).toBe('/enrollment-keys/add-device-parent');
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
      if (url === '/enrollment-keys/add-device-parent') {
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
      if (url === '/enrollment-keys/add-device-parent') {
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
      if (url === '/enrollment-keys/add-device-parent') {
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
      if (url === '/enrollment-keys/add-device-parent') {
        return makeJsonResponse({ id: 'key-456', key: 'raw-key-def' }, true, 201);
      }
      if (url === '/enrollment-keys/key-456/installer-link?discardKeyOnFailure=1') {
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
    expect(String(linkCall[0])).toBe('/enrollment-keys/key-456/installer-link?discardKeyOnFailure=1');
    expect(JSON.parse((linkCall[1] as RequestInit).body as string).ttlMinutes)
      .toBe(43200);
  });

  it('copies generated link to clipboard', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') {
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

  // #7422: the 2s "copied" reset must not outlive the component — it fired
  // after jsdom teardown ("window is not defined") and set state post-unmount.
  it('clears the copy-link reset timer on unmount (#7422)', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') {
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

    const resetTimers = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: TimerHandler,
      ms?: number,
      ...args: unknown[]
    ) => {
      const id = realSetTimeout(fn as () => void, ms, ...args);
      if (ms === 2000) resetTimers.add(id);
      return id;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      const { unmount } = render(<AddDeviceModal isOpen onClose={vi.fn()} />);
      fireEvent.click(screen.getByText('Generate Link'));
      fireEvent.click(await screen.findByText('Copy'));
      await waitFor(() => expect(resetTimers.size).toBe(1));

      unmount();

      const cleared = clearSpy.mock.calls.map((c) => c[0]);
      for (const id of resetTimers) expect(cleared).toContain(id);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('shows error when download fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') {
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
      fireEvent.click(screen.getByTestId('cli-regenerate-token'));

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
      if (url === '/enrollment-keys/add-device-parent') {
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

  // #7035: opening the tab used to POST /devices/onboarding-token on its own,
  // leaving a live multi-use key behind for every look at the tab.
  it('does not mint a CLI token just because the CLI tab is opened (#7035)', async () => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));

    expect(screen.getByTestId('cli-regenerate-token').textContent).toContain('Generate token');
    // Let any effect-driven request settle before asserting none happened.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  // #7628: after #7035 the tab no longer mints on open, so the command used to
  // render with a literal "<TOKEN>" and the copy button copied it — the agent
  // then failed enrollment with enrollment_key_not_found (exit 11).
  it.each([
    ['Windows'],
    ['Linux/macOS'],
  ])('shows no runnable %s command and no copy button until a token is generated (#7628)', (platform) => {
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));
    fireEvent.click(screen.getByRole('button', { name: platform }));

    expect(screen.queryByText(/<TOKEN>/)).toBeNull();
    expect(screen.queryByTestId('cli-command')).toBeNull();
    expect(screen.queryByTestId('cli-copy-command')).toBeNull();
    expect(screen.getByTestId('cli-command-needs-token').textContent).toContain(
      'Generate a token first'
    );
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('shows and copies the real command once a token is generated (#7628)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'real-token-123', enrollmentSecret: 'secret-abc' })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));
    fireEvent.click(screen.getByTestId('cli-regenerate-token'));

    const command = await screen.findByTestId('cli-command');
    expect(command.textContent).toContain('real-token-123');
    expect(command.textContent).not.toContain('<TOKEN>');
    expect(screen.queryByTestId('cli-command-needs-token')).toBeNull();

    fireEvent.click(screen.getByTestId('cli-copy-command'));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(command.textContent);
    });
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).toContain('real-token-123');
  });

  it('shows the no-sites notice on the CLI tab and cannot mint without a site (#7035)', () => {
    setOrgStore({ sites: [] });
    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));

    expect(screen.getByText(/No sites available/)).toBeDefined();
    expect(screen.queryByTestId('cli-site')).toBeNull();
    const generate = screen.getByTestId('cli-regenerate-token') as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    fireEvent.click(generate);
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('mints the CLI token for the site chosen in the modal (#7035)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'site-token', maxUsage: 50, siteId: SITE_B.id })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-cli'));
    fireEvent.change(screen.getByTestId('cli-site'), { target: { value: SITE_B.id } });
    fireEvent.click(screen.getByTestId('cli-regenerate-token'));

    await waitFor(() => {
      expect(screen.getByText('site-token')).toBeDefined();
    });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    const init = fetchWithAuthMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      count: 50,
      ttlMinutes: 43200,
      siteId: SITE_B.id,
    });
    expect(screen.getByTestId('cli-token-site').textContent).toContain('Branch Office');
  });

  it('fetches onboarding token when Generate is clicked on the CLI tab', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'test-token-xyz', enrollmentSecret: 'secret-abc' })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    // Installer tab is active by default (jsdom UA "darwin" contains "win").
    // Opening the CLI tab no longer mints anything (#7035) — Generate does.
    fireEvent.click(screen.getByText('CLI Commands'));
    fireEvent.click(screen.getByTestId('cli-regenerate-token'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/devices/onboarding-token',
        // #1108: the request now carries a device count → maxUsage.
        // #2777: …and an explicit TTL (default 30 days) with the JSON content type
        // the route's strict validator requires.
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 50, ttlMinutes: 43200, siteId: SITE_A.id }),
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
    fireEvent.click(screen.getByTestId('cli-regenerate-token'));

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

  // #8120: the command used the build-time PUBLIC_API_URL (empty in the
  // published image) or the page origin, which is the dashboard host on split
  // dashboard/API deployments. The server's runtime URL wins when it sends one.
  it('builds the install command from the serverUrl the token route returns (#8120)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'test-token-xyz', serverUrl: 'https://agents.example.test' })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('CLI Commands'));
    fireEvent.click(screen.getByTestId('cli-regenerate-token'));

    await waitFor(() => {
      expect(screen.getByText('test-token-xyz')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Linux/macOS' }));
    expect(
      screen.getByText(/https:\/\/agents\.example\.test\/api\/v1\/agents\/install\.sh/)
    ).toBeDefined();
    expect(screen.queryByText(new RegExp(`${window.location.origin}/api/v1/agents/install`))).toBeNull();
  });

  it('falls back to the page origin when the token route sends no serverUrl (#8120)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ token: 'test-token-xyz' }));

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('CLI Commands'));
    fireEvent.click(screen.getByTestId('cli-regenerate-token'));

    await waitFor(() => {
      expect(screen.getByText('test-token-xyz')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Linux/macOS' }));
    expect(screen.getByText(new RegExp(`${window.location.origin}/api/v1/agents/install`))).toBeDefined();
  });

  it('requests a multi-use token after the operator raises the device count (#1108)', async () => {
    // Initial single-device mint on the first Generate click.
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ token: 'token-single', maxUsage: 1, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    );

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('CLI Commands'));
    fireEvent.click(screen.getByTestId('cli-regenerate-token'));

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
          body: JSON.stringify({ count: 5, ttlMinutes: 43200, siteId: SITE_A.id }),
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
    fireEvent.click(screen.getByTestId('cli-regenerate-token'));

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
    await userEvent.click(screen.getByTestId('cli-regenerate-token'));
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
      if (url === '/enrollment-keys/add-device-parent') {
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
    fireEvent.click(screen.getByTestId('cli-regenerate-token'));

    await waitFor(() => {
      expect(screen.getByText('cli-token')).toBeDefined();
    });

    expect((screen.getByTestId('cli-link-ttl') as HTMLSelectElement).value).toBe('10080');
    expect((screen.getByTestId('cli-device-count') as HTMLInputElement).value).toBe('25');
    expect(optionLabels('cli-link-ttl')).toEqual(['1 hour', '24 hours', '7 days', '30 days']);

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/devices/onboarding-token',
      expect.objectContaining({
        body: JSON.stringify({ count: 25, ttlMinutes: 10080, siteId: SITE_A.id }),
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
      if (url === '/enrollment-keys/add-device-parent') {
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

// #7217 — every Download / Generate Link click mints a parent key first. A
// failed attempt must not leave that key live: the server discards it on an
// HTTP failure (the request carries ?discardKeyOnFailure=1), and the modal
// deletes it itself when the request never got an answer.
describe('AddDeviceModal — failed attempts leave no live key (#7217)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOrgStore();
    authState.user = { hasPassword: true };
  });

  function deleteCalls() {
    return fetchWithAuthMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    );
  }

  it('asks the installer route to discard the key on failure', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') return makeJsonResponse({ id: 'key-d1' }, true, 201);
      if (url.startsWith('/enrollment-keys/key-d1/installer/')) {
        return makeJsonResponse({ error: 'MSI not available' }, false, 503);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(getDownloadButton());

    await waitFor(() => expect(screen.getByText(/MSI not available/)).toBeDefined());
    const dlUrl = String(fetchWithAuthMock.mock.calls[1][0]);
    expect(dlUrl).toContain('discardKeyOnFailure=1');
    // The server discarded it; the modal must not send a second delete.
    expect(deleteCalls()).toHaveLength(0);
  });

  it('asks the link route to discard the key on failure', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') return makeJsonResponse({ id: 'key-d2' }, true, 201);
      if (url.startsWith('/enrollment-keys/key-d2/installer-link')) {
        return makeJsonResponse({ error: 'macOS PKG not reachable' }, false, 503);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => expect(screen.getByText(/macOS PKG not reachable/)).toBeDefined());
    expect(String(fetchWithAuthMock.mock.calls[1][0])).toBe(
      '/enrollment-keys/key-d2/installer-link?discardKeyOnFailure=1',
    );
    expect(deleteCalls()).toHaveLength(0);
  });

  it('deletes the key itself when the installer request never gets an answer', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') return makeJsonResponse({ id: 'key-d3' }, true, 201);
      if (url.startsWith('/enrollment-keys/key-d3/installer/')) {
        throw new TypeError('Failed to fetch');
      }
      if (url === '/enrollment-keys/key-d3' && init?.method === 'DELETE') {
        return makeJsonResponse({ success: true });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(getDownloadButton());

    await waitFor(() => expect(screen.getByText(/Failed to fetch/)).toBeDefined());
    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(String(deleteCalls()[0][0])).toBe('/enrollment-keys/key-d3');
  });

  it('deletes the key itself when the link request never gets an answer', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') return makeJsonResponse({ id: 'key-d4' }, true, 201);
      if (url.startsWith('/enrollment-keys/key-d4/installer-link')) {
        throw new TypeError('Failed to fetch');
      }
      if (url === '/enrollment-keys/key-d4' && init?.method === 'DELETE') {
        return makeJsonResponse({ success: true });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(String(deleteCalls()[0][0])).toBe('/enrollment-keys/key-d4');
  });

  it('logs a key it could not delete instead of dropping it silently', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') return makeJsonResponse({ id: 'key-d5' }, true, 201);
      if (url.startsWith('/enrollment-keys/key-d5/installer/')) {
        throw new TypeError('Failed to fetch');
      }
      if (init?.method === 'DELETE') return makeJsonResponse({ error: 'nope' }, false, 500);
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(getDownloadButton());

    await waitFor(() =>
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringMatching(/could not delete/i),
        expect.objectContaining({ keyId: 'key-d5' }),
      ),
    );
    errSpy.mockRestore();
  });
});

// #7345 — Download / Generate Link no longer mint a parent per click. The
// server hands back the caller's existing parent for the site when it is
// still good (`reused: true`) and mints one only when it is not. A reused
// parent already backs earlier installers, so a failed attempt must never
// ask for it to be discarded.
describe('AddDeviceModal — reuses the site parent key (#7345)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOrgStore();
    authState.user = { hasPassword: true };
  });

  function deleteCalls() {
    return fetchWithAuthMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    );
  }

  it('asks the server for the site parent instead of minting a key per click', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') {
        return makeJsonResponse({ id: 'key-r1', reused: true }, true, 200);
      }
      if (url.startsWith('/enrollment-keys/key-r1/installer/')) return makeJsonResponse(null, true);
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(getDownloadButton());

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchWithAuthMock.mock.calls[0];
    expect(String(url)).toBe('/enrollment-keys/add-device-parent');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      siteId: 'site-aaa-111',
      orgId: 'org-111',
    });
    expect(fetchWithAuthMock.mock.calls.some(([u]) => String(u) === '/enrollment-keys')).toBe(false);
  });

  it('never asks the installer route to discard a reused parent', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') {
        return makeJsonResponse({ id: 'key-r2', reused: true }, true, 200);
      }
      if (url.startsWith('/enrollment-keys/key-r2/installer/')) {
        return makeJsonResponse({ error: 'MSI not available' }, false, 503);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(getDownloadButton());

    await waitFor(() => expect(screen.getByText(/MSI not available/)).toBeDefined());
    expect(String(fetchWithAuthMock.mock.calls[1][0])).not.toContain('discardKeyOnFailure');
  });

  it('never asks the link route to discard a reused parent', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') {
        return makeJsonResponse({ id: 'key-r3', reused: true }, true, 200);
      }
      if (url.startsWith('/enrollment-keys/key-r3/installer-link')) {
        return makeJsonResponse({ shortUrl: 'https://x/s/abc' }, true);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    expect(String(fetchWithAuthMock.mock.calls[1][0])).toBe(
      '/enrollment-keys/key-r3/installer-link',
    );
  });

  it('does not delete a reused parent when the request never gets an answer', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys/add-device-parent') {
        return makeJsonResponse({ id: 'key-r4', reused: true }, true, 200);
      }
      if (url.startsWith('/enrollment-keys/key-r4/')) throw new TypeError('Failed to fetch');
      return makeJsonResponse({ success: true });
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);
    fireEvent.click(getDownloadButton());
    await waitFor(() => expect(screen.getByText(/Failed to download installer/)).toBeDefined());

    fireEvent.click(screen.getByText('Generate Link'));
    await waitFor(() => expect(screen.getByText(/Failed to generate link/)).toBeDefined());

    expect(deleteCalls()).toHaveLength(0);
  });
});
