/**
 * Functional RLS + FK proof for agreement_requests / agreement_request_recipients
 * (#8865 W1b, spec 2026-10-15-standalone-agreement-signing §4.1).
 *
 * Both tables are RLS shape 1 (direct org_id, four per-command
 * breeze_has_org_access policies). These run through the real driver as the
 * unprivileged app role under the integration config. Beyond the forge they
 * pin the structural contracts: the composite (contract_id, org_id) FK keeps a
 * request on its own org's contracts and SET NULLs only contract_id, and the
 * DEFERRABLE composite FKs let org merge move parent and child separately.
 *
 * Fixtures are re-seeded per test (setup truncates tenant data between tests).
 */
import './setup';
import { getTestDb } from './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import {
  insertContract,
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

describe('agreement_requests / agreement_request_recipients RLS (shape 1)', () => {
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const { ctxA } = await seedTwoOrgs();
    const r = rows(await withDbAccessContext(ctxA, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`)))[0]!;
    expect(r.who).toBe('breeze_app');
    expect(r.rolbypassrls).toBe(false);
  });

  runDb('both tables have RLS enabled + forced and exactly the four per-command policies', async () => {
    const meta = rows(await sys(() => db.execute(sql`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT array_agg(p.cmd ORDER BY p.cmd) FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS cmds
        FROM pg_class c
       WHERE c.relname IN ('agreement_requests', 'agreement_request_recipients')
       ORDER BY c.relname`)));
    expect(meta).toEqual([
      { relname: 'agreement_request_recipients', relrowsecurity: true, relforcerowsecurity: true, cmds: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
      { relname: 'agreement_requests', relrowsecurity: true, relforcerowsecurity: true, cmds: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
    ]);
  });

  runDb('cross-tenant forge insert as the app role is refused (42501) on both tables', async () => {
    const { partner, orgA, orgB, ctxA } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    expect(await sqlstate(() => withDbAccessContext(ctxA, () => db.execute(sql`
      INSERT INTO agreement_requests (org_id, template_id, template_version_id, expires_at)
      VALUES (${orgB.id}::uuid, ${tv.templateId}::uuid, ${tv.versionId}::uuid, now() + interval '30 days')`)))).toBe('42501');

    const requestB = await insertRequest(orgB.id, tv);
    expect(await sqlstate(() => withDbAccessContext(ctxA, () => db.execute(sql`
      INSERT INTO agreement_request_recipients (org_id, request_id, email)
      VALUES (${orgB.id}::uuid, ${requestB}::uuid, 'forged@example.test')`)))).toBe('42501');

    // Positive control: org A writes its own request + recipient.
    expect(await sqlstate(() => withDbAccessContext(ctxA, () => db.execute(sql`
      WITH r AS (
        INSERT INTO agreement_requests (org_id, template_id, template_version_id, expires_at)
        VALUES (${orgA.id}::uuid, ${tv.templateId}::uuid, ${tv.versionId}::uuid, now() + interval '30 days')
        RETURNING id
      )
      INSERT INTO agreement_request_recipients (org_id, request_id, email)
      SELECT ${orgA.id}::uuid, r.id, 'own@example.test' FROM r`)))).toBeUndefined();
  });

  runDb('an org context reads only its own requests and recipients', async () => {
    const { partner, orgA, orgB, ctxA, ctxB } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const requestA = await insertRequest(orgA.id, tv);
    const requestB = await insertRequest(orgB.id, tv);
    await insertRecipient(orgA.id, requestA, 'a@example.test');
    await insertRecipient(orgB.id, requestB, 'b@example.test');

    const seenByA = rows(await withDbAccessContext(ctxA, () => db.execute(sql`
      SELECT (SELECT array_agg(id) FROM agreement_requests) AS requests,
             (SELECT array_agg(email) FROM agreement_request_recipients) AS emails`)))[0]!;
    expect(seenByA).toEqual({ requests: [requestA], emails: ['a@example.test'] });

    const seenByB = rows(await withDbAccessContext(ctxB, () => db.execute(sql`
      SELECT (SELECT array_agg(id) FROM agreement_requests) AS requests,
             (SELECT array_agg(email) FROM agreement_request_recipients) AS emails`)))[0]!;
    expect(seenByB).toEqual({ requests: [requestB], emails: ['b@example.test'] });

    // UPDATE/DELETE of another org's row match nothing (USING hides it).
    await withDbAccessContext(ctxA, () => db.execute(sql`UPDATE agreement_requests SET label = 'hijack' WHERE id = ${requestB}::uuid`));
    await withDbAccessContext(ctxA, () => db.execute(sql`DELETE FROM agreement_request_recipients WHERE request_id = ${requestB}::uuid`));
    const b = rows(await sys(() => db.execute(sql`
      SELECT r.label, (SELECT count(*)::int FROM agreement_request_recipients x WHERE x.request_id = r.id) AS n
        FROM agreement_requests r WHERE r.id = ${requestB}::uuid`)))[0]!;
    expect(b).toEqual({ label: null, n: 1 });
  });

  runDb("filing against another org's contract is refused by the composite FK (23503), even under system scope", async () => {
    const { partner, orgA, orgB } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const contractB = await insertContract(partner.id, orgB.id);
    expect(await sqlstate(() => insertRequest(orgA.id, tv, { contractId: contractB }))).toBe('23503');

    // A recipient cannot sit in a different org than its request either.
    const requestA = await insertRequest(orgA.id, tv);
    expect(await sqlstate(() => insertRecipient(orgB.id, requestA, 'x@example.test'))).toBe('23503');

    // Positive control: the same org's contract is accepted.
    const contractA = await insertContract(partner.id, orgA.id);
    expect(await sqlstate(() => insertRequest(orgA.id, tv, { contractId: contractA }))).toBeUndefined();
  });

  runDb('deleting a contract nulls only contract_id on its requests (column-list SET NULL)', async () => {
    const { partner, orgA } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const contractA = await insertContract(partner.id, orgA.id);
    const requestA = await insertRequest(orgA.id, tv, { contractId: contractA });

    await sys(() => db.execute(sql`DELETE FROM contracts WHERE id = ${contractA}::uuid`));
    const r = rows(await sys(() => db.execute(sql`
      SELECT contract_id, org_id FROM agreement_requests WHERE id = ${requestA}::uuid`)))[0]!;
    expect(r).toEqual({ contract_id: null, org_id: orgA.id });
  });

  runDb('deleting a request cascades to its recipients', async () => {
    const { partner, orgA } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const requestA = await insertRequest(orgA.id, tv);
    await insertRecipient(orgA.id, requestA, 'a@example.test');
    await sys(() => db.execute(sql`DELETE FROM agreement_requests WHERE id = ${requestA}::uuid`));
    const n = rows(await sys(() => db.execute(sql`
      SELECT count(*)::int AS n FROM agreement_request_recipients WHERE request_id = ${requestA}::uuid`)))[0]!;
    expect(n.n).toBe(0);
  });

  runDb('recipient emails must be stored normalized (23514)', async () => {
    const { partner, orgA } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const requestA = await insertRequest(orgA.id, tv);
    expect(await sqlstate(() => insertRecipient(orgA.id, requestA, ' Mixed@Example.test'))).toBe('23514');
  });

  runDb('org merge repoints a request + its recipients + its signed agreement without 23503', async () => {
    const { partner, orgA, orgB, ctxB } = await seedTwoOrgs();
    const tv = await seedPublishedTemplate(partner.id);
    const contractA = await insertContract(partner.id, orgA.id);
    const requestA = await insertRequest(orgA.id, tv, { contractId: contractA, status: 'signed' });
    await insertRecipient(orgA.id, requestA, 'a@example.test');
    const docA = await insertRequestDocument(orgA.id, tv, requestA);

    // Control: with IMMEDIATE checking, moving the parent first is refused —
    // the recipients' composite FK fires on the parent's org_id change.
    expect(await sqlstate(() => sys(() =>
      db.execute(sql`UPDATE agreement_requests SET org_id = ${orgB.id}::uuid WHERE id = ${requestA}::uuid`)))).toBe('23503');

    // The merge shape (orgMerge.ts): one transaction, SET CONSTRAINTS ALL DEFERRED,
    // parent and children moved in separate statements.
    const adminDb = getTestDb() as never as typeof db;
    await adminDb.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`UPDATE contracts SET org_id = ${orgB.id}::uuid WHERE id = ${contractA}::uuid`);
      await tx.execute(sql`UPDATE agreement_requests SET org_id = ${orgB.id}::uuid WHERE org_id = ${orgA.id}::uuid`);
      await tx.execute(sql`UPDATE agreement_request_recipients SET org_id = ${orgB.id}::uuid WHERE org_id = ${orgA.id}::uuid`);
      await tx.execute(sql`UPDATE contract_documents SET org_id = ${orgB.id}::uuid WHERE org_id = ${orgA.id}::uuid`);
    });

    const seenByB = rows(await withDbAccessContext(ctxB, () => db.execute(sql`
      SELECT (SELECT count(*)::int FROM agreement_requests WHERE id = ${requestA}::uuid AND contract_id = ${contractA}::uuid) AS r,
             (SELECT count(*)::int FROM agreement_request_recipients WHERE request_id = ${requestA}::uuid) AS rr,
             (SELECT count(*)::int FROM contract_documents WHERE id = ${docA}::uuid AND agreement_request_id = ${requestA}::uuid) AS d`)))[0]!;
    expect(seenByB).toEqual({ r: 1, rr: 1, d: 1 });
  });
});
