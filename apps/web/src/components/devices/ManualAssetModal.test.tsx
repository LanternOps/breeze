import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ManualAssetModal from './ManualAssetModal';
import type { Device } from './DeviceList';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const sessionExpiredMock = vi.mocked(handleSessionExpired);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG_ID = 'aaaaaaaa-1111-1111-1111-111111111111';
const SITE_ID = 'bbbbbbbb-1111-1111-1111-111111111111';

const ORGS = [{ id: ORG_ID, name: 'Acme Corp' }];
const ONE_SITE = [{ id: SITE_ID, name: 'HQ', orgId: ORG_ID }];
const TWO_SITES = [
  { id: SITE_ID, name: 'HQ', orgId: ORG_ID },
  { id: 'cccccccc-1111-1111-1111-111111111111', name: 'Branch', orgId: ORG_ID },
];

const EXISTING: Device = {
  id: 'dddddddd-1111-1111-1111-111111111111',
  deviceClass: 'manual',
  hostname: 'spare-laptop',
  displayName: 'Spare Laptop',
  os: '' as Device['os'],
  osVersion: '',
  status: 'unknown',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: '',
  orgId: ORG_ID,
  orgName: 'Acme Corp',
  siteId: SITE_ID,
  siteName: 'HQ',
  agentVersion: '',
  tags: ['loaner'],
  serialNumber: 'SN-1',
  assetTag: 'TAG-1',
  location: 'Closet B',
  linkedDeviceId: null,
  linkedDiscoveredAssetId: null,
  notes: 'Some notes',
};

function renderModal(overrides?: Partial<Parameters<typeof ManualAssetModal>[0]>) {
  const onClose = overrides?.onClose ?? vi.fn();
  const onSaved = overrides?.onSaved ?? vi.fn();
  render(
    <ManualAssetModal
      isOpen
      onClose={onClose}
      onSaved={onSaved}
      organizationId={overrides?.organizationId ?? ORG_ID}
      orgs={overrides?.orgs ?? ORGS}
      sites={overrides?.sites ?? ONE_SITE}
      existing={overrides?.existing ?? null}
      linkableDevices={overrides?.linkableDevices ?? []}
    />,
  );
  return { onClose, onSaved };
}

beforeEach(() => {
  fetchMock.mockReset();
  sessionExpiredMock.mockReset();
  toastMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/contacts')) return jsonResponse({ data: [] });
    return jsonResponse({ id: 'new-id' }, true, 201);
  });
});

describe('ManualAssetModal — create', () => {
  it('Name is required — Create stays disabled until a name is entered', () => {
    renderModal();
    expect(screen.getByTestId('manual-asset-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('manual-asset-name'), { target: { value: 'Spare phone' } });
    expect(screen.getByTestId('manual-asset-submit')).not.toBeDisabled();
  });

  it('defaults Site to the org\'s only site when there is exactly one', () => {
    renderModal({ sites: ONE_SITE });
    expect(screen.getByTestId('manual-asset-site')).toHaveValue(SITE_ID);
  });

  it('leaves Site unselected when the org has more than one', () => {
    renderModal({ sites: TWO_SITES });
    expect(screen.getByTestId('manual-asset-site')).toHaveValue('');
  });

  it('submit POSTs to /devices/manual via runAction (fetchWithAuth)', async () => {
    renderModal({ sites: ONE_SITE });
    fireEvent.change(screen.getByTestId('manual-asset-name'), { target: { value: 'Spare phone' } });
    fireEvent.click(screen.getByTestId('manual-asset-submit'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u) === '/devices/manual');
      expect(call).toBeDefined();
    });
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === '/devices/manual')!;
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ orgId: ORG_ID, siteId: SITE_ID, name: 'Spare phone' });
  });

  it('a DUPLICATE_SERIAL warning renders non-blockingly and does not prevent the create from completing', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/contacts')) return jsonResponse({ data: [] });
      return jsonResponse(
        { id: 'new-id', warnings: [{ code: 'DUPLICATE_SERIAL', message: 'An asset with this serial number already exists in this organization' }] },
        true,
        201,
      );
    });
    const { onSaved } = renderModal({ sites: ONE_SITE });
    fireEvent.change(screen.getByTestId('manual-asset-name'), { target: { value: 'Spare phone' } });
    fireEvent.click(screen.getByTestId('manual-asset-submit'));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.getByTestId('manual-asset-duplicate-warning')).toHaveTextContent(/already exists/);
    // Non-blocking: the create succeeded (onSaved fired) and the modal stays
    // open on the warning rather than closing — verified by the input still
    // being present.
    expect(screen.getByTestId('manual-asset-name')).toBeInTheDocument();
  });
});

describe('ManualAssetModal — edit + link control', () => {
  it('the link control is on the modal\'s primary surface, not behind a tab', () => {
    renderModal({ existing: EXISTING, sites: ONE_SITE });
    // No tab-switch interaction — the section is visible immediately.
    expect(screen.getByTestId('manual-asset-link-section')).toBeVisible();
    expect(screen.getByTestId('manual-asset-link-device-select')).toBeInTheDocument();
  });

  it('shows "Linked to" and an Unlink button when already linked', () => {
    const linkedTarget: Device = { ...EXISTING, id: 'agent-1', deviceClass: 'agent', hostname: 'win-box', displayName: undefined };
    renderModal({
      existing: { ...EXISTING, linkedDeviceId: 'agent-1' },
      sites: ONE_SITE,
      linkableDevices: [linkedTarget],
    });
    expect(screen.getByText(/win-box/)).toBeInTheDocument();
    expect(screen.getByTestId('manual-asset-unlink-button')).toBeInTheDocument();
  });

  it('pre-fills the form from the existing asset', () => {
    renderModal({ existing: EXISTING, sites: ONE_SITE });
    expect(screen.getByTestId('manual-asset-name')).toHaveValue('Spare Laptop');
    expect(screen.getByTestId('manual-asset-serial')).toHaveValue('SN-1');
    expect(screen.getByTestId('manual-asset-tag')).toHaveValue('TAG-1');
    expect(screen.getByTestId('manual-asset-location')).toHaveValue('Closet B');
  });
});
