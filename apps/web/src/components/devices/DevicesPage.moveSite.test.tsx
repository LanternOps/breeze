import '@/lib/i18n';

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DevicesPage from './DevicesPage';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllDevices } from '../../lib/devicesFetch';
import { showToast } from '../shared/Toast';
import { BULK_SITE_MOVE_CAP } from './bulkActionGating';

/**
 * DevicesPage owns the action funnels (#9796): `move-site` must reach ChangeSiteModal from BOTH
 * the row path (runDeviceAction) and the bulk path (handleBulkAction → runBulkAction) instead of
 * the unknown-action toasts, and the bulk 200 body — never the HTTP status — decides the toast.
 */
vi.mock('@/lib/featureFlags', () => ({ ENABLE_NETWORK_DEVICES_IN_LIST: false, ENABLE_ENDPOINT_AV_FEATURES: false }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));
vi.mock('../../lib/devicesFetch', () => ({
  fetchAllDevices: vi.fn(),
  fetchAllNetworkDevices: vi.fn(async () => ({ data: [], total: 0, pagesWalked: 1 })),
  fetchAllManualAssets: vi.fn(async () => ({ data: [], total: 0, pagesWalked: 1 })),
}));
vi.mock('../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const orgStoreState = vi.hoisted(() => ({
  currentOrgId: null as string | null, currentPartnerId: null as string | null, allOrgs: true, lastOrgId: null as string | null,
  organizations: [] as Array<{ id: string; name: string }>, organizationsLoaded: true, error: null as string | null,
  selectOrganization: () => {},
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: typeof orgStoreState) => unknown) => (selector ? selector(orgStoreState) : orgStoreState),
    { getState: () => orgStoreState },
  ),
}));

type Row = { id: string; hostname: string; orgId: string; siteId: string; deviceClass?: string };
const captured = vi.hoisted(() => ({
  listProps: null as null | { devices: Row[]; onAction?: (a: string, d: Row) => void; onBulkAction?: (a: string, d: Row[]) => void },
  modalProps: null as null | Record<string, any>,
}));
vi.mock('./DeviceList', () => ({
  default: (props: any) => {
    captured.listProps = props;
    return <div data-testid="device-list" data-count={props.devices.length} />;
  },
}));
vi.mock('./ChangeSiteModal', () => ({
  default: (props: any) => {
    captured.modalProps = props;
    return props.isOpen ? (
      <div
        data-testid="change-site-modal-stub"
        data-variant={props.devices ? 'bulk' : 'single'}
        data-ids={(props.devices ?? [props.device]).map((d: Row) => d.id).join(',')}
      />
    ) : null;
  },
}));
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

let seq = 0;
function raw(orgId = 'org-1', siteId = 'site-1') {
  seq += 1;
  const n = String(seq).padStart(12, '0');
  return {
    id: `11111111-1111-4111-8111-${n}`, hostname: `host-${seq}`, osType: 'windows', osVersion: '11', status: 'online',
    lastSeenAt: new Date().toISOString(), orgId, siteId, agentVersion: '1.0.0', tags: [],
  };
}

async function renderWith(rows: ReturnType<typeof raw>[]) {
  vi.mocked(fetchAllDevices).mockResolvedValue({ data: rows } as never);
  render(<DevicesPage />);
  await waitFor(() => expect(captured.listProps?.devices.length).toBe(rows.length));
  return captured.listProps!;
}

const unknownActionToasted = () =>
  vi.mocked(showToast).mock.calls.some(([t]) => /unknown/i.test(String(t.message)) || /Unknown/.test(String(t.message)));

beforeEach(() => {
  vi.clearAllMocks();
  captured.listProps = null;
  captured.modalProps = null;
  vi.mocked(fetchWithAuth).mockImplementation(async () => ({ ok: true, json: async () => ({ data: [] }) }) as unknown as Response);
});

