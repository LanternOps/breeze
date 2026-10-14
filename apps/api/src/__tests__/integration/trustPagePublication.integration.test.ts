import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { trustPages, trustPageSnapshots } from '../../db/schema';
import { getRedis } from '../../services/redis';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { TRUST_SERVING_SET_KEY } from '../../services/trustPage/servingSet';
import { ensureTrustPage, publishTrustPage, refreshPublishedPage, unpublishTrustPage } from '../../services/trustPage/publication';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

interface Seeded { partnerId: string; orgId: string; userId: string; partnerSlug: string; orgSlug: string }

/** Superuser seed (no RLS): one trusted active partner, one active org with a lowercase slug, one user. */
async function seedTrustedPartnerWithOrg(): Promise<Seeded> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `nw-int-${suffix}`;
  const orgSlug = `acme-int-${suffix}`;
  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Northwind IT', ${partnerSlug}, 'active', 'trusted', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`trust-pub-${suffix}@example.com`}, 'Trust Publisher', 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partner!.id}, 'Acme Dental', ${orgSlug}, 'active', 'USD', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { partnerId: partner!.id, orgId: org!.id, userId: user!.id, partnerSlug, orgSlug };
}

async function currentSnapshots(pageId: string) {
  return sys(() => db.select().from(trustPageSnapshots)
    .where(and(eq(trustPageSnapshots.trustPageId, pageId), eq(trustPageSnapshots.isCurrent, true))));
}

async function allSnapshots(pageId: string) {
  return sys(() => db.select().from(trustPageSnapshots).where(eq(trustPageSnapshots.trustPageId, pageId)));
}

async function publishFirst(s: Seeded) {
  await sys(() => ensureTrustPage(s.orgId, s.userId));
  return sys(() => publishTrustPage({
    orgId: s.orgId, expectedRevision: 0, actorUserId: s.userId, authorization: { authorizedBy: 'Jane Doe, COO' },
    partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
  }));
}

const isServingMember = async (member: string) => (await getRedis()!.sismember(TRUST_SERVING_SET_KEY, member)) === 1;

