/**
 * flows RLS — dual-axis (org XOR partner) enforcement and the service's
 * caller-context writes (Tool Catalog W03, #5218, plan Task A11).
 *
 * Migration under test: 2027-01-02-130000-flows.sql.
 *   flows_isolation (FOR ALL):
 *     system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *            OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *   flows_partner_wide_select (FOR SELECT):
 *     org_id IS NULL AND partner_id = breeze_current_partner_id()
 *
 * `rls-coverage.integration.test.ts` proves the policies exist; this suite
 * drives the real driver as breeze_app under FORCE RLS to prove they enforce,
 * plus the CHECKs, plus `saveDraftFlow` against a real database (slug shadow
 * rule across owners, the advisory lock, and an org token's update of a
 * partner-wide row).
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { flows } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';
import { saveDraftFlow } from '../../services/flows/service';
import type { AuthContext } from '../../middleware/auth';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[], userId: string | null = null): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId, currentPartnerId: partnerId };
}

/** Org sessions carry their partner id (the SELECT branch keys on it) but never pass breeze_has_partner_access. */
function orgContext(orgId: string, partnerId: string, userId: string | null = null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId, currentPartnerId: partnerId };
}

function orgAuth(orgId: string, partnerId: string, userId: string): AuthContext {
  return {
    scope: 'organization', orgId, partnerId, partnerOrgAccess: null, accessibleOrgIds: [orgId],
    canAccessOrg: (id: string) => id === orgId, user: { id: userId, email: 'flows-it@example.com' },
  } as unknown as AuthContext;
}

function partnerAuth(partnerId: string, orgIds: string[], userId: string): AuthContext {
  return {
    scope: 'partner', orgId: null, partnerId, partnerOrgAccess: 'all', accessibleOrgIds: orgIds,
    canAccessOrg: (id: string) => orgIds.includes(id), user: { id: userId, email: 'flows-it@example.com' },
  } as unknown as AuthContext;
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const DEFINITION = { version: 1, name: 'Seeded', trigger: { type: 'manual' }, inputs: [], steps: [{ id: 'a', tool: 'wait', input: { minutes: 1 } }] };
const created: string[] = [];

afterEach(async () => {
  const ids = [...new Set(created)];
  created.length = 0;
  if (ids.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.delete(flows).where(inArray(flows.id, ids));
  });
});

async function seedFlow(owner: { orgId?: string | null; partnerId?: string | null }, slug: string): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(flows).values({
      orgId: owner.orgId ?? null,
      partnerId: owner.partnerId ?? null,
      slug,
      name: 'Seeded',
      definition: DEFINITION,
      effectiveTier: 1,
    }).returning({ id: flows.id }),
  );
  created.push(rows[0]!.id);
  return rows[0]!.id;
}

const visible = (ctx: DbAccessContext, id: string) =>
  withDbAccessContext(ctx, async () => (await db.select({ id: flows.id }).from(flows).where(eq(flows.id, id))).length);

const values = (o: Record<string, unknown>) => ({ name: 'F', definition: DEFINITION, effectiveTier: 1, slug: 'forged', ...o });

