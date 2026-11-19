/**
 * Alert re-arm lifecycle W2 (feature #10765, wave #10767; plan Tasks 12 + 14):
 * the lifecycle-defaults route and the lifecycle loader under REAL row-level
 * security (breeze_app role). A mocked db cannot see the trap this pins:
 * `partners` RLS hides the partner row from an org-scoped session, so a plain
 * read silently collapses every inherited value to the built-in default.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

const h = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  ctx: null as unknown,
}));

// The real gates are unit-tested (routes/alerts/lifecycleDefaults.test.ts).
// Here the scope middleware opens the caller's REAL RLS context around the
// handler, exactly as authMiddleware does in production.
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', h.auth);
    const { withDbAccessContext: withContext } = await import('../../db');
    await withContext(h.ctx as DbAccessContext, () => next());
  },
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { lifecycleDefaultsRoutes } from '../../routes/alerts/lifecycleDefaults';
import { loadAlertLifecycle } from '../../services/alertLifecycle/resolve';

// currentPartnerId is set for every scope by authMiddleware: it is what lets an
// org session read its partner's partner-wide monitors (SELECT-only branch).
function partnerCtx(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null };
}
function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: partnerId, userId: null };
}

function asPartner(partnerId: string, orgIds: string[], reachable: (id: string) => boolean = (id) => orgIds.includes(id)) {
  h.ctx = partnerCtx(partnerId, orgIds);
  h.auth = {
    scope: 'partner', partnerId, orgId: null, partnerOrgAccess: 'all',
    user: { id: '00000000-0000-4000-8000-000000000001', email: 'p@example.test' }, canAccessOrg: reachable,
  };
}
function asOrg(partnerId: string, orgId: string) {
  h.ctx = orgCtx(orgId, partnerId);
  h.auth = {
    scope: 'organization', partnerId, orgId, partnerOrgAccess: null,
    user: { id: '00000000-0000-4000-8000-000000000002', email: 'o@example.test' }, canAccessOrg: (id: string) => id === orgId,
  };
}

const app = () => new Hono().route('/alerts', lifecycleDefaultsRoutes);
const get = (query = '') => app().request(`/alerts/lifecycle-defaults${query}`);
const put = (body: unknown) => app().request('/alerts/lifecycle-defaults', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return { partnerId: partner.id, orgId: org.id };
}

async function insertMonitor(owner: { orgId: string | null; partnerId: string | null }, cooldown: number | null) {
  await getTestDb().execute(sql`
    INSERT INTO monitor_definitions (org_id, partner_id, name, kind, condition, severity, cooldown_minutes)
    VALUES (${owner.orgId}, ${owner.partnerId}, ${`m-${Math.random()}`}, 'cpu', '{"threshold":90}'::jsonb, 'high', ${cooldown})`);
}

describe('alert lifecycle defaults under real RLS', () => {
  it('an org-scoped session cannot read its partner row directly, but the loader still inherits it', async () => {
    const { partnerId, orgId } = await tenant();
    await getTestDb().execute(sql`UPDATE partners SET alert_cooldown_minutes = 25 WHERE id = ${partnerId}::uuid`);

    const resolved = await withDbAccessContext(orgCtx(orgId, partnerId), async () => {
      // The control: RLS hides the row from this session.
      const direct = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId));
      expect(direct).toHaveLength(0);
      return loadAlertLifecycle({
        rule: { managedByMonitorId: '00000000-0000-4000-8000-0000000000aa', overrideSettings: null },
        template: { autoResolve: false, cooldownMinutes: 5 },
        monitor: null,
        deviceOrgId: orgId,
      });
    });
    expect(resolved.cooldownMinutes).toBe(25);
    expect(resolved.sources.cooldownMinutes).toBe('partner');
  });

  it('a full-access partner writes the partner default; an org user then reads it as inherited', async () => {
    const { partnerId, orgId } = await tenant();
    asPartner(partnerId, [orgId]);
    const write = await put({ scope: 'partner', autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 45, cooldownMinutes: 12 });
    expect(write.status).toBe(200);

    asOrg(partnerId, orgId);
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.partner).toEqual({ autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 45, cooldownMinutes: 12 });
    expect(body.effective).toEqual(body.partner);
    expect(body.sources).toEqual({ autoResolve: 'partner', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'partner' });
  });

  it('an org override saves through RLS, and null saves inherit', async () => {
    const { partnerId, orgId } = await tenant();
    asOrg(partnerId, orgId);
    expect((await put({
      scope: 'organization', orgId, autoResolve: false, rearmMode: 'after_delay', rearmDelayMinutes: 15, cooldownMinutes: 0,
    })).status).toBe(200);
    const [stored] = await getTestDb().select({
      a: organizations.alertAutoResolve, m: organizations.alertRearmMode, d: organizations.alertRearmDelayMinutes, c: organizations.alertCooldownMinutes,
    }).from(organizations).where(eq(organizations.id, orgId));
    expect(stored).toEqual({ a: false, m: 'after_delay', d: 15, c: 0 });

    const cleared = await put({ scope: 'organization', orgId, autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).sources.cooldownMinutes).toBe('partner');
  });

  it("RLS backstops an org write that names another partner's org", async () => {
    const mine = await tenant();
    const theirs = await tenant();
    // A forged access check that lets every id through: the session's own RLS
    // context still cannot see the other partner's org.
    asPartner(mine.partnerId, [mine.orgId], () => true);
    const res = await put({ scope: 'organization', orgId: theirs.orgId, autoResolve: true, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: 1 });
    expect(res.status).toBe(404);
    const [stored] = await getTestDb().select({ c: organizations.alertCooldownMinutes })
      .from(organizations).where(eq(organizations.id, theirs.orgId));
    expect(stored!.c).toBeNull();
  });

  it("counts the org's own and its partner's partner-wide monitor overrides for an org user", async () => {
    const { partnerId, orgId } = await tenant();
    const other = await createOrganization({ partnerId });
    await insertMonitor({ orgId, partnerId: null }, 10);
    await insertMonitor({ orgId, partnerId: null }, null);
    await insertMonitor({ orgId: null, partnerId }, 30);
    await insertMonitor({ orgId: other.id, partnerId: null }, 7); // a sibling org: not this org's count
    // Another partner's monitors never count, at either level.
    const foreign = await tenant();
    await insertMonitor({ orgId: foreign.orgId, partnerId: null }, 9);
    await insertMonitor({ orgId: null, partnerId: foreign.partnerId }, 9);

    asOrg(partnerId, orgId);
    const body = await (await get()).json();
    expect(body.monitorOverrideCounts.cooldownMinutes).toBe(2);

    asPartner(partnerId, [orgId, other.id]);
    const partnerBody = await (await get()).json();
    expect(partnerBody.monitorOverrideCounts.cooldownMinutes).toBe(3);
  });
});
