// #9936 — a device removed in another tab (or by another user) stayed listed in
// an already-open /devices tab until a manual refresh: nothing publishes a
// removal event to the list (#9510 dropped the never-published
// `device.decommissioned`; #8836 L4 owns re-adding it). The page now re-syncs
// when the user comes back to the tab, bounded so tab-flicking does not re-walk
// the whole fleet every time.
//
// Same harness shape as DevicesPage.orgScope.test.tsx: REAL orgStore + REAL
// fetchWithAuth, only globalThis.fetch stubbed, so "a /devices request went out"
// is a statement about the product, not about a mocked fetch helper.
import '@/lib/i18n';

import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DevicesPage from './DevicesPage';
import { useOrgStore, type Organization } from '../../stores/orgStore';
import { useAuthStore } from '../../stores/auth';

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_NETWORK_DEVICES_IN_LIST: false,
  ENABLE_ENDPOINT_AV_FEATURES: false,
}));
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: vi.fn() }),
}));
const advancedFilter = vi.hoisted(() => ({ refetch: vi.fn() }));
vi.mock('../../hooks/useAdvancedFilterIds', () => ({
  useAdvancedFilterIds: () => ({ ids: null, loading: false, refetch: advancedFilter.refetch }),
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
vi.mock('./AddNetworkAssetModal', () => ({ default: () => null }));
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

let requests: string[] = [];
function deviceRequests(): string[] {
  return requests.filter((u) => /\/devices(\?|$)/.test(u.split('#')[0]));
}

// The page's staleness clock. Driven by hand so "the list is N seconds old" is
// exact rather than a real-time sleep.
let now = 0;
let visibility: DocumentVisibilityState = 'visible';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function focusWindow(): void {
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

async function renderLoaded(): Promise<void> {
  render(<DevicesPage />);
  await waitFor(() => expect(deviceRequests().length).toBeGreaterThan(0));
  await settle();
  expect(deviceRequests()).toHaveLength(1);
}

beforeEach(() => {
  requests = [];
  now = 1_800_000_000_000;
  visibility = 'visible';
  advancedFilter.refetch.mockClear();
  window.history.replaceState({}, '', '/devices');

  vi.spyOn(Date, 'now').mockImplementation(() => now);
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    requests.push(typeof input === 'string' ? input : input.toString());
    return new Response(
      JSON.stringify({ data: [], pagination: { nextCursor: null, total: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  useAuthStore.setState({
    tokens: { accessToken: 'test-token', refreshToken: 'r', expiresAt: now + 3_600_000 },
    isAuthenticated: true,
  } as never);

  useOrgStore.setState({
    currentOrgId: ORG_A.id,
    currentPartnerId: null,
    allOrgs: false,
    lastOrgId: null,
    organizations: [ORG_A],
    organizationsLoaded: true,
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Drop the instance override so jsdom's own getter is back for other suites.
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('DevicesPage — re-sync when the user returns to the tab (#9936)', () => {
  it('refetches the list (and the server-resolved filter ids) when a stale tab becomes visible again', async () => {
    await renderLoaded();
    advancedFilter.refetch.mockClear();

    setVisibility('hidden');
    // Meanwhile, in another tab, a device is removed.
    now += 60_000;
    setVisibility('visible');

    await waitFor(() => expect(deviceRequests()).toHaveLength(2));
    expect(deviceRequests()[1]).toContain(`orgId=${ORG_A.id}`);
    await settle();
    // Status is a filterable attribute, so the id set is refreshed with the
    // rows (#5023) — otherwise an active "Status is …" filter stays stale.
    expect(advancedFilter.refetch).toHaveBeenCalledTimes(1);
  });

  it('refetches on window focus too (side-by-side windows never change visibility)', async () => {
    await renderLoaded();

    now += 60_000;
    focusWindow();

    await waitFor(() => expect(deviceRequests()).toHaveLength(2));
  });

  it('does not refetch when the list is still fresh (quick tab flick)', async () => {
    await renderLoaded();

    setVisibility('hidden');
    now += 5_000;
    setVisibility('visible');
    focusWindow();
    await settle();

    expect(deviceRequests()).toHaveLength(1);
  });

  it('refetches once, not twice, when visibilitychange and focus fire together on return', async () => {
    await renderLoaded();

    setVisibility('hidden');
    now += 60_000;
    setVisibility('visible');
    focusWindow();
    await settle();

    expect(deviceRequests()).toHaveLength(2);
  });

  it('does not refetch on a visibilitychange to hidden', async () => {
    await renderLoaded();

    now += 60_000;
    setVisibility('hidden');
    await settle();

    expect(deviceRequests()).toHaveLength(1);
  });

  it('does not fire an unscoped fetch on return while the org context is still resolving (#4147)', async () => {
    useOrgStore.setState({ currentOrgId: null, organizations: [], organizationsLoaded: false });
    render(<DevicesPage />);
    await settle();
    expect(deviceRequests()).toEqual([]);

    now += 60_000;
    setVisibility('hidden');
    setVisibility('visible');
    focusWindow();
    await settle();

    expect(deviceRequests()).toEqual([]);
  });
});
