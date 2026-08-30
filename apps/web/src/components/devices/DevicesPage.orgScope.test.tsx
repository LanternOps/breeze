// #4147 — the devices list must not issue its fetch before the org context has
// resolved, and must (re)issue it once the context lands.
//
// Deliberately end-to-end through the REAL orgStore + REAL fetchWithAuth, with
// only the network primitive (globalThis.fetch) stubbed. DevicesPage never
// passes an orgId itself — the `?orgId=` comes from fetchWithAuth's
// auto-injection, which reads the org store synchronously at call time. Mocking
// either side would make the central assertion ("the request carried the
// selected org") a statement about the mock rather than about the product.
import '@/lib/i18n';

import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DevicesPage from './DevicesPage';
import { useOrgStore, type Organization } from '../../stores/orgStore';
import { useAuthStore } from '../../stores/auth';

// The network arm would add a second fetch shape with no bearing on org
// scoping; keep the list on its agent-only path.
vi.mock('@/lib/featureFlags', () => ({
  ENABLE_NETWORK_DEVICES_IN_LIST: false,
  ENABLE_ENDPOINT_AV_FEATURES: false,
}));

vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../../hooks/useAdvancedFilterIds', () => ({
  useAdvancedFilterIds: () => ({ ids: null, loading: false }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./filterUrl', () => ({
  decodeFilterFromHash: vi.fn(() => null),
  writeFilterToHash: vi.fn(),
  isFiltersV2Enabled: vi.fn(() => true),
}));

// Presentational children — not under test.
vi.mock('./DeviceList', () => ({ default: () => null }));
vi.mock('./DeviceCard', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./AddDeviceModal', () => ({ default: () => null }));
vi.mock('./CreateGroupModal', () => ({ default: () => null }));
vi.mock('./LinkVmHostModal', () => ({ default: () => null }));
vi.mock('../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => null }));
vi.mock('./DeviceFilterToolbar', () => ({ DeviceFilterToolbar: () => null }));
vi.mock('../shared/ProgressBar', () => ({ default: () => null }));

const ORG_A: Organization = {
  id: 'org-a',
  partnerId: 'partner-1',
  name: 'Org A',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};

let requestedUrls: string[] = [];

/** Every `/devices` page request that reached the network, in order. */
function deviceRequests(): string[] {
  return requestedUrls.filter((u) => /\/devices(\?|$)/.test(u.split('#')[0]));
}

/** Let mount effects, promise microtasks and the cursor walk settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  requestedUrls = [];
  // The orgId provider is page-aware: /devices is `org-or-all`, so the
  // selected org IS injected here (a `catalog` route would inject nothing).
  window.history.replaceState({}, '', '/devices');

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    requestedUrls.push(typeof input === 'string' ? input : input.toString());
    return new Response(
      JSON.stringify({ data: [], pagination: { nextCursor: null, total: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  useAuthStore.setState({
    tokens: { accessToken: 'test-token', refreshToken: 'r', expiresAt: Date.now() + 60_000 },
    isAuthenticated: true,
  } as never);

  // The unresolved shape a fresh post-login session starts in: logout wipes the
  // persisted `breeze-org` key (auth.ts evictLocalAuthState), so currentOrgId is
  // null until OrgSwitcher's async fetchOrganizations auto-selects an org.
  useOrgStore.setState({
    currentOrgId: null,
    currentPartnerId: null,
    allOrgs: false,
    lastOrgId: null,
    organizations: [],
    organizationsLoaded: false,
    error: null,
  });
});

describe('DevicesPage — org-context race on first load after login (#4147)', () => {
  it('does not fetch devices while the org context is still resolving, then fetches with the selected org once it lands', async () => {
    render(<DevicesPage />);
    await settle();

    // The bug: today the mount effect fires immediately, so an UNSCOPED
    // /devices request goes out and the fleet-wide result is never corrected.
    expect(deviceRequests()).toEqual([]);

    // OrgSwitcher's fetchOrganizations resolves and auto-selects the org.
    act(() => {
      useOrgStore.setState({
        currentOrgId: ORG_A.id,
        organizations: [ORG_A],
        organizationsLoaded: true,
      });
    });

    await waitFor(() => expect(deviceRequests().length).toBeGreaterThan(0));
    await settle();

    expect(deviceRequests()).toHaveLength(1);
    expect(deviceRequests()[0]).toContain(`orgId=${ORG_A.id}`);
  });

  it('fetches exactly once, scoped, when the org context is already resolved at mount (warm reload)', async () => {
    useOrgStore.setState({
      currentOrgId: ORG_A.id,
      organizations: [ORG_A],
      organizationsLoaded: true,
    });

    render(<DevicesPage />);
    await waitFor(() => expect(deviceRequests().length).toBeGreaterThan(0));
    await settle();

    expect(deviceRequests()).toHaveLength(1);
    expect(deviceRequests()[0]).toContain(`orgId=${ORG_A.id}`);
  });

  it('still fetches fleet-wide (no orgId) when All-organizations is the explicit choice', async () => {
    useOrgStore.setState({
      currentOrgId: null,
      allOrgs: true,
      organizations: [ORG_A],
      organizationsLoaded: true,
    });

    render(<DevicesPage />);
    await waitFor(() => expect(deviceRequests().length).toBeGreaterThan(0));
    await settle();

    expect(deviceRequests()).toHaveLength(1);
    expect(deviceRequests()[0]).not.toContain('orgId=');
  });

  it('fetches rather than hanging when the org list fails to load', async () => {
    render(<DevicesPage />);
    await settle();
    expect(deviceRequests()).toEqual([]);

    // /orgs/organizations failed: no selection will ever arrive, so the page
    // must degrade to an unscoped fetch instead of spinning forever.
    act(() => {
      useOrgStore.setState({ error: 'Failed to fetch organizations' });
    });

    await waitFor(() => expect(deviceRequests().length).toBeGreaterThan(0));
    await settle();
    expect(deviceRequests()).toHaveLength(1);
  });
});
