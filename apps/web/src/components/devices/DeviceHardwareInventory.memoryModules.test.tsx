import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceHardwareInventory from './DeviceHardwareInventory';

// #5351 — per-slot memory inventory on the device Hardware tab.

vi.mock('./DeviceWarrantyCard', () => ({ default: () => null }));
vi.mock('./hardware/StorageHealthSection', () => ({ default: () => null }));

const m = vi.hoisted(() => ({ payload: {} as Record<string, unknown> }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify(m.payload), { status: 200 })),
}));

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const OBSERVED = '2026-09-26T00:00:00.000Z';

const dimm = (i: number, overrides: Record<string, unknown> = {}) => ({
  id: `m${i}`, slotKey: `smbios:0x${1100 + i}`, slotIndex: i, locator: `DIMM_A${i + 1}`, bankLabel: `BANK ${i}`,
  populated: true, capacityMb: 16384, memoryType: 'DDR4', formFactor: 'DIMM', speedMts: 3200,
  configuredSpeedMts: 2933, manufacturer: 'Samsung', partNumber: 'M378A2K43DB1-CTD', serialNumber: `SN${i}`,
  ...overrides,
});
const empty = (i: number) => ({
  id: `m${i}`, slotKey: `smbios:0x${1100 + i}`, slotIndex: i, locator: `DIMM_A${i + 1}`, bankLabel: null,
  populated: false, capacityMb: null, memoryType: null, formFactor: null, speedMts: null, configuredSpeedMts: null,
  manufacturer: null, partNumber: null, serialNumber: null,
});

function payload(hardware: Record<string, unknown>, memoryModules: unknown[]) {
  return {
    hardware: { cpuModel: 'Xeon', ramTotalMb: 32768, ...hardware },
    diskDrives: [], networkInterfaces: [], memoryModules,
  };
}

describe('DeviceHardwareInventory memory modules (#5351)', () => {
  beforeEach(() => {
    m.payload = {};
  });

  it('summarises used slots and a uniform configured speed on the memory card', async () => {
    m.payload = payload(
      { memorySlotsTotal: 4, memoryObservedAt: OBSERVED, memorySoldered: false },
      [dimm(0), empty(1), dimm(2), empty(3)],
    );
    render(<DeviceHardwareInventory deviceId={DEVICE_ID} />);

    expect(await screen.findByTestId('memory-slots-used')).toHaveTextContent('2 of 4 slots used');
    expect(screen.getByTestId('memory-speed-summary')).toHaveTextContent('2,933 MT/s');
    expect(screen.getByTestId('memory-speed-summary')).toHaveTextContent('configured');
  });

  it('shows a speed range when modules run at different speeds, labelled rated when no configured speed is known', async () => {
    m.payload = payload(
      { memorySlotsTotal: 2, memoryObservedAt: OBSERVED },
      [dimm(0, { configuredSpeedMts: null, speedMts: 2400 }), dimm(1, { configuredSpeedMts: null, speedMts: 3200 })],
    );
    render(<DeviceHardwareInventory deviceId={DEVICE_ID} />);

    const speed = await screen.findByTestId('memory-speed-summary');
    expect(speed).toHaveTextContent('2,400–3,200 MT/s');
    expect(speed).toHaveTextContent('rated');
  });

  it('lists every slot in a scrollable table with empty slots marked Empty', async () => {
    m.payload = payload({ memorySlotsTotal: 2, memoryObservedAt: OBSERVED }, [dimm(0), empty(1)]);
    render(<DeviceHardwareInventory deviceId={DEVICE_ID} />);

    const table = await screen.findByTestId('memory-modules-table');
    expect(table.closest('[data-testid="memory-modules-scroll"]')).toHaveClass('overflow-x-auto');
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Slot', 'Capacity', 'Type', 'Speed', 'Manufacturer', 'Part Number', 'Serial']);

    const rows = within(table).getAllByTestId('memory-module-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('DIMM_A1')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('16.0 GB');
    expect(rows[0]).toHaveTextContent('DDR4');
    expect(rows[0]).toHaveTextContent('Samsung');
    expect(rows[0]).toHaveTextContent('M378A2K43DB1-CTD');
    expect(rows[0]).toHaveTextContent('SN0');
    expect(within(rows[1]!).getByText('DIMM_A2')).toBeInTheDocument();
    expect(within(rows[1]!).getByTestId('memory-module-empty')).toHaveTextContent('Empty');
  });

  it('shows "On-package memory" for soldered memory instead of a slot count', async () => {
    m.payload = payload(
      { memorySoldered: true, memoryObservedAt: OBSERVED, memorySlotsTotal: null },
      [dimm(0, { slotKey: 'macos:on-package', locator: 'On-package', memoryType: 'LPDDR5', speedMts: null, configuredSpeedMts: null })],
    );
    render(<DeviceHardwareInventory deviceId={DEVICE_ID} />);

    expect(await screen.findByTestId('memory-on-package')).toHaveTextContent('On-package memory');
    expect(screen.queryByTestId('memory-slots-used')).not.toBeInTheDocument();
  });

  it('explains that an agent update is needed when memory was never reported', async () => {
    m.payload = payload({ memoryObservedAt: null }, []);
    render(<DeviceHardwareInventory deviceId={DEVICE_ID} />);

    expect(await screen.findByTestId('memory-modules-not-reported'))
      .toHaveTextContent('Not reported yet — needs agent update');
    expect(screen.queryByTestId('memory-modules-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('memory-slots-used')).not.toBeInTheDocument();
  });

  it('tolerates an API that predates memoryModules (older server)', async () => {
    m.payload = { hardware: { cpuModel: 'Xeon', ramTotalMb: 8192 }, diskDrives: [], networkInterfaces: [] };
    render(<DeviceHardwareInventory deviceId={DEVICE_ID} />);

    expect(await screen.findByTestId('memory-modules-not-reported')).toBeInTheDocument();
  });
});
