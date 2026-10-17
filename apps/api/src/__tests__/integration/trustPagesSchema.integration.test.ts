/**
 * Trust Center W1 schema bounds against real Postgres (final fix wave, I1 +
 * Ruling 20): the trust_pages intro CHECK must admit every intro the API can
 * store (TRUST_INTRO_STORED_MAX_CHARS = TRUST_INTRO_MAX_CHARS * 8 = 40,000),
 * and published_config round-trips as jsonb. A 20,000 CHECK used to turn a
 * valid sanitized intro into a 23514 → 500.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TRUST_INTRO_STORED_MAX_CHARS, type TrustPublishedConfig } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { trustPages } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const RUN = !!process.env.DATABASE_URL;

async function newPage() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [page] = await withSystemDbAccessContext(() => db.insert(trustPages).values({ orgId: org!.id, partnerId: partner.id }).returning());
  return page!;
}

describe.skipIf(!RUN)('trust_pages schema bounds', () => {
  it('stores a 25,000-char sanitized intro (above the old 20,000 CHECK)', async () => {
    const page = await newPage();
    const intro = `<p>${'a'.repeat(25_000 - 7)}</p>`;
    expect(intro.length).toBe(25_000);
    await withSystemDbAccessContext(() => db.update(trustPages).set({ introHtml: intro }).where(eq(trustPages.id, page.id)));
    const [row] = await withSystemDbAccessContext(() => db.select({ introHtml: trustPages.introHtml }).from(trustPages).where(eq(trustPages.id, page.id)));
    expect(row?.introHtml?.length).toBe(25_000);
  });

  it('stores exactly TRUST_INTRO_STORED_MAX_CHARS and rejects one more (23514)', async () => {
    const page = await newPage();
    await withSystemDbAccessContext(() => db.update(trustPages).set({ introHtml: 'x'.repeat(TRUST_INTRO_STORED_MAX_CHARS) }).where(eq(trustPages.id, page.id)));
    const err = await withSystemDbAccessContext(() => db.update(trustPages).set({ introHtml: 'x'.repeat(TRUST_INTRO_STORED_MAX_CHARS + 1) }).where(eq(trustPages.id, page.id))).catch((e) => e);
    const code = err?.code ?? err?.cause?.code;
    expect(code).toBe('23514');
  });

  it('published_config is nullable jsonb and round-trips', async () => {
    const page = await newPage();
    expect(page.publishedConfig).toBeNull();
    const cfg: TrustPublishedConfig = {
      hiddenControlIds: ['dns_filtering'], showPercentages: true, showDeviceCount: false, showManagedBy: true,
      searchIndexable: false, introHtml: '<p>Hi</p>', websiteUrl: null, securityContactEmail: null, documentIds: [],
    };
    await withSystemDbAccessContext(() => db.update(trustPages).set({ publishedConfig: cfg }).where(eq(trustPages.id, page.id)));
    const [row] = await withSystemDbAccessContext(() => db.select({ c: trustPages.publishedConfig }).from(trustPages).where(eq(trustPages.id, page.id)));
    expect(row?.c).toEqual(cfg);
  });
});
