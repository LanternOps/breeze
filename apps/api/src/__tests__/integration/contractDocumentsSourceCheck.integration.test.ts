/**
 * contract_documents source discriminator + FK direction (#8865 W1b, spec §4.2).
 *
 * contract_documents_one_source_chk is deliberately NOT a strict XOR on
 * quote_id / agreement_request_id: both FKs are ON DELETE SET NULL, so after a
 * source row is deleted both may be NULL, and a strict XOR would raise 23514
 * during the parent delete. These tests pin both halves: the CHECK refuses a
 * mixed-source row, and deleting either source leaves the signed agreement (and
 * its evidence snapshot) in place. They also prove org erasure can order and
 * delete the new tables.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { cascadeDeleteOrg, topologicalCascadeOrder } from '../../services/tenantCascade';
import { createUser } from './db-utils';
import {
  insertRecipient,
  insertRequest,
  insertRequestDocument,
  rows,
  seedPublishedTemplate,
  seedTwoOrgs,
  sqlstate,
  sys,
} from './agreementRequestsFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function insertQuote(partnerId: string, orgId: string): Promise<string> {
  return sys(async () => rows(await db.execute(sql`
    INSERT INTO quotes (partner_id, org_id, currency_code, status)
    VALUES (${partnerId}::uuid, ${orgId}::uuid, 'USD', 'accepted') RETURNING id`))[0]!.id as string);
}

/** Raw contract_documents insert with explicit source columns. */
async function insertDoc(
  orgId: string,
  tv: { templateId: string; versionId: string },
  src: { sourceKind: 'quote' | 'request'; quoteId?: string | null; requestId?: string | null },
): Promise<string> {
  return sys(async () => rows(await db.execute(sql`
    INSERT INTO contract_documents
      (org_id, source_kind, quote_id, agreement_request_id, template_id, template_version_id,
       pdf_data, byte_size, sha256, signer_name, signed_at, acceptance_origin)
    VALUES (${orgId}::uuid, ${src.sourceKind}, ${src.quoteId ?? null}::uuid, ${src.requestId ?? null}::uuid,
            ${tv.templateId}::uuid, ${tv.versionId}::uuid, '\\x00'::bytea, 1, ${'c'.repeat(64)},
            'Jane Doe', now(), 'customer')
    RETURNING id`))[0]!.id as string);
}

const docRow = async (id: string) =>
  rows(await sys(() => db.execute(sql`
    SELECT source_kind, quote_id, agreement_request_id, signer_name, acceptance_origin, signed_at IS NOT NULL AS has_signed_at
      FROM contract_documents WHERE id = ${id}::uuid`)))[0];

