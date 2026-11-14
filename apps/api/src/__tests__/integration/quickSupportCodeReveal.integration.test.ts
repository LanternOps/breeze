/**
 * Quick Support — the code stays readable to the technician while the session
 * is pending, and only then (#11836). Real Postgres, real routes, `breeze_app`
 * under FORCE ROW LEVEL SECURITY.
 *
 * What only this file can prove (the unit suites mock `../db`):
 *  - the sealed code is cleared in the SAME statement as every transition out
 *    of `pending` — redeem, tech end, reaper expiry — and the table's CHECK
 *    constraint makes a missed path fail rather than leave a readable code;
 *  - an expired code is never returned even before the reaper has run;
 *  - RLS + the partner check keep the code from another partner and from a
 *    caller who could not have created the session;
 *  - "New code" atomically replaces hash + sealed value + expiry, so the old
 *    code no longer redeems, and it revives a code-expired session;
 *  - a redeem racing a "New code" has exactly one winner.
 *
 * The handlers run inside `withDbAccessContext(dbAccessContextFromAuth(auth))`,
 * the same request transaction `authMiddleware` opens, so every read and write
 * is scoped by the real policies.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { auditLogs, devices, enrollmentKeys, sites, supportSessions } from '../../db/schema';
import { createPartner, createUser } from './db-utils';
import { getTestRedis } from './setup';
import { getOrCreateQuickSupportOrg } from '../../services/quickSupportOrg';
import { endSupportSession } from '../../services/quickSupportEnd';
import { reapOnce } from '../../jobs/quickSupportReaper';
import { supportPublicRoutes } from '../../routes/supportPublic';
import { supportSessionRoutes } from '../../routes/remote/supportSessions';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';

const createdOrgs: string[] = [];

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

afterEach(async () => {
  if (createdOrgs.length === 0) return;
  await asSystem(async () => {
    for (const orgId of createdOrgs) {
      await db.delete(enrollmentKeys).where(eq(enrollmentKeys.orgId, orgId));
      await db.delete(supportSessions).where(eq(supportSessions.orgId, orgId));
      await db.delete(devices).where(eq(devices.orgId, orgId));
      await db.delete(sites).where(eq(sites.orgId, orgId));
    }
  });
  createdOrgs.length = 0;
});

/**
 * This file redeems far more than the per-IP /redeem limit (10/min) and spends
 * misses on purpose (old codes), all from one test client. Clear the limiter
 * and miss-budget keys so each test starts with a fresh allowance; the
 * guessing controls themselves are unchanged and covered by their own suites.
 */
beforeEach(async () => {
  const redis = getTestRedis();
  for (const pattern of ['support-redeem:*', 'support-check:*', 'support-code:*']) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
});

const REMOTE_ACCESS = { resource: 'remote', action: 'access' };

interface Caller {
  scope: 'partner' | 'system' | 'organization';
  partnerId: string | null;
  orgId?: string | null;
  accessibleOrgIds: string[] | null;
  userId: string;
  /** Grants the route-level `requirePermission` gate would have resolved. */
  permissions: Array<{ resource: string; action: string }>;
}

/**
 * The tech routes mounted the way production mounts them, minus the JWT: the
 * permission gate's outcome is set as `c.get('permissions')` and the handler
 * runs inside the caller's RLS request transaction.
 */
function techApp(caller: Caller): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const auth = {
      user: { id: caller.userId, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
      scope: caller.scope,
      partnerId: caller.partnerId,
      orgId: caller.orgId ?? null,
      accessibleOrgIds: caller.accessibleOrgIds,
    } as unknown as AuthContext;
    c.set('auth', auth);
    c.set('permissions', { permissions: caller.permissions, partnerId: caller.partnerId, orgId: null, roleId: 'role', scope: caller.scope } as never);
    // /end owns its own context (SELF_MANAGED_DB_CONTEXT_ROUTES), as in production.
    if (c.req.path.endsWith('/end')) return next();
    return withDbAccessContext(dbAccessContextFromAuth(auth), next);
  });
  app.route('/', supportSessionRoutes);
  return app;
}

