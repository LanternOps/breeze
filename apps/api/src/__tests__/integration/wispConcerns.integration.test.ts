/**
 * Wisp W05a Task 3 (#9911, feature #9906) — services/wisp/concerns.ts against
 * real Postgres: ceiling-filtered reads, the live-row upsert (subject and
 * signature arbiters, NULLS NOT DISTINCT partner-level subjects, cross-index
 * 23505), snooze survival on re-raise (Review Focus 5), per-grant recipient
 * state, and the concern_outcome memory block written on resolve.
 *
 * Read-side ceilings are plain GrantCeiling literals; grant rows are seeded
 * where FKs need them. The resolve-with-memory case builds a resolvable live
 * grant (active partner user with ai_sessions:use, Wisp switched on).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiMemoryBlocks,
  wispConcernRecipients,
  wispConcerns,
  wispGrantRevisions,
  wispGrants,
} from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import type { GrantCeiling } from '../../services/wisp/grantAuthority';
import {
  dismissConcern,
  getConcernForCeiling,
  listConcernsForCeiling,
  recipientState,
  recordFeedback,
  recordNudge,
  resolveConcern,
  snoozeConcern,
  updateConcern,
  upsertConcern,
} from '../../services/wisp/concerns';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

afterEach(() => {
  vi.unstubAllEnvs();
});

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

interface Fixture { partner: string; orgA: string; orgB: string; user: string; grant: string }

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `wisp-concerns-${randomUUID()}@wisp.test` });
  return {
    partner: partner.id, orgA: orgA.id, orgB: orgB.id, user: user.id,
    grant: await seedGrant(partner.id, user.id, [orgA.id, orgB.id]),
  };
}

/** A second live grant in the same partner (one live grant per grantor + scope, so a second grantor). */
async function secondGrant(f: Fixture, orgIds: string[]): Promise<string> {
  const other = await createUser({ partnerId: f.partner, email: `wisp-concerns-2-${randomUUID()}@wisp.test` });
  return seedGrant(f.partner, other.id, orgIds);
}

const ceilingFor = (f: Fixture, over: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: f.grant, revisionId: randomUUID(), partnerId: f.partner, grantorUserId: f.user,
  scopeOrgId: null, partnerWide: false, orgIds: new Set([f.orgA]), siteIds: null,
  permissionKeys: new Set(['ai_sessions:use']), toolAllowlist: null, deniedTools: new Set(),
  orgTerms: new Map(), status: 'active', ...over,
});

const input = (f: Fixture, orgId: string | null, over: Partial<Parameters<typeof upsertConcern>[0]> = {}) => ({
  partnerId: f.partner, orgId, subject: { kind: 'ticket' as const, id: randomUUID() },
  summary: 'Ticket waiting on the customer for 3 days', severity: 'medium' as const, evidence: { days: 3 }, ...over,
});

const concernRows = (partnerId: string) =>
  asSystem(() => db.select().from(wispConcerns).where(eq(wispConcerns.partnerId, partnerId)));

const concernById = async (id: string) => {
  const [row] = await asSystem(() => db.select().from(wispConcerns).where(eq(wispConcerns.id, id)));
  return row!;
};

const recipientRow = async (concernId: string, grantId: string) => {
  const [row] = await asSystem(() => db.select().from(wispConcernRecipients)
    .where(and(eq(wispConcernRecipients.concernId, concernId), eq(wispConcernRecipients.grantId, grantId))));
  return row;
};

