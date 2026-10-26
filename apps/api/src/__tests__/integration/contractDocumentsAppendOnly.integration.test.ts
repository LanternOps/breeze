/**
 * contract_documents is append-only (#9075 W4b, spec OD2-B;
 * migrations/2027-01-06-150000-contract-documents-append-only.sql).
 *
 * A signed agreement is legal evidence. Once inserted, the bytes, the hashes
 * and the signer snapshot never change and the row is never deleted, except
 * by org erasure (breeze_audit_admin + breeze.allow_audit_retention = '1').
 * What still moves, and why:
 *
 *   contract_id   filing link: link-later, contract adopt, contracts FK SET NULL
 *   org_id        org merge re-point only (system scope, loser fenced
 *                 'merging', survivor under the same partner)
 *   quote_id, quote_acceptance_id, agreement_request_id, recorded_by_user_id
 *                 cleared to NULL by their own ON DELETE SET NULL only
 *
 * Two walls. breeze_app holds UPDATE on contract_id and org_id ONLY (column
 * grants), so any other app-role write is 42501 before a trigger runs; the
 * contract_documents_append_only trigger (55000) binds every role, the table
 * owner included, and limits org_id to the merge. Runs through the breeze_app
 * pool (`db`) unless a test says otherwise; the superuser connection
 * (`getTestDb()`) proves the trigger wall. Setup truncates tenant data between
 * tests.
 */
import './setup';
import { getTestDb } from './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { createUser } from './db-utils';
import type { AuthContext } from '../../middleware/auth';
import { linkContractDocument } from '../../services/contractDocumentService';
import {
  insertContract,
  insertRequest,
  insertRequestDocument,
  orgContext,
  rows,
  seedPublishedTemplate,
  seedTwoOrgs,
  sqlstate,
  sys,
} from './agreementRequestsFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const admin = () => getTestDb() as never as typeof db;

const docRow = async (id: string) =>
  rows(await sys(() => db.execute(sql`SELECT * FROM contract_documents WHERE id = ${id}::uuid`)))[0];

/** A quote-sourced signed agreement with every provenance pointer set. */
async function seedQuoteDocument() {
  const t = await seedTwoOrgs();
  const tv = await seedPublishedTemplate(t.partner.id);
  return sys(async () => {
    const tech = await createUser({ partnerId: t.partner.id, orgId: t.orgA.id });
    const quoteId = rows(await db.execute(sql`
      INSERT INTO quotes (partner_id, org_id, currency_code, status)
      VALUES (${t.partner.id}::uuid, ${t.orgA.id}::uuid, 'USD', 'accepted') RETURNING id`))[0]!.id as string;
    const acceptanceId = rows(await db.execute(sql`
      INSERT INTO quote_acceptances
        (quote_id, org_id, signer_name, signer_email, signed_at, ip_address, user_agent,
         quote_sha256, hash_version, render_locale, origin, method, reference, recorded_by_user_id)
      VALUES (${quoteId}::uuid, ${t.orgA.id}::uuid, 'Jane Doe', 'jane@example.test', '2026-10-01 12:34:56',
              '203.0.113.7', 'UA/1', ${'a'.repeat(64)}, 2, 'en', 'on_behalf', 'email', 'PO 1', ${tech.id}::uuid)
      RETURNING id`))[0]!.id as string;
    const docId = rows(await db.execute(sql`
      INSERT INTO contract_documents
        (org_id, source_kind, quote_id, quote_acceptance_id, template_id, template_version_id,
         rendered_html, pdf_data, byte_size, sha256, signer_name, signer_email, signed_at, signer_ip,
         signer_user_agent, acceptance_origin, acceptance_method, acceptance_reference,
         recorded_by_user_id, content_sha256, content_hash_version, acceptance_render_locale)
      VALUES (${t.orgA.id}::uuid, 'quote', ${quoteId}::uuid, ${acceptanceId}::uuid, ${tv.templateId}::uuid,
              ${tv.versionId}::uuid, '<p>MSA</p>', '\\x25504446'::bytea, 4, ${'c'.repeat(64)}, 'Jane Doe',
              'jane@example.test', '2026-10-01 12:34:56+00', '203.0.113.7', 'UA/1', 'on_behalf', 'email',
              'PO 1', ${tech.id}::uuid, ${'d'.repeat(64)}, 2, 'en')
      RETURNING id`))[0]!.id as string;
    return { ...t, tv, techId: tech.id, quoteId, acceptanceId, docId };
  });
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null };
}

