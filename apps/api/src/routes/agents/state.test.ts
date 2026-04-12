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
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'id',
    agentId: 'agent_id',
  },
  deviceRegistryState: {
    deviceId: 'device_id',
    registryPath: 'registry_path',
    valueName: 'value_name',
    valueData: 'value_data',
    valueType: 'value_type',
    collectedAt: 'collected_at',
    updatedAt: 'updated_at',
  },
  deviceConfigState: {
    deviceId: 'device_id',
    filePath: 'file_path',
    configKey: 'config_key',
    configValue: 'config_value',
    collectedAt: 'collected_at',
    updatedAt: 'updated_at',
  },
}));

vi.mock('./helpers', () => ({
  normalizeStateValue: vi.fn((v: any) => (v === undefined ? null : String(v))),
  parseDate: vi.fn((d: any) => (d ? new Date(d) : null)),
}));

import { db } from '../../db';
import { stateRoutes } from './state';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('state routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/agents', stateRoutes);
  });

  // ----------------------------------------------------------------
  // PUT /:id/registry-state
  // ----------------------------------------------------------------

  describe('PUT /agents/:id/registry-state', () => {
    it('should upsert registry state entries for a known device', async () => {
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
            values: vi.fn().mockReturnValue({
              onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return fn(tx);
      });

      const res = await app.request(`/agents/${AGENT_ID}/registry-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              registryPath: 'HKLM\\SOFTWARE\\Test',
              valueName: 'Version',
              valueData: '1.0.0',
              valueType: 'REG_SZ',
            },
          ],
          replace: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(1);
    });

    it('should return 404 when device not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/agents/${AGENT_ID}/registry-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [],
          replace: false,
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Device not found');
    });

    it('should handle empty entries with replace=true (clears all)', async () => {
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

      const res = await app.request(`/agents/${AGENT_ID}/registry-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [],
          replace: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(0);
    });

    it('should validate registryPath is required', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/registry-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              valueName: 'Version',
              valueData: '1.0.0',
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate valueName is required', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/registry-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              registryPath: 'HKLM\\SOFTWARE\\Test',
              valueData: '1.0.0',
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should accept multiple value types for valueData', async () => {
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
            values: vi.fn().mockReturnValue({
              onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return fn(tx);
      });

      const res = await app.request(`/agents/${AGENT_ID}/registry-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            { registryPath: 'HKLM\\A', valueName: 'str', valueData: 'hello' },
            { registryPath: 'HKLM\\B', valueName: 'num', valueData: 42 },
            { registryPath: 'HKLM\\C', valueName: 'bool', valueData: true },
            { registryPath: 'HKLM\\D', valueName: 'nil', valueData: null },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(4);
    });
  });

  // ----------------------------------------------------------------
  // PUT /:id/config-state
  // ----------------------------------------------------------------

  describe('PUT /agents/:id/config-state', () => {
    it('should upsert config state entries for a known device', async () => {
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
            values: vi.fn().mockReturnValue({
              onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return fn(tx);
      });

      const res = await app.request(`/agents/${AGENT_ID}/config-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              filePath: '/etc/ssh/sshd_config',
              configKey: 'PermitRootLogin',
              configValue: 'no',
            },
          ],
          replace: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(1);
    });

    it('should return 404 when device not found', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/agents/${AGENT_ID}/config-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [],
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Device not found');
    });

    it('should validate filePath is required', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/config-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              configKey: 'SomeKey',
              configValue: 'SomeValue',
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate configKey is required', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/config-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              filePath: '/etc/config',
              configValue: 'SomeValue',
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should handle empty entries without replace', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, agentId: AGENT_ID }]),
          }),
        }),
      } as any);

      vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
        const tx = {};
        return fn(tx);
      });

      const res = await app.request(`/agents/${AGENT_ID}/config-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [],
          replace: false,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(0);
    });

    it('should accept numeric and boolean config values', async () => {
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
            values: vi.fn().mockReturnValue({
              onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return fn(tx);
      });

      const res = await app.request(`/agents/${AGENT_ID}/config-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            { filePath: '/etc/a', configKey: 'port', configValue: 8080 },
            { filePath: '/etc/b', configKey: 'debug', configValue: false },
            { filePath: '/etc/c', configKey: 'nil', configValue: null },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(3);
    });
  });

  // ----------------------------------------------------------------
  // Multi-tenant isolation
  // ----------------------------------------------------------------

  describe('multi-tenant isolation', () => {
    it('returns 404 for registry-state when agent ID does not match any device', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/agents/agent-other-org/registry-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [{ registryPath: 'HKLM\\Test', valueName: 'V', valueData: '1' }],
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Device not found');
    });

    it('returns 404 for config-state when agent ID does not match any device', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request('/agents/agent-other-org/config-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [{ filePath: '/etc/test', configKey: 'key', configValue: 'val' }],
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Device not found');
    });
  });
});
