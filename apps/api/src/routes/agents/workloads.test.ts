import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({ ingest: vi.fn(), rows: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }),
  },
}));
vi.mock('../../services/workloads/ingest', () => ({ ingestWorkloadsReport: m.ingest }));

import { workloadsRoutes } from './workloads';
import { reportFixture, runtimeFixture, workloadFixture } from '../../services/workloads/testFixtures';

const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';

function request(body: unknown = reportFixture(), role = 'agent', path = 'agent-1') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (role === 'missing') return c.json({ error: 'Unauthorized' }, 401);
    c.set('agent', { role, deviceId, orgId, agentId: 'agent-1' } as any);
    await next();
  });
  app.route('/', workloadsRoutes);
  return app.request(`/${path}/workloads`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  m.rows = [{ id: deviceId }];
  m.ingest.mockReset().mockResolvedValue({ accepted: true, runtimes: [{ runtime: 'docker', applied: true }] });
});

it('ingests with the authenticated ids and returns the per-runtime applied flags', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true, runtimes: [{ runtime: 'docker', applied: true }] });
  expect(m.ingest).toHaveBeenCalledWith({
    deviceId,
    orgId,
    report: expect.objectContaining({ protocolVersion: 1 }),
    receivedAt: expect.any(Date),
  });
  // the service receives the parsed (null-normalized) report, not the raw body
  const parsed = m.ingest.mock.calls[0]![0].report;
  expect(parsed.runtimes[0].workloads[0].guestOs).toBeNull();
});

it.each([
  ['missing', 401],
  ['watchdog', 403],
  ['helper', 403],
])('rejects %s credentials', async (role, status) => {
  expect((await request(reportFixture(), role)).status).toBe(status);
  expect(m.ingest).not.toHaveBeenCalled();
});

it('rejects a path id that is not the authenticated agent before ingesting', async () => {
  expect((await request(reportFixture(), 'agent', 'agent-2')).status).toBe(403);
  expect(m.ingest).not.toHaveBeenCalled();
});

it.each([
  ['a duplicate workloadId within a runtime', reportFixture({ runtimes: [runtimeFixture({ workloads: [workloadFixture(), workloadFixture()] })] })],
  ['a duplicate runtime entry', reportFixture({ runtimes: [runtimeFixture(), runtimeFixture()] })],
  ['a kind that does not fit the runtime', reportFixture({ runtimes: [runtimeFixture({ runtime: 'hyperv' })] })],
  ['any workload under containerd', reportFixture({ runtimes: [runtimeFixture({ runtime: 'containerd' })] })],
  ['an unknown key', reportFixture({ extra: true })],
  ['a forbidden field', reportFixture({ runtimes: [runtimeFixture({ workloads: [workloadFixture({ env: ['A=B'] })] })] })],
  ['a negative observedCount', reportFixture({ runtimes: [runtimeFixture({ observedCount: -1 })] })],
])('returns 400, not a database error, for %s', async (_name, body) => {
  expect((await request(body)).status).toBe(400);
  expect(m.ingest).not.toHaveBeenCalled();
});

it('returns 404 for a device that is not visible and 500 for a service failure', async () => {
  m.rows = [];
  expect((await request()).status).toBe(404);
  m.rows = [{ id: deviceId }];
  m.ingest.mockRejectedValue(new Error('database'));
  expect((await request()).status).toBe(500);
  expect(m.ingest).toHaveBeenCalledTimes(1);
});

it('returns 200 with applied: false for a replayed runtime (not an error)', async () => {
  m.ingest.mockResolvedValue({ accepted: true, runtimes: [{ runtime: 'docker', applied: false }] });
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true, runtimes: [{ runtime: 'docker', applied: false }] });
});

it('caps the standalone route body at 2 MiB', async () => {
  expect((await request({ ...reportFixture(), padding: 'x'.repeat(2 * 1024 * 1024) })).status).toBe(413);
  expect(m.ingest).not.toHaveBeenCalled();
});
