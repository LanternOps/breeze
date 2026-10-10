import { beforeEach, describe, expect, it, vi } from 'vitest';

// #8134 — get_device_details carries the device's physical placement (room /
// rack / rack unit / height U), the agent-facing read of devices/placement.ts.

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

function rigTables(byTable: Record<string, unknown[]>) {
  m.select.mockImplementation(() => {
    const builder: any = {
      where: vi.fn(() => builder), orderBy: vi.fn(() => builder), limit: vi.fn(() => builder),
    };
    builder.from = vi.fn((table: any) => {
      const promise = Promise.resolve(byTable[table[Symbol.for('drizzle:Name')] as string] ?? []);
      builder.then = promise.then.bind(promise);
      return builder;
    });
    return builder;
  });
}

function tool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerDeviceTools(tools);
  return tools.get('get_device_details')!;
}

describe('get_device_details physical placement (#8134)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.access.mockResolvedValue({ device: DEVICE });
  });

  it('returns the stored placement fields', async () => {
    rigTables({
      asset_physical_placements: [{
        id: 'p1', orgId: 'org-1', deviceId: DEVICE.id, discoveredAssetId: null,
        room: 'MDF', rack: 'R2', rackUnit: 12, heightU: 2,
      }],
    });

    const out = JSON.parse(await tool().handler({ deviceId: DEVICE.id }, {} as any));

    expect(out.placement).toEqual({ room: 'MDF', rack: 'R2', rackUnit: 12, heightU: 2 });
  });

  it('returns null placement when none is recorded', async () => {
    rigTables({});
    const out = JSON.parse(await tool().handler({ deviceId: DEVICE.id }, {} as any));
    expect(out.placement).toBeNull();
  });
});