describe('trust page publication', () => {
  let s: Seeded;
  beforeEach(async () => { s = await seedTrustedPartnerWithOrg(); });

  it('a customer page without an attestation is refused 422 and nothing is written', async () => {
    const page = await sys(() => ensureTrustPage(s.orgId, s.userId));
    await expect(sys(() => publishTrustPage({
      orgId: s.orgId, expectedRevision: 0, actorUserId: s.userId, partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
    }))).rejects.toMatchObject({ status: 422, code: 'AUTHORIZATION_REQUIRED' });
    expect(await allSnapshots(page.id)).toHaveLength(0);
    const [reloaded] = await sys(() => db.select().from(trustPages).where(eq(trustPages.id, page.id)));
    expect(reloaded!.publishedAt).toBeNull();
    expect(reloaded!.publicationRevision).toBe(0);
  });

  it('publishes with an attestation, serves one current snapshot, 409s on a stale revision', async () => {
    const first = await publishFirst(s);
    expect(first.page.publicationRevision).toBe(1);
    expect(first.page.publishedAt).not.toBeNull();
    expect(first.page.publicationAuthorizedBy).toBe('Jane Doe, COO');
    expect(first.page.publicationAuthorizedByUserId).toBe(s.userId);
    expect(await isServingMember(`${s.partnerSlug}/${s.orgSlug}`)).toBe(true);

    // The stored attestation satisfies the requirement; the stale revision is what refuses it.
    await expect(sys(() => publishTrustPage({
      orgId: s.orgId, expectedRevision: 0, actorUserId: s.userId, partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
    }))).rejects.toMatchObject({ status: 409, code: 'REVISION_MISMATCH' });

    const current = await currentSnapshots(first.page.id);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(first.snapshotId);
    expect(current[0]!.publicationRevision).toBe(1);

    // A republish at the current revision demotes the previous snapshot (only is_current flips) and keeps published_at.
    const second = await sys(() => publishTrustPage({
      orgId: s.orgId, expectedRevision: 1, actorUserId: s.userId, partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
    }));
    expect(second.page.publicationRevision).toBe(2);
    expect(second.page.publishedAt!.getTime()).toBe(first.page.publishedAt!.getTime());
    const after = await allSnapshots(first.page.id);
    expect(after).toHaveLength(2);
    expect(after.filter((r) => r.isCurrent).map((r) => r.id)).toEqual([second.snapshotId]);
    const demoted = after.find((r) => r.id === first.snapshotId)!;
    expect(demoted.payloadSha256).toBe(current[0]!.payloadSha256);
    expect(demoted.publicationRevision).toBe(1);
  });

  it('refresh with unchanged evidence does not insert; a changed payload inserts at the same revision', async () => {
    const first = await publishFirst(s);
    const r = await refreshPublishedPage(first.page.id);
    expect(r).toEqual({ rebuilt: false, snapshotId: first.snapshotId });
    expect(await allSnapshots(first.page.id)).toHaveLength(1);
    const [reloaded] = await sys(() => db.select().from(trustPages).where(eq(trustPages.id, first.page.id)));
    expect(reloaded!.lastEvaluatedAt!.getTime()).toBeGreaterThanOrEqual(first.page.lastEvaluatedAt!.getTime());

    // A page-setting change alters the payload hash: the worker inserts a new current snapshot, revision unchanged.
    await sys(() => db.update(trustPages).set({ showManagedBy: false }).where(eq(trustPages.id, first.page.id)));
    const rebuilt = await refreshPublishedPage(first.page.id);
    expect(rebuilt.rebuilt).toBe(true);
    const current = await currentSnapshots(first.page.id);
    expect(current.map((c) => c.id)).toEqual([rebuilt.snapshotId]);
    expect(current[0]!.publicationRevision).toBe(1);
    expect(await allSnapshots(first.page.id)).toHaveLength(2);
  });

  it('a refresh racing a publish keeps exactly one is_current', async () => {
    const first = await publishFirst(s);
    // Force the refresh down its insert path so both writers demote+insert.
    await sys(() => db.update(trustPages).set({ showManagedBy: false }).where(eq(trustPages.id, first.page.id)));
    for (let i = 0; i < 3; i++) {
      const [page] = await sys(() => db.select().from(trustPages).where(eq(trustPages.id, first.page.id)));
      await sys(() => db.update(trustPages).set({ showDeviceCount: i % 2 === 0 }).where(eq(trustPages.id, page!.id)));
      const [refresh, publish] = await Promise.allSettled([
        refreshPublishedPage(page!.id),
        sys(() => publishTrustPage({
          orgId: s.orgId, expectedRevision: page!.publicationRevision, actorUserId: s.userId,
          partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
        })),
      ]);
      expect(refresh.status).toBe('fulfilled');
      expect(publish.status).toBe('fulfilled');
      const current = await currentSnapshots(page!.id);
      expect(current).toHaveLength(1);
      expect(current[0]!.publicationRevision).toBe(page!.publicationRevision + 1);
    }
  });

  it('snapshots are immutable except is_current', async () => {
    const first = await publishFirst(s);
    const err = await sys(() => db.update(trustPageSnapshots).set({ catalogVersion: 'tampered' })
      .where(eq(trustPageSnapshots.id, first.snapshotId))).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    const msg = `${(err as Error).message} ${((err as { cause?: Error }).cause)?.message ?? ''}`;
    expect(msg).toMatch(/immutable/);
    await expect(sys(() => db.update(trustPageSnapshots).set({ isCurrent: false })
      .where(eq(trustPageSnapshots.id, first.snapshotId)))).resolves.toBeDefined();
  });

  it('unpublish clears published_at, bumps the revision, removes the member and 409s an in-flight publish', async () => {
    const first = await publishFirst(s);
    const member = `${s.partnerSlug}/${s.orgSlug}`;
    expect(await isServingMember(member)).toBe(true);
    const u = await sys(() => unpublishTrustPage({ orgId: s.orgId, actorUserId: s.userId, partnerSlug: s.partnerSlug, orgSlug: s.orgSlug, isPartnerHome: false }));
    expect(u.publishedAt).toBeNull();
    expect(u.publicationRevision).toBe(first.page.publicationRevision + 1);
    expect(await isServingMember(member)).toBe(false);
    await expect(sys(() => publishTrustPage({
      orgId: s.orgId, expectedRevision: first.page.publicationRevision, actorUserId: s.userId,
      partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
    }))).rejects.toMatchObject({ status: 409 });
    // The worker leaves an unpublished page alone.
    expect(await refreshPublishedPage(first.page.id)).toEqual({ rebuilt: false, snapshotId: null });
  });

  it('erasing the org succeeds with a published page and leaves no trust_* rows', async () => {
    await publishFirst(s);
    await cascadeDeleteOrg(s.orgId, s.userId);
    const testDb = getTestDb();
    for (const table of ['trust_pages', 'trust_page_snapshots', 'trust_page_documents']) {
      const rows = (await testDb.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${s.orgId}`)) as unknown as Array<{ n: number }>;
      expect({ table, n: rows[0]!.n }).toEqual({ table, n: 0 });
    }
  });
});
