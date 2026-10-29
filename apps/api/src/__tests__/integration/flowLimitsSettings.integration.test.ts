import './setup';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema/orgs';
import { createOrganization, createPartner } from './db-utils';

/**
 * Tool Catalog W05 (#5220) — flow limits settings routes on a real Postgres
 * with forced RLS: the request runs in the caller's partner context, so the
 * org read and the path-level jsonb UPDATE go through the real policies.
 * Only the permission lookup is stubbed (every caller holds automations
 * read+write); scope, MFA and the partner-wide gate stay real.
 */

vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      permissions: [actual.PERMISSIONS.AUTOMATIONS_READ, actual.PERMISSIONS.AUTOMATIONS_WRITE],
      partnerId: null, orgId: null, roleId: 'r', scope: 'partner',
    })),
  };
});
vi.mock('../../services/auditService', () => ({ createAuditLogAsync: vi.fn(async () => {}) }));

import { registerFlowLimitsRoutes } from '../../routes/flowLimits';
import { computeFlowLimits } from '../../services/flows/flowLimits';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    await db.update(partners).set({ settings: { flows: { monthlyRunsPerFlow: 500 }, keep: 'partner-kept' } }).where(eq(partners.id, partner.id));
    await db.update(organizations).set({ settings: { keep: 'org-kept' } }).where(eq(organizations.id, org.id));
    return { partner, org, otherPartner, otherOrg };
  });
}

function appFor(partnerId: string, accessibleOrgIds: string[], partnerOrgAccess: 'all' | 'selected' = 'all') {
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null,
  };
  const auth = {
    user: { id: '33333333-3333-4333-8333-333333333333', email: 'admin@example.com' },
    scope: 'partner', orgId: null, partnerId, partnerOrgAccess, accessibleOrgIds,
    canAccessOrg: (id: string) => accessibleOrgIds.includes(id),
    token: { mfa: true, sid: 'sid-1' },
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as never);
    await withDbAccessContext(ctx, () => next());
  });
  registerFlowLimitsRoutes(app);
  return app;
}
const put = (app: Hono, body: unknown) =>
  app.request('/limits', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const settingsOf = async (table: 'org' | 'partner', id: string) => withSystemDbAccessContext(async () => {
  const [row] = table === 'org'
    ? await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, id)).limit(1)
    : await db.select({ settings: partners.settings }).from(partners).where(eq(partners.id, id)).limit(1);
  return row!.settings as Record<string, unknown>;
});

describe('flow limits settings routes (real DB, RLS)', () => {
  runDb('org override: lowers are written path-level (other keys kept) and resolve; a raise is refused and nothing changes', async () => {
    const { partner, org } = await seed();
    const app = appFor(partner.id, [org.id]);

    const ok = await put(app, { orgId: org.id, limits: { monthlyRunsPerFlow: 100 } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ level: 'org', limits: { effective: { monthlyRunsPerFlow: 100 }, source: { monthlyRunsPerFlow: 'org' } } });
    let stored = await settingsOf('org', org.id);
    expect(stored).toEqual({ keep: 'org-kept', flows: { monthlyRunsPerFlow: 100 } });

    const raise = await put(app, { orgId: org.id, limits: { monthlyRunsPerFlow: 501 } });
    expect(raise.status).toBe(422);
    expect(await raise.json()).toMatchObject({ error: 'limit_above_partner_ceiling', field: 'monthlyRunsPerFlow', ceiling: 500 });
    stored = await settingsOf('org', org.id);
    expect(stored.flows).toEqual({ monthlyRunsPerFlow: 100 });

    // The resolver reads what the route wrote.
    const partnerSettings = await settingsOf('partner', partner.id);
    expect(computeFlowLimits(partnerSettings, stored).monthlyRunsPerFlow).toBe(100);

    const cleared = await put(app, { orgId: org.id, limits: { monthlyRunsPerFlow: null } });
    expect(cleared.status).toBe(200);
    expect(await settingsOf('org', org.id)).toEqual({ keep: 'org-kept', flows: {} });
  });

  runDb("cross-partner: another partner's org is a 404 for read and write, even when listed as accessible", async () => {
    const { partner, org, otherOrg } = await seed();
    // The caller's canAccessOrg says yes; RLS (partner A's context) must still hide org B.
    const app = appFor(partner.id, [org.id, otherOrg.id]);
    expect((await app.request(`/limits?orgId=${otherOrg.id}`)).status).toBe(404);
    expect((await put(app, { orgId: otherOrg.id, limits: { monthlyRunsPerFlow: 1 } })).status).toBe(404);
    expect((await settingsOf('org', otherOrg.id)).flows).toBeUndefined();
  });

  runDb('partner default: written path-level with partner-wide authority, refused without it', async () => {
    const { partner, org } = await seed();
    const refused = await put(appFor(partner.id, [org.id], 'selected'), { limits: { aiTokensPerRun: 2000 } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'partner_wide_forbidden' });
    expect((await settingsOf('partner', partner.id)).flows).toEqual({ monthlyRunsPerFlow: 500 });

    const ok = await put(appFor(partner.id, [org.id]), { limits: { aiTokensPerRun: 2000 } });
    expect(ok.status).toBe(200);
    // The response reflects the write (not a re-read in another context).
    expect(await ok.json()).toMatchObject({ level: 'partner', stored: { aiTokensPerRun: 2000 }, limits: { effective: { aiTokensPerRun: 2000 } } });
    expect(await settingsOf('partner', partner.id)).toEqual({ keep: 'partner-kept', flows: { monthlyRunsPerFlow: 500, aiTokensPerRun: 2000 } });

    // null clears the key (inherit), it is not stored as null.
    const cleared = await put(appFor(partner.id, [org.id]), { limits: { monthlyRunsPerFlow: null } });
    expect(cleared.status).toBe(200);
    expect(await settingsOf('partner', partner.id)).toEqual({ keep: 'partner-kept', flows: { aiTokensPerRun: 2000 } });
  });
});
