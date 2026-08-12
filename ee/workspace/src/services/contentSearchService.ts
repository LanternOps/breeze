// Hybrid content retrieval (per-org content flag).
//
// Weighted Reciprocal Rank Fusion over independent arms, fused per-file:
//   entity exact-match  3.0   (query-side detection uses the ingest normalizer)
//   FTS-AND             2.5   (websearch_to_tsquery — all terms must match)
//   project resolution  2.0   (query ~ workspace_projects label/key/aliases)
//   name/relPath trigram 1.0  (the legacy finder arm — Beat 1 unregressed)
//   FTS-OR relaxed      0.8   (any term; low weight, recall backstop)
//   vector              1.0   (lands with the chunks migration; absent = skipped)
// RRF (score = Σ w/(60+rank)) instead of raw score mixing: the arms' scores
// are not commensurable, and normalization bugs — not ranking taste — are how
// a misfiled deed loses to a folder full of near-name matches.
//
// Every arm shares one scoped FROM/WHERE tail: deleted_at IS NULL, fail-closed
// source visibility, and the same partition rule as fileQueryService (smb rows
// under the shared key, local_profile rows device-scoped).
import type { WorkspaceDatabase } from '../hostTypes';
import { sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { normalizeQueryEntities } from '../content/entities';
import { toVectorLiteral, type Embedder } from '../content/embedder';
import type { FinderFile, SearchFilters, VisibleSource } from './fileQueryService';
import { SHARED_DEVICE_KEY } from './runScope';
import { visibleSourcePredicateSql } from './visibility';

export interface ContentSearchResult extends FinderFile {
  snippet: string | null;
  inferredDocType: string | null;
  inferredProjectKey: string | null;
  inferredProjectLabel: string | null;
  declaredProjectKey: string | null;
  declaredProjectLabel: string | null;
  metadataDisagreement: boolean;
  group: 'document' | 'email';
  matchedEntities: Array<{ type: string; value: string }>;
}

/**
 * A ranked content fragment for cited RAG. Retrieval runs over
 * workspace_content_chunks through the SAME fail-closed visible-sources scope
 * as search(); a passage whose source is outside the caller's visibility is
 * unreachable by construction. `snippet` is byte-capped deterministically.
 */
export interface ContentPassage {
  fileIndexId: string;
  relPath: string;
  sourceId: string;
  openPath: string | null;
  snippet: string;
  score: number;
}

export interface PassageOptions {
  /** Same device partition rule as search (local_profile rows device-scoped). */
  helperDeviceId: string;
  /** Restrict retrieval to a single file's chunks. */
  fileIndexId?: string;
  /** Passage cap; defaults to and is clamped at PASSAGE_MAX. */
  limit?: number;
}

export interface RrfArm {
  weight: number;
  /** file ids, best first */
  ids: string[];
}

const RRF_K = 60;

/** Weighted reciprocal-rank fusion; returns ids best-first with their scores. */
export function fuseRrf(arms: RrfArm[]): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const arm of arms) {
    arm.ids.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + arm.weight / (RRF_K + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export const ARM_WEIGHTS = {
  entity: 3.0,
  ftsAnd: 2.5,
  project: 2.0,
  trigram: 1.0,
  ftsOr: 0.8,
  vector: 1.0,
} as const;

const ARM_LIMIT = 50;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Passages are bounded so the chat model never receives an unbounded chunk
// dump: at most PASSAGE_MAX fragments, each snippet capped to PASSAGE_SNIPPET_CHARS.
const PASSAGE_MAX = 6;
const PASSAGE_SNIPPET_CHARS = 700;

function clampPassageLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return PASSAGE_MAX;
  return Math.min(PASSAGE_MAX, Math.max(1, Math.floor(limit)));
}

/**
 * Postgres array literal for a string[] bound parameter. drizzle's raw sql
 * template binds a JS array as a scalar, so arrays travel as an explicit
 * '{"a","b"}' literal with a ::text[]/::uuid[] cast at the call site.
 */
function pgArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

interface IdRow { id: string }

interface HydratedRow {
  id: string;
  source_id: string;
  device_key: string;
  rel_path: string;
  parent_path: string;
  name: string;
  is_dir: boolean;
  ext: string | null;
  size: string | number | null;
  mtime: string | Date | null;
  snippet: string | null;
  inferred_doc_type: string | null;
  inferred_project_key: string | null;
  inferred_project_label: string | null;
  declared_project_key: string | null;
  declared_project_label: string | null;
  matched_entities: Array<{ type: string; value: string }> | null;
}

function openPathFor(source: VisibleSource, relPath: string): string | null {
  if (source.kind !== 'smb_share') return null;
  return `${source.rootPath}\\${relPath.replaceAll('/', '\\')}`;
}

export interface ContentSearchDeps {
  /** Absent → the vector arm is skipped (lexical/entity arms carry the load). */
  embedder?: Embedder;
}

export function createContentSearchService(db: WorkspaceDatabase, deps: ContentSearchDeps = {}) {
  const d = db;

  async function visibleSources(orgId: string, groupIds: string[] = []): Promise<VisibleSource[]> {
    const rows = await d.execute(sql`
      SELECT s.id, s.display_name, s.kind, s.root_path
      FROM workspace_sources s
      WHERE s.org_id = ${orgId} AND ${visibleSourcePredicateSql(sql, groupIds)}
      ORDER BY s.display_name ASC
    `) as unknown as Array<{
      id: string; display_name: string; kind: 'smb_share' | 'local_profile'; root_path: string;
    }>;
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, kind: r.kind, rootPath: r.root_path }));
  }

  return {
    async search(
      orgId: string,
      helperDeviceId: string,
      filters: SearchFilters,
      groupIds: string[] = [],
    ): Promise<ContentSearchResult[]> {
      const visible = await visibleSources(orgId, groupIds);
      const scoped = filters.sourceId
        ? visible.filter((s) => s.id === filters.sourceId)
        : visible;
      if (scoped.length === 0) return [];
      const sourceIds = scoped.map((s) => s.id);

      const extraFilters: SQL[] = [];
      if (filters.ext) extraFilters.push(sql`AND fi.ext = ${filters.ext}`);
      if (filters.modifiedAfter) extraFilters.push(sql`AND fi.mtime >= ${new Date(filters.modifiedAfter)}`);
      if (filters.modifiedBefore) extraFilters.push(sql`AND fi.mtime <= ${new Date(filters.modifiedBefore)}`);
      // en is only joined in the final hydration SELECT below, so the guard
      // here is an EXISTS against workspace_file_enrichment (same predicate
      // shape as fileQueryService's search) rather than a bare column ref.
      if (filters.project) {
        extraFilters.push(sql`AND EXISTS (
          SELECT 1 FROM workspace_file_enrichment wfe
          WHERE wfe.file_index_id = fi.id AND wfe.inferred_project_label = ${filters.project}
        )`);
      }
      if (filters.docType) {
        extraFilters.push(sql`AND EXISTS (
          SELECT 1 FROM workspace_file_enrichment wfe
          WHERE wfe.file_index_id = fi.id AND wfe.inferred_doc_type = ${filters.docType}
        )`);
      }
      const extras = extraFilters.length > 0 ? sql.join(extraFilters, sql` `) : sql``;

      // Shared scope tail. c is joined so FTS arms can reference it; the other
      // arms simply ignore it.
      const scope = sql`
        FROM workspace_file_index fi
        JOIN workspace_sources s ON s.id = fi.source_id AND s.org_id = fi.org_id
        LEFT JOIN workspace_file_content c
          ON c.file_index_id = fi.id AND c.status = 'extracted'
        WHERE fi.org_id = ${orgId}
          AND fi.deleted_at IS NULL
          AND fi.is_dir = false
          AND fi.source_id = ANY(${pgArrayLiteral(sourceIds)}::uuid[])
          AND (
            (s.kind = 'smb_share' AND fi.device_key = ${SHARED_DEVICE_KEY})
            OR (s.kind = 'local_profile' AND fi.device_key = ${helperDeviceId})
          )
          ${extras}
      `;

      const q = filters.q;
      const queryEntities = normalizeQueryEntities(q);
      const entityKeys = queryEntities.map((e) => `${e.type}:${e.valueNorm}`);
      const orQuery = q.trim().split(/\s+/).filter(Boolean).join(' OR ');

      // Project resolution: the best-matching registry entry, if any.
      const projectHit = await d.execute(sql`
        SELECT p.project_key
        FROM workspace_projects p
        WHERE p.org_id = ${orgId}
          AND (
            similarity(p.label, ${q}) > 0.3
            OR p.label ILIKE ${'%' + q + '%'}
            OR ${q} ILIKE '%' || p.project_key || '%'
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(p.aliases) a(alias)
              WHERE similarity(a.alias, ${q}) > 0.3
            )
          )
        ORDER BY similarity(p.label, ${q}) DESC
        LIMIT 1
      `) as unknown as Array<{ project_key: string }>;
      const projectKey = projectHit[0]?.project_key ?? null;

      // Vector arm: embed the query once; max cosine similarity per file over
      // its chunks. Fail-soft — an embeddings outage degrades to lexical arms.
      const vectorArm: Promise<IdRow[]> = (async () => {
        if (!deps.embedder) return [];
        try {
          const [qVec] = await deps.embedder.embed([q], 'query');
          if (!qVec) return [];
          return await d.execute(sql`
            SELECT fi.id
            ${scope}
            AND EXISTS (SELECT 1 FROM workspace_content_chunks ch
                        WHERE ch.file_index_id = fi.id AND ch.embedding IS NOT NULL)
            ORDER BY (
              SELECT min(ch.embedding <=> ${toVectorLiteral(qVec)}::vector)
              FROM workspace_content_chunks ch
              WHERE ch.org_id = ${orgId} AND ch.file_index_id = fi.id AND ch.embedding IS NOT NULL
            ) ASC,
            fi.mtime DESC NULLS LAST, fi.id ASC
            LIMIT ${ARM_LIMIT}
          `) as unknown as IdRow[];
        } catch {
          return [];
        }
      })();

      const [entityIds, ftsAndIds, ftsOrIds, trigramIds, projectIds, vectorIds] = await Promise.all([
        entityKeys.length === 0 ? Promise.resolve([] as IdRow[]) : d.execute(sql`
          SELECT fi.id,
                 (SELECT count(*) FROM workspace_content_entities e
                  WHERE e.org_id = ${orgId} AND e.file_index_id = fi.id
                    AND (e.entity_type || ':' || e.value_norm) = ANY(${pgArrayLiteral(entityKeys)}::text[])) AS hits
          ${scope}
          AND EXISTS (
            SELECT 1 FROM workspace_content_entities e
            WHERE e.org_id = ${orgId} AND e.file_index_id = fi.id
              AND (e.entity_type || ':' || e.value_norm) = ANY(${pgArrayLiteral(entityKeys)}::text[])
          )
          ORDER BY hits DESC, fi.mtime DESC NULLS LAST, fi.id ASC
          LIMIT ${ARM_LIMIT}
        `) as unknown as Promise<IdRow[]>,
        d.execute(sql`
          SELECT fi.id
          ${scope}
          AND c.id IS NOT NULL
          AND to_tsvector('english', coalesce(c.extracted_text, '')) @@ websearch_to_tsquery('english', ${q})
          ORDER BY ts_rank(to_tsvector('english', coalesce(c.extracted_text, '')),
                           websearch_to_tsquery('english', ${q})) DESC,
                   fi.mtime DESC NULLS LAST, fi.id ASC
          LIMIT ${ARM_LIMIT}
        `) as unknown as Promise<IdRow[]>,
        orQuery.length === 0 ? Promise.resolve([] as IdRow[]) : d.execute(sql`
          SELECT fi.id
          ${scope}
          AND c.id IS NOT NULL
          AND to_tsvector('english', coalesce(c.extracted_text, '')) @@ websearch_to_tsquery('english', ${orQuery})
          ORDER BY ts_rank(to_tsvector('english', coalesce(c.extracted_text, '')),
                           websearch_to_tsquery('english', ${orQuery})) DESC,
                   fi.mtime DESC NULLS LAST, fi.id ASC
          LIMIT ${ARM_LIMIT}
        `) as unknown as Promise<IdRow[]>,
        d.execute(sql`
          SELECT fi.id
          ${scope}
          AND (fi.name % ${q} OR fi.name ILIKE ${'%' + q + '%'} OR fi.rel_path ILIKE ${'%' + q + '%'})
          ORDER BY greatest(similarity(fi.name, ${q}), similarity(fi.rel_path, ${q}) * 0.8) DESC,
                   fi.mtime DESC NULLS LAST, fi.id ASC
          LIMIT ${ARM_LIMIT}
        `) as unknown as Promise<IdRow[]>,
        projectKey === null ? Promise.resolve([] as IdRow[]) : d.execute(sql`
          SELECT fi.id
          ${scope}
          AND (
            fi.rel_path ILIKE ${'%' + projectKey + '%'}
            OR EXISTS (
              SELECT 1 FROM workspace_file_enrichment en
              WHERE en.file_index_id = fi.id AND en.org_id = ${orgId}
                AND (en.inferred_project_key = ${projectKey} OR en.declared_project_key = ${projectKey})
            )
          )
          ORDER BY (to_tsvector('english', coalesce(c.extracted_text, '')) @@ websearch_to_tsquery('english', ${orQuery || q})) DESC,
                   ts_rank(to_tsvector('english', coalesce(c.extracted_text, '')),
                           websearch_to_tsquery('english', ${orQuery || q})) DESC,
                   fi.mtime DESC NULLS LAST, fi.id ASC
          LIMIT ${ARM_LIMIT}
        `) as unknown as Promise<IdRow[]>,
        vectorArm,
      ]);

      const fused = fuseRrf([
        { weight: ARM_WEIGHTS.entity, ids: entityIds.map((r) => r.id) },
        { weight: ARM_WEIGHTS.ftsAnd, ids: ftsAndIds.map((r) => r.id) },
        { weight: ARM_WEIGHTS.project, ids: projectIds.map((r) => r.id) },
        { weight: ARM_WEIGHTS.trigram, ids: trigramIds.map((r) => r.id) },
        { weight: ARM_WEIGHTS.ftsOr, ids: ftsOrIds.map((r) => r.id) },
        { weight: ARM_WEIGHTS.vector, ids: vectorIds.map((r) => r.id) },
      ]);
      const limit = clampLimit(filters.limit);
      const top = fused.slice(0, limit);
      if (top.length === 0) return [];
      const topIds = top.map((t) => t.id);
      const scoreById = new Map(top.map((t) => [t.id, t.score]));

      const rows = await d.execute(sql`
        SELECT fi.id, fi.source_id, fi.device_key, fi.rel_path, fi.parent_path,
               fi.name, fi.is_dir, fi.ext, fi.size, fi.mtime,
               CASE WHEN c.extracted_text IS NULL THEN NULL
                    ELSE ts_headline('english', c.extracted_text,
                                     websearch_to_tsquery('english', ${orQuery || q}),
                                     'MaxWords=30, MinWords=10, MaxFragments=1')
               END AS snippet,
               en.inferred_doc_type, en.inferred_project_key, en.inferred_project_label,
               en.declared_project_key, en.declared_project_label,
               (SELECT jsonb_agg(jsonb_build_object('type', e.entity_type, 'value', e.value_norm))
                FROM workspace_content_entities e
                WHERE e.org_id = ${orgId} AND e.file_index_id = fi.id
                  AND (e.entity_type || ':' || e.value_norm) = ANY(${pgArrayLiteral(entityKeys)}::text[])) AS matched_entities
        FROM workspace_file_index fi
        LEFT JOIN workspace_file_content c
          ON c.file_index_id = fi.id AND c.status = 'extracted'
        LEFT JOIN workspace_file_enrichment en ON en.file_index_id = fi.id
        WHERE fi.org_id = ${orgId} AND fi.id = ANY(${pgArrayLiteral(topIds)}::uuid[])
      `) as unknown as HydratedRow[];

      const sourceById = new Map(scoped.map((s) => [s.id, s]));
      const results: ContentSearchResult[] = [];
      for (const row of rows) {
        const source = sourceById.get(row.source_id);
        if (!source) continue;
        const disagreement = row.inferred_project_key !== null
          && row.declared_project_key !== null
          && row.inferred_project_key !== row.declared_project_key;
        results.push({
          id: row.id,
          sourceId: row.source_id,
          deviceKey: row.device_key,
          relPath: row.rel_path,
          parentPath: row.parent_path,
          name: row.name,
          isDir: row.is_dir,
          ext: row.ext,
          size: row.size === null ? null : Number(row.size),
          mtime: row.mtime ? new Date(row.mtime).toISOString() : null,
          openPath: openPathFor(source, row.rel_path),
          score: scoreById.get(row.id),
          snippet: row.snippet,
          inferredDocType: row.inferred_doc_type,
          inferredProjectKey: row.inferred_project_key,
          inferredProjectLabel: row.inferred_project_label,
          declaredProjectKey: row.declared_project_key,
          declaredProjectLabel: row.declared_project_label,
          metadataDisagreement: disagreement,
          group: row.ext === 'eml' ? 'email' : 'document',
          matchedEntities: row.matched_entities ?? [],
        });
      }
      results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id));
      return results;
    },

    /**
     * Chunk-level retrieval for cited RAG. Ranks workspace_content_chunks with
     * the FTS-AND / FTS-OR / trigram arms (plus the vector arm when an embedder
     * is configured — absent → degrade to lexical, like ingest), fused by RRF.
     * Chunks are joined to the file index through the SAME fail-closed
     * visible-sources scope as search(), so a passage from a source outside the
     * caller's visibility can never appear. Truncated deterministically:
     * top-PASSAGE_MAX, each snippet byte-capped.
     */
    async passages(
      orgId: string,
      q: string,
      opts: PassageOptions,
      groupIds: string[] = [],
    ): Promise<ContentPassage[]> {
      const visible = await visibleSources(orgId, groupIds);
      if (visible.length === 0) return [];
      const sourceIds = visible.map((s) => s.id);
      const orQuery = q.trim().split(/\s+/).filter(Boolean).join(' OR ');
      const fileFilter = opts.fileIndexId ? sql`AND fi.id = ${opts.fileIndexId}` : sql``;

      // Chunk scope: identical visibility/partition tail as search's file scope,
      // rooted at workspace_content_chunks and restricted to the chunks table.
      const scope = sql`
        FROM workspace_content_chunks ch
        JOIN workspace_file_index fi ON fi.id = ch.file_index_id AND fi.org_id = ch.org_id
        JOIN workspace_sources s ON s.id = fi.source_id AND s.org_id = fi.org_id
        WHERE ch.org_id = ${orgId}
          AND fi.deleted_at IS NULL
          AND fi.is_dir = false
          AND fi.source_id = ANY(${pgArrayLiteral(sourceIds)}::uuid[])
          AND (
            (s.kind = 'smb_share' AND fi.device_key = ${SHARED_DEVICE_KEY})
            OR (s.kind = 'local_profile' AND fi.device_key = ${opts.helperDeviceId})
          )
          ${fileFilter}
      `;

      // Vector arm: max cosine similarity over embedded chunks. Fail-soft — an
      // embeddings outage (or no key) degrades to the lexical arms.
      const vectorArm: Promise<IdRow[]> = (async () => {
        if (!deps.embedder) return [];
        try {
          const [qVec] = await deps.embedder.embed([q], 'query');
          if (!qVec) return [];
          return await d.execute(sql`
            SELECT ch.id
            ${scope}
            AND ch.embedding IS NOT NULL
            ORDER BY ch.embedding <=> ${toVectorLiteral(qVec)}::vector ASC, ch.id ASC
            LIMIT ${ARM_LIMIT}
          `) as unknown as IdRow[];
        } catch {
          return [];
        }
      })();

      const [ftsAndIds, ftsOrIds, trigramIds, vectorIds] = await Promise.all([
        d.execute(sql`
          SELECT ch.id
          ${scope}
          AND to_tsvector('english', ch.text) @@ websearch_to_tsquery('english', ${q})
          ORDER BY ts_rank(to_tsvector('english', ch.text),
                           websearch_to_tsquery('english', ${q})) DESC, ch.id ASC
          LIMIT ${ARM_LIMIT}
        `) as unknown as Promise<IdRow[]>,
        orQuery.length === 0 ? Promise.resolve([] as IdRow[]) : d.execute(sql`
          SELECT ch.id
          ${scope}
          AND to_tsvector('english', ch.text) @@ websearch_to_tsquery('english', ${orQuery})
          ORDER BY ts_rank(to_tsvector('english', ch.text),
                           websearch_to_tsquery('english', ${orQuery})) DESC, ch.id ASC
          LIMIT ${ARM_LIMIT}
        `) as unknown as Promise<IdRow[]>,
        d.execute(sql`
          SELECT ch.id
          ${scope}
          AND (ch.text ILIKE ${'%' + q + '%'} OR ${q} <% ch.text)
          ORDER BY word_similarity(${q}, ch.text) DESC, ch.id ASC
          LIMIT ${ARM_LIMIT}
        `) as unknown as Promise<IdRow[]>,
        vectorArm,
      ]);

      const fused = fuseRrf([
        { weight: ARM_WEIGHTS.ftsAnd, ids: ftsAndIds.map((r) => r.id) },
        { weight: ARM_WEIGHTS.ftsOr, ids: ftsOrIds.map((r) => r.id) },
        { weight: ARM_WEIGHTS.trigram, ids: trigramIds.map((r) => r.id) },
        { weight: ARM_WEIGHTS.vector, ids: vectorIds.map((r) => r.id) },
      ]);
      const top = fused.slice(0, clampPassageLimit(opts.limit));
      if (top.length === 0) return [];
      const topIds = top.map((t) => t.id);
      const scoreById = new Map(top.map((t) => [t.id, t.score]));

      const rows = await d.execute(sql`
        SELECT ch.id, ch.file_index_id, ch.text, fi.source_id, fi.rel_path
        FROM workspace_content_chunks ch
        JOIN workspace_file_index fi ON fi.id = ch.file_index_id AND fi.org_id = ch.org_id
        WHERE ch.org_id = ${orgId} AND ch.id = ANY(${pgArrayLiteral(topIds)}::uuid[])
      `) as unknown as Array<{
        id: string; file_index_id: string; text: string; source_id: string; rel_path: string;
      }>;

      const sourceById = new Map(visible.map((s) => [s.id, s]));
      const passages: ContentPassage[] = [];
      for (const row of rows) {
        // Defense in depth: the arms already scope to visible sources, and this
        // guard drops anything that somehow isn't — a hidden-source passage is
        // unreachable on both paths.
        const source = sourceById.get(row.source_id);
        if (!source) continue;
        passages.push({
          fileIndexId: row.file_index_id,
          relPath: row.rel_path,
          sourceId: row.source_id,
          openPath: openPathFor(source, row.rel_path),
          snippet: row.text.slice(0, PASSAGE_SNIPPET_CHARS),
          score: scoreById.get(row.id) ?? 0,
        });
      }
      passages.sort((a, b) => b.score - a.score || a.fileIndexId.localeCompare(b.fileIndexId));
      return passages;
    },
  };
}
