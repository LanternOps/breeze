// W3 Task 6: admin dashboard read model. ADMIN/org-operator scope — every
// query here reads the WHOLE org (all sources, incl. grouped ones) and
// deliberately does NOT thread visibleSourcePredicateSql/groupIds through:
// an org operator manages the estate, not a slice of it (see the Global
// Constraints note on the sources card and dashboard.integration.test.ts's
// grouped-source pin).
//
// Every card is a single round-trip query (no N+1); summary() fans them out
// with Promise.all, mirroring contentIngestService.status()'s existing
// concurrent-execute() pattern on the same request-scoped handle. The one
// exception is the filing card: "declared project" is derived from rel_path
// in JS (content/projects.ts), so that predicate can't live in SQL — the
// query fetches the full eml/live/undeclared-candidate set and the pool
// filter + unfiled/suggested/confirmed/reassigned partition + queue cap all
// happen in JS, exactly like filingService.unfiledEmails.
//
// generatedAt is read from the DATABASE clock (SELECT now()), never
// `new Date()` — Global Constraints: timestamps/comparisons use the DB
// clock, never host clocks.
import type { WorkspaceDatabase } from '../hostTypes';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { deriveDeclaredProject } from '../content/projects';
import type { IngestStatus } from './contentIngestService';

export interface DashboardSummary {
  sources: Array<{
    id: string; name: string; kind: string; status: string;
    lastCompleteRunAt: string | null; liveFiles: number; liveDirs: number;
    tombstoned: number; newestSeenAt: string | null;
    activeRun: { id: string; status: string; startedAt: string; stats: unknown } | null;
  }>;
  ingest: {
    eligible: number; extracted: number; failed: number; skippedTooLarge: number;
    skippedBinary: number; blockedDlp: number; pending: number;
    enrichPending: number; chunks: number;
  };
  filing: {
    unfiled: number; suggested: number; confirmed: number; reassigned: number;
    highConfidence: number;
    queue: Array<{
      id: string; name: string; relPath: string;
      suggestedProjectLabel: string | null; confidence: string | null;
    }>;
  };
  activity: Array<{
    fileIndexId: string; name: string; relPath: string;
    lastActivityAt: string; events7d: number;
  }>;
  projects: Array<{
    projectKey: string; label: string; filedEmails: number;
    crosswalkEntities: number; evidenceFiles: number;
  }>;
  generatedAt: string;
}

export interface DashboardServiceDeps {
  contentIngestStatus(orgId: string): Promise<IngestStatus>;
}

interface SourceRow {
  id: string; display_name: string; kind: string; status: string;
  last_complete_run_at: string | Date | null;
  live_files: number | string; live_dirs: number | string; tombstoned: number | string;
  newest_seen_at: string | Date | null;
  active_run_id: string | null; active_run_status: string | null;
  active_run_started_at: string | Date | null; active_run_stats: unknown;
}

interface UnfiledCandidateRow {
  id: string; rel_path: string; name: string;
  status: 'suggested' | 'confirmed' | 'reassigned' | null;
  suggested_project_label: string | null;
  confidence: string | null;
}

interface ActivityRow {
  file_index_id: string; name: string; rel_path: string;
  last_activity_at: string | Date; events_7d: number | string;
}

interface ProjectRow {
  project_key: string; label: string;
  filed_emails: number | string; crosswalk_entities: number | string; evidence_files: number | string;
}

function toIsoOrNull(v: string | Date | null): string | null {
  return v === null ? null : new Date(v).toISOString();
}

