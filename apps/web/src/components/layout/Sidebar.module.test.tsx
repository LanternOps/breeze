import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Harness copied from Sidebar.featuregate.test.tsx (the AI-for-Office gate),
// plus `registerOrgIdProvider`: this suite loads the REAL orgStore so the module
// gate is exercised against the actual persisted state, and orgStore imports
// that helper from the mocked auth module at load time.
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (
      selector: (s: {
        user: { isPlatformAdmin: boolean; permissions: Array<{ resource: string; action: string }> };
      }) => unknown,
    ) => selector({ user: { isPlatformAdmin: false, permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: () => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() }),
}));
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';
import { useOrgStore } from '../../stores/orgStore';

/** `/orgs/partners/me` answers 200 with the given mode; everything else 404s. */
function mockPartner(serviceManagementMode: string | undefined) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/orgs/partners/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ name: 'Acme MSP', serviceManagementMode, settings: {} }),
      } as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  });
}

/** Every request fails, including the partner fetch — the fail-open case. */
function mockPartnerFetchFailure() {
  fetchWithAuthMock.mockRejectedValue(new Error('network down'));
}

const TICKETS = 'a[href="/tickets"]';
const TIMESHEETS = 'a[href="/timesheet"]';
const INVOICES = 'a[href="/billing/invoices"]';
const CONTRACTS = 'a[href="/contracts"]';
const ORGANIZATIONS = 'a[href="/settings/organizations"]';
const REPORTS = 'a[href="/reports"]';

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  useOrgStore.setState({ serviceManagementMode: 'native' });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.clearAllMocks();
  useOrgStore.setState({ serviceManagementMode: 'native' });
});

describe('Sidebar — Service Management module gate (#5075 W04)', () => {
  it('shows Service Desk and Billing when the partner runs native', async () => {
    mockPartner('native');
    const { container } = render(<Sidebar currentPath="/" />);

    await waitFor(() => expect(container.querySelector(TICKETS)).not.toBeNull());
    expect(container.querySelector(TIMESHEETS)).not.toBeNull();
    expect(container.querySelector(INVOICES)).not.toBeNull();
    expect(container.querySelector(CONTRACTS)).not.toBeNull();
    expect(useOrgStore.getState().serviceManagementMode).toBe('native');
  });

  it('hides both sections when the partner has the module off', async () => {
    mockPartner('off');
    const { container } = render(<Sidebar currentPath="/" />);

    // Wait for the fetch to land in the store before asserting an ABSENCE —
    // otherwise the assertion could pass against the pre-fetch render and prove
    // nothing about the gate.
    await waitFor(() => expect(useOrgStore.getState().serviceManagementMode).toBe('off'));
    await waitFor(() => expect(container.querySelector(TICKETS)).toBeNull());

    expect(container.querySelector(TIMESHEETS)).toBeNull();
    expect(container.querySelector(INVOICES)).toBeNull();
    expect(container.querySelector(CONTRACTS)).toBeNull();
    // Only the module's surfaces go — the rest of the nav is untouched.
    expect(container.querySelector(ORGANIZATIONS)).not.toBeNull();
    expect(container.querySelector(REPORTS)).not.toBeNull();
  });

  it('hides both native sections when the partner runs an external PSA', async () => {
    mockPartner('external');
    const { container } = render(<Sidebar currentPath="/" />);

    await waitFor(() => expect(useOrgStore.getState().serviceManagementMode).toBe('external'));
    await waitFor(() => expect(container.querySelector(TICKETS)).toBeNull());

    expect(container.querySelector(TIMESHEETS)).toBeNull();
    expect(container.querySelector(INVOICES)).toBeNull();
    expect(container.querySelector(ORGANIZATIONS)).not.toBeNull();
  });

  it('fails OPEN: a failed partner fetch leaves the sections visible', async () => {
    mockPartnerFetchFailure();
    const { container } = render(<Sidebar currentPath="/" />);

    await waitFor(() => expect(container.querySelector(ORGANIZATIONS)).not.toBeNull());
    expect(container.querySelector(TICKETS)).not.toBeNull();
    expect(container.querySelector(INVOICES)).not.toBeNull();
    expect(useOrgStore.getState().serviceManagementMode).toBe('native');
  });

  it('fails OPEN: an unrecognised mode from a newer API falls back to native', async () => {
    useOrgStore.setState({ serviceManagementMode: 'off' });
    mockPartner('brand_new_mode');
    const { container } = render(<Sidebar currentPath="/" />);

    await waitFor(() => expect(useOrgStore.getState().serviceManagementMode).toBe('native'));
    expect(container.querySelector(TICKETS)).not.toBeNull();
  });

  it('fails OPEN: an API that omits the field falls back to native', async () => {
    useOrgStore.setState({ serviceManagementMode: 'off' });
    mockPartner(undefined);
    const { container } = render(<Sidebar currentPath="/" />);

    await waitFor(() => expect(useOrgStore.getState().serviceManagementMode).toBe('native'));
    expect(container.querySelector(TICKETS)).not.toBeNull();
  });
});

describe('Sidebar — Organizations placement (#5075 W04)', () => {
  it('renders Organizations exactly once, above Devices, and not under Settings', async () => {
    mockPartner('native');
    const { container } = render(<Sidebar currentPath="/" />);

    await waitFor(() => expect(container.querySelector(ORGANIZATIONS)).not.toBeNull());

    // Exactly once across the WHOLE rendered nav — the Settings-section entry
    // was removed when the item was promoted, and a second copy would mean the
    // removal regressed.
    const links = container.querySelectorAll(ORGANIZATIONS);
    expect(links).toHaveLength(1);

    // Top-level, right after Dashboard: it precedes Devices in document order.
    const devices = container.querySelector('a[href="/devices"]');
    expect(devices).not.toBeNull();
    expect(links[0].compareDocumentPosition(devices!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps Organizations visible when the Service Management module is off', async () => {
    mockPartner('off');
    const { container } = render(<Sidebar currentPath="/" />);

    await waitFor(() => expect(useOrgStore.getState().serviceManagementMode).toBe('off'));
    expect(container.querySelectorAll(ORGANIZATIONS)).toHaveLength(1);
  });
});
