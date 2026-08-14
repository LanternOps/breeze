// W3 Task 6: dashboardService.summary — real-DB integration (:5433 stack,
// breeze_app role). Seeds one org with two sources (one grouped — proves the
// org-operator-scope decision: the dashboard counts grouped sources, unlike
// every visibility-scoped helper read), a full spread of content statuses
// (incl. blocked_dlp), an enrichment gap, chunks, a mixed filing pool (incl.
// one declared-path email that must be EXCLUDED), activity, a project +
// crosswalk, and one ingest job — then asserts summary() numbers against the
// seed arithmetic by hand. A second org proves the RLS probe: querying org
// A's id from org B's session context reads back an all-zero summary, not an
// error and not org A's data (silent-0-row RLS, same idiom as
// ingestJobs.integration.test.ts / visibilityIntersection.integration.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { WorkspaceDatabase } from '../hostTypes';
import type { ContentByteReader } from '../content/byteReader';
import { createContentIngestService } from '../services/contentIngestService';
import { createDashboardService } from '../services/dashboardService';
import { createIngestJobsService } from '../services/ingestJobsService';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partnerA: string, partnerB: string, orgA: string, orgB: string;
let source1: string, source2: string;
let runRunning: string, runComplete: string;
let jobId: string;
const ids: Record<string, string> = {};

const FIXED_SIZE = 1000;
const FIXED_MTIME = new Date('2026-07-10T00:00:00Z');

// Never actually read: status()/summary() do not touch bytes.
const stubReader: ContentByteReader = { read: async () => { throw new Error('unused in this suite'); } };

/** Run fn as breeze_app inside the given org's access context (mirrors withDbAccessContext). */
async function withOrg<T>(org: string, partner: string, fn: (db: WorkspaceDatabase) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } }).session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${org}, true),
                    set_config('breeze.accessible_org_ids', ${org}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(transaction as unknown as WorkspaceDatabase);
  }) as Promise<T>;
}

