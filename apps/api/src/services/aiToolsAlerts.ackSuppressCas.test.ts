import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * `manage_alerts { action: 'acknowledge' | 'suppress' }` are compare-and-swaps
 * (#4101), the same shape as the `resolve` action (`aiToolsAlerts.resolveCas.test.ts`).
 *
 * Before this change both did read-status-then-UPDATE-by-id and never asked for a
 * `RETURNING` at all, so the tool reported `success: true` and published
 * `alert.acknowledged` / `alert.suppressed` for a write that may have matched zero
 * rows — or, worse, that overwrote a resolution a technician had just performed.
 * An agent step racing a technician is not hypothetical: a retried or duplicated
 * tool call races itself.
 *
 * Two kinds of assertion here, deliberately:
 *
 *  - BEHAVIOUR — an empty `RETURNING` (the CAS matched nothing) must produce the
 *    CAS-lost error and NO fan-out.
 *  - COMPILED SQL — the predicate the handler actually passes to `.where()`,
 *    compiled through `PgDialect`. drizzle-orm and ../db/schema are REAL in this
 *    file for that reason: a mocked-drizzle `where` assertion can only substring-
 *    match column NAMES, which cannot tell `and` from `or` and cannot see the
 *    status list gaining a value that makes the CAS a no-op.
 */
const { dbMock, updateWheres, updateReturns, alertRow } = vi.hoisted(() => {
  const updateWheres: unknown[] = [];
  const updateReturns: unknown[][] = [];
  const alertRow = {
    id: '66666666-6666-4666-8666-666666666666',
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

const ACK_CAS_LOST =
  'Alert is no longer acknowledgeable — its status is no longer active.';
const SUPPRESS_CAS_LOST =
  'Alert is no longer suppressible — it already reached a terminal status (resolved or dismissed).';

function manageAlerts(): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerAlertTools(registry);
  return registry.get('manage_alerts')!.handler;
}

// Unrestricted org caller — see aiToolsAlerts.resolveCas.test.ts. This file is
// about the CAS, not the site axis.
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

const acknowledge = () => manageAlerts()({ action: 'acknowledge', alertId: alertRow.id }, makeAuth());
const suppress = (overrides: Record<string, unknown> = {}) =>
  manageAlerts()({ action: 'suppress', alertId: alertRow.id, suppressDuration: 24, ...overrides }, makeAuth());

beforeEach(() => {
  updateWheres.length = 0;
  updateReturns.length = 0;
  vi.clearAllMocks();
  publishEvent.mockResolvedValue('evt');
  emitAlertStateFeedback.mockResolvedValue(undefined);
  // The pre-read always sees an actionable alert; the race happens after it.
  alertRow.status = 'active';
});

describe('manage_alerts acknowledge — the losing caller', () => {
  it('answers the CAS-lost error instead of claiming success', async () => {
    updateReturns.push([]); // CAS matched nothing

    const result = JSON.parse(await acknowledge());

    expect(result).toEqual({ error: ACK_CAS_LOST });
    expect(result.success).toBeUndefined();
  });

  it('publishes no alert.acknowledged event and emits no ML feedback', async () => {
    updateReturns.push([]);

    await acknowledge();

    expect(publishEvent).not.toHaveBeenCalled();
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
  });
});

describe('manage_alerts acknowledge — the winning caller', () => {
  it('answers success and publishes alert.acknowledged exactly once', async () => {
    updateReturns.push([{ id: alertRow.id }]);

    const result = JSON.parse(await acknowledge());

    expect(result.success).toBe(true);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.acknowledged');
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
  });
});

describe('manage_alerts acknowledge — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by id AND acknowledgeable status', async () => {
    updateReturns.push([{ id: alertRow.id }]);

    await acknowledge();

    expect(updateWheres).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(updateWheres[0] as SQL);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2))');
    expect(params).toEqual([alertRow.id, 'active']);
  });
});

describe('manage_alerts suppress — the losing caller', () => {
  it('answers the CAS-lost error and fans nothing out', async () => {
    updateReturns.push([]); // CAS matched nothing

    const result = JSON.parse(await suppress());

    expect(result).toEqual({ error: SUPPRESS_CAS_LOST });
    expect(publishEvent).not.toHaveBeenCalled();
    expect(emitAlertStateFeedback).not.toHaveBeenCalled();
  });
});

describe('manage_alerts suppress — the winning caller', () => {
  it('answers success and publishes alert.suppressed exactly once', async () => {
    updateReturns.push([{ id: alertRow.id }]);

    const result = JSON.parse(await suppress());

    expect(result.success).toBe(true);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(publishEvent.mock.calls[0]?.[0]).toBe('alert.suppressed');
    expect(emitAlertStateFeedback).toHaveBeenCalledTimes(1);
  });

  it('still refuses a resolved alert at the pre-read', async () => {
    alertRow.status = 'resolved';

    const result = JSON.parse(await suppress());

    expect(result).toEqual({ error: 'Cannot suppress a resolved alert' });
    expect(updateWheres).toHaveLength(0);
  });
});

describe('manage_alerts suppress — the shipped predicate (compiled SQL)', () => {
  it('scopes the UPDATE by id AND suppressible status', async () => {
    updateReturns.push([{ id: alertRow.id }]);

    await suppress();

    expect(updateWheres).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(updateWheres[0] as SQL);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4))');
    expect(params).toEqual([alertRow.id, 'active', 'acknowledged', 'suppressed']);
  });
});
