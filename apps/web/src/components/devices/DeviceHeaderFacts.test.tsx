import '@/lib/i18n';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceHeaderFacts from './DeviceHeaderFacts';
import { fetchWithAuth } from '../../stores/auth';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const can = vi.fn((_resource: string, _action?: string) => true);
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ can }) }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
// GET /devices/:id/warranty wraps the record: { warranty: {...} | null } (as DeviceWarrantyCard reads it).

const device = (over: Partial<Device> = {}): Device => ({
  id: 'dev-1',
  hostname: 'adrianna',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Castellini Law',
  siteId: 'site-1',
  siteName: 'Main',
  agentVersion: '0.129.0',
  ...over,
}) as Device;

type Routes = Partial<Record<'warranty' | 'contacts' | 'billing' | 'placement' | 'assets' | 'contracts', Response>>;

function route(routes: Routes) {
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    if (url.includes('/warranty')) return routes.warranty ?? json({}, 404);
    if (url.includes('/contact-responsibilities')) return routes.contacts ?? json({ responsibilities: [] });
    if (url.includes('/billing')) return routes.billing ?? json({}, 500);
    if (url.startsWith('/contracts')) return routes.contracts ?? json({ data: [{ id: 'k1', status: 'active' }] });
    if (url.includes('/placement')) return routes.placement ?? json({}, 404);
    if (url.includes('/discovery/assets')) return routes.assets ?? json({ assets: [] });
    return json({}, 404);
  });
}

const settle = () => waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.length).toBeGreaterThanOrEqual(5));

