/**
 * #12299: platform-admin partner and signal tools must reach other partners'
 * rows when the admin's request carries a partner-scoped DB context.
 *
 * A platform admin who also holds a partner membership gets a partner-scoped
 * token, so the request transaction opened by the auth middleware is scoped to
 * that partner (A). A `withSystemDbAccessContext` nested inside that
 * transaction keeps A's context instead of opening a system one, so a route
 * acting on another partner (B) saw nothing: suspend and unsuspend answered
 * 404 "partner not found", the signals list came back empty, acknowledge
 * answered 404, and the org lookups in tenant export and tenant erasure
 * answered 404 "org not found".
 *
 * Every test runs the real admin router (real platformAdminMiddleware, real
 * route handlers) over a mocked authMiddleware that opens a REAL
 * partner-scoped `withDbAccessContext` for partner A, built through the same
 * `buildDbAccessContext` the production middleware uses, against Postgres as
 * `breeze_app` (forced RLS). Final state is read over the superuser test
 * connection.
 *
 * Negative controls:
 *  - a partner user WITHOUT the platform-admin flag gets 403 on every route
 *    and partner B's rows stay unchanged;
 *  - after each handler returns, a probe inside the same request context
 *    still cannot see partner B's row or any abuse signal: the request's own
 *    RLS scope is unchanged by the fix.
 *  - the signals list under a system-scoped request context returns B's rows
 *    (the red below is the partner-scoped context, not the harness).
 *
 * Run:
 *   pnpm test-stack up   # worktree root
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/adminAbuseSystemScope.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';

type ActiveAuth = {
  scope: 'partner' | 'system';
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  userId: string;
  email: string;
  isPlatformAdmin: boolean;
};

let activeAuth: ActiveAuth | null = null;
let probeOtherPartnerId: string | null = null;
/** What the request's own context could see AFTER the handler returned. */
let probeResult: { partnerRows: number; signalRows: number } | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const dbModule = await import('../../db');
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      if (!activeAuth) return c.json({ error: 'Unauthorized' }, 401);
      const a = activeAuth;
      c.set('auth', {
        scope: a.scope,
        partnerId: a.partnerId,
        partnerOrgAccess: 'all',
        orgId: null,
        accessibleOrgIds: a.accessibleOrgIds,
        user: { id: a.userId, email: a.email, name: 'Admin', isPlatformAdmin: a.isPlatformAdmin },
        token: { mfa: true },
      });
      return dbModule.withDbAccessContext(
        actual.buildDbAccessContext({
          scope: a.scope,
          orgId: null,
          accessibleOrgIds: a.accessibleOrgIds,
          partnerId: a.partnerId,
          userId: a.userId,
        }),
        async () => {
          await next();
          if (probeOtherPartnerId) {
            const [p] = await dbModule.db.execute(
              sql`SELECT count(*)::int AS n FROM partners WHERE id = ${probeOtherPartnerId}`,
            ) as unknown as Array<{ n: number }>;
            const [s] = await dbModule.db.execute(
              sql`SELECT count(*)::int AS n FROM partner_abuse_signals`,
            ) as unknown as Array<{ n: number }>;
            probeResult = { partnerRows: p?.n ?? -1, signalRows: s?.n ?? -1 };
          }
        },
      );
    },
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

// The evidence-card action requires a fresh TOTP; the step-up check itself is
// not under test here (the suspend it leads to is).
vi.mock('../../routes/auth/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/helpers')>();
  return { ...actual, requireFreshMfaStepUp: vi.fn(async () => null) };
});

const enqueueTenantErasureMock = vi.fn(async (_payload: unknown) => ({ id: 'job-test' }));
vi.mock('../../jobs/tenantErasure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/tenantErasure')>();
  return { ...actual, enqueueTenantErasure: (p: unknown) => enqueueTenantErasureMock(p) };
});