export function createDashboardService(db: WorkspaceDatabase, deps: DashboardServiceDeps) {
  const d = db;

  async function sourcesCard(orgId: string): Promise<DashboardSummary['sources']> {
    const rows = await d.execute(sql`
      SELECT s.id, s.display_name, s.kind, s.status, s.last_complete_run_at,
             COALESCE(fc.live_files, 0)::int AS live_files,
             COALESCE(fc.live_dirs, 0)::int AS live_dirs,
             COALESCE(fc.tombstoned, 0)::int AS tombstoned,
             fc.newest_seen_at,
             ar.id AS active_run_id, ar.status AS active_run_status,
             ar.started_at AS active_run_started_at, ar.stats AS active_run_stats
      FROM workspace_sources s
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE fi.deleted_at IS NULL AND NOT fi.is_dir) AS live_files,
          COUNT(*) FILTER (WHERE fi.deleted_at IS NULL AND fi.is_dir) AS live_dirs,
          COUNT(*) FILTER (WHERE fi.deleted_at IS NOT NULL) AS tombstoned,
          MAX(fi.last_seen_at) FILTER (WHERE fi.deleted_at IS NULL) AS newest_seen_at
        FROM workspace_file_index fi
        WHERE fi.org_id = s.org_id AND fi.source_id = s.id
      ) fc ON true
      LEFT JOIN LATERAL (
        SELECT cr.id, cr.status, cr.started_at, cr.stats
        FROM workspace_crawl_runs cr
        WHERE cr.org_id = s.org_id AND cr.source_id = s.id AND cr.status = 'running'
        ORDER BY cr.started_at DESC
        LIMIT 1
      ) ar ON true
      WHERE s.org_id = ${orgId}
      ORDER BY s.display_name
    `) as unknown as SourceRow[];

    return rows.map((r) => ({
      id: r.id,
      name: r.display_name,
      kind: r.kind,
      status: r.status,
      lastCompleteRunAt: toIsoOrNull(r.last_complete_run_at),
      liveFiles: Number(r.live_files),
      liveDirs: Number(r.live_dirs),
      tombstoned: Number(r.tombstoned),
      newestSeenAt: toIsoOrNull(r.newest_seen_at),
      activeRun: r.active_run_id === null ? null : {
        id: r.active_run_id,
        status: r.active_run_status as string,
        startedAt: new Date(r.active_run_started_at as string | Date).toISOString(),
        stats: r.active_run_stats,
      },
    }));
  }

  async function ingestCard(orgId: string): Promise<DashboardSummary['ingest']> {
    const [status, enrichPendingRes, chunksRes] = await Promise.all([
      deps.contentIngestStatus(orgId),
      // Same pending-enrichment predicate as enrichmentService.run's pendingSql
      // (extracted, live, no enrichment row or a row whose model is still null).
      d.execute(sql`
        SELECT count(*)::int AS n
        FROM workspace_file_content c
        JOIN workspace_file_index fi ON fi.id = c.file_index_id AND fi.org_id = c.org_id
        LEFT JOIN workspace_file_enrichment en
          ON en.file_index_id = c.file_index_id AND en.enriched_at IS NOT NULL
        WHERE c.org_id = ${orgId}
          AND c.status = 'extracted'
          AND fi.deleted_at IS NULL
          AND (en.id IS NULL OR en.model IS NULL)
      `),
      d.execute(sql`SELECT count(*)::int AS n FROM workspace_content_chunks WHERE org_id = ${orgId}`),
    ]);
    return {
      eligible: status.eligible,
      extracted: status.extracted,
      failed: status.failed,
      skippedTooLarge: status.skippedTooLarge,
      skippedBinary: status.skippedBinary,
      blockedDlp: status.blockedDlp,
      pending: status.pending,
      enrichPending: Number((enrichPendingRes as unknown as Array<{ n: number }>)[0]?.n ?? 0),
      chunks: Number((chunksRes as unknown as Array<{ n: number }>)[0]?.n ?? 0),
    };
  }

  async function filingCard(orgId: string): Promise<DashboardSummary['filing']> {
    // Same base predicate as filingService.unfiledEmails (.eml, live) minus the
    // visibility predicate — org-operator scope sees every source. The
    // declared-project filter is JS-only (deriveDeclaredProject), so it is
    // applied below, not in SQL.
    const rows = await d.execute(sql`
      SELECT fi.id, fi.rel_path, fi.name, ef.status, ef.suggested_project_label, ef.confidence
      FROM workspace_file_index fi
      LEFT JOIN workspace_email_filings ef ON ef.file_index_id = fi.id AND ef.org_id = fi.org_id
      WHERE fi.org_id = ${orgId}
        AND fi.deleted_at IS NULL
        AND fi.is_dir = false
        AND fi.ext = 'eml'
      ORDER BY fi.rel_path
    `) as unknown as UnfiledCandidateRow[];

    const pool = rows.filter((r) => deriveDeclaredProject(r.rel_path) === null);

    // A filing row's status enum is only ever 'suggested' | 'confirmed' |
    // 'reassigned' (default 'suggested' on classify(), flipped to
    // confirmed/reassigned by assign()); no row at all means never classified.
    // "unfiled" = still undecided — no row, or a live 'suggested' row that
    // hasn't been acted on yet. confirmed/reassigned are DECIDED and leave
    // the unfiled bucket even though the file's path never moved.
    const unfiledPool = pool.filter((r) => r.status === null || r.status === 'suggested');
    const suggested = pool.filter((r) => r.status === 'suggested');
    const confirmed = pool.filter((r) => r.status === 'confirmed');
    const reassigned = pool.filter((r) => r.status === 'reassigned');
    const highConfidence = pool.filter((r) => r.status === 'suggested' && r.confidence === 'high');

    return {
      unfiled: unfiledPool.length,
      suggested: suggested.length,
      confirmed: confirmed.length,
      reassigned: reassigned.length,
      highConfidence: highConfidence.length,
      queue: unfiledPool.slice(0, 10).map((r) => ({
        id: r.id,
        name: r.name,
        relPath: r.rel_path,
        suggestedProjectLabel: r.suggested_project_label,
        confidence: r.confidence,
      })),
    };
  }

  async function activityCard(orgId: string): Promise<DashboardSummary['activity']> {
    const rows = await d.execute(sql`
      SELECT fi.id AS file_index_id, fi.name, fi.rel_path, x.last_activity_at, x.events_7d
      FROM (
        SELECT a.file_index_id, MAX(a.created_at) AS last_activity_at,
               COUNT(*) FILTER (WHERE a.created_at > now() - interval '7 days') AS events_7d
        FROM workspace_file_activity a
        WHERE a.org_id = ${orgId}
        GROUP BY a.file_index_id
      ) x
      JOIN workspace_file_index fi ON fi.id = x.file_index_id AND fi.org_id = ${orgId}
      WHERE fi.deleted_at IS NULL
      ORDER BY x.last_activity_at DESC
      LIMIT 15
    `) as unknown as ActivityRow[];

    return rows.map((r) => ({
      fileIndexId: r.file_index_id,
      name: r.name,
      relPath: r.rel_path,
      lastActivityAt: new Date(r.last_activity_at).toISOString(),
      events7d: Number(r.events_7d),
    }));
  }

  async function projectsCard(orgId: string): Promise<DashboardSummary['projects']> {
    const rows = await d.execute(sql`
      SELECT p.project_key, p.label,
        COALESCE(f.filed_emails, 0)::int AS filed_emails,
        COALESCE(c.crosswalk_entities, 0)::int AS crosswalk_entities,
        COALESCE(c.evidence_files, 0)::int AS evidence_files
      FROM workspace_projects p
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS filed_emails
        FROM workspace_email_filings ef
        WHERE ef.org_id = p.org_id
          AND (
            (ef.status = 'confirmed' AND ef.decided_project_key = p.project_key)
            OR (ef.status = 'suggested' AND ef.suggested_project_key = p.project_key)
          )
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS crosswalk_entities, COALESCE(SUM(pc.evidence_count), 0) AS evidence_files
        FROM workspace_project_crosswalk pc
        WHERE pc.org_id = p.org_id AND pc.project_key = p.project_key
      ) c ON true
      WHERE p.org_id = ${orgId}
      ORDER BY p.project_key
    `) as unknown as ProjectRow[];

    return rows.map((r) => ({
      projectKey: r.project_key,
      label: r.label,
      filedEmails: Number(r.filed_emails),
      crosswalkEntities: Number(r.crosswalk_entities),
      evidenceFiles: Number(r.evidence_files),
    }));
  }

  return {
    async summary(orgId: string): Promise<DashboardSummary> {
      const [sources, ingest, filing, activity, projects, nowRes] = await Promise.all([
        sourcesCard(orgId),
        ingestCard(orgId),
        filingCard(orgId),
        activityCard(orgId),
        projectsCard(orgId),
        d.execute(sql`SELECT now() AS ts`),
      ]);
      const ts = (nowRes as unknown as Array<{ ts: string | Date }>)[0]?.ts ?? new Date();
      return { sources, ingest, filing, activity, projects, generatedAt: new Date(ts).toISOString() };
    },
  };
}
