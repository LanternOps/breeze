import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { order } = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('../../db', () => ({
  db: { transaction: async (fn: () => unknown) => { order.push('tx:open'); try { return await fn(); } finally { order.push('tx:close'); } } },
  withSystemDbAccessContext: async (fn: () => unknown) => { order.push('ctx:open'); try { return await fn(); } finally { order.push('ctx:close'); } },
}));
vi.mock('../../services/topology/flags', () => ({
  loadTopologyFlags: vi.fn(async () => { order.push('flags:loaded'); return { materialization: true }; }),
  withResolvedTopologyFlags: vi.fn(async (_resolved: unknown, fn: () => unknown) => { order.push('flags:wrap'); try { return await fn(); } finally { order.push('flags:unwrap'); } }),
}));
vi.mock('../../services/topology/unifiAdapter', () => ({
  adaptUnifiTopology: vi.fn(),
}));
vi.mock('../../services/topology/unifiAuthority', () => ({
  loadUnifiCollector: vi.fn(),
  unifiTopologyAdvertisement: vi.fn(async () => null),
}));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/unifi/unifiCollectorService', () => ({
  listCollectorsForDevice: vi.fn(),
}));
vi.mock('../../jobs/unifiTelemetryWorker', () => ({
  enqueueUnifiTelemetry: vi.fn(async () => undefined),
}));

import { unifiTelemetryRoutes } from './unifiTelemetry';
import * as collectorSvc from '../../services/unifi/unifiCollectorService';
import * as worker from '../../jobs/unifiTelemetryWorker';
import * as adapter from '../../services/topology/unifiAdapter';
import * as authority from '../../services/topology/unifiAuthority';
import * as flagsModule from '../../services/topology/flags';
import vectors from '../../../../../packages/shared/src/testing/topology-unifi-v1.json';

const AGENT_ID = 'agent-1';

// Build an app that injects the given agent role context, mirroring the
// eventlogs route test (agentAuthMiddleware is applied by the parent agentRoutes
// in production; here we stub it so requireAgentRole + the handlers run).
function appWithRole(role: 'agent' | 'watchdog') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', { deviceId: 'dev-1', agentId: AGENT_ID, orgId: 'org-1', siteId: 'site-1', role } as never);
    return next();
  });
  app.route('/agents', unifiTelemetryRoutes);
  return app;
}

