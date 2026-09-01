import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  consumeRateLimit: vi.fn(),
  recordResult: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: mocks.select },
  runOutsideDbContext: mocks.runOutsideDbContext,
}));
vi.mock('../../services/pamReconciliationRateLimit', () => ({
  consumePamReconciliationRateLimit: mocks.consumeRateLimit,
}));
vi.mock('../../services/pamActuationResult', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/pamActuationResult')>();
  return { ...actual, recordPamActuationResult: mocks.recordResult };
});

import { pamObservationRoutes } from './pamObservations';

const AGENT_ID = 'agent-primary';
const DEVICE_ID = '30000000-0000-4000-8000-000000000001';
const COMMAND_ID = '60000000-0000-4000-8000-000000000001';

const received = {
  protocolVersion: 2 as const,
  observationId: '10000000-0000-4000-8000-000000000001',
  actuationId: '20000000-0000-4000-8000-000000000001',
  generation: 3,
  state: 'received' as const,
  observedAt: '2026-08-27T12:00:00.000Z',
  evidence: {
    bootId: 'boot-1',
    pid: 4321,
    processCreationTime: '2026-08-27T11:59:59.000Z',
    jobName: 'Global\\Breeze.PAM.20000000-0000-4000-8000-000000000001.g3',
  },
};
const body = { protocolVersion: 1 as const, observation: received };

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows),
      })),
    })),
  };
}

function buildApp(options: {
  role?: 'agent' | 'watchdog';
  agentId?: string;
  claimTypeAllowlist?: string[];
  includeAgent?: boolean;
} = {}) {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    if (options.includeAgent !== false) {
      c.set('agent', {
        deviceId: DEVICE_ID,
        orgId: '40000000-0000-4000-8000-000000000001',
        agentId: options.agentId ?? AGENT_ID,
        siteId: '50000000-0000-4000-8000-000000000001',
        role: options.role ?? 'agent',
        claimTypeAllowlist: options.claimTypeAllowlist,
      });
    }
    await next();
  });
  app.route('/agents', pamObservationRoutes);
  return app;
}

function request(app: Hono, requestBody: unknown = body, commandId = COMMAND_ID) {
  return app.request(`/agents/${AGENT_ID}/commands/${commandId}/pam-observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
}

describe('PAM received-observation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue(selectChain([{ id: COMMAND_ID }]));
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 119,
      resetAt: new Date('2026-08-27T12:01:00.000Z'),
    });
    mocks.recordResult.mockResolvedValue('applied');
  });

  it('returns the frozen acknowledgement for the exact authenticated command', async () => {
    const response = await request(buildApp());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      protocolVersion: 1,
      classification: 'applied',
    });
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(DEVICE_ID);
    expect(mocks.recordResult).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      deviceId: DEVICE_ID,
      commandId: COMMAND_ID,
      result: received,
    });
  });

  it.each([
    ['watchdog credential', { role: 'watchdog' as const }],
    ['missing credential', { includeAgent: false }],
  ])('rejects %s before rate limiting or command lookup', async (_name, options) => {
    const response = await request(buildApp(options));
    expect(response.status).toBe(403);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.recordResult).not.toHaveBeenCalled();
  });

  it('rejects an authenticated path identity mismatch before rate limiting', async () => {
    const response = await request(buildApp({ agentId: 'another-agent' }));
    expect(response.status).toBe(403);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('blocks every drain allowlist before rate limiting', async () => {
    const response = await request(buildApp({ claimTypeAllowlist: ['pam_apply_v2'] }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'drain_restricted' });
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical command ID before rate limiting', async () => {
    const response = await request(buildApp(), body, 'not-a-uuid');
    expect(response.status).toBe(400);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong outer protocol', { ...body, protocolVersion: 2 }],
    ['non-received state', { ...body, observation: { ...received, state: 'verified_active' } }],
    ['unknown outer key', { ...body, unknown: true }],
    ['unknown observation key', { ...body, observation: { ...received, unknown: true } }],
    ['unknown evidence key', { ...body, observation: { ...received, evidence: { ...received.evidence, unknown: true } } }],
  ])('strictly rejects %s', async (_name, invalidBody) => {
    const response = await request(buildApp(), invalidBody);
    expect(response.status).toBe(400);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('rejects a streamed body over 32 KiB before validation', async () => {
    const response = await request(buildApp(), { ...body, padding: 'x'.repeat(33 * 1024) });
    expect(response.status).toBe(413);
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('rate-limits by authenticated device before command lookup', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date('2026-08-27T12:01:00.000Z'),
    });
    const response = await request(buildApp());
    expect(response.status).toBe(429);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.recordResult).not.toHaveBeenCalled();
  });

  it('returns opaque not-found when exact command ownership is unavailable', async () => {
    mocks.select.mockReturnValue(selectChain([]));
    const response = await request(buildApp());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Command not found' });
    expect(mocks.recordResult).not.toHaveBeenCalled();
  });
});
