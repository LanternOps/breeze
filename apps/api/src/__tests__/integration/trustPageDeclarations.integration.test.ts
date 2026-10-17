import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { trustPageDeclarations, trustPages, trustPageSnapshots } from '../../db/schema';
import type { TrustPageRow } from '../../db/schema/trustPages';
import { ensureTrustPage, publishTrustPage, refreshPublishedPage } from '../../services/trustPage/publication';
import { and } from 'drizzle-orm';
import type { TrustPagePublicPayload } from '@breeze/shared';
import { declareTrustControl, listTrustDeclarations, withdrawTrustDeclaration } from '../../services/trustPage/declarations';
import { runDeclarationReminders } from '../../services/trustPage/declarationReminders';
import { PERMISSIONS } from '../../services/permissions';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const DAY_MS = 86_400_000;

interface Seeded { orgId: string; userId: string; partnerId: string; partnerSlug: string; orgSlug: string }

/** Superuser seed (no RLS): one partner, one org, one user. */
async function seed(): Promise<Seeded> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `nw-decl-${suffix}`;
  const orgSlug = `acme-decl-${suffix}`;
  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Northwind IT', ${partnerSlug}, 'active', 'trusted', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`trust-decl-${suffix}@example.com`}, 'Trust Declarer', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partner!.id}, 'Acme Dental', ${orgSlug}, 'active', 'USD', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { orgId: org!.id, userId: user!.id, partnerId: partner!.id, partnerSlug, orgSlug };
}