describe('DeviceHeaderFacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    can.mockReturnValue(true);
  });

  it('renders nothing for a device with no known facts (no dashes moved into the header)', async () => {
    route({});
    const { container } = render(<DeviceHeaderFacts device={device()} />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows model, serial and LAN IP from the device, each copyable where it is an identifier', async () => {
    route({});
    render(<DeviceHeaderFacts device={device({ manufacturer: 'Dell Inc.', model: 'OptiPlex 7060', serialNumber: '4XK9P2', lanIp: '10.0.4.21' })} />);
    expect(screen.getByTestId('device-fact-model')).toHaveTextContent('Dell OptiPlex 7060');
    expect(screen.getByTestId('device-fact-serial')).toHaveTextContent('4XK9P2');
    expect(screen.getByTestId('device-fact-ip')).toHaveTextContent('10.0.4.21');
    expect(screen.getByTestId('device-fact-serial-copy')).toBeInTheDocument();
    expect(screen.getByTestId('device-fact-ip-copy')).toBeInTheDocument();
    await settle();
  });

  it('does not repeat the manufacturer when the model already starts with it', () => {
    route({});
    render(<DeviceHeaderFacts device={device({ manufacturer: 'LENOVO', model: 'Lenovo ThinkPad T14' })} />);
    expect(screen.getByTestId('device-fact-model')).toHaveTextContent(/^Lenovo ThinkPad T14$/);
  });

  it('shows a warranty chip only for a known status, and its popover opens and closes on Escape', async () => {
    route({ warranty: json({ warranty: { id: 'w', deviceId: 'dev-1', manufacturer: 'Dell', serialNumber: 'X', status: 'expiring', warrantyStartDate: '2023-03-01', warrantyEndDate: '2026-12-15', entitlements: [], dataSource: 'provider', lastSyncAt: null, lastSyncError: null } }) });
    render(<DeviceHeaderFacts device={device()} />);
    const chip = await screen.findByTestId('device-fact-warranty');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('device-fact-warranty-panel')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('device-fact-warranty-panel')).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });

  it('hides the warranty chip when the status is unknown', async () => {
    route({ warranty: json({ warranty: { id: 'w', deviceId: 'dev-1', manufacturer: 'DELL', serialNumber: 'X', status: 'unknown', warrantyStartDate: null, warrantyEndDate: null, entitlements: [], dataSource: null, lastSyncAt: null, lastSyncError: null } }) });
    render(<DeviceHeaderFacts device={device()} />);
    await settle();
    expect(screen.queryByTestId('device-fact-warranty')).not.toBeInTheDocument();
  });

  it('picks the technical contact before site and billing, falling back to email or phone for a nameless contact', async () => {
    route({
      contacts: json({ responsibilities: [
        { role: 'billing', level: 'organization', contacts: [{ contactId: 'c1', name: 'Kerri Castellini', email: 'k@example.com', phone: null, mobile: null, title: null, isPrimary: true }] },
        { role: 'site', level: 'site', contacts: [{ contactId: 'c2', name: null, email: null, phone: '7037750035', mobile: null, title: null, isPrimary: false }] },
      ] }),
    });
    render(<DeviceHeaderFacts device={device()} />);
    const chip = await screen.findByTestId('device-fact-contact');
    // No technical contact → the site (local) contact wins over billing.
    expect(chip).toHaveTextContent('7037750035');
    fireEvent.click(chip);
    const panel = screen.getByTestId('device-fact-contact-panel');
    expect(within(panel).getByRole('link', { name: '7037750035' })).toHaveAttribute('href', 'tel:7037750035');
    expect(within(panel).getByRole('link', { name: 'k@example.com' })).toHaveAttribute('href', 'mailto:k@example.com');
  });

  it('shows "Not billed" only when the device is uncovered — never on error or not-billable', async () => {
    route({ billing: json({ data: { uncovered: true, notBillable: false, lines: [], deviceRole: 'workstation' } }) });
    const { unmount } = render(<DeviceHeaderFacts device={device()} />);
    expect(await screen.findByTestId('device-fact-billing')).toBeInTheDocument();
    unmount();

    for (const billing of [json({}, 500), json({ data: { uncovered: false, notBillable: true, notBillableReason: 'decommissioned', lines: [] } })]) {
      vi.clearAllMocks();
      route({ billing });
      const r = render(<DeviceHeaderFacts device={device()} />);
      await settle();
      expect(screen.queryByTestId('device-fact-billing')).not.toBeInTheDocument();
      r.unmount();
    }
  });

  it('shows no "Not billed" chip when the org has no active contracts (a partner that does not bill by contract)', async () => {
    route({
      billing: json({ data: { uncovered: true, notBillable: false, lines: [], deviceRole: 'workstation' } }),
      contracts: json({ data: [] }),
    });
    render(<DeviceHeaderFacts device={device()} />);
    await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([u]) => String(u).startsWith('/contracts'))).toBe(true));
    await settle();
    expect(screen.queryByTestId('device-fact-billing')).not.toBeInTheDocument();
  });

  it('does not request billing without contracts:read', async () => {
    can.mockImplementation((resource: string) => resource !== 'contracts');
    route({});
    render(<DeviceHeaderFacts device={device()} />);
    await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(vi.mocked(fetchWithAuth).mock.calls.some(([u]) => String(u).includes('/billing'))).toBe(false);
  });

  it('shows physical placement only when something is set', async () => {
    route({ placement: json({ authority: { kind: 'device', id: 'dev-1', linked: false }, placement: { room: 'Server room', rack: 'A', rackUnit: 12, heightU: 1 } }) });
    render(<DeviceHeaderFacts device={device()} />);
    expect(await screen.findByTestId('device-fact-placement')).toHaveTextContent('Server room');
  });

  it('links a discovered network asset', async () => {
    route({ assets: json({ assets: [{ id: 'na-1', label: 'sw-core-01' }] }) });
    render(<DeviceHeaderFacts device={device()} />);
    const link = await screen.findByRole('link', { name: /sw-core-01/ });
    expect(link).toHaveAttribute('href', '/devices/network/na-1');
    // A bare asset name in the header reads as noise; say what it is, visibly.
    expect(within(link).getByText('Network asset')).not.toHaveClass('sr-only');
  });
});
