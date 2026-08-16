import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Active-VPN-client presence ingest via PUT /:id/network (#2139). Verifies the
// handler stamps reportedAt server-side and persists the snapshot to
// devices.activeVpns, that old agents (no `vpns`) store an empty array, and
// that a malformed VPN entry is SALVAGED per-entry — dropped without rejecting
// the whole payload (which used to discard the valid adapter inventory, #3550).

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
// `updateCalled` distinguishes "wrote []" from "never touched the column".
function mockTransactionCapture() {
  const captured: { activeVpns?: unknown; inserted?: unknown[]; updateCalled: boolean } = {
    updateCalled: false,
  };
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
    const tx = {
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((rows: unknown[]) => {
          captured.inserted = rows;
          return Promise.resolve(undefined);
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((row: { activeVpns?: unknown }) => {
          captured.updateCalled = true;
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
    const [entry] = stored;
    expect(entry).toMatchObject({
      provider: 'tailscale',
      active: true,
      interfaceName: 'utun3',
      ipv4: '100.101.102.103',
      dnsName: 'host.tailnet.ts.net',
      detectionSource: 'interface',
    });
    // reportedAt is stamped by the API, not sent by the agent.
    expect(typeof entry!.reportedAt).toBe('string');
    expect(Number.isNaN(Date.parse(entry!.reportedAt as string))).toBe(false);
  });

  it('leaves activeVpns untouched (preserving last-known) when an older agent omits vpns', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const captured = mockTransactionCapture();

    const res = await putNetwork(makeApp(), {
      adapters: [{ interfaceName: 'eth0', ipAddress: '10.0.0.5', ipType: 'ipv4' }],
    });

    expect(res.status).toBe(200);
    // Omitted key -> no clobber, and no devices update at all.
    expect((await res.json()).vpnCount).toBeNull();
    expect(captured.updateCalled).toBe(false);
  });

  it('stores an empty array when the agent reports zero active VPNs', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const captured = mockTransactionCapture();

    const res = await putNetwork(makeApp(), {
      adapters: [{ interfaceName: 'eth0', ipAddress: '10.0.0.5', ipType: 'ipv4' }],
      vpns: [],
    });

    expect(res.status).toBe(200);
    // Explicit [] -> "collected, no active VPN": the column IS written to [].
    expect((await res.json()).vpnCount).toBe(0);
    expect(captured.updateCalled).toBe(true);
    expect(captured.activeVpns).toEqual([]);
  });

  it('persists both an active and an inactive VPN entry, stamping reportedAt on each', async () => {
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
          detectionSource: 'interface',
        },
        {
          provider: 'netbird',
          active: false,
          interfaceName: '',
          detectionSource: 'service',
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vpnCount).toBe(2);

    const stored = captured.activeVpns as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(2);
    const [active, inactive] = stored;
    expect(active).toMatchObject({ provider: 'tailscale', active: true, interfaceName: 'utun3' });
    expect(inactive).toMatchObject({ provider: 'netbird', active: false, interfaceName: '' });
    // Both entries are stamped by the API, regardless of active/inactive.
    expect(typeof active!.reportedAt).toBe('string');
    expect(Number.isNaN(Date.parse(active!.reportedAt as string))).toBe(false);
    expect(typeof inactive!.reportedAt).toBe('string');
    expect(Number.isNaN(Date.parse(inactive!.reportedAt as string))).toBe(false);
  });

  it('salvages a mixed payload: drops a malformed VPN but keeps the valid VPN and the adapters (#3550)', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const captured = mockTransactionCapture();

    const res = await putNetwork(makeApp(), {
      adapters: [{ interfaceName: 'en0', ipAddress: '10.0.0.5', ipType: 'ipv4', isPrimary: true }],
      vpns: [
        { provider: 'tailscale', active: true, interfaceName: 'utun3', ipv4: '100.1.2.3', detectionSource: 'interface' },
        // Malformed: an active VPN with no interfaceName.
        { provider: 'tailscale', active: true, interfaceName: '', detectionSource: 'interface' },
      ],
    });

    // The whole payload is no longer rejected — the valid adapter is persisted...
    expect(res.status).toBe(200);
    expect(captured.inserted).toHaveLength(1);
    // ...and only the well-formed VPN survives.
    const stored = captured.activeVpns as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ provider: 'tailscale', interfaceName: 'utun3' });
    const body = await res.json();
    expect(body.vpnCount).toBe(1);
    // The response reports how many entries were dropped (#3550 observability).
    expect(body.droppedVpnCount).toBe(1);
  });

  it('salvages an unknown-provider VPN: adapters persist and the bad entry is dropped (#3550)', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1' });
    const captured = mockTransactionCapture();

    const res = await putNetwork(makeApp(), {
      adapters: [{ interfaceName: 'eth0', ipAddress: '192.168.1.20', ipType: 'ipv4', isPrimary: true }],
      vpns: [{ provider: 'nordvpn', active: true, interfaceName: 'utun9', detectionSource: 'interface' }],
    });

    expect(res.status).toBe(200);
    expect(captured.inserted).toHaveLength(1);
    // Every provided VPN was malformed, so the snapshot is left UNTOUCHED rather
    // than overwritten to "no VPN" (avoids clobbering a live tunnel). The handler
    // signals this by not calling update on activeVpns.
    expect(captured.updateCalled).toBe(false);
  });

  it('returns 404 and does not open a txn when the device is unknown', async () => {
    mockDeviceLookup(null);

    const res = await putNetwork(makeApp(), { adapters: [], vpns: [] });

    expect(res.status).toBe(404);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
