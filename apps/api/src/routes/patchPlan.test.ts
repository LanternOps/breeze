import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  hasPermMock,
  mfaOkMock,
  resolveEffectiveAgentMock,
  createAndEnqueueAgentRunMock,
  writeRouteAuditMock,
} = vi.hoisted(() => ({
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  mfaOkMock: vi.fn(() => true),
  resolveEffectiveAgentMock: vi.fn(),
  createAndEnqueueAgentRunMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

// Same permissive-but-refusable middleware stand-ins routes/fleetDesign.test.ts
// uses: these tests exercise routing/validation/tenancy, not the middleware.
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
    requireMfa: () => async (c: { json: (body: unknown, status: number) => Response }, next: () => Promise<void>) => (
      mfaOkMock() ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)
    ),
    requirePermission: (resource: string, action: string) => async (
      c: { json: (body: unknown, status: number) => Response },
      next: () => Promise<void>,
    ) => (hasPermMock(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)),
  };
});

vi.mock('../services/aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgent: resolveEffectiveAgentMock,
}));

vi.mock('../services/aiAgents/runService', () => ({
  createAndEnqueueAgentRun: createAndEnqueueAgentRunMock,
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: writeRouteAuditMock,
}));

const { patchPlanRoutes } = await import('./patchPlan');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';

function buildApp(authOverrides: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: USER_ID, email: 'tech@example.com', name: 'Tech' },
      principal: { kind: 'user', id: USER_ID },
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: () => undefined,
      ...authOverrides,
    } as never);
    await next();
  });
  app.route('/ai/patch-plan', patchPlanRoutes);
  return app;
}

function postRuns(app: Hono, body: unknown) {
  return app.request('/ai/patch-plan/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  mfaOkMock.mockReturnValue(true);
  resolveEffectiveAgentMock.mockResolvedValue({ agentId: AGENT_ID, kind: 'patch', effective: { enabled: true, mode: 'act' } });
  createAndEnqueueAgentRunMock.mockResolvedValue({ created: true, run: { id: RUN_ID, status: 'queued' } });
});

// Every other suite in this file mounts `patchPlanRoutes` behind a test-only
// middleware that pre-sets `c.set('auth', ...)` (see `buildApp`) — that masks
// whether the router itself ever applies `authMiddleware`, because
// `authMiddleware` no-ops when `auth` is already on the context. This suite
// mounts the router bare, the way `index.ts` does (`api.route('/ai/patch-plan',
// patchPlanRoutes)`, no upstream auth), so it exercises the router's own gate —
// same shape as `routes/fleetDesign.test.ts` (#5866) and `routes/aiAgents.test.ts`.
describe('router auth gate', () => {
  it('is behind authMiddleware', async () => {
    const app = new Hono();
    app.route('/ai/patch-plan', patchPlanRoutes);

    const res = await app.request('/ai/patch-plan/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID }),
    });

    expect(res.status).toBe(401);
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });
});

describe('POST /ai/patch-plan/runs', () => {
  it('admits a device-less patch run and audits it', async () => {
    const res = await postRuns(buildApp(), { orgId: ORG_ID });

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ runId: RUN_ID });

    expect(createAndEnqueueAgentRunMock).toHaveBeenCalledTimes(1);
    const call = createAndEnqueueAgentRunMock.mock.calls[0]![0];
    expect(call).toMatchObject({
      orgId: ORG_ID,
      kind: 'patch',
      profile: 'patch',
      triggerKind: 'manual',
      deviceId: null,
      triggerRef: { requestedByUserId: USER_ID, agentId: AGENT_ID },
    });
    expect(call.dedupeKey).toMatch(/^patch-manual-/);

    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({
      orgId: ORG_ID,
      action: 'ai_patch_plan.run.manual_trigger',
      resourceType: 'ai_agent',
      resourceId: AGENT_ID,
      result: 'success',
      details: { runId: RUN_ID },
    });
  });

  it('404s for an org the caller cannot access — never 403', async () => {
    const res = await postRuns(buildApp(), { orgId: OTHER_ORG_ID });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
    expect(resolveEffectiveAgentMock).not.toHaveBeenCalled();
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('404s no_patch_agent when the org has no effective patch agent', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    const res = await postRuns(buildApp(), { orgId: ORG_ID });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'no_patch_agent' });
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('returns HTTP 200 { success: false, skipped } on a declined admission', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'mode_off' });
    const res = await postRuns(buildApp(), { orgId: ORG_ID });
    // runAction reads an HTTP-200 `success: false` body as a failure, so the
    // "Run now" button can never toast "queued" for a run that never was.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: false, skipped: 'mode_off' });
  });

  it('audits the declined admission as a failure', async () => {
    createAndEnqueueAgentRunMock.mockResolvedValue({ created: false, skipped: 'org_cap' });
    await postRuns(buildApp(), { orgId: ORG_ID });
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({
      action: 'ai_patch_plan.run.manual_trigger',
      result: 'failure',
      details: { skipped: 'org_cap' },
    });
  });

  it('requires ai:write', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await postRuns(buildApp(), { orgId: ORG_ID });
    expect(res.status).toBe(403);
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('requires MFA', async () => {
    mfaOkMock.mockReturnValue(false);
    const res = await postRuns(buildApp(), { orgId: ORG_ID });
    expect(res.status).toBe(403);
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });

  it('rejects a body carrying a deviceId — the patch profile is org-scoped', async () => {
    const res = await postRuns(buildApp(), { orgId: ORG_ID, deviceId: ORG_ID });
    expect(res.status).toBe(400);
    expect(createAndEnqueueAgentRunMock).not.toHaveBeenCalled();
  });
});