describe('contract_documents append-only (#9075 W4b)', () => {
  runDb('breeze_app: SELECT/INSERT, UPDATE on contract_id + org_id only, no DELETE/TRUNCATE; breeze_audit_admin may DELETE', async () => {
    const [p] = rows(await db.execute(sql`
      SELECT has_table_privilege('breeze_app', 'contract_documents', 'SELECT') AS sel,
             has_table_privilege('breeze_app', 'contract_documents', 'INSERT') AS ins,
             has_table_privilege('breeze_app', 'contract_documents', 'UPDATE') AS upd,
             has_column_privilege('breeze_app', 'contract_documents', 'contract_id', 'UPDATE') AS upd_contract,
             has_column_privilege('breeze_app', 'contract_documents', 'org_id', 'UPDATE') AS upd_org,
             has_column_privilege('breeze_app', 'contract_documents', 'quote_id', 'UPDATE') AS upd_quote,
             has_column_privilege('breeze_app', 'contract_documents', 'pdf_data', 'UPDATE') AS upd_pdf,
             has_table_privilege('breeze_app', 'contract_documents', 'DELETE') AS del,
             has_table_privilege('breeze_app', 'contract_documents', 'TRUNCATE') AS trunc,
             has_table_privilege('breeze_audit_admin', 'contract_documents', 'DELETE') AS admin_del,
             has_table_privilege('breeze_audit_admin', 'contract_documents', 'UPDATE') AS admin_upd`));
    expect(p).toEqual({
      sel: true, ins: true, upd: false, upd_contract: true, upd_org: true, upd_quote: false, upd_pdf: false,
      del: false, trunc: false, admin_del: true, admin_upd: false,
    });
  });

  runDb.each([
    ['pdf_data', sql`pdf_data = '\\x00'::bytea`],
    ['sha256', sql`sha256 = ${'e'.repeat(64)}`],
    ['byte_size', sql`byte_size = 5`],
    ['mime', sql`mime = 'image/png'`],
    ['rendered_html', sql`rendered_html = '<p>other</p>'`],
    ['content_sha256', sql`content_sha256 = ${'f'.repeat(64)}`],
    ['content_hash_version', sql`content_hash_version = 1`],
    ['signer_name', sql`signer_name = 'Mallory'`],
    ['signer_email', sql`signer_email = NULL`],
    ['signed_at', sql`signed_at = now()`],
    ['signer_ip', sql`signer_ip = '198.51.100.1'`],
    ['acceptance_origin', sql`acceptance_origin = 'customer'`],
    ['acceptance_method', sql`acceptance_method = 'phone'`],
    ['acceptance_reference', sql`acceptance_reference = 'forged'`],
    ['acceptance_render_locale', sql`acceptance_render_locale = 'fr-FR'`],
    ['source_kind', sql`source_kind = 'request', quote_id = NULL, quote_acceptance_id = NULL`],
    ['template_id', sql`template_id = gen_random_uuid()`],
    ['template_version_id', sql`template_version_id = gen_random_uuid()`],
    ['created_at', sql`created_at = now() - interval '1 day'`],
  ])('refuses a rewrite of %s: 42501 for the app role (no column grant), 55000 for the table owner (trigger)', async (_col, set) => {
    const s = await seedQuoteDocument();
    const before = await docRow(s.docId);
    const stmt = sql`UPDATE contract_documents SET ${set} WHERE id = ${s.docId}::uuid`;
    expect(await sqlstate(() => sys(() => db.execute(stmt)))).toBe('42501');
    expect(await sqlstate(() => admin().execute(stmt))).toBe('55000');
    expect(await docRow(s.docId)).toEqual(before);
  });

  runDb('a no-op UPDATE passes: the guard compares values, not the SET list', async () => {
    const s = await seedQuoteDocument();
    expect(await sqlstate(() => admin().execute(sql`
      UPDATE contract_documents SET signer_name = signer_name, pdf_data = pdf_data WHERE id = ${s.docId}::uuid`))).toBeUndefined();
    expect(await sqlstate(() => sys(() => db.execute(sql`
      UPDATE contract_documents SET contract_id = contract_id, org_id = org_id WHERE id = ${s.docId}::uuid`)))).toBeUndefined();
  });

  runDb('linkContractDocument still files an unattached agreement under a contract (contract_id only)', async () => {
    const s = await seedQuoteDocument();
    const contractId = await insertContract(s.partner.id, s.orgA.id);
    const auth = { canAccessOrg: (orgId: string) => orgId === s.orgA.id } as unknown as AuthContext;
    const linked = await withDbAccessContext(s.ctxA, () => linkContractDocument(auth, s.docId, contractId));
    expect(linked.contractId).toBe(contractId);
    const after = await docRow(s.docId);
    expect(after).toMatchObject({ contract_id: contractId, signer_name: 'Jane Doe', sha256: 'c'.repeat(64) });
  });

  runDb('contract_id re-files (adopt) and clears when the contract is deleted (FK SET NULL)', async () => {
    const s = await seedQuoteDocument();
    const [c1, c2] = [await insertContract(s.partner.id, s.orgA.id), await insertContract(s.partner.id, s.orgA.id)];
    await withDbAccessContext(s.ctxA, () => db.execute(sql`UPDATE contract_documents SET contract_id = ${c1}::uuid WHERE id = ${s.docId}::uuid`));
    await withDbAccessContext(s.ctxA, () => db.execute(sql`UPDATE contract_documents SET contract_id = ${c2}::uuid WHERE id = ${s.docId}::uuid`));
    expect((await docRow(s.docId))!.contract_id).toBe(c2);
    await sys(() => db.execute(sql`DELETE FROM contracts WHERE id = ${c2}::uuid`));
    expect((await docRow(s.docId))!.contract_id).toBeNull();
  });

  runDb('a direct UPDATE may not clear a provenance pointer (42501 app / 55000 owner), but deleting its target does', async () => {
    const s = await seedQuoteDocument();
    for (const col of ['quote_id', 'quote_acceptance_id', 'recorded_by_user_id']) {
      const stmt = sql`UPDATE contract_documents SET ${sql.identifier(col)} = NULL WHERE id = ${s.docId}::uuid`;
      expect(await sqlstate(() => sys(() => db.execute(stmt)))).toBe('42501');
      // The owner holds every grant, so this is the trigger's depth-0 refusal.
      expect(await sqlstate(() => admin().execute(stmt))).toBe('55000');
    }
    // Re-pointing a provenance id elsewhere is refused too.
    expect(await sqlstate(() => admin().execute(sql`
      UPDATE contract_documents SET quote_id = gen_random_uuid() WHERE id = ${s.docId}::uuid`))).toBe('55000');

    // Deleting the quote cascades its acceptance; both SET NULLs land, the
    // evidence snapshot survives (spec §4.4 "Quote deletion").
    await sys(() => db.execute(sql`DELETE FROM quotes WHERE id = ${s.quoteId}::uuid`));
    // Deleting the recorder nulls recorded_by_user_id.
    await sys(() => db.execute(sql`DELETE FROM users WHERE id = ${s.techId}::uuid`));
    const after = await docRow(s.docId);
    expect(after).toMatchObject({
      quote_id: null, quote_acceptance_id: null, recorded_by_user_id: null,
      source_kind: 'quote', signer_name: 'Jane Doe', acceptance_reference: 'PO 1', content_sha256: 'd'.repeat(64),
    });
  });

  runDb('breeze_app cannot fake the FK SET NULL from a trigger of its own (temp-trigger depth bypass, 42501)', async () => {
    // pg_trigger_depth() > 1 says "inside SOME trigger", not "inside the FK's
    // action". breeze_app holds TEMP, so it can create a pg_temp trigger that
    // clears a pointer at depth 2 while the quote still exists. The column-level
    // UPDATE grant (contract_id, org_id only) is what stops it; the real RI
    // action runs as the table owner and is unaffected (previous test).
    const s = await seedQuoteDocument();
    const code = await sqlstate(() => sys(async () => {
      await db.execute(sql`CREATE TEMP TABLE w4b_probe (x int) ON COMMIT DROP`);
      await db.execute(sql.raw(`
        CREATE FUNCTION pg_temp.w4b_clear_quote() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          UPDATE public.contract_documents SET quote_id = NULL WHERE id = '${s.docId}'::uuid;
          RETURN NEW;
        END $$`));
      await db.execute(sql`CREATE TRIGGER w4b_probe_trg AFTER INSERT ON w4b_probe FOR EACH ROW EXECUTE FUNCTION pg_temp.w4b_clear_quote()`);
      await db.execute(sql`INSERT INTO w4b_probe VALUES (1)`);
    }));
    expect(code).toBe('42501');
    expect((await docRow(s.docId))!.quote_id).toBe(s.quoteId);
  });

  runDb('deleting the agreement request clears agreement_request_id and keeps the signed agreement', async () => {
    const t = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(t.partner.id);
    const requestId = await insertRequest(t.orgA.id, tv, { status: 'signed' });
    const docId = await insertRequestDocument(t.orgA.id, tv, requestId);
    expect(await sqlstate(() => admin().execute(sql`
      UPDATE contract_documents SET agreement_request_id = NULL WHERE id = ${docId}::uuid`))).toBe('55000');
    await sys(() => db.execute(sql`DELETE FROM agreement_requests WHERE id = ${requestId}::uuid`));
    expect(await docRow(docId)).toMatchObject({ agreement_request_id: null, source_kind: 'request', signer_name: 'Jane Doe' });
  });

  runDb('org_id moves only as the org-merge re-point: system scope, loser fenced merging, same partner', async () => {
    const s = await seedQuoteDocument();
    const { orgA: loser, orgB: survivor } = s;
    const foreign = (await seedTwoOrgs()).orgA;
    const repoint = (to: string) => sql`UPDATE contract_documents SET org_id = ${to}::uuid WHERE org_id = ${loser.id}::uuid`;

    // No fence: refused even in system scope, and for the superuser.
    expect(await sqlstate(() => sys(() => db.execute(repoint(survivor.id))))).toBe('55000');
    expect(await sqlstate(() => admin().execute(repoint(survivor.id)))).toBe('55000');

    await admin().execute(sql`UPDATE organizations SET status = 'merging' WHERE id = ${loser.id}::uuid`);
    // Fenced, but to another partner's org.
    expect(await sqlstate(() => sys(() => db.execute(repoint(foreign.id))))).toBe('55000');
    // Fenced, same partner, but a partner caller (who can flip status itself) — system scope is required.
    expect(await sqlstate(() => withDbAccessContext(partnerContext(s.partner.id, [loser.id, survivor.id]), () =>
      db.execute(repoint(survivor.id))))).toBe('55000');
    // The re-point may not smuggle an evidence change along with it: no column
    // grant for the app role, and the trigger refuses it for the owner even in
    // system scope with the fence up.
    const smuggle = sql`UPDATE contract_documents SET org_id = ${survivor.id}::uuid, signer_name = 'Mallory' WHERE org_id = ${loser.id}::uuid`;
    expect(await sqlstate(() => sys(() => db.execute(smuggle)))).toBe('42501');
    expect(await sqlstate(() => admin().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      await tx.execute(smuggle);
    }))).toBe('55000');

    await sys(() => db.execute(repoint(survivor.id)));
    expect(await docRow(s.docId)).toMatchObject({ org_id: survivor.id, signer_name: 'Jane Doe' });
  });

  runDb('DELETE: refused for breeze_app (42501) and for every role without the audit-admin pair (55000)', async () => {
    const s = await seedQuoteDocument();
    const del = sql`DELETE FROM contract_documents WHERE id = ${s.docId}::uuid`;
    expect(await sqlstate(() => sys(() => db.execute(del)))).toBe('42501');
    expect(await sqlstate(() => withDbAccessContext(orgContext(s.orgA.id), () => db.execute(del)))).toBe('42501');
    // The GUC alone is caller-settable; it authorizes nothing without the role.
    expect(await sqlstate(() => admin().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await tx.execute(del);
    }))).toBe('55000');
    // The role alone is not enough either.
    expect(await sqlstate(() => sys(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(del);
    }))).toBe('55000');
    // The superuser is bound too.
    expect(await sqlstate(() => admin().execute(del))).toBe('55000');
    expect(await docRow(s.docId)).toBeDefined();

    await sys(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await db.execute(del);
    });
    expect(await docRow(s.docId)).toBeUndefined();
  });
});