async function seedDocument(orgId: string, sha: string): Promise<string> {
  const [doc] = (await getTestDb().execute(sql`
    INSERT INTO org_documents (org_id, title, category, storage_backend, data, content_type, byte_size, sha256, original_filename)
    VALUES (${orgId}, 'IR plan', 'policy', 'db', '\\x01'::bytea, 'application/pdf', 1, ${sha}, 'ir.pdf') RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return doc!.id;
}

/** Superuser: a partner role granting organizations:write, held by the seeded user for all orgs. */
async function grantOrgWrite(s: Seeded): Promise<void> {
  const { resource, action } = PERMISSIONS.ORGS_WRITE;
  const testDb = getTestDb();
  const [role] = (await testDb.execute(sql`
    INSERT INTO roles (partner_id, scope, name) VALUES (${s.partnerId}, 'partner', 'Trust declarer') RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const existing = (await testDb.execute(sql`
    SELECT id FROM permissions WHERE resource = ${resource} AND action = ${action} LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  const permId = existing[0]?.id ?? ((await testDb.execute(sql`
    INSERT INTO permissions (resource, action) VALUES (${resource}, ${action}) RETURNING id
  `)) as unknown as Array<{ id: string }>)[0]!.id;
  await testDb.execute(sql`INSERT INTO role_permissions (role_id, permission_id) VALUES (${role!.id}, ${permId})`);
  await testDb.execute(sql`
    INSERT INTO partner_users (partner_id, user_id, role_id, org_access) VALUES (${s.partnerId}, ${s.userId}, ${role!.id}, 'all')
  `);
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

  it('publish freezes the declaration; the refresh flips it to expired, then a withdrawal drops it (Review Focus 4)', async () => {
    const page = await freshPage(s);
    // Superuser insert: declared 365 days minus 3 s ago, so it is current at publish and expires seconds later.
    const [inserted] = (await getTestDb().execute(sql`
      INSERT INTO trust_page_declarations (trust_page_id, org_id, control_id, statement, declared_by_partner_name, declared_by_user_id, declared_at, expires_at)
      SELECT ${page.id}, ${s.orgId}, 'cyber_insurance', 'We hold an active cyber insurance policy.', 'Northwind IT', ${s.userId},
             d, d + interval '8760 hours' FROM (SELECT now() - interval '8760 hours' + interval '3 seconds' AS d) t
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await sys(() => publishTrustPage({
      orgId: s.orgId, expectedRevision: page.publicationRevision, actorUserId: s.userId, authorization: { authorizedBy: 'Jane Doe, COO' },
      partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
    }));
    const current = async () => {
      const [snap] = await sys(() => db.select().from(trustPageSnapshots)
        .where(and(eq(trustPageSnapshots.trustPageId, page.id), eq(trustPageSnapshots.isCurrent, true))));
      return snap!.payload as TrustPagePublicPayload;
    };
    const published = (await freshPage(s)).publishedConfig as { declarationIds: string[] };
    expect(published.declarationIds).toEqual([inserted!.id]);
    const first = await current();
    expect(first.declaredControls).toEqual([expect.objectContaining({ id: 'cyber_insurance', status: 'current', declaredBy: 'Northwind IT' })]);
    expect(first.summary.controlsMet).toBe(first.controls.filter((c) => c.status === 'met').length);

    await new Promise((r) => setTimeout(r, 3500));
    expect((await refreshPublishedPage(page.id)).rebuilt).toBe(true);
    expect((await current()).declaredControls).toEqual([expect.objectContaining({ id: 'cyber_insurance', status: 'expired' })]);

    const live = await freshPage(s);
    await sys(() => withdrawTrustDeclaration({ page: live, declarationId: inserted!.id, actorUserId: s.userId, expectedRevision: live.publicationRevision }));
    expect((await refreshPublishedPage(page.id)).rebuilt).toBe(true);
    expect((await current()).declaredControls).toEqual([]);
  }, 20_000);

  it('reminders: 29 days out is reminded once; 31 days out, expired and withdrawn rows are not', async () => {
    const page = await freshPage(s);
    /** Superuser insert of a row expiring `days` from now (fractional allowed); returns its id. */
    const insertExpiringIn = async (controlId: string, days: number, withdrawn = false) => {
      const [r] = (await getTestDb().execute(sql`
        INSERT INTO trust_page_declarations (trust_page_id, org_id, control_id, statement, declared_by_partner_name, declared_at, expires_at, withdrawn_at)
        SELECT ${page.id}, ${s.orgId}, ${controlId}, 'A statement long enough.', 'Northwind IT', d, d + interval '8760 hours', ${withdrawn ? sql`now()` : sql`NULL`}
        FROM (SELECT now() + make_interval(secs => ${days}::float8 * 86400) - interval '8760 hours' AS d) t
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      return r!.id;
    };
    await grantOrgWrite(s);
    const due = await insertExpiringIn('incident_response_plan', 29);
    // The 30-day edge: just inside is reminded, just outside is not.
    const edgeIn = await insertExpiringIn('penetration_test', 30 - 60 / 86400);
    const edgeOut = await insertExpiringIn('vendor_risk_management', 30 + 120 / 86400);
    const notYet = await insertExpiringIn('cyber_insurance', 31);
    const expired = await insertExpiringIn('access_review', -1);
    const withdrawn = await insertExpiringIn('data_inventory', 10, true);

    const first = await runDeclarationReminders(new Date());
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    const sentAt = async (id: string) => (await sys(() => db.select({ r: trustPageDeclarations.reminderSentAt }).from(trustPageDeclarations).where(eq(trustPageDeclarations.id, id))))[0]!.r;
    for (const id of [due, edgeIn]) expect(await sentAt(id)).toBeInstanceOf(Date);
    for (const id of [notYet, edgeOut, expired, withdrawn]) expect(await sentAt(id)).toBeNull();
    // The recipient got the in-app notification, deduped per declaration.
    const notes = (await getTestDb().execute(sql`
      SELECT dedupe_key FROM user_notifications WHERE user_id = ${s.userId} AND dedupe_key = ${`trust-declaration-reminder:${due}`}
    `)) as unknown as unknown[];
    expect(notes).toHaveLength(1);

    // At-most-once: the claim stands, so a second sweep finds nothing to remind.
    const stamp = await sentAt(due);
    expect((await runDeclarationReminders(new Date())).reminded).toBe(0);
    expect(await sentAt(due)).toEqual(stamp);
  });

  it('reminders: an org with no organizations:write user is left unclaimed', async () => {
    const page = await freshPage(s);
    const [r] = (await getTestDb().execute(sql`
      INSERT INTO trust_page_declarations (trust_page_id, org_id, control_id, statement, declared_by_partner_name, declared_at, expires_at)
      SELECT ${page.id}, ${s.orgId}, 'backup_recovery_plan', 'A statement long enough.', 'Northwind IT', d, d + interval '8760 hours'
      FROM (SELECT now() + interval '10 days' - interval '8760 hours' AS d) t RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await runDeclarationReminders(new Date());
    const [row] = await sys(() => db.select({ r: trustPageDeclarations.reminderSentAt }).from(trustPageDeclarations).where(eq(trustPageDeclarations.id, r!.id)));
    expect(row!.r).toBeNull();
  });

  it("withdrawing a declaration through another org's page is a 404 and leaves it untouched", async () => {
    const other = await seed();
    const otherPage = await freshPage(other);
    const theirs = await sys(() => declareTrustControl({
      page: otherPage, controlId: 'cyber_insurance', statement: 'We hold an active cyber policy.', evidenceDocumentId: null,
      actorUserId: other.userId, partnerName: 'Other MSP', expectedRevision: otherPage.publicationRevision,
    }));
    const mine = await freshPage(s);
    await expect(sys(() => withdrawTrustDeclaration({ page: mine, declarationId: theirs.declaration.id, actorUserId: s.userId, expectedRevision: mine.publicationRevision })))
      .rejects.toMatchObject({ status: 404 });
    const [row] = await sys(() => db.select().from(trustPageDeclarations).where(eq(trustPageDeclarations.id, theirs.declaration.id)));
    expect(row!.withdrawnAt).toBeNull();
  });
});
