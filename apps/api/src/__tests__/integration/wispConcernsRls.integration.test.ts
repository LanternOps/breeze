/**
 * Wisp W05 (#9911, feature #9906) — `wisp_concerns`, `wisp_concern_recipients`
 * and `wisp_watches` against real Postgres
 * (migrations/2027-01-04-110300-wisp-concerns-watches.sql).
 *
 * `rls-coverage.integration.test.ts` proves the tables are REGISTERED. This
 * file is the functional proof: cross-partner / cross-org forges are refused,
 * partner-level (org_id NULL) rows are invisible to org tokens, the live
 * unique indexes hold (incl. NULLS NOT DISTINCT for partner-level subjects),
 * and every org-bound composite FK is DEFERRABLE INITIALLY IMMEDIATE.
 *
 * Grants are seeded straight into `wisp_grants` + `wisp_grant_revisions`
 * under system scope (createGrant needs a step-up proof).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  wispConcernRecipients,
  wispConcerns,
  wispGrantRevisions,
  wispGrants,
  wispWatches,
} from '../../db/schema';
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

interface Fixture {
  partnerA: string; partnerB: string;
  orgA1: string; orgA2: string; orgB1: string;
  userA: string; userB: string;
  grantA: string; grantB: string;
}

async function seed(): Promise<Fixture> {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  const uA = await createUser({ partnerId: partnerA.id, email: `wisp-concern-a-${randomUUID()}@wisp.test` });
  const uB = await createUser({ partnerId: partnerB.id, email: `wisp-concern-b-${randomUUID()}@wisp.test` });
  return {
    partnerA: partnerA.id, partnerB: partnerB.id,
    orgA1: orgA1.id, orgA2: orgA2.id, orgB1: orgB1.id,
    userA: uA.id, userB: uB.id,
    grantA: await seedGrant(partnerA.id, uA.id, [orgA1.id, orgA2.id]),
    grantB: await seedGrant(partnerB.id, uB.id, [orgB1.id]),
  };
}

const concernValues = (partnerId: string, orgId: string | null, extra: Partial<typeof wispConcerns.$inferInsert> = {}) => ({
  partnerId, orgId, subjectKind: 'ticket' as const, subjectId: randomUUID(),
  summary: 'Ticket waiting on the customer for 3 days', severity: 'medium' as const, ...extra,
});

const insertConcern = (partnerId: string, orgId: string | null, extra: Partial<typeof wispConcerns.$inferInsert> = {}) =>
  asSystem(async () => {
    const [row] = await db.insert(wispConcerns).values(concernValues(partnerId, orgId, extra)).returning();
    return row!;
  });

const watchValues = (f: Fixture, orgId: string | null) => ({
  partnerId: f.partnerA, orgId, grantId: f.grantA, ownerUserId: f.userA,
  kind: 'ticket_waiting' as const, cadenceMinutes: 60, nextDueAt: new Date(Date.now() + 3_600_000),
});

describe('wisp_concerns RLS (partner-anchored, org-optional)', () => {
  it('a partner-B org context cannot forge a concern into partner A\'s org (42501)', async () => {
    const f = await seed();
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
        db.insert(wispConcerns).values(concernValues(f.partnerA, f.orgA1))),
      '42501',
    );
  });

  it('a partner-B partner context cannot forge a partner-level concern for partner A (42501)', async () => {
    const f = await seed();
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), () =>
        db.insert(wispConcerns).values(concernValues(f.partnerA, null))),
      '42501',
    );
  });

  it('an org A1 token cannot read org A2 concerns of the same partner', async () => {
    const f = await seed();
    const c1 = await insertConcern(f.partnerA, f.orgA1);
    const c2 = await insertConcern(f.partnerA, f.orgA2);
    const visible = await withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
      db.select({ id: wispConcerns.id }).from(wispConcerns));
    const ids = visible.map((r) => r.id);
    expect(ids).toContain(c1.id);
    expect(ids).not.toContain(c2.id);
  });

  it('a partner-level (org_id NULL) concern is visible to its partner context and never to an org token', async () => {
    const f = await seed();
    const partnerLevel = await insertConcern(f.partnerA, null, { subjectKind: 'incident' });
    const asPartner = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA1, f.orgA2]), () =>
      db.select({ id: wispConcerns.id }).from(wispConcerns));
    expect(asPartner.map((r) => r.id)).toContain(partnerLevel.id);
    const asOrg = await withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
      db.select({ id: wispConcerns.id }).from(wispConcerns));
    expect(asOrg.map((r) => r.id)).not.toContain(partnerLevel.id);
    const asOtherPartner = await withDbAccessContext(partnerContext(f.partnerB, [f.orgB1]), () =>
      db.select({ id: wispConcerns.id }).from(wispConcerns));
    expect(asOtherPartner.map((r) => r.id)).not.toContain(partnerLevel.id);
  });

  it('live subject uniqueness: a second open concern for the subject is 23505; a resolved one does not block', async () => {
    const f = await seed();
    const subjectId = randomUUID();
    const first = await insertConcern(f.partnerA, f.orgA1, { subjectId });
    await expectSqlState(() => insertConcern(f.partnerA, f.orgA1, { subjectId }), '23505', 'wisp_concerns_live_subject_uq');
    await asSystem(() => db.update(wispConcerns).set({ status: 'resolved', outcome: 'done', resolvedAt: new Date() })
      .where(eq(wispConcerns.id, first.id)));
    const second = await insertConcern(f.partnerA, f.orgA1, { subjectId });
    expect(second.id).not.toBe(first.id);
  });

  it('snoozed counts as live for the unique index', async () => {
    const f = await seed();
    const subjectId = randomUUID();
    await insertConcern(f.partnerA, f.orgA1, { subjectId, status: 'snoozed' });
    await expectSqlState(() => insertConcern(f.partnerA, f.orgA1, { subjectId }), '23505', 'wisp_concerns_live_subject_uq');
  });

  it('NULLS NOT DISTINCT: two live partner-level concerns on one subject collide', async () => {
    const f = await seed();
    const subjectId = randomUUID();
    await insertConcern(f.partnerA, null, { subjectKind: 'incident', subjectId });
    await expectSqlState(
      () => insertConcern(f.partnerA, null, { subjectKind: 'incident', subjectId }),
      '23505', 'wisp_concerns_live_subject_uq',
    );
  });

  it('live signature uniqueness: two live concerns with one signature collide, across orgs', async () => {
    const f = await seed();
    await insertConcern(f.partnerA, f.orgA1, { signature: 'sig-1' });
    await expectSqlState(
      () => insertConcern(f.partnerA, f.orgA2, { signature: 'sig-1' }),
      '23505', 'wisp_concerns_live_signature_uq',
    );
    // A different partner may reuse the signature.
    await insertConcern(f.partnerB, f.orgB1, { signature: 'sig-1' });
  });

  it('the org/partner FK refuses an org of another partner (23503)', async () => {
    const f = await seed();
    await expectSqlState(() => insertConcern(f.partnerA, f.orgB1), '23503', 'wisp_concerns_org_partner_fk');
  });

  it('raised_by_grant_id must be a grant of the same partner (23503)', async () => {
    const f = await seed();
    await expectSqlState(() => insertConcern(f.partnerA, f.orgA1, { raisedByGrantId: f.grantB }), '23503', 'wisp_concerns_raised_by_grant_fk');
    const ok = await insertConcern(f.partnerA, f.orgA1, { raisedByGrantId: f.grantA });
    expect(ok.raisedByGrantId).toBe(f.grantA);
  });

  it('summary and evidence caps are enforced by CHECK (23514)', async () => {
    const f = await seed();
    await expectSqlState(() => insertConcern(f.partnerA, f.orgA1, { summary: 'x'.repeat(2001) }), '23514');
    await expectSqlState(() => insertConcern(f.partnerA, f.orgA1, { evidence: { blob: 'x'.repeat(40_000) } }), '23514');
    await expectSqlState(() => insertConcern(f.partnerA, f.orgA1, { subjectKind: 'nonsense' as never }), '23514');
  });

  it('the org cascade predicate (WHERE org_id = $1) never touches a partner-level concern', async () => {
    const f = await seed();
    const orgRow = await insertConcern(f.partnerA, f.orgA1);
    const partnerLevel = await insertConcern(f.partnerA, null, { subjectKind: 'incident' });
    await asSystem(() => db.delete(wispConcerns).where(eq(wispConcerns.orgId, f.orgA1)));
    const left = await asSystem(() => db.select({ id: wispConcerns.id }).from(wispConcerns)
      .where(eq(wispConcerns.partnerId, f.partnerA)));
    const ids = left.map((r) => r.id);
    expect(ids).not.toContain(orgRow.id);
    expect(ids).toContain(partnerLevel.id);
  });
});

describe('wisp_concern_recipients', () => {
  it('cascades with its concern and refuses a grant of another partner', async () => {
    const f = await seed();
    const concern = await insertConcern(f.partnerA, f.orgA1);
    await expectSqlState(
      () => asSystem(() => db.insert(wispConcernRecipients).values({
        concernId: concern.id, partnerId: f.partnerA, orgId: f.orgA1, grantId: f.grantB,
      })),
      '23503', 'wisp_concern_recipients_grant_fk',
    );
    await asSystem(() => db.insert(wispConcernRecipients).values({
      concernId: concern.id, partnerId: f.partnerA, orgId: f.orgA1, grantId: f.grantA,
    }));
    await expectSqlState(
      () => asSystem(() => db.insert(wispConcernRecipients).values({
        concernId: concern.id, partnerId: f.partnerA, orgId: f.orgA1, grantId: f.grantA,
      })),
      '23505', 'wisp_concern_recipients_concern_grant_uq',
    );
    await asSystem(() => db.delete(wispConcerns).where(eq(wispConcerns.id, concern.id)));
    const left = await asSystem(() => db.select().from(wispConcernRecipients)
      .where(eq(wispConcernRecipients.concernId, concern.id)));
    expect(left).toHaveLength(0);
  });

  it('a recipient row cannot point at a concern of another partner (23503)', async () => {
    const f = await seed();
    const concernB = await insertConcern(f.partnerB, f.orgB1);
    await expectSqlState(
      () => asSystem(() => db.insert(wispConcernRecipients).values({
        concernId: concernB.id, partnerId: f.partnerA, orgId: f.orgA1, grantId: f.grantA,
      })),
      '23503', 'wisp_concern_recipients_concern_fk',
    );
  });

  it('an org token never reads a partner-level recipient row; feedback CHECK holds', async () => {
    const f = await seed();
    const partnerLevel = await insertConcern(f.partnerA, null, { subjectKind: 'incident' });
    await asSystem(() => db.insert(wispConcernRecipients).values({
      concernId: partnerLevel.id, partnerId: f.partnerA, orgId: null, grantId: f.grantA,
    }));
    const asOrg = await withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
      db.select().from(wispConcernRecipients).where(eq(wispConcernRecipients.concernId, partnerLevel.id)));
    expect(asOrg).toHaveLength(0);
    const asPartner = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA1, f.orgA2]), () =>
      db.select().from(wispConcernRecipients).where(eq(wispConcernRecipients.concernId, partnerLevel.id)));
    expect(asPartner).toHaveLength(1);
    await expectSqlState(
      () => asSystem(() => db.update(wispConcernRecipients).set({ feedback: 'meh' as never })
        .where(eq(wispConcernRecipients.concernId, partnerLevel.id))),
      '23514',
    );
  });
});

describe('wisp_watches', () => {
  it('an org_id NULL watch is visible to the partner context and invisible to an org token', async () => {
    const f = await seed();
    const [partnerWide] = await asSystem(() => db.insert(wispWatches).values(watchValues(f, null)).returning());
    const asPartner = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA1, f.orgA2]), () =>
      db.select({ id: wispWatches.id }).from(wispWatches));
    expect(asPartner.map((r) => r.id)).toContain(partnerWide!.id);
    const asOrg = await withDbAccessContext(orgContext(f.orgA1, f.partnerA), () =>
      db.select({ id: wispWatches.id }).from(wispWatches));
    expect(asOrg.map((r) => r.id)).not.toContain(partnerWide!.id);
  });

  it('cadence CHECK and the owner/partner FK hold', async () => {
    const f = await seed();
    await expectSqlState(
      () => asSystem(() => db.insert(wispWatches).values({ ...watchValues(f, f.orgA1), cadenceMinutes: 14 })),
      '23514',
    );
    await expectSqlState(
      () => asSystem(() => db.insert(wispWatches).values({ ...watchValues(f, f.orgA1), ownerUserId: f.userB })),
      '23503', 'wisp_watches_owner_fk',
    );
  });

  it('a partner-B org context cannot forge a watch for partner A (42501)', async () => {
    const f = await seed();
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgB1, f.partnerB), () =>
        db.insert(wispWatches).values(watchValues(f, f.orgA1))),
      '42501',
    );
  });
});

describe('migration shape', () => {
  it('every org-bound composite FK on the three tables is DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const rows = await asSystem(() => db.execute<{ conname: string; condeferrable: boolean; condeferred: boolean }>(sql`
      SELECT conname, condeferrable, condeferred
        FROM pg_constraint
       WHERE conname IN (
         'wisp_concerns_org_partner_fk',
         'wisp_concern_recipients_org_partner_fk',
         'wisp_watches_org_partner_fk',
         'wisp_watches_owner_fk'
       )`));
    const list = Array.isArray(rows) ? rows : (rows as { rows: typeof rows }).rows;
    expect(list).toHaveLength(4);
    for (const r of list as Array<{ conname: string; condeferrable: boolean; condeferred: boolean }>) {
      expect(r.condeferrable, r.conname).toBe(true);
      expect(r.condeferred, r.conname).toBe(false);
    }
  });

  it('RLS is enabled and forced on all three tables', async () => {
    const rows = await asSystem(() => db.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('wisp_concerns','wisp_concern_recipients','wisp_watches') AND relkind = 'r'`));
    const list = (Array.isArray(rows) ? rows : (rows as { rows: typeof rows }).rows) as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(list).toHaveLength(3);
    for (const r of list) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
    }
  });

  it('wisp_grants.last_floor_tick_at exists and is nullable', async () => {
    const f = await seed();
    const [g] = await asSystem(() => db.select({ t: wispGrants.lastFloorTickAt }).from(wispGrants).where(eq(wispGrants.id, f.grantA)));
    expect(g!.t).toBeNull();
  });
});
