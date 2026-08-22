// Content ingest runner — real-DB integration (:5433 stack, breeze_app role,
// MountedDirReader over the in-repo fixture estate). Covers the pending
// predicate, extraction/entity/project writes, snapshot idempotency,
// mtime-driven re-ingest, and tombstone exclusion. No network, no real APIs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { WorkspaceDatabase } from '../hostTypes';
import { createContentIngestService } from '../services/contentIngestService';
import { MountedDirReader } from '../content/byteReader';
import { FakeEmbedder, EMBEDDING_DIM } from '../content/embedder';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'estate');

const FILES = [
  { rel: 'Projects/2023-041 Henderson Water Main Replacement/transmittal.md', name: 'transmittal.md' },
  { rel: 'Emails/2023-041/po-4021-issued.eml', name: 'po-4021-issued.eml' },
  { rel: 'photo.jpg', name: 'photo.jpg' },
] as const;

let admin: postgres.Sql;
let app: postgres.Sql;
let partner: string, org: string, source: string;
const fileIds: Record<string, string> = {};

let appDb: ReturnType<typeof drizzle>;

/** Run fn as breeze_app inside the org's access context (mirrors withDbAccessContext set_configs). */
async function asOrg<T>(fn: (svc: ReturnType<typeof createContentIngestService>) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } })
      .session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${org}, true),
                    set_config('breeze.accessible_org_ids', ${org}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    const db = transaction as unknown as WorkspaceDatabase;
    const svc = createContentIngestService(db, {
      reader: new MountedDirReader({ [source]: FIXTURES }),
      embedder: new FakeEmbedder(), // plumbing only — never behind real search results
    });
    return fn(svc);
  });
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partner = randomUUID(); org = randomUUID(); source = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug) VALUES (${partner}, 'wsp-ingest', ${`wsp-ingest-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
              VALUES (${org}, ${partner}, 'wsp-ingest-org', ${`wsp-ingest-org-${sfx}`}, 'USD')`;
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path, visibility_group_ids)
              VALUES (${source}, ${org}, 'smb_share', 'fixture estate', '\\\\127.0.0.1\\fixtures', '[]'::jsonb)`;
  for (const f of FILES) {
    const id = randomUUID();
    fileIds[f.rel] = id;
    const parent = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
    await admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, parent_path, name, is_dir, size, mtime)
                VALUES (${id}, ${org}, ${source}, ${f.rel}, ${parent}, ${f.name}, false, 100, now())`;
  }
});

afterAll(async () => {
  for (const t of ['workspace_content_chunks', 'workspace_content_entities', 'workspace_file_enrichment', 'workspace_file_content',
    'workspace_projects', 'workspace_file_index', 'workspace_sources']) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
  }
  await admin`DELETE FROM organizations WHERE id = ${org}`;
  await admin`DELETE FROM partners WHERE id = ${partner}`;
  await admin.end(); await app.end();
});

