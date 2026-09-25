/**
 * #4165 — org merge with an extension that owns org-scoped tables.
 *
 * `executeOrgMerge` walks `getOrgCascadeDeleteOrder()`, which folds in every
 * published extension's `tenancy.orgCascadeDeleteTables`. Before the fix the
 * merge registry had no extension hook, so with `ee/workspace` enabled every
 * merge failed ~25 s in with `no merge policy registered for
 * 'workspace_org_settings'`. The boot-time loader that publishes extension
 * tenancy never runs under vitest, so no existing suite could see it.
 *
 * This suite reproduces the production shape in-process: it applies ALL of
 * `ee/workspace`'s shipped migrations to the integration database, publishes
 * the REAL manifest's tenancy exactly as `builtinExtensions.ts` does, and runs
 * the real `executeOrgMerge` against a committed two-org fixture that
 * exercises every policy kind the manifest declares — including the colliding
 * rows (`workspace_org_settings` PK, `workspace_projects` /
 * `workspace_project_crosswalk` / active `workspace_ingest_jobs` partial
 * unique) that a plain repoint would turn into a 23505.
 *
 * FIXTURE HYGIENE. Same contract as `workspaceEnrichmentByok.integration.test.ts`
 * (read its header): `tenantCascade.integration.test.ts` enumerates every
 * `org_id` table in `public`, so any workspace table left behind reds the core
 * cascade contract for the rest of the run. This suite drops defensively in
 * `beforeAll`, drops in `afterAll`, and asserts the `public` table set is
 * exactly what it inherited.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { sql } from 'drizzle-orm';
import { parseExtensionManifestV1 } from '@breeze/extension-sdk';
import { db, withSystemDbAccessContext } from '../../db';
import { executeOrgMerge } from '../../services/orgMerge';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import {
  registerRuntimeExtensionTenancy,
  resetExtensionTenancyCacheForTests,
} from '../../extensions/tenancyRegistry';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const WORKSPACE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../../ee/workspace');
const WORKSPACE_MIGRATIONS_DIR = join(WORKSPACE_DIR, 'migrations');

const workspaceManifest = parseExtensionManifestV1(
  JSON.parse(readFileSync(join(WORKSPACE_DIR, 'manifest.json'), 'utf8')),
);

/** Every table the workspace migrations create — the drop mechanism (the guard is the snapshot). */
const WORKSPACE_TABLES = workspaceManifest.tenancy.orgCascadeDeleteTables;
const WORKSPACE_TYPES = [
  'workspace_source_kind', 'workspace_source_status', 'workspace_file_action',
  'workspace_content_status', 'workspace_filing_status', 'workspace_filing_confidence',
  'workspace_crawl_status', 'workspace_ingest_trigger', 'workspace_ingest_phase',
  'workspace_ingest_job_status',
];

async function withAdmin<T>(fn: (admin: Sql) => Promise<T>): Promise<T> {
  const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function dropWorkspaceSchema(): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.unsafe(`DROP TABLE IF EXISTS ${WORKSPACE_TABLES.join(', ')} CASCADE`);
    await admin.unsafe(`DROP TYPE IF EXISTS ${WORKSPACE_TYPES.join(', ')} CASCADE`);
  });
}

