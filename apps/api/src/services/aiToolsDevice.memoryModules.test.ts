import { beforeEach, describe, expect, it, vi } from 'vitest';

// #5351 — get_device_details carries the per-slot memory inventory: a bounded
// module list plus the full count, and a populated/free summary computed from
// ALL slots before the list is truncated.

const m = vi.hoisted(() => ({ access: vi.fn(), select: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: m.select, insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
  withDbAccessContext: (_ctx: any, fn: any) => fn(),
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(), getAllDeviceContext: vi.fn(), createDeviceContext: vi.fn(), resolveDeviceContext: vi.fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: m.access }));
vi.mock('./hardwareHealth/view', () => ({ getDeviceHardwareHealthView: vi.fn() }));

import { registerDeviceTools } from './aiToolsDevice';
import type { AiTool } from './aiTools';

const DEVICE = {
  id: '22222222-2222-4222-8222-222222222222', orgId: 'org-1', siteId: 'site-1', hostname: 'srv-01',
  osType: 'linux', status: 'online',
};

function query(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const builder: any = {
    from: vi.fn(() => builder), where: vi.fn(() => builder), orderBy: vi.fn(() => builder),
    limit: vi.fn(() => builder), then: promise.then.bind(promise),
  };
  return builder;
}

function rigTables(byTable: Record<string, unknown[]>) {
  m.select.mockImplementation(() => {
    const builder = query([]);
    builder.from = vi.fn((table: any) => {
      const rows = byTable[table[Symbol.for('drizzle:Name')] as string] ?? [];
      const promise = Promise.resolve(rows);
      builder.then = promise.then.bind(promise);
      return builder;
    });
    return builder;
  });
}

const slot = (i: number, populated: boolean, capacityMb: number | null = populated ? 16384 : null) => ({
  id: `m${i}`, deviceId: DEVICE.id, orgId: 'org-1', slotKey: `smbios:0x${1100 + i}`, slotIndex: i,
  locator: `DIMM_${i}`, bankLabel: null, populated, capacityMb, memoryType: populated ? 'DDR4' : null,
  formFactor: 'DIMM', speedMts: populated ? 3200 : null, configuredSpeedMts: populated ? 2933 : null,
  manufacturer: populated ? 'Samsung' : null, partNumber: null, serialNumber: populated ? `SN${i}` : null,
  updatedAt: new Date('2026-09-26T00:00:00.000Z'),
});

function tool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerDeviceTools(tools);
  return tools.get('get_device_details')!;
}

describe('get_device_details memory modules (#5351)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.access.mockResolvedValue({ device: DEVICE });
  });

  it('mentions memory modules in its description so the model knows to use it', () => {
    expect(tool().definition.description).toMatch(/memory module|RAM slot/i);
  });

  it('returns slot-ordered modules and a populated/free summary', async () => {
    rigTables({
      device_hardware: [{ deviceId: DEVICE.id, ramTotalMb: 32768, memorySlotsTotal: 4, memoryMaxCapacityMb: 131072, memorySoldered: false, memoryObservedAt: new Date('2026-09-26T00:00:00.000Z') }],
      device_memory_modules: [slot(0, true), slot(1, false), slot(2, true), slot(3, false)],
      sites: [{ name: 'HQ' }],
    });

    const out = JSON.parse(await tool().handler({ deviceId: DEVICE.id }, {} as any));

    expect(out.memorySummary).toEqual({
      reported: true, slotsTotal: 4, slotsPopulated: 2, slotsFree: 2, installedMb: 32768,
      maxCapacityMb: 131072, soldered: false, observedAt: '2026-09-26T00:00:00.000Z',
    });
    expect(out.memoryModuleCount).toBe(4);
    expect(out.memoryModules.map((row: any) => row.locator)).toEqual(['DIMM_0', 'DIMM_1', 'DIMM_2', 'DIMM_3']);
    expect(out.memoryModules[0]).toEqual({
      locator: 'DIMM_0', bankLabel: null, populated: true, capacityMb: 16384, memoryType: 'DDR4', formFactor: 'DIMM',
      speedMts: 3200, configuredSpeedMts: 2933, manufacturer: 'Samsung', partNumber: null, serialNumber: 'SN0',
    });
  });

  it('computes the summary from every slot before bounding the list', async () => {
    const modules = Array.from({ length: 48 }, (_, i) => slot(i, i % 3 === 0));
    rigTables({
      device_hardware: [{ deviceId: DEVICE.id, memorySlotsTotal: 48, memoryObservedAt: new Date('2026-09-26T00:00:00.000Z') }],
      device_memory_modules: modules,
    });

    const out = JSON.parse(await tool().handler({ deviceId: DEVICE.id }, {} as any));

    expect(out.memoryModules).toHaveLength(32);
    expect(out.memoryModuleCount).toBe(48);
    expect(out.memorySummary).toMatchObject({ slotsTotal: 48, slotsPopulated: 16, slotsFree: 32, installedMb: 16 * 16384 });
  });

  it('says memory was not reported (rather than "0 slots") for a device without a memory report', async () => {
    rigTables({ device_hardware: [{ deviceId: DEVICE.id, ramTotalMb: 8192, memoryObservedAt: null }] });

    const out = JSON.parse(await tool().handler({ deviceId: DEVICE.id }, {} as any));

    expect(out.memoryModules).toEqual([]);
    expect(out.memoryModuleCount).toBe(0);
    expect(out.memorySummary).toEqual({ reported: false });
  });

  it('checks device access before reading any inventory', async () => {
    m.access.mockResolvedValue({ error: 'Device not found or access denied' });
    const out = JSON.parse(await tool().handler({ deviceId: DEVICE.id }, {} as any));
    expect(out).toEqual({ error: 'Device not found or access denied' });
    expect(m.select).not.toHaveBeenCalled();
  });
});
