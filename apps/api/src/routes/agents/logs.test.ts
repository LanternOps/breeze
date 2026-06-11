import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
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
  agentLogs: {
    deviceId: 'device_id',
    orgId: 'org_id',
    timestamp: 'timestamp',
    level: 'level',
    component: 'component',
    message: 'message',
    fields: 'fields',
    agentVersion: 'agent_version',
  },
}));

import { db } from '../../db';
import { logsRoutes } from './logs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDeviceLookup(found: boolean) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi
          .fn()
          .mockResolvedValue(
            found ? [{ id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID }] : []
          ),
      }),
    }),
  } as any);
}

function mockInsertSuccess() {
  const values = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValue({
    values,
  } as any);
  return values;
}

function makeLogEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    timestamp: '2026-05-01T00:00:00.000Z',
    level: 'info',
    component: 'test',
    message: 'hello',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent logs routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/agents', logsRoutes);
  });

  describe('POST /agents/:id/logs — batch size limit', () => {
    it('accepts a batch with exactly 200 entries (at the cap)', async () => {
      mockDeviceLookup(true);
      mockInsertSuccess();

      const logs = Array.from({ length: 200 }, () => makeLogEntry());
      const res = await app.request(`/agents/${AGENT_ID}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.received).toBe(200);
    });

    it('rejects a batch with 250 entries (over the 200 cap)', async () => {
      // No device lookup — request should be rejected by Zod before DB.
      const logs = Array.from({ length: 250 }, () => makeLogEntry());
      const res = await app.request(`/agents/${AGENT_ID}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/invalid request body/i);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('POST /agents/:id/logs — body size limit', () => {
    it('rejects payloads larger than 256 KB with 413', async () => {
      // Build a payload that's >256KB on the wire. Three entries × ~100KB
      // message each = ~300KB JSON total.
      const bigMessage = 'x'.repeat(100 * 1024);
      const logs = Array.from({ length: 3 }, () =>
        makeLogEntry({ message: bigMessage })
      );

      const res = await app.request(`/agents/${AGENT_ID}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs }),
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toMatch(/too large/i);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('accepts payloads under 256 KB', async () => {
      mockDeviceLookup(true);
      mockInsertSuccess();

      // ~45KB total — well under the 256KB cap. Each message stays under
      // the per-entry 10000-char Zod limit.
      const logs = Array.from({ length: 5 }, () =>
        makeLogEntry({ message: 'a'.repeat(9 * 1024) })
      );

      const res = await app.request(`/agents/${AGENT_ID}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs }),
      });

      expect(res.status).toBe(201);
    });

    it('redacts secrets before storing log rows', async () => {
      mockDeviceLookup(true);
      const values = mockInsertSuccess();

      const res = await app.request(`/agents/${AGENT_ID}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logs: [
            makeLogEntry({
              message: 'install failed token=raw-token password=hunter2',
              fields: {
                apiKey: 'raw-api-key',
                nested: { authPassword: 'raw-auth-password' },
                output: 'Authorization: Bearer raw-bearer-token',
              },
            }),
          ],
        }),
      });

      expect(res.status).toBe(201);
      expect(values).toHaveBeenCalledWith([
        expect.objectContaining({
          message: 'install failed token=[REDACTED] password=[REDACTED]',
          fields: {
            apiKey: '[REDACTED]',
            nested: { authPassword: '[REDACTED]' },
            output: 'Authorization: Bearer [REDACTED]',
          },
        }),
      ]);
    });
  });
});
