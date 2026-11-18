import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'id',
    agentId: 'agent_id',
    orgId: 'org_id',
  },
  deviceConnections: {
    deviceId: 'device_id',
    protocol: 'protocol',
    localAddr: 'local_addr',
    localPort: 'local_port',
    remoteAddr: 'remote_addr',
    remotePort: 'remote_port',
    state: 'state',
    pid: 'pid',
    processName: 'process_name',
    updatedAt: 'updated_at',
  },
}));

import { db } from '../../db';
import {
  connectionsRoutes,
  CONNECTION_INSERT_CHUNK_SIZE,
  connectionCapLogThrottle,
  maxStoredConnectionsPerDevice,
  selectConnectionsToStore,
} from './connections';

/** Mocks the device lookup + transaction; returns every insert batch. */
function mockKnownDeviceTransaction() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, agentId: AGENT_ID, orgId: 'org-1' }]),
      }),
    }),
  } as any);

  const insertedBatches: any[][] = [];
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
    const tx = {
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((rows: any[]) => {
          insertedBatches.push(rows);
          return Promise.resolve(undefined);
        }),
      }),
    };
    return fn(tx);
  });
  return { insertedBatches };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('connections routes', () => {
  let app: Hono;
  let agentRole: 'agent' | 'watchdog';

  const putConnections = (connections: unknown[]) =>
    app.request(`/agents/${AGENT_ID}/connections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connections }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_CONNECTIONS_MAX_PER_DEVICE;
    agentRole = 'agent';
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', {
        deviceId: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: '11111111-1111-1111-1111-111111111111',
        siteId: '22222222-2222-4222-8222-222222222222',
        role: agentRole,
      } as never);
      await next();
    });
    app.route('/agents', connectionsRoutes);
  });

  // ----------------------------------------------------------------
  // PUT /:id/connections
  // ----------------------------------------------------------------

  describe('PUT /agents/:id/connections', () => {
    it('rejects watchdog credentials before querying or replacing inventory', async () => {
      agentRole = 'watchdog';

      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: [] }),
      });

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('should upsert connections for a known device', async () => {
      // device lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, agentId: AGENT_ID }]),
          }),
        }),
      } as any);

      vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
        const tx = {
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
        };
        return fn(tx);
      });

      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connections: [
            {
              protocol: 'tcp',
              localAddr: '0.0.0.0',
              localPort: 443,
              remoteAddr: '10.0.0.1',
              remotePort: 54321,
              state: 'ESTABLISHED',
              pid: 1234,
              processName: 'nginx',
            },
            {
              protocol: 'udp',
              localAddr: '0.0.0.0',
              localPort: 53,
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(2);
    });

    it('should return 404 when device not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: [] }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Device not found');
    });

    it('should handle empty connections array', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, agentId: AGENT_ID }]),
          }),
        }),
      } as any);

      vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
        const tx = {
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        };
        return fn(tx);
      });

      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: [] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(0);
    });

    it('should validate protocol enum', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connections: [
            {
              protocol: 'invalid',
              localAddr: '0.0.0.0',
              localPort: 80,
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should reject "unknown" protocol (Linux agent must filter before sending)', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connections: [
            {
              protocol: 'unknown',
              localAddr: '0.0.0.0',
              localPort: 80,
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate port range', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connections: [
            {
              protocol: 'tcp',
              localAddr: '0.0.0.0',
              localPort: 70000,
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate localAddr is required', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connections: [
            {
              protocol: 'tcp',
              localPort: 80,
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('truncates oversized state/processName/addr to column widths (#504)', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, agentId: AGENT_ID, orgId: 'org-1' }]),
          }),
        }),
      } as any);

      let insertedValues: any;
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
        const tx = {
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockImplementation((rows: any) => {
              insertedValues = rows;
              return Promise.resolve(undefined);
            }),
          }),
        };
        return fn(tx);
      });

      const longProcessName = 'x'.repeat(500);
      const longState = 'ESTABLISHED_WITH_LINGER_AND_EXTRAS';
      const longAddr = 'fe80::1234:5678:9abc:def0%' + 'a'.repeat(200);

      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connections: [
            {
              protocol: 'tcp',
              localAddr: longAddr,
              localPort: 443,
              remoteAddr: longAddr,
              remotePort: 54321,
              state: longState,
              pid: 1234,
              processName: longProcessName,
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(insertedValues).toHaveLength(1);
      expect(insertedValues[0].state.length).toBeLessThanOrEqual(20);
      expect(insertedValues[0].processName.length).toBeLessThanOrEqual(255);
      expect(insertedValues[0].localAddr.length).toBeLessThanOrEqual(128);
      expect(insertedValues[0].remoteAddr.length).toBeLessThanOrEqual(128);
    });

    it('should accept all valid protocol types', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, agentId: AGENT_ID }]),
          }),
        }),
      } as any);

      vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
        const tx = {
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
        };
        return fn(tx);
      });

      const res = await app.request(`/agents/${AGENT_ID}/connections`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connections: [
            { protocol: 'tcp', localAddr: '0.0.0.0', localPort: 80 },
            { protocol: 'tcp6', localAddr: '::', localPort: 443 },
            { protocol: 'udp', localAddr: '0.0.0.0', localPort: 53 },
            { protocol: 'udp6', localAddr: '::', localPort: 53 },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(4);
    });

    it('chunks large inserts into bounded statements (#1696, #10859)', async () => {
      // Raise the per-device cap to the schema max so this test exercises the
      // chunking alone; the cap has its own tests below.
      process.env.AGENT_CONNECTIONS_MAX_PER_DEVICE = '10000';
      const { insertedBatches } = mockKnownDeviceTransaction();

      // 11 columns/row × 10,000 rows = 110,000 bind params — far over the
      // 65534 limit if sent as one statement. The schema cap is 10,000.
      const COUNT = 10000;
      const connections = Array.from({ length: COUNT }, (_, i) => ({
        protocol: 'tcp',
        localAddr: '0.0.0.0',
        localPort: (i % 65535),
      }));

      const res = await putConnections(connections);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(COUNT);

      // #10859 — no statement may exceed 500 rows (× 11 cols = 5,500 params).
      // The old 5,000-row chunk built 55k-param statements whose query
      // building blocked the event loop for over a second.
      expect(CONNECTION_INSERT_CHUNK_SIZE).toBe(500);
      for (const batch of insertedBatches) {
        expect(batch.length).toBeLessThanOrEqual(500);
      }
      expect(insertedBatches).toHaveLength(COUNT / 500);
      // Concatenated batches must equal the original rows IN ORDER — guards
      // against a chunk() off-by-one that drops/duplicates a specific row while
      // keeping the total count correct (localPort is the unique per-row marker).
      const flatPorts = insertedBatches.flat().map((r: { localPort: number }) => r.localPort);
      expect(flatPorts).toEqual(connections.map((c) => c.localPort));
    });
  });

  // ----------------------------------------------------------------
  // #10859 — per-device cap with deterministic priority
  // ----------------------------------------------------------------

  describe('PUT /agents/:id/connections per-device cap (#10859)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      connectionCapLogThrottle.reset();
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('defaults the cap to 2000 connections per device and honours the env override', () => {
      delete process.env.AGENT_CONNECTIONS_MAX_PER_DEVICE;
      expect(maxStoredConnectionsPerDevice()).toBe(2000);
      process.env.AGENT_CONNECTIONS_MAX_PER_DEVICE = '750';
      expect(maxStoredConnectionsPerDevice()).toBe(750);
      // Zero, negative and garbage fall back to the default rather than
      // disabling the cap or storing nothing.
      for (const bad of ['0', '-5', 'lots', '']) {
        process.env.AGENT_CONNECTIONS_MAX_PER_DEVICE = bad;
        expect(maxStoredConnectionsPerDevice()).toBe(2000);
      }
    });

    it('stores every row, in agent order, and does not warn when under the cap', async () => {
      process.env.AGENT_CONNECTIONS_MAX_PER_DEVICE = '5';
      const { insertedBatches } = mockKnownDeviceTransaction();
      const connections = [
        { protocol: 'tcp', localAddr: '0.0.0.0', localPort: 9, state: 'TIME_WAIT' },
        { protocol: 'tcp', localAddr: '0.0.0.0', localPort: 1, state: 'LISTEN' },
      ];

      const res = await putConnections(connections);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, count: 2, received: 2, truncated: false });
      expect(insertedBatches.flat().map((r: { localPort: number }) => r.localPort)).toEqual([9, 1]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('keeps listeners, then established, then UDP, then the rest — and logs the cap', async () => {
      process.env.AGENT_CONNECTIONS_MAX_PER_DEVICE = '4';
      const { insertedBatches } = mockKnownDeviceTransaction();
      // Agent order deliberately puts the noise first.
      const connections = [
        { protocol: 'tcp', localAddr: '10.0.0.5', localPort: 50001, remoteAddr: '10.0.0.9', remotePort: 443, state: 'TIME_WAIT' },
        { protocol: 'tcp', localAddr: '10.0.0.5', localPort: 50002, remoteAddr: '10.0.0.9', remotePort: 443, state: 'CLOSE_WAIT' },
        { protocol: 'udp', localAddr: '0.0.0.0', localPort: 53 },
        { protocol: 'tcp', localAddr: '10.0.0.5', localPort: 50003, remoteAddr: '10.0.0.9', remotePort: 443, state: 'ESTABLISHED' },
        { protocol: 'tcp6', localAddr: '::', localPort: 445, state: 'LISTEN' },
        { protocol: 'tcp', localAddr: '0.0.0.0', localPort: 389, state: 'LISTENING' },
      ];

      const res = await putConnections(connections);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, count: 4, received: 6, truncated: true });
      expect(insertedBatches.flat().map((r: { localPort: number }) => r.localPort)).toEqual([389, 445, 50003, 53]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain('capped');
      expect(warnSpy.mock.calls[0]![1]).toMatchObject({ deviceId: DEVICE_ID, received: 6, stored: 4, max: 4 });

      // The same device's next capped report is still capped and flagged, but
      // not logged again within the hour.
      mockKnownDeviceTransaction();
      const again = await putConnections(connections);
      expect(await again.json()).toMatchObject({ count: 4, truncated: true });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('selects the same rows whatever order the agent reports them in', () => {
      const connections = Array.from({ length: 40 }, (_, i) => ({
        protocol: (i % 3 === 0 ? 'udp' : 'tcp') as 'tcp' | 'udp',
        localAddr: '10.0.0.5',
        localPort: 1000 + i,
        remoteAddr: i % 3 === 0 ? undefined : '10.0.0.9',
        remotePort: i % 3 === 0 ? undefined : 443,
        state: ['LISTEN', 'ESTABLISHED', 'TIME_WAIT', 'SYN_SENT'][i % 4],
      }));
      const reversed = [...connections].reverse();
      const pick = (rows: typeof connections) => selectConnectionsToStore(rows, 15).map((c) => c.localPort);

      expect(pick(connections)).toHaveLength(15);
      expect(pick(reversed)).toEqual(pick(connections));
    });

    it('caps a 10,000-row report at the default and still writes it in bounded chunks', async () => {
      delete process.env.AGENT_CONNECTIONS_MAX_PER_DEVICE;
      const { insertedBatches } = mockKnownDeviceTransaction();
      const connections = Array.from({ length: 10000 }, (_, i) => ({
        protocol: 'tcp',
        localAddr: '10.0.0.5',
        localPort: i % 65535,
        remoteAddr: '10.0.0.9',
        remotePort: 443,
        state: i % 10 === 0 ? 'ESTABLISHED' : 'TIME_WAIT',
      }));

      const res = await putConnections(connections);

      expect(res.status).toBe(200);
      const stored = insertedBatches.flat();
      expect(stored).toHaveLength(2000);
      for (const batch of insertedBatches) {
        expect(batch.length).toBeLessThanOrEqual(500);
      }
      // All 1,000 established connections survive the cap.
      expect(stored.filter((r: { state: string }) => r.state === 'ESTABLISHED')).toHaveLength(1000);
    });
  });

  // ----------------------------------------------------------------
  // Multi-tenant isolation
  // ----------------------------------------------------------------

  describe('multi-tenant isolation', () => {
    it('returns 404 when agent ID belongs to a different org (no device match)', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/agents/agent-cross-org/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connections: [
            { protocol: 'tcp', localAddr: '0.0.0.0', localPort: 443 },
          ],
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Device not found');
    });
  });
});
