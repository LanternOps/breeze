import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

const {
  selectMock,
  hasPermMock,
  mfaOkMock,
  getAgentMock,
  resolveEffectiveAgentMock,
  createAndEnqueueAgentRunMock,
  verifyDeviceAccessMock,
  writeRouteAuditMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  // Explicit generic: vitest infers a zero-arg tuple from a bare `() => true`
  // impl, and `tsc` (not vitest) then rejects both the two-arg call inside the
  // requirePermission mock and the two-arg assertion below.
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  mfaOkMock: vi.fn(() => true),
  getAgentMock: vi.fn(),
  resolveEffectiveAgentMock: vi.fn(),
  createAndEnqueueAgentRunMock: vi.fn(),
  verifyDeviceAccessMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => (
    mfaOkMock() ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)
  ),
  requirePermission: (resource: string, action: string) => async (
    c: { json: (body: unknown, status: number) => Response },
    next: () => Promise<void>,
  ) => (
    hasPermMock(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)
  ),
}));

vi.mock('../services/aiAgents/agentService', () => ({
  AgentInvariantError: class AgentInvariantError extends Error {},
  AgentKindConflictError: class AgentKindConflictError extends Error {},
  UnsupportedAgentModeError: class UnsupportedAgentModeError extends Error {},
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  disableAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgent: getAgentMock,
}));

vi.mock('../services/aiAgents/runService', () => ({
  createAndEnqueueAgentRun: createAndEnqueueAgentRunMock,
}));

vi.mock('../services/aiTools', () => ({
  verifyDeviceAccess: verifyDeviceAccessMock,
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  getCurrentDbAccessContext: () => undefined,
}));

vi.mock('../services/aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgent: resolveEffectiveAgentMock,
}));

import { aiAgentsRoutes } from './aiAgents';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ORG_ID = '44444444-4444-4444-8444-444444444444';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';
const USER_ID = '77777777-7777-4777-8777-777777777777';

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    kind: 'triage',
    name: 'Triage',
    orgId: ORG_ID,
    partnerId: null,
    ...overrides,
  };
}

function buildApp(withGlobalErrorHandler = false): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: USER_ID, email: 'tech@example.com', name: 'Tech' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as never);
    await next();
  });
  if (withGlobalErrorHandler) {
    app.onError((err, c) => {
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json({ error: 'Internal server error' }, 500);
    });
  }
  app.route('/ai-agents', aiAgentsRoutes);
  return app;
}

function trigger(app: Hono, body: unknown = { deviceId: DEVICE_ID }, id = AGENT_ID) {
  return app.request(`/ai-agents/${id}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  mfaOkMock.mockReturnValue(true);
  getAgentMock.mockResolvedValue(agent());
  verifyDeviceAccessMock.mockResolvedValue({
    device: { id: DEVICE_ID, orgId: ORG_ID, siteId: null },
  });
  createAndEnqueueAgentRunMock.mockResolvedValue({
    created: true,
    run: { id: RUN_ID, status: 'queued' },
  });
});

describe('POST /ai-agents/:id/runs', () => {
  it('queues a manual run and audits the accountable human actor', async () => {
    const res = await trigger(buildApp());

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { runId: RUN_ID, status: 'queued' } });
    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      kind: 'triage',
      triggerKind: 'manual',
      deviceId: DEVICE_ID,
      dedupeKey: expect.stringMatching(/^manual:[0-9a-f-]{36}$/),
      triggerRef: { requestedByUserId: USER_ID, agentId: AGENT_ID },
    });
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        action: 'ai_agent.run.manual_trigger',
        resourceType: 'ai_agent',
        resourceId: AGENT_ID,
        resourceName: 'Triage',
        result: 'success',
        details: { deviceId: DEVICE_ID, runId: RUN_ID, triggerKind: 'manual' },
      }),
    );
  });

  it("uses the device's organization when the visible agent is partner-wide", async () => {
    getAgentMock.mockResolvedValue(agent({ orgId: null, partnerId: PARTNER_ID }));

    const res = await trigger(buildApp());

    expect(res.status).toBe(202);
    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, kind: 'triage' }),
    );
  });

  it('requires the ai_agents:write permission before admission', async () => {
    hasPermMock.mockImplementation((resource: string, action: string) => (
      resource !== 'ai_agents' || action !== 'write'
    ));

    const res = await trigger(buildApp());

    expect(res.status).toBe(403);
    // These literals are the public permission contract consumed by the route.
    expect(hasPermMock).toHaveBeenCalledTimes(1);
    expect(hasPermMock).toHaveBeenCalledWith('ai_agents', 'write');
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('requires MFA before admission', async () => {
    mfaOkMock.mockReturnValue(false);

    const res = await trigger(buildApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('returns a uniform 404 for a foreign-tenant agent before probing the device', async () => {
    getAgentMock.mockResolvedValue(null);

    const res = await trigger(buildApp());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Agent not found' });
    expect(verifyDeviceAccessMock).not.toHaveBeenCalled();
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid agent id without touching the database', async () => {
    const res = await trigger(buildApp(), { deviceId: DEVICE_ID }, 'not-a-uuid');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Agent not found' });
    expect(getAgentMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the device is outside the caller's scope", async () => {
    verifyDeviceAccessMock.mockResolvedValue({ error: 'Device not found or access denied' });

    const res = await trigger(buildApp());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Device not found or access denied' });
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('surfaces a cooldown skip as a conflict and audits the failure', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'cooldown' });

    const res = await trigger(buildApp());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run_skipped', reason: 'cooldown' });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'failure',
        details: { deviceId: DEVICE_ID, reason: 'cooldown' },
      }),
    );
  });

  it('returns a deliberate conflict when the kill switch is off', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'kill_switch_off' });

    const res = await trigger(buildApp());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'run_skipped', reason: 'kill_switch_off' });
  });

  it('reports a created terminal-failed row as an enqueue failure', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({
      created: true,
      run: { id: RUN_ID, status: 'failed', errorCode: 'enqueue_failed' },
    });

    const res = await trigger(buildApp());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'run_enqueue_failed',
      code: 'enqueue_failed',
      runId: RUN_ID,
    });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'failure',
        details: { deviceId: DEVICE_ID, runId: RUN_ID, errorCode: 'enqueue_failed' },
      }),
    );
  });

  it('rejects missing, malformed, and non-strict request bodies before admission', async () => {
    const app = buildApp();

    const missing = await trigger(app, {});
    const malformed = await trigger(app, { deviceId: 'not-a-uuid' });
    const smuggled = await trigger(app, { deviceId: DEVICE_ID, orgId: OTHER_ORG_ID });

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(smuggled.status).toBe(400);
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('lets a missing-organization HTTPException reach the global error handler', async () => {
    createAndEnqueueAgentRunMock.mockRejectedValue(
      new HTTPException(404, { message: 'Organization not found' }),
    );

    const res = await trigger(buildApp(true));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });
});
