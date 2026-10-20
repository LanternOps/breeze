/**
 * #9312 — a signed agreement already stored in `contract_documents` can be
 * linked as deliverable evidence BY REFERENCE (evidence kind
 * `contract_document`), never by copying its bytes into `org_documents`.
 *
 * Proves, against real Postgres as the unprivileged app role:
 *  - the service links an agreement of the occurrence's own org, and answers
 *    404 for another org's agreement even when the caller's RLS context can
 *    see both orgs (so the explicit org predicate, not RLS alone, refuses it);
 *  - the composite FK (contract_document_id, org_id) refuses a cross-org
 *    pairing (23503) and is DEFERRABLE for org merge;
 *  - sd_evidence_kind_chk keeps exactly one target per kind (23514);
 *  - deleting the agreement cascades its evidence rows.
 *
 * Fixtures are re-seeded per test: the integration setup truncates tenant data
 * between tests.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { addEvidence } from '../../services/serviceDeliverableService';
import {
  insertRequest, insertRequestDocument, rows, seedPublishedTemplate, seedTwoOrgs, sqlstate, sys,
} from './agreementRequestsFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function insertOccurrence(orgId: string): Promise<string> {
  return sys(async () => {
    const d = rows(await db.execute(sql`
      INSERT INTO service_deliverables (org_id, name, cadence, anchor_due_date, effective_from)
      VALUES (${orgId}::uuid, 'Agreement signed', 'one_time', '2026-12-31', '2026-10-01')
      RETURNING id`))[0]!.id as string;
    return rows(await db.execute(sql`
      INSERT INTO service_deliverable_occurrences
        (org_id, deliverable_id, name_snapshot, period_start, period_end, due_at, original_due_at, status)
      VALUES (${orgId}::uuid, ${d}::uuid, 'Agreement signed', '2026-10-01', '2026-12-31', '2026-12-31', '2026-12-31', 'open')
      RETURNING id`))[0]!.id as string;
  });
}

async function seedAgreement(partnerId: string, orgId: string): Promise<string> {
  const tv = await seedPublishedTemplate(partnerId);
  const requestId = await insertRequest(orgId, tv, { status: 'signed' });
  return insertRequestDocument(orgId, tv, requestId);
}

async function seed() {
  const base = await seedTwoOrgs();
  const occA = await insertOccurrence(base.orgA.id);
  const agreementA = await seedAgreement(base.partner.id, base.orgA.id);
  const agreementB = await seedAgreement(base.partner.id, base.orgB.id);
  // A partner technician's context sees BOTH orgs through RLS.
  const partnerCtx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [base.orgA.id, base.orgB.id],
    accessiblePartnerIds: [base.partner.id], userId: null,
  };
  const actor = { userId: null, partnerId: base.partner.id, accessibleOrgIds: [base.orgA.id, base.orgB.id] };
  return { ...base, occA, agreementA, agreementB, partnerCtx, actor };
}

async function evidenceRows(orgId: string) {
  return sys(async () => rows(await db.execute(sql`
    SELECT kind::text AS kind, contract_document_id, document_id, report_id, report_run_id
      FROM service_deliverable_evidence WHERE org_id = ${orgId}::uuid`)));
}

describe('signed agreement as deliverable evidence (#9312, live DB)', () => {
  runDb('links the org\'s own signed agreement by reference', async () => {
    const s = await seed();
    const view = await withDbAccessContext(s.partnerCtx, () =>
      addEvidence(s.orgA.id, s.occA, { kind: 'contract_document', contractDocumentId: s.agreementA }, s.actor));
    expect(view.evidence).toEqual([
      expect.objectContaining({ kind: 'contract_document', contractDocumentId: s.agreementA, documentId: null }),
    ]);
    expect(await evidenceRows(s.orgA.id)).toEqual([
      { kind: 'contract_document', contract_document_id: s.agreementA, document_id: null, report_id: null, report_run_id: null },
    ]);
    // No copy: the library is untouched.
    const docs = await sys(async () => rows(await db.execute(sql`SELECT count(*)::int AS n FROM org_documents`)));
    expect(docs[0]!.n).toBe(0);
  });

  runDb('another org\'s signed agreement is 404 even when RLS can see both orgs; nothing is inserted', async () => {
    const s = await seed();
    await expect(withDbAccessContext(s.partnerCtx, () =>
      addEvidence(s.orgA.id, s.occA, { kind: 'contract_document', contractDocumentId: s.agreementB }, s.actor)))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await evidenceRows(s.orgA.id)).toEqual([]);
  });

  runDb('composite FK refuses a cross-org pairing (23503); same-org positive control succeeds', async () => {
    const s = await seed();
    const forge = (cdoc: string) => sql`
      INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, contract_document_id)
      VALUES (${s.orgA.id}::uuid, ${s.occA}::uuid, 'contract_document', ${cdoc}::uuid)`;
    expect(await sqlstate(() => sys(() => db.execute(forge(s.agreementB))))).toBe('23503');
    expect(await sqlstate(() => withDbAccessContext(s.ctxA, () => db.execute(forge(s.agreementA))))).toBeUndefined();
  });

  runDb('the FK is DEFERRABLE INITIALLY IMMEDIATE (org merge re-points parent and child separately)', async () => {
    const r = await sys(async () => rows(await db.execute(sql`
      SELECT condeferrable, condeferred FROM pg_constraint
       WHERE conname = 'sd_evidence_contract_document_org_fk'
         AND conrelid = 'service_deliverable_evidence'::regclass`)));
    expect(r).toEqual([{ condeferrable: true, condeferred: false }]);
  });

  runDb('sd_evidence_kind_chk keeps exactly one target per kind (23514)', async () => {
    const s = await seed();
    const docId = rows(await sys(() => db.execute(sql`
      INSERT INTO org_documents (org_id, title, category, storage_backend, data, content_type, byte_size, sha256, original_filename)
      VALUES (${s.orgA.id}::uuid, 'Scan', 'evidence', 'db', '\\x255044462d'::bytea, 'application/pdf', 5, ${'a'.repeat(64)}, 'scan.pdf')
      RETURNING id`)))[0]!.id as string;
    const insert = (kind: string, cdoc: string | null, doc: string | null) => sys(() => db.execute(sql`
      INSERT INTO service_deliverable_evidence (org_id, occurrence_id, kind, contract_document_id, document_id)
      VALUES (${s.orgA.id}::uuid, ${s.occA}::uuid, ${kind}::deliverable_evidence_kind, ${cdoc}::uuid, ${doc}::uuid)`));
    expect(await sqlstate(() => insert('contract_document', null, null))).toBe('23514');
    expect(await sqlstate(() => insert('contract_document', s.agreementA, docId))).toBe('23514');
    expect(await sqlstate(() => insert('document', s.agreementA, docId))).toBe('23514');
    // Positive controls: each kind with exactly its own target.
    expect(await sqlstate(() => insert('document', null, docId))).toBeUndefined();
    expect(await sqlstate(() => insert('contract_document', s.agreementA, null))).toBeUndefined();
  });

  runDb('deleting the signed agreement cascades its evidence and leaves the occurrence', async () => {
    const s = await seed();
    await withDbAccessContext(s.partnerCtx, () =>
      addEvidence(s.orgA.id, s.occA, { kind: 'contract_document', contractDocumentId: s.agreementA }, s.actor));
    await sys(() => db.execute(sql`DELETE FROM contract_documents WHERE id = ${s.agreementA}::uuid`));
    expect(await evidenceRows(s.orgA.id)).toEqual([]);
    const occ = await sys(async () => rows(await db.execute(sql`SELECT count(*)::int AS n FROM service_deliverable_occurrences`)));
    expect(occ[0]!.n).toBe(1);
  });
});
