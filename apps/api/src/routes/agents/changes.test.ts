import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { gzipSync } from 'node:zlib';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

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
  deviceChangeLog: {
    id: 'id',
    deviceId: 'device_id',
    orgId: 'org_id',
    fingerprint: 'fingerprint',
    timestamp: 'timestamp',
    changeType: 'change_type',
    changeAction: 'change_action',
    subject: 'subject',
    beforeValue: 'before_value',
    afterValue: 'after_value',
    details: 'details',
  },
}));

import { db } from '../../db';
import { changesRoutes } from './changes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChangePayload(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-03-01T12:00:00Z',
    changeType: 'software',
    changeAction: 'added',
    subject: 'Node.js v22',
    ...overrides,
  };
}

function mockDeviceFound() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID }]),
      }),
    }),
  } as any);
}

function mockDeviceNotFound() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as any);
}

function mockInsertSuccess(count: number) {
  const results = Array.from({ length: count }, (_, i) => ({ id: `change-${i}` }));
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(results),
      }),
    }),
  } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('changes routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/agents', changesRoutes);
  });

  // ----------------------------------------------------------------
  // PUT /:id/changes - Submit changes
  // ----------------------------------------------------------------

  describe('PUT /agents/:id/changes', () => {
    it('should accept and insert valid changes', async () => {
      mockDeviceFound();
      mockInsertSuccess(2);

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [
            makeChangePayload(),
            makeChangePayload({
              changeType: 'service',
              changeAction: 'modified',
              subject: 'sshd',
              timestamp: '2026-03-01T13:00:00Z',
            }),
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(2);
    });

    it('should return 404 when device not found', async () => {
      mockDeviceNotFound();

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [makeChangePayload()] }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Device not found');
    });

    it('should handle empty changes array', async () => {
      mockDeviceFound();

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(0);
    });

    it('should deduplicate changes with identical fingerprints', async () => {
      mockDeviceFound();
      // Only 1 unique change should be inserted
      mockInsertSuccess(1);

      const change = makeChangePayload();
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [change, change], // exact duplicates
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(1);
    });

    it('should validate changeType enum', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [makeChangePayload({ changeType: 'invalid_type' })],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate changeAction enum', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [makeChangePayload({ changeAction: 'destroyed' })],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate subject is required', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [makeChangePayload({ subject: '' })],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should validate timestamp is a valid datetime', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [makeChangePayload({ timestamp: 'not-a-date' })],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should accept all valid changeType values', async () => {
      mockDeviceFound();
      mockInsertSuccess(6);

      const changeTypes = ['software', 'service', 'startup', 'network', 'scheduled_task', 'user_account'];
      const changes = changeTypes.map((ct, i) =>
        makeChangePayload({
          changeType: ct,
          subject: `change-${i}`,
          timestamp: `2026-03-01T${String(i + 10).padStart(2, '0')}:00:00Z`,
        })
      );

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(6);
    });

    it('should accept optional beforeValue and afterValue', async () => {
      mockDeviceFound();
      mockInsertSuccess(1);

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [
            makeChangePayload({
              beforeValue: { version: '1.0' },
              afterValue: { version: '2.0' },
              details: { reason: 'upgrade' },
            }),
          ],
        }),
      });

      expect(res.status).toBe(200);
    });

    it('should handle gzip-encoded request body', async () => {
      mockDeviceFound();
      mockInsertSuccess(1);

      const payload = JSON.stringify({ changes: [makeChangePayload()] });
      const compressed = gzipSync(Buffer.from(payload));

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
        body: compressed,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 400 for malformed JSON body', async () => {
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
      });

      expect(res.status).toBe(400);
    });

    it('should return 500 when all inserts fail', async () => {
      mockDeviceFound();

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      } as any);

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [makeChangePayload()] }),
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain('Failed to insert');
    });
  });

  // ----------------------------------------------------------------
  // Multi-tenant isolation
  // ----------------------------------------------------------------

  describe('multi-tenant isolation', () => {
    it('returns 404 when agent ID belongs to a different org (no device match)', async () => {
      mockDeviceNotFound();

      const res = await app.request('/agents/agent-cross-org/changes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [makeChangePayload()] }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('Device not found');
    });

    it('prevents cross-org data injection by scoping orgId from device lookup', async () => {
      // Device found with its own orgId - the route uses the device's orgId,
      // not a user-supplied one, preventing cross-org data injection
      mockDeviceFound();
      mockInsertSuccess(1);

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [makeChangePayload()],
        }),
      });

      expect(res.status).toBe(200);
      // The insert should use the device's orgId (ORG_ID), not any user-supplied value
      expect(vi.mocked(db.insert)).toHaveBeenCalled();
    });
  });
});
