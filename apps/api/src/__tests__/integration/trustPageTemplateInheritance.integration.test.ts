// apps/api/src/__tests__/integration/trustPageTemplateInheritance.integration.test.ts
// Trust Center W2 sub-wave W02g (#8770): the partner template is the middle level of page → template → default,
// it is frozen at publish (a later template edit does not reach a published page until republish), and a
// publish whose editor loaded an older template revision is 409 TEMPLATE_CHANGED (Review Focus 5).
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { trustPages, trustPageSnapshots } from '../../db/schema';
import {
  buildSnapshotForPage, ensureTrustPage, publishTrustPage, refreshPublishedPage, resolveTrustPageSettings,
} from '../../services/trustPage/publication';
import { loadPartnerTemplate, savePartnerTemplate } from '../../services/trustPage/template';
import type { TrustPagePublicPayload } from '@breeze/shared';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

interface Seeded { partnerId: string; orgId: string; userId: string; partnerSlug: string; orgSlug: string }

/** Superuser seed (no RLS): one trusted active partner, one active org, one user. */
async function seed(): Promise<Seeded> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `tpl-int-${suffix}`;
  const orgSlug = `acme-tpl-${suffix}`;
  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Northwind IT', ${partnerSlug}, 'active', 'trusted', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`trust-tpl-${suffix}@example.com`}, 'Template Admin', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partner!.id}, 'Acme Dental', ${orgSlug}, 'active', 'USD', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { partnerId: partner!.id, orgId: org!.id, userId: user!.id, partnerSlug, orgSlug };
}

async function saveTemplate(s: Seeded, expectedRevision: number, patch: Parameters<typeof savePartnerTemplate>[0]['patch']) {
  const out = await sys(() => savePartnerTemplate({ partnerId: s.partnerId, expectedRevision, patch, actorUserId: s.userId, actor: { scope: 'system' } }));
  if (!out.ok) throw new Error('template save unexpectedly hit a revision mismatch');
  return out.revision;
}
async function freshPage(s: Seeded) {
  return sys(() => ensureTrustPage(s.orgId, s.userId));
}
async function reloadPage(pageId: string) {
  const [p] = await sys(() => db.select().from(trustPages).where(eq(trustPages.id, pageId)));
  return p!;
}
async function currentPayload(pageId: string): Promise<TrustPagePublicPayload> {
  const [cur] = await sys(() => db.select().from(trustPageSnapshots)
    .where(and(eq(trustPageSnapshots.trustPageId, pageId), eq(trustPageSnapshots.isCurrent, true))));
  return cur!.payload as TrustPagePublicPayload;
}
const publish = (s: Seeded, expectedRevision: number, expectedTemplateRevision?: number | null) => sys(() => publishTrustPage({
  orgId: s.orgId, expectedRevision, actorUserId: s.userId, authorization: { authorizedBy: 'Jane Doe, COO' },
  partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug, expectedTemplateRevision,
}));

describe('trust page partner template inheritance', () => {
  let s: Seeded;
  beforeEach(async () => { s = await seed(); });

  it('a page with no value of its own inherits the template (draft build and effective sources)', async () => {
    await saveTemplate(s, 0, { showManagedBy: false });
    const page = await freshPage(s);
    expect(page.showManagedBy).toBeNull();

    const { effective, template } = await sys(() => resolveTrustPageSettings(page));
    expect(effective.sources.showManagedBy).toBe('template');
    expect(effective.values.showManagedBy).toBe(false);
    expect(template).toEqual({ revision: 1 });
    // Untouched template keys still come from the Breeze default.
    expect(effective.sources.showPercentages).toBe('default');

    const built = await sys(() => buildSnapshotForPage(page, { config: 'draft' }));
    expect(built.payload.managedBy).toBeNull();
  });

  it("the page's own explicit value wins over the template", async () => {
    await saveTemplate(s, 0, { showManagedBy: false });
    const page = await freshPage(s);
    await sys(() => db.update(trustPages).set({ showManagedBy: true }).where(eq(trustPages.id, page.id)));
    const reloaded = await reloadPage(page.id);

    const { effective } = await sys(() => resolveTrustPageSettings(reloaded));
    expect(effective.sources.showManagedBy).toBe('page');
    const built = await sys(() => buildSnapshotForPage(reloaded, { config: 'draft' }));
    expect(built.payload.managedBy).not.toBeNull();
    expect(built.payload.managedBy?.name).toBe('Northwind IT');
  });

  it("the template intro is inherited, and a page's explicit '' (no intro) does not fall back to it", async () => {
    await saveTemplate(s, 0, { introHtml: '<p>We monitor every device.</p>' });
    const page = await freshPage(s);
    const inherited = await sys(() => buildSnapshotForPage(page, { config: 'draft' }));
    expect(inherited.payload.introHtml).toContain('We monitor every device.');

    await sys(() => db.update(trustPages).set({ introHtml: '' }).where(eq(trustPages.id, page.id)));
    const { effective } = await sys(async () => resolveTrustPageSettings(await reloadPage(page.id)));
    expect(effective.sources.introHtml).toBe('page');
    expect(effective.values.introHtml).toBeNull();
    const none = await sys(async () => buildSnapshotForPage(await reloadPage(page.id), { config: 'draft' }));
    expect(none.payload.introHtml).toBeNull();
  });

  it('publish with the loaded template revision succeeds; after a template edit the old revision is 409 TEMPLATE_CHANGED', async () => {
    const rev1 = await saveTemplate(s, 0, { showManagedBy: false });
    await freshPage(s);
    const first = await publish(s, 0, rev1);
    expect(first.page.publicationRevision).toBe(1);

    const rev2 = await saveTemplate(s, rev1, { showManagedBy: true });
    expect(rev2).toBe(rev1 + 1);
    await expect(publish(s, 1, rev1)).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_CHANGED' });
    // Nothing was written by the refused publish.
    expect((await reloadPage(first.page.id)).publicationRevision).toBe(1);

    // Reloaded editor → current revision → publish goes through.
    const second = await publish(s, 1, rev2);
    expect(second.page.publicationRevision).toBe(2);
  });

  it('an editor that loaded "no template" (null) is refused once a template exists', async () => {
    await freshPage(s);
    expect(await sys(() => loadPartnerTemplate(s.partnerId))).toBeNull();
    await saveTemplate(s, 0, { showHistory: true });
    await expect(publish(s, 0, null)).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_CHANGED' });
  });

  it('the template is frozen at publish: a later template edit does not change the next refresh', async () => {
    const rev1 = await saveTemplate(s, 0, { showManagedBy: false });
    await freshPage(s);
    const first = await publish(s, 0, rev1);
    expect((await currentPayload(first.page.id)).managedBy).toBeNull();
    expect((await reloadPage(first.page.id)).publishedConfig).toMatchObject({ showManagedBy: false });

    await saveTemplate(s, rev1, { showManagedBy: true, introHtml: '<p>New template intro</p>' });
    await refreshPublishedPage(first.page.id);

    const after = await currentPayload(first.page.id);
    expect(after.managedBy).toBeNull();
    expect(after.introHtml).toBeNull();
    expect((await reloadPage(first.page.id)).publishedConfig).toMatchObject({ showManagedBy: false });
  });
});
