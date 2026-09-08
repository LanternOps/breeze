import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS } from '@breeze/shared';

const {
  selectMock, hasPermMock, authOkMock, mfaOkMock,
  tasksEnabledMock, recipeEnabledMock, admitMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  authOkMock: vi.fn(() => true),
  mfaOkMock: vi.fn(() => true),
  tasksEnabledMock: vi.fn(() => true),
  recipeEnabledMock: vi.fn(() => true),
  admitMock: vi.fn(),
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    authMiddleware: async (
      c: { json: (body: unknown, status: number) => Response },
      next: () => Promise<void>,
    ) => (authOkMock() ? next() : c.json({ error: 'Unauthorized' }, 401)),
    requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
    requirePermission: (resource: string, action: string) => async (
      c: { json: (body: unknown, status: number) => Response },
      next: () => Promise<void>,
    ) => (hasPermMock(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)),
    // W08: the POST admission route is MFA step-up gated, same as
    // `POST /ai/agents/:id/runs`. Mocked with the real middleware's own
    // failure shape so a test can prove the gate is wired, not just present.
    requireMfa: () => async (
      c: { json: (body: unknown, status: number) => Response },
      next: () => Promise<void>,
    ) => (mfaOkMock() ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)),
    buildOrgAccessClosures: actual.buildOrgAccessClosures,
  };
});

vi.mock('../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  aiOperatorTasksEnabled: () => tasksEnabledMock(),
  aiOperatorServiceRecoveryEnabled: () => recipeEnabledMock(),
}));

vi.mock('../services/aiOperator/taskService', () => ({
  admitServiceRecoveryTask: (input: unknown) => admitMock(input),
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
}));

import { aiOperatorTasksRoutes } from './aiOperatorTasks';

const ORG_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ORG_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '66666666-6666-4666-8666-666666666666';

function selectChain<T>(
  rows: T,
  onWhere?: (predicate: unknown) => void,
) {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    // The list route builds its query with `.$dynamic()` so the site-visibility
    // LEFT JOIN can be attached conditionally (review fix, PR #5254) —
    // without this the real drizzle builder (and this mock) has no
    // `.$dynamic` method and the route 500s before ever reaching `.where()`.
    $dynamic: () => chain,
    where: (predicate: unknown) => { onWhere?.(predicate); return chain; },
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

const dialect = new PgDialect();
function sqlText(predicate: unknown): string {
  return dialect.sqlToQuery(predicate as SQL).sql;
}

function buildApp(authOverrides: Record<string, unknown> = {}): Hono {
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
      allowedSiteIds: undefined,
      canAccessSite: () => true,
      ...authOverrides,
    } as never);
    await next();
  });
  app.route('/ai/operator', aiOperatorTasksRoutes);
  return app;
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    agentKind: 'triage',
    agentName: 'Triage Agent',
    workflowKey: 'recover-service',
    workflowVersion: 1,
    mode: 'live',
    originKind: 'manual',
    objective: 'Recover the stopped print spooler service',
    deviceId: DEVICE_ID,
    targetLabel: 'WKS-042',
    targetDetachedAt: null,
    targetDetachedReason: null,
    state: 'running',
    phase: 'execute',
    waitReason: null,
    waitDependencyKind: null,
    waitDependencyId: null,
    revision: 1,
    attemptOrdinal: 0,
    currentStepKey: 'restart-service',
    deadlineAt: null,
    nextWakeAt: null,
    outcome: null,
    outcomeDetail: null,
    handoffSummary: null,
    accountingRootTaskId: TASK_ID,
    successorOfTaskId: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    createdAtRaw: '2026-09-01T00:00:00.000000Z',
    updatedAt: new Date('2026-09-01T00:05:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  authOkMock.mockReturnValue(true);
});