describe('agent unifi telemetry routes', () => {
  beforeEach(() => { vi.clearAllMocks(); order.length = 0; });

  it('GET /agents/:id/unifi-collectors returns this device\'s collector configs', async () => {
    (collectorSvc.listCollectorsForDevice as any).mockResolvedValue([
      { collectorId: 'c1', unifiHostId: 'h1', controllerUrl: 'https://10.0.0.1', apiKey: 'K', pollIntervalSeconds: 60 },
    ]);
    const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-collectors`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ collectors: [{ collectorId: 'c1', apiKey: 'K' }] });
    // Looks up by the token-resolved deviceId, not the :id path param.
    expect(collectorSvc.listCollectorsForDevice).toHaveBeenCalledWith(expect.anything(), 'dev-1', expect.any(Object));
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

  describe('topologyV1 companion (M2 Task 5)', () => {
    const legacy = { collectorId: 'c1', polledAt: '2026-06-29T00:00:00Z', firmwareOk: true, devices: [], clients: [] };
    const report = vectors.vectors[0]!.report;
    const post = (body: unknown) => appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-telemetry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const collector = { id: 'c1', collectorDeviceId: 'dev-1', orgId: 'org-1' };

    it('GET advertises through the topology provider for this device only', async () => {
      (collectorSvc.listCollectorsForDevice as any).mockImplementation(async (_db: unknown, _dev: string, opts: any) => [{ collectorId: 'c1', topology: await opts.topologyAdvertisement('c1') }]);
      (authority.unifiTopologyAdvertisement as any).mockResolvedValue({ acceptedUnifiTopologyVersions: [1], topologyProducerEpoch: 'e', topologySourceIdentity: 's' });
      const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-collectors`, { method: 'GET' });
      expect(await res.json()).toMatchObject({ collectors: [{ collectorId: 'c1', topology: { topologyProducerEpoch: 'e' } }] });
      expect(authority.unifiTopologyAdvertisement).toHaveBeenCalledWith('dev-1', 'c1');
    });

    it('leaves the legacy path unchanged when no companion is sent', async () => {
      const res = await post(legacy);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: true });
      expect(adapter.adaptUnifiTopology).not.toHaveBeenCalled();
      expect(authority.loadUnifiCollector).not.toHaveBeenCalled();
      expect((worker.enqueueUnifiTelemetry as any).mock.calls[0][0]).not.toHaveProperty('topologyV1');
    });

    it('rejects a malformed companion in its receipt but still delivers legacy telemetry', async () => {
      const res = await post({ ...legacy, topologyV1: { ...report, resources: 'nope' } });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: true, topology: { accepted: false, reason: 'invalid_report', reportSequence: '3', resources: [] } });
      expect(adapter.adaptUnifiTopology).not.toHaveBeenCalled();
      expect(worker.enqueueUnifiTelemetry).toHaveBeenCalledTimes(1);
      const unsupported = await post({ ...legacy, topologyV1: { ...report, version: 2 } });
      expect((await unsupported.json()).topology).toMatchObject({ accepted: false, reason: 'unsupported_major_version' });
    });

    it('ingests the companion synchronously before the legacy enqueue and returns receipts', async () => {
      const order: string[] = [];
      (authority.loadUnifiCollector as any).mockResolvedValue(collector);
      (adapter.adaptUnifiTopology as any).mockImplementation(async () => {
        order.push('topology');
        return { accepted: true, producerEpoch: 'e', reportSequence: '3', resources: [{ controllerSiteId: 's', kind: 'device_list', accepted: true, contentDigest: 'd' }] };
      });
      (worker.enqueueUnifiTelemetry as any).mockImplementation(async () => { order.push('legacy'); });
      const res = await post({ ...legacy, topologyV1: report });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ accepted: true, topology: { accepted: true, resources: [{ accepted: true, contentDigest: 'd' }] } });
      expect(order).toEqual(['topology', 'legacy']);
      expect((adapter.adaptUnifiTopology as any).mock.calls[0][0]).toBe('dev-1');
      expect((adapter.adaptUnifiTopology as any).mock.calls[0][2]).toMatchObject({ sequence: '3', resources: expect.any(Array) });
      expect((worker.enqueueUnifiTelemetry as any).mock.calls[0][0]).not.toHaveProperty('topologyV1');
    });

    it('refuses a companion for a collector owned by another device', async () => {
      (authority.loadUnifiCollector as any).mockResolvedValue({ ...collector, collectorDeviceId: 'dev-2' });
      const res = await post({ ...legacy, topologyV1: report });
      expect((await res.json()).topology).toEqual({ accepted: false, reason: 'collector_not_owned', reportSequence: '3', resources: [] });
      expect(adapter.adaptUnifiTopology).not.toHaveBeenCalled();
      expect(worker.enqueueUnifiTelemetry).toHaveBeenCalledTimes(1);
    });

    // #6671 shape (US 2026-09-22): the companion ingest used to run inside the
    // agent's request-long org transaction and resolve topology flags per
    // resource through a partner-axis read on a SECOND pooled connection while
    // earlier resources' site-state row locks were still held. The route now
    // self-manages its context: flags are resolved ONCE in a short context that
    // closes before the ingest transaction opens, the ingest runs under
    // withResolvedTopologyFlags, and it commits before the legacy enqueue.
    it('resolves topology flags once, before the ingest transaction, and commits before the legacy enqueue', async () => {
      (authority.loadUnifiCollector as any).mockResolvedValue(collector);
      (adapter.adaptUnifiTopology as any).mockImplementation(async () => {
        order.push('topology');
        return { accepted: true, producerEpoch: 'e', reportSequence: '3', resources: [] };
      });
      (worker.enqueueUnifiTelemetry as any).mockImplementation(async () => { order.push('legacy'); });
      const res = await post({ ...legacy, topologyV1: report });
      expect(res.status).toBe(202);
      expect(flagsModule.loadTopologyFlags).toHaveBeenCalledTimes(1);
      expect(flagsModule.loadTopologyFlags).toHaveBeenCalledWith({ scope: { orgId: 'org-1', siteId: 'site-1' } });
      expect(flagsModule.withResolvedTopologyFlags).toHaveBeenCalledWith({ orgId: 'org-1', flags: { materialization: true } }, expect.any(Function));
      expect(order).toEqual([
        'ctx:open', 'flags:loaded', 'ctx:close',
        'flags:wrap', 'ctx:open', 'tx:open', 'topology', 'tx:close', 'ctx:close', 'flags:unwrap',
        'legacy',
      ]);
    });

    it('reports collection_unavailable without opening the ingest transaction when flag resolution fails', async () => {
      (flagsModule.loadTopologyFlags as any).mockRejectedValueOnce(new Error('pool busy'));
      const res = await post({ ...legacy, topologyV1: report });
      expect(res.status).toBe(202);
      expect((await res.json()).topology).toEqual({ accepted: false, reason: 'collection_unavailable', reportSequence: '3', resources: [] });
      expect(adapter.adaptUnifiTopology).not.toHaveBeenCalled();
      expect(order).not.toContain('tx:open');
      expect(worker.enqueueUnifiTelemetry).toHaveBeenCalledTimes(1);
    });

    it('GET resolves topology flags once before the collector read and advertises under them', async () => {
      (collectorSvc.listCollectorsForDevice as any).mockImplementation(async (_db: unknown, _dev: string, opts: any) => {
        order.push('collectors');
        return [{ collectorId: 'c1', topology: await opts.topologyAdvertisement('c1') }, { collectorId: 'c2', topology: await opts.topologyAdvertisement('c2') }];
      });
      const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-collectors`, { method: 'GET' });
      expect(res.status).toBe(200);
      expect(flagsModule.loadTopologyFlags).toHaveBeenCalledTimes(1);
      expect(order.slice(0, 4)).toEqual(['ctx:open', 'flags:loaded', 'ctx:close', 'flags:wrap']);
      expect(order.indexOf('collectors')).toBeGreaterThan(order.indexOf('flags:wrap'));
      expect(authority.unifiTopologyAdvertisement).toHaveBeenCalledTimes(2);
    });

    it('GET still delivers legacy collector configs, unadvertised, when flag resolution fails', async () => {
      (flagsModule.loadTopologyFlags as any).mockRejectedValueOnce(new Error('pool busy'));
      (collectorSvc.listCollectorsForDevice as any).mockImplementation(async (_db: unknown, _dev: string, opts: any) => [{ collectorId: 'c1', topology: await opts.topologyAdvertisement('c1') }]);
      const res = await appWithRole('agent').request(`/agents/${AGENT_ID}/unifi-collectors`, { method: 'GET' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ collectors: [{ collectorId: 'c1', topology: null }] });
      expect(authority.unifiTopologyAdvertisement).not.toHaveBeenCalled();
    });

    it('never loses legacy telemetry when topology ingest fails unexpectedly', async () => {
      (authority.loadUnifiCollector as any).mockResolvedValue(collector);
      (adapter.adaptUnifiTopology as any).mockRejectedValue(new Error('boom'));
      const res = await post({ ...legacy, topologyV1: report });
      expect(res.status).toBe(202);
      expect((await res.json()).topology).toEqual({ accepted: false, reason: 'collection_unavailable', reportSequence: '3', resources: [] });
      expect(worker.enqueueUnifiTelemetry).toHaveBeenCalledTimes(1);
    });
  });
});
