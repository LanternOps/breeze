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

// #6260 — the handler now opens its own withDbAccessContext (after the rate
// limiter decides), mirroring routes/agents/elevationRequests.ts (#6130).
// Mocked the same way that test mocks it: a no-op passthrough that just
// invokes the callback, so tests below can assert call order/args without a
// real Postgres connection.
vi.mock('../../db', () => ({
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

import { withDbAccessContext } from '../../db';
import {
  pamReconciliationBindingResponseSchemas,
  pamReconciliationRoutes,
  serializePamReconciliationBindingResponse,
} from './pamReconciliation';

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
    // vi.resetAllMocks() strips the factory's default passthrough
    // implementation too (it's a full mockReset, not just a mockClear) —
    // restore it here so every test gets the real self-managed-context
    // behavior unless it overrides withDbAccessContext itself.
    vi.mocked(withDbAccessContext).mockImplementation(async (_ctx: any, fn: any) => fn());
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
      protocolVersion: 1,
      candidates: [candidate],
    });
  });

  // PAM ownership epochs W3 (#8205): v2 negotiates the `retired` disposition.
  it('accepts protocol v2 and returns retired dispositions', async () => {
    mocks.resolve.mockResolvedValue([{ status: 'retired', observationId: candidate.observationId }]);
    const response = await request(buildApp(), { protocolVersion: 2, candidates: [candidate] });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 2,
      dispositions: [{ status: 'retired', observationId: candidate.observationId }],
    });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ protocolVersion: 2 }));
  });

  it('fails the v1 request rather than serialize a retired disposition to a v1 agent', async () => {
    mocks.resolve.mockResolvedValue([{ status: 'retired', observationId: candidate.observationId }]);
    const response = await request(buildApp(), { protocolVersion: 1, candidates: [candidate] });
    expect(response.status).toBe(500);
  });

  // #6260 / #1105 — the DB work (resolvePamReconciliationBindings, raw
  // RLS-scoped SQL) must run inside a context this handler opens itself,
  // AFTER the rate limiter's Redis round-trip has already decided. The route
  // is now in SELF_MANAGED_DB_CONTEXT_TWO_SEGMENT_ACTIONS
  // (middleware/agentAuth.ts), so agentAuthMiddleware no longer holds a
  // request-long transaction across that round-trip.
  it('opens its own org-scoped DB context, after the rate limiter decides', async () => {
    const order: string[] = [];
    mocks.consumeRateLimit.mockImplementation(async () => {
      order.push('rateLimit');
      return { allowed: true, remaining: 119, resetAt: new Date('2026-08-26T12:01:00.000Z') };
    });
    vi.mocked(withDbAccessContext).mockImplementation(async (_ctx: any, fn: any) => {
      order.push('withDbAccessContext');
      return fn();
    });

    const response = await request(buildApp(), { protocolVersion: 1, candidates: [candidate] });

    expect(response.status).toBe(200);
    expect(order).toEqual(['rateLimit', 'withDbAccessContext']);
    expect(vi.mocked(withDbAccessContext)).toHaveBeenCalledWith(
      {
        scope: 'organization',
        orgId: '40000000-0000-4000-8000-000000000001',
        accessibleOrgIds: ['40000000-0000-4000-8000-000000000001'],
        accessiblePartnerIds: [],
        currentPartnerId: '70000000-0000-4000-8000-000000000001',
      },
      expect.any(Function),
    );
  });

  // A rate-limited request must never open the DB context at all — that is
  // the whole point of the fix (#6260): the Redis check happens with no
  // pooled connection held.
  it('never opens the DB context when the rate limit rejects the request', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date('2026-08-26T12:01:00.000Z'),
    });

    const response = await request(buildApp(), { protocolVersion: 1, candidates: [candidate] });

    expect(response.status).toBe(429);
    expect(vi.mocked(withDbAccessContext)).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('refuses watchdog credentials before rate limiting or resolution', async () => {
    const response = await request(buildApp('watchdog'), { protocolVersion: 1, candidates: [candidate] });
    expect(response.status).toBe(403);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['protocol 3', { protocolVersion: 3, candidates: [candidate] }],
    ['protocol 0', { protocolVersion: 0, candidates: [candidate] }],
    ['string protocol', { protocolVersion: '2', candidates: [candidate] }],
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

describe('PAM reconciliation binding response serializer', () => {
  const observationId = '10000000-0000-4000-8000-000000000001';

  it('v1 never emits retired', () => {
    expect(() => serializePamReconciliationBindingResponse(1, [{ status: 'retired', observationId }]))
      .toThrow();
    expect(pamReconciliationBindingResponseSchemas[1].safeParse({
      protocolVersion: 1,
      dispositions: [{ status: 'retired', observationId }],
    }).success).toBe(false);
  });

  it('v2 carries retired and every v1 disposition', () => {
    const dispositions = [
      { status: 'bound' as const, observationId, commandId: '60000000-0000-4000-8000-000000000001' },
      { status: 'duplicate' as const, observationId },
      { status: 'stale' as const, observationId },
      { status: 'unresolved' as const, observationId },
      { status: 'retired' as const, observationId },
    ];
    expect(serializePamReconciliationBindingResponse(2, dispositions)).toEqual({ protocolVersion: 2, dispositions });
    expect(serializePamReconciliationBindingResponse(1, dispositions.slice(0, 4)))
      .toEqual({ protocolVersion: 1, dispositions: dispositions.slice(0, 4) });
  });
});