describe('GET /ai/operator/tasks (org-wide keyset list)', () => {
  it('is gated on ai_agents:read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request('/ai/operator/tasks');
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns a page with no nextCursor when fewer rows than the limit come back', async () => {
    selectMock.mockReturnValueOnce(selectChain([taskRow()]));
    const res = await buildApp().request('/ai/operator/tasks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
    expect(body.data[0]).toMatchObject({ id: TASK_ID, orgId: ORG_ID, state: 'running' });
    expect(body.data[0].agent).toEqual({ id: AGENT_ID, kind: 'triage', name: 'Triage Agent' });
  });

  it('returns a nextCursor and trims the peeked row when a full extra page comes back', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => taskRow({
      id: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`,
      createdAt: new Date(Date.UTC(2026, 7, 28, 10, 0, i)),
      createdAtRaw: `2026-08-28T10:00:${String(i).padStart(2, '0')}.000000Z`,
    }));
    selectMock.mockReturnValueOnce(selectChain(rows));
    const res = await buildApp().request('/ai/operator/tasks');
    const body = await res.json();
    expect(body.data).toHaveLength(25);
    expect(body.nextCursor).not.toBeNull();
  });

  it('rejects a malformed cursor with 400 before touching the database', async () => {
    const res = await buildApp().request('/ai/operator/tasks?cursor=not-valid-base64url!!!');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects a limit above the 50 ceiling', async () => {
    const res = await buildApp().request('/ai/operator/tasks?limit=51');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized state filter', async () => {
    const res = await buildApp().request('/ai/operator/tasks?state=bogus_state');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed deviceId filter', async () => {
    const res = await buildApp().request('/ai/operator/tasks?deviceId=not-a-uuid');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('binds the site-restricted caller\'s allowedSiteIds into the query predicate', async () => {
    const siteId = '99999999-9999-4999-8999-999999999999';
    let capturedPredicate: unknown;
    selectMock.mockReturnValueOnce(selectChain([taskRow()], (p) => { capturedPredicate = p; }));

    const res = await buildApp({ allowedSiteIds: [siteId], canAccessSite: (id: string | null) => id === siteId })
      .request('/ai/operator/tasks');
    expect(res.status).toBe(200);
    // The site-restriction branch binds the allowlist directly into SQL —
    // proves the route actually built a site-scoped predicate rather than
    // silently trusting the mocked db to filter.
    expect(sqlText(capturedPredicate)).toContain('site_id');
  });

  it('never leaks a tripwire key on any list-item DTO', async () => {
    selectMock.mockReturnValueOnce(selectChain([taskRow()]));
    const res = await buildApp().request('/ai/operator/tasks');
    const json = JSON.stringify(await res.json());
    for (const forbidden of AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}":`);
    }
  });
});