function dashboardFor(db: WorkspaceDatabase) {
  const contentIngest = createContentIngestService(db, { reader: stubReader });
  return createDashboardService(db, { contentIngestStatus: (orgId) => contentIngest.status(orgId) });
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);

  partnerA = randomUUID(); partnerB = randomUUID();
  orgA = randomUUID(); orgB = randomUUID();
  source1 = randomUUID(); source2 = randomUUID();
  runRunning = randomUUID(); runComplete = randomUUID();
  jobId = randomUUID();
  const sfx = randomUUID();

  await admin`INSERT INTO partners (id, name, slug)
              VALUES (${partnerA}, 'wsp-dash-a', ${`wsp-dash-a-${sfx}`}),
                     (${partnerB}, 'wsp-dash-b', ${`wsp-dash-b-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug)
              VALUES (${orgA}, ${partnerA}, 'wsp-dash-org-a', ${`wsp-dash-org-a-${sfx}`}),
                     (${orgB}, ${partnerB}, 'wsp-dash-org-b', ${`wsp-dash-org-b-${sfx}`})`;

  // Two sources: source1 ungrouped+active (content-eligible), source2
  // GROUPED — the org-operator-scope pin: the sources card must still count
  // it, unlike every visibility-scoped helper read.
  await admin`INSERT INTO workspace_sources
                (id, org_id, kind, display_name, root_path, visibility_group_ids, status, last_complete_run_at)
              VALUES
                (${source1}, ${orgA}, 'smb_share', 'Alpha SMB', '\\\\srv\\alpha', '[]'::jsonb, 'active',
                 '2026-07-15T00:00:00Z'),
                (${source2}, ${orgA}, 'smb_share', 'Bravo Grouped', '\\\\srv\\bravo', '["g1"]'::jsonb, 'active', NULL)`;

  // A running crawl run (must surface as activeRun) and a completed one
  // (must NOT — only status='running' qualifies).
  await admin`INSERT INTO workspace_crawl_runs (id, org_id, source_id, status, started_at)
              VALUES (${runRunning}, ${orgA}, ${source1}, 'running', now() - interval '30 minutes'),
                     (${runComplete}, ${orgA}, ${source1}, 'complete', now() - interval '2 hours')`;

  // File spread under source1: content-status coverage (f1..f6), a live dir
  // (f7), a tombstoned file (f8, excluded everywhere), and the filing pool
  // (f9..f13, one of which — f13 — DECLARES a project via its path and must
  // be excluded from every filing count).
  const fileRows: Array<{
    key: string; relPath: string; isDir?: boolean; deleted?: boolean; lastSeenAt?: string;
  }> = [
    { key: 'f1', relPath: 'Docs/f1.md', lastSeenAt: '2026-07-19T01:00:00Z' },
    { key: 'f2', relPath: 'Docs/f2.md', lastSeenAt: '2026-07-19T02:00:00Z' }, // newest live row
    { key: 'f3', relPath: 'Docs/f3.md', lastSeenAt: '2026-07-19T00:30:00Z' },
    { key: 'f4', relPath: 'Docs/f4.pdf', lastSeenAt: '2026-07-19T00:20:00Z' },
    { key: 'f5', relPath: 'Docs/f5.jpg', lastSeenAt: '2026-07-19T00:10:00Z' },
    { key: 'f6', relPath: 'Docs/f6.md', lastSeenAt: '2026-07-19T00:05:00Z' },
    // newestSeenAt spans ALL live rows, not just files — give the dir a seen
    // time older than f2 so it doesn't accidentally become "newest" via the
    // now()-defaulted fallback below.
    { key: 'f7', relPath: 'Docs', isDir: true, lastSeenAt: '2026-07-19T00:15:00Z' },
    { key: 'f8', relPath: 'Docs/gone.md', deleted: true },
    // f9-f13 are live rows too — every lastSeenAt below stays older than f2's
    // so newestSeenAt has exactly one candidate.
    { key: 'f9', relPath: 'Unfiled/none.eml', lastSeenAt: '2026-07-19T00:04:00Z' },
    { key: 'f10', relPath: 'Unfiled/suggested.eml', lastSeenAt: '2026-07-19T00:03:00Z' },
    { key: 'f11', relPath: 'Unfiled/confirmed.eml', lastSeenAt: '2026-07-19T00:02:00Z' },
    { key: 'f12', relPath: 'Unfiled/reassigned.eml', lastSeenAt: '2026-07-19T00:01:00Z' },
    { key: 'f13', relPath: 'Projects/2023-041 Henderson/note.eml', lastSeenAt: '2026-07-19T00:00:30Z' },
  ];
  for (const f of fileRows) {
    const id = randomUUID();
    ids[f.key] = id;
    const name = f.relPath.split('/').pop()!;
    const parent = f.relPath.includes('/') ? f.relPath.slice(0, f.relPath.lastIndexOf('/')) : '';
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : null;
    const size = f.isDir ? null : FIXED_SIZE;
    const mtime = f.isDir ? null : FIXED_MTIME;
    await admin`INSERT INTO workspace_file_index
        (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime, last_seen_at, deleted_at)
        VALUES (${id}, ${orgA}, ${source1}, ${f.relPath}, ${parent}, ${name}, ${f.isDir ?? false}, ${ext},
                ${size}, ${mtime}, ${f.lastSeenAt ? new Date(f.lastSeenAt) : new Date()},
                ${f.deleted ? new Date() : null})`;
  }
  // source2's single (grouped) file — proves the sources card counts it.
  const g1 = randomUUID();
  ids.g1 = g1;
  await admin`INSERT INTO workspace_file_index
      (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime, last_seen_at)
      VALUES (${g1}, ${orgA}, ${source2}, 'GroupDocs/g1.md', 'GroupDocs', 'g1.md', false, 'md', 500,
              ${FIXED_MTIME}, '2026-07-19T03:00:00Z')`;

  // Content rows: two extracted (f1 enriched, f2 not — enrichPending pin),
  // one of each failure/skip mode, one blocked_dlp. Snapshots match the file
  // rows exactly so none of these six is "pending" (only f9-f13 are).
  await admin`INSERT INTO workspace_file_content
      (org_id, file_index_id, content_hash, source_size, source_mtime, extracted_text, status)
      VALUES
        (${orgA}, ${ids.f1}, 'hash-f1', ${FIXED_SIZE}, ${FIXED_MTIME}, 'body one', 'extracted'),
        (${orgA}, ${ids.f2}, 'hash-f2', ${FIXED_SIZE}, ${FIXED_MTIME}, 'body two', 'extracted'),
        (${orgA}, ${ids.f3}, NULL, ${FIXED_SIZE}, ${FIXED_MTIME}, NULL, 'failed'),
        (${orgA}, ${ids.f4}, NULL, ${FIXED_SIZE}, ${FIXED_MTIME}, NULL, 'skipped_too_large'),
        (${orgA}, ${ids.f5}, NULL, ${FIXED_SIZE}, ${FIXED_MTIME}, NULL, 'skipped_binary'),
        (${orgA}, ${ids.f6}, NULL, ${FIXED_SIZE}, ${FIXED_MTIME}, NULL, 'blocked_dlp')`;

  // f1 is enriched (model set); f2 deliberately is not → enrichPending pins to 1.
  await admin`INSERT INTO workspace_file_enrichment (org_id, file_index_id, model, enriched_at)
              VALUES (${orgA}, ${ids.f1}, 'claude-haiku-4-5', now())`;

  // Three chunks, all on f1.
  await admin`INSERT INTO workspace_content_chunks (org_id, file_index_id, chunk_index, text)
              VALUES (${orgA}, ${ids.f1}, 0, 'chunk 0'),
                     (${orgA}, ${ids.f1}, 1, 'chunk 1'),
                     (${orgA}, ${ids.f1}, 2, 'chunk 2')`;

  // Filing pool: f9 untouched, f10 suggested+high-confidence, f11 confirmed,
  // f12 reassigned. f13 (declared path) gets NO filing row and must never
  // appear in any filing count regardless.
  await admin`INSERT INTO workspace_email_filings
      (org_id, file_index_id, status, suggested_project_key, suggested_project_label, confidence,
       decided_project_key)
      VALUES
        (${orgA}, ${ids.f10}, 'suggested', '2023-041', 'Henderson', 'high', NULL),
        (${orgA}, ${ids.f11}, 'confirmed', '2023-041', 'Henderson', 'low', '2023-041'),
        (${orgA}, ${ids.f12}, 'reassigned', '2023-099', 'Other Job', 'low', '2023-041')`;

  // Project + crosswalk.
  await admin`INSERT INTO workspace_projects (org_id, project_key, label)
              VALUES (${orgA}, '2023-041', 'Henderson')`;
  await admin`INSERT INTO workspace_project_crosswalk
      (org_id, entity_type, value_norm, project_key, project_label, evidence_count)
      VALUES (${orgA}, 'po', 'PO 1', '2023-041', 'Henderson', 3),
             (${orgA}, 'invoice', 'INV 9', '2023-041', 'Henderson', 2)`;

  // Activity: f1 has two events (one within the 7-day window, one outside —
  // pins the events7d filter without moving last_activity_at); f2 has one,
  // strictly older than f1's most recent, pinning the recency ORDER BY.
  await admin`INSERT INTO workspace_file_activity (org_id, file_index_id, action, created_at)
              VALUES (${orgA}, ${ids.f1}, 'open', now() - interval '1 day'),
                     (${orgA}, ${ids.f1}, 'open', now() - interval '10 days'),
                     (${orgA}, ${ids.f2}, 'open', now() - interval '2 days')`;

  // One ingest job — GET /dashboard/jobs is a thin proxy over
  // ingestJobsService.list, exercised directly against real PG here.
  await admin`INSERT INTO workspace_ingest_jobs (id, org_id, source_id, trigger, status)
              VALUES (${jobId}, ${orgA}, ${source1}, 'manual', 'pending')`;
});

afterAll(async () => {
  await admin`DELETE FROM workspace_project_crosswalk WHERE org_id = ${orgA}`;
  await admin`DELETE FROM workspace_projects WHERE org_id = ${orgA}`;
  // Cascades away file_index, file_content, entities, enrichment, chunks,
  // email_filings, file_activity, crawl_runs, and ingest_jobs.
  await admin`DELETE FROM workspace_sources WHERE org_id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
  await admin`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})`;
  await admin.end(); await app.end();
});