describe('flows partner RLS (#5218 W03 Task A11)', () => {
  describe('DB-enforced: RLS + CHECK constraints', () => {
    it("partner B forging partner A's partner_id is rejected (42501)", async () => {
      const a = await createPartner();
      const b = await createPartner();
      await expectSqlState(
        () => withDbAccessContext(partnerContext(b.id, []), () => db.insert(flows).values(values({ orgId: null, partnerId: a.id })).returning()),
        '42501',
      );
    });

    it("org B forging org A's org_id is rejected (42501)", async () => {
      const p = await createPartner();
      const orgA = await createOrganization({ partnerId: p.id });
      const orgB = await createOrganization({ partnerId: p.id });
      await expectSqlState(
        () => withDbAccessContext(orgContext(orgB.id, p.id), () => db.insert(flows).values(values({ orgId: orgA.id, partnerId: null })).returning()),
        '42501',
      );
    });

    it('both owners and neither owner violate flows_one_owner_chk (23514)', async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(flows).values(values({ orgId: org.id, partnerId: p.id }))), '23514');
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(flows).values(values({ orgId: null, partnerId: null }))), '23514');
    });

    it("a slug containing '__' violates flows_slug_chk (23514)", async () => {
      const p = await createPartner();
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(flows).values(values({ partnerId: p.id, slug: 'a__b' }))), '23514');
    });

    it('status paused without paused_reason violates flows_paused_reason_chk (23514)', async () => {
      const p = await createPartner();
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(flows).values(values({ partnerId: p.id, status: 'paused' }))), '23514');
    });

    it("an org token reads its partner's partner-wide flow but its UPDATE affects 0 rows", async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const id = await seedFlow({ partnerId: p.id }, 'pw_read');
      expect(await visible(orgContext(org.id, p.id), id)).toBe(1);
      const updated = await withDbAccessContext(orgContext(org.id, p.id), () =>
        db.update(flows).set({ name: 'hijacked' }).where(eq(flows.id, id)).returning({ id: flows.id }),
      );
      expect(updated).toHaveLength(0);
      const deleted = await withDbAccessContext(orgContext(org.id, p.id), () =>
        db.delete(flows).where(eq(flows.id, id)).returning({ id: flows.id }),
      );
      expect(deleted).toHaveLength(0);
    });

    it("an org token never sees another partner's partner-wide flow", async () => {
      const p1 = await createPartner();
      const p2 = await createPartner();
      const org = await createOrganization({ partnerId: p1.id });
      const other = await seedFlow({ partnerId: p2.id }, 'pw_other');
      expect(await visible(orgContext(org.id, p1.id), other)).toBe(0);
    });

    it("a partner token sees its orgs' flows and its partner-wide flows, not another partner's", async () => {
      const p = await createPartner();
      const p2 = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const orgFlow = await seedFlow({ orgId: org.id }, 'org_flow');
      const pwFlow = await seedFlow({ partnerId: p.id }, 'pw_flow');
      const foreign = await seedFlow({ partnerId: p2.id }, 'pw_foreign');
      const ctx = partnerContext(p.id, [org.id]);
      expect(await visible(ctx, orgFlow)).toBe(1);
      expect(await visible(ctx, pwFlow)).toBe(1);
      expect(await visible(ctx, foreign)).toBe(0);
    });
  });

  describe('saveDraftFlow against a real database', () => {
    it('org auth updating a partner-wide flowId ⇒ flow_not_found, row untouched', async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const user = await createUser({ partnerId: p.id, orgId: org.id });
      const id = await seedFlow({ partnerId: p.id }, 'pw_update');
      const r = await withDbAccessContext(orgContext(org.id, p.id, user.id), () =>
        saveDraftFlow(orgAuth(org.id, p.id, user.id), { document: DEFINITION, flowId: id }),
      );
      expect(r).toEqual({ saved: false, error: 'flow_not_found' });
      const [row] = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(flows).where(eq(flows.id, id)));
      expect(row!.definitionVersion).toBe(1);
    });

    it("creates an org draft, suffixing a slug its partner's partner-wide flow already holds (shadow rule)", async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const user = await createUser({ partnerId: p.id, orgId: org.id });
      await seedFlow({ partnerId: p.id }, 'disk_cleanup');
      const doc = { ...DEFINITION, name: 'Disk Cleanup' };
      const r = await withDbAccessContext(orgContext(org.id, p.id, user.id), () =>
        saveDraftFlow(orgAuth(org.id, p.id, user.id), { document: doc }),
      );
      expect(r.saved).toBe(true);
      if (!r.saved) return;
      created.push(r.flow.id);
      expect(r.flow).toMatchObject({ slug: 'disk_cleanup_2', ownerScope: 'organization', orgId: org.id, partnerId: null, status: 'draft', effectiveTier: 1 });
      expect(r.validation.valid).toBe(true);
    });

    it('a partner-wide draft is suffixed against an existing org flow under the same partner (other direction)', async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const user = await createUser({ partnerId: p.id });
      await seedFlow({ orgId: org.id }, 'patch_report');
      const doc = { ...DEFINITION, name: 'Patch report' };
      const r = await withDbAccessContext(partnerContext(p.id, [org.id], user.id), () =>
        saveDraftFlow(partnerAuth(p.id, [org.id], user.id), { document: doc, ownerScope: 'partner' }),
      );
      expect(r.saved).toBe(true);
      if (!r.saved) return;
      created.push(r.flow.id);
      expect(r.flow).toMatchObject({ slug: 'patch_report_2', ownerScope: 'partner', orgId: null, partnerId: p.id });
    });

    it('an update bumps definition_version and a stale expectedVersion is a conflict', async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const user = await createUser({ partnerId: p.id, orgId: org.id });
      const id = await seedFlow({ orgId: org.id }, 'versioned');
      const ctx = orgContext(org.id, p.id, user.id);
      const auth = orgAuth(org.id, p.id, user.id);
      const ok = await withDbAccessContext(ctx, () => saveDraftFlow(auth, { document: { ...DEFINITION, name: 'Renamed' }, flowId: id, expectedVersion: 1 }));
      expect(ok.saved).toBe(true);
      if (ok.saved) expect(ok.flow).toMatchObject({ definitionVersion: 2, name: 'Renamed', slug: 'versioned' });
      const stale = await withDbAccessContext(ctx, () => saveDraftFlow(auth, { document: DEFINITION, flowId: id, expectedVersion: 1 }));
      expect(stale).toEqual({ saved: false, error: 'version_conflict' });
    });
  });
});