describe('listConcernsForCeiling / getConcernForCeiling', () => {
  it('an org-A-only ceiling lists A\'s concern and never B\'s (one partner, two orgs)', async () => {
    const f = await seed();
    const a = await upsertConcern(input(f, f.orgA));
    const b = await upsertConcern(input(f, f.orgB));
    const c = ceilingFor(f);

    const ids = (await listConcernsForCeiling(c)).map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(await listConcernsForCeiling(c, { orgId: f.orgB })).toEqual([]);
    expect((await listConcernsForCeiling(c, { orgId: f.orgA })).map((x) => x.id)).toEqual([a.id]);

    expect((await getConcernForCeiling(c, a.id))?.id).toBe(a.id);
    expect(await getConcernForCeiling(c, b.id)).toBeNull();
    expect(await getConcernForCeiling(c, randomUUID())).toBeNull();
  });

  it('a site-restricted ceiling reads no concerns of the restricted org (fail closed: subjects carry no site)', async () => {
    const f = await seed();
    const a = await upsertConcern(input(f, f.orgA));
    const siteId = randomUUID();
    const ceilingWide = ceilingFor(f, { siteIds: new Set([siteId]) });
    expect(await listConcernsForCeiling(ceilingWide)).toEqual([]);
    expect(await listConcernsForCeiling(ceilingWide, { orgId: f.orgA })).toEqual([]);
    expect(await getConcernForCeiling(ceilingWide, a.id)).toBeNull();
    const ceilingOrgTerm = ceilingFor(f, {
      orgIds: new Set([f.orgA, f.orgB]),
      orgTerms: new Map([[f.orgA, { permissionKeys: new Set(['*:*']), siteIds: new Set([siteId]) }]]),
    });
    const b = await upsertConcern(input(f, f.orgB));
    const ids = (await listConcernsForCeiling(ceilingOrgTerm)).map((x) => x.id);
    expect(ids).toEqual([b.id]);
    expect(await getConcernForCeiling(ceilingOrgTerm, a.id)).toBeNull();
  });

  it('a site-restricted partner-wide ceiling never reads a partner-level concern', async () => {
    const f = await seed();
    const p = await upsertConcern(input(f, null, { subject: { kind: 'incident', id: randomUUID() } }));
    const c = ceilingFor(f, { scopeOrgId: null, partnerWide: true, siteIds: new Set([randomUUID()]) });
    expect(await listConcernsForCeiling(c)).toEqual([]);
    expect(await getConcernForCeiling(c, p.id)).toBeNull();
    // Control: the same ceiling without the site restriction sees it.
    expect((await getConcernForCeiling(ceilingFor(f, { scopeOrgId: null, partnerWide: true }), p.id))?.id).toBe(p.id);
  });

  it('an org-scoped ceiling never sees a partner-level concern; a partner-wide one does', async () => {
    const f = await seed();
    const partnerLevel = await upsertConcern(input(f, null, { subject: { kind: 'incident', id: randomUUID() }, severity: 'high' }));
    const orgLevel = await upsertConcern(input(f, f.orgA));

    const scoped = ceilingFor(f, { scopeOrgId: f.orgA, partnerWide: false });
    expect((await listConcernsForCeiling(scoped)).map((x) => x.id)).toEqual([orgLevel.id]);
    expect(await getConcernForCeiling(scoped, partnerLevel.id)).toBeNull();

    // Partner-wide grant whose grantor no longer reaches the whole partner: still closed.
    const narrowed = ceilingFor(f, { scopeOrgId: null, partnerWide: false });
    expect((await listConcernsForCeiling(narrowed)).map((x) => x.id)).not.toContain(partnerLevel.id);

    const wide = ceilingFor(f, { scopeOrgId: null, partnerWide: true, orgIds: new Set([f.orgA, f.orgB]) });
    const listed = await listConcernsForCeiling(wide);
    // high before medium
    expect(listed.map((x) => x.id)).toEqual([partnerLevel.id, orgLevel.id]);
    expect(listed[0]!.orgId).toBeNull();
    expect((await getConcernForCeiling(wide, partnerLevel.id))?.id).toBe(partnerLevel.id);
  });

  it('joins the caller grant\'s recipient row only', async () => {
    const f = await seed();
    const a = await upsertConcern(input(f, f.orgA));
    const at = new Date('2026-10-24T10:00:00Z');
    await recordNudge(a.id, f.grant, at);
    await recordNudge(a.id, f.grant, new Date(at.getTime() + 31 * 60_000));
    const [mine] = await listConcernsForCeiling(ceilingFor(f));
    expect(mine!.recipient).toMatchObject({ nudgeCount: 2, digestOnly: true });

    const otherGrant = await secondGrant(f, [f.orgA]);
    const [theirs] = await listConcernsForCeiling(ceilingFor(f, { grantId: otherGrant }));
    expect(theirs!.recipient).toBeUndefined();
  });
});

