import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { trustPageDeclarations, trustPages } from '../../db/schema';
import type { TrustPageRow } from '../../db/schema/trustPages';
import { ensureTrustPage } from '../../services/trustPage/publication';
import { declareTrustControl, listTrustDeclarations, withdrawTrustDeclaration } from '../../services/trustPage/declarations';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const DAY_MS = 86_400_000;

interface Seeded { orgId: string; userId: string }

/** Superuser seed (no RLS): one partner, one org, one user. */
async function seed(): Promise<Seeded> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Northwind IT', ${`nw-decl-${suffix}`}, 'active', 'trusted', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`trust-decl-${suffix}@example.com`}, 'Trust Declarer', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partner!.id}, 'Acme Dental', ${`acme-decl-${suffix}`}, 'active', 'USD', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { orgId: org!.id, userId: user!.id };
}

async function seedDocument(orgId: string, sha: string): Promise<string> {
  const [doc] = (await getTestDb().execute(sql`
    INSERT INTO org_documents (org_id, title, category, storage_backend, data, content_type, byte_size, sha256, original_filename)
    VALUES (${orgId}, 'IR plan', 'policy', 'db', '\\x01'::bytea, 'application/pdf', 1, ${sha}, 'ir.pdf') RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return doc!.id;
}

const freshPage = async (s: Seeded): Promise<TrustPageRow> => {
  await sys(() => ensureTrustPage(s.orgId, s.userId));
  // Re-read so publicationRevision is current.
  return sys(async () => (await db.select().from(trustPages).where(eq(trustPages.orgId, s.orgId)).limit(1))[0]!);
};

describe('trust page declarations (real DB)', () => {
  let s: Seeded;
  beforeEach(async () => { s = await seed(); });

  it('declare → re-declare → re-declare leaves exactly one active row and stamps both superseded_at', async () => {
    let page = await freshPage(s);
    const base = { controlId: 'incident_response_plan' as const, evidenceDocumentId: null, actorUserId: s.userId, partnerName: 'Northwind IT' };
    const first = await sys(() => declareTrustControl({ ...base, page, statement: 'First version of our IR plan.', expectedRevision: page.publicationRevision }));
    expect(first.superseded).toBeNull();
    page = await freshPage(s);
    const second = await sys(() => declareTrustControl({ ...base, page, statement: 'Second version of our IR plan.', expectedRevision: page.publicationRevision }));
    expect(second.superseded).toBe(first.declaration.id);
    page = await freshPage(s);
    const third = await sys(() => declareTrustControl({ ...base, page, statement: 'Third version of our IR plan.', expectedRevision: page.publicationRevision }));
    expect(third.superseded).toBe(second.declaration.id);
    expect(third.publicationRevision).toBe(page.publicationRevision + 1);

    const rows = await sys(() => db.select().from(trustPageDeclarations).where(eq(trustPageDeclarations.trustPageId, page.id)));
    expect(rows).toHaveLength(3);
    const active = rows.filter((r) => r.supersededAt === null && r.withdrawnAt === null);
    expect(active.map((r) => r.id)).toEqual([third.declaration.id]);
    for (const id of [first.declaration.id, second.declaration.id]) {
      expect(rows.find((r) => r.id === id)!.supersededAt).toBeInstanceOf(Date);
    }
    // The DB CHECK (8760 hours) and the API agree: exactly 365 days.
    for (const r of rows) expect(r.expiresAt.getTime() - r.declaredAt.getTime()).toBe(365 * DAY_MS);

    const listed = await sys(() => listTrustDeclarations(page));
    expect(listed.active.map((r) => r.id)).toEqual([third.declaration.id]);
    expect(listed.history.map((r) => r.id)).toEqual([second.declaration.id, first.declaration.id]);
  });

  it('a stale revision is refused and writes nothing', async () => {
    const page = await freshPage(s);
    await expect(sys(() => declareTrustControl({
      page, controlId: 'cyber_insurance', statement: 'We hold an active cyber policy.', evidenceDocumentId: null,
      actorUserId: s.userId, partnerName: 'Northwind IT', expectedRevision: page.publicationRevision + 5,
    }))).rejects.toMatchObject({ status: 409 });
    const rows = await sys(() => db.select().from(trustPageDeclarations).where(eq(trustPageDeclarations.trustPageId, page.id)));
    expect(rows).toHaveLength(0);
  });

  it('copies the evidence sha256 and refuses a superseded evidence document', async () => {
    let page = await freshPage(s);
    const sha = 'b'.repeat(64);
    const docId = await seedDocument(s.orgId, sha);
    const out = await sys(() => declareTrustControl({
      page, controlId: 'penetration_test', statement: 'Annual external penetration test.', evidenceDocumentId: docId,
      actorUserId: s.userId, partnerName: 'Northwind IT', expectedRevision: page.publicationRevision,
    }));
    expect(out.declaration.evidenceDocumentSha256).toBe(sha);

    // Supersede the document with a newer version: it is no longer a valid evidence choice.
    await getTestDb().execute(sql`
      INSERT INTO org_documents (org_id, title, category, storage_backend, data, content_type, byte_size, sha256, original_filename, supersedes_document_id)
      VALUES (${s.orgId}, 'IR plan v2', 'policy', 'db', '\\x01'::bytea, 'application/pdf', 1, ${'c'.repeat(64)}, 'ir2.pdf', ${docId})
    `);
    page = await freshPage(s);
    await expect(sys(() => declareTrustControl({
      page, controlId: 'penetration_test', statement: 'Annual external penetration test.', evidenceDocumentId: docId,
      actorUserId: s.userId, partnerName: 'Northwind IT', expectedRevision: page.publicationRevision,
    }))).rejects.toMatchObject({ status: 422, code: 'EVIDENCE_UNAVAILABLE' });
  });

  it('withdraw stamps the active row and its superseded predecessors; a second withdraw is 404', async () => {
    let page = await freshPage(s);
    const base = { controlId: 'access_review' as const, evidenceDocumentId: null, actorUserId: s.userId, partnerName: 'Northwind IT' };
    const first = await sys(() => declareTrustControl({ ...base, page, statement: 'Quarterly access reviews.', expectedRevision: page.publicationRevision }));
    page = await freshPage(s);
    const second = await sys(() => declareTrustControl({ ...base, page, statement: 'Monthly access reviews now.', expectedRevision: page.publicationRevision }));
    page = await freshPage(s);
    const out = await sys(() => withdrawTrustDeclaration({ page, declarationId: second.declaration.id, actorUserId: s.userId, expectedRevision: page.publicationRevision }));
    expect(out.publicationRevision).toBe(page.publicationRevision + 1);

    const rows = await sys(() => db.select().from(trustPageDeclarations).where(eq(trustPageDeclarations.trustPageId, page.id)));
    for (const id of [first.declaration.id, second.declaration.id]) {
      const r = rows.find((x) => x.id === id)!;
      expect(r.withdrawnAt).toBeInstanceOf(Date);
      expect(r.withdrawnByUserId).toBe(s.userId);
    }
    page = await freshPage(s);
    await expect(sys(() => withdrawTrustDeclaration({ page, declarationId: second.declaration.id, actorUserId: s.userId, expectedRevision: page.publicationRevision })))
      .rejects.toMatchObject({ status: 404 });
    // The 404 rolled its revision bump back.
    expect((await freshPage(s)).publicationRevision).toBe(page.publicationRevision);
  });
});
