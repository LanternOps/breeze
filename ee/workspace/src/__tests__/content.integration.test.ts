// Content phase (dev-preview) — migration/RLS/lifecycle integration coverage.
// Mirrors workspaceRls.integration.test.ts bootstrap (:5433 stack, breeze_app
// role, asOrg GUC scoping). Covers, per new content table:
//   - RLS shape 1: org A context can neither read nor forge org B rows
//   - migration idempotency: the SQL file re-applies cleanly on a migrated DB
//   - tombstone semantics: content/entity rows SURVIVE a soft-delete (cascade
//     only fires on hard delete) — retrieval joins are responsible for hiding
//     them (covered by the search suite)
//   - file hard-delete cascades content/entities/enrichment/filings
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

let admin: postgres.Sql;
let app: postgres.Sql;
let partnerA: string, partnerB: string, orgA: string, orgB: string;
let sourceA: string, sourceB: string, fileA: string, fileB: string;

const CONTENT_TABLES = [
  'workspace_file_content', 'workspace_content_entities', 'workspace_file_enrichment',
  'workspace_projects', 'workspace_project_crosswalk', 'workspace_email_filings',
] as const;

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  partnerA = randomUUID(); partnerB = randomUUID();
  orgA = randomUUID(); orgB = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug)
              VALUES (${partnerA}, 'wsp-content-a', ${`wsp-content-a-${sfx}`}),
                     (${partnerB}, 'wsp-content-b', ${`wsp-content-b-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug)
              VALUES (${orgA}, ${partnerA}, 'wsp-content-org-a', ${`wsp-content-org-a-${sfx}`}),
                     (${orgB}, ${partnerB}, 'wsp-content-org-b', ${`wsp-content-org-b-${sfx}`})`;
  sourceA = randomUUID(); sourceB = randomUUID();
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path)
              VALUES (${sourceA}, ${orgA}, 'smb_share', 'a share', '\\\\srv\\a'),
                     (${sourceB}, ${orgB}, 'smb_share', 'b share', '\\\\srv\\b')`;
  fileA = randomUUID(); fileB = randomUUID();
  await admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, parent_path, name)
              VALUES (${fileA}, ${orgA}, ${sourceA}, 'Projects/x/doc.md', 'Projects/x', 'doc.md'),
                     (${fileB}, ${orgB}, ${sourceB}, 'Projects/y/doc.md', 'Projects/y', 'doc.md')`;
  // Org B fixture rows (the foil the org-A context must never see).
  await admin`INSERT INTO workspace_file_content (org_id, file_index_id, status, extracted_text)
              VALUES (${orgB}, ${fileB}, 'extracted', 'org b secret text')`;
  await admin`INSERT INTO workspace_content_entities (org_id, file_index_id, entity_type, value_norm)
              VALUES (${orgB}, ${fileB}, 'po', 'PO 9999')`;
  await admin`INSERT INTO workspace_file_enrichment (org_id, file_index_id, inferred_doc_type)
              VALUES (${orgB}, ${fileB}, 'deed')`;
  await admin`INSERT INTO workspace_projects (org_id, project_key, label)
              VALUES (${orgB}, '9999-001', 'Org B Project')`;
  await admin`INSERT INTO workspace_project_crosswalk (org_id, entity_type, value_norm, project_key, evidence_count)
              VALUES (${orgB}, 'po', 'PO 9999', '9999-001', 3)`;
  await admin`INSERT INTO workspace_email_filings (org_id, file_index_id)
              VALUES (${orgB}, ${fileB})`;
});

afterAll(async () => {
  for (const t of CONTENT_TABLES) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [orgA, orgB]);
  }
  await admin`DELETE FROM workspace_file_index WHERE org_id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM workspace_sources WHERE org_id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})`;
  await admin.end(); await app.end();
});

async function asOrgA<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${orgA}, true),
                    set_config('breeze.accessible_org_ids', ${orgA}, true),
                    set_config('breeze.accessible_partner_ids', ${partnerA}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(tx);
  }) as Promise<T>;
}

describe('content migration idempotency', () => {
  it('re-applies cleanly on an already-migrated database', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(join(here, '../../migrations/2026-07-19-content.sql'), 'utf8');
    await admin.begin(async (tx) => { await tx.unsafe(sql); });
    // and again, outside a fresh transaction, to be sure
    await admin.begin(async (tx) => { await tx.unsafe(sql); });
  });
});

