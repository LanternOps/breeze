import '@/lib/i18n';

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DevicesPage from './DevicesPage';
import { fetchWithAuth } from '../../stores/auth';
import { encodeFilterToHash } from './filterUrl';

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_NETWORK_DEVICES_IN_LIST: false,
  ENABLE_ENDPOINT_AV_FEATURES: false,
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/devicesFetch', () => ({
  fetchAllDevices: vi.fn(async () => []),
  fetchAllNetworkDevices: vi.fn(async () => []),
}));
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../../services/deviceActions', () => ({
  sendDeviceCommand: vi.fn(),
  sendBulkCommand: vi.fn(),
  executeScript: vi.fn(),
  toggleMaintenanceMode: vi.fn(),
  decommissionDevice: vi.fn(),
  bulkDecommissionDevices: vi.fn(),
  restoreDevice: vi.fn(),
  permanentDeleteDevice: vi.fn(),
  sendWakeCommand: vi.fn(),
  sendBulkWakeCommand: vi.fn(),
  summarizeBulkWakeFailures: vi.fn(() => ''),
  summarizeBulkCommandFailures: vi.fn(() => ''),
  watchWakeOutcome: vi.fn(),
  WakeCommandError: class WakeCommandError extends Error { code = 'x'; },
  wakeFriendlyErrorMessage: vi.fn(() => null),
  linkDevicesMultiboot: vi.fn(),
  linkDevicesVmHost: vi.fn(),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const orgStoreState = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  currentPartnerId: null as string | null,
  allOrgs: true,
  lastOrgId: null as string | null,
  organizations: [] as Array<{ id: string; name: string }>,
  organizationsLoaded: true,
  error: null as string | null,
  selectOrganization: vi.fn<(id: string) => void>(),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: typeof orgStoreState) => unknown) => selector ? selector(orgStoreState) : orgStoreState,
    { getState: () => orgStoreState },
  ),
}));

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

const ORG_FROM_HASH = '0f8fad5b-d9cb-469f-a165-70867728950e';
const FILTER = { operator: 'AND' as const, conditions: [{ field: 'deviceRole', operator: 'equals' as const, value: 'unknown' }] };

// Ordering probe: every selectOrganization call and every /filters/preview
// request is appended here, so the assertion is about ORDER, not just calls.
const events: string[] = [];

describe('DevicesPage deep link (#3205 W06)', () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
    orgStoreState.currentOrgId = 'a-different-org';
    orgStoreState.selectOrganization = vi.fn((id: string) => {
      events.push(`selectOrganization:${id}`);
      orgStoreState.currentOrgId = id;
    });
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/filters/preview')) {
        // Mirror fetchWithAuth's org injection so this test observes which org
        // would be carried on the wire, in addition to call ordering.
        const scopedUrl = `${url}?orgId=${orgStoreState.currentOrgId}`;
        events.push(`preview:${scopedUrl}`);
        return { ok: true, json: async () => ({ data: { deviceIds: [] } }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response;
    });
    // The real encoder builds the hash, so this test cannot drift from the producer.
    window.location.hash = `#orgId=${ORG_FROM_HASH}&${encodeFilterToHash(FILTER)}`;
  });

  afterEach(() => { window.location.hash = ''; });

  it('adopts the org from the hash BEFORE the filter preview fires', async () => {
    render(<DevicesPage />);
    await waitFor(() => expect(events.some((e) => e.startsWith('preview:'))).toBe(true));
    const orgAt = events.findIndex((e) => e === `selectOrganization:${ORG_FROM_HASH}`);
    const previewAt = events.findIndex((e) => e.startsWith('preview:'));
    expect(orgAt).toBeGreaterThanOrEqual(0);
    expect(orgAt).toBeLessThan(previewAt);   // layout effect before passive effect
    expect(events[previewAt]).toBe(`preview:/filters/preview?orgId=${ORG_FROM_HASH}`);
  });

  it('posts the decoded filter to /filters/preview', async () => {
    render(<DevicesPage />);
    await waitFor(() => expect(events.some((e) => e.startsWith('preview:'))).toBe(true));
    const previewCall = vi.mocked(fetchWithAuth).mock.calls.find(([url]) => url === '/filters/preview');
    const body = JSON.parse(String(previewCall?.[1]?.body));
    expect(body.conditions).toEqual(FILTER);
    expect(body.idsOnly).toBe(true);
  });

  it('removes only the adopted orgId fragment while preserving filtersV2', async () => {
    render(<DevicesPage />);
    await waitFor(() => expect(window.location.hash).not.toContain('orgId='));
    expect(window.location.hash).toContain('filtersV2=');
  });

  it('a hash with no orgId leaves the current org alone', async () => {
    window.location.hash = `#${encodeFilterToHash(FILTER)}`;
    render(<DevicesPage />);
    await waitFor(() => expect(events.some((e) => e.startsWith('preview:'))).toBe(true));
    expect(events.some((e) => e.startsWith('selectOrganization:'))).toBe(false);
  });
});
