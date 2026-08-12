// Classify-one-email filing pipeline (dev-preview; per-org content flag).
//
// Confidence rules (fixed, deterministic — never a vibe):
//   HIGH — a strong entity (po/wdr/invoice/permit) in the email hits the
//   crosswalk with DOMINANT evidence: ≥2 distinct files for the winning
//   project AND (no competing project OR winner ≥ 2× the runner-up).
//   LOW  — everything else: person/org-participant evidence (however
//   suggestive), non-dominant crosswalk hits, or no candidates at all.
//   Person evidence can suggest, never auto-confirm.
// Matching is strict on (entity_type, value_norm) — the corpus plants
// "LS 8841" (a license) against "invoice 8841" precisely to punish
// value-only matching.
import type { WorkspaceDatabase } from '../hostTypes';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { deriveDeclaredProject } from '../content/projects';
import { STRONG_TYPES, type CrosswalkService } from './crosswalkService';
import { visibleSourcePredicateSql } from './visibility';

export interface FilingRecord {
  fileIndexId: string;
  relPath: string;
  name: string;
  emailMeta: { from?: string; to?: string[]; subject?: string; date?: string } | null;
  status: 'suggested' | 'confirmed' | 'reassigned' | null;
  suggestedProjectKey: string | null;
  suggestedProjectLabel: string | null;
  matchedEntityType: string | null;
  matchedEntityValue: string | null;
  confidence: 'high' | 'low' | null;
  rationale: string | null;
  decidedProjectKey: string | null;
}

export interface FilingDeps {
  crosswalkService: Pick<CrosswalkService, 'lookup'>;
}

const DOMINANCE_MIN_EVIDENCE = 2;
const DOMINANCE_MARGIN = 2;

/** Display form for a matched entity ("PO 4021" → "PO #4021"). */
function displayEntity(type: string, valueNorm: string): string {
  if (type === 'po') return valueNorm.replace(/^PO /, 'PO #');
  if (type === 'invoice') return valueNorm.replace(/^INV /, 'invoice #');
  return valueNorm;
}

