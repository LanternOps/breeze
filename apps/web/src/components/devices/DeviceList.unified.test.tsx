import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';

// Unified Devices list (#1322): network-discovered devices render alongside
// agent endpoints with a class badge, a type badge, an All/Agent/Network
// facet, and blank agent-only columns.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
// Fleet view so the fleet-only Organization column stays available to these
// suites (see DeviceList isColumnAvailable).
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

const agent: Device = {
  id: '11111111-1111-1111-1111-111111111111',
  deviceClass: 'agent',
  hostname: 'agent-box',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 42,
  ramPercent: 55,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '0.70.0',
  tags: [],
};

const networkPrinter: Device = {
  id: '22222222-2222-2222-2222-222222222222',
  deviceClass: 'network',
  assetType: 'printer',
  hostname: 'Lobby Printer',
  os: '' as Device['os'],
  osVersion: '',
  status: 'online',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '',
  tags: [],
  manufacturer: 'HP',
  model: 'LaserJet',
  monitoringEnabled: true,
};

describe('DeviceList — unified agent + network (#1322)', () => {
  it('renders class badges distinguishing agent and network rows', () => {
    render(<DeviceList devices={[agent, networkPrinter]} pageSize={50} networkDevicesEnabled />);

    const agentBadge = screen.getByTestId(`device-${agent.id}-class-badge`);
    expect(agentBadge.textContent).toMatch(/Agent/i);

    const netBadge = screen.getByTestId(`device-${networkPrinter.id}-class-badge`);
    expect(netBadge.textContent).toMatch(/Network/i);
  });

  it('hides the Class column and the facet entirely when the network arm is disabled', () => {
    render(<DeviceList devices={[agent, networkPrinter]} pageSize={50} />);

    // No class badge cells and no class facet when the feature flag is off.
    expect(screen.queryByTestId(`device-${agent.id}-class-badge`)).toBeNull();
    expect(screen.queryByTestId('device-class-filter-network')).toBeNull();
    // The agent row still renders — it's just the agent-only view.
    expect(screen.getByText('agent-box')).toBeTruthy();
  });

  it('shows the All/Agent/Network facet only when a network device is present', () => {
    const { rerender } = render(<DeviceList devices={[agent]} pageSize={50} networkDevicesEnabled />);
    expect(screen.queryByTestId('device-class-filter-network')).toBeNull();

    rerender(<DeviceList devices={[agent, networkPrinter]} pageSize={50} networkDevicesEnabled />);
    expect(screen.getByTestId('device-class-filter-network')).toBeTruthy();
  });

  it('filters to network-only when the Network facet is selected', () => {
    render(<DeviceList devices={[agent, networkPrinter]} pageSize={50} networkDevicesEnabled />);

    // Both rows visible under "All".
    expect(screen.getByText('agent-box')).toBeTruthy();
    expect(screen.getByText('Lobby Printer')).toBeTruthy();

    fireEvent.click(screen.getByTestId('device-class-filter-network'));

    expect(screen.queryByText('agent-box')).toBeNull();
    expect(screen.getByText('Lobby Printer')).toBeTruthy();
  });

  it('routes a network row to onSelect (Discovery placeholder) via the View button', () => {
    const onSelect = vi.fn();
    render(<DeviceList devices={[networkPrinter]} onSelect={onSelect} pageSize={50} networkDevicesEnabled />);

    fireEvent.click(screen.getByTestId(`device-${networkPrinter.id}-open-network`));
    expect(onSelect).toHaveBeenCalledWith(networkPrinter);
  });

  it('renders agent-only columns blank for a network row (no metric bars)', () => {
    render(<DeviceList devices={[networkPrinter]} pageSize={50} networkDevicesEnabled />);

    // The network row exists.
    const row = screen.getByText('Lobby Printer').closest('tr')!;
    // CPU/RAM are rendered as an em-dash placeholder (—) not a 0% bar; the
    // agent-only cells must not render a progressbar-style metric element.
    expect(within(row).queryByText('0%')).toBeNull();
  });

  // #1386: Role (agent function) and Type (network asset_type) used to collapse
  // to the same deviceRole value+icon on agent rows, reading as a duplicate
  // column. They're now complementary — each populated for exactly one class,
  // a dash for the other — so they never show the same value side by side.
  describe('Role and Type are complementary, never duplicated (#1386)', () => {
    const agentWorkstation: Device = { ...agent, deviceRole: 'workstation' };

    beforeEach(() => {
      // Type is opt-in now (default-off); enable it so this view exercises both
      // columns. writeColumnVisibility persists to localStorage, which the list
      // reads at mount.
      writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS, 'type']);
    });
    afterEach(() => window.localStorage.clear());

    it('agent row: Role shows the function, Type is a dash (not an echo of Role)', () => {
      render(<DeviceList devices={[agentWorkstation]} pageSize={50} networkDevicesEnabled />);

      // Role is populated for the agent.
      const roleCell = screen.getByTestId(`device-${agentWorkstation.id}-role`);
      expect(within(roleCell).getByLabelText('Workstation')).toBeTruthy();

      // Type renders nothing meaningful for an agent — it has no populated
      // (testid-bearing) cell, just a dash — so it can't duplicate Role.
      expect(screen.queryByTestId(`device-${agentWorkstation.id}-type`)).toBeNull();
    });

    it('network row: Type shows the asset type, Role is a dash', () => {
      render(<DeviceList devices={[networkPrinter]} pageSize={50} networkDevicesEnabled />);

      const typeCell = screen.getByTestId(`device-${networkPrinter.id}-type`);
      expect(typeCell.textContent).toMatch(/printer/i);

      // Role is meaningless for a printer — rendered as a dash, no role badge.
      const roleCell = screen.getByTestId(`device-${networkPrinter.id}-role`);
      expect(roleCell.textContent).toMatch(/—/);
      expect(within(roleCell).queryByLabelText(/workstation|server|printer/i)).toBeNull();
    });
  });

  // #1424 (deferred item 1): with no column actively selected, the agent arm
  // arrives hostname-sorted and the network arm last-seen-sorted, and
  // DevicesPage concatenates them as `[...agents, ...network]`. The raw
  // concatenation renders as two differently-ordered blocks ("the merged list
  // visibly alternates sort order"). The default ordering must instead apply one
  // unified key across the whole union so the classes interleave coherently.
  describe('unified default sort across the merged union (#1424)', () => {
    // Primary display name of each rendered row, in DOM order. The hostname
    // cell renders the primary name (`displayName || hostname`) in a
    // `font-medium` span and, only when a distinct displayName is present, the
    // raw hostname in a second muted span — so target the primary span
    // explicitly rather than every span in the cell.
    const rowOrder = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('tbody tr td:nth-child(2) span.font-medium')).map(
        el => el.textContent,
      );

    const mkAgent = (id: string, hostname: string): Device => ({ ...agent, id, hostname });
    const mkNetwork = (id: string, hostname: string): Device => ({ ...networkPrinter, id, hostname });

    it('interleaves agent and network rows by name (numeric collation) instead of as two blocks', () => {
      // Input arrives as the DevicesPage concatenation: all agents first (in
      // their server hostname order), then all network rows (in last-seen
      // order). Names force a coherent default sort to interleave the two
      // classes, which a raw concatenation never would. `node-2`/`node-10` also
      // pin the numeric collation: a lexical sort would order `node-10` first.
      const devices: Device[] = [
        mkAgent('a1111111-0000-0000-0000-000000000010', 'node-10'),
        mkAgent('a1111111-0000-0000-0000-000000000001', 'alpha-pc'),
        mkNetwork('b2222222-0000-0000-0000-000000000002', 'node-2'),
        mkNetwork('b2222222-0000-0000-0000-000000000003', 'bravo-switch'),
      ];

      const { container } = render(<DeviceList devices={devices} pageSize={50} networkDevicesEnabled />);

      // agent, network, network, agent — interleaved, and node-2 before node-10.
      expect(rowOrder(container)).toEqual(['alpha-pc', 'bravo-switch', 'node-2', 'node-10']);
    });

    it('orders by displayName when present, not the raw hostname', () => {
      // The default key is `displayName || hostname` (the same the Device column
      // sorts on). A device whose displayName disagrees with its hostname order
      // must sort by the displayName the cell actually shows — sorting by raw
      // hostname would place `zzz-machine` last instead of first.
      const labeled: Device = {
        ...agent,
        id: 'a3333333-0000-0000-0000-000000000001',
        hostname: 'zzz-machine',
        displayName: 'aaa-friendly',
      };
      const plain = mkAgent('a3333333-0000-0000-0000-000000000002', 'mmm-machine');

      const { container } = render(
        <DeviceList devices={[plain, labeled]} pageSize={50} networkDevicesEnabled />,
      );

      expect(rowOrder(container)).toEqual(['aaa-friendly', 'mmm-machine']);
    });

    it('breaks hostname ties by id so client-side pagination is deterministic', () => {
      // Two rows share a hostname; without a stable tiebreaker their relative
      // order would depend on input/merge order and a row could hop pages
      // between renders. The id tiebreaker pins the order.
      const devices: Device[] = [
        mkNetwork('b0000000-0000-0000-0000-0000000000ff', 'shared-host'),
        mkAgent('a0000000-0000-0000-0000-000000000001', 'shared-host'),
      ];

      const { container } = render(<DeviceList devices={devices} pageSize={50} networkDevicesEnabled />);

      // Both rows render the same hostname text, so assert order via the class
      // badge id and confirm reversing the input doesn't change the DOM order.
      const firstPass = Array.from(container.querySelectorAll('tbody tr')).map(tr =>
        tr.querySelector('[data-testid$="-class-badge"]')?.getAttribute('data-testid'),
      );
      const { container: container2 } = render(
        <DeviceList devices={[...devices].reverse()} pageSize={50} networkDevicesEnabled />,
      );
      const secondPass = Array.from(container2.querySelectorAll('tbody tr')).map(tr =>
        tr.querySelector('[data-testid$="-class-badge"]')?.getAttribute('data-testid'),
      );

      // a000... sorts before b000..., regardless of input order.
      expect(firstPass).toEqual([
        'device-a0000000-0000-0000-0000-000000000001-class-badge',
        'device-b0000000-0000-0000-0000-0000000000ff-class-badge',
      ]);
      expect(secondPass).toEqual(firstPass);
    });

    it('applies the unified numeric collation even with zero network rows (agent-only fleet)', () => {
      // The default sort is unconditional — gated only on "no active column
      // sort", not on the network arm. So an agent-only fleet (feature flag off,
      // no network rows) is still re-ordered to the unified key: host-2 sorts
      // before host-10 rather than keeping the server's lexical order. This is
      // intentional and deterministic, not a network-only behavior.
      const devices: Device[] = [
        mkAgent('a4444444-0000-0000-0000-000000000010', 'host-10'),
        mkAgent('a4444444-0000-0000-0000-000000000002', 'host-2'),
        mkAgent('a4444444-0000-0000-0000-000000000001', 'alpha'),
      ];

      const { container } = render(<DeviceList devices={devices} pageSize={50} />);

      expect(rowOrder(container)).toEqual(['alpha', 'host-2', 'host-10']);
    });

    it('sorts a row with an empty/whitespace name last (blanks-last)', () => {
      // `displayName || hostname` can be blank; such a row must sink to the
      // bottom rather than collate as an empty string among the named rows —
      // matching the column-sort branch's blanks-last rule.
      const devices: Device[] = [
        mkAgent('a5555555-0000-0000-0000-000000000001', '   '),
        mkAgent('a5555555-0000-0000-0000-000000000002', 'bravo'),
        mkAgent('a5555555-0000-0000-0000-000000000003', 'alpha'),
      ];

      const { container } = render(<DeviceList devices={devices} pageSize={50} networkDevicesEnabled />);

      const order = rowOrder(container);
      expect(order.slice(0, 2)).toEqual(['alpha', 'bravo']);
      // The blank-named row renders last; its primary name span is whitespace.
      expect(order[2]?.trim()).toBe('');
    });
  });
});
