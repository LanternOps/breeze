// LLM enrichment pass (per-org content flag).
//
// Per extracted file, a single cheap-model call infers: document type, the
// project the CONTENT belongs to, a document date, and person/org entities.
// The inferred project is stored NEXT TO the declared location (derived from
// the path) so the finder can show disagreement — never silently refile.
//
// Division of labor (hard rule): the deterministic regex pass owns the
// structured entity types (apn/po/wdr/invoice/permit/job/license); this pass
// may only ADD person/org entities and never touches regex-origin rows.
//
// Pattern follows hive's extractor-model/classifier shape: injectable
// invoke() call, system prompt + JSON extraction + strict Zod, fail-soft per
// file (an LLM hiccup marks the file unenriched, never throws out of the
// batch) — EXCEPT for provider/billing problems (ExtensionAiError), which
// must abort the whole run instead of burning every pending file into a
// silent null-model row.
//
// Whether that abort is RETRYABLE is the host's call, carried on
// `ExtensionAiError.permanent` — not something this file can infer from the
// code, because `budget_exceeded` and `ai_unavailable` each cover both a
// condition that clears on its own and one that never does. A PERMANENT error
// (no provider configured, AI switched off for the org, partner plan without
// AI, an unpriced model id) degrades to a drained phase; anything else throws
// a TransientIngestError and backs the job off. See the `run()` invoke-loop.
//
// DLP invariant (W2): this pass never re-runs DLP. It reads
// workspace_file_content.extracted_text for status='extracted' rows only, and
// that text was ALREADY redacted at ingest (contentIngestService applies DLP
// once, before persistence). DLP-blocked files never reach status='extracted',
// so they are never enriched. Every enrichment prompt is therefore built from
// stored, already-redacted text — no raw sensitive value can reach the LLM here.
import { ExtensionAiError } from '@breeze/extension-sdk';
import type { WorkspaceDatabase } from '../hostTypes';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { z } from 'zod';
import { deriveDeclaredProject } from '../content/projects';
import { TransientIngestError } from './ingestErrors';

/**
 * The host's metered `context.ai.invoke` capability, narrowed to exactly what
 * enrichment needs. This is intentionally NOT the full `ExtensionAiInvokeInput`
 * shape — `model` selection (default + WORKSPACE_CONTENT_LLM_MODEL override) is
 * the host's job, not this call site's; see `run()`'s local `model` constant,
 * which mirrors that same resolution purely for the recorded DB column.
 */
export type EnrichmentInvoke = (input: {
  orgId: string;
  surface: 'workspace_enrichment';
  principal: { type: 'system'; id: null };
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  maxTokens: number;
}) => Promise<{ text: string }>;

