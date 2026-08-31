import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * manage_alerts { action: 'resolve' } is a compare-and-swap (#4094), the same
 * predicate as POST /alerts/:id/resolve (`alerts.resolveCas.test.ts`) and
 * `resolveAlert` (`alertService.resolveCasSql.test.ts`). Before this PR the tool
 * did read-status-then-UPDATE-by-id: an AI agent step racing a technician's
 * resolve (or another agent step — at-least-once event delivery, tracked for wave
 * 3.5c in #4085 and not yet shipped, will make this
 * likelier than a human double-click) both "won" and both published
 * `alert.resolved`.
 *
 * Two kinds of assertion here, deliberately:
 *
 *  - BEHAVIOUR — an empty `RETURNING` (the CAS matched nothing) must produce the
 *    "no longer resolvable" error and NO fan-out.
 *  - COMPILED SQL — the predicate the handler actually passes to `.where()`,
 *    compiled through `PgDialect`. drizzle-orm and ../db/schema are REAL in this
 *    file for that reason: a mocked-drizzle `where` assertion can only substring-
 *    match column NAMES, which cannot tell `and` from `or` and cannot see the
 *    status list gaining a terminal value. Both mutations were verified to pass
 *    green against exactly that style of test (the wave-3825 test-hardening
 *    pass, `8763a3239`, which is not on main).
 */
const { dbMock, updateWheres, updateReturns, alertRow } = vi.hoisted(() => {
  const updateWheres: unknown[] = [];
  const updateReturns: unknown[][] = [];
  const alertRow = {
    id: '55555555-5555-4555-8555-555555555555',
    orgId: 'org-1',
    deviceId: 'device-1',
    ruleId: null as string | null,
    configPolicyId: null as string | null,
    status: 'active',
    title: 'Disk almost full',
    triggeredAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const dbMock = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([alertRow]) }) }),
    }),
    update: () => ({
      set: () => ({
        where: (predicate: unknown) => {
          updateWheres.push(predicate);
          return { returning: () => Promise.resolve(updateReturns.shift() ?? []) };
        },
      }),
    }),
  };
  return { dbMock, updateWheres, updateReturns, alertRow };
});

const publishEvent = vi.fn((..._args: unknown[]) => Promise.resolve('evt'));
const emitAlertStateFeedback = vi.fn((..._args: unknown[]) => Promise.resolve());

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('./eventBus', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }));
vi.mock('./mlFeedbackEmitters', () => ({ emitAlertStateFeedback: (...a: unknown[]) => emitAlertStateFeedback(...a) }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerAlertTools } from './aiToolsAlerts';

function resolveHandler(): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerAlertTools(registry);
  return registry.get('manage_alerts')!.handler;
}

// Unrestricted org caller: orgCondition a no-op (mirrors an org-scope RLS
// context, which already confines the row) and no canAccessSite, so
// findAlertWithAccess's deviceIdSiteDenied check short-circuits without an
// extra db call — this file is about the resolve CAS, not the site axis.
function makeAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.com', name: 'User', isPlatformAdmin: false },
    token: {} as never,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: (orgId) => orgId === 'org-1',
  } as AuthContext;
}

const resolve = (overrides: Record<string, unknown> = {}) =>
  resolveHandler()({ action: 'resolve', alertId: alertRow.id, ...overrides }, makeAuth());

beforeEach(() => {
  updateWheres.length = 0;
  updateReturns.length = 0;
  vi.clearAllMocks();
  publishEvent.mockResolvedValue('evt');
  emitAlertStateFeedback.mockResolvedValue(undefined);
});

describe('manage_alerts resolve — the losing caller', () => {
  it('answers the CAS-lost error and reports no resolution it did not perform', async () => {
    updateReturns.push([]); // CAS matched nothing: another request got there first

    const result = JSON.parse(await resolve());

    expect(result).toEqual({
      error: 'Alert is no longer resolvable — it already reached a terminal status (resolved or dismissed).',
    });
  });

  it('publishes no alert.resolved event and emits no ML feedback', async () => {
    updateReturns.push([]);

    await resolve();

    // The whole point of the CAS: escalation cancellation and the '*' automation
    // subscriber must see one event per real transition, not one per tool call.
    expect(publishEvent).not.toHaveBeenCalled();
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
  });
});

describe('manage_alerts resolve — the winning caller', () => {
  it('answers success and publishes alert.resolved exactly once', async () => {
    updateReturns.push([{ id: alertRow.id }]);

    const result = JSON.parse(await resolve({ resolutionNote: 'cleared by hand' }));

    expect(result.success).toBe(true);
    expect(result.message).toContain('resolved');
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.resolved');
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
  });
});

describe('manage_alerts resolve — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by id AND resolvable status', async () => {
    updateReturns.push([{ id: alertRow.id }]);

    await resolve();

    expect(updateWheres).toHaveLength(1);
    const dialect = new PgDialect();
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);

    // `or` instead of `and` would stamp every active/acknowledged/suppressed alert
    // in EVERY tenant resolved from one call; dropping the status list makes the
    // write unconditional again; admitting 'resolved' or 'dismissed' makes the CAS
    // a no-op. Each of those changes this string or its params.
    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4))');
    expect(params).toEqual([alertRow.id, 'active', 'acknowledged', 'suppressed']);
  });
});
