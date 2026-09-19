import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock('../../services/pamReconciliationBinding', () => ({
  resolvePamReconciliationBindings: mocks.resolve,
}));
vi.mock('../../services/pamReconciliationRateLimit', () => ({
  consumePamReconciliationRateLimit: mocks.consumeRateLimit,
}));

import { pamReconciliationRoutes } from './pamReconciliation';

const candidate = {
  observationId: '10000000-0000-4000-8000-000000000001',
  actuationId: '20000000-0000-4000-8000-000000000001',
  generation: 3,
};

function buildApp(role: 'agent' | 'watchdog' = 'agent'): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      deviceId: '30000000-0000-4000-8000-000000000001',
      orgId: '40000000-0000-4000-8000-000000000001',
      partnerId: '70000000-0000-4000-8000-000000000001',
      agentId: 'agent-primary',
      siteId: '50000000-0000-4000-8000-000000000001',
      role,
    });
    await next();
  });
  app.route('/agents', pamReconciliationRoutes);
  return app;
}

function request(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/agents/path-agent/pam/reconciliation-bindings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('PAM reconciliation binding route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 119,
      resetAt: new Date('2026-08-26T12:01:00.000Z'),
    });
    mocks.resolve.mockResolvedValue([{
      status: 'bound',
      observationId: candidate.observationId,
      commandId: '60000000-0000-4000-8000-000000000001',
    }]);
  });

  it('uses only authenticated identity and returns protocol-v1 dispositions', async () => {
    const response = await request(buildApp(), { protocolVersion: 1, candidates: [candidate] });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 1,
      dispositions: [{
        status: 'bound',
        observationId: candidate.observationId,
        commandId: '60000000-0000-4000-8000-000000000001',
      }],
    });
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith('30000000-0000-4000-8000-000000000001');
    expect(mocks.resolve).toHaveBeenCalledWith({
      agentId: 'agent-primary',
      deviceId: '30000000-0000-4000-8000-000000000001',
      orgId: '40000000-0000-4000-8000-000000000001',
      candidates: [candidate],
    });
  });

  it('refuses watchdog credentials before rate limiting or resolution', async () => {
    const response = await request(buildApp('watchdog'), { protocolVersion: 1, candidates: [candidate] });
    expect(response.status).toBe(403);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong protocol', { protocolVersion: 2, candidates: [candidate] }],
    ['invalid observation UUID', { protocolVersion: 1, candidates: [{ ...candidate, observationId: 'bad' }] }],
    ['invalid actuation UUID', { protocolVersion: 1, candidates: [{ ...candidate, actuationId: 'bad' }] }],
    ['zero generation', { protocolVersion: 1, candidates: [{ ...candidate, generation: 0 }] }],
    ['empty candidates', { protocolVersion: 1, candidates: [] }],
    ['too many candidates', { protocolVersion: 1, candidates: Array.from({ length: 101 }, (_, index) => ({
      ...candidate,
      observationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      actuationId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    })) }],
    ['duplicate observation', { protocolVersion: 1, candidates: [candidate, { ...candidate, actuationId: '20000000-0000-4000-8000-000000000002' }] }],
    ['duplicate actuation generation', { protocolVersion: 1, candidates: [candidate, { ...candidate, observationId: '10000000-0000-4000-8000-000000000002' }] }],
  ])('rejects %s', async (_name, body) => {
    const response = await request(buildApp(), body);
    expect(response.status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body before parsing', async () => {
    const response = await request(
      buildApp(),
      { protocolVersion: 1, candidates: [candidate] },
      { 'content-length': '32769' },
    );
    expect(response.status).toBe(413);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('fails closed when the per-device reconciliation budget is exhausted', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date('2026-08-26T12:01:00.000Z'),
    });
    const response = await request(buildApp(), { protocolVersion: 1, candidates: [candidate] });
    expect(response.status).toBe(429);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
