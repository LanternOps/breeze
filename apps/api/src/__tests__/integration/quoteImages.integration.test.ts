/**
 * Quote image bytea storage — real-driver round-trip under RLS.
 *
 * Service under test: services/quoteImageStorage.ts. The image bytes live in
 * `quote_images.image_data` (bytea), org-axis RLS shipped in Phase 1. These
 * cases run through the REAL `breeze_app` driver inside withDbAccessContext, so
 * they prove postgres.js round-trips the bytea byte-exactly AND that the
 * insert/select pass the table's org-axis policies (the contract test alone
 * misses write-path gaps — the custom_field_definitions #1257 class).
 *
 * No memoization: integration/setup.ts TRUNCATE ... CASCADEs the tenant tables
 * on beforeEach, so each test re-seeds.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { db } from '../../db';
import { quotes } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { writeQuoteImage, readQuoteImage } from '../../services/quoteImageStorage';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);

describe('quote image storage', () => {
  runDb('writes and reads back a PNG scoped to its quote', async () => {
    const { ctx, quoteId } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
      const [q] = await db.insert(quotes).values({ partnerId: partner.id, orgId: org.id, currencyCode: 'USD' }).returning({ id: quotes.id, orgId: quotes.orgId });
      const ctx: DbAccessContext = { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id], userId: null };
      return { ctx, quoteId: q!.id, orgId: org.id };
    });
    const written = await withDbAccessContext(ctx, () => writeQuoteImage(quoteId, ctx.orgId!, 'image/png', PNG));
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    const read = await withDbAccessContext(ctx, () => readQuoteImage(written.id, quoteId));
    expect(read?.mime).toBe('image/png');
    expect(read?.data.equals(PNG)).toBe(true);
  });

  // TA-6: readQuoteImage is scoped to BOTH imageId AND quoteId. Within ONE org,
  // RLS does NOT separate two quotes — the quote_id predicate is the ONLY barrier
  // stopping a valid token holder for quote B from serving quote A's image bytes
  // on the system-scope public image route. This is the test RLS can't be.
  runDb('does not serve an image under a different quote in the same org (cross-quote IDOR guard)', async () => {
    const { ctx, quoteA, quoteB } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner(); const org = await createOrganization({ partnerId: partner.id });
      const [qA] = await db.insert(quotes).values({ partnerId: partner.id, orgId: org.id, currencyCode: 'USD' }).returning({ id: quotes.id });
      const [qB] = await db.insert(quotes).values({ partnerId: partner.id, orgId: org.id, currencyCode: 'USD' }).returning({ id: quotes.id });
      const ctx: DbAccessContext = { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id], userId: null };
      return { ctx, quoteA: qA!.id, quoteB: qB!.id };
    });
    const imgA = await withDbAccessContext(ctx, () => writeQuoteImage(quoteA, ctx.orgId!, 'image/png', PNG));
    // Same org, image belongs to quote A — requesting it under quote B must miss.
    const crossed = await withDbAccessContext(ctx, () => readQuoteImage(imgA.id, quoteB));
    expect(crossed).toBeNull();
    // Sanity: the correct quote still returns the bytes (the predicate isn't deny-all).
    const ok = await withDbAccessContext(ctx, () => readQuoteImage(imgA.id, quoteA));
    expect(ok?.data.equals(PNG)).toBe(true);
  });
});