function publicApp(): Hono {
  const app = new Hono();
  app.route('/support', supportPublicRoutes);
  return app;
}

async function post(app: Hono, path: string, body: unknown = {}): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function uniqueEmail(): string {
  return `qs-reveal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@example.com`;
}

async function seedTenant() {
  const partner = await createPartner();
  const { orgId } = await getOrCreateQuickSupportOrg(partner.id);
  createdOrgs.push(orgId);
  const tech = await createUser({ partnerId: partner.id, email: uniqueEmail() });
  const caller: Caller = {
    scope: 'partner',
    partnerId: partner.id,
    accessibleOrgIds: [orgId],
    userId: tech.id,
    permissions: [REMOTE_ACCESS],
  };
  return { partnerId: partner.id, orgId, techId: tech.id, caller };
}

type Created = { id: string; code: string; landingUrl: string; codeExpiresAt: string };

async function createSession(caller: Caller): Promise<Created> {
  const res = await post(techApp(caller), '/support-sessions');
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

async function getDetail(caller: Caller, id: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await techApp(caller).request(`/support-sessions/${id}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function listRow(caller: Caller, id: string): Promise<Record<string, unknown> | undefined> {
  const res = await techApp(caller).request('/support-sessions?limit=100');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
  return body.sessions.find((s) => s.id === id);
}

async function readRow(id: string) {
  return asSystem(async () => {
    const [row] = await db.select().from(supportSessions).where(eq(supportSessions.id, id));
    return row ?? null;
  });
}

function redeem(code: string, hostname = 'qs-reveal-host') {
  return post(publicApp(), '/support/redeem', { code, hostname, osType: 'windows' });
}

/** The raw (unformatted) code, which is what the landing link and redeem take. */
function raw(code: string): string {
  return code.replace(/-/g, '');
}

describe('code is readable while pending', () => {
  it('list and detail return the code and landing link to the creating tech, sealed at rest', async () => {
    const t = await seedTenant();
    const created = await createSession(t.caller);

    const detail = await getDetail(t.caller, created.id);
    expect(detail.status).toBe(200);
    expect(detail.body.code).toBe(created.code);
    expect(detail.body.landingUrl).toBe(created.landingUrl);

    const row = await listRow(t.caller, created.id);
    expect(row?.code).toBe(created.code);
    expect(row?.landingUrl).toBe(created.landingUrl);

    // Never the ciphertext or the hash on the wire.
    expect(detail.body).not.toHaveProperty('codeEncrypted');
    expect(detail.body).not.toHaveProperty('codeHash');
    expect(row).not.toHaveProperty('codeEncrypted');

    // At rest: sealed, not plaintext.
    const stored = await readRow(created.id);
    expect(stored?.codeEncrypted).toBeTruthy();
    expect(stored!.codeEncrypted!.startsWith('enc:')).toBe(true);
    expect(stored!.codeEncrypted).not.toContain(raw(created.code));
  });

  it('the sealed value is bound to its row: pasted onto another session it does not open', async () => {
    const t = await seedTenant();
    const a = await createSession(t.caller);
    const b = await createSession(t.caller);
    const sealedA = (await readRow(a.id))!.codeEncrypted!;
    await asSystem(() => db.update(supportSessions).set({ codeEncrypted: sealedA }).where(eq(supportSessions.id, b.id)));

    const detail = await getDetail(t.caller, b.id);
    expect(detail.status).toBe(200);
    expect(detail.body.code).toBeUndefined();
  });
});

describe('code is gone after every transition out of pending', () => {
  it('after the customer redeems it', async () => {
    const t = await seedTenant();
    const created = await createSession(t.caller);
    expect((await redeem(raw(created.code))).status).toBe(200);

    const stored = await readRow(created.id);
    expect(stored?.status).toBe('claimed');
    expect(stored?.codeEncrypted).toBeNull();
    expect((await getDetail(t.caller, created.id)).body.code).toBeUndefined();
    expect((await listRow(t.caller, created.id))?.code).toBeUndefined();
  });

  it('after the tech ends the session (route) and after a service end', async () => {
    const t = await seedTenant();
    const viaRoute = await createSession(t.caller);
    expect((await post(techApp(t.caller), `/support-sessions/${viaRoute.id}/end`)).status).toBe(200);
    const endedRow = await readRow(viaRoute.id);
    expect(endedRow?.status).toBe('ended');
    expect(endedRow?.codeEncrypted).toBeNull();
    expect((await getDetail(t.caller, viaRoute.id)).body.code).toBeUndefined();

    const viaService = await createSession(t.caller);
    await endSupportSession(viaService.id, 'expired');
    expect((await readRow(viaService.id))?.codeEncrypted).toBeNull();
  });

  it('once code_expires_at has passed — before the reaper runs — and the reaper then clears it', async () => {
    const t = await seedTenant();
    const created = await createSession(t.caller);
    await asSystem(() => db.update(supportSessions)
      .set({ codeExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(supportSessions.id, created.id)));

    // Reaper has not run: the row still holds the sealed value and is pending...
    const before = await readRow(created.id);
    expect(before?.status).toBe('pending');
    expect(before?.codeEncrypted).toBeTruthy();
    // ...but it is not returned.
    expect((await getDetail(t.caller, created.id)).body.code).toBeUndefined();
    expect((await listRow(t.caller, created.id))?.code).toBeUndefined();

    await reapOnce();
    const after = await readRow(created.id);
    expect(after?.status).toBe('expired');
    expect(after?.codeEncrypted).toBeNull();
  });

  it('the database refuses a status change that leaves the sealed code behind', async () => {
    const t = await seedTenant();
    const created = await createSession(t.caller);
    await expect(asSystem(() => db.update(supportSessions)
      .set({ status: 'ended' })
      .where(eq(supportSessions.id, created.id)))).rejects.toThrow();
    expect((await readRow(created.id))?.status).toBe('pending');
  });
});

describe('who may read the code', () => {
  it('a caller without the create permission gets no code, and cannot create or reissue', async () => {
    const t = await seedTenant();
    const created = await createSession(t.caller);
    const noPerm: Caller = { ...t.caller, permissions: [{ resource: 'devices', action: 'read' }] };

    const detail = await getDetail(noPerm, created.id);
    expect(detail.status).toBe(200);
    expect(detail.body.code).toBeUndefined();
    expect(detail.body.landingUrl).toBeUndefined();
    expect((await listRow(noPerm, created.id))?.code).toBeUndefined();

    expect((await post(techApp(noPerm), '/support-sessions')).status).toBe(403);
    expect((await post(techApp(noPerm), `/support-sessions/${created.id}/code`)).status).toBe(403);
  });

  it('another partner cannot see the session at all (RLS), so never the code', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const created = await createSession(a.caller);

    expect((await getDetail(b.caller, created.id)).status).toBe(404);
    expect(await listRow(b.caller, created.id)).toBeUndefined();
    expect((await post(techApp(b.caller), `/support-sessions/${created.id}/code`)).status).toBe(404);
  });

  it('a system-scope caller sees the row but gets the code only for its own partner', async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const created = await createSession(a.caller);

    const systemForB: Caller = { scope: 'system', partnerId: b.partnerId, accessibleOrgIds: null, userId: b.techId, permissions: [REMOTE_ACCESS] };
    const asB = await getDetail(systemForB, created.id);
    expect(asB.status).toBe(200);
    expect(asB.body.code).toBeUndefined();
    expect((await listRow(systemForB, created.id))?.code).toBeUndefined();
    expect((await post(techApp(systemForB), `/support-sessions/${created.id}/code`)).status).toBe(404);

    const systemNoPartner: Caller = { ...systemForB, partnerId: null };
    expect((await getDetail(systemNoPartner, created.id)).body.code).toBeUndefined();

    const systemForA: Caller = { ...systemForB, partnerId: a.partnerId, userId: a.techId };
    expect((await getDetail(systemForA, created.id)).body.code).toBe(created.code);
  });
});

describe('POST /support-sessions/:id/code — New code', () => {
  it('replaces the code: the old one no longer redeems, the new one does, and it is audited', async () => {
    const t = await seedTenant();
    const created = await createSession(t.caller);

    const res = await post(techApp(t.caller), `/support-sessions/${created.id}/code`);
    expect(res.status).toBe(200);
    const fresh = (await res.json()) as Created;
    expect(fresh.id).toBe(created.id);
    expect(fresh.code).not.toBe(created.code);
    expect(fresh.landingUrl).toContain(raw(fresh.code));
    expect((await getDetail(t.caller, created.id)).body.code).toBe(fresh.code);

    expect((await redeem(raw(created.code))).status).toBe(404);
    expect((await redeem(raw(fresh.code))).status).toBe(200);

    const audits = await asSystem(() => db.select({ action: auditLogs.action, details: auditLogs.details })
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, created.id), eq(auditLogs.action, 'support_session_code_reissued'))));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.details)).not.toContain(raw(fresh.code));
  });

  it('works after the code expired and the reaper moved the session to expired', async () => {
    const t = await seedTenant();
    const created = await createSession(t.caller);
    await asSystem(() => db.update(supportSessions)
      .set({ codeExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(supportSessions.id, created.id)));
    await reapOnce();
    expect((await readRow(created.id))?.status).toBe('expired');

    const res = await post(techApp(t.caller), `/support-sessions/${created.id}/code`);
    expect(res.status).toBe(200);
    const fresh = (await res.json()) as Created;

    const revived = await readRow(created.id);
    expect(revived?.status).toBe('pending');
    expect(revived?.endedAt).toBeNull();
    expect(revived?.endedReason).toBeNull();
    expect(revived?.codeExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((await getDetail(t.caller, created.id)).body.code).toBe(fresh.code);
    expect((await redeem(raw(fresh.code))).status).toBe(200);
  });

  it('is refused once the session was claimed or ended, or past the hard cap', async () => {
    const t = await seedTenant();

    const claimed = await createSession(t.caller);
    expect((await redeem(raw(claimed.code))).status).toBe(200);
    expect((await post(techApp(t.caller), `/support-sessions/${claimed.id}/code`)).status).toBe(409);

    const ended = await createSession(t.caller);
    expect((await post(techApp(t.caller), `/support-sessions/${ended.id}/end`)).status).toBe(200);
    expect((await post(techApp(t.caller), `/support-sessions/${ended.id}/code`)).status).toBe(409);

    const capped = await createSession(t.caller);
    await asSystem(() => db.update(supportSessions)
      .set({ hardExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(supportSessions.id, capped.id)));
    expect((await post(techApp(t.caller), `/support-sessions/${capped.id}/code`)).status).toBe(409);
  });

  it('a redeem racing a New code has exactly one winner', async () => {
    const t = await seedTenant();
    for (let i = 0; i < 6; i++) {
      const created = await createSession(t.caller);
      const [redeemRes, reissueRes] = await Promise.all([
        redeem(raw(created.code), `qs-race-${i}`),
        post(techApp(t.caller), `/support-sessions/${created.id}/code`),
      ]);
      const redeemed = redeemRes.status === 200;
      const reissued = reissueRes.status === 200;
      expect(redeemed !== reissued).toBe(true);
      const row = await readRow(created.id);
      if (redeemed) {
        expect(row?.status).toBe('claimed');
        expect(row?.codeEncrypted).toBeNull();
      } else {
        expect(row?.status).toBe('pending');
        expect(row?.codeEncrypted).toBeTruthy();
      }
    }
  });
});