export function createFilingService(db: WorkspaceDatabase, deps: FilingDeps) {
  const d = db;

  async function unfiledEmails(orgId: string, groupIds: string[] = []): Promise<Array<{
    id: string; rel_path: string; name: string; email_meta: FilingRecord['emailMeta'];
  }>> {
    const rows = await d.execute(sql`
      SELECT fi.id, fi.rel_path, fi.name, en.email_meta
      FROM workspace_file_index fi
      JOIN workspace_sources s ON s.id = fi.source_id AND s.org_id = fi.org_id
      LEFT JOIN workspace_file_enrichment en ON en.file_index_id = fi.id
      WHERE fi.org_id = ${orgId}
        AND fi.deleted_at IS NULL
        AND fi.is_dir = false
        AND fi.ext = 'eml'
        AND ${visibleSourcePredicateSql(sql, groupIds)}
      ORDER BY fi.rel_path
    `) as unknown as Array<{
      id: string; rel_path: string; name: string; email_meta: FilingRecord['emailMeta'];
    }>;
    return rows.filter((r) => deriveDeclaredProject(r.rel_path) === null);
  }

  async function filingRowsFor(orgId: string, fileIds: string[]): Promise<Map<string, Record<string, unknown>>> {
    if (fileIds.length === 0) return new Map();
    const rows = await d.execute(sql`
      SELECT file_index_id, status, suggested_project_key, suggested_project_label,
             matched_entity_type, matched_entity_value, confidence, rationale,
             decided_project_key
      FROM workspace_email_filings
      WHERE org_id = ${orgId}
    `) as unknown as Array<Record<string, unknown> & { file_index_id: string }>;
    return new Map(rows.map((r) => [r.file_index_id, r]));
  }

  function toRecord(
    file: { id: string; rel_path: string; name: string; email_meta: FilingRecord['emailMeta'] },
    filing: Record<string, unknown> | undefined,
  ): FilingRecord {
    return {
      fileIndexId: file.id,
      relPath: file.rel_path,
      name: file.name,
      emailMeta: file.email_meta ?? null,
      status: (filing?.status as FilingRecord['status']) ?? null,
      suggestedProjectKey: (filing?.suggested_project_key as string | null) ?? null,
      suggestedProjectLabel: (filing?.suggested_project_label as string | null) ?? null,
      matchedEntityType: (filing?.matched_entity_type as string | null) ?? null,
      matchedEntityValue: (filing?.matched_entity_value as string | null) ?? null,
      confidence: (filing?.confidence as FilingRecord['confidence']) ?? null,
      rationale: (filing?.rationale as string | null) ?? null,
      decidedProjectKey: (filing?.decided_project_key as string | null) ?? null,
    };
  }

  return {
    async list(orgId: string, groupIds: string[] = []): Promise<FilingRecord[]> {
      const emails = await unfiledEmails(orgId, groupIds);
      const filings = await filingRowsFor(orgId, emails.map((e) => e.id));
      return emails.map((e) => toRecord(e, filings.get(e.id)));
    },

    /**
     * Classify one unfiled email. Returns null when the file is unknown,
     * tombstoned, hidden, not an email, or not unfiled (404 at the route).
     */
    async classify(orgId: string, fileIndexId: string, groupIds: string[] = []): Promise<FilingRecord | null> {
      const emails = await unfiledEmails(orgId, groupIds);
      const email = emails.find((e) => e.id === fileIndexId);
      if (!email) return null;

      // Deterministic entity order: strongest lead types first, then value —
      // Postgres row order is otherwise unspecified and the first dominant
      // hit wins below.
      const entities = await d.execute(sql`
        SELECT entity_type, value_norm FROM workspace_content_entities
        WHERE org_id = ${orgId} AND file_index_id = ${fileIndexId}
        ORDER BY array_position(ARRAY['po','wdr','permit','invoice','org','person'], entity_type)
                 NULLS LAST,
                 value_norm ASC
      `) as unknown as Array<{ entity_type: string; value_norm: string }>;

      let suggestion: {
        projectKey: string; projectLabel: string | null;
        matchedType: string | null; matchedValue: string | null;
        confidence: 'high' | 'low'; rationale: string;
      } | null = null;

      // 1) Strong-entity crosswalk with dominance.
      for (const e of entities) {
        if (!(STRONG_TYPES as readonly string[]).includes(e.entity_type)) continue;
        const hits = await deps.crosswalkService.lookup(orgId, e.entity_type, e.value_norm);
        if (hits.length === 0) continue;
        // `hits.length === 0` was skipped above, so hits[0] is present.
        const winner = hits[0]!;
        const runnerUp = hits[1];
        const dominant = winner.evidenceCount >= DOMINANCE_MIN_EVIDENCE
          && (!runnerUp || winner.evidenceCount >= DOMINANCE_MARGIN * runnerUp.evidenceCount);
        // An org participant mentioned in the email makes the rationale read
        // the way a person would say it ("matched City of Fairoaks PO #4021").
        const orgEntity = entities.find((x) => x.entity_type === 'org');
        const rationale = `matched ${orgEntity ? `${orgEntity.value_norm} ` : ''}${displayEntity(e.entity_type, e.value_norm)}`;
        if (dominant) {
          suggestion = {
            projectKey: winner.projectKey,
            projectLabel: winner.projectLabel,
            matchedType: e.entity_type,
            matchedValue: e.value_norm,
            confidence: 'high',
            rationale,
          };
          break;
        }
        // non-dominant crosswalk hit: keep as a LOW fallback unless something
        // better shows up
        suggestion ??= {
          projectKey: winner.projectKey,
          projectLabel: winner.projectLabel,
          matchedType: e.entity_type,
          matchedValue: e.value_norm,
          confidence: 'low',
          rationale: `${rationale} — evidence is thin (${winner.evidenceCount} file${winner.evidenceCount === 1 ? '' : 's'})`,
        };
      }

      // 2) Participant fallback (people/orgs shared with filed project files) —
      //    forced LOW, never auto-confirmed.
      if (!suggestion || suggestion.confidence === 'low') {
        const people = entities.filter((e) => e.entity_type === 'person' || e.entity_type === 'org');
        if (people.length > 0) {
          const names = people.map((p) => p.value_norm);
          const candidates = await d.execute(sql`
            SELECT en.declared_project_key AS project_key,
                   max(en.declared_project_label) AS project_label,
                   e.value_norm,
                   count(DISTINCT e.file_index_id) AS files
            FROM workspace_content_entities e
            JOIN workspace_file_enrichment en ON en.file_index_id = e.file_index_id
            JOIN workspace_file_index fi ON fi.id = e.file_index_id
            JOIN workspace_sources s ON s.id = fi.source_id AND s.org_id = fi.org_id
            WHERE e.org_id = ${orgId}
              AND fi.deleted_at IS NULL
              AND ${visibleSourcePredicateSql(sql, groupIds)}
              AND e.entity_type IN ('person', 'org')
              AND e.value_norm = ANY(${'{' + names.map((n) => `"${n.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',') + '}'}::text[])
              AND en.declared_project_key IS NOT NULL
            GROUP BY en.declared_project_key, e.value_norm
            ORDER BY files DESC, project_key ASC
            LIMIT 5
          `) as unknown as Array<{
            project_key: string; project_label: string | null; value_norm: string; files: number;
          }>;
          const best = candidates[0];
          if (best && (!suggestion || Number(best.files) > 1)) {
            suggestion = {
              projectKey: best.project_key,
              projectLabel: best.project_label,
              matchedType: null,
              matchedValue: best.value_norm,
              confidence: 'low',
              rationale: `${best.value_norm} appears in ${best.files} ${best.project_label ?? best.project_key} file${Number(best.files) === 1 ? '' : 's'}`,
            };
          }
        }
      }

      await d.execute(sql`
        INSERT INTO workspace_email_filings
          (org_id, file_index_id, status, suggested_project_key, suggested_project_label,
           matched_entity_type, matched_entity_value, confidence, rationale)
        VALUES
          (${orgId}, ${fileIndexId}, 'suggested', ${suggestion?.projectKey ?? null},
           ${suggestion?.projectLabel ?? null}, ${suggestion?.matchedType ?? null},
           ${suggestion?.matchedValue ?? null},
           ${(suggestion?.confidence ?? 'low')}::workspace_filing_confidence,
           ${suggestion?.rationale ?? 'no filing signal found'})
        ON CONFLICT (file_index_id) DO UPDATE SET
          status = 'suggested',
          suggested_project_key = EXCLUDED.suggested_project_key,
          suggested_project_label = EXCLUDED.suggested_project_label,
          matched_entity_type = EXCLUDED.matched_entity_type,
          matched_entity_value = EXCLUDED.matched_entity_value,
          confidence = EXCLUDED.confidence,
          rationale = EXCLUDED.rationale,
          updated_at = now()
        -- A human decision is never silently overwritten by a re-classify:
        -- decided rows keep their status and decided_* values.
        WHERE workspace_email_filings.decided_project_key IS NULL
      `);
      const filings = await filingRowsFor(orgId, [fileIndexId]);
      return toRecord(email, filings.get(fileIndexId));
    },

    /**
     * One-click (re)assign. Confirms when the choice matches the suggestion,
     * reassigns otherwise. Returns null for unknown file/filing or project.
     */
    async assign(
      orgId: string,
      fileIndexId: string,
      projectKey: string,
      decidedLabel: string | null,
      groupIds: string[] = [],
    ): Promise<FilingRecord | null> {
      const project = (await d.execute(sql`
        SELECT project_key FROM workspace_projects
        WHERE org_id = ${orgId} AND project_key = ${projectKey}
      `) as unknown as Array<{ project_key: string }>)[0];
      if (!project) return null;
      const updated = await d.execute(sql`
        UPDATE workspace_email_filings SET
          status = CASE WHEN suggested_project_key = ${projectKey}
                        THEN 'confirmed'::workspace_filing_status
                        ELSE 'reassigned'::workspace_filing_status END,
          decided_project_key = ${projectKey},
          decided_label = ${decidedLabel},
          decided_at = now(),
          updated_at = now()
        WHERE org_id = ${orgId} AND file_index_id = ${fileIndexId}
        RETURNING file_index_id
      `) as unknown as Array<{ file_index_id: string }>;
      if (updated.length === 0) return null;
      const emails = await unfiledEmails(orgId, groupIds);
      const email = emails.find((e) => e.id === fileIndexId);
      if (!email) return null;
      const filings = await filingRowsFor(orgId, [fileIndexId]);
      return toRecord(email, filings.get(fileIndexId));
    },

    async projects(orgId: string): Promise<Array<{ key: string; label: string }>> {
      const rows = await d.execute(sql`
        SELECT project_key, label FROM workspace_projects
        WHERE org_id = ${orgId} ORDER BY project_key
      `) as unknown as Array<{ project_key: string; label: string }>;
      return rows.map((r) => ({ key: r.project_key, label: r.label }));
    },
  };
}

export type FilingService = ReturnType<typeof createFilingService>;