describe('upsertConcern', () => {
  it('twice on one subject → one row; the second is created:false with the same id', async () => {
    const f = await seed();
    const i = input(f, f.orgA);
    const first = await upsertConcern(i);
    const second = await upsertConcern({ ...i, summary: 'different words', severity: 'high' });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    const rows = await concernRows(f.partner);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe('Ticket waiting on the customer for 3 days');
  });

  it('a partner-level (org_id null) subject dedupes too (NULLS NOT DISTINCT)', async () => {
    const f = await seed();
    const i = input(f, null, { subject: { kind: 'incident', id: randomUUID() } });
    const first = await upsertConcern(i);
    const second = await upsertConcern(i);
    expect(second).toEqual({ id: first.id, created: false });
    expect(await concernRows(f.partner)).toHaveLength(1);
  });

  it('twice on one signature → one row, across different subjects', async () => {
    const f = await seed();
    const first = await upsertConcern(input(f, f.orgA, { subject: { kind: 'incident', id: randomUUID() }, signature: 'sig-1' }));
    const second = await upsertConcern(input(f, f.orgA, { subject: { kind: 'incident', id: randomUUID() }, signature: 'sig-1' }));
    expect(second).toEqual({ id: first.id, created: false });
    expect(await concernRows(f.partner)).toHaveLength(1);
  });

  it('a signature upsert whose SUBJECT collides with a live concern returns created:false (no throw)', async () => {
    const f = await seed();
    const chatRaised = await upsertConcern(input(f, f.orgA, { subject: { kind: 'org', id: f.orgA } }));
    const readiness = await upsertConcern(input(f, f.orgA, {
      subject: { kind: 'org', id: f.orgA }, signature: `readiness:${f.orgA}`, severity: 'info',
    }));
    expect(readiness).toEqual({ id: chatRaised.id, created: false });
    expect(await concernRows(f.partner)).toHaveLength(1);
  });

  it('updateConcern replaces evidence (no merge) and leaves status alone; unknown id is a no-op', async () => {
    const f = await seed();
    const c = await upsertConcern(input(f, f.orgA, { evidence: { a: 1, b: 2 } }));
    await updateConcern(c.id, { evidence: { c: 3 }, severity: 'high', summary: '  updated  ' });
    const row = await concernById(c.id);
    expect(row).toMatchObject({ evidence: { c: 3 }, severity: 'high', summary: 'updated', status: 'open' });
    await expect(updateConcern(randomUUID(), { severity: 'low' })).resolves.toBeUndefined();
  });

  it('resolve then upsert → a new row', async () => {
    const f = await seed();
    const i = input(f, f.orgA);
    const first = await upsertConcern(i);
    await resolveConcern(first.id, { userId: f.user }, 'customer replied');
    const second = await upsertConcern(i);
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    const resolved = await concernById(first.id);
    expect(resolved).toMatchObject({ status: 'resolved', outcome: 'customer replied', resolvedByUserId: f.user });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
  });

  it('snooze then upsert → created:false and snoozed_until unchanged (Review Focus 5)', async () => {
    const f = await seed();
    const i = input(f, f.orgA);
    const first = await upsertConcern(i);
    const until = new Date(Date.now() + 2 * 86_400_000);
    await snoozeConcern(first.id, { grantId: f.grant, userId: f.user }, until);
    expect((await concernById(first.id)).status).toBe('snoozed');

    const again = await upsertConcern({ ...i, severity: 'high' });
    expect(again).toEqual({ id: first.id, created: false });
    const after = await concernById(first.id);
    expect(after.status).toBe('snoozed');
    expect(after.severity).toBe('medium');
    expect((await recipientState(first.id, f.grant)).snoozedUntil?.getTime()).toBe(until.getTime());
  });
});