describe('contract_documents one-source CHECK + FK direction', () => {
  runDb('both source FKs set → 23514', async () => {
    const { partner, orgA } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const quoteId = await insertQuote(partner.id, orgA.id);
    const requestId = await insertRequest(orgA.id, tv);
    expect(await sqlstate(() => insertDoc(orgA.id, tv, { sourceKind: 'quote', quoteId, requestId }))).toBe('23514');
    expect(await sqlstate(() => insertDoc(orgA.id, tv, { sourceKind: 'request', quoteId, requestId }))).toBe('23514');
  });

  runDb("source_kind='request' with a quote_id → 23514; source_kind='quote' with an agreement_request_id → 23514", async () => {
    const { partner, orgA } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const quoteId = await insertQuote(partner.id, orgA.id);
    const requestId = await insertRequest(orgA.id, tv);
    expect(await sqlstate(() => insertDoc(orgA.id, tv, { sourceKind: 'request', quoteId }))).toBe('23514');
    expect(await sqlstate(() => insertDoc(orgA.id, tv, { sourceKind: 'quote', requestId }))).toBe('23514');
    // Unknown discriminator and origin values are refused too.
    expect(await sqlstate(() => insertDoc(orgA.id, tv, { sourceKind: 'upload' as never }))).toBe('23514');
    // Positive controls: each well-formed source is accepted.
    expect(await sqlstate(() => insertDoc(orgA.id, tv, { sourceKind: 'quote', quoteId }))).toBeUndefined();
    expect(await sqlstate(() => insertDoc(orgA.id, tv, { sourceKind: 'request', requestId }))).toBeUndefined();
  });

  runDb('a request-sourced agreement is unique per request', async () => {
    const { partner, orgA } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const requestId = await insertRequest(orgA.id, tv);
    await insertRequestDocument(orgA.id, tv, requestId);
    expect(await sqlstate(() => insertRequestDocument(orgA.id, tv, requestId))).toBe('23505');
  });

  runDb("deleting the quote leaves a quote-sourced row with its evidence and source_kind='quote'", async () => {
    const { partner, orgA } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const quoteId = await insertQuote(partner.id, orgA.id);
    const docId = await insertDoc(orgA.id, tv, { sourceKind: 'quote', quoteId });

    await sys(() => db.execute(sql`DELETE FROM quotes WHERE id = ${quoteId}::uuid`));
    expect(await docRow(docId)).toEqual({
      source_kind: 'quote', quote_id: null, agreement_request_id: null,
      signer_name: 'Jane Doe', acceptance_origin: 'customer', has_signed_at: true,
    });
  });

  runDb('deleting a draft request nulls agreement_request_id on its signed agreement (SET NULL), row survives', async () => {
    const { partner, orgA } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const requestId = await insertRequest(orgA.id, tv);
    const docId = await insertRequestDocument(orgA.id, tv, requestId);

    await sys(() => db.execute(sql`DELETE FROM agreement_requests WHERE id = ${requestId}::uuid`));
    expect(await docRow(docId)).toEqual({
      source_kind: 'request', quote_id: null, agreement_request_id: null,
      signer_name: 'Jane Doe', acceptance_origin: 'customer', has_signed_at: true,
    });
  });

  // topologicalCascadeOrder() is child-before-parent over every FK edge,
  // SET NULL included: both recipients (CASCADE) and contract_documents
  // (agreement_request_id SET NULL) reference agreement_requests, so both are
  // deleted before it. No CASCADE_ORDER_SET_NULL_EDGE_BREAKS entry is needed
  // because there is no back-edge (no agreement_requests.signed_agreement_id).
  runDb('topologicalCascadeOrder() includes both tables and orders each child before agreement_requests', async () => {
    const order = await sys(() => topologicalCascadeOrder());
    const recipients = order.indexOf('agreement_request_recipients');
    const requests = order.indexOf('agreement_requests');
    const documents = order.indexOf('contract_documents');
    expect(recipients).toBeGreaterThanOrEqual(0);
    expect(requests).toBeGreaterThanOrEqual(0);
    expect(documents).toBeGreaterThanOrEqual(0);
    expect(recipients).toBeLessThan(requests);
    expect(documents).toBeLessThan(requests);
    // The pinned template version must outlive the request that RESTRICT-references it.
    expect(requests).toBeLessThan(order.indexOf('contract_template_versions'));
  });

  runDb('cascadeDeleteOrg erases an org holding a signed request, its recipients and its signed agreement', async () => {
    const { partner, orgA, orgB } = await seedTwoOrgs();
    const actor = await sys(() => createUser({ partnerId: partner.id }));
    const tv = await seedPublishedTemplate(partner.id);
    const requestA = await insertRequest(orgA.id, tv, { status: 'signed' });
    await insertRecipient(orgA.id, requestA, 'a@example.test');
    await insertRequestDocument(orgA.id, tv, requestA);
    // A sibling org's request must survive.
    const requestB = await insertRequest(orgB.id, tv, { status: 'signed' });
    await insertRecipient(orgB.id, requestB, 'b@example.test');
    await insertRequestDocument(orgB.id, tv, requestB);

    const stats = await cascadeDeleteOrg(orgA.id, actor.id);
    expect(stats.tablesDeleted.organizations).toBe(1);
    expect(stats.tablesDeleted.agreement_requests).toBe(1);
    expect(stats.tablesDeleted.agreement_request_recipients).toBe(1);
    expect(stats.tablesDeleted.contract_documents).toBe(1);

    const left = rows(await sys(() => db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM agreement_requests WHERE org_id = ${orgA.id}::uuid) AS a_req,
        (SELECT count(*)::int FROM agreement_request_recipients WHERE org_id = ${orgA.id}::uuid) AS a_rcp,
        (SELECT count(*)::int FROM contract_documents WHERE org_id = ${orgA.id}::uuid) AS a_doc,
        (SELECT count(*)::int FROM agreement_requests WHERE org_id = ${orgB.id}::uuid) AS b_req,
        (SELECT count(*)::int FROM agreement_request_recipients WHERE org_id = ${orgB.id}::uuid) AS b_rcp,
        (SELECT count(*)::int FROM contract_documents WHERE org_id = ${orgB.id}::uuid) AS b_doc`)))[0]!;
    expect(left).toEqual({ a_req: 0, a_rcp: 0, a_doc: 0, b_req: 1, b_rcp: 1, b_doc: 1 });
  });
});