describe('content tables RLS (cross-tenant as breeze_app)', () => {
  it('org A context reads zero org B rows from every content table', async () => {
    for (const t of CONTENT_TABLES) {
      const rows = await asOrgA((tx) => tx.unsafe(`SELECT id FROM ${t} WHERE org_id = $1`, [orgB]));
      expect(rows, t).toHaveLength(0);
    }
  });

  it('org A context cannot forge org B rows (insert forbidden per table)', async () => {
    const inserts: Record<(typeof CONTENT_TABLES)[number], () => Promise<unknown>> = {
      workspace_file_content: () => asOrgA((tx) =>
        tx`INSERT INTO workspace_file_content (org_id, file_index_id, status) VALUES (${orgB}, ${fileB}, 'failed')`),
      workspace_content_entities: () => asOrgA((tx) =>
        tx`INSERT INTO workspace_content_entities (org_id, file_index_id, entity_type, value_norm) VALUES (${orgB}, ${fileB}, 'po', 'PO 1')`),
      workspace_file_enrichment: () => asOrgA((tx) =>
        tx`INSERT INTO workspace_file_enrichment (org_id, file_index_id) VALUES (${orgB}, ${fileB})`),
      workspace_projects: () => asOrgA((tx) =>
        tx`INSERT INTO workspace_projects (org_id, project_key, label) VALUES (${orgB}, 'x', 'x')`),
      workspace_project_crosswalk: () => asOrgA((tx) =>
        tx`INSERT INTO workspace_project_crosswalk (org_id, entity_type, value_norm, project_key) VALUES (${orgB}, 'po', 'PO 1', 'x')`),
      workspace_email_filings: () => asOrgA((tx) =>
        tx`INSERT INTO workspace_email_filings (org_id, file_index_id) VALUES (${orgB}, ${fileB})`),
    };
    for (const t of CONTENT_TABLES) {
      await expect(inserts[t](), t).rejects.toThrow(
        new RegExp(`row-level security policy for table "${t}"`),
      );
    }
  });

  it('org A can write and read back its own content rows', async () => {
    await asOrgA(async (tx) => {
      await tx`INSERT INTO workspace_file_content (org_id, file_index_id, status, extracted_text, content_hash, source_size)
               VALUES (${orgA}, ${fileA}, 'extracted', 'the quick brown fox', 'abc123', 19)`;
      await tx`INSERT INTO workspace_content_entities (org_id, file_index_id, entity_type, value_norm)
               VALUES (${orgA}, ${fileA}, 'apn', '057-071-012')`;
    });
    const rows = await asOrgA((tx) =>
      tx`SELECT extracted_text FROM workspace_file_content WHERE file_index_id = ${fileA}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].extracted_text).toBe('the quick brown fox');
  });
});

describe('lifecycle: tombstone vs hard delete', () => {
  it('soft-delete (tombstone) leaves content and entity rows in place', async () => {
    await admin`UPDATE workspace_file_index SET deleted_at = now() WHERE id = ${fileA}`;
    const content = await admin`SELECT id FROM workspace_file_content WHERE file_index_id = ${fileA}`;
    const entities = await admin`SELECT id FROM workspace_content_entities WHERE file_index_id = ${fileA}`;
    expect(content).toHaveLength(1);
    expect(entities).toHaveLength(1);
    // resurrect for the next test
    await admin`UPDATE workspace_file_index SET deleted_at = NULL WHERE id = ${fileA}`;
  });

  it('hard delete of the file cascades content/entities/enrichment/filings', async () => {
    await admin`INSERT INTO workspace_file_enrichment (org_id, file_index_id, inferred_doc_type)
                VALUES (${orgA}, ${fileA}, 'memo')`;
    await admin`INSERT INTO workspace_email_filings (org_id, file_index_id) VALUES (${orgA}, ${fileA})`;
    await admin`DELETE FROM workspace_file_index WHERE id = ${fileA}`;
    for (const t of ['workspace_file_content', 'workspace_content_entities', 'workspace_file_enrichment', 'workspace_email_filings']) {
      const rows = await admin.unsafe(`SELECT id FROM ${t} WHERE file_index_id = $1`, [fileA]);
      expect(rows, t).toHaveLength(0);
    }
  });
});
