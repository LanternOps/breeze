import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Active-VPN-client presence ingest via PUT /:id/network (#2139). Verifies the
// handler stamps reportedAt server-side and persists the snapshot to
// devices.activeVpns, that old agents (no `vpns`) store an empty array, and
// that the payload validator rejects unknown providers.

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

vi.mock('../../services/warrantySync', () => ({ upsertAgentWarranty: vi.fn() }));
vi.mock('../../services/warrantyWorker', () => ({
  queueWarrantySyncForDevice: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../../db';
import { inventoryRoutes } from './inventory';

function mockDeviceLookup(device: { id: string; orgId: string } | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(device ? [device] : []),
      }),
    }),
  } as any);
}

// Capture what the handler writes to devices.activeVpns inside the txn.
function mockTransactionCapture() {
  const captured: { activeVpns?: unknown } = {};
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
    const tx = {
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((row: { activeVpns?: unknown }) => {
          captured.activeVpns = row.activeVpns;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    return fn(tx);
  });
  return captured;
}

function makeApp() {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('agent', { orgId: 'org-1', agentId: 'agent-1', role: 'agent' });
    await next();
  });
  app.route('/agents', inventoryRoutes);
  return app;
}

function putNetwork(app: Hono, body: Record<string, unknown>) {
  return app.request('/agents/agent-1/network', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('agent network inventory — VPN presence ingest (#2139)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists reported VPNs to devices.activeVpns and stamps reportedAt', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const captured = mockTransactionCapture();

    const res = await putNetwork(makeApp(), {
      adapters: [{ interfaceName: 'en0', ipAddress: '192.168.1.10', ipType: 'ipv4', isPrimary: true }],
      vpns: [
        {
          provider: 'tailscale',
          active: true,
          interfaceName: 'utun3',
          ipv4: '100.101.102.103',
          dnsName: 'host.tailnet.ts.net',
          detectionSource: 'interface',
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vpnCount).toBe(1);

    const stored = captured.activeVpns as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      provider: 'tailscale',
      active: true,
      interfaceName: 'utun3',
      ipv4: '100.101.102.103',
      dnsName: 'host.tailnet.ts.net',
      detectionSource: 'interface',
    });
    // reportedAt is stamped by the API, not sent by the agent.
    expect(typeof stored[0].reportedAt).toBe('string');
    expect(Number.isNaN(Date.parse(stored[0].reportedAt as string))).toBe(false);
  });

  it('stores an empty array when an older agent omits vpns', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const captured = mockTransactionCapture();

    const res = await putNetwork(makeApp(), {
      adapters: [{ interfaceName: 'eth0', ipAddress: '10.0.0.5', ipType: 'ipv4' }],
    });

    expect(res.status).toBe(200);
    expect((await res.json()).vpnCount).toBe(0);
    expect(captured.activeVpns).toEqual([]);
  });

  it('rejects an unknown VPN provider (validator)', async () => {
    // zValidator rejects before the handler runs — no db mocks needed, and
    // queuing a device lookup here would leak into the next test.
    const res = await putNetwork(makeApp(), {
      adapters: [],
      vpns: [{ provider: 'nordvpn', active: true, interfaceName: 'utun9', detectionSource: 'interface' }],
    });

    expect(res.status).toBe(400);
  });

  it('returns 404 and does not open a txn when the device is unknown', async () => {
    mockDeviceLookup(null);

    const res = await putNetwork(makeApp(), { adapters: [], vpns: [] });

    expect(res.status).toBe(404);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
