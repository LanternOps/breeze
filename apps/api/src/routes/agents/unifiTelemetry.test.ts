import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../services/unifi/unifiCollectorService', () => ({
  listCollectorsForDevice: vi.fn(),
}));
vi.mock('../../jobs/unifiTelemetryWorker', () => ({
  enqueueUnifiTelemetry: vi.fn(async () => undefined),
}));

import { unifiTelemetryRoutes } from './unifiTelemetry';
import * as collectorSvc from '../../services/unifi/unifiCollectorService';
import * as worker from '../../jobs/unifiTelemetryWorker';

const AGENT_ID = 'agent-1';

// Build an app that injects the given agent role context, mirroring the
// eventlogs route test (agentAuthMiddleware is applied by the parent agentRoutes
// in production; here we stub it so requireAgentRole + the handlers run).
function appWithRole(role: 'agent' | 'watchdog') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', { deviceId: 'dev-1', agentId: AGENT_ID, orgId: 'org-1', role } as never);
    return next();
  });
  app.route('/agents', unifiTelemetryRoutes);
  return app;
}

describe('agent unifi telemetry routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /agents/:id/unifi-collectors returns this device\'s collector configs', async () => {
    (collectorSvc.listCollectorsForDevice as any).mockResolvedValue([
      { collectorId: 'c1', unifiHostId: 'h1', controllerUrl: 'https://10.0.0.1', apiKey: 'K', pollIntervalSeconds: 60 },
    ]);
    const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-collectors`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ collectors: [{ collectorId: 'c1', apiKey: 'K' }] });
    // Looks up by the token-resolved deviceId, not the :id path param.
    expect(collectorSvc.listCollectorsForDevice).toHaveBeenCalledWith(expect.anything(), 'dev-1');
  });

  it('POST /agents/:id/unifi-telemetry enqueues the payload and returns 202', async () => {
    const body = { collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true, devices: [], clients: [] };
    const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    expect(worker.enqueueUnifiTelemetry).toHaveBeenCalledWith(expect.objectContaining({ collectorId: 'c1' }));
  });

  it('POST /agents/:id/unifi-telemetry rejects an invalid payload with 400', async () => {
    const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
    expect(worker.enqueueUnifiTelemetry).not.toHaveBeenCalled();
  });

  it('rejects the watchdog credential with 403 (requireAgentRole)', async () => {
    const res = await appWithRole('watchdog').request(`/agents/${AGENT_ID}/unifi-collectors`, { method: 'GET' });
    expect(res.status).toBe(403);
    expect(collectorSvc.listCollectorsForDevice).not.toHaveBeenCalled();
  });
});