describe('recipients', () => {
  it('recordNudge twice → counts 1 then 2, next eligible +30 then +60 minutes', async () => {
    const f = await seed();
    const c = await upsertConcern(input(f, f.orgA));
    const t1 = new Date('2026-10-24T10:00:00Z');
    const n1 = await recordNudge(c.id, f.grant, t1);
    expect(n1).toEqual({ nudgeCount: 1, nextEligibleNudgeAt: new Date(t1.getTime() + 30 * 60_000) });
    const t2 = new Date('2026-10-24T10:45:00Z');
    const n2 = await recordNudge(c.id, f.grant, t2);
    expect(n2).toEqual({ nudgeCount: 2, nextEligibleNudgeAt: new Date(t2.getTime() + 60 * 60_000) });

    const row = await recipientRow(c.id, f.grant);
    expect(row).toMatchObject({ partnerId: f.partner, orgId: f.orgA, nudgeCount: 2 });
    expect(row!.lastNudgedAt?.getTime()).toBe(t2.getTime());
    expect(await recipientState(c.id, f.grant)).toEqual({
      nudgeCount: 2, nextEligibleNudgeAt: n2.nextEligibleNudgeAt, snoozedUntil: null, dismissedAt: null,
    });
  });

  it('recipientState is zeros/nulls when no row exists', async () => {
    const f = await seed();
    const c = await upsertConcern(input(f, f.orgA));
    expect(await recipientState(c.id, f.grant)).toEqual({
      nudgeCount: 0, nextEligibleNudgeAt: null, snoozedUntil: null, dismissedAt: null,
    });
  });

  it('dismiss by the only recipient → status dismissed; with a second open recipient → stays open', async () => {
    const f = await seed();
    const solo = await upsertConcern(input(f, f.orgA));
    await dismissConcern(solo.id, { grantId: f.grant, userId: f.user });
    expect((await concernById(solo.id)).status).toBe('dismissed');
    expect((await recipientRow(solo.id, f.grant))!.dismissedAt).toBeInstanceOf(Date);

    const shared = await upsertConcern(input(f, f.orgA));
    const otherGrant = await secondGrant(f, [f.orgA]);
    await recordNudge(shared.id, otherGrant, new Date());
    await dismissConcern(shared.id, { grantId: f.grant, userId: f.user });
    expect((await concernById(shared.id)).status).toBe('open');
  });

  it('snooze with a second OPEN recipient keeps the concern open; an expired snooze does not count as snoozed', async () => {
    const f = await seed();
    const c = await upsertConcern(input(f, f.orgA));
    const otherGrant = await secondGrant(f, [f.orgA]);
    await recordNudge(c.id, otherGrant, new Date());
    await snoozeConcern(c.id, { grantId: f.grant, userId: f.user }, new Date(Date.now() + 86_400_000));
    expect((await concernById(c.id)).status).toBe('open');

    // The other recipient's snooze is already over → it is open again → still 'open'.
    await asSystem(() => db.update(wispConcernRecipients).set({ snoozedUntil: new Date(Date.now() - 60_000) })
      .where(and(eq(wispConcernRecipients.concernId, c.id), eq(wispConcernRecipients.grantId, otherGrant))));
    await snoozeConcern(c.id, { grantId: f.grant, userId: f.user }, new Date(Date.now() + 86_400_000));
    expect((await concernById(c.id)).status).toBe('open');

    // Once the other recipient also snoozes, nobody is open → 'snoozed'.
    await snoozeConcern(c.id, { grantId: otherGrant, userId: f.user }, new Date(Date.now() + 3_600_000));
    expect((await concernById(c.id)).status).toBe('snoozed');
  });

  it('two recipients dismissing concurrently still close the concern (row lock serialises the aggregate)', async () => {
    const f = await seed();
    for (let i = 0; i < 5; i++) {
      const c = await upsertConcern(input(f, f.orgA));
      const otherGrant = await secondGrant(f, [f.orgA]);
      await recordNudge(c.id, otherGrant, new Date());
      await recordNudge(c.id, f.grant, new Date());
      await Promise.all([
        dismissConcern(c.id, { grantId: f.grant, userId: f.user }),
        dismissConcern(c.id, { grantId: otherGrant, userId: f.user }),
      ]);
      expect((await concernById(c.id)).status).toBe('dismissed');
    }
  });

  it('dismissing a resolved concern leaves its status alone', async () => {
    const f = await seed();
    const c = await upsertConcern(input(f, f.orgA));
    await resolveConcern(c.id, {}, 'fixed');
    await dismissConcern(c.id, { grantId: f.grant, userId: f.user });
    await snoozeConcern(c.id, { grantId: f.grant, userId: f.user }, new Date(Date.now() + 86_400_000));
    expect((await concernById(c.id)).status).toBe('resolved');
  });

  it('feedback not_useful pushes next eligible +24 h and resets the nudge count', async () => {
    const f = await seed();
    const c = await upsertConcern(input(f, f.orgA));
    await recordNudge(c.id, f.grant, new Date('2026-10-24T09:00:00Z'));
    const at = new Date('2026-10-24T10:00:00Z');
    await recordFeedback(c.id, f.grant, { useful: false, note: '  not mine  ' }, at);
    const row = await recipientRow(c.id, f.grant);
    expect(row).toMatchObject({ feedback: 'not_useful', feedbackNote: 'not mine', nudgeCount: 0 });
    expect(row!.nextEligibleNudgeAt?.getTime()).toBe(at.getTime() + 24 * 3_600_000);
    expect(row!.answeredAt?.getTime()).toBe(at.getTime());
  });
});

