// Force-sweep convergence — real-DB integration (:5433 stack, breeze_app role).
//
// Regression for the estate-sized-batch bug: contentIngestService.run reported
// `remaining` via the NON-force snapshot count, which is already 0 for an
// already-extracted estate. A force sweep over MORE files than the batch size
// therefore re-walked only the first batch and reported remaining=0, so the job
// runner phase-completed after visiting a fraction of the estate — retrying
// could never advance. The fix returns a FORCE-AWARE remaining: the count of
// eligible files not yet refreshed at/after forceSince this sweep, which drains
// to 0 exactly when the whole estate has been re-walked.
//
// Harness mirrors the ingest/dlp integration suites: seed via breeze_test, run
// via breeze_app under the org access context, in-memory reader + FakeEmbedder.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { WorkspaceDatabase } from '../hostTypes';
import { createContentIngestService } from '../services/contentIngestService';
import { FakeEmbedder } from '../content/embedder';
import type { ContentByteReader, ContentSourceRef } from '../content/byteReader';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

// A five-file estate driven with batch=2 — deliberately larger than one batch,
// the case the non-force snapshot count masked.
const RELS = [
  'Projects/A/one.md',
  'Projects/A/two.md',
  'Projects/B/three.md',
  'Projects/B/four.md',
  'Projects/C/five.md',
];
const BATCH = 2;
const files: Record<string, string> = Object.fromEntries(
  RELS.map((rel, i) => [rel, `Document ${i}. PO ${4000 + i} covers the work. Body text for ${rel}.`]),
);

// DLP off for every detector — this suite is about sweep convergence, not DLP.
const DLP_CONFIG = {
  detectors: { credit_card: 'off', ssn: 'off', iban: 'off', api_key: 'off', email: 'off', phone: 'off' },
  customPatterns: [],
};

class MapReader implements ContentByteReader {
  constructor(private readonly map: Record<string, string>) {}
  async read(_source: ContentSourceRef, relPath: string): Promise<Buffer> {
    const body = this.map[relPath];
    if (body === undefined) throw new Error(`no fixture for ${relPath}`);
    return Buffer.from(body, 'utf8');
  }
}

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partner: string, org: string, source: string;
const fileIds: Record<string, string> = {};

async function withOrgTx<T>(fn: (db: WorkspaceDatabase) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } }).session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${org}, true),
                    set_config('breeze.accessible_org_ids', ${org}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(transaction as unknown as WorkspaceDatabase);
  });
}

function run(batch: number, opts?: { force?: boolean; forceSince?: Date }) {
  return withOrgTx((db) => createContentIngestService(db, {
    reader: new MapReader(files),
    embedder: new FakeEmbedder(), // plumbing only
  }).run(org, batch, opts));
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partner = randomUUID(); org = randomUUID(); source = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug) VALUES (${partner}, 'wsp-force', ${`wsp-force-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug)
              VALUES (${org}, ${partner}, 'wsp-force-org', ${`wsp-force-org-${sfx}`})`;
  await admin`INSERT INTO workspace_org_settings (org_id, content_enabled, dlp_config)
              VALUES (${org}, true, ${JSON.stringify(DLP_CONFIG)}::jsonb)`;
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path, visibility_group_ids)
              VALUES (${source}, ${org}, 'smb_share', 'force estate', '\\\\127.0.0.1\\force', '[]'::jsonb)`;
  for (const rel of RELS) {
    const id = randomUUID();
    fileIds[rel] = id;
    const parent = rel.slice(0, rel.lastIndexOf('/'));
    const name = rel.split('/').pop()!;
    await admin`INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime)
                VALUES (${id}, ${org}, ${source}, ${rel}, ${parent}, ${name}, false, 'md', 100, now())`;
  }
});

afterAll(async () => {
  for (const t of ['workspace_content_chunks', 'workspace_content_entities', 'workspace_file_enrichment',
    'workspace_file_content', 'workspace_projects', 'workspace_file_index', 'workspace_sources',
    'workspace_org_settings']) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
  }
  await admin`DELETE FROM organizations WHERE id = ${org}`;
  await admin`DELETE FROM partners WHERE id = ${partner}`;
  await admin.end(); await app.end();
});

describe('force-sweep convergence across a multi-batch estate (real DB)', () => {
  it('a repeated force sweep re-walks EVERY file, decreasing remaining monotonically to 0', async () => {
    // 1. Non-force drain: all five files become extracted in one pass.
    const seeded = await run(50);
    expect(seeded.errors).toEqual([]);
    expect(seeded.processed).toBe(5);
    expect(seeded.remaining).toBe(0);

    // 2. forceSince = a DB-clock instant AFTER the initial extract, so every
    //    file's stored updated_at is strictly earlier (mirrors the job runner
    //    passing the job's DB-sourced started_at). DB-sourced to avoid any
    //    app-vs-DB clock skew.
    const [{ now }] = await admin`SELECT now() AS now` as unknown as Array<{ now: Date }>;
    const forceSince = new Date(now);

    // 3. Drive batch=2 force sweeps to convergence. Before the fix, the FIRST
    //    sweep already reported remaining=0 (non-force snapshot count) after
    //    touching only two files, and the loop terminated early.
    const remainings: number[] = [];
    let visited = 0;
    let guard = 0;
    for (;;) {
      if (guard++ > 20) throw new Error('force sweep failed to converge');
      const r = await run(BATCH, { force: true, forceSince });
      expect(r.errors).toEqual([]);
      expect(r.transient).toBeNull();
      remainings.push(r.remaining);
      visited += r.processed;
      if (r.remaining === 0) break;
      // Each non-final sweep must make progress, or it would loop forever.
      expect(r.processed).toBeGreaterThan(0);
    }

    // remaining decreased monotonically (non-increasing) and reached 0. With
    // five files and batch=2 the sequence is [3, 1, 0].
    expect(remainings[remainings.length - 1]).toBe(0);
    for (let i = 1; i < remainings.length; i += 1) {
      expect(remainings[i]).toBeLessThan(remainings[i - 1]);
    }
    // The sweep visited more files than a single batch — it did NOT stop early.
    expect(visited).toBeGreaterThan(BATCH);

    // 4. Every eligible file's content row was re-walked this sweep: its
    //    updated_at is at/after forceSince.
    const stale = await admin`
      SELECT count(*)::int AS n
      FROM workspace_file_content c
      JOIN workspace_file_index fi ON fi.id = c.file_index_id
      WHERE c.org_id = ${org} AND fi.deleted_at IS NULL AND fi.is_dir = false
        AND c.updated_at < ${forceSince.toISOString()}::timestamptz` as unknown as Array<{ n: number }>;
    expect(stale[0].n).toBe(0);
  });
});
