/**
 * Overview blocks are ordered by triage value (#9029), and Overview ENDS at
 * the performance graphs. Contacts, warranty, billing, placement and WAN live
 * in the header facts row (DeviceHeaderFacts) or the Details tab's Asset
 * record (DeviceAssetRecord) — never as another card below the graphs.
 */
import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import { fetchWithAuth } from '../../stores/auth';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    fetchWithAuth: vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'NOT FOUND',
      json: vi.fn().mockResolvedValue({}),
    }),
  };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => null,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./DeviceOverviewState', () => ({ default: () => <div data-testid="block-state" /> }));
vi.mock('./DeviceReliabilityPanel', () => ({ default: () => <div data-testid="block-reliability" /> }));
vi.mock('./DevicePerformanceGraphs', () => ({ default: () => <div data-testid="block-performance" /> }));
vi.mock('../shared/ContactResponsibilitiesCard', () => ({ default: () => <div data-testid="block-contacts" /> }));
vi.mock('./DeviceWarrantyCard', () => ({ default: () => <div data-testid="block-warranty" /> }));
vi.mock('./DeviceBillingCard', () => ({ default: () => <div data-testid="block-billing" /> }));
vi.mock('./PhysicalPlacementCard', () => ({ default: () => <div data-testid="block-placement" /> }));
vi.mock('./AssetCircuitCard', () => ({ default: () => <div data-testid="block-circuit" /> }));
vi.mock('./DeviceQueuedActions', () => ({ default: () => <div data-testid="block-queued" /> }));
vi.mock('./DeviceHeaderFacts', () => ({ default: () => <div data-testid="block-header-facts" /> }));
// The Hardware tab's own sections read real payload shapes; only its circuit mount is under test here.
vi.mock('./hardware/StorageHealthSection', () => ({ default: () => null }));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'offline',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: new Date(Date.now() - 25 * 60_000).toISOString(),
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
} as Device;

const before = (a: HTMLElement, b: HTMLElement) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

// The complete list of blocks the Overview column may hold. Adding a block
// here is a design decision, not a default: a new device fact goes in the
// header facts row if it changes the tech's next move and fits in ~3 words,
// otherwise in a named Details-tab section (DeviceAssetRecord).
const OVERVIEW_ALLOWLIST = ['block-state', 'block-queued', 'device-health-strip', 'block-reliability', 'block-performance'];

describe('DeviceDetails Overview (#9029)', () => {
  it('orders state → health → reliability → performance', () => {
    render(<DeviceDetails device={device} />);
    const order = OVERVIEW_ALLOWLIST.map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i++) {
      expect(before(order[i - 1]!, order[i]!), `${order[i - 1]!.dataset.testid} before ${order[i]!.dataset.testid}`).toBe(true);
    }
  });

  it('ends at the performance graphs: the column holds only allowlisted blocks', () => {
    render(<DeviceDetails device={device} />);
    const column = screen.getByTestId('device-overview-main');
    const children = Array.from(column.children).map((el) => (el as HTMLElement).dataset.testid ?? el.outerHTML.slice(0, 80));
    expect(
      children,
      'New Overview block? Put a one-line fact in DeviceHeaderFacts, or a record in a Details-tab section (DeviceAssetRecord).',
    ).toEqual(OVERVIEW_ALLOWLIST);
  });

  it('shows the facts row in the header, above the tabs, on every tab', () => {
    render(<DeviceDetails device={device} />);
    expect(before(screen.getByTestId('block-header-facts'), screen.getByTestId('device-overview-main'))).toBe(true);
  });

  it('puts contacts, placement and billing in the Details tab Asset record, and WAN/circuit on Hardware', async () => {
    window.location.hash = '#details';
    const { unmount } = render(<DeviceDetails device={device} />);
    const record = screen.getByTestId('device-asset-record');
    for (const id of ['block-contacts', 'block-placement', 'block-billing']) {
      expect(record.contains(screen.getByTestId(id)), id).toBe(true);
    }
    unmount();
    // The Hardware tab only renders its sections once inventory loads.
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: async () => ({}) } as Response);
    window.location.hash = '#hardware';
    render(<DeviceDetails device={device} />);
    expect(await screen.findByTestId('block-circuit')).toBeInTheDocument();
    window.location.hash = '';
  });
});