describe('resolveConcern with a live grant', () => {
  it('writes one ai_memory_blocks row of type concern_outcome; a second resolve writes nothing', async () => {
    vi.stubEnv('IS_HOSTED', 'true');
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
    vi.stubEnv('BREEZE_WISP_ENABLED', 'true');

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const grantor = await createUser({ partnerId: partner.id, email: `wisp-concern-live-${randomUUID()}@wisp.test` });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(role.id, [{ resource: 'ai_sessions', action: 'use' }]);
    await assignUserToPartner(grantor.id, partner.id, role.id, 'all');
    const snapshot: WispCeilingSnapshot = {
      version: 1, permissionKeys: ['ai_sessions:use'], orgIds: [org.id], siteIds: null,
      toolAllowlist: null, deniedTools: [], partnerWide: true,
    };
    const grantId = await asSystem(async () => {
      const [g] = await db.insert(wispGrants).values({
        partnerId: partner.id, grantorUserId: grantor.id, expiresAt: new Date(Date.now() + 30 * 86_400_000),
      }).returning({ id: wispGrants.id });
      const [r] = await db.insert(wispGrantRevisions).values({
        grantId: g!.id, partnerId: partner.id, revision: 1, ceilingSnapshot: snapshot,
        factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
      }).returning({ id: wispGrantRevisions.id });
      await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
      return g!.id;
    });

    const subjectId = randomUUID();
    const c = await upsertConcern({
      partnerId: partner.id, orgId: org.id, subject: { kind: 'ticket', id: subjectId },
      summary: 'Backup failing 3 nights', severity: 'high', evidence: {}, raisedByGrantId: grantId,
    });
    await resolveConcern(c.id, { grantId }, 'job re-pointed to the new NAS');
    await resolveConcern(c.id, { grantId }, 'again');

    const blocks = await asSystem(() => db.select().from(aiMemoryBlocks)
      .where(eq(aiMemoryBlocks.subjectKey, `concern:ticket:${subjectId}`)));
    try {
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({
        blockType: 'concern_outcome', ownerKind: 'org', ownerOrgId: org.id, tenantPartnerId: partner.id,
        authoredByGrantId: grantId, status: 'unconfirmed', confidence: 'medium',
        content: { summary: 'Backup failing 3 nights', outcome: 'job re-pointed to the new NAS', severity: 'high', resolvedBy: 'wisp' },
      });
      expect((await concernById(c.id)).outcome).toBe('job re-pointed to the new NAS');
    } finally {
      await asSystem(() => db.delete(aiMemoryBlocks).where(eq(aiMemoryBlocks.subjectKey, `concern:ticket:${subjectId}`)));
    }
  });

  it('a paused grant resolves the concern without a memory block', async () => {
    const f = await seed();
    await asSystem(() => db.update(wispGrants).set({ status: 'paused', pausedReason: 'user_paused' }).where(eq(wispGrants.id, f.grant)));
    const subjectId = randomUUID();
    const c = await upsertConcern(input(f, f.orgA, { subject: { kind: 'ticket', id: subjectId } }));
    await resolveConcern(c.id, { grantId: f.grant }, 'fixed');
    expect((await concernById(c.id)).status).toBe('resolved');
    const blocks = await asSystem(() => db.select().from(aiMemoryBlocks)
      .where(eq(aiMemoryBlocks.subjectKey, `concern:ticket:${subjectId}`)));
    expect(blocks).toHaveLength(0);
  });
});
