import '@/lib/i18n';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceHeaderFacts, { factsToFold } from './DeviceHeaderFacts';
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

type Routes = Partial<Record<'warranty' | 'contacts' | 'billing' | 'placement' | 'assets' | 'contracts', Response | Promise<Response>>>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const EXPIRING = { warranty: { id: 'w', deviceId: 'dev-1', manufacturer: 'Dell', serialNumber: 'X', status: 'expiring', warrantyStartDate: '2023-03-01', warrantyEndDate: '2026-12-15', entitlements: [], dataSource: 'provider', lastSyncAt: null, lastSyncError: null } };

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

/** Every source has been asked (not necessarily answered). */
const fetched = () => waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.length).toBeGreaterThanOrEqual(4));
/** Every source has answered and the row has revealed its fetched facts. */
const settle = async () => {
  await fetched();
  await waitFor(() => expect(document.querySelector('[data-testid="device-header-facts"][aria-busy="true"]')).toBeNull());
};

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

  it('"Warranty details" opens the Details tab, where warranty now lives', async () => {
    route({ warranty: json(EXPIRING) });
    const onOpenTab = vi.fn();
    render(<DeviceHeaderFacts device={device()} onOpenTab={onOpenTab} />);
    fireEvent.click(await screen.findByTestId('device-fact-warranty'));
    fireEvent.click(screen.getByRole('button', { name: 'Warranty details' }));
    expect(onOpenTab).toHaveBeenCalledWith('details');
  });

  it('hides the warranty chip when the status is unknown', async () => {
    route({ warranty: json({ warranty: { id: 'w', deviceId: 'dev-1', manufacturer: 'DELL', serialNumber: 'X', status: 'unknown', warrantyStartDate: null, warrantyEndDate: null, entitlements: [], dataSource: null, lastSyncAt: null, lastSyncError: null } }) });
    render(<DeviceHeaderFacts device={device()} />);
    await settle();
    expect(screen.queryByTestId('device-fact-warranty')).not.toBeInTheDocument();
  });

  it('picks the technical contact before site and billing; a nameless contact shows its role and a call button, not a number as a name', async () => {
    route({
      contacts: json({ responsibilities: [
        { role: 'billing', level: 'organization', contacts: [
          { contactId: 'c1', name: 'Kerri Castellini', email: 'k@example.com', phone: null, mobile: null, title: null, isPrimary: true },
          // The same person entered twice: one entry, not two.
          { contactId: 'c3', name: 'Kerri Castellini', email: 'K@Example.com', phone: null, mobile: null, title: null, isPrimary: false },
        ] },
        { role: 'site', level: 'site', contacts: [{ contactId: 'c2', name: null, email: null, phone: '7037750035', mobile: null, title: null, isPrimary: false }] },
      ] }),
    });
    render(<DeviceHeaderFacts device={device()} />);
    const chip = await screen.findByTestId('device-fact-contact');
    // No technical contact → the site (local) contact wins over billing.
    expect(chip).toHaveTextContent('Local contact');
    expect(chip).not.toHaveTextContent('7037750035');
    const call = screen.getByTestId('device-fact-contact-call');
    expect(call).toHaveAttribute('href', 'tel:7037750035');
    expect(call).toHaveAccessibleName(/Call Local contact/);

    fireEvent.click(chip);
    const panel = screen.getByTestId('device-fact-contact-panel');
    // Same order as the chip: the local contact's role comes before billing.
    const headings = within(panel).getAllByTestId('device-fact-contact-role').map((h) => h.textContent);
    expect(headings[0]).toMatch(/^Local contact/);
    expect(headings[1]).toMatch(/^Billing/);
    // Where the assignment comes from.
    expect(headings[0]).toContain('This site');
    expect(headings[1]).toContain('Entire organization');
    expect(within(panel).getAllByText('Kerri Castellini')).toHaveLength(1);
    expect(within(panel).getByRole('link', { name: '7037750035' })).toHaveAttribute('href', 'tel:7037750035');
  });

  it('never shows billing in the header (it lives on the Details tab) and does not fetch it', async () => {
    route({ billing: json({ data: { uncovered: true, notBillable: false, lines: [], deviceRole: 'workstation' } }) });
    render(<DeviceHeaderFacts device={device({ model: 'OptiPlex 7060' })} />);
    await settle();
    expect(screen.queryByTestId('device-fact-billing')).not.toBeInTheDocument();
    const urls = vi.mocked(fetchWithAuth).mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('/billing') || u.startsWith('/contracts'))).toBe(false);
  });

  it('marks warranty state by shape as well as colour, with a non-text-contrast amber', async () => {
    route({ warranty: json(EXPIRING) });
    render(<DeviceHeaderFacts device={device()} />);
    const chip = await screen.findByTestId('device-fact-warranty');
    const icon = chip.querySelector('svg');
    expect(icon?.getAttribute('class')).toMatch(/lucide-shield-alert/);
    expect(icon?.closest('span')).toHaveClass('text-warning-strong');
  });

  it('labels the LAN IP visibly, like the serial', () => {
    route({});
    render(<DeviceHeaderFacts device={device({ lanIp: '10.0.4.21' })} />);
    expect(within(screen.getByTestId('device-fact-ip')).getByText('LAN IP')).not.toHaveClass('sr-only');
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

  // ── Load stability: the row must not grow or reshuffle as each fetch lands ──

  it('reveals the loaded facts together, not one by one, while identity facts show at once', async () => {
    const placement = deferred<Response>();
    route({ warranty: json(EXPIRING), placement: placement.promise });
    render(<DeviceHeaderFacts device={device({ model: 'OptiPlex 7060' })} />);
    expect(screen.getByTestId('device-fact-model')).toBeInTheDocument();
    expect(screen.getByTestId('device-header-facts')).toHaveAttribute('aria-busy', 'true');
    await fetched();
    await act(async () => { await Promise.resolve(); });
    // Warranty has answered, placement has not: hold the warranty back.
    expect(screen.queryByTestId('device-fact-warranty')).not.toBeInTheDocument();
    placement.resolve(json({ authority: { kind: 'device', id: 'dev-1', linked: false }, placement: { room: 'Server room', rack: null, rackUnit: null, heightU: null } }));
    expect(await screen.findByTestId('device-fact-warranty')).toBeInTheDocument();
    expect(screen.getByTestId('device-fact-placement')).toBeInTheDocument();
    expect(screen.getByTestId('device-header-facts')).not.toHaveAttribute('aria-busy', 'true');
  });

  it('does not hold the row forever when one source never answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      route({ warranty: json(EXPIRING), placement: new Promise<Response>(() => {}) });
      render(<DeviceHeaderFacts device={device()} />);
      await fetched();
      expect(screen.queryByTestId('device-fact-warranty')).not.toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(1500); });
      expect(await screen.findByTestId('device-fact-warranty')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the reserved line past the deadline while a slow source may still add the only fact', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      route({ contacts: new Promise<Response>(() => {}) });
      render(<DeviceHeaderFacts device={device()} />);
      await fetched();
      await act(async () => { vi.advanceTimersByTime(1500); });
      // Collapsing now and growing back when the contact lands is two jumps.
      expect(screen.getByTestId('device-header-facts')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reserves the line for a device with no identity facts while its facts load', () => {
    route({ warranty: new Promise<Response>(() => {}) });
    render(<DeviceHeaderFacts device={device()} />);
    expect(screen.getByTestId('device-header-facts')).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps to one line: low-priority facts fold behind a "more" toggle, alerts and identifiers stay; the rest expand in place', async () => {
    const WIDTHS: Record<string, number> = { model: 150, serial: 120, ip: 110, warranty: 200, contact: 200, placement: 180, 'network-asset': 180, more: 60 };
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const w = WIDTHS[this.getAttribute('data-fact') ?? ''] ?? 0;
      return { width: w, height: 24, top: 0, left: 0, right: w, bottom: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'device-header-facts' ? 760 : 0;
    });
    try {
      route({
        warranty: json(EXPIRING),
        contacts: json({ responsibilities: [{ role: 'technical', level: 'organization', contacts: [{ contactId: 'c1', name: 'Kerri Castellini', email: null, phone: '555', mobile: null, title: null, isPrimary: true }] }] }),
        placement: json({ authority: { kind: 'device', id: 'dev-1', linked: false }, placement: { room: 'Server room', rack: 'A', rackUnit: 12, heightU: 1 } }),
        assets: json({ assets: [{ id: 'na-1', label: 'sw-core-01' }] }),
      });
      render(<DeviceHeaderFacts device={device({ model: 'OptiPlex 7060', serialNumber: '4XK9P2', lanIp: '10.0.4.21' })} />);
      const more = await screen.findByTestId('device-facts-more');
      // 150+120+110+200 + 60 ("3 more") fits 760; adding the contact (200) does not.
      for (const id of ['device-fact-model', 'device-fact-serial', 'device-fact-ip', 'device-fact-warranty']) {
        expect(screen.getByTestId(id)).toBeVisible();
      }
      for (const id of ['device-fact-contact', 'device-fact-placement', 'device-network-asset-link']) {
        expect(screen.getByTestId(id)).not.toBeVisible();
      }
      expect(more).toHaveTextContent('3 more');
      expect(more).toHaveAttribute('aria-expanded', 'false');
      // Expanding is the user's choice, so the row may wrap then; loading never wraps it.
      fireEvent.click(more);
      expect(more).toHaveAttribute('aria-expanded', 'true');
      expect(more).toHaveTextContent('Show less');
      for (const id of ['device-fact-contact', 'device-fact-placement', 'device-network-asset-link']) {
        expect(screen.getByTestId(id)).toBeVisible();
      }
      fireEvent.click(more);
      expect(screen.getByTestId('device-fact-contact')).not.toBeVisible();
    } finally {
      rect.mockRestore();
      client.mockRestore();
    }
  });
});

describe('factsToFold', () => {
  it('folds nothing when everything fits', () => {
    expect(factsToFold([{ key: 'a', rank: 0, width: 100 }, { key: 'b', rank: 1, width: 100 }], 220, 20, 50).size).toBe(0);
  });

  it('keeps facts in priority order and skips one that does not fit rather than every fact ranked below it', () => {
    const folded = factsToFold(
      [{ key: 'a', rank: 0, width: 100 }, { key: 'b', rank: 1, width: 300 }, { key: 'c', rank: 2, width: 50 }],
      420, 0, 50,
    );
    expect([...folded]).toEqual(['b']);
  });

  it('always keeps the top-ranked fact', () => {
    expect([...factsToFold([{ key: 'a', rank: 0, width: 500 }, { key: 'b', rank: 1, width: 500 }], 300, 0, 50)]).toEqual(['b']);
  });
});
