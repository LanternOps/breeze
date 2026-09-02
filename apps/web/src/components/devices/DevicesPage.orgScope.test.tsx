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

// Captures the page's own onEvent handler so a test can deliver a real-time
// event at a chosen moment (the enroll-during-pre-resolution case below).
type DeviceEvent = { type: string; payload: Record<string, unknown> };
const eventStream = vi.hoisted(() => ({
  onEvent: null as null | ((event: { type: string; payload: Record<string, unknown> }) => void),
}));
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: (opts: { onEvent: (event: DeviceEvent) => void }) => {
    eventStream.onEvent = opts.onEvent;
    return { subscribe: vi.fn() };
  },
}));

function emitDeviceEvent(event: DeviceEvent): void {
  if (!eventStream.onEvent) throw new Error('useEventStream never received an onEvent handler');
  eventStream.onEvent(event);
}
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

const ORG_B: Organization = { ...ORG_A, id: 'org-b', name: 'Org B' };

/** Every request that reached the network, with the signal it was given. */
let requests: Array<{ url: string; signal: AbortSignal | null }> = [];

/** Every `/devices` page request that reached the network, in order. */
function deviceRequests(): string[] {
  return requests.map((r) => r.url).filter((u) => /\/devices(\?|$)/.test(u.split('#')[0]));
}

// Deliberately more than one macrotask: a single tick cannot tell "never
// fetches" apart from "fetches after a short delay", so the absence assertions
// below would read as a false green against a debounced/setTimeout'd variant of
// the gate. The current gate is a synchronous early-return, but the negative
// assertions are this suite's whole point — they should not depend on that.
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

beforeEach(() => {
  requests = [];
  eventStream.onEvent = null;
  // The orgId provider is page-aware: /devices is `org-or-all`, so the
  // selected org IS injected here (a `catalog` route would inject nothing).
  window.history.replaceState({}, '', '/devices');

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: typeof input === 'string' ? input : input.toString(),
      signal: init?.signal ?? null,
    });
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

  it('surfaces the org-load failure instead of quietly listing every org\'s devices', async () => {
    const { findByTestId } = render(<DevicesPage />);
    await settle();
    expect(deviceRequests()).toEqual([]);

    // /orgs/organizations failed with no selection to fall back on. Fetching
    // here would go out unscoped and render a cross-tenant list that looks
    // exactly like a real org-scoped one, so the page must say so instead —
    // and its Retry re-runs the org resolution rather than stranding the user.
    act(() => {
      useOrgStore.setState({ error: 'Failed to fetch organizations' });
    });

    expect(await findByTestId('org-load-failed-state')).toBeInTheDocument();
    await settle();
    expect(deviceRequests()).toEqual([]);
  });

  it('fetches scoped once the org context recovers after a failure', async () => {
    render(<DevicesPage />);
    await settle();

    act(() => {
      useOrgStore.setState({ error: 'Failed to fetch organizations' });
    });
    await settle();
    expect(deviceRequests()).toEqual([]);

    // Retry succeeded (the store clears `error` and resolves a selection).
    act(() => {
      useOrgStore.setState({
        error: null,
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

  it('does not let an enroll event fire an unscoped fetch during the pre-resolution window', async () => {
    render(<DevicesPage />);
    await settle();
    expect(deviceRequests()).toEqual([]);

    // useEventStream connects on auth alone, so a device.enrolled event can
    // arrive before the org context resolves. Its refetch must respect the
    // same gate as the mount effect (the stub captures the page's handler).
    act(() => {
      emitDeviceEvent({ type: 'device.enrolled', payload: { deviceId: 'dev-1' } });
    });
    await settle();
    expect(deviceRequests()).toEqual([]);

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

  // The reason the effect is KEYED on the scope rather than merely gated on it:
  // a boolean "ready" gate passes every test above while leaving a later switch
  // unobserved, which is the stale-cross-org-data half of #4147.
  it('refetches with the new org when the selection changes while mounted', async () => {
    useOrgStore.setState({
      currentOrgId: ORG_A.id,
      organizations: [ORG_A, ORG_B],
      organizationsLoaded: true,
    });

    render(<DevicesPage />);
    await waitFor(() => expect(deviceRequests().length).toBeGreaterThan(0));
    await settle();
    expect(deviceRequests()).toHaveLength(1);

    act(() => {
      useOrgStore.setState({ currentOrgId: ORG_B.id });
    });

    await waitFor(() => expect(deviceRequests().length).toBeGreaterThan(1));
    await settle();
    expect(deviceRequests()).toHaveLength(2);
    expect(deviceRequests()[1]).toContain(`orgId=${ORG_B.id}`);
  });

  it('aborts the superseded request when the org changes mid-flight', async () => {
    useOrgStore.setState({
      currentOrgId: ORG_A.id,
      organizations: [ORG_A, ORG_B],
      organizationsLoaded: true,
    });

    render(<DevicesPage />);
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await settle();

    // The AbortController the org-A pass created. Read it off the sibling
    // `/orgs` request specifically: fetchAllDevices does NOT thread the signal
    // into its own `/devices` fetch (it only checks `signal.aborted` between
    // cursor pages), so that request carries fetchWithAuth's internal timeout
    // controller instead and would never show the page's abort. The sibling
    // reads are what make the whole pass bail — Promise.all rejects with their
    // AbortError — so they are the honest place to assert it.
    //
    // Switching org must abort this, or a slow org-A response can land after
    // org-B's and repaint the list with the previous tenant's data.
    const orgAsignal =
      requests.find((r) => /\/orgs(\?|$)/.test(r.url.split('#')[0]))?.signal ?? null;
    expect(orgAsignal).not.toBeNull();
    expect(orgAsignal!.aborted).toBe(false);

    act(() => {
      useOrgStore.setState({ currentOrgId: ORG_B.id });
    });
    await settle();

    expect(orgAsignal!.aborted).toBe(true);
  });

  it('fetches once the org list loads and this partner genuinely has zero orgs', async () => {
    render(<DevicesPage />);
    await settle();
    expect(deviceRequests()).toEqual([]);

    // 'empty' is terminal, not transient — there is nothing to scope to, so the
    // page must settle rather than hold the skeleton waiting for a selection
    // that is never coming.
    act(() => {
      useOrgStore.setState({ organizations: [], organizationsLoaded: true });
    });

    await waitFor(() => expect(deviceRequests().length).toBeGreaterThan(0));
    await settle();
    expect(deviceRequests()).toHaveLength(1);
    expect(deviceRequests()[0]).not.toContain('orgId=');
  });
});
