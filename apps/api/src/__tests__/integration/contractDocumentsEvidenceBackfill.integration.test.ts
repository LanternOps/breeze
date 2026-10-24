/**
 * Back-fill proof for the signer-evidence snapshot on contract_documents
 * (#8865 W1b, spec docs/superpowers/specs/billing/2026-10-15-standalone-agreement-signing-spec.md §4.2).
 *
 * The migration copies quote_acceptances evidence onto every contract_documents
 * row whose quote_acceptance_id still resolves, so a signed agreement keeps
 * "who signed, when, how" after its quote is deleted. A legacy row whose
 * acceptance is already gone (quote deleted → SET NULL) must stay
 * source_kind='quote' with NULL evidence — never invented, never blanked into ''.
 *
 * Fixtures are re-seeded per test: the integration setup truncates tenant data
 * between tests.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createUser } from './db-utils';
import { replayMigration } from './replayMigration';

const MIGRATION = '2026-12-31-210000-agreement-requests.sql';
const runDb = it.runIf(!!process.env.DATABASE_URL);

type Row = Record<string, unknown>;
const rows = (r: unknown) => r as unknown as Row[];
const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

// A dedicated superuser client (the role autoMigrate runs as) with onnotice
// wired, so the back-fill's RAISE WARNING row count can be asserted.
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: (n) => { notices.push(String(n.message)); } });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });
async function runMigrationAsAdmin(): Promise<string[]> {
  const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  return notices.filter((m) => m.startsWith('backfilled signer evidence'));
}

const QUOTE_SHA = 'a'.repeat(64);

/** Seeds: template + published version; a quote + an on-behalf acceptance
 *  (method 'email', reference 'PO 1', render_locale 'fr-FR', hash_version 2);
 *  contract_documents row A linked to that acceptance; row B with
 *  quote_acceptance_id NULL (its quote was deleted long ago). Both rows start
 *  with NULL evidence, as every pre-migration row does. */
async function seed() {
  return sys(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const tech = await createUser({ partnerId: partner.id, orgId: org.id });
    const tv = rows(await db.execute(sql`
      WITH t AS (
        INSERT INTO contract_templates (org_id, name) VALUES (${org.id}::uuid, 'Backfill MSA') RETURNING id
      )
      INSERT INTO contract_template_versions
        (template_id, org_id, version_number, status, source_type, body_html, sha256, declared_variables, published_at)
      SELECT t.id, ${org.id}::uuid, 1, 'published', 'authored', '<p>MSA</p>', ${'b'.repeat(64)}, '[]'::jsonb, now() FROM t
      RETURNING template_id, id`))[0]!;
    const quoteId = rows(await db.execute(sql`
      INSERT INTO quotes (partner_id, org_id, currency_code, status)
      VALUES (${partner.id}::uuid, ${org.id}::uuid, 'EUR', 'accepted') RETURNING id`))[0]!.id as string;
    const acceptance = rows(await db.execute(sql`
      INSERT INTO quote_acceptances
        (quote_id, org_id, signer_name, signer_email, signed_at, ip_address, user_agent,
         quote_sha256, hash_version, render_locale, origin, method, reference, recorded_by_user_id)
      VALUES (${quoteId}::uuid, ${org.id}::uuid, 'Jane Doe', 'jane@example.test', '2026-10-01 12:34:56',
              '203.0.113.7', 'UA/1', ${QUOTE_SHA}, 2, 'fr-FR', 'on_behalf', 'email', 'PO 1', ${tech.id}::uuid)
      RETURNING id`))[0]!;
    const insertDoc = async (link: boolean) => rows(await db.execute(sql`
      INSERT INTO contract_documents
        (org_id, quote_id, quote_acceptance_id, template_id, template_version_id, pdf_data, byte_size, sha256)
      VALUES (${org.id}::uuid,
              ${link ? quoteId : null}::uuid,
              ${link ? acceptance.id : null}::uuid,
              ${tv.template_id}::uuid, ${tv.id}::uuid, '\\x00'::bytea, 1, ${'c'.repeat(64)})
      RETURNING id`))[0]!.id as string;
    const rowA = await insertDoc(true);
    const rowB = await insertDoc(false);
    // Pre-migration state: no evidence on either row.
    await db.execute(sql`
      UPDATE contract_documents
         SET signer_name = NULL, signer_email = NULL, signed_at = NULL, signer_ip = NULL,
             signer_user_agent = NULL, acceptance_origin = NULL, acceptance_method = NULL,
             acceptance_reference = NULL, recorded_by_user_id = NULL, content_sha256 = NULL,
             content_hash_version = NULL, acceptance_render_locale = NULL
       WHERE id IN (${rowA}::uuid, ${rowB}::uuid)`);
    return { rowA, rowB, techId: tech.id };
  });
}

const docRow = async (id: string) =>
  rows(await sys(() => db.execute(sql`SELECT * FROM contract_documents WHERE id = ${id}::uuid`)))[0]!;

describe('contract_documents evidence back-fill (2026-12-31-210000)', () => {
  runDb('copies the acceptance evidence onto linked rows and leaves orphaned rows untouched', async () => {
    const { rowA, rowB, techId } = await seed();
    const warnings = await runMigrationAsAdmin();
    expect(warnings).toEqual(['backfilled signer evidence onto 1 contract_documents rows']);

    const a = await docRow(rowA);
    expect(a).toMatchObject({
      source_kind: 'quote',
      signer_name: 'Jane Doe',
      signer_email: 'jane@example.test',
      signer_ip: '203.0.113.7',
      signer_user_agent: 'UA/1',
      acceptance_origin: 'on_behalf',
      acceptance_method: 'email',
      acceptance_reference: 'PO 1',
      recorded_by_user_id: techId,
      content_sha256: QUOTE_SHA,
      content_hash_version: 2,
      acceptance_render_locale: 'fr-FR',
      agreement_request_id: null,
    });
    // quote_acceptances.signed_at is a naive UTC timestamp; the snapshot is timestamptz.
    expect(new Date(a.signed_at as string).toISOString()).toBe('2026-10-01T12:34:56.000Z');

    const b = await docRow(rowB);
    expect(b).toMatchObject({
      source_kind: 'quote',
      quote_acceptance_id: null,
      signer_name: null,
      signed_at: null,
      acceptance_origin: null,
      content_sha256: null,
      agreement_request_id: null,
    });
  });

  runDb('is idempotent: a second replay changes nothing and back-fills no row', async () => {
    const { rowA, rowB } = await seed();
    await replayMigration(MIGRATION);
    const firstA = await docRow(rowA);
    const firstB = await docRow(rowB);
    expect(firstA.signer_name).toBe('Jane Doe');

    const warnings = await runMigrationAsAdmin();
    expect(warnings).toEqual([]); // the `signed_at IS NULL` guard: nothing left to back-fill

    expect(await docRow(rowA)).toEqual(firstA);
    expect(await docRow(rowB)).toEqual(firstB);
  });
});
