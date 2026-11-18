import '@/lib/i18n';

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DevicesPage from './DevicesPage';
import { fetchWithAuth } from '../../stores/auth';
import { fetchAllDevices } from '../../lib/devicesFetch';
import { showToast } from '../shared/Toast';
import { BULK_GROUP_MEMBERSHIP_CAP } from './bulkActionGating';

/**
 * DevicesPage owns the bulk action funnel (#9866): `add-to-group` / `remove-from-group` must
 * reach BulkGroupMembershipDialog (handleBulkAction → runBulkAction) instead of the unknown-bulk
 * toast, with the selection's agents only, and refuse a selection the bar should never have sent.
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
vi.mock('./BulkGroupMembershipDialog', () => ({
  default: (props: any) => {
    captured.modalProps = props;
    return (
      <div
        data-testid="group-membership-dialog-stub"
        data-mode={props.mode}
        data-ids={props.devices.map((d: Row) => d.id).join(',')}
      />
    );
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

async function renderWith(rows: Array<ReturnType<typeof raw> & { deviceClass?: string }>) {
  vi.mocked(fetchAllDevices).mockResolvedValue({ data: rows } as never);
  render(<DevicesPage />);
  await waitFor(() => expect(captured.listProps?.devices.length).toBe(rows.length));
  return captured.listProps!;
}

const unknownActionToasted = () =>
  vi.mocked(showToast).mock.calls.some(([t]) => /unknown/i.test(String(t.message)));

beforeEach(() => {
  vi.clearAllMocks();
  captured.listProps = null;
  captured.modalProps = null;
  vi.mocked(fetchWithAuth).mockImplementation(async () => ({ ok: true, json: async () => ({ data: [] }) }) as unknown as Response);
});

describe('DevicesPage — bulk group membership dispatch', () => {
  it.each([
    ['add-to-group', 'add'],
    ['remove-from-group', 'remove'],
  ])('%s opens the dialog in %s mode with the selected agents, not the unknown-bulk toast', async (action, mode) => {
    const list = await renderWith([raw(), raw('org-1', 'site-2')]);
    await act(async () => { list.onBulkAction!(action, list.devices); });
    const dialog = await screen.findByTestId('group-membership-dialog-stub');
    expect(dialog.dataset.mode).toBe(mode);
    expect(dialog.dataset.ids).toBe(list.devices.map((d) => d.id).join(','));
    expect(unknownActionToasted()).toBe(false);
  });

  it('refuses a mixed-org selection without opening the dialog (defence behind the disabled item)', async () => {
    const list = await renderWith([raw('org-1'), raw('org-2')]);
    await act(async () => { list.onBulkAction!('add-to-group', list.devices); });
    expect(screen.queryByTestId('group-membership-dialog-stub')).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'Selected devices belong to more than one organization',
    }));
  });

  it(`refuses more than ${BULK_GROUP_MEMBERSHIP_CAP} agents without opening the dialog (never chunks)`, async () => {
    const list = await renderWith(Array.from({ length: BULK_GROUP_MEMBERSHIP_CAP + 1 }, () => raw()));
    await act(async () => { list.onBulkAction!('remove-from-group', list.devices); });
    expect(screen.queryByTestId('group-membership-dialog-stub')).toBeNull();
    expect(showToast).toHaveBeenCalledWith({
      type: 'error',
      message: `Select at most ${BULK_GROUP_MEMBERSHIP_CAP} devices to change group membership at once`,
    });
  });

  it('wires the dialog to the session-expiry handler and refreshes the list when it is done', async () => {
    const list = await renderWith([raw()]);
    await act(async () => { list.onBulkAction!('add-to-group', list.devices); });
    await screen.findByTestId('group-membership-dialog-stub');
    const { handleSessionExpired } = await import('../../stores/auth');
    expect(captured.modalProps!.onUnauthorized).toBe(handleSessionExpired);
    const before = vi.mocked(fetchAllDevices).mock.calls.length;
    await act(async () => { captured.modalProps!.onDone(); });
    await waitFor(() => expect(vi.mocked(fetchAllDevices).mock.calls.length).toBeGreaterThan(before));
  });
});