describe('GET /ai/operator/tasks/:id (detail)', () => {
  it('is gated on ai_agents:read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(`/ai/operator/tasks/${TASK_ID}`);
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('404s on a non-uuid id without touching the database', async () => {
    const res = await buildApp().request('/ai/operator/tasks/not-a-uuid');
    expect(res.status).toBe(404);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('404s non-enumerating when the task row is not found (cross-org or nonexistent)', async () => {
    selectMock.mockReturnValueOnce(selectChain([]));
    const res = await buildApp().request(`/ai/operator/tasks/${TASK_ID}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Task not found');
  });

  it('returns the task with projected operations and linked runs', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([taskRow()]))
      .mockReturnValueOnce(selectChain([
        {
          operationKey: 'restart-service:0',
          attemptOrdinal: 0,
          intentId: 'intent-1',
          dispatchState: 'dispatched',
          resultState: 'succeeded',
          executionRefKind: 'device_command',
          executionRefId: 'cmd-1',
          dispatchedAt: new Date('2026-09-01T00:01:00.000Z'),
          resultAt: new Date('2026-09-01T00:02:00.000Z'),
        },
      ]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'run-1',
          status: 'completed',
          taskAttemptOrdinal: 0,
          promptVersion: 'v3',
          resolvedModel: 'claude-opus-4-5',
        },
      ]));

    const res = await buildApp().request(`/ai/operator/tasks/${TASK_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(TASK_ID);
    expect(body.data.operations).toHaveLength(1);
    expect(body.data.operations[0]).toMatchObject({ operationKey: 'restart-service:0', resultState: 'succeeded' });
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.runs[0]).toMatchObject({ id: 'run-1', status: 'completed' });
  });

  it('never leaks a tripwire key (checkpoint/result/etc.) on the detail DTO', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([taskRow()]))
      .mockReturnValueOnce(selectChain([
        {
          operationKey: 'restart-service:0',
          attemptOrdinal: 0,
          intentId: 'intent-1',
          dispatchState: 'dispatched',
          resultState: 'succeeded',
          executionRefKind: 'device_command',
          executionRefId: 'cmd-1',
          dispatchedAt: new Date('2026-09-01T00:01:00.000Z'),
          resultAt: new Date('2026-09-01T00:02:00.000Z'),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const res = await buildApp().request(`/ai/operator/tasks/${TASK_ID}`);
    const json = JSON.stringify(await res.json());
    for (const forbidden of AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}":`);
    }
  });

  it('binds the site-restricted caller\'s allowedSiteIds into the detail query predicate', async () => {
    const siteId = '99999999-9999-4999-8999-999999999999';
    let capturedPredicate: unknown;
    selectMock.mockReturnValueOnce(selectChain([taskRow()], (p) => { capturedPredicate = p; }));
    selectMock.mockReturnValueOnce(selectChain([]));
    selectMock.mockReturnValueOnce(selectChain([]));

    await buildApp({ allowedSiteIds: [siteId], canAccessSite: (id: string | null) => id === siteId })
      .request(`/ai/operator/tasks/${TASK_ID}`);
    expect(sqlText(capturedPredicate)).toContain('site_id');
  });
});

/**
 * W08 (#5246) — `POST /ai/operator/tasks`, the only route that creates a task.
 *
 * Every case below is a REFUSAL contract except the 202s, because the whole
 * value of this route is what it declines to admit: each accepted task can
 * dispatch a real service restart to a customer machine.
 */
describe('POST /ai/operator/tasks (W08 admission)', () => {
  const SITE_ID = '99999999-9999-4999-8999-999999999999';
  const ADMITTED_TASK_ID = '77777777-7777-4777-8777-777777777777';

  function body(overrides: Record<string, unknown> = {}) {
    return {
      mode: 'live',
      recipeKey: 'service_recovery',
      recipeVersion: 1,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      inputs: { serviceName: 'spooler' },
      clientIdempotencyKey: 'delegate-abcdef0123456789',
      ...overrides,
    };
  }

  function post(payload: unknown, authOverrides: Record<string, unknown> = {}) {
    return buildApp(authOverrides).request('/ai/operator/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  const deviceRow = { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, hostname: 'WS-01' };

  /** device row, then agent row, then the pending-cap count. */
  function happyPathSelects(pendingCount = 0) {
    selectMock.mockReturnValueOnce(selectChain([deviceRow]));
    selectMock.mockReturnValueOnce(selectChain([{ id: AGENT_ID }]));
    selectMock.mockReturnValueOnce(selectChain([{ count: pendingCount }]));
  }

  beforeEach(() => {
    selectMock.mockClear();
    admitMock.mockClear();
    mfaOkMock.mockReturnValue(true);
    hasPermMock.mockReturnValue(true);
    tasksEnabledMock.mockReturnValue(true);
    recipeEnabledMock.mockReturnValue(true);
    admitMock.mockResolvedValue({ ok: true, taskId: ADMITTED_TASK_ID, replayed: false });
  });

  it('admits a valid request with 202 and the new task id', async () => {
    happyPathSelects();
    const res = await post(body());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ taskId: ADMITTED_TASK_ID, replayed: false });
  });

  it('passes the client idempotency key and the resolved agent through to admission', async () => {
    happyPathSelects();
    await post(body());
    expect(admitMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      clientIdempotencyKey: 'delegate-abcdef0123456789',
      requesterUserId: USER_ID,
      recipeInput: expect.objectContaining({ deviceId: DEVICE_ID, serviceName: 'spooler' }),
    }));
  });

  it('returns the SAME task id with 202 on an idempotent replay', async () => {
    happyPathSelects();
    admitMock.mockResolvedValue({ ok: true, taskId: ADMITTED_TASK_ID, replayed: true });
    const res = await post(body());
    expect(res.status).toBe(202);
    // Identical id to the first admission: a replay is indistinguishable to
    // the client, which is what stops a double-click becoming two restarts.
    expect(await res.json()).toEqual({ taskId: ADMITTED_TASK_ID, replayed: true });
  });

  it('records origin `alert` and threads the alert id into the verification criterion', async () => {
    happyPathSelects();
    const alertId = '88888888-8888-4888-8888-888888888888';
    await post(body({ sourceKind: 'alert', sourceId: alertId }));
    expect(admitMock).toHaveBeenCalledWith(expect.objectContaining({
      originKind: 'alert',
      recipeInput: expect.objectContaining({ triggeringAlertId: alertId }),
    }));
  });

  it('records origin `manual` and a null alert id for a device-page delegate', async () => {
    happyPathSelects();
    await post(body({ sourceKind: 'device', sourceId: DEVICE_ID }));
    expect(admitMock).toHaveBeenCalledWith(expect.objectContaining({
      originKind: 'manual',
      recipeInput: expect.objectContaining({ triggeringAlertId: null }),
    }));
  });

  // ---- Spec §12: "Requests cannot supply a principal, effective policy,
  // approval result, or trusted continuation token." ----

  it.each(['task', 'policySnapshot', 'approval', 'principal', 'agentId'])(
    'rejects a body carrying a forged `%s` field before any admission',
    async (field) => {
      const res = await post(body({ [field]: { forged: true } }));
      expect(res.status).toBe(400);
      expect(admitMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a trial mode through the live admission route', async () => {
    const res = await post(body({ mode: 'trial' }));
    expect(res.status).toBe(400);
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('rejects a request with no idempotency key', async () => {
    const payload = body() as Record<string, unknown>;
    delete payload.clientIdempotencyKey;
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('rejects a source id with no source kind', async () => {
    const res = await post(body({ sourceId: DEVICE_ID }));
    expect(res.status).toBe(400);
  });

  // ---- RBAC / MFA (spec §5.1) ----

  it('requires ai_agents:write, not merely ai_agents:read', async () => {
    hasPermMock.mockImplementation((_r, action) => action !== 'write');
    const res = await post(body());
    expect(res.status).toBe(403);
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('requires the MFA step-up', async () => {
    mfaOkMock.mockReturnValue(false);
    const res = await post(body());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(admitMock).not.toHaveBeenCalled();
  });

  // ---- Target authorization: non-enumerating 404 (spec §12) ----

  it('404s without touching the database when the org is outside the caller access', async () => {
    const res = await post(body({ orgId: OTHER_ORG_ID }), { canAccessOrg: () => false });
    expect(res.status).toBe(404);
    expect(selectMock).not.toHaveBeenCalled();
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('404s when the device does not resolve inside the named org', async () => {
    selectMock.mockReturnValueOnce(selectChain([]));
    const res = await post(body());
    expect(res.status).toBe(404);
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('404s (not 403) for a device outside a site-restricted caller sites', async () => {
    selectMock.mockReturnValueOnce(selectChain([
      { ...deviceRow, siteId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    ]));
    const res = await post(body(), {
      allowedSiteIds: [SITE_ID],
      canAccessSite: (id: string | null) => id === SITE_ID,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Device not found' });
    expect(admitMock).not.toHaveBeenCalled();
  });

  // ---- Readiness, recomputed on launch (spec §12) ----

  it('422s with an actionable reason when the task infrastructure flag is off', async () => {
    tasksEnabledMock.mockReturnValue(false);
    selectMock.mockReturnValueOnce(selectChain([deviceRow]));
    const res = await post(body());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_TASKS_DISABLED' });
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('422s when the service-recovery recipe flag is off', async () => {
    recipeEnabledMock.mockReturnValue(false);
    selectMock.mockReturnValueOnce(selectChain([deviceRow]));
    const res = await post(body());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_RECIPE_DISABLED' });
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('422s rather than silently upgrading a stale reviewed recipe version', async () => {
    selectMock.mockReturnValueOnce(selectChain([deviceRow]));
    const res = await post(body({ recipeVersion: 99 }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_RECIPE_VERSION_MISMATCH' });
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('422s when the org has no enabled agent to run the task', async () => {
    selectMock.mockReturnValueOnce(selectChain([deviceRow]));
    selectMock.mockReturnValueOnce(selectChain([]));
    const res = await post(body());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_NO_AGENT' });
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('surfaces an admission refusal as 422 with its reason', async () => {
    happyPathSelects();
    admitMock.mockResolvedValue({ ok: false, refusal: 'invalid_input', detail: 'serviceName is required' });
    const res = await post(body());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'serviceName is required', code: 'INVALID_INPUT' });
  });

  it('keeps an admission-time device refusal non-enumerating (404, not 422)', async () => {
    happyPathSelects();
    admitMock.mockResolvedValue({ ok: false, refusal: 'device_not_in_org', detail: 'device x is not in org y' });
    const res = await post(body());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Device not found' });
  });

  // ---- Capacity (spec §7.2: pending cap 100 per org) ----

  it('429s when the org is already at the pending-task cap', async () => {
    happyPathSelects(100);
    const res = await post(body());
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'OPERATOR_PENDING_CAP_REACHED' });
    expect(admitMock).not.toHaveBeenCalled();
  });

  it('admits at one below the cap', async () => {
    happyPathSelects(99);
    const res = await post(body());
    expect(res.status).toBe(202);
  });

  it('counts the cap over non-terminal states for the ONE named org', async () => {
    let capturedPredicate: unknown;
    selectMock.mockReturnValueOnce(selectChain([deviceRow]));
    selectMock.mockReturnValueOnce(selectChain([{ id: AGENT_ID }]));
    selectMock.mockReturnValueOnce(selectChain([{ count: 0 }], (p) => { capturedPredicate = p; }));
    await post(body());
    const text = sqlText(capturedPredicate).toLowerCase();
    expect(text).toContain('org_id');
    expect(text).toContain('not in');
  });
});
