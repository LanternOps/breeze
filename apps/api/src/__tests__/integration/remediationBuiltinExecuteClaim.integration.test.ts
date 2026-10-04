/**
 * PR #7939 fix pass A5 — a built-in /execute is dispatched AT MOST ONCE.
 *
 * Before the fix the built-in path dispatched (reboot / kill / restart) and
 * only then flipped the suggestion to `executed`. A retry after a phase-3
 * failure, or two concurrent clicks, both saw `accepted` and both dispatched.
 * The gate now claims the row (accepted -> executed, conditional) in a context
 * that commits before dispatch.
 *
 * Drives the real remediationSuggestionRoutes against real Postgres as
 * breeze_app, with only the device dispatch replaced by a counting fake. The
 * route is self-managed (no request transaction), so the mocked auth
 * middleware opens no DB context — exactly as the real middleware does for a
 * SELF_MANAGED_DB_CONTEXT_ROUTES entry. Must stay real-DB: the concurrency
 * property is a Postgres row-lock + READ COMMITTED re-check, which a mock
 * cannot exhibit.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

type ActiveAuth = { orgId: string; partnerId: string; userId: string };
let activeAuth: ActiveAuth | null = null;

const dispatchCalls = vi.hoisted(() => ({ count: 0 }));
const feedbackFailOnce = vi.hoisted(() => ({ fail: false }));

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuth) return c.json({ error: 'Unauthorized' }, 401);
      const a = activeAuth;
      c.set('auth', {
        principal: { kind: 'user_session' },
        scope: 'organization',
        partnerId: a.partnerId,
        orgId: a.orgId,
        accessibleOrgIds: [a.orgId],
        canAccessOrg: (orgId: string) => orgId === a.orgId,
        orgCondition: () => undefined,
        user: { id: a.userId, email: 'integration@test', name: 'Tech' },
      });
      c.set('permissions', { permissions: [{ resource: 'scripts', action: 'execute' }, { resource: 'devices', action: 'execute' }] });
      // Self-managed route: no request DB context, the handler opens its own phases.
      return next();
    },
    requireScope: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

vi.mock('../../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeRouteAudit: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/fixMemory/builtinActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/fixMemory/builtinActions')>();
  return {
    ...actual,
    dispatchBuiltinAction: vi.fn(async () => {
      dispatchCalls.count += 1;
      // Long enough that a concurrent request reaches its claim while this one is "sending".
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true as const, commandId: randomUUID(), cleanupRunId: null };
    }),
  };
});

vi.mock('../../services/mlFeedbackEmitters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mlFeedbackEmitters')>();
  return {
    ...actual,
    emitRemediationSuggestionFeedback: vi.fn(async (...args: Parameters<typeof actual.emitRemediationSuggestionFeedback>) => {
      if (feedbackFailOnce.fail) {
        feedbackFailOnce.fail = false;
        throw new Error('feedback store unavailable');
      }
      return actual.emitRemediationSuggestionFeedback(...args);
    }),
  };
});

import { db, withSystemDbAccessContext } from '../../db';
import { alerts, devices, fixOutcomes, remediationSuggestions } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

async function buildApp() {
  const { remediationSuggestionRoutes } = await import('../../routes/remediationSuggestions');
  const app = new Hono();
  app.route('/remediation-suggestions', remediationSuggestionRoutes);
  return app;
}

async function seedApprovedBuiltin() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'WS-CLAIM', osType: 'windows', osVersion: '11',
    architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id }));
  const [alert] = await withSystemDbAccessContext(() => db.insert(alerts).values({
    orgId: org.id, deviceId: device!.id, severity: 'high', title: 'Spooler stopped',
  }).returning({ id: alerts.id }));
  const [suggestion] = await withSystemDbAccessContext(() => db.insert(remediationSuggestions).values({
    orgId: org.id, sourceType: 'alert', sourceId: alert!.id, alertId: alert!.id, deviceId: device!.id,
    targetDeviceIds: [device!.id], targetType: 'builtin_action', builtinAction: 'restart_service', title: 'Restart spooler',
    rationale: 'r', expectedAction: 'e', status: 'accepted', riskTier: 'medium', origin: 'memory',
    parameters: { serviceName: 'Spooler' },
  } as never).returning({ id: remediationSuggestions.id }));
  activeAuth = { orgId: org.id, partnerId: partner.id, userId: user.id };
  return { suggestionId: suggestion!.id };
}

const readSuggestion = (id: string) => withSystemDbAccessContext(async () => {
  const [row] = await db.select().from(remediationSuggestions).where(eq(remediationSuggestions.id, id));
  return row!;
});
const outcomesFor = (id: string) => withSystemDbAccessContext(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.suggestionId, id)));

describe('built-in /execute claim (real Postgres, PR #7939 A5)', () => {
  let app: Hono;
  beforeEach(async () => {
    dispatchCalls.count = 0;
    feedbackFailOnce.fail = false;
    app = await buildApp();
  });
  afterEach(() => { activeAuth = null; });

  const execute = (id: string) => app.request(`/remediation-suggestions/${id}/execute`, { method: 'POST', headers: { Authorization: 'Bearer t' } });

  it('a sequential retry after success never dispatches again (409 already_executed)', async () => {
    const { suggestionId } = await seedApprovedBuiltin();
    const first = await execute(suggestionId);
    expect(first.status).toBe(201);
    const second = await execute(suggestionId);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'already_executed' });
    expect(dispatchCalls.count).toBe(1);
    expect(await readSuggestion(suggestionId)).toMatchObject({ status: 'executed' });
    expect(await outcomesFor(suggestionId)).toHaveLength(1);
  });

  it('two concurrent /execute calls dispatch exactly once; the loser gets a 409', async () => {
    const { suggestionId } = await seedApprovedBuiltin();
    const results = await Promise.all([execute(suggestionId), execute(suggestionId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(dispatchCalls.count).toBe(1);
    expect(await outcomesFor(suggestionId)).toHaveLength(1);
  });

  it('the true race: both gates read `accepted` before either claims — the conditional claim still admits one', async () => {
    const { suggestionId } = await seedApprovedBuiltin();
    // A separate connection holds the row lock, so both requests pass their (non-locking)
    // gate reads and then queue on the claim UPDATE. Releasing it lets one claim win; the
    // other re-evaluates its WHERE under READ COMMITTED and must match nothing.
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((r) => { lockedResolve = r; });
    const holder = withSystemDbAccessContext(async () => {
      await db.execute(sql`SELECT id FROM remediation_suggestions WHERE id = ${suggestionId} FOR UPDATE`);
      lockedResolve();
      await released;
    });
    await locked;
    const inFlight = Promise.all([execute(suggestionId), execute(suggestionId)]);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await withSystemDbAccessContext(() => db.execute(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE 'update "remediation_suggestions"%'`)) as unknown as Array<{ n: number }>;
      if ((row?.n ?? 0) >= 2 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await holder;
    const results = await inFlight;
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(dispatchCalls.count).toBe(1);
    expect(await outcomesFor(suggestionId)).toHaveLength(1);
  });

  it('dispatch ok but phase 3 fails: 202 with the commandId, the claim stays, and a retry still does not dispatch', async () => {
    const { suggestionId } = await seedApprovedBuiltin();
    feedbackFailOnce.fail = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const first = await execute(suggestionId);
    err.mockRestore();
    expect(first.status).toBe(202);
    const body = await first.json();
    expect(body).toMatchObject({ dispatched: true, recorded: false, commandId: expect.any(String) });
    // Phase 3 rolled back (no outcome row), but the committed claim survives.
    expect(await readSuggestion(suggestionId)).toMatchObject({ status: 'executed' });
    expect(await outcomesFor(suggestionId)).toHaveLength(0);
    const retry = await execute(suggestionId);
    expect(retry.status).toBe(409);
    expect(dispatchCalls.count).toBe(1);
  });

  it('a refused dispatch releases the claim back to accepted, so the technician can try again', async () => {
    const { suggestionId } = await seedApprovedBuiltin();
    const { dispatchBuiltinAction } = await import('../../services/fixMemory/builtinActions');
    vi.mocked(dispatchBuiltinAction).mockImplementationOnce(async () => {
      dispatchCalls.count += 1;
      return { ok: false as const, status: 409, error: 'process_ambiguous' };
    });
    const refused = await execute(suggestionId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'process_ambiguous' });
    expect(await readSuggestion(suggestionId)).toMatchObject({ status: 'accepted', executedBy: null, executedAt: null });
    expect(await outcomesFor(suggestionId)).toHaveLength(0);
    const again = await execute(suggestionId);
    expect(again.status).toBe(201);
    expect(dispatchCalls.count).toBe(2);
  });
});