import {
  auditLogs,
  deviceCommands,
  partnerAbuseSignals,
  partners,
  refreshTokenFamilies,
  users,
} from '../../db/schema';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { mintTrustActionToken } from '../../services/partnerTrustEvidenceCard';
import {
  assignUserToPartner,
  createDevice,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
} from './db-utils';
import { getTestDb } from './setup';
import { insertHoldRaw, markMergedShell } from './orgEvidenceHoldFixture';
import { EVIDENCE_HOLD_DEFERRED_ACTION } from '../../services/orgEvidenceHold';

async function buildApp() {
  const { adminRoutes } = await import('../../routes/admin');
  const app = new Hono();
  app.route('/admin', adminRoutes);
  return app;
}

function uniqEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/**
 * Partner A holds the caller; partner B is the target with an org, device,
 * an active user carrying a refresh family, and two open abuse signals.
 */
async function seed(opts: { platformAdmin: boolean }) {
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const roleA = await createRole({ scope: 'partner', partnerId: partnerA.id });
  const callerEmail = uniqEmail('caller');
  const caller = await createUser({ partnerId: partnerA.id, email: callerEmail, status: 'active' });
  await assignUserToPartner(caller.id, partnerA.id, roleA.id, 'all');
  if (opts.platformAdmin) {
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, caller.id));
  }

  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const siteB = await createSite({ orgId: orgB.id });
  const deviceB = await createDevice({ orgId: orgB.id, siteId: siteB.id });
  const userB = await createUser({ partnerId: partnerB.id, email: uniqEmail('target'), status: 'active' });
  const familyB = await mintRefreshTokenFamily(userB.id);

  const signals = await getTestDb()
    .insert(partnerAbuseSignals)
    .values([
      { partnerId: partnerB.id, signalKey: 'test_signal_one', severity: 'alert', score: 5 },
      { partnerId: partnerB.id, signalKey: 'test_signal_two', severity: 'watch', score: 3 },
    ])
    .returning({ id: partnerAbuseSignals.id });

  activeAuth = {
    scope: 'partner',
    partnerId: partnerA.id,
    accessibleOrgIds: [orgA.id],
    userId: caller.id,
    email: callerEmail,
    isPlatformAdmin: opts.platformAdmin,
  };
  probeOtherPartnerId = partnerB.id;

  return {
    partnerA, orgA, caller, callerEmail,
    partnerB, orgB, deviceB, userB, familyB,
    signalIds: signals.map((s) => s.id),
  };
}

async function partnerStatus(id: string) {
  const [row] = await getTestDb().select({ status: partners.status }).from(partners).where(eq(partners.id, id));
  return row?.status;
}

