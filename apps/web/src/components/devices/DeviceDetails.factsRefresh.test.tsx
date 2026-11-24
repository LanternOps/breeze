/**
 * The header facts summarise records that are edited further down the same
 * page. These run the real header and the real Details-tab cards together: the
 * props that carry "this changed" between them are all optional, so a dropped
 * one fails no type check.
 */
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});
vi.mock('../extensions/ExtensionSlotHost', () => ({ useExtensionSlotDescriptors: () => [], default: () => null }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));
vi.mock('../shared/ContactResponsibilitiesCard', () => ({ default: () => null }));
vi.mock('./DeviceBillingCard', () => ({ default: () => null }));
// Stands in for the Details tab's own sections; the warranty section inside it
// reports a finished lookup through onWarrantyChanged (DeviceInfoTab.test.tsx
// covers that hand-off from the real section).
vi.mock('./DeviceInfoTab', () => ({
  default: ({ onWarrantyChanged }: { onWarrantyChanged?: () => void }) => (
    <div>
      <button type="button" data-testid="warranty-looked-up" onClick={() => onWarrantyChanged?.()}>Looked up</button>
      <section id="device-warranty" data-testid="device-warranty" tabIndex={-1} />
    </div>
  ),
}));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 5,
  ramPercent: 5,
  lastSeen: '2026-08-02T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: [],
} as Device;

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 300, status, statusText: '', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const placement = (rack: string) => ({
  authority: { kind: 'device', id: device.id, linked: false },
  placement: { room: 'Server room', rack, rackUnit: 12, heightU: 1 },
});

const EXPIRING = { warranty: { id: 'w', deviceId: device.id, manufacturer: 'Dell', serialNumber: 'X', status: 'expiring', warrantyStartDate: '2023-03-01', warrantyEndDate: '2026-12-15', entitlements: [], dataSource: 'provider', lastSyncAt: null, lastSyncError: null } };

/** What the server holds; a PUT to placement changes it, as the real one does. */
let server: { rack: string; warranty: unknown };

beforeEach(() => {
  server = { rack: 'B', warranty: { warranty: null } };
  window.location.hash = '#details';
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === `/devices/${device.id}/placement`) {
      if (init?.method === 'PUT') server.rack = (JSON.parse(String(init.body)) as { rack: string }).rack;
      return json(placement(server.rack));
    }
    if (url === `/devices/${device.id}/warranty`) return json(server.warranty);
    return json({}, 404);
  });
});

afterEach(() => {
  window.location.hash = '';
});

describe('DeviceDetails — header facts follow edits made on the page', () => {
  it('a placement saved in the Asset record shows in the header without a reload', async () => {
    render(<DeviceDetails device={device} />);
    await waitFor(() => expect(screen.getByTestId('device-fact-placement')).toHaveTextContent('Rack B'));

    fireEvent.click(await screen.findByTestId('physical-placement-edit'));
    const rack = screen.getByTestId('physical-placement-rack');
    fireEvent.change(rack, { target: { value: 'C' } });
    fireEvent.submit(rack.closest('form')!);

    await waitFor(() => expect(screen.getByTestId('device-fact-placement')).toHaveTextContent('Rack C'));
  });

  it('a warranty looked up on the Details tab shows in the header without a reload', async () => {
    render(<DeviceDetails device={device} />);
    await waitFor(() => expect(screen.getByTestId('device-fact-placement')).toBeInTheDocument());
    expect(screen.queryByTestId('device-fact-warranty')).not.toBeInTheDocument();

    server.warranty = EXPIRING;
    fireEvent.click(screen.getByTestId('warranty-looked-up'));

    expect(await screen.findByTestId('device-fact-warranty')).toHaveTextContent('Warranty ends');
  });

  describe('"Warranty details" in the header', () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    beforeEach(() => {
      // jsdom has no layout: scrollIntoView is missing, so stub it to observe.
      Element.prototype.scrollIntoView = scrollIntoView;
      scrollIntoView.mockClear();
      server.warranty = EXPIRING;
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = original;
    });

    const openWarrantyDetails = async () => {
      fireEvent.click(await screen.findByTestId('device-fact-warranty'));
      fireEvent.click(within(screen.getByTestId('device-fact-warranty-panel')).getByRole('button', { name: 'Warranty details' }));
    };

    it('scrolls to the warranty section when already on the Details tab', async () => {
      render(<DeviceDetails device={device} />);
      await openWarrantyDetails();
      const section = screen.getByTestId('device-warranty');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView.mock.contexts[0]).toBe(section);
      expect(document.activeElement).toBe(section);
    });

    it('opens the Details tab from another tab', async () => {
      window.location.hash = '';
      render(<DeviceDetails device={device} />);
      await openWarrantyDetails();
      await waitFor(() => expect(window.location.hash).toBe('#details'));
      expect(await screen.findByTestId('device-asset-record')).toBeInTheDocument();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    });
  });
});
