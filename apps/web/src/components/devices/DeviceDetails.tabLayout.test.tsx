/**
 * Device detail tab layout: a curated primary row, everything else grouped
 * inside "More", and "needs attention" counts from GET /devices/:id/tab-counts
 * that badge the tabs and promote the by-default-empty signal tabs
 * (Anomalies / Tickets / Operator Tasks) into the primary row only when they
 * have something to show.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';
import { useOrgStore } from '../../stores/orgStore';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => null,
}));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  pendingReboot: false,
  displayName: 'Edge 01',
} as Device;

const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const notFound = (): Response =>
  ({ ok: false, status: 404, statusText: 'NOT FOUND', json: vi.fn().mockResolvedValue({}) }) as unknown as Response;

// jsdom reports 0 for every width; give the tab row room so only the curated
// secondary set lands in "More" (see OverflowTabs.test.tsx for the same stub).
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

let counts: Record<string, number> | null;
// Sweep E1: undefined ⇒ no org context / hook not exercised by a given test
// (the default — matches every pre-existing test in this file, which never
// set an org and so never called GET /config/ml-feature-flags at all).
let mlAnomaliesEnabled: boolean | undefined;

beforeEach(() => {
  window.location.hash = '';
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 60 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 4000 });
  counts = { alerts: 0, anomalies: 0, tickets: 0, operatorTasks: 0, monitoring: 0, compliance: 0 };
  mlAnomaliesEnabled = undefined;
  useOrgStore.setState({ currentOrgId: null });
  fetchWithAuthMock.mockImplementation((url: string) => {
    const href = String(url);
    if (href.includes('/tab-counts')) {
      return Promise.resolve(counts ? jsonResponse({ data: counts }) : notFound());
    }
    if (href.includes('/config/ml-feature-flags')) {
      return Promise.resolve(jsonResponse({
        mlFeatureFlags: {
          'ml.anomalies.enabled': { flag: 'ml.anomalies.enabled', enabled: mlAnomaliesEnabled ?? true, defaultEnabled: true },
        },
      }));
    }
    return Promise.resolve(notFound());
  });
});

afterEach(() => {
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  else delete (HTMLElement.prototype as any).offsetWidth;
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  else delete (HTMLElement.prototype as any).clientWidth;
  window.location.hash = '';
  useOrgStore.setState({ currentOrgId: null });
});

const visibleTabNames = () => screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''));

describe('DeviceDetails tab layout', () => {
  it('shows the curated primary row and keeps empty signal tabs inside "More"', async () => {
    render(<DeviceDetails device={device} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(expect.stringContaining('/devices/device-1/tab-counts')));

    expect(visibleTabNames()).toEqual([
      'Overview', 'Details', 'Performance', 'Alerts', 'Event Log', 'Hardware', 'Software', 'Patches', 'Scripts',
    ]);
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(items).toEqual(expect.arrayContaining(['Anomalies', 'Tickets', 'Operator Tasks', 'Monitoring', 'Compliance']));
    const headers = Array.from(screen.getByRole('menu').querySelectorAll('[data-overflow-group]')).map((h) => h.textContent);
    expect(headers).toEqual(['Monitoring', 'Inventory', 'Management', 'History & Network']);
  });

  it('promotes Tickets into the primary row with a badge when the device has open tickets', async () => {
    counts = { alerts: 4, anomalies: 0, tickets: 2, operatorTasks: 0, monitoring: 0, compliance: 0 };
    render(<DeviceDetails device={device} />);

    const tickets = await screen.findByRole('tab', { name: /tickets/i });
    expect(tickets).toHaveTextContent('Tickets2');
    expect(screen.getByRole('tab', { name: /^alerts/i })).toHaveTextContent('Alerts4');
    expect(visibleTabNames()).toEqual([
      'Overview', 'Details', 'Performance', 'Alerts', 'Tickets', 'Event Log', 'Hardware', 'Software', 'Patches', 'Scripts',
    ]);
  });

  it('badges Monitoring/Compliance inside "More" and marks the trigger with a dot, without promoting them', async () => {
    counts = { alerts: 0, anomalies: 0, tickets: 0, operatorTasks: 0, monitoring: 1, compliance: 3 };
    render(<DeviceDetails device={device} />);

    await waitFor(() => expect(screen.getByTestId('overflow-tabs-hidden-dot')).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: /compliance/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    expect(screen.getByRole('menuitem', { name: /compliance/i })).toHaveTextContent('Compliance3');
    expect(screen.getByRole('menuitem', { name: /monitoring/i })).toHaveTextContent('Monitoring1');
  });

  it('still renders the tab bar when the counts request fails', async () => {
    counts = null;
    render(<DeviceDetails device={device} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(expect.stringContaining('/tab-counts')));
    expect(screen.getByRole('tab', { name: /overview/i })).toBeInTheDocument();
    expect(screen.queryByTestId('overflow-tabs-hidden-dot')).toBeNull();
  });

  // Sweep E1: a stale open metric_anomalies count (server-side, device-scoped)
  // must not badge or promote Anomalies once detection is confirmed OFF for
  // this org — the panel behind that badge would just say "disabled".
  it('never badges or promotes Anomalies once org detection is confirmed off, even with open episodes counted', async () => {
    counts = { alerts: 0, anomalies: 2, tickets: 0, operatorTasks: 0, monitoring: 0, compliance: 0 };
    mlAnomaliesEnabled = false;
    useOrgStore.setState({ currentOrgId: 'org-1' });
    render(<DeviceDetails device={device} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(expect.stringContaining('/config/ml-feature-flags')));
    // Not promoted into the primary row (an enabled org would show it there,
    // badged "2" — see the sibling Tickets-promotion test above).
    expect(screen.queryByRole('tab', { name: /anomalies/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    expect(screen.getByRole('menuitem', { name: /anomalies/i })).toHaveTextContent('Anomalies');
    expect(screen.getByRole('menuitem', { name: /anomalies/i })).not.toHaveTextContent('Anomalies2');
  });

  it('still badges/promotes Anomalies normally when org detection is on', async () => {
    counts = { alerts: 0, anomalies: 2, tickets: 0, operatorTasks: 0, monitoring: 0, compliance: 0 };
    mlAnomaliesEnabled = true;
    useOrgStore.setState({ currentOrgId: 'org-1' });
    render(<DeviceDetails device={device} />);

    const anomalies = await screen.findByRole('tab', { name: /anomalies/i });
    expect(anomalies).toHaveTextContent('Anomalies2');
  });
});
