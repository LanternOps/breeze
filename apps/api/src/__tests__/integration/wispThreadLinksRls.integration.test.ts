/**
 * Wisp W08a (#9914, feature #9906) — `wisp_thread_links` against real
 * Postgres (migrations/2027-01-05-100500-wisp-thread-links.sql).
 *
 * `rls-coverage.integration.test.ts` proves the table is REGISTERED
 * (DUAL_AXIS_TENANT_TABLES). This file is the functional proof of the
 * partner-anchored / org-optional shape: an org token sees its org's links and
 * never a partner-level (org_id NULL) link, a partner context sees both, a
 * sibling partner sees nothing, cross-tenant forges are refused WITH CHECK,
 * every composite FK pins the row to one partner, and the org registries
 * (cascade delete, merge repoint) move only the org rows.
 *
 * Grants and threads are seeded straight into their tables under system scope
 * (createGrant needs a step-up proof, which is not what this file is about).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  wispGrantRevisions,
  wispGrants,
  wispThreadLinks,
  wispThreads,
} from '../../db/schema';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

const partnerContext = (partnerId: string, orgIds: string[]): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId],
  userId: null, currentPartnerId: partnerId,
});

const orgContext = (orgId: string, partnerId: string): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
  userId: null, currentPartnerId: partnerId,
});

const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

async function expectSqlState(fn: () => Promise<unknown>, code: string, constraint?: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised), String(raised)).toBe(code);
  if (constraint) expect(pgErrorConstraint(raised)).toBe(constraint);
}

async function seedGrant(partnerId: string, grantorUserId: string, orgIds: string[], scopeOrgId: string | null = null) {
  return asSystem(async () => {
    const [grant] = await db.insert(wispGrants).values({
      partnerId, orgId: scopeOrgId, grantorUserId, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const [revision] = await db.insert(wispGrantRevisions).values({
      grantId: grant!.id, partnerId, revision: 1,
      ceilingSnapshot: { version: 1, permissionKeys: ['ai_sessions:use'], orgIds, siteIds: null, toolAllowlist: null, deniedTools: [] },
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: revision!.id }).where(eq(wispGrants.id, grant!.id));
    return grant!.id;
  });
}

const insertThread = (grantId: string, partnerId: string) =>
  asSystem(async () => {
    const [row] = await db.insert(wispThreads).values({ grantId, partnerId }).returning({ id: wispThreads.id });
    return row!.id;
  });

interface Fixture {
  partnerA: string; partnerB: string;
  orgA1: string; orgA2: string; orgB1: string;
  userA: string; userB: string;
  grantA: string; grantB: string;
  threadA: string; threadB: string;
}

async function seed(): Promise<Fixture> {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  const uA = await createUser({ partnerId: partnerA.id, email: `wisp-link-a-${randomUUID()}@wisp.test` });
  const uB = await createUser({ partnerId: partnerB.id, email: `wisp-link-b-${randomUUID()}@wisp.test` });
  const grantA = await seedGrant(partnerA.id, uA.id, [orgA1.id, orgA2.id]);
  const grantB = await seedGrant(partnerB.id, uB.id, [orgB1.id]);
  return {
    partnerA: partnerA.id, partnerB: partnerB.id,
    orgA1: orgA1.id, orgA2: orgA2.id, orgB1: orgB1.id,
    userA: uA.id, userB: uB.id,
    grantA, grantB,
    threadA: await insertThread(grantA, partnerA.id),
    threadB: await insertThread(grantB, partnerB.id),
  };
}

type LinkInsert = typeof wispThreadLinks.$inferInsert;

const linkValues = (f: Fixture, orgId: string | null, extra: Partial<LinkInsert> = {}): LinkInsert => ({
  threadId: f.threadA, partnerId: f.partnerA, orgId,
  entityKind: orgId ? 'ticket' : 'user', entityId: randomUUID(),
  label: 'T-1042 Printer offline', addedByUserId: f.userA, ...extra,
});

const insertLink = (f: Fixture, orgId: string | null, extra: Partial<LinkInsert> = {}) =>
  asSystem(async () => {
    const [row] = await db.insert(wispThreadLinks).values(linkValues(f, orgId, extra)).returning();
    return row!;
  });

const visibleIds = async (ctx: DbAccessContext): Promise<string[]> => {
  const rows = await withDbAccessContext(ctx, () => db.select({ id: wispThreadLinks.id }).from(wispThreadLinks));
  return rows.map((r) => r.id);
};

describe('wisp_thread_links RLS (partner-anchored, org-optional)', () => {
  it("an org token sees its org's links, not a sibling org's and never a partner-level (org_id NULL) link", async () => {
    const f = await seed();
    const a1 = await insertLink(f, f.orgA1);
    const a2 = await insertLink(f, f.orgA2);
    const partnerLevel = await insertLink(f, null);

    const ids = await visibleIds(orgContext(f.orgA1, f.partnerA));
    expect(ids).toContain(a1.id);
    expect(ids).not.toContain(a2.id);
    expect(ids).not.toContain(partnerLevel.id);
  });

  it('a partner context sees its org links and its partner-level links', async () => {
    const f = await seed();
    const a1 = await insertLink(f, f.orgA1);
    const a2 = await insertLink(f, f.orgA2);
    const partnerLevel = await insertLink(f, null);

    const ids = await visibleIds(partnerContext(f.partnerA, [f.orgA1, f.orgA2]));
    expect(ids).toEqual(expect.arrayContaining([a1.id, a2.id, partnerLevel.id]));
  });

  it("partner B (partner or org context) sees none of partner A's links", async () => {
    const f = await seed();
    const a1 = await insertLink(f, f.orgA1);
    const partnerLevel = await insertLink(f, null);

    for (const ctx of [partnerContext(f.partnerB, [f.orgB1]), orgContext(f.orgB1, f.partnerB)]) {
      const ids = await visibleIds(ctx);
      expect(ids).not.toContain(a1.id);
      expect(ids).not.toContain(partnerLevel.id);
    }
  });

  it("a partner-B context cannot forge a link into partner A (WITH CHECK, 42501)", async () => {
    const f = await seed();
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), () =>
        db.insert(wispThreadLinks).values(linkValues(f, null))),
      '42501',
    );
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
        db.insert(wispThreadLinks).values(linkValues(f, f.orgA1))),
      '42501',
    );
  });

  it('an org token cannot write a partner-level link of its own partner (42501)', async () => {
    const f = await seed();
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
        db.insert(wispThreadLinks).values(linkValues(f, null))),
      '42501',
    );
  });

  it("a partner-B context cannot update or delete partner A's links (zero rows)", async () => {
    const f = await seed();
    const a1 = await insertLink(f, f.orgA1);
    const ctx = partnerContext(f.partnerB, [f.orgB1]);
    const updated = await withDbAccessContext(ctx, () =>
      db.update(wispThreadLinks).set({ label: 'pwned' }).where(eq(wispThreadLinks.id, a1.id)).returning({ id: wispThreadLinks.id }));
    expect(updated).toHaveLength(0);
    const deleted = await withDbAccessContext(ctx, () =>
      db.delete(wispThreadLinks).where(eq(wispThreadLinks.id, a1.id)).returning({ id: wispThreadLinks.id }));
    expect(deleted).toHaveLength(0);
    const [still] = await asSystem(() => db.select().from(wispThreadLinks).where(eq(wispThreadLinks.id, a1.id)));
    expect(still!.label).toBe('T-1042 Printer offline');
  });
});

describe('wisp_thread_links constraints', () => {
  it('every composite FK pins the row to one partner (23503)', async () => {
    const f = await seed();
    await expectSqlState(() => insertLink(f, f.orgA1, { threadId: f.threadB }), '23503', 'wisp_thread_links_thread_fk');
    await expectSqlState(() => insertLink(f, f.orgB1), '23503', 'wisp_thread_links_org_partner_fk');
    await expectSqlState(() => insertLink(f, f.orgA1, { addedByUserId: f.userB }), '23503', 'wisp_thread_links_added_by_user_fk');
    await expectSqlState(() => insertLink(f, f.orgA1, { addedByGrantId: f.grantB }), '23503', 'wisp_thread_links_added_by_grant_fk');
    const ok = await insertLink(f, f.orgA1, { addedByGrantId: f.grantA });
    expect(ok.addedByGrantId).toBe(f.grantA);
  });

  it('entity_kind and label CHECKs hold (23514)', async () => {
    const f = await seed();
    await expectSqlState(() => insertLink(f, f.orgA1, { entityKind: 'concern' as never }), '23514', 'wisp_thread_links_entity_kind_chk');
    await expectSqlState(() => insertLink(f, f.orgA1, { label: 'x'.repeat(201) }), '23514', 'wisp_thread_links_label_len_chk');
    await insertLink(f, f.orgA1, { label: 'x'.repeat(200) });
  });

  it('one link per (thread, entity_kind, entity_id) — 23505', async () => {
    const f = await seed();
    const entityId = randomUUID();
    await insertLink(f, f.orgA1, { entityKind: 'device', entityId });
    await expectSqlState(
      () => insertLink(f, f.orgA1, { entityKind: 'device', entityId }),
      '23505', 'wisp_thread_links_thread_entity_uq',
    );
    // Same entity, other kind: a different link.
    await insertLink(f, f.orgA1, { entityKind: 'ticket', entityId });
  });

  it('deleting the thread cascades its links; erasing a grant other than the thread\'s nulls added_by_grant_id', async () => {
    const f = await seed();
    // One live grant per (grantor, scope): the second one is org-scoped.
    const otherGrant = await seedGrant(f.partnerA, f.userA, [f.orgA1], f.orgA1);
    const viaOther = await insertLink(f, f.orgA1, { addedByGrantId: otherGrant });
    await asSystem(() => db.delete(wispGrants).where(eq(wispGrants.id, otherGrant)));
    const [kept] = await asSystem(() => db.select().from(wispThreadLinks).where(eq(wispThreadLinks.id, viaOther.id)));
    expect(kept!.addedByGrantId).toBeNull();
    expect(kept!.partnerId).toBe(f.partnerA);

    await asSystem(() => db.delete(wispThreads).where(eq(wispThreads.id, f.threadA)));
    const left = await asSystem(() => db.select().from(wispThreadLinks).where(eq(wispThreadLinks.threadId, f.threadA)));
    expect(left).toHaveLength(0);
  });
});

describe('wisp_thread_links through the org registries', () => {
  it("org erasure (cascadeDeleteOrg) removes the org's links and leaves the thread and partner-level links", async () => {
    const f = await seed();
    const a1 = await insertLink(f, f.orgA1);
    const a2 = await insertLink(f, f.orgA2);
    const partnerLevel = await insertLink(f, null);

    await cascadeDeleteOrg(f.orgA1, f.userA);

    const left = await asSystem(() => db.select({ id: wispThreadLinks.id }).from(wispThreadLinks)
      .where(inArray(wispThreadLinks.id, [a1.id, a2.id, partnerLevel.id])));
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([a2.id, partnerLevel.id]));
    const threads = await asSystem(() => db.select({ id: wispThreads.id }).from(wispThreads).where(eq(wispThreads.id, f.threadA)));
    expect(threads).toHaveLength(1);
  }, 120_000);

  it("org merge repoints the loser's links to the survivor; partner-level links are untouched", async () => {
    const f = await seed();
    const loserLink = await insertLink(f, f.orgA1);
    const partnerLevel = await insertLink(f, null);

    await executeOrgMerge({ loserOrgId: f.orgA1, survivorOrgId: f.orgA2, partnerId: f.partnerA, performedBy: f.userA });

    const rows = await asSystem(() => db.select().from(wispThreadLinks)
      .where(inArray(wispThreadLinks.id, [loserLink.id, partnerLevel.id])));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(loserLink.id)!.orgId).toBe(f.orgA2);
    expect(byId.get(partnerLevel.id)!.orgId).toBeNull();
  }, 120_000);
});

describe('migration shape', () => {
  const list = <T>(rows: unknown): T[] => (Array.isArray(rows) ? rows : (rows as { rows: T[] }).rows) as T[];

  it('RLS is enabled and forced; the org-bound composite FKs are DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const cls = list<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(await asSystem(() => db.execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'wisp_thread_links' AND relkind = 'r'`)));
    expect(cls).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const fks = list<{ conname: string; condeferrable: boolean; condeferred: boolean }>(await asSystem(() => db.execute(sql`
      SELECT conname, condeferrable, condeferred FROM pg_constraint
       WHERE conname IN ('wisp_thread_links_org_partner_fk', 'wisp_thread_links_added_by_user_fk')`)));
    expect(fks).toHaveLength(2);
    for (const r of fks) {
      expect(r.condeferrable, r.conname).toBe(true);
      expect(r.condeferred, r.conname).toBe(false);
    }
  });

  it('the entity_kind CHECK lists exactly the eleven kinds, in order', async () => {
    const [row] = list<{ def: string }>(await asSystem(() => db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'wisp_thread_links_entity_kind_chk'`)));
    const kinds = [...row!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual(['ticket', 'quote', 'invoice', 'contract', 'device', 'organization', 'site', 'alert', 'run', 'task', 'user']);
  });
});
