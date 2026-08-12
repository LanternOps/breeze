// Crosswalk miner (per-org content flag).
//
// Mines counterparty identifiers (PO/WDR/invoice/permit — the deterministic
// regex types only) from files whose PATH declares a project, producing
// (entity → project) evidence rows. Evidence counts DISTINCT FILES, never
// mentions, and the miner RECOMPUTES the whole org's table on every run —
// re-runs can never inflate counts.
//
// The dominance rule (is this mapping trustworthy enough to auto-file?) lives
// with the consumer (filingService), not here: the miner records evidence,
// the classifier judges it.
import type { WorkspaceDatabase } from '../hostTypes';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { deriveDeclaredProject } from '../content/projects';

export const STRONG_TYPES = ['po', 'wdr', 'invoice', 'permit'] as const;
const SAMPLE_LIMIT = 5;

export interface CrosswalkRow {
  entityType: string;
  valueNorm: string;
  projectKey: string;
  projectLabel: string | null;
  evidenceCount: number;
}

interface EvidenceEntry {
  entityType: string;
  valueNorm: string;
  projectKey: string;
  files: Set<string>;
}

export function createCrosswalkService(db: WorkspaceDatabase) {
  const d = db;

  return {
    /** Recompute the org's crosswalk. Returns the mined mapping count. */
    async run(orgId: string): Promise<{ mined: number }> {
      const rows = await d.execute(sql`
        SELECT e.entity_type, e.value_norm, e.file_index_id, fi.rel_path
        FROM workspace_content_entities e
        JOIN workspace_file_index fi ON fi.id = e.file_index_id
        WHERE e.org_id = ${orgId}
          AND fi.deleted_at IS NULL
          AND e.entity_type IN ('po', 'wdr', 'invoice', 'permit')
      `) as unknown as Array<{
        entity_type: string; value_norm: string; file_index_id: string; rel_path: string;
      }>;

      const labels = new Map<string, string>();
      for (const p of await d.execute(sql`
        SELECT project_key, label FROM workspace_projects WHERE org_id = ${orgId}
      `) as unknown as Array<{ project_key: string; label: string }>) {
        labels.set(p.project_key, p.label);
      }

      // (type, value, project) → distinct file ids. Declared project comes
      // from the file's PATH (the filing humans already did), never inference.
      // Structured (JSON) key — value_norm itself contains spaces.
      const evidence = new Map<string, EvidenceEntry>();
      for (const row of rows) {
        const declared = deriveDeclaredProject(row.rel_path);
        if (!declared) continue;
        const key = JSON.stringify([row.entity_type, row.value_norm, declared.key]);
        let entry = evidence.get(key);
        if (!entry) {
          entry = {
            entityType: row.entity_type,
            valueNorm: row.value_norm,
            projectKey: declared.key,
            files: new Set(),
          };
          evidence.set(key, entry);
        }
        entry.files.add(row.file_index_id);
      }

      await d.execute(sql`DELETE FROM workspace_project_crosswalk WHERE org_id = ${orgId}`);
      let mined = 0;
      for (const { entityType, valueNorm, projectKey, files } of evidence.values()) {
        await d.execute(sql`
          INSERT INTO workspace_project_crosswalk
            (org_id, entity_type, value_norm, project_key, project_label,
             evidence_count, sample_file_ids, mined_at)
          VALUES
            (${orgId}, ${entityType}, ${valueNorm}, ${projectKey},
             ${labels.get(projectKey) ?? null}, ${files.size},
             ${JSON.stringify([...files].slice(0, SAMPLE_LIMIT))}::jsonb, now())
          ON CONFLICT (org_id, entity_type, value_norm, project_key) DO UPDATE SET
            project_label = EXCLUDED.project_label,
            evidence_count = EXCLUDED.evidence_count,
            sample_file_ids = EXCLUDED.sample_file_ids,
            mined_at = now(),
            updated_at = now()
        `);
        mined += 1;
      }
      return { mined };
    },

    /** Evidence rows for one entity value, strongest first. */
    async lookup(orgId: string, entityType: string, valueNorm: string): Promise<CrosswalkRow[]> {
      const rows = await d.execute(sql`
        SELECT entity_type, value_norm, project_key, project_label, evidence_count
        FROM workspace_project_crosswalk
        WHERE org_id = ${orgId} AND entity_type = ${entityType} AND value_norm = ${valueNorm}
        ORDER BY evidence_count DESC, project_key ASC
      `) as unknown as Array<{
        entity_type: string; value_norm: string; project_key: string;
        project_label: string | null; evidence_count: number;
      }>;
      return rows.map((r) => ({
        entityType: r.entity_type,
        valueNorm: r.value_norm,
        projectKey: r.project_key,
        projectLabel: r.project_label,
        evidenceCount: Number(r.evidence_count),
      }));
    },
  };
}

export type CrosswalkService = ReturnType<typeof createCrosswalkService>;
