/**
 * Trust Center schema bounds against real Postgres.
 *
 * W1 (final fix wave, I1 + Ruling 20): the trust_pages intro CHECK must admit every intro the API can store
 * (TRUST_INTRO_STORED_MAX_CHARS = TRUST_INTRO_MAX_CHARS * 8 = 40,000), and published_config round-trips as
 * jsonb. A 20,000 CHECK used to turn a valid sanitized intro into a 23514 → 500.
 *
 * W2 (#8770 W02a, migration 2026-12-30-100300-trust-center-w2.sql): the five new shape-1 tables refuse a
 * cross-tenant insert as breeze_app (42501), the declaration immutability trigger allows exactly the documented
 * transitions, the evidence/user FKs SET NULL without losing the row, and the CHECKs hold.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { TRUST_INTRO_STORED_MAX_CHARS, trustPublishedConfigSchema } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  trustPages, trustPageDeclarations, trustPageAccessRequests, trustPageAccessTokens, trustPageFaqItems,
  trustPageSubprocessors, trustPageDocuments,
} from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { replayMigration } from './replayMigration';

const RUN = !!process.env.DATABASE_URL;
const HOURS_365_DAYS = 8760;

async function newPage() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [page] = await withSystemDbAccessContext(() => db.insert(trustPages).values({ orgId: org!.id, partnerId: partner.id }).returning());
  return { page: page!, partnerId: partner.id, orgId: org!.id };
}

const pgCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code ?? e?.cause?.code;
};

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function newDocument(orgId: string): Promise<string> {
  const rows = (await sys(() => db.execute(sql`
    INSERT INTO org_documents (org_id, title, storage_backend, data, content_type, byte_size, sha256, original_filename)
    VALUES (${orgId}::uuid, 'Policy', 'db', '\\x01'::bytea, 'application/pdf', 1, ${'b'.repeat(64)}, 'policy.pdf')
    RETURNING id`))) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

function declarationValues(page: { id: string; orgId: string }, extra: Partial<typeof trustPageDeclarations.$inferInsert> = {}) {
  const declaredAt = new Date('2026-10-01T00:00:00.000Z');
  return {
    trustPageId: page.id, orgId: page.orgId, controlId: 'incident_response_plan', statement: 'We keep a written IR plan.',
    declaredByPartnerName: 'Northwind IT', declaredAt, expiresAt: new Date(declaredAt.getTime() + HOURS_365_DAYS * 3_600_000),
    ...extra,
  };
}

describe.skipIf(!RUN)('trust_pages schema bounds', () => {
  it('stores a 25,000-char sanitized intro (above the old 20,000 CHECK)', async () => {
    const { page } = await newPage();
    const intro = `<p>${'a'.repeat(25_000 - 7)}</p>`;
    expect(intro.length).toBe(25_000);
    await sys(() => db.update(trustPages).set({ introHtml: intro }).where(eq(trustPages.id, page.id)));
    const [row] = await sys(() => db.select({ introHtml: trustPages.introHtml }).from(trustPages).where(eq(trustPages.id, page.id)));
    expect(row?.introHtml?.length).toBe(25_000);
  });

  it('stores exactly TRUST_INTRO_STORED_MAX_CHARS and rejects one more (23514)', async () => {
    const { page } = await newPage();
    await sys(() => db.update(trustPages).set({ introHtml: 'x'.repeat(TRUST_INTRO_STORED_MAX_CHARS) }).where(eq(trustPages.id, page.id)));
    const err = await sys(() => db.update(trustPages).set({ introHtml: 'x'.repeat(TRUST_INTRO_STORED_MAX_CHARS + 1) }).where(eq(trustPages.id, page.id))).catch((e) => e);
    expect(pgCode(err)).toBe('23514');
  });

  it('published_config is nullable jsonb and round-trips', async () => {
    const { page } = await newPage();
    expect(page.publishedConfig).toBeNull();
    const cfg = trustPublishedConfigSchema.parse({
      hiddenControlIds: ['dns_filtering'], showPercentages: true, showDeviceCount: false, showManagedBy: true,
      searchIndexable: false, introHtml: '<p>Hi</p>', websiteUrl: null, securityContactEmail: null, documentIds: [],
    });
    await sys(() => db.update(trustPages).set({ publishedConfig: cfg }).where(eq(trustPages.id, page.id)));
    const [row] = await sys(() => db.select({ c: trustPages.publishedConfig }).from(trustPages).where(eq(trustPages.id, page.id)));
    expect(row?.c).toEqual(cfg);
  });

  it('W2: a new page has NULL (inherit) settings, the ticket flag off, and bounds nda_text', async () => {
    const { page } = await newPage();
    expect(page).toMatchObject({
      searchIndexable: null, showPercentages: null, showDeviceCount: null, showManagedBy: null, hiddenControlIds: null,
      frameworkView: null, showHistory: null, ndaText: null, accessRequestCreatesTicket: false,
    });
    const err = await sys(() => db.update(trustPages).set({ ndaText: 'x'.repeat(10_001) }).where(eq(trustPages.id, page.id))).catch((e) => e);
    expect(pgCode(err)).toBe('23514');
  });
});

describe.skipIf(!RUN)('trust center W2 tables', () => {
  it('as breeze_app in org A, inserting a row stamped with org B is refused (42501) on every new table', async () => {
    const a = await newPage();
    const b = await newPage();
    const [bRequest] = await sys(() => db.insert(trustPageAccessRequests).values({
      trustPageId: b.page.id, orgId: b.orgId, requesterEmail: 'buyer@example.com', requesterName: 'Buyer', requesterCompany: 'Buyer Co', purpose: 'Review',
    }).returning());
    const ctxA: DbAccessContext = {
      scope: 'organization', orgId: a.orgId, accessibleOrgIds: [a.orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: a.partnerId,
    };
    const forges: Array<[string, () => Promise<unknown>]> = [
      ['declarations', () => db.insert(trustPageDeclarations).values(declarationValues({ id: b.page.id, orgId: b.orgId }))],
      ['access_requests', () => db.insert(trustPageAccessRequests).values({ trustPageId: b.page.id, orgId: b.orgId, requesterEmail: 'x@example.com', requesterName: 'X', requesterCompany: 'X', purpose: 'X' })],
      ['access_tokens', () => db.insert(trustPageAccessTokens).values({ requestId: bRequest!.id, orgId: b.orgId, purpose: 'verify_email', tokenHash: 'e'.repeat(64), expiresAt: new Date(Date.now() + 86_400_000) })],
      ['faq_items', () => db.insert(trustPageFaqItems).values({ trustPageId: b.page.id, orgId: b.orgId, question: 'Q?', answerHtml: '<p>A</p>', sortOrder: 0 })],
      ['subprocessors', () => db.insert(trustPageSubprocessors).values({ trustPageId: b.page.id, orgId: b.orgId, name: 'V', purpose: 'P', sortOrder: 0 })],
    ];
    for (const [name, forge] of forges) {
      const err = await withDbAccessContext(ctxA, forge).catch((e) => e);
      expect(pgCode(err), name).toBe('42501');
    }
  });

  it('declaration attribution is immutable; withdrawn_at is one-way; the active-control index is unique', async () => {
    const { page } = await newPage();
    const [d] = await sys(() => db.insert(trustPageDeclarations).values(declarationValues(page)).returning());
    const stmtErr = await sys(() => db.update(trustPageDeclarations).set({ statement: 'Changed' }).where(eq(trustPageDeclarations.id, d!.id))).catch((e) => e);
    expect(pgCode(stmtErr)).toBe('23000'); // integrity_constraint_violation
    const nameErr = await sys(() => db.update(trustPageDeclarations).set({ declaredByPartnerName: 'Other' }).where(eq(trustPageDeclarations.id, d!.id))).catch((e) => e);
    expect(pgCode(nameErr)).toBe('23000');

    // A second active declaration for the same control → 23505.
    const dupErr = await sys(() => db.insert(trustPageDeclarations).values(declarationValues(page))).catch((e) => e);
    expect(pgCode(dupErr)).toBe('23505');

    await sys(() => db.update(trustPageDeclarations).set({ withdrawnAt: new Date() }).where(eq(trustPageDeclarations.id, d!.id)));
    const backErr = await sys(() => db.update(trustPageDeclarations).set({ withdrawnAt: null }).where(eq(trustPageDeclarations.id, d!.id))).catch((e) => e);
    expect(pgCode(backErr)).toBe('23000');
    // Once withdrawn, the control may be declared again.
    await sys(() => db.insert(trustPageDeclarations).values(declarationValues(page)));
  });

  it('withdrawn_by_user_id may only be set together with withdrawn_at', async () => {
    const { page, partnerId } = await newPage();
    const user = await createUser({ partnerId });
    const [d] = await sys(() => db.insert(trustPageDeclarations).values(declarationValues(page)).returning());
    const alone = await sys(() => db.update(trustPageDeclarations).set({ withdrawnByUserId: user.id }).where(eq(trustPageDeclarations.id, d!.id))).catch((e) => e);
    expect(pgCode(alone)).toBe('23000');
    await sys(() => db.update(trustPageDeclarations).set({ withdrawnAt: new Date(), withdrawnByUserId: user.id }).where(eq(trustPageDeclarations.id, d!.id)));
  });

  it('deleting the evidence document or the declaring user SET NULLs the reference; the row and its digest survive', async () => {
    const { page, partnerId } = await newPage();
    const user = await createUser({ partnerId });
    const documentId = await newDocument(page.orgId);
    const [d] = await sys(() => db.insert(trustPageDeclarations).values(declarationValues(page, {
      evidenceDocumentId: documentId, evidenceDocumentSha256: 'f'.repeat(64), declaredByUserId: user.id,
    })).returning());
    await sys(() => db.execute(sql`DELETE FROM org_documents WHERE id = ${documentId}::uuid`));
    await sys(() => db.execute(sql`DELETE FROM users WHERE id = ${user.id}::uuid`));
    const [row] = await sys(() => db.select().from(trustPageDeclarations).where(eq(trustPageDeclarations.id, d!.id)));
    expect(row).toMatchObject({ evidenceDocumentId: null, evidenceDocumentSha256: 'f'.repeat(64), declaredByUserId: null });
  });

  it('expires_at must be exactly declared_at + 365 days (23514)', async () => {
    const { page } = await newPage();
    const declaredAt = new Date('2026-10-01T00:00:00.000Z');
    const err = await sys(() => db.insert(trustPageDeclarations).values(declarationValues(page, {
      declaredAt, expiresAt: new Date(declaredAt.getTime() + 364 * 86_400_000),
    }))).catch((e) => e);
    expect(pgCode(err)).toBe('23514');
  });

  it('an approved request without a grant is refused (23514); with one it is stored', async () => {
    const { page } = await newPage();
    const base = { trustPageId: page.id, orgId: page.orgId, requesterEmail: 'buyer@example.com', requesterName: 'Buyer', requesterCompany: 'Buyer Co', purpose: 'Review' };
    const err = await sys(() => db.insert(trustPageAccessRequests).values({ ...base, status: 'approved' })).catch((e) => e);
    expect(pgCode(err)).toBe('23514');
    const now = new Date();
    await sys(() => db.insert(trustPageAccessRequests).values({
      ...base, status: 'approved', emailVerifiedAt: now, decidedAt: now, grantExpiresAt: new Date(now.getTime() + 7 * 86_400_000), grantedDocumentIds: [],
    }));
    const upper = await sys(() => db.insert(trustPageAccessRequests).values({ ...base, requesterEmail: 'Buyer@Example.com' })).catch((e) => e);
    expect(pgCode(upper)).toBe('23514');
  });

  it('a linked document without a disclosure confirmation is refused for both visibilities (23514)', async () => {
    const { page } = await newPage();
    for (const visibility of ['public', 'gated'] as const) {
      const documentId = await newDocument(page.orgId);
      const err = await sys(() => db.insert(trustPageDocuments).values({ trustPageId: page.id, documentId, orgId: page.orgId, visibility })).catch((e) => e);
      expect(pgCode(err), visibility).toBe('23514');
    }
  });

  it("migration: a pre-W2 page with no intro (NULL) keeps meaning 'no intro' ('' after the migration), an explicit intro is untouched", async () => {
    const empty = await newPage();
    const withIntro = await newPage();
    await sys(() => db.update(trustPages).set({ introHtml: '<p>Kept</p>' }).where(eq(trustPages.id, withIntro.page.id)));
    expect(empty.page.introHtml).toBeNull();
    await replayMigration('2026-12-30-100300-trust-center-w2.sql');
    const rows = await sys(() => db.select({ id: trustPages.id, introHtml: trustPages.introHtml }).from(trustPages)
      .where(sql`${trustPages.id} IN (${empty.page.id}, ${withIntro.page.id})`));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.introHtml]))).toEqual({ [empty.page.id]: '', [withIntro.page.id]: '<p>Kept</p>' });
  });
});
