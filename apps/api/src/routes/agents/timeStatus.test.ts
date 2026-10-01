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
vi.mock('../../services/timeSync/ingest', () => ({
  ingestTimeStatusSnapshot: m.ingest,
}));
import { timeStatusRoutes } from './timeStatus';
import { snapshot } from '../../services/timeSync/testFixtures';
const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
function request(body: unknown = snapshot(), role = 'agent', path = 'agent-1') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (role === 'missing') return c.json({ error: 'Unauthorized' }, 401);
    c.set('agent', { role, deviceId, orgId, agentId: 'agent-1' } as any);
    await next();
  });
  app.route('/', timeStatusRoutes);
  return app.request(`/${path}/time-status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  m.rows = [{ id: deviceId, orgId, agentVersion: '1.0.0' }];
  m.ingest.mockReset().mockResolvedValue({ accepted: true, health: 'healthy' });
});
it('uses authenticated IDs and stored agent version', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true, health: 'healthy' });
  expect(m.ingest).toHaveBeenCalledWith({
    deviceId,
    orgId,
    agentVersion: '1.0.0',
    snapshot: snapshot(),
    receivedAt: expect.any(Date),
  });
});
it.each([
  ['missing', 401],
  ['watchdog', 403],
  ['helper', 403],
])('rejects %s credentials', async (role, status) => {
  expect((await request(snapshot(), role as string)).status).toBe(status);
  expect(m.ingest).not.toHaveBeenCalled();
});
it('rejects a different agent path before ingestion', async () => {
  expect((await request(snapshot(), 'agent', 'agent-2')).status).toBe(403);
  expect(m.ingest).not.toHaveBeenCalled();
});
it('returns 400 for invalid schema, 404 for hidden device, 500 for service failure', async () => {
  expect((await request({ ...snapshot(), sequence: -1 })).status).toBe(400);
  m.rows = [];
  expect((await request()).status).toBe(404);
  m.rows = [{ id: deviceId, orgId }];
  m.ingest.mockRejectedValue(new Error('database'));
  expect((await request()).status).toBe(500);
});
it('returns the stale-sequence reason so the sender may commit the rejected snapshot', async () => {
  m.ingest.mockResolvedValue({ accepted: false, reason: 'stale_sequence' });
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    accepted: false,
    reason: 'stale_sequence',
  });
});
it('caps standalone route bodies at 512 KiB', async () => {
  expect(
    (await request({ ...snapshot(), padding: 'x'.repeat(512 * 1024) })).status,
  ).toBe(413);
  expect(m.ingest).not.toHaveBeenCalled();
});