describe('DevicesPage — move-site dispatch', () => {
  it('the row action opens the single-device ChangeSiteModal, not the unknown-action toast', async () => {
    const list = await renderWith([raw()]);
    await act(async () => { list.onAction!('move-site', list.devices[0]!); });
    const modal = await screen.findByTestId('change-site-modal-stub');
    expect(modal.dataset.variant).toBe('single');
    expect(modal.dataset.ids).toBe(list.devices[0]!.id);
    expect(unknownActionToasted()).toBe(false);
  });

  it('the bulk action opens the bulk ChangeSiteModal with the selected agents, not the unknown-bulk toast', async () => {
    const list = await renderWith([raw(), raw('org-1', 'site-2')]);
    await act(async () => { list.onBulkAction!('move-site', list.devices); });
    const modal = await screen.findByTestId('change-site-modal-stub');
    expect(modal.dataset.variant).toBe('bulk');
    expect(modal.dataset.ids).toBe(list.devices.map((d) => d.id).join(','));
    expect(unknownActionToasted()).toBe(false);
  });

  it('refuses a mixed-org bulk selection without opening the modal (defence behind the disabled item)', async () => {
    const list = await renderWith([raw('org-1'), raw('org-2')]);
    await act(async () => { list.onBulkAction!('move-site', list.devices); });
    expect(screen.queryByTestId('change-site-modal-stub')).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'Selected devices belong to more than one organization',
    }));
  });

  it(`refuses more than ${BULK_SITE_MOVE_CAP} agents without opening the modal (never chunks)`, async () => {
    const list = await renderWith(Array.from({ length: BULK_SITE_MOVE_CAP + 1 }, () => raw()));
    await act(async () => { list.onBulkAction!('move-site', list.devices); });
    expect(screen.queryByTestId('change-site-modal-stub')).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(vi.mocked(fetchWithAuth).mock.calls.some(([url]) => url === '/devices/bulk/site')).toBe(false);
  });
});

describe('DevicesPage — bulk move outcome toast', () => {
  async function openBulk() {
    const list = await renderWith([raw(), raw(), raw()]);
    await act(async () => { list.onBulkAction!('move-site', list.devices); });
    await screen.findByTestId('change-site-modal-stub');
    return list.devices;
  }

  it('all moved → success', async () => {
    const devices = await openBulk();
    act(() => captured.modalProps!.onBulkMoved({
      results: devices.map((d) => ({ id: d.id, outcome: 'moved' })), summary: { moved: 3, total: 3 },
    }, 'Lakeside'));
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: '3 devices are now at Lakeside' });
  });

  it('some moved → warning "Moved N of M" naming the failures', async () => {
    const devices = await openBulk();
    act(() => captured.modalProps!.onBulkMoved({
      results: [{ id: devices[0]!.id, outcome: 'moved' }, { id: devices[1]!.id, outcome: 'conflict' }, { id: devices[2]!.id, outcome: 'forbidden' }],
      summary: { moved: 1, total: 3 },
    }, 'Lakeside'));
    expect(showToast).toHaveBeenCalledWith({
      type: 'warning',
      message: `Moved 1 of 3 devices to Lakeside. Not moved: ${devices[1]!.hostname}, ${devices[2]!.hostname}`,
    });
  });

  it('none moved → error, even though the HTTP status was 200', async () => {
    const devices = await openBulk();
    act(() => captured.modalProps!.onBulkMoved({
      results: devices.map((d) => ({ id: d.id, outcome: 'not_found' })), summary: { moved: 0, total: 3 },
    }, 'Lakeside'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(String(vi.mocked(showToast).mock.calls.at(-1)![0].message)).toContain('No devices were moved');
  });

  it('the bulk modal is wired to the session-expiry handler for a 401', async () => {
    await openBulk();
    const { handleSessionExpired } = await import('../../stores/auth');
    expect(captured.modalProps!.onUnauthorized).toBe(handleSessionExpired);
  });
});
