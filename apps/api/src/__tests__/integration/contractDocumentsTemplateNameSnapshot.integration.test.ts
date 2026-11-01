/**
 * Back-fill proof for contract_documents.template_name_snapshot (#10294
 * follow-up): the template name frozen at signing, so a later rename never
 * changes a signed agreement's certificate.
 *
 * The migration runs AFTER 2027-01-06-170000 made contract_documents
 * append-only, so its back-fill has to lift contract_documents_block_update
 * itself (the guard compares whole rows, new columns included). This suite runs
 * the file the way autoMigrate does — as the table owner, with the guard ON —
 * against a pre-existing signed row, and proves the guard is back on after.
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
import { createOrganization, createPartner } from './db-utils';

const MIGRATION = '2027-01-18-164000-contract-documents-template-name-snapshot.sql.sql';
const runDb = it.runIf(!!process.env.DATABASE_URL);

type Row = Record<string, unknown>;
const rows = (r: unknown) => r as unknown as Row[];
const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: (n) => { notices.push(String(n.message)); } });
afterAll(async () => {
  // A failed run must not leave the evidence guard off for later suites.
  await adminSql`ALTER TABLE contract_documents ENABLE TRIGGER contract_documents_block_update`;
  await adminSql.end({ timeout: 5 });
});

async function runMigrationAsOwner(): Promise<string[]> {
  const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
  notices.length = 0;
  // One transaction, as autoMigrate wraps each file.
  await adminSql.begin((tx) => tx.unsafe(migrationSql));
  return notices.filter((m) => m.startsWith('contract_documents.template_name_snapshot'));
}

async function guardState(): Promise<string | undefined> {
  const [t] = await adminSql`
    SELECT tgenabled FROM pg_trigger
     WHERE tgrelid = 'contract_documents'::regclass AND tgname = 'contract_documents_block_update'`;
  return t?.tgenabled as string | undefined;
}

/** A signed agreement written before the snapshot column existed (NULL). */
async function seed(templateName: string) {
  return sys(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const tv = rows(await db.execute(sql`
      WITH t AS (
        INSERT INTO contract_templates (org_id, name) VALUES (${org.id}::uuid, ${templateName}) RETURNING id
      )
      INSERT INTO contract_template_versions
        (template_id, org_id, version_number, status, source_type, body_html, sha256, declared_variables, published_at)
      SELECT t.id, ${org.id}::uuid, 1, 'published', 'authored', '<p>BAA</p>', ${'b'.repeat(64)}, '[]'::jsonb, now() FROM t
      RETURNING template_id, id`))[0]!;
    const docId = rows(await db.execute(sql`
      INSERT INTO contract_documents (org_id, template_id, template_version_id, pdf_data, byte_size, sha256)
      VALUES (${org.id}::uuid, ${tv.template_id}::uuid, ${tv.id}::uuid, '\\x00'::bytea, 1, ${'c'.repeat(64)})
      RETURNING id`))[0]!.id as string;
    return { docId, templateId: tv.template_id as string };
  });
}

const snapshotOf = async (id: string) =>
  rows(await sys(() => db.execute(sql`SELECT template_name_snapshot FROM contract_documents WHERE id = ${id}::uuid`)))[0]!
    .template_name_snapshot;

describe('contract_documents.template_name_snapshot back-fill (#10294)', () => {
  runDb('back-fills an existing signed row with the guard ON, and leaves the guard enabled', async () => {
    const { docId } = await seed('Business Associate Agreement');
    expect(await snapshotOf(docId)).toBeNull();
    expect(await guardState()).toBe('O');

    expect(await runMigrationAsOwner()).toEqual(['contract_documents.template_name_snapshot backfilled on 1 row(s)']);
    expect(await snapshotOf(docId)).toBe('Business Associate Agreement');
    expect(await guardState()).toBe('O');
  });

  runDb('once back-filled, a template rename never reaches the snapshot, and a re-run changes nothing', async () => {
    const { docId, templateId } = await seed('Original BAA');
    await runMigrationAsOwner();
    await sys(() => db.execute(sql`UPDATE contract_templates SET name = 'Renamed BAA' WHERE id = ${templateId}::uuid`));

    expect(await runMigrationAsOwner()).toEqual(['contract_documents.template_name_snapshot backfilled on 0 row(s)']);
    expect(await snapshotOf(docId)).toBe('Original BAA');
    expect(await guardState()).toBe('O');
  });

  runDb('the snapshot is evidence: the append-only guard refuses rewriting it (55000)', async () => {
    const { docId } = await seed('Frozen BAA');
    await runMigrationAsOwner();
    await expect(adminSql`UPDATE contract_documents SET template_name_snapshot = 'Rewritten' WHERE id = ${docId}::uuid`)
      .rejects.toMatchObject({ code: '55000' });
  });
});
