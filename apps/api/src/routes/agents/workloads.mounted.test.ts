import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: '11111111-1111-4111-8111-111111111111' }] }) }) }),
  },
}));
vi.mock('../../services/workloads/ingest', () => ({ ingestWorkloadsReport: m.ingest }));

import { workloadsRoutes } from './workloads';
import { createGlobalBodyLimitMiddleware } from '../../middleware/bodyLimitGate';
import { reportFixture } from '../../services/workloads/testFixtures';

const app = new Hono();
app.use('*', createGlobalBodyLimitMiddleware({ warn: () => {}, capture: () => {} }));
app.use('*', async (c, next) => {
  c.set('agent', {
    role: 'agent',
    agentId: 'agent-1',
    deviceId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
  } as any);
  await next();
});
app.route('/api/v1/agents', workloadsRoutes);

beforeEach(() => {
  m.ingest.mockReset().mockResolvedValue({ accepted: true, runtimes: [] });
});

function request(body: string, contentLength: boolean) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (contentLength) headers['content-length'] = String(Buffer.byteLength(body));
  return app.request('/api/v1/agents/agent-1/workloads', { method: 'PUT', headers, body });
}

it.each([false, true])('accepts exactly 2 MiB and rejects one byte over; Content-Length %s', async (length) => {
  const raw = JSON.stringify(reportFixture());
  const exact = raw + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(raw));
  expect((await request(exact, length)).status).toBe(200);
  expect(m.ingest).toHaveBeenCalledOnce();
  m.ingest.mockClear();
  expect((await request(exact + ' ', length)).status).toBe(413);
  expect(m.ingest).not.toHaveBeenCalled();
});
