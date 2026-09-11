/**
 * Functional forge proof for `org_documents` (service deliverables W03, spec
 * #5573 §4.4) and the evidence → document ownership FK W03 closes on
 * `service_deliverable_evidence`.
 *
 * Shape 1 (direct org_id, breeze_has_org_access). These tests run through the
 * real driver as the unprivileged app role under the integration config; do
 * not run them with the plain unit-test config.
 *
 * Beyond the forge, this file proves the structural contracts the version
 * chain depends on: one successor per document (unique index), same-org
 * supersede only (composite self-FK), evidence may only point at a document of
 * its own org (composite FK), and the org-merge re-point shape (SET
 * CONSTRAINTS ALL DEFERRED, rows moved in separate statements).
 *
 * Fixtures are re-seeded per test: the integration setup truncates tenant data
 * between tests, so a memoized fixture would be stale and vacuous.
 */
import './setup';
import { getTestDb } from './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { createOrganization, createPartner } from './db-utils';
import {
  deleteDocument, getDocument, listDocuments, replaceDocument, streamDocument, supersedeDocument, updateDocument,
} from '../../services/orgDocumentService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

type Row = Record<string, unknown>;
const rows = (r: unknown) => r as unknown as Row[];

async function seedTwoOrgs() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    return { partner, orgA, orgB, ctxA: orgContext(orgA.id), ctxB: orgContext(orgB.id) };
  });
}

