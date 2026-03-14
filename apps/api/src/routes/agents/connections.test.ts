import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import { connectionsRoutes } from './connections';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('connections routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/agents', connectionsRoutes);
  });

  // ----------------------------------------------------------------
  // PUT /:id/connections
  // ----------------------------------------------------------------

  describe('PUT /agents/:id/connections', () => {
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
  });
});
