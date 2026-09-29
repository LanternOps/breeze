import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const m = vi.hoisted(() => ({ ingest: vi.fn(), auth: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ agentVersion: '1.0.0' }] }),
      }),
    }),
  },
}));
vi.mock('../../services/timeSync/ingest', () => ({
  ingestTimeStatusSnapshot: m.ingest,
}));
vi.mock('../../middleware/agentAuth', () => ({
  agentAuthMiddleware: async (c: any, next: any) => {
    m.auth(c.req.param('id'));
    c.set('agent', {
      role: 'agent',
      agentId: 'agent-1',
      deviceId: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222',
    });
    return next();
  },
}));
vi.mock('./download', async () => ({
  downloadRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./enrollment', async () => ({
  enrollmentRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./heartbeat', async () => ({
  heartbeatRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./uninstallIntent', async () => ({
  uninstallIntentRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./commands', async () => ({
  commandsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./pamObservations', async () => ({
  pamObservationRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./pamReconciliation', async () => ({
  pamReconciliationRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./security', async () => ({
  agentSecurityRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./recoveryKeys', async () => ({
  agentRecoveryKeysRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./inventory', async () => ({
  inventoryRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./state', async () => ({
  stateRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./sessions', async () => ({
  sessionsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./patches', async () => ({
  patchesRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./connections', async () => ({
  connectionsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./eventlogs', async () => ({
  eventLogsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./hardwareHealth', async () => ({
  hardwareHealthRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./logs', async () => ({
  logsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./mtls', async () => ({
  mtlsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./bootPerformance', async () => ({
  bootPerformanceRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./reliability', async () => ({
  reliabilityRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./changes', async () => ({
  changesRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./peripherals', async () => ({
  peripheralRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./token', async () => ({
  tokenRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./elevationRequests', async () => ({
  elevationRequestsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./processSample', async () => ({
  processSampleRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./unifiTelemetry', async () => ({
  unifiTelemetryRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./topologyAdjacency', async () => ({
  topologyAdjacencyRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./wingetBootstrap', async () => ({
  wingetBootstrapRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./storageSessions', async () => ({
  agentStorageSessionRoutes: new (await import('hono')).Hono(),
}));
import { agentRoutes } from './index';
import { createGlobalBodyLimitMiddleware } from '../../middleware/bodyLimitGate';
import { snapshot } from '../../services/timeSync/testFixtures';
const app = new Hono();
app.use(
  '*',
  createGlobalBodyLimitMiddleware({ warn: () => {}, capture: () => {} }),
);
app.route('/api/v1/agents', agentRoutes);
beforeEach(() => {
  m.auth.mockClear();
  m.ingest.mockReset().mockResolvedValue({ accepted: true, health: 'healthy' });
});
function request(body: string, contentLength: boolean) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (contentLength)
    headers['content-length'] = String(Buffer.byteLength(body));
  return app.request('/api/v1/agents/agent-1/time-status', {
    method: 'PUT',
    headers,
    body,
  });
}
it.each([false, true])(
  'accepts exactly 512 KiB and rejects one byte over; Content-Length %s',
  async (length) => {
    const raw = JSON.stringify(snapshot());
    const exact = raw + ' '.repeat(512 * 1024 - Buffer.byteLength(raw));
    const accepted = await request(exact, length);
    expect(accepted.status).toBe(200);
    expect(m.auth).toHaveBeenCalledWith('agent-1');
    expect(m.ingest).toHaveBeenCalledOnce();
    m.auth.mockClear();
    m.ingest.mockClear();
    expect((await request(exact + ' ', length)).status).toBe(413);
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.ingest).not.toHaveBeenCalled();
  },
);
