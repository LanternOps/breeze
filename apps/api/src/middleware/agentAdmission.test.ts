import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { authSpy } = vi.hoisted(() => ({ authSpy: vi.fn() }));
vi.mock('./agentAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentAuth')>()),
  agentAuthMiddleware: authSpy,
}));

import { hasDbAccessContext } from '../db';
import { agentRoutes } from '../routes/agents';
import { metricsMiddleware } from '../routes/metrics';
import { metricsRegistry } from '../services/metricsRegistry';
import type { AdmissionDecision, AdmissionGate } from '../services/admission/admissionRuntime';
import type { ClassifiedRequest } from '../services/admission/agentRouteClasses';
import { agentAdmission } from './agentAdmission';
import { requestPathLogger } from './requestPathLogger';

const AGENT = 'a'.repeat(64);

function stubGate(decide: (req: ClassifiedRequest) => AdmissionDecision, mode: AdmissionGate['mode'] = 'enforce') {
  const seen: Array<{ req: ClassifiedRequest; inDbContext: boolean }> = [];
  const gate: AdmissionGate = {
    mode,
    decide: (req) => {
      seen.push({ req, inDbContext: hasDbAccessContext() });
      return decide(req);
    },
  };
  return { gate, seen };
}
const shed = (): AdmissionDecision => ({ action: 'shed', reason: 'level', retryAfterSec: 137 });

beforeEach(() => {
  authSpy.mockReset();
  authSpy.mockImplementation(async (c: { text: (body: string, status: number) => Response }) => c.text('auth reached', 200));
});

