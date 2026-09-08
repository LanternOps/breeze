import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AI_OPERATOR_TASK_LEAK_TRIPWIRE_KEYS } from '@breeze/shared';

const { selectMock, hasPermMock, authOkMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  hasPermMock: vi.fn<(resource: string, action: string) => boolean>(() => true),
  authOkMock: vi.fn(() => true),
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
    buildOrgAccessClosures: actual.buildOrgAccessClosures,
  };
});

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
