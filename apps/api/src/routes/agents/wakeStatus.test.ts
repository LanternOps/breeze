import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const m = vi.hoisted(() => ({ ingest: vi.fn(), rows: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => m.rows }) }),
    }),
  },
}));
vi.mock('../../services/wakeStatusIngest', () => ({
  ingestWakeStatusSnapshot: m.ingest,
}));
import { wakeStatusRoutes } from './wakeStatus';

const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const snapshot = () => ({
  readinessState: 'unproven',
  reasonCodes: ['firmware_adapter_unavailable'],
  vendor: 'dell',
  fingerprint: 'a'.repeat(64),
  collectedAt: '2026-11-15T10:00:00Z',
  lastApplyAt: null,
  lastApplyResult: null,
  lastWiredAdapterSeenAt: '2026-11-15T09:59:00Z',
  details: { os: 'windows', adapters: [] },
});
function request(body: unknown = snapshot(), role = 'agent', path = 'agent-1') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (role === 'missing') return c.json({ error: 'Unauthorized' }, 401);
    c.set('agent', { role, deviceId, orgId, agentId: 'agent-1' } as any);
    await next();
  });
  app.route('/', wakeStatusRoutes);
  return app.request(`/${path}/wake-status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  m.rows = [{ agentVersion: '0.130.0' }];
  m.ingest.mockReset().mockResolvedValue({ accepted: true });
});
it('uses authenticated ids and the stored agent version', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true });
  expect(m.ingest).toHaveBeenCalledWith({
    deviceId, orgId, agentVersion: '0.130.0', snapshot: snapshot(), receivedAt: expect.any(Date),
  });
});
it.each([['missing', 401], ['watchdog', 403], ['helper', 403]])('rejects %s credentials', async (role, status) => {
  expect((await request(snapshot(), role)).status).toBe(status);
  expect(m.ingest).not.toHaveBeenCalled();
});
it('returns 403 on agent id mismatch before ingesting', async () => {
  expect((await request(snapshot(), 'agent', 'agent-2')).status).toBe(403);
  expect(m.ingest).not.toHaveBeenCalled();
});
it('returns 404 when the device row is gone', async () => {
  m.rows = [];
  expect((await request()).status).toBe(404);
  expect(m.ingest).not.toHaveBeenCalled();
});
it.each([
  ['unknown readiness state', { ...snapshot(), readinessState: 'bogus' }],
  ['extra key', { ...snapshot(), deviceId }],
  ['too many reason codes', { ...snapshot(), reasonCodes: Array.from({ length: 17 }, (_, i) => `r_${i}`) }],
  ['bad reason code', { ...snapshot(), reasonCodes: ['Not Snake'] }],
])('returns 400 for %s', async (_n, body) => {
  expect((await request(body)).status).toBe(400);
  expect(m.ingest).not.toHaveBeenCalled();
});
it('caps standalone route bodies at 64 KiB', async () => {
  const big = { ...snapshot(), details: { pad: 'x'.repeat(64 * 1024) } };
  expect((await request(big)).status).toBe(413);
  expect(m.ingest).not.toHaveBeenCalled();
});
it('returns 500 on service failure', async () => {
  m.ingest.mockRejectedValue(new Error('database'));
  expect((await request()).status).toBe(500);
});
