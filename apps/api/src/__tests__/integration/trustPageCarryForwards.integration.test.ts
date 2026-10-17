import './setup';

/**
 * Trust Center W02i (#8770): the new read paths against a real database under RLS — the AI status tool's
 * counts (raw `count(*) filter` SQL), the portal dashboard link (org-scoped page read + system-scoped partner
 * read), and neither creating a trust page row.
 */
import { describe, it, expect, vi } from 'vitest';

// Pinned: the trust-state gates are asserted under enforcement, not whatever the test env defaults to.
vi.mock('../../config/partnerTrustMode', () => ({ partnerTrustMode: () => 'enforce' }));
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { trustPages } from '../../db/schema';
import { ensureTrustPage, publishTrustPage } from '../../services/trustPage/publication';
import { registerTrustPageTools } from '../../services/aiToolsTrustPage';
import type { AiTool } from '../../services/aiTools';
import type { AuthContext } from '../../middleware/auth';
import { portalTrustPageLinkRoutes } from '../../routes/portal/trustPageLink';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const asOrg = <T>(orgId: string, fn: () => Promise<T>) =>
  runOutsideDbContext(() => withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, fn));

interface Seeded { partnerId: string; orgId: string; userId: string; partnerSlug: string; orgSlug: string }

async function seed(trustState: 'trusted' | 'restricted' = 'trusted'): Promise<Seeded> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `nw-w02i-${suffix}`;
  const orgSlug = `acme-w02i-${suffix}`;
  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Northwind IT', ${partnerSlug}, 'active', ${trustState}, now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`w02i-${suffix}@example.com`}, 'Trust Publisher', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partner!.id}, 'Acme Dental', ${orgSlug}, 'active', 'USD', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { partnerId: partner!.id, orgId: org!.id, userId: user!.id, partnerSlug, orgSlug };
}

async function publish(s: Seeded) {
  await sys(() => ensureTrustPage(s.orgId, s.userId));
  return sys(() => publishTrustPage({
    orgId: s.orgId, expectedRevision: 0, actorUserId: s.userId, authorization: { authorizedBy: 'Jane Doe, COO' },
    partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
  }));
}

const tools = new Map<string, AiTool>();
registerTrustPageTools(tools);
const statusTool = tools.get('get_trust_page_status')!;
const partnerAuth = { scope: 'partner', canAccessOrg: () => true } as unknown as AuthContext;
const status = async (orgId: string) => JSON.parse(await asOrg(orgId, () => statusTool.handler({ orgId }, partnerAuth)) as string);

function portalApp(orgId: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth' as never, { user: { id: 'portal-user', orgId } } as never);
    await asOrg(orgId, () => next());
  });
  app.route('/', portalTrustPageLinkRoutes);
  return app;
}
const portalLink = async (orgId: string) => (await (await portalApp(orgId).request('/trust-page')).json()).data.publicPath;
const pageRows = (orgId: string) => sys(() => db.select({ id: trustPages.id }).from(trustPages).where(eq(trustPages.orgId, orgId)));

describe('trust page W02i read paths (real DB, RLS)', () => {
  it('get_trust_page_status: never-created page → exists:false and no row is created', async () => {
    const s = await seed();
    const out = await status(s.orgId);
    expect(out).toMatchObject({ exists: false, published: false, controls: null, declarations: { current: 0, expiringWithin30Days: 0 } });
    expect(await pageRows(s.orgId)).toHaveLength(0);
  });

  it('get_trust_page_status: a published page reports snapshot counts, current/expiring declarations and pending requests', async () => {
    const s = await seed();
    const { page } = await publish(s);
    const testDb = getTestDb();
    // current, expiring in 10 days, withdrawn (not counted), superseded (not counted)
    await testDb.execute(sql`
      INSERT INTO trust_page_declarations (trust_page_id, org_id, control_id, statement, declared_by_partner_name, declared_at, expires_at, withdrawn_at, superseded_at)
      VALUES
        (${page.id}, ${s.orgId}, 'security_training', 'We train staff annually.', 'Northwind IT', now(), now() + interval '8760 hours', NULL, NULL),
        (${page.id}, ${s.orgId}, 'incident_response_plan', 'We have a plan.', 'Northwind IT', now() - interval '8520 hours', now() + interval '240 hours', NULL, NULL),
        (${page.id}, ${s.orgId}, 'vendor_management', 'Withdrawn.', 'Northwind IT', now(), now() + interval '8760 hours', now(), NULL),
        (${page.id}, ${s.orgId}, 'data_retention_policy', 'Superseded.', 'Northwind IT', now() - interval '24 hours', now() + interval '8736 hours', NULL, now())
    `);
    await testDb.execute(sql`
      INSERT INTO trust_page_access_requests (trust_page_id, org_id, requester_email, requester_name, requester_company, purpose, status, email_verified_at)
      VALUES
        (${page.id}, ${s.orgId}, 'a@example.com', 'A', 'Insurer', 'Underwriting', 'pending_approval', now()),
        (${page.id}, ${s.orgId}, 'b@example.com', 'B', 'Auditor', 'Audit', 'pending_verification', NULL)
    `);
    const out = await status(s.orgId);
    expect(out.exists).toBe(true);
    expect(out.published).toBe(true);
    expect(out.publicPath).toBe(`/portal/trust/${s.partnerSlug}/${s.orgSlug}`);
    expect(out.stale).toBe(false);
    expect(out.controls).toEqual({ shown: expect.any(Number), met: expect.any(Number), catalogTotal: expect.any(Number) });
    expect(out.controls.catalogTotal).toBeGreaterThan(0);
    expect(out.declarations).toEqual({ current: 2, expiringWithin30Days: 1 });
    expect(out.accessRequests).toEqual({ pendingApproval: 1 });
  });

  it('get_trust_page_status: RLS hides another org\'s page even if the auth check were bypassed', async () => {
    const a = await seed();
    const b = await seed();
    await publish(b);
    // Read B's page from A's org context: forced RLS returns nothing.
    const out = JSON.parse(await asOrg(a.orgId, () => statusTool.handler({ orgId: b.orgId }, partnerAuth)) as string);
    expect(out.exists).toBe(false);
  });

  it('portal dashboard link: null before publish, the portal-relative path after, null once the partner may not publish', async () => {
    const s = await seed();
    expect(await portalLink(s.orgId)).toBeNull();
    expect(await pageRows(s.orgId)).toHaveLength(0);
    await publish(s);
    expect(await portalLink(s.orgId)).toBe(`/trust/${s.partnerSlug}/${s.orgSlug}`);
    expect((await status(s.orgId)).publicPath).toBe(`/portal/trust/${s.partnerSlug}/${s.orgSlug}`);

    for (const state of ['restricted', 'probation'] as const) {
      await getTestDb().execute(sql`UPDATE partners SET trust_state = ${state} WHERE id = ${s.partnerId}`);
      expect(await portalLink(s.orgId)).toBeNull();
      // The AI tool applies the same serving gate: still published, but no URL that would 404.
      expect(await status(s.orgId)).toMatchObject({ published: true, publicPath: null });
    }
  });
});