describe('dashboardService.summary (W3 Task 6, real PG as breeze_app)', () => {
  it('sources: counts BOTH sources including the grouped one (org-operator scope)', async () => {
    const { sources } = await withOrg(orgA, partnerA, (db) => dashboardFor(db).summary(orgA));

    expect(sources).toHaveLength(2);
    const bySourceId = new Map(sources.map((s) => [s.id, s]));

    const alpha = bySourceId.get(source1)!;
    expect(alpha).toMatchObject({
      name: 'Alpha SMB', kind: 'smb_share', status: 'active',
      lastCompleteRunAt: '2026-07-15T00:00:00.000Z',
      liveFiles: 11, liveDirs: 1, tombstoned: 1,
      newestSeenAt: '2026-07-19T02:00:00.000Z',
    });
    expect(alpha.activeRun).toMatchObject({ id: runRunning, status: 'running' });
    expect(alpha.activeRun?.id).not.toBe(runComplete);

    // The grouped source — this is the pin: it IS present and counted.
    const bravo = bySourceId.get(source2)!;
    expect(bravo).toMatchObject({
      name: 'Bravo Grouped', kind: 'smb_share', status: 'active',
      lastCompleteRunAt: null, liveFiles: 1, liveDirs: 0, tombstoned: 0,
      newestSeenAt: '2026-07-19T03:00:00.000Z', activeRun: null,
    });
  });

  it('ingest: eligible/status counts (incl. blockedDlp), pending, enrichPending, chunks', async () => {
    const { ingest } = await withOrg(orgA, partnerA, (db) => dashboardFor(db).summary(orgA));

    // eligible = source1's live non-dir files only (source2 is grouped, excluded
    // from the ingest-eligibility predicate): f1..f6, f9..f13 = 11.
    expect(ingest.eligible).toBe(11);
    expect(ingest.extracted).toBe(2);
    expect(ingest.failed).toBe(1);
    expect(ingest.skippedTooLarge).toBe(1);
    expect(ingest.skippedBinary).toBe(1);
    expect(ingest.blockedDlp).toBe(1);
    // pending = eligible files with no matching content snapshot: f9..f13 (5).
    expect(ingest.pending).toBe(5);
    expect(ingest.enrichPending).toBe(1); // f2 only
    expect(ingest.chunks).toBe(3);
  });

  it('filing: unfiled/suggested/confirmed/reassigned/highConfidence partition; declared path excluded', async () => {
    const { filing } = await withOrg(orgA, partnerA, (db) => dashboardFor(db).summary(orgA));

    // Pool = f9 (untouched) + f10 (suggested) — both still undecided.
    expect(filing.unfiled).toBe(2);
    expect(filing.suggested).toBe(1);
    expect(filing.confirmed).toBe(1);
    expect(filing.reassigned).toBe(1);
    expect(filing.highConfidence).toBe(1);

    expect(filing.queue).toHaveLength(2);
    const byId = new Map(filing.queue.map((q) => [q.id, q]));
    expect(byId.get(ids.f9)).toMatchObject({ relPath: 'Unfiled/none.eml', suggestedProjectLabel: null, confidence: null });
    expect(byId.get(ids.f10)).toMatchObject({ relPath: 'Unfiled/suggested.eml', suggestedProjectLabel: 'Henderson', confidence: 'high' });
    // f13 (declared path) must never appear, in the queue or the counts.
    expect(byId.has(ids.f13)).toBe(false);
  });

  it('activity: top-15 by recency with 7-day event counts, org-wide', async () => {
    const { activity } = await withOrg(orgA, partnerA, (db) => dashboardFor(db).summary(orgA));

    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ fileIndexId: ids.f1, events7d: 1 }); // 1-day-ago event only
    expect(activity[1]).toMatchObject({ fileIndexId: ids.f2, events7d: 1 });
    expect(new Date(activity[0].lastActivityAt).getTime()).toBeGreaterThan(new Date(activity[1].lastActivityAt).getTime());
  });

  it('projects: filed (confirmed+suggested, not reassigned), crosswalk rows, summed evidence', async () => {
    const { projects } = await withOrg(orgA, partnerA, (db) => dashboardFor(db).summary(orgA));

    expect(projects).toEqual([
      { projectKey: '2023-041', label: 'Henderson', filedEmails: 2, crosswalkEntities: 2, evidenceFiles: 5 },
    ]);
  });

  it('generatedAt is a DB-clock ISO timestamp', async () => {
    const before = Date.now();
    const { generatedAt } = await withOrg(orgA, partnerA, (db) => dashboardFor(db).summary(orgA));
    const ts = new Date(generatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 60_000); // sanity bound, not host-clock equality
    expect(ts).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('ingestJobsService.list surfaces the seeded job (dashboard/jobs proxy target)', async () => {
    const jobs = await withOrg(orgA, partnerA, (db) => createIngestJobsService(db).list(orgA));
    expect(jobs.map((j) => j.id)).toContain(jobId);
  });

  it('RLS probe: org B session reading org A\'s id gets an all-zero summary, not org A\'s data', async () => {
    const summary = await withOrg(orgB, partnerB, (db) => dashboardFor(db).summary(orgA));

    expect(summary.sources).toEqual([]);
    expect(summary.ingest).toEqual({
      eligible: 0, extracted: 0, failed: 0, skippedTooLarge: 0, skippedBinary: 0,
      blockedDlp: 0, pending: 0, enrichPending: 0, chunks: 0,
    });
    expect(summary.filing).toEqual({
      unfiled: 0, suggested: 0, confirmed: 0, reassigned: 0, highConfidence: 0, queue: [],
    });
    expect(summary.activity).toEqual([]);
    expect(summary.projects).toEqual([]);
  });
});