async function sqlstate(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

/** A db-backed document row (the integration env has no bucket). */
function insertDocSql(orgId: string, opts: { id?: string; supersedes?: string | null; title?: string } = {}) {
  const id = opts.id ?? crypto.randomUUID();
  return {
    id,
    stmt: sql`
      INSERT INTO org_documents (id, org_id, title, category, storage_backend, data,
                                 content_type, byte_size, sha256, original_filename, supersedes_document_id)
      VALUES (${id}::uuid, ${orgId}::uuid, ${opts.title ?? 'Firewall baseline'}, 'baseline', 'db', '\\x255044462d'::bytea,
              'application/pdf', 5, ${'a'.repeat(64)}, 'baseline.pdf', ${opts.supersedes ?? null}::uuid)
      RETURNING id`,
  };
}

async function insertDoc(ctx: DbAccessContext, orgId: string, opts: { supersedes?: string | null; title?: string } = {}) {
  const { id, stmt } = insertDocSql(orgId, opts);
  await withDbAccessContext(ctx, () => db.execute(stmt));
  return id;
}

async function insertOccurrence(ctx: DbAccessContext, orgId: string) {
  const d = rows(
    await withDbAccessContext(ctx, () =>
      db.execute(sql`
        INSERT INTO service_deliverables (org_id, name, cadence, anchor_due_date, effective_from)
        VALUES (${orgId}::uuid, 'Quarterly baseline review', 'quarterly', '2026-12-31', '2026-10-01')
        RETURNING id`),
    ),
  )[0]!.id as string;
  return rows(
    await withDbAccessContext(ctx, () =>
      db.execute(sql`
        INSERT INTO service_deliverable_occurrences
          (org_id, deliverable_id, name_snapshot, period_start, period_end, due_at, original_due_at)
        VALUES (${orgId}::uuid, ${d}::uuid, 'Quarterly baseline review', '2026-10-01', '2026-12-31', '2026-12-31', '2026-12-31')
        RETURNING id`),
    ),
  )[0]!.id as string;
}

describe('org_documents RLS — org-axis forge (breeze_app role)', () => {
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const { ctxA } = await seedTwoOrgs();
    const r = rows(
      await withDbAccessContext(ctxA, () =>
        db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`),
      ),
    )[0]!;
    expect(r.who).toBe('breeze_app');
    expect(r.rolbypassrls).toBe(false);
  });

  runDb('positive control: org A inserts and reads back exactly its own document', async () => {
    const { orgA, ctxA } = await seedTwoOrgs();
    const id = await insertDoc(ctxA, orgA.id);
    const seen = rows(await withDbAccessContext(ctxA, () => db.execute(sql`SELECT id FROM org_documents`)));
    expect(seen.map((r) => r.id)).toEqual([id]);
  });

  runDb('cross-org forge: org A context cannot insert a row carrying org B (42501)', async () => {
    const { orgB, ctxA } = await seedTwoOrgs();
    const { stmt } = insertDocSql(orgB.id);
    expect(await sqlstate(() => withDbAccessContext(ctxA, () => db.execute(stmt)))).toBe('42501');
  });

  runDb('cross-org read and write: org B documents are invisible and untouchable from org A', async () => {
    const { orgB, ctxA, ctxB } = await seedTwoOrgs();
    const idB = await insertDoc(ctxB, orgB.id);
    const count = rows(
      await withDbAccessContext(ctxA, () => db.execute(sql`SELECT count(*)::int AS n FROM org_documents`)),
    )[0]!.n;
    expect(count).toBe(0);
    const updated = rows(
      await withDbAccessContext(ctxA, () =>
        db.execute(sql`UPDATE org_documents SET title = 'pwned' WHERE id = ${idB}::uuid RETURNING id`)),
    );
    expect(updated).toHaveLength(0);
    const title = rows(
      await withDbAccessContext(ctxB, () => db.execute(sql`SELECT title FROM org_documents WHERE id = ${idB}::uuid`)),
    )[0]!.title;
    expect(title).toBe('Firewall baseline');
  });

  runDb('chain integrity: a document can have only one successor (23505)', async () => {
    const { orgA, ctxA } = await seedTwoOrgs();
    const d1 = await insertDoc(ctxA, orgA.id);
    await insertDoc(ctxA, orgA.id, { supersedes: d1, title: 'v2' });
    const { stmt } = insertDocSql(orgA.id, { supersedes: d1, title: 'branch' });
    expect(await sqlstate(() => withDbAccessContext(ctxA, () => db.execute(stmt)))).toBe('23505');
  });

  runDb('cross-org supersede: a document of org A cannot supersede one of org B (23503)', async () => {
    const { orgA, orgB, ctxB } = await seedTwoOrgs();
    const idB = await insertDoc(ctxB, orgB.id);
    // System context so RLS is not what refuses it — the composite FK must.
    const { stmt } = insertDocSql(orgA.id, { supersedes: idB });
    expect(await sqlstate(() => withSystemDbAccessContext(() => db.execute(stmt)))).toBe('23503');
  });

  runDb('evidence may not point at a document of another org (23503 sd_evidence_document_org_fk)', async () => {
    const { orgA, orgB, ctxA, ctxB } = await seedTwoOrgs();
    const occA = await insertOccurrence(ctxA, orgA.id);
    const docB = await insertDoc(ctxB, orgB.id);
    const docA = await insertDoc(ctxA, orgA.id);
    const forge = (docId: string) => sql`
      INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, document_id)
      VALUES (${orgA.id}::uuid, ${occA}::uuid, 'document', ${docId}::uuid)`;
    expect(await sqlstate(() => withSystemDbAccessContext(() => db.execute(forge(docB))))).toBe('23503');
    // Positive control: the same insert with org A's own document succeeds.
    expect(await sqlstate(() => withDbAccessContext(ctxA, () => db.execute(forge(docA))))).toBeUndefined();
  });

  runDb('org-merge re-point: a version chain moves orgs under SET CONSTRAINTS ALL DEFERRED (and fails without it)', async () => {
    const { orgA, orgB, ctxA, ctxB } = await seedTwoOrgs();
    const d1 = await insertDoc(ctxA, orgA.id);
    const d2 = await insertDoc(ctxA, orgA.id, { supersedes: d1, title: 'v2' });
    const adminDb = getTestDb() as never as typeof db;

    // Control: IMMEDIATE checking refuses moving the successor alone, proving
    // the composite self-FK is live and the deferral below is load-bearing.
    expect(await sqlstate(() => adminDb.transaction(async (tx) => {
      await tx.execute(sql`UPDATE org_documents SET org_id = ${orgB.id}::uuid WHERE id = ${d2}::uuid`);
    }))).toBe('23503');

    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`UPDATE org_documents SET org_id = ${orgB.id}::uuid WHERE id = ${d2}::uuid`);
      await tx.execute(sql`UPDATE org_documents SET org_id = ${orgB.id}::uuid WHERE id = ${d1}::uuid`);
    });
    const seenByB = rows(
      await withDbAccessContext(ctxB, () =>
        db.execute(sql`SELECT id, supersedes_document_id FROM org_documents ORDER BY created_at, id`)),
    );
    expect(seenByB.map((r) => r.id).sort()).toEqual([d1, d2].sort());
    expect(seenByB.find((r) => r.id === d2)?.supersedes_document_id).toBe(d1);
  });

  runDb('deleting a document row cascades its evidence rows and leaves the occurrence', async () => {
    const { orgA, ctxA } = await seedTwoOrgs();
    const occA = await insertOccurrence(ctxA, orgA.id);
    const docA = await insertDoc(ctxA, orgA.id);
    await withDbAccessContext(ctxA, () =>
      db.execute(sql`
        INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, document_id)
        VALUES (${orgA.id}::uuid, ${occA}::uuid, 'document', ${docA}::uuid)`));
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM org_documents WHERE id = ${docA}::uuid`));
    const counts = rows(
      await withDbAccessContext(ctxA, () =>
        db.execute(sql`
          SELECT (SELECT count(*) FROM service_deliverable_evidence)::int AS e,
                 (SELECT count(*) FROM service_deliverable_occurrences)::int AS o`)),
    )[0]!;
    expect(counts).toMatchObject({ e: 0, o: 1 });
  });

  runDb('lost race on the head check: the loser gets 409 NOT_HEAD from the 23505 and its request transaction stays usable', async () => {
    const { orgA, ctxA } = await seedTwoOrgs();
    const head = await insertDoc(ctxA, orgA.id);
    const actor = { userId: null, partnerId: null, accessibleOrgIds: [orgA.id] };
    const file = () => ({ buffer: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(16, 7)]), contentType: 'application/pdf', filename: 'v2.pdf' });

    // Force the race deterministically: the winner inserts its new version and
    // then HOLDS its transaction open. The loser's head pre-check cannot see the
    // uncommitted row, so it passes; its INSERT then blocks on the unique index
    // until the winner commits, and fails 23505. That 23505 must be raised
    // inside a SAVEPOINT: the loser, like a route, CATCHES the service error and
    // keeps using its transaction — without the savepoint the follow-up SELECT
    // fails 25P02 and the mapped 409 would become a 500 at commit (#5580).
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let signalInserted!: () => void;
    const inserted = new Promise<void>((r) => { signalInserted = r; });

    const winner = withDbAccessContext(ctxA, async () => {
      const doc = await replaceDocument(orgA.id, head, { file: file() }, actor);
      signalInserted();
      await gate;
      return doc.id;
    });
    await inserted;

    const loser = withDbAccessContext(ctxA, async () => {
      let caught: { status?: number; code?: string } | null = null;
      try {
        await replaceDocument(orgA.id, head, { file: file() }, actor);
      } catch (err) {
        caught = { status: (err as { status?: number }).status, code: (err as { code?: string }).code };
      }
      const probe = rows(await db.execute(sql`SELECT 1 AS alive`))[0]!.alive;
      return { caught, probe };
    });

    // Give the loser time to pass its pre-check and block on the index.
    await new Promise((r) => setTimeout(r, 750));
    release();

    const [winnerId, loserResult] = await Promise.all([winner, loser]);
    expect(typeof winnerId).toBe('string');
    expect(loserResult.caught).toEqual({ status: 409, code: 'NOT_HEAD' });
    expect(loserResult.probe).toBe(1);

    const successors = rows(await withDbAccessContext(ctxA, () =>
      db.execute(sql`SELECT id FROM org_documents WHERE supersedes_document_id = ${head}::uuid`)));
    expect(successors.map((r) => r.id)).toEqual([winnerId]);
  });

  runDb('a supersede that arrives while a delete holds the head lock waits, then refuses the deleted target (no live row ever points at a tombstone)', async () => {
    const { orgA, ctxA } = await seedTwoOrgs();
    const head = await insertDoc(ctxA, orgA.id, { title: 'Firewall baseline' });
    const newer = await insertDoc(ctxA, orgA.id, { title: 'Firewall baseline v2' });
    const actor = { userId: null, partnerId: null, accessibleOrgIds: [orgA.id] };

    // What this proves: the END STATE under a real concurrent interleave — the
    // superseder waits on the row lock the deleter holds and then refuses,
    // instead of linking `newer` to a tombstone that every read path 404s.
    //
    // What it does NOT prove: that deleteDocument is the thing taking the lock
    // (this test takes one explicitly to make the interleave deterministic, and
    // an UPDATE would take a row lock anyway). That deleteDocument runs its
    // head check and its tombstone under ONE lock is pinned by the unit test
    // 'takes a row lock on the head so a concurrent supersede cannot slip in
    // behind the check' in orgDocumentService.test.ts.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deleterStarted = (async () => {
      // Take the same lock deleteDocument takes, then hold it.
      return withDbAccessContext(ctxA, async () => {
        await db.execute(sql`SELECT id FROM org_documents WHERE id = ${head}::uuid FOR UPDATE`);
        await gate;
        await deleteDocument(orgA.id, head, actor);
      });
    })();

    await new Promise((r) => setTimeout(r, 250));
    let supersedeOutcome: { ok: true } | { status?: number; code?: string };
    const superseder = withDbAccessContext(ctxA, async () => {
      try {
        await supersedeDocument(orgA.id, newer, head, actor);
        return { ok: true } as const;
      } catch (err) {
        return { status: (err as { status?: number }).status, code: (err as { code?: string }).code };
      }
    });
    // Give the superseder time to block on the lock, then let the delete run.
    await new Promise((r) => setTimeout(r, 250));
    release();

    await deleterStarted;
    supersedeOutcome = await superseder;

    // The superseder ran AFTER the delete committed, so its target is gone:
    // it must refuse rather than link to a tombstone.
    expect(supersedeOutcome).toMatchObject({ status: 404 });
    const orphan = rows(await withDbAccessContext(ctxA, () =>
      db.execute(sql`SELECT count(*)::int AS n FROM org_documents WHERE supersedes_document_id IS NOT NULL`)))[0]!.n;
    expect(orphan).toBe(0);
    const live = rows(await withDbAccessContext(ctxA, () =>
      db.execute(sql`SELECT id FROM org_documents WHERE deleted_at IS NULL ORDER BY id`)));
    expect(live.map((r) => r.id)).toEqual([newer]);
  });

  runDb('the SERVICE denies a foreign org against real Postgres — 404 on every exported function, and RLS hides the row even for a system-shaped actor', async () => {
    const { orgA, orgB, ctxA, ctxB } = await seedTwoOrgs();
    const docA = await insertDoc(ctxA, orgA.id, { title: 'Org A baseline' });
    // An actor who can reach org B only, asking for org A's document.
    const actorB = { userId: null, partnerId: null, accessibleOrgIds: [orgB.id] };
    const file = { buffer: Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(8, 3)]), contentType: 'application/pdf', filename: 'x.pdf' };

    await withDbAccessContext(ctxB, async () => {
      for (const call of [
        () => getDocument(orgA.id, docA, actorB),
        () => streamDocument(orgA.id, docA, actorB),
        () => updateDocument(orgA.id, docA, { title: 'pwned' }, actorB),
        () => replaceDocument(orgA.id, docA, { file }, actorB),
        () => supersedeDocument(orgA.id, docA, docA, actorB),
        () => deleteDocument(orgA.id, docA, actorB),
      ]) {
        await expect(call()).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      }
      await expect(listDocuments(orgA.id, {}, actorB)).rejects.toMatchObject({ status: 404 });
    });

    // Defence in depth: even an actor the app layer would let through (null
    // accessibleOrgIds = system-shaped) sees nothing under org B's RLS context,
    // so the guard is not the only thing standing between the orgs.
    const unrestricted = { userId: null, partnerId: null, accessibleOrgIds: null };
    const seen = await withDbAccessContext(ctxB, () => listDocuments(orgA.id, {}, unrestricted));
    expect(seen).toEqual([]);
    await expect(withDbAccessContext(ctxB, () => getDocument(orgA.id, docA, unrestricted)))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    // Positive control: the same calls succeed for the owning org.
    const actorA = { userId: null, partnerId: null, accessibleOrgIds: [orgA.id] };
    const mine = await withDbAccessContext(ctxA, () => listDocuments(orgA.id, {}, actorA));
    expect(mine.map((d) => d.id)).toEqual([docA]);
  });

  runDb('a live row must carry its bytes in exactly one place; a tombstone may carry none (23514 / ok)', async () => {
    const { orgA, ctxA } = await seedTwoOrgs();
    const noBytes = sql`
      INSERT INTO org_documents (org_id, title, storage_backend, content_type, byte_size, sha256, original_filename)
      VALUES (${orgA.id}::uuid, 'x', 'db', 'application/pdf', 1, ${'a'.repeat(64)}, 'x.pdf')`;
    expect(await sqlstate(() => withDbAccessContext(ctxA, () => db.execute(noBytes)))).toBe('23514');
    const id = await insertDoc(ctxA, orgA.id);
    expect(await sqlstate(() => withDbAccessContext(ctxA, () =>
      db.execute(sql`UPDATE org_documents SET deleted_at = now(), data = NULL WHERE id = ${id}::uuid`)))).toBeUndefined();
  });
});