describe('agentAdmission', () => {
  it('refuses before agent auth runs — so before its DB transaction and any body read', async () => {
    const { gate, seen } = stubGate(shed);
    const app = new Hono();
    app.use('*', agentAdmission(() => gate));
    app.route('/api/v1/agents', agentRoutes);

    const res = await app.request(`/api/v1/agents/${AGENT}/software`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ software: [] }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('137');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'Server busy; retry later', code: 'ADMISSION_SHED', retryAfterSeconds: 137 });
    expect(authSpy).not.toHaveBeenCalled();
    expect(seen).toEqual([
      { req: { cls: 'bulk', key: 'PUT /:id/software', label: '/api/v1/agents/:id/software' }, inDbContext: false },
    ]);
  });

  it('admitted requests continue to agent auth; protected routes never consult the gate', async () => {
    const { gate, seen } = stubGate(() => ({ action: 'admit' }));
    const app = new Hono();
    app.use('*', agentAdmission(() => gate));
    app.route('/api/v1/agents', agentRoutes);

    expect((await app.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' })).status).toBe(200);
    expect((await app.request(`/api/v1/agents/${AGENT}/heartbeat`, { method: 'POST' })).status).toBe(200);
    expect(authSpy).toHaveBeenCalledTimes(2);
    expect(seen.map((s) => s.req.key)).toEqual(['PUT /:id/software']);
  });

  it('is a pass-through with no gate, in off mode, and for unclassified paths', async () => {
    const off = stubGate(shed, 'off');
    const enforce = stubGate(shed);
    for (const [gate, path] of [
      [null, `/api/v1/agents/${AGENT}/software`],
      [off.gate, `/api/v1/agents/${AGENT}/software`],
      [enforce.gate, `/api/v1/agents/${AGENT}/software/`],
      [enforce.gate, '/api/v1/devices'],
    ] as const) {
      const app = new Hono();
      app.use('*', agentAdmission(() => gate));
      app.all('*', (c) => c.text('through', 200));
      expect((await app.request(path, { method: 'PUT' })).status, path).toBe(200);
    }
    expect(off.seen).toEqual([]);
    expect(enforce.seen).toEqual([]);
  });

  it('releases bulk accounting when the handler finishes, even when it throws', async () => {
    const release = vi.fn();
    const app = new Hono();
    app.use('*', agentAdmission(() => ({ mode: 'enforce', decide: () => ({ action: 'admit', release }) })));
    app.put('/api/v1/agents/:id/software', () => {
      throw new Error('boom');
    });
    app.onError((_err, c) => c.text('error', 500));

    expect((await app.request(`/api/v1/agents/${AGENT}/software`, { method: 'PUT' })).status).toBe(500);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('hands the WS setup slot downstream and releases it only when the upgrade was not accepted', async () => {
    const slot = { release: vi.fn() };
    let seenSlot: unknown;
    const app = new Hono();
    app.use('*', agentAdmission(() => ({ mode: 'enforce', decide: () => ({ action: 'admit', wsSlot: slot }) })));
    app.get('/api/v1/agent-ws/:id/ws', (c) => {
      seenSlot = c.get('admissionWsSetupSlot');
      // @hono/node-ws answers an accepted upgrade with a plain `new Response()` (200).
      return c.req.header('x-accept') ? new Response() : c.json({ error: 'Unauthorized' }, 401);
    });

    expect((await app.request(`/api/v1/agent-ws/${AGENT}/ws`, { headers: { 'x-accept': '1', upgrade: 'WebSocket' } })).status).toBe(200);
    expect(seenSlot).toBe(slot);
    expect(slot.release).not.toHaveBeenCalled();

    expect((await app.request(`/api/v1/agent-ws/${AGENT}/ws`, { headers: { upgrade: 'websocket' } })).status).toBe(401);
    expect(slot.release).toHaveBeenCalledTimes(1);
  });

  it('refunds the WS token when an admitted upgrade did not complete, but not when it did', async () => {
    const refund = vi.fn();
    const slot = { release: vi.fn() };
    const app = new Hono();
    app.use('*', agentAdmission(() => ({ mode: 'enforce', decide: () => ({ action: 'admit', wsSlot: slot, refund }) })));
    app.get('/api/v1/agent-ws/:id/ws', (c) => (c.req.header('x-accept') ? new Response() : c.json({ error: 'Unauthorized' }, 401)));

    await app.request(`/api/v1/agent-ws/${AGENT}/ws`, { headers: { 'x-accept': '1', upgrade: 'websocket' } });
    expect(refund).not.toHaveBeenCalled();
    await app.request(`/api/v1/agent-ws/${AGENT}/ws`, { headers: { upgrade: 'websocket' } });
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('a WS-path request without Upgrade: websocket is unclassified: the gate is never consulted', async () => {
    const { gate, seen } = stubGate(shed);
    const app = new Hono();
    app.use('*', agentAdmission(() => gate));
    app.get('/api/v1/agent-ws/:id/ws', (c) => c.json({ error: 'Unauthorized' }, 401));

    expect((await app.request(`/api/v1/agent-ws/${AGENT}/ws`)).status).toBe(401);
    expect((await app.request(`/api/v1/agent-ws/${AGENT}/ws`, { headers: { upgrade: 'h2c' } })).status).toBe(401);
    expect(seen).toEqual([]);
    expect((await app.request(`/api/v1/agent-ws/${AGENT}/ws`, { headers: { upgrade: 'WebSocket' } })).status).toBe(503);
    expect(seen).toHaveLength(1);
  });

  it('a refused WS upgrade never reaches the upgrade handler (Review Focus 1)', async () => {
    const upgrade = vi.fn((c: { text: (b: string) => Response }) => c.text('upgraded'));
    const app = new Hono();
    app.use('*', agentAdmission(() => ({
      mode: 'enforce',
      decide: () => ({ action: 'shed', reason: 'ws_bucket', retryAfterSec: 11 }),
    })));
    app.get('/api/v1/agent-ws/:id/ws', upgrade);

    const res = await app.request(`/api/v1/agent-ws/${AGENT}/ws`, { headers: { upgrade: 'websocket' } });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('11');
    expect(await res.json()).toMatchObject({ code: 'WS_UPGRADE_REFUSED', retryAfterSeconds: 11 });
    expect(upgrade).not.toHaveBeenCalled();
  });

  it('labels refused requests by route template in http_requests_total and the request log (Review Focus 4)', async () => {
    const print = vi.fn();
    const app = new Hono();
    app.use('*', metricsMiddleware);
    app.use('*', requestPathLogger(print));
    app.use('*', agentAdmission(() => stubGate(shed).gate));

    await app.request(`/api/v1/agents/${'b'.repeat(64)}/software`, { method: 'PUT' });
    await app.request(`/api/v1/agents/${'c'.repeat(64)}/software`, { method: 'PUT' });

    const metric = metricsRegistry.getSingleMetric('http_requests_total');
    const { values } = await metric!.get();
    expect(values.filter((v) => v.labels.route === '/api/v1/agents/:id/software')).toEqual([
      expect.objectContaining({ labels: { method: 'PUT', route: '/api/v1/agents/:id/software', status_class: '5xx' }, value: 2 }),
    ]);
    expect(print.mock.calls.flat().join('\n')).toContain('route=/api/v1/agents/:id/software status=503 reason=admission_shed_bulk');
  });
});
