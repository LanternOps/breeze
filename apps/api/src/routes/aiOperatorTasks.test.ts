import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS } from '@breeze/shared';

const { selectMock, hasPermMock, authOkMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  authOkMock: vi.fn(() => true),
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  // Real `buildOrgAccessClosures` (via importOriginal) — same review-round-1
  // rationale as `routes/aiAgents.test.ts`: a test wiring `auth.orgCondition`
  // through it exercises the exact eq/inArray shape authMiddleware installs,
  // not a test-only approximation.
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
    buildOrgAccessClosures: actual.buildOrgAccessClosures,
  };
});

vi.mock('../db', () => ({ db: { select: selectMock } }));

import { aiOperatorTasksRoutes } from './aiOperatorTasks';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const SITE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_SITE_ID = '66666666-6666-4666-8666-666666666666';
const USER_ID = '77777777-7777-4777-8777-777777777777';

function selectChain<T>(rows: T) {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    agentKind: 'triage',
    agentName: 'Triage',
    workflowKey: 'recover_service',
    workflowVersion: 1,
    mode: 'live',
    originKind: 'manual',
    objective: 'Recover the stopped print spooler service',
    deviceId: DEVICE_ID,
    targetLabel: 'DESKTOP-ACME01',
    targetDetachedAt: null,
    targetDetachedReason: null,
    state: 'running',
    phase: 'execute',
    waitReason: null,
    waitDependencyKind: null,
    waitDependencyId: null,
    revision: 1,
    attemptOrdinal: 0,
    currentStepKey: 'restart_service',
    deadlineAt: null,
    nextWakeAt: null,
    outcome: null,
    outcomeDetail: null,
    handoffSummary: null,
    accountingRootTaskId: null,
    successorOfTaskId: null,
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-01T10:05:00.000Z'),
    updatedAtRaw: '2026-09-01T10:05:00.000000Z',
    ...overrides,
  };
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
      canAccessOrg: (id: string) => id === ORG_ID,
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

beforeEach(() => {
  vi.clearAllMocks();
  hasPermMock.mockReturnValue(true);
  authOkMock.mockReturnValue(true);
});

describe('GET /ai/operator/tasks/:id', () => {
  it('is gated on ai_agents:read', async () => {
    hasPermMock.mockReturnValue(false);
    const res = await buildApp().request(`/ai/operator/tasks/${TASK_ID}`);
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('404s on a malformed id before touching the database', async () => {
    const res = await buildApp().request('/ai/operator/tasks/not-a-uuid');
    expect(res.status).toBe(404);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('404s (non-enumerating) when the task row is not found under the caller\'s org scope', async () => {
    selectMock.mockReturnValueOnce(selectChain([]));
    const res = await buildApp().request(`/ai/operator/tasks/${TASK_ID}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    // Non-enumerating: same message shape as a malformed id, never
    // "exists but you can't see it".
    expect(body.error).toBe('Task not found');
  });

  it('returns the safe-projected detail DTO with operations and linked runs', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([taskRow()])) // task
      .mockReturnValueOnce(selectChain([
        {
          operationKey: 'restart_service:print_spooler',
          attemptOrdinal: 0,
          intentId: null,
          dispatchState: 'dispatched',
          resultState: 'pending',
          executionRefKind: 'device_command',
          executionRefId: '88888888-8888-4888-8888-888888888888',
          dispatchedAt: new Date('2026-09-01T10:01:00.000Z'),
          resultAt: null,
        },
      ])) // operations
      .mockReturnValueOnce(selectChain([
        {
          id: '99999999-9999-4999-8999-999999999999',
          status: 'completed',
          taskAttemptOrdinal: 0,
          promptVersion: 'v3',
          resolvedModel: 'claude-opus-4-5',
        },
      ])); // runs

    const res = await buildApp().request(`/ai/operator/tasks/${TASK_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(TASK_ID);
    expect(body.data.agent).toEqual({ id: AGENT_ID, kind: 'triage', name: 'Triage' });
    expect(body.data.operations).toHaveLength(1);
    expect(body.data.operations[0].operationKey).toBe('restart_service:print_spooler');
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.runs[0].id).toBe('99999999-9999-4999-8999-999999999999');
  });

  it('never carries a leak-tripwire key in the serialized response', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([taskRow()]))
      .mockReturnValueOnce(selectChain([
        {
          operationKey: 'restart_service:print_spooler',
          attemptOrdinal: 0,
          intentId: null,
          dispatchState: 'dispatched',
          resultState: 'pending',
          executionRefKind: 'device_command',
          executionRefId: '88888888-8888-4888-8888-888888888888',
          dispatchedAt: null,
          resultAt: null,
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const res = await buildApp().request(`/ai/operator/tasks/${TASK_ID}`);
    const body = await res.json();
    const json = JSON.stringify(body);
    for (const forbidden of AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
  });

  it('404s when the caller is site-restricted and the task device is outside the allowlist (new site-visibility behaviour)', async () => {
    // The route's WHERE predicate is mocked to a no-op (selectChain ignores
    // it), so this proves the CALLER-SIDE contract: with allowedSiteIds set
    // and the device's site excluded, the route's own predicate — not RLS —
    // must be what filters the row out. Since selectChain always returns
    // whatever rows it's given regardless of the predicate, this test seeds
    // an EMPTY result to represent what the real predicate produces once the
    // caller is site-restricted; the companion integration test proves the
    // real SQL predicate does the filtering against a live database.
    selectMock.mockReturnValueOnce(selectChain([]));
    const res = await buildApp({ allowedSiteIds: [OTHER_SITE_ID], canAccessSite: (id: string) => id === OTHER_SITE_ID })
      .request(`/ai/operator/tasks/${TASK_ID}`);
    expect(res.status).toBe(404);
  });

  it('does not site-restrict an unrestricted (partner/system-scope) caller', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([taskRow()]))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([]));
    const res = await buildApp({ allowedSiteIds: undefined }).request(`/ai/operator/tasks/${TASK_ID}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /ai/operator/tasks (list)', () => {
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
    expect(body.data[0]).not.toHaveProperty('operations');
    expect(body.data[0]).not.toHaveProperty('runs');
  });

  it('returns a nextCursor and trims the peeked row when a full extra page comes back', async () => {
    const makeRow = (i: number) => taskRow({
      id: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`,
      updatedAtRaw: `2026-09-01T10:00:${String(i).padStart(2, '0')}.000000Z`,
    });
    const rows = Array.from({ length: 26 }, (_, i) => makeRow(i));
    selectMock.mockReturnValueOnce(selectChain(rows));

    const res = await buildApp().request('/ai/operator/tasks');
    expect(res.status).toBe(200);
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

  it('never carries a leak-tripwire key on any list item', async () => {
    selectMock.mockReturnValueOnce(selectChain([taskRow()]));
    const res = await buildApp().request('/ai/operator/tasks');
    const body = await res.json();
    const json = JSON.stringify(body);
    for (const forbidden of AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
  });
});
