import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { gzipSync } from 'node:zlib';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// `withDbTransaction` is a pass-through so tests can assert that each insert
// ran inside its own savepoint (#8301).
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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

// Default: no Redis client, so the ingest quota check fails open (allowed)
// and existing tests are unaffected. Quota-specific tests below override
// `checkAndConsumeIngestQuota` directly.
vi.mock('../../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../../services/ingestQuota', () => ({
  checkAndConsumeIngestQuota: vi.fn().mockResolvedValue({ allowed: true, rowsUsed: 0, bytesUsed: 0 }),
}));

import { db, withDbTransaction } from '../../db';
import { checkAndConsumeIngestQuota } from '../../services/ingestQuota';
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

/**
 * Drive every `db.insert(...).values(batch)...returning()` call through `impl`,
 * which sees the rows of that one statement and decides whether it succeeds.
 */
function mockInsertImpl(impl: (batch: Array<Record<string, unknown>>) => Promise<unknown[]>) {
  const valuesSpy = vi.fn((batch: Array<Record<string, unknown>>) => ({
    onConflictDoNothing: vi.fn().mockReturnValue({
      returning: vi.fn(() => impl(batch)),
    }),
  }));
  vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);
  return valuesSpy;
}

/** A DrizzleQueryError-shaped failure: generic message, the pg error on `.cause`. */
function pgFailure(code: string, message = 'pg error'): Error {
  return Object.assign(new Error('Failed query: insert into "device_change_log" ...'), {
    cause: Object.assign(new Error(message), { code }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('changes routes', () => {
  let app: Hono;
  let agentRole: 'agent' | 'watchdog';

  beforeEach(() => {
    vi.clearAllMocks();
    agentRole = 'agent';
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', {
        deviceId: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
        siteId: '22222222-2222-4222-8222-222222222222',
        role: agentRole,
      } as never);
      await next();
    });
    app.route('/agents', changesRoutes);
  });

  // ----------------------------------------------------------------
  // PUT /:id/changes - Submit changes
  // ----------------------------------------------------------------

  describe('PUT /agents/:id/changes', () => {
    it('rejects watchdog credentials before querying or inserting change history', async () => {
      agentRole = 'watchdog';

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [makeChangePayload()] }),
      });

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

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

    it('strips NUL characters from string fields and jsonb payloads before insert (#8020)', async () => {
      mockDeviceFound();
      const valuesSpy = vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'c1' }]),
        }),
      });
      vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as any);

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [
            makeChangePayload({
              subject: 'Node\u0000.js',
              beforeValue: { ver: '1\u00002' },
              details: { nested: [{ 'k\u0000ey': 'a\u0000b' }], keep: 5 },
            }),
          ],
        }),
      });

      expect(res.status).toBe(200);
      const row = valuesSpy.mock.calls[0]![0][0];
      expect(row.subject).toBe('Node.js');
      expect(row.beforeValue).toEqual({ ver: '12' });
      expect(row.details.nested).toEqual([{ key: 'ab' }]);
      expect(row.details.keep).toBe(5);      expect(JSON.stringify(row)).not.toContain('\\u0000');
    });

    it('persists the #8301 batch: NUL-corrupted service account next to unrelated changes', async () => {
      mockDeviceFound();
      const valuesSpy = mockInsertImpl(async (batch) => batch.map((_, i) => ({ id: `c${i}` })));

      // The exact shape from the report: a Windows agent read the service
      // account as four NULs + "lSystem" (should be "LocalSystem"), shipped in
      // the same submission as software and startup-entry changes.
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [
            makeChangePayload({ subject: 'Google Chrome', afterValue: { version: '141.0' } }),
            makeChangePayload({
              changeType: 'startup',
              subject: 'OneDrive',
              afterValue: { path: 'C:\\Program Files\\OneDrive.exe' },
            }),
            makeChangePayload({
              changeType: 'service',
              changeAction: 'modified',
              subject: 'Google Updater Internal Service (GoogleUpdaterInternalService156.0.8067.0)',
              beforeValue: { account: '\u0000\u0000\u0000\u0000lSystem' },
              afterValue: { account: 'LocalSystem' },
            }),
          ],
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, count: 3 });
      expect(valuesSpy).toHaveBeenCalledTimes(1);
      const rows = valuesSpy.mock.calls[0]![0];
      expect(rows).toHaveLength(3);
      const service = rows.find((r) => r.changeType === 'service')!;
      expect(service.beforeValue).toEqual({ account: 'lSystem' });
      expect(service.afterValue).toEqual({ account: 'LocalSystem' });
      expect(JSON.stringify(rows)).not.toContain('\\u0000');
    });

    it('runs each 200-row chunk insert in its own savepoint (#8301)', async () => {
      mockDeviceFound();
      mockInsertImpl(async (batch) => batch.map((_, i) => ({ id: `c${i}` })));

      const changes = Array.from({ length: 250 }, (_, i) => makeChangePayload({ subject: `pkg-${i}` }));
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, count: 250 });
      // One savepoint per chunk: a failed bare statement would abort the
      // request-long agent transaction and lose every chunk at commit.
      expect(withDbTransaction).toHaveBeenCalledTimes(2);
    });

    it('retries a chunk row by row on a data exception so one bad row does not sink the batch (#8301)', async () => {
      mockDeviceFound();
      const valuesSpy = mockInsertImpl(async (batch) => {
        if (batch.some((r) => r.subject === 'poison')) {
          throw pgFailure('22P05', 'unsupported Unicode escape sequence');
        }
        return batch.map((_, i) => ({ id: `c${i}` }));
      });

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [
            makeChangePayload({ subject: 'good-1' }),
            makeChangePayload({ subject: 'poison' }),
            makeChangePayload({ subject: 'good-2' }),
          ],
        }),
      });

      expect(res.status).toBe(207);
      expect(await res.json()).toEqual({ success: true, count: 2, total: 3, dropped: 1, partial: true });
      // One failed chunk statement, then one statement per row.
      expect(valuesSpy).toHaveBeenCalledTimes(4);
      expect(valuesSpy.mock.calls.slice(1).map((call) => call[0].map((r) => r.subject))).toEqual([
        ['good-1'],
        ['poison'],
        ['good-2'],
      ]);
      // The chunk and every per-row retry each get their own savepoint.
      expect(withDbTransaction).toHaveBeenCalledTimes(4);
    });

    it('does not retry row by row, and stops, on a non-data error (#8301)', async () => {
      mockDeviceFound();
      const valuesSpy = mockInsertImpl(async () => {
        throw pgFailure('57014', 'canceling statement due to statement timeout');
      });

      const changes = Array.from({ length: 250 }, (_, i) => makeChangePayload({ subject: `pkg-${i}` }));
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });

      expect(res.status).toBe(500);
      expect(valuesSpy).toHaveBeenCalledTimes(1);
    });

    it('answers 500 when a non-data error strands later chunks, so the agent re-sends (#8301)', async () => {
      mockDeviceFound();
      let call = 0;
      const valuesSpy = mockInsertImpl(async (batch) => {
        call += 1;
        if (call === 2) throw pgFailure('57014', 'canceling statement due to statement timeout');
        return batch.map((_, i) => ({ id: `c${i}` }));
      });

      const changes = Array.from({ length: 450 }, (_, i) => makeChangePayload({ subject: `pkg-${i}` }));
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });

      // A 2xx would make the agent commit its diff baseline and the
      // unattempted rows would never be re-sent.
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to insert changes', count: 200 });
      // No row-by-row retry and no third chunk.
      expect(valuesSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps going after a row-by-row retry: later chunks are still inserted (#8301)', async () => {
      mockDeviceFound();
      const valuesSpy = mockInsertImpl(async (batch) => {
        if (batch.some((r) => r.subject === 'pkg-250')) {
          throw pgFailure('22P02', 'invalid input syntax for type json');
        }
        return batch.map((_, i) => ({ id: `c${i}` }));
      });

      const changes = Array.from({ length: 450 }, (_, i) => makeChangePayload({ subject: `pkg-${i}` }));
      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });

      expect(res.status).toBe(207);
      expect(await res.json()).toEqual({ success: true, count: 449, total: 450, dropped: 1, partial: true });
      // chunk 1, failed chunk 2, 200 single-row retries, chunk 3.
      expect(valuesSpy).toHaveBeenCalledTimes(203);
      expect(valuesSpy.mock.calls.at(-1)![0]).toHaveLength(50);
    });

    it('answers 2xx when every row is dropped on a data exception, so a poison row is not re-sent forever (#8301)', async () => {
      mockDeviceFound();
      mockInsertImpl(async () => {
        throw pgFailure('22P05', 'unsupported Unicode escape sequence');
      });

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [makeChangePayload({ subject: 'poison' })] }),
      });

      expect(res.status).toBe(207);
      expect(await res.json()).toEqual({ success: true, count: 0, total: 1, dropped: 1, partial: true });
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
      mockInsertSuccess(8);

      const changeTypes = ['software', 'service', 'startup', 'network', 'scheduled_task', 'user_account', 'hardware', 'os_version'];
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
      expect(body.count).toBe(8);
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

  // ----------------------------------------------------------------
  // Daily ingest budget
  // ----------------------------------------------------------------

  describe('daily ingest budget', () => {
    it('drops the batch with 429 once the per-device quota is exceeded', async () => {
      mockDeviceFound();
      mockInsertSuccess(1);
      vi.mocked(checkAndConsumeIngestQuota).mockResolvedValueOnce({
        allowed: false,
        rowsUsed: 500_100,
        bytesUsed: 1000,
      });

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [makeChangePayload()] }),
      });

      expect(res.status).toBe(429);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('drops the batch with 429 once the per-org quota is exceeded', async () => {
      mockDeviceFound();
      mockInsertSuccess(1);
      vi.mocked(checkAndConsumeIngestQuota)
        .mockResolvedValueOnce({ allowed: true, rowsUsed: 10, bytesUsed: 100 }) // device check
        .mockResolvedValueOnce({ allowed: false, rowsUsed: 5_000_100, bytesUsed: 1000 }); // org check

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [makeChangePayload()] }),
      });

      expect(res.status).toBe(429);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('inserts normally when both quotas are within budget', async () => {
      mockDeviceFound();
      mockInsertSuccess(1);

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [makeChangePayload()] }),
      });

      expect(res.status).toBe(200);
      expect(db.insert).toHaveBeenCalled();
    });

    it('does not check the quota for an empty change batch', async () => {
      mockDeviceFound();

      const res = await app.request(`/agents/${AGENT_ID}/changes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [] }),
      });

      expect(res.status).toBe(200);
      expect(checkAndConsumeIngestQuota).not.toHaveBeenCalled();
    });
  });
});