export interface EnrichmentDeps {
  invoke: EnrichmentInvoke;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TEXT_CHARS = 12_000;
const MAX_PEOPLE = 12;

const resultSchema = z.object({
  docType: z.string().min(1).max(120).nullable(),
  projectKey: z.string().max(40).nullable(),
  projectLabel: z.string().max(200).nullable(),
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  people: z.array(z.object({
    name: z.string().min(1).max(120),
    kind: z.enum(['person', 'org']),
  })).max(MAX_PEOPLE),
});

export type EnrichmentResult = z.infer<typeof resultSchema>;

const SYSTEM = [
  'You classify one document from a small civil-engineering/land-surveying firm.',
  'Given the file path and body text, return ONLY a JSON object:',
  '{ "docType": short noun phrase for what the document IS (e.g. "easement deed",',
  '  "record of survey narrative", "meeting notes", "transmittal", "invoice email",',
  '  "agency review letter") or null if unclear;',
  '  "projectKey": the firm job number the CONTENT belongs to, chosen from the',
  '  provided project registry (format NNNN-NNN) or null if none fits — judge by',
  '  the body text, NOT by the folder the file sits in;',
  '  "projectLabel": the registry label for that key (or a short name from the',
  '  text if the registry lacks it), or null;',
  '  "docDate": the document\'s own date as YYYY-MM-DD, or null;',
  '  "confidence": "high" | "medium" | "low" for the project inference;',
  '  "people": up to 12 distinct people/organizations that appear, as',
  '  [{"name": "...", "kind": "person"|"org"}] }.',
  'Never invent identifiers. If the text contradicts the folder location, trust the text.',
].join('\n');

/** Extract the first JSON object from (possibly fenced) model output. */
export function extractJson(text: string, label: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${label}: no JSON object in model output: ${text.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function buildEnrichmentPrompt(input: {
  relPath: string;
  text: string;
  projects: Array<{ key: string; label: string }>;
}): string {
  const registry = input.projects.map((p) => `  ${p.key} — ${p.label}`).join('\n');
  return [
    `File path: ${input.relPath}`,
    '',
    'Project registry:',
    registry.length > 0 ? registry : '  (empty)',
    '',
    'Document text:',
    input.text.slice(0, MAX_TEXT_CHARS),
  ].join('\n');
}

interface PendingEnrichmentRow {
  id: string;
  rel_path: string;
  extracted_text: string;
}

export function createEnrichmentService(db: WorkspaceDatabase, deps: EnrichmentDeps) {
  const d = db;
  // Recorded (not authoritative) model label: mirrors the same env-var/default
  // resolution the host's invoke() applies, purely for the DB column — the
  // host is the single source of truth for which model actually ran.
  const model = process.env.WORKSPACE_CONTENT_LLM_MODEL ?? DEFAULT_MODEL;

  async function classifyOne(
    orgId: string,
    relPath: string,
    text: string,
    projects: Array<{ key: string; label: string }>,
  ): Promise<EnrichmentResult | null> {
    try {
      const result = await deps.invoke({
        orgId,
        surface: 'workspace_enrichment',
        principal: { type: 'system', id: null },
        system: SYSTEM,
        messages: [{ role: 'user', content: buildEnrichmentPrompt({ relPath, text, projects }) }],
        maxTokens: 1024,
      });
      return resultSchema.parse(extractJson(result.text, 'workspace-enrich'));
    } catch (err) {
      // Provider/billing problems (broken BYOK key, exhausted budget, rate cap)
      // must abort the run, not burn a null-model row into every pending file —
      // rethrow past this fail-soft catch. `run()` wraps it as TransientIngestError.
      if (err instanceof ExtensionAiError) throw err;
      return null; // fail-soft: an LLM/parse hiccup never breaks the batch
    }
  }

  return {
    classifyOne,

    /**
     * Enrich up to `batch` extracted-but-unenriched files. Returns
     * {processed, remaining, errors} like the ingest runner. A file whose LLM
     * call fails is recorded with model=null and stays re-enrichable.
     */
    async run(orgId: string, batch: number): Promise<{
      processed: number;
      remaining: number;
      errors: Array<{ fileIndexId: string; relPath: string; error: string }>;
      aiUnavailable?: true;
    }> {
      const projects = (await d.execute(sql`
        SELECT project_key, label FROM workspace_projects
        WHERE org_id = ${orgId} ORDER BY project_key
      `) as unknown as Array<{ project_key: string; label: string }>)
        .map((p) => ({ key: p.project_key, label: p.label }));
      const projectByKey = new Map(projects.map((p) => [p.key, p.label]));

      const pendingSql = sql`
        FROM workspace_file_content c
        JOIN workspace_file_index fi ON fi.id = c.file_index_id
        LEFT JOIN workspace_file_enrichment en
          ON en.file_index_id = c.file_index_id AND en.enriched_at IS NOT NULL
        WHERE c.org_id = ${orgId}
          AND c.status = 'extracted'
          AND fi.deleted_at IS NULL
          AND (en.id IS NULL OR en.model IS NULL)
      `;
      const pending = await d.execute(sql`
        SELECT fi.id, fi.rel_path, c.extracted_text
        ${pendingSql}
        ORDER BY fi.rel_path
        LIMIT ${batch}
      `) as unknown as PendingEnrichmentRow[];

      const errors: Array<{ fileIndexId: string; relPath: string; error: string }> = [];
      let processed = 0;

      for (const file of pending) {
        const declared = deriveDeclaredProject(file.rel_path);
        const declaredLabel = declared
          ? (declared.label ?? projectByKey.get(declared.key) ?? null)
          : null;
        let result: EnrichmentResult | null;
        try {
          result = await classifyOne(orgId, file.rel_path, file.extracted_text, projects);
        } catch (err) {
          // ExtensionAiError escaped classifyOne's fail-soft catch on purpose
          // (broken BYOK key / exhausted budget / provider rate cap): abort the
          // whole run rather than mark the rest of the batch as per-file errors.
          // The ingest runner's isTransientIngestError catch backs the job off
          // with a visible transient_error release; the admin enrich-run route
          // maps the same shape to a 503.
          if (err instanceof ExtensionAiError) {
            // PERMANENT means no retry can clear it: the deployment has no AI
            // provider at all (`not_configured` — the default self-hosted
            // shape, exactly what the pre-BYOK missing-ANTHROPIC_API_KEY guard
            // covered by handing the runner a no-op enrichment service), the
            // org or its partner's plan has AI switched off, or the configured
            // model id is not a priced model. Report the phase DRAINED so the
            // ingest job advances to crosswalk. Retrying instead burns all
            // max_attempts and fails the job, taking indexing and crosswalk
            // down with a feature that was merely absent or switched off — and
            // the next job repeats it forever.
            //
            // `=== true` on purpose: an ExtensionAiError from a host built
            // before the flag existed carries `undefined`, which must read as
            // transient (retry may help), never as "drain the phase".
            if (err.code === 'not_configured' || err.permanent === true) {
              return { processed, remaining: 0, errors, aiUnavailable: true };
            }
            // Everything else — a provider rate cap, an outage, a rejected
            // partner BYOK key, a spend cap that rolls over — stays LOUD and
            // retryable.
            throw new TransientIngestError(
              `AI provider unavailable for this organization: ${err.code}`,
              { cause: err },
            );
          }
          throw err;
        }
        const inferredKey = result?.projectKey ?? null;
        const inferredLabel = result?.projectLabel
          ?? (inferredKey ? projectByKey.get(inferredKey) ?? null : null);

        try {
          await d.execute(sql`
            INSERT INTO workspace_file_enrichment
              (org_id, file_index_id, inferred_project_key, inferred_project_label,
               inferred_doc_type, doc_date, declared_project_key, declared_project_label,
               confidence, model, enriched_at)
            VALUES
              (${orgId}, ${file.id}, ${inferredKey}, ${inferredLabel},
               ${result?.docType ?? null}, ${result?.docDate ?? null},
               ${declared?.key ?? null}, ${declaredLabel},
               ${result?.confidence ?? null}, ${result ? model : null}, now())
            ON CONFLICT (file_index_id) DO UPDATE SET
              inferred_project_key = EXCLUDED.inferred_project_key,
              inferred_project_label = EXCLUDED.inferred_project_label,
              inferred_doc_type = EXCLUDED.inferred_doc_type,
              doc_date = EXCLUDED.doc_date,
              declared_project_key = EXCLUDED.declared_project_key,
              declared_project_label = EXCLUDED.declared_project_label,
              confidence = EXCLUDED.confidence,
              model = EXCLUDED.model,
              enriched_at = now(),
              updated_at = now()
          `);
          for (const person of result?.people ?? []) {
            const norm = person.name.trim().replace(/\s+/g, ' ');
            if (!norm) continue;
            await d.execute(sql`
              INSERT INTO workspace_content_entities
                (org_id, file_index_id, entity_type, value_norm, value_raw, origin)
              VALUES (${orgId}, ${file.id}, ${person.kind}, ${norm}, ${person.name}, 'llm')
              ON CONFLICT (org_id, file_index_id, entity_type, value_norm) DO NOTHING
            `);
          }
          if (!result) {
            errors.push({ fileIndexId: file.id, relPath: file.rel_path, error: 'llm classification failed' });
          }
          processed += 1;
        } catch (error) {
          errors.push({
            fileIndexId: file.id,
            relPath: file.rel_path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const remainingRes = await d.execute(sql`
        SELECT count(*)::int AS n ${pendingSql}
      `) as unknown as Array<{ n: number }>;
      return { processed, remaining: Number(remainingRes[0]?.n ?? 0), errors };
    },
  };
}
