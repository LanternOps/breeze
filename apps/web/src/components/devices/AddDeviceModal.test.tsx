import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
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
  });

  it('generates a public link on button click', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-456', key: 'raw-key-def' }, true, 201);
      }
      if (url === '/enrollment-keys/key-456/installer-link') {
        return makeJsonResponse({
          url: 'https://api.example.com/api/v1/enrollment-keys/public-download/windows?token=abc123',
          expiresAt: '2026-04-14T00:00:00Z',
          maxUsage: 1,
          platform: 'windows',
          childKeyId: 'child-key-789',
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<AddDeviceModal isOpen onClose={vi.fn()} />);

    fireEvent.click(screen.getByText('Generate Link'));

    await waitFor(() => {
      expect(screen.getByDisplayValue(/public-download/)).toBeDefined();
    });

    expect(screen.getByText(/Valid for 1 download/)).toBeDefined();
  });

  it('copies generated link to clipboard', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/enrollment-keys') {
        return makeJsonResponse({ id: 'key-456' }, true, 201);
      }
      if (url.includes('/installer-link')) {
        return makeJsonResponse({
          url: 'https://api.example.com/public-download/windows?token=abc',
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
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/onboarding-token', { method: 'POST' });
    });

    await waitFor(() => {
      expect(screen.getByText('test-token-xyz')).toBeDefined();
    });
  });
});
