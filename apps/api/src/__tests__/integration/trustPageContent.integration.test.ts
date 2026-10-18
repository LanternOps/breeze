import './setup';

import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { trustPageFaqItems, trustPages, trustPageSnapshots, trustPageSubprocessors } from '../../db/schema';
import { ensureTrustPage, publishTrustPage, refreshPublishedPage } from '../../services/trustPage/publication';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

async function seed() {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `nw-content-${suffix}`;
  const orgSlug = `acme-content-${suffix}`;
  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Northwind IT', ${partnerSlug}, 'active', 'trusted', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`trust-content-${suffix}@example.com`}, 'Trust Publisher', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partner!.id}, 'Acme Dental', ${orgSlug}, 'active', 'USD', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { partnerId: partner!.id, orgId: org!.id, userId: user!.id, partnerSlug, orgSlug };
}

const publish = (s: Awaited<ReturnType<typeof seed>>, expectedRevision: number) => sys(() => publishTrustPage({
  orgId: s.orgId, expectedRevision, actorUserId: s.userId, authorization: { authorizedBy: 'Jane Doe, COO' },
  partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
}));

describe('trust page subprocessors, FAQ and history (real database)', () => {
  it('freezes the draft rows at publish, builds history from earlier snapshots, and keeps both on refresh', async () => {
    const s = await seed();
    const page = await sys(() => ensureTrustPage(s.orgId, s.userId));
    await sys(async () => {
      await db.insert(trustPageSubprocessors).values([
        { trustPageId: page.id, orgId: s.orgId, name: 'Second', purpose: 'Backup', location: null, websiteUrl: 'https://b.example', source: 'backup', sourceKey: 'backup:second', sortOrder: 1 },
        { trustPageId: page.id, orgId: s.orgId, name: 'First', purpose: 'Endpoint security', location: 'US', websiteUrl: null, source: 'manual', sortOrder: 0 },
      ]);
      // A hostile answer written straight into the table (bypassing the route) must still not reach the public payload.
      await db.insert(trustPageFaqItems).values({ trustPageId: page.id, orgId: s.orgId, question: 'Is data encrypted?', answerHtml: '<p>Yes</p><script>alert(1)</script>', sortOrder: 0 });
      await db.update(trustPages).set({ showHistory: true }).where(eq(trustPages.id, page.id));
      // Two earlier snapshots: one before the 90-day window (baseline) and one inside it.
      for (const [daysAgo, met] of [[120, 5], [30, 8]] as const) {
        await db.insert(trustPageSnapshots).values({
          trustPageId: page.id, orgId: s.orgId, isCurrent: false, publicationRevision: 0, catalogVersion: 'test',
          payloadSha256: String(daysAgo).padStart(64, '0'),
          generatedAt: new Date(Date.now() - daysAgo * 86_400_000),
          payload: { summary: { catalogTotal: 16, controlsShown: 16, controlsMet: met, deviceCount: null } } as never,
        });
      }
    });

    const published = await publish(s, page.publicationRevision);
    expect(published).toBeTruthy();
    const read = async () => {
      const [cur] = await sys(() => db.select().from(trustPageSnapshots).where(sql`${trustPageSnapshots.trustPageId} = ${page.id} AND ${trustPageSnapshots.isCurrent}`));
      return cur!.payload as { subprocessors: unknown[]; faq: Array<{ answerHtml: string }>; history: Array<{ met: number }> };
    };

    const payload = await read();
    expect(payload.subprocessors).toEqual([
      { name: 'First', purpose: 'Endpoint security', location: 'US', websiteUrl: null },
      { name: 'Second', purpose: 'Backup', location: null, websiteUrl: 'https://b.example' },
    ]);
    expect(payload.faq).toHaveLength(1);
    expect(payload.faq[0]!.answerHtml).toContain('Yes');
    expect(payload.faq[0]!.answerHtml).not.toContain('script');
    expect(payload.history.map((p) => p.met)).toEqual([5, 8]);

    // A draft edit after publish does not reach the public page until the next publish (Ruling 20), and the
    // hourly refresh keeps serving the frozen blocks.
    await sys(() => db.delete(trustPageSubprocessors).where(eq(trustPageSubprocessors.trustPageId, page.id)));
    await sys(() => refreshPublishedPage(page.id));
    expect((await read()).subprocessors).toHaveLength(2);
  });
});