describe('content ingest runner (real DB + fixture estate)', () => {
  it('drains pending files to zero and writes content/entities/projects', async () => {
    const first = await asOrg((svc) => svc.run(org, 2));
    expect(first.processed).toBe(2);
    expect(first.errors).toEqual([]);
    expect(first.remaining).toBeGreaterThan(0);

    const second = await asOrg((svc) => svc.run(org, 10));
    expect(second.remaining).toBe(0);
    expect(second.errors).toEqual([]);

    const status = await asOrg((svc) => svc.status(org));
    expect(status).toMatchObject({ eligible: 3, extracted: 2, skippedBinary: 1, failed: 0, pending: 0 });

    // entities from the markdown transmittal
    const mdId = fileIds[FILES[0].rel];
    const entities = await admin`SELECT entity_type, value_norm FROM workspace_content_entities
                                 WHERE file_index_id = ${mdId} ORDER BY entity_type, value_norm`;
    const byType: Record<string, string[]> = {};
    for (const e of entities) (byType[e.entity_type as string] ??= []).push(e.value_norm as string);
    expect(byType.po).toEqual(['PO 4021']);
    expect(byType.apn).toEqual(['042-330-021']);
    expect(byType.license).toEqual(['LS 4102']);
    expect(byType.invoice).toBeUndefined();

    // project registry from the declared folder
    const projects = await admin`SELECT project_key, label FROM workspace_projects WHERE org_id = ${org}`;
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ project_key: '2023-041', label: 'Henderson Water Main Replacement' });

    // email meta written deterministically on the enrichment row
    const emlId = fileIds[FILES[1].rel];
    const [enr] = await admin`SELECT email_meta FROM workspace_file_enrichment WHERE file_index_id = ${emlId}`;
    expect(enr.email_meta).toMatchObject({ subject: 'PO 4021 issued' });

    // chunks written with 1024-dim embeddings for extracted files only
    const chunks = await admin`SELECT file_index_id, chunk_index, vector_dims(embedding) AS dims
                               FROM workspace_content_chunks WHERE org_id = ${org}`;
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const ch of chunks) expect(Number(ch.dims)).toBe(EMBEDDING_DIM);
    const chunkFiles = new Set(chunks.map((ch) => ch.file_index_id as string));
    expect(chunkFiles.has(mdId)).toBe(true);
    expect(chunkFiles.has(fileIds['photo.jpg'])).toBe(false);
  });

  it('is idempotent while the snapshot is fresh and re-ingests on mtime change', async () => {
    const noop = await asOrg((svc) => svc.run(org, 10));
    expect(noop.processed).toBe(0);
    expect(noop.remaining).toBe(0);

    const mdId = fileIds[FILES[0].rel];
    await admin`UPDATE workspace_file_index SET mtime = now() + interval '1 minute' WHERE id = ${mdId}`;
    const rerun = await asOrg((svc) => svc.run(org, 10));
    expect(rerun.processed).toBe(1);
    expect(rerun.remaining).toBe(0);
  });

  it('excludes tombstoned files from pending', async () => {
    const mdId = fileIds[FILES[0].rel];
    await admin`UPDATE workspace_file_index SET deleted_at = now(), mtime = now() + interval '2 minute' WHERE id = ${mdId}`;
    const run = await asOrg((svc) => svc.run(org, 10));
    expect(run.processed).toBe(0);
    await admin`UPDATE workspace_file_index SET deleted_at = NULL WHERE id = ${mdId}`;
  });

  it('force re-sweep binds a forceSince Date against the real driver (no param-serialization crash)', async () => {
    // Regression: forceSince (the runner passes job.startedAt, a JS Date) is used
    // in the force pending predicate. Bound raw, postgres.js throws
    // ERR_INVALID_ARG_TYPE in Bind ("… Received an instance of Date"); it must be
    // serialized as an ISO ::timestamptz. A future forceSince selects every file
    // so this also exercises a real force re-read end to end.
    const future = new Date(Date.now() + 60_000);
    const run = await asOrg((svc) => svc.run(org, 10, { force: true, forceSince: future }));
    expect(run.transient).toBeNull();
    expect(run.processed).toBeGreaterThan(0);
    expect(typeof run.remaining).toBe('number');
  });

  it('treats an unreadable file as transient: aborts the batch, parks no row, stays re-ingestable', async () => {
    // W3: a byte-read failure is a source-down signal, not a bad file. The run
    // aborts the remaining batch and writes NOTHING for the unreadable file, so
    // it stays fully pending and re-ingests once the source recovers — the old
    // behavior (a parked `failed` row) would have wrongly retired it.
    const ghost = randomUUID();
    await admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, parent_path, name, is_dir, size, mtime)
                VALUES (${ghost}, ${org}, ${source}, 'missing/ghost.md', 'missing', 'ghost.md', false, 5, now())`;
    const run = await asOrg((svc) => svc.run(org, 10));
    expect(run.transient).not.toBeNull();
    expect(run.transient!.reason).toMatch(/reader:/);
    expect(run.errors).toEqual([]); // transient is reported via .transient, not .errors
    const rows = await admin`SELECT id FROM workspace_file_content WHERE file_index_id = ${ghost}`;
    expect(rows).toHaveLength(0); // no failed/blocked row parked it — still pending
    await admin`DELETE FROM workspace_file_index WHERE id = ${ghost}`;
  });
});