async function signalRow(id: string) {
  const [row] = await getTestDb().select().from(partnerAbuseSignals).where(eq(partnerAbuseSignals.id, id));
  return row;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** The request's own partner-A context saw neither B's partner row nor any signal. */
function expectRequestScopeUnchanged() {
  expect(probeResult).toEqual({ partnerRows: 0, signalRows: 0 });
}

async function markSuspended(partnerId: string, userId: string) {
  await getTestDb().update(partners).set({ status: 'suspended' }).where(eq(partners.id, partnerId));
  await getTestDb()
    .update(users)
    .set({ status: 'disabled', disabledReason: 'partner_suspended' })
    .where(eq(users.id, userId));
}

async function seedLegalHold(orgId: string, deviceId: string) {
  const testDb = getTestDb();
  const [config] = (await testDb.execute(sql`
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (${orgId}, 'Legal hold fixture', 'file', 'local', '{}') RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [job] = (await testDb.execute(sql`
    INSERT INTO backup_jobs (org_id, config_id, device_id)
    VALUES (${orgId}, ${config!.id}, ${deviceId}) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  await testDb.execute(sql`
    INSERT INTO backup_snapshots (org_id, job_id, device_id, snapshot_id, legal_hold)
    VALUES (${orgId}, ${job!.id}, ${deviceId}, ${crypto.randomUUID()}, true)
  `);
}

beforeEach(() => {
  activeAuth = null;
  probeOtherPartnerId = null;
  probeResult = null;
  enqueueTenantErasureMock.mockClear();
});
afterEach(() => {
  activeAuth = null;
  probeOtherPartnerId = null;
  probeResult = null;
});

describe('platform admin with a partner-scoped request context acting on another partner (#12299)', () => {
  it('POST /admin/partners/:id/suspend-for-abuse suspends partner B', async () => {
    const s = await seed({ platformAdmin: true });
    const app = await buildApp();

    const res = await app.request(
      `/admin/partners/${s.partnerB.id}/suspend-for-abuse`,
      json({ confirmEmail: s.callerEmail, reason: 'integration test suspend' }),
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toEqual({ error: 'partner not found' });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ partnerId: s.partnerB.id, status: 'suspended', deviceCount: 1, userCount: 1 });

    expect(await partnerStatus(s.partnerB.id)).toBe('suspended');
    const [userB] = await getTestDb().select().from(users).where(eq(users.id, s.userB.id));
    expect(userB).toMatchObject({ status: 'disabled', disabledReason: 'partner_suspended' });
    const commands = await getTestDb()
      .select({ type: deviceCommands.type, status: deviceCommands.status })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, s.deviceB.id));
    expect(commands).toEqual([{ type: 'self_uninstall', status: 'pending' }]);
    const [family] = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, s.familyB));
    expect(family?.revokedAt).not.toBeNull();
    const [audit] = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'partner.suspended_for_abuse'), eq(auditLogs.resourceId, s.partnerB.id)));
    expect(audit?.actorId).toBe(s.caller.id);
    // The caller's own partner is untouched.
    expect(await partnerStatus(s.partnerA.id)).toBe('active');
    expectRequestScopeUnchanged();
  });

  it('POST /admin/trust/act (evidence-card suspend, shares suspendPartnerForAbuse) suspends partner B', async () => {
    const s = await seed({ platformAdmin: true });
    const token = mintTrustActionToken(s.partnerB.id, 'suspend', s.caller.id);
    const app = await buildApp();

    const res = await app.request('/admin/trust/act', json({ token, totp: '123456' }));
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toEqual({ error: 'partner not found' });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ partnerId: s.partnerB.id, status: 'suspended' });
    expect(await partnerStatus(s.partnerB.id)).toBe('suspended');
    expectRequestScopeUnchanged();
  });

  it('POST /admin/partners/:id/unsuspend restores partner B and its suspension-disabled users', async () => {
    const s = await seed({ platformAdmin: true });
    await markSuspended(s.partnerB.id, s.userB.id);
    const app = await buildApp();

    const res = await app.request(
      `/admin/partners/${s.partnerB.id}/unsuspend`,
      json({ reason: 'integration test unsuspend' }),
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toEqual({ error: 'partner not found' });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ partnerId: s.partnerB.id, userCount: 1 });
    expect(await partnerStatus(s.partnerB.id)).not.toBe('suspended');
    const [userB] = await getTestDb().select().from(users).where(eq(users.id, s.userB.id));
    expect(userB).toMatchObject({ status: 'active', disabledReason: null });
    expectRequestScopeUnchanged();
  });

  it('GET /admin/signals?status=open returns partner B\'s open signals', async () => {
    const s = await seed({ platformAdmin: true });
    const app = await buildApp();

    const res = await app.request(`/admin/signals?status=open&partnerId=${s.partnerB.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { signals: Array<{ id: string; partnerId: string }> };
    expect(body.signals.map((r) => r.id).sort()).toEqual([...s.signalIds].sort());
    expectRequestScopeUnchanged();
  });

  it('GET /admin/signals?status=open without a partner filter includes partner B\'s signals', async () => {
    const s = await seed({ platformAdmin: true });
    const app = await buildApp();

    const res = await app.request('/admin/signals?status=open&limit=200');
    expect(res.status).toBe(200);
    const body = await res.json() as { signals: Array<{ id: string }> };
    const ids = new Set(body.signals.map((r) => r.id));
    for (const id of s.signalIds) expect(ids.has(id)).toBe(true);
    expectRequestScopeUnchanged();
  });

  it('POST /admin/signals/:id/acknowledge acknowledges partner B\'s signal', async () => {
    const s = await seed({ platformAdmin: true });
    const app = await buildApp();

    const res = await app.request(`/admin/signals/${s.signalIds[0]}/acknowledge`, { method: 'POST' });
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toEqual({ error: 'signal not found' });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ alreadyAcknowledged: false });
    const row = await signalRow(s.signalIds[0]!);
    expect(row?.acknowledgedAt).not.toBeNull();
    expect(row?.acknowledgedBy).toBe(s.callerEmail);
    expectRequestScopeUnchanged();
  });

  it('POST /admin/signals/acknowledge-bulk acknowledges partner B\'s signals', async () => {
    const s = await seed({ platformAdmin: true });
    const app = await buildApp();

    const res = await app.request('/admin/signals/acknowledge-bulk', json({ ids: s.signalIds }));
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<{ id: string; status: string }>; acknowledgedCount: number };
    expect(body.results.map((r) => r.status)).toEqual(['acknowledged', 'acknowledged']);
    expect(body.acknowledgedCount).toBe(2);
    for (const id of s.signalIds) expect((await signalRow(id))?.acknowledgedAt).not.toBeNull();
    expectRequestScopeUnchanged();
  });

  it('GET /admin/tenant-export/:orgId exports partner B\'s org', async () => {
    const s = await seed({ platformAdmin: true });
    const app = await buildApp();

    const res = await app.request(`/admin/tenant-export/${s.orgB.id}`);
    if (res.status !== 200) {
      expect(await res.json()).not.toEqual({ error: 'org not found' });
    }
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expectRequestScopeUnchanged();
  });

  it('POST /admin/tenant-erasure accepts partner B\'s org', async () => {
    const s = await seed({ platformAdmin: true });
    const app = await buildApp();

    const res = await app.request('/admin/tenant-erasure', json({ orgId: s.orgB.id, confirmEmail: s.callerEmail }));
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toEqual({ error: 'org not found' });
    expect(res.status).toBe(202);
    expect(body).toMatchObject({ status: 'accepted', orgId: s.orgB.id, partnerId: s.partnerB.id });
    expect(enqueueTenantErasureMock).toHaveBeenCalledTimes(1);
    expectRequestScopeUnchanged();
  });

  it('POST /admin/tenant-erasure refuses partner B\'s org under a backup legal hold (the hold check sees B\'s rows)', async () => {
    const s = await seed({ platformAdmin: true });
    await seedLegalHold(s.orgB.id, s.deviceB.id);
    const app = await buildApp();

    const res = await app.request('/admin/tenant-erasure', json({ orgId: s.orgB.id, confirmEmail: s.callerEmail }));
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toEqual({ error: 'org not found' });
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: 'LEGAL_HOLD_ACTIVE' });
    expect(enqueueTenantErasureMock).not.toHaveBeenCalled();
    expectRequestScopeUnchanged();
  });

  it('POST /admin/tenant-erasure refuses partner B\'s org with an unresolved network isolation (the isolation check sees B\'s rows)', async () => {
    const s = await seed({ platformAdmin: true });
    await getTestDb().execute(sql`
      INSERT INTO device_network_isolations (org_id, device_id, break_glass_secret_enc, requested_by_kind, reason, expires_at)
      VALUES (${s.orgB.id}::uuid, ${s.deviceB.id}::uuid, 'enc:v1:placeholder', 'user', 'integration fixture', now() + interval '1 hour')
    `);
    const app = await buildApp();

    const res = await app.request('/admin/tenant-erasure', json({ orgId: s.orgB.id, confirmEmail: s.callerEmail }));
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toEqual({ error: 'org not found' });
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ error: 'isolation_unresolved' });
    expect(enqueueTenantErasureMock).not.toHaveBeenCalled();
    expectRequestScopeUnchanged();
  });

  it('POST /admin/tenant-erasure reports the evidence hold on partner B\'s merged-away org (the hold lookup sees B\'s rows)', async () => {
    const s = await seed({ platformAdmin: true });
    const survivor = await createOrganization({ partnerId: s.partnerB.id });
    const mergeEventId = await markMergedShell({
      partnerId: s.partnerB.id,
      loserOrgId: s.orgB.id,
      survivorOrgId: survivor.id,
    });
    await insertHoldRaw({
      partnerId: s.partnerB.id,
      loserOrgId: s.orgB.id,
      survivorOrgId: survivor.id,
      mergeEventId,
    });
    const app = await buildApp();

    const res = await app.request('/admin/tenant-erasure', json({ orgId: s.orgB.id, confirmEmail: s.callerEmail }));
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toEqual({ error: 'org not found' });
    expect(res.status).toBe(202);
    expect(body).toMatchObject({ evidenceHold: { retained: true, survivorOrgId: survivor.id } });
    const [audit] = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, EVIDENCE_HOLD_DEFERRED_ACTION), eq(auditLogs.resourceId, s.orgB.id)));
    expect(audit?.actorId).toBe(s.caller.id);
    expectRequestScopeUnchanged();
  });
});

describe('right-reason control: a system-scoped request context (#12299)', () => {
  it('GET /admin/signals?status=open returns partner B\'s signals', async () => {
    const s = await seed({ platformAdmin: true });
    activeAuth = { ...activeAuth!, scope: 'system', partnerId: null, accessibleOrgIds: null };
    probeOtherPartnerId = null;
    const app = await buildApp();

    const res = await app.request(`/admin/signals?status=open&partnerId=${s.partnerB.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { signals: Array<{ id: string }> };
    expect(body.signals.map((r) => r.id).sort()).toEqual([...s.signalIds].sort());
  });
});

