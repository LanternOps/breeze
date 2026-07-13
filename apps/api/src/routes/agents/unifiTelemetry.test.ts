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

  it('POST /agents/:id/unifi-telemetry enqueues the payload, stamping the token deviceId', async () => {
    const body = { collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true, devices: [], clients: [] };
    const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    // Server stamps the token-resolved deviceId so the worker can verify ownership.
    expect(worker.enqueueUnifiTelemetry).toHaveBeenCalledWith(expect.objectContaining({ collectorId: 'c1', deviceId: 'dev-1' }));
  });

  it('POST /agents/:id/unifi-telemetry accepts a populated camelCase device payload', async () => {
    const body = {
      collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true,
      devices: [{
        unifiDeviceId: 'd1', unifiSiteId: 's1', mac: 'aa:bb:cc:dd:ee:ff', name: 'AP',
        uptimeSeconds: 10, cpuPct: 1, memPct: 2, txBytes: 3, rxBytes: 4, numClients: 1,
        poePorts: [{ portIdx: 1, up: true }], raw: { x: 1 },
      }],
      clients: [{ mac: '11:22:33:44:55:66', unifiSiteId: 's1', hostname: 'phone', ip: '10.0.0.9', isWired: false, raw: {} }],
    };
    const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    expect(worker.enqueueUnifiTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ devices: [expect.objectContaining({ unifiDeviceId: 'd1' })] }),
    );
  });

  it('POST /agents/:id/unifi-telemetry returns 403 when the device context is missing', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', { agentId: AGENT_ID, orgId: 'org-1', role: 'agent' } as never); // no deviceId
      return next();
    });
    app.route('/agents', unifiTelemetryRoutes);
    const body = { collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true, devices: [], clients: [] };
    const res = await app.request(`/agents/${AGENT_ID}/unifi-telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    expect(worker.enqueueUnifiTelemetry).not.toHaveBeenCalled();
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


  it('redacts secrets from the agent-supplied poll error before enqueue (#2434)', async () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';
    const body = {
      collectorId: 'c1',
      polledAt: '2026-06-29T00:00:00Z',
      firmwareOk: false,
      devices: [],
      clients: [],
      error: `controller rejected the poll, key follows:\n${pem}`,
    };
    const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    expect(res.status).toBe(202);
    // lastPollError is rendered in the collectors UI — a controller error can
    // embed the controller API key, so it must never be enqueued verbatim.
    const enqueued = (worker.enqueueUnifiTelemetry as any).mock.calls[0][0] as { error: string };
    expect(enqueued.error).toContain('[PRIVATE_KEY_REDACTED]');
    expect(enqueued.error).not.toContain('BEGIN RSA PRIVATE KEY');
  });
});