async function listPublicBaseTables(): Promise<Set<string>> {
  const rows = await withAdmin((admin) => admin<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  return new Set(rows.map((r) => r.table_name));
}

let publicTablesBefore: Set<string> | null = null;

async function q<T = Record<string, unknown>>(statement: ReturnType<typeof sql>): Promise<T[]> {
  return withSystemDbAccessContext(async () => (await db.execute(statement)) as unknown as T[]);
}

interface Fixture {
  partner: string;
  loser: string;
  survivor: string;
  actor: string;
  sourceL: string;
  sourceS: string;
  fileL: string;
  projectCollideL: string;
  projectOnlyL: string;
  crosswalkCollideL: string;
  crosswalkOnlyL: string;
  jobOrgWideL: string;
  jobSourceL: string;
  memoryL: string;
}

async function seed(): Promise<Fixture> {
  const f: Fixture = {
    partner: randomUUID(), loser: randomUUID(), survivor: randomUUID(), actor: randomUUID(),
    sourceL: randomUUID(), sourceS: randomUUID(), fileL: randomUUID(),
    projectCollideL: randomUUID(), projectOnlyL: randomUUID(),
    crosswalkCollideL: randomUUID(), crosswalkOnlyL: randomUUID(),
    jobOrgWideL: randomUUID(), jobSourceL: randomUUID(), memoryL: randomUUID(),
  };
  const sfx = f.loser.slice(0, 8);
  await withSystemDbAccessContext(async () => {
    await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${f.partner}::uuid, 'Ext Merge MSP', ${`extmerge-${sfx}`})`);
    await db.execute(sql`
      INSERT INTO organizations (id, partner_id, name, slug, status, currency_code) VALUES
        (${f.loser}::uuid,    ${f.partner}::uuid, 'Loser Co',    ${`loser-${sfx}`},    'active', 'USD'),
        (${f.survivor}::uuid, ${f.partner}::uuid, 'Survivor Co', ${`survivor-${sfx}`}, 'active', 'USD')`);
    await db.execute(sql`
      INSERT INTO users (id, email, name, partner_id, org_id)
      VALUES (${f.actor}::uuid, ${`actor-${sfx}@x.test`}, 'Actor', ${f.partner}::uuid, NULL)`);

    // keep-survivor: one settings row per org (PK org_id) — both sides have one.
    await db.execute(sql`
      INSERT INTO workspace_org_settings (org_id, content_enabled) VALUES
        (${f.loser}::uuid, true), (${f.survivor}::uuid, false)`);

    // repoint: a source + file tree hanging off it.
    await db.execute(sql`
      INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path) VALUES
        (${f.sourceL}::uuid, ${f.loser}::uuid,    'smb_share', 'L share', '\\\\l\\share'),
        (${f.sourceS}::uuid, ${f.survivor}::uuid, 'smb_share', 'S share', '\\\\s\\share')`);
    await db.execute(sql`
      INSERT INTO workspace_file_index (id, org_id, source_id, rel_path, name)
      VALUES (${f.fileL}::uuid, ${f.loser}::uuid, ${f.sourceL}::uuid, 'a/b.txt', 'b.txt')`);
    await db.execute(sql`
      INSERT INTO workspace_file_content (org_id, file_index_id, status)
      VALUES (${f.loser}::uuid, ${f.fileL}::uuid, 'extracted')`);
    await db.execute(sql`
      INSERT INTO memory_blocks (id, org_id, block_type, subject_key, content)
      VALUES (${f.memoryL}::uuid, ${f.loser}::uuid, 'fact', 'k', '{}'::jsonb)`);

    // repoint-dedupe on (project_key): one collides with the survivor, one is unique.
    await db.execute(sql`
      INSERT INTO workspace_projects (id, org_id, project_key, label) VALUES
        (${f.projectCollideL}::uuid, ${f.loser}::uuid,    'P-100', 'Loser dup'),
        (${f.projectOnlyL}::uuid,    ${f.loser}::uuid,    'P-200', 'Loser only'),
        (${randomUUID()}::uuid,      ${f.survivor}::uuid, 'P-100', 'Survivor')`);
    await db.execute(sql`
      INSERT INTO workspace_project_crosswalk (id, org_id, entity_type, value_norm, project_key) VALUES
        (${f.crosswalkCollideL}::uuid, ${f.loser}::uuid,    'po', '42', 'P-100'),
        (${f.crosswalkOnlyL}::uuid,    ${f.loser}::uuid,    'po', '43', 'P-100'),
        (${randomUUID()}::uuid,        ${f.survivor}::uuid, 'po', '42', 'P-100')`);

    // repoint-dedupe on (source_id): both orgs hold an ACTIVE org-wide job
    // (source_id NULL) — a plain repoint violates wsp_ingest_jobs_one_active_idx.
    // The loser's per-source job cannot collide and must move.
    await db.execute(sql`
      INSERT INTO workspace_ingest_jobs (id, org_id, source_id, trigger, status) VALUES
        (${f.jobOrgWideL}::uuid, ${f.loser}::uuid,    NULL,               'manual', 'pending'),
        (${f.jobSourceL}::uuid,  ${f.loser}::uuid,    ${f.sourceL}::uuid, 'manual', 'pending'),
        (${randomUUID()}::uuid,  ${f.survivor}::uuid, NULL,               'manual', 'running')`);
  });
  return f;
}

async function orgIdOf(table: string, id: string): Promise<string | null> {
  const rows = await q<{ org_id: string }>(
    sql`SELECT org_id::text AS org_id FROM ${sql.identifier(table)} WHERE id = ${id}::uuid`,
  );
  return rows[0]?.org_id ?? null;
}

describe('executeOrgMerge with extension-owned org tables (#4165)', () => {
  let priorDrain: string | undefined;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    await dropWorkspaceSchema();
    publicTablesBefore = await listPublicBaseTables();
    await withAdmin(async (admin) => {
      const files = readdirSync(WORKSPACE_MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        const content = readFileSync(join(WORKSPACE_MIGRATIONS_DIR, file), 'utf8');
        await admin.begin((tx) => tx.unsafe(content));
      }
    });
  });

  afterAll(async () => {
    resetExtensionTenancyCacheForTests();
    if (!process.env.DATABASE_URL) return;
    await dropWorkspaceSchema();
    const after = await listPublicBaseTables();
    const leaked = [...after].filter((t) => !publicTablesBefore!.has(t)).sort();
    const removed = [...publicTablesBefore!].filter((t) => !after.has(t)).sort();
    expect({ leaked, removed }).toEqual({ leaked: [], removed: [] });
  });

  beforeEach(() => {
    priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    resetExtensionTenancyCacheForTests();
  });

  afterEach(() => {
    resetExtensionTenancyCacheForTests();
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  });

  runDb('every extension table the merge walks has a policy, and every workspace table exists', async () => {
    registerRuntimeExtensionTenancy(workspaceManifest.tenancy);
    const policies = getOrgMergePolicies();
    expect(getOrgCascadeDeleteOrder().filter((t) => !policies.has(t))).toEqual([]);
    const present = await listPublicBaseTables();
    expect(WORKSPACE_TABLES.filter((t) => !present.has(t))).toEqual([]);
  });

  runDb('merges the loser\'s workspace rows into the survivor, resolving every collision', async () => {
    registerRuntimeExtensionTenancy(workspaceManifest.tenancy);
    const f = await seed();

    const result = await executeOrgMerge({
      loserOrgId: f.loser,
      survivorOrgId: f.survivor,
      partnerId: f.partner,
      performedBy: f.actor,
      performedByEmail: `actor-${f.loser.slice(0, 8)}@x.test`,
    });

    // keep-survivor: the loser's settings row is dropped; the survivor's stays.
    expect(result.summary['workspace_org_settings']).toMatchObject({ moved: 0, dropped: 1 });
    const settings = await q<{ org_id: string; content_enabled: boolean }>(sql`
      SELECT org_id::text AS org_id, content_enabled FROM workspace_org_settings
      WHERE org_id IN (${f.loser}::uuid, ${f.survivor}::uuid)`);
    expect(settings).toEqual([{ org_id: f.survivor, content_enabled: false }]);

    // repoint: the whole file tree follows its source.
    expect(await orgIdOf('workspace_sources', f.sourceL)).toBe(f.survivor);
    expect(await orgIdOf('workspace_file_index', f.fileL)).toBe(f.survivor);
    expect(await orgIdOf('memory_blocks', f.memoryL)).toBe(f.survivor);
    const content = await q<{ org_id: string }>(sql`
      SELECT org_id::text AS org_id FROM workspace_file_content WHERE file_index_id = ${f.fileL}::uuid`);
    expect(content).toEqual([{ org_id: f.survivor }]);

    // repoint-dedupe: colliding loser rows dropped, unique ones moved.
    expect(await orgIdOf('workspace_projects', f.projectCollideL)).toBeNull();
    expect(await orgIdOf('workspace_projects', f.projectOnlyL)).toBe(f.survivor);
    expect(await orgIdOf('workspace_project_crosswalk', f.crosswalkCollideL)).toBeNull();
    expect(await orgIdOf('workspace_project_crosswalk', f.crosswalkOnlyL)).toBe(f.survivor);
    expect(await orgIdOf('workspace_ingest_jobs', f.jobOrgWideL)).toBeNull();
    expect(await orgIdOf('workspace_ingest_jobs', f.jobSourceL)).toBe(f.survivor);

    // Nothing of the extension's is stranded under the dead loser org.
    for (const table of WORKSPACE_TABLES) {
      const [row] = await q<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${f.loser}::uuid`,
      );
      expect(row?.n, `${table} rows left under the loser`).toBe(0);
    }
  });

  runDb('fails closed — and rolls back — when a published extension table has no merge policy', async () => {
    // The pre-fix shape: the cascade walk includes the workspace tables but the
    // declaration carries no merge policies. The merge must refuse, never
    // guess a default, and leave the loser's rows where they were.
    const { orgMergePolicies: _omit, ...legacy } = workspaceManifest.tenancy;
    registerRuntimeExtensionTenancy(legacy);
    const f = await seed();

    await expect(executeOrgMerge({
      loserOrgId: f.loser,
      survivorOrgId: f.survivor,
      partnerId: f.partner,
      performedBy: f.actor,
      performedByEmail: `actor-${f.loser.slice(0, 8)}@x.test`,
    })).rejects.toThrow(/missing a merge policy/);

    expect(await orgIdOf('workspace_sources', f.sourceL)).toBe(f.loser);
    const [org] = await q<{ status: string }>(
      sql`SELECT status FROM organizations WHERE id = ${f.loser}::uuid`,
    );
    expect(org?.status).toBe('active');
  });
});