describe('negative control: a partner user without the platform-admin flag (#12299)', () => {
  const routes: Array<{
    name: string;
    request: (s: Awaited<ReturnType<typeof seed>>) => [string, RequestInit?];
  }> = [
    {
      name: 'suspend-for-abuse',
      request: (s) => [`/admin/partners/${s.partnerB.id}/suspend-for-abuse`,
        json({ confirmEmail: s.callerEmail, reason: 'integration test suspend' })],
    },
    {
      name: 'unsuspend',
      request: (s) => [`/admin/partners/${s.partnerB.id}/unsuspend`, json({ reason: 'integration test unsuspend' })],
    },
    { name: 'signals list', request: (s) => [`/admin/signals?status=open&partnerId=${s.partnerB.id}`] },
    { name: 'acknowledge', request: (s) => [`/admin/signals/${s.signalIds[0]}/acknowledge`, { method: 'POST' }] },
    { name: 'acknowledge-bulk', request: (s) => ['/admin/signals/acknowledge-bulk', json({ ids: s.signalIds })] },
    {
      name: 'trust/act',
      request: (s) => ['/admin/trust/act',
        json({ token: mintTrustActionToken(s.partnerB.id, 'suspend', s.caller.id), totp: '123456' })],
    },
    { name: 'tenant-export', request: (s) => [`/admin/tenant-export/${s.orgB.id}`] },
    {
      name: 'tenant-erasure',
      request: (s) => ['/admin/tenant-erasure', json({ orgId: s.orgB.id, confirmEmail: s.callerEmail })],
    },
  ];

  for (const route of routes) {
    it(`${route.name}: 403, and partner B's rows are unchanged`, async () => {
      const s = await seed({ platformAdmin: false });
      const app = await buildApp();

      const res = await app.request(...route.request(s));
      expect(res.status).toBe(403);
      const text = await res.text();
      for (const id of s.signalIds) expect(text).not.toContain(id);
      expect(text).not.toContain(s.partnerB.id);

      expect(await partnerStatus(s.partnerB.id)).toBe('active');
      for (const id of s.signalIds) expect((await signalRow(id))?.acknowledgedAt).toBeNull();
      const commands = await getTestDb()
        .select({ id: deviceCommands.id })
        .from(deviceCommands)
        .where(eq(deviceCommands.deviceId, s.deviceB.id));
      expect(commands).toHaveLength(0);
      expect(enqueueTenantErasureMock).not.toHaveBeenCalled();
    });
  }
});
