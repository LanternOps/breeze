// Content ingest runner (dev-preview; per-org content flag).
//
// Batch-per-request by design: the caller (admin route) processes up to N
// pending files INSIDE the request, where the org RLS context is valid, and
// returns {processed, remaining} so a dev loop can drive it to zero. No
// detached worker, no queue — FORCE RLS makes a fire-and-forget async runner
// a footgun (no org GUCs on its connections), and the preview estate is a
// couple hundred files.
//
// "Pending" = a live, non-tombstoned file in a visible smb_share source whose
// content row is missing or whose (source_size, source_mtime) snapshot is
// stale. A matching sha256 short-circuits re-extraction (snapshot refresh
// only). Failures/skips also store the snapshot so one broken file cannot
// wedge the loop.
//
// DLP-on-ingest (W2): DLP runs ONCE here, right after extractContent and
// BEFORE any persistence or embedding. The org's DlpConfig is fetched once per
// run. A 'block'-action detector hit short-circuits the file to
// status='blocked_dlp' with no text, no chunks, and no embedder call (the
// snapshot is still written, so a blocked file is skipped — not retried — on
// the next run). Otherwise 'redact' hits rewrite the text and EVERYTHING
// downstream (stored extracted_text, entities, chunks, embeddings, and the
// enrichment prompt) is derived from that redacted text. Entities
// (extractEntities) therefore run on the redacted text: structured entity IDs
// (PO/APN/etc.) are not DLP targets and survive redaction, while any redacted
// span is already gone before entity extraction sees it.
import type { WorkspaceDatabase } from '../hostTypes';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ContentByteReader } from '../content/byteReader';
import { chunkText, toVectorLiteral, type Embedder } from '../content/embedder';
import { extractContent, type EmailMeta } from '../content/extract';
import { extractEntities } from '../content/entities';
import { deriveDeclaredProject } from '../content/projects';
import { applyDlpToText, type DlpFinding } from '../content/dlp';
import { getOrgSettings } from './orgSettingsService';

export interface IngestError {
  fileIndexId: string;
  relPath: string;
  error: string;
}

export interface IngestRunResult {
  processed: number;
  remaining: number;
  errors: IngestError[];
}

export interface IngestStatus {
  eligible: number;
  extracted: number;
  failed: number;
  skippedTooLarge: number;
  skippedBinary: number;
  pending: number;
}

interface PendingRow {
  id: string;
  source_id: string;
  rel_path: string;
  name: string;
  size: string | number | null;
  mtime: string | null;
  root_path: string;
  source_kind: string;
  content_hash: string | null;
}

export interface ContentIngestDeps {
  reader: ContentByteReader;
  maxBytes?: number;
  /** Absent → chunk/embedding writes are skipped entirely (lexical-only). */
  embedder?: Embedder;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

// Predicate shared by run/status: live files in visible smb_share sources.
// Visibility mirrors fileQueryService: active + empty visibility_group_ids
// (fail closed on non-empty).
const eligibleFilesSql = (orgId: string) => sql`
  FROM workspace_file_index fi
  JOIN workspace_sources s
    ON s.id = fi.source_id AND s.org_id = fi.org_id
  WHERE fi.org_id = ${orgId}
    AND fi.deleted_at IS NULL
    AND fi.is_dir = false
    AND s.kind = 'smb_share'
    AND s.status = 'active'
    AND s.visibility_group_ids = '[]'::jsonb
`;

const pendingPredicateSql = sql`
  AND (
    c.id IS NULL
    OR c.source_size IS DISTINCT FROM fi.size
    OR c.source_mtime IS DISTINCT FROM fi.mtime
  )
`;

export function createContentIngestService(db: WorkspaceDatabase, deps: ContentIngestDeps) {
  const d = db;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  async function pendingCount(orgId: string): Promise<number> {
    const res = await d.execute(sql`
      SELECT count(*)::int AS n
      ${eligibleFilesSql(orgId)}
      ${sql`AND NOT EXISTS (
        SELECT 1 FROM workspace_file_content c
        WHERE c.file_index_id = fi.id
          AND c.source_size IS NOT DISTINCT FROM fi.size
          AND c.source_mtime IS NOT DISTINCT FROM fi.mtime
      )`}
    `);
    return Number((res as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  }

  async function replaceRegexEntities(
    orgId: string,
    fileIndexId: string,
    text: string,
  ): Promise<void> {
    const entities = extractEntities(text);
    await d.execute(sql`
      DELETE FROM workspace_content_entities
      WHERE org_id = ${orgId} AND file_index_id = ${fileIndexId} AND origin = 'regex'
    `);
    for (const e of entities) {
      await d.execute(sql`
        INSERT INTO workspace_content_entities (org_id, file_index_id, entity_type, value_norm, value_raw, origin)
        VALUES (${orgId}, ${fileIndexId}, ${e.type}, ${e.valueNorm}, ${e.valueRaw}, 'regex')
        ON CONFLICT (org_id, file_index_id, entity_type, value_norm) DO NOTHING
      `);
    }
  }

  async function upsertDeclaredProject(orgId: string, relPath: string): Promise<void> {
    const declared = deriveDeclaredProject(relPath);
    if (!declared) return;
    const label = declared.label ?? declared.key;
    // A real label (folder name) may replace a key-only placeholder, never the
    // other way round.
    await d.execute(sql`
      INSERT INTO workspace_projects (org_id, project_key, label)
      VALUES (${orgId}, ${declared.key}, ${label})
      ON CONFLICT (org_id, project_key) DO UPDATE
        SET label = EXCLUDED.label, updated_at = now()
        WHERE workspace_projects.label = workspace_projects.project_key
          AND EXCLUDED.label <> EXCLUDED.project_key
    `);
  }

  async function upsertContentRow(
    orgId: string,
    fileIndexId: string,
    row: {
      contentHash: string | null;
      sourceSize: number | null;
      sourceMtime: string | null;
      extractedText: string | null;
      status: 'extracted' | 'failed' | 'skipped_too_large' | 'skipped_binary' | 'blocked_dlp';
      errorReason: string | null;
      emailMeta: EmailMeta | null;
      // Always written (defaults to []), so a file that transitions from a
      // prior blocked/redacted ingest to a clean one resets its findings.
      dlpFindings: DlpFinding[];
    },
  ): Promise<void> {
    await d.execute(sql`
      INSERT INTO workspace_file_content
        (org_id, file_index_id, content_hash, source_size, source_mtime, extracted_text, status, error_reason, dlp_findings)
      VALUES
        (${orgId}, ${fileIndexId}, ${row.contentHash}, ${row.sourceSize},
         ${row.sourceMtime}, ${row.extractedText}, ${row.status}::workspace_content_status, ${row.errorReason},
         ${JSON.stringify(row.dlpFindings)}::jsonb)
      ON CONFLICT (file_index_id) DO UPDATE SET
        content_hash = EXCLUDED.content_hash,
        source_size = EXCLUDED.source_size,
        source_mtime = EXCLUDED.source_mtime,
        extracted_text = EXCLUDED.extracted_text,
        status = EXCLUDED.status,
        error_reason = EXCLUDED.error_reason,
        dlp_findings = EXCLUDED.dlp_findings,
        extracted_at = now(),
        updated_at = now()
    `);
    // email_meta lives on the enrichment row (written deterministically here,
    // never by the LLM; the enrichment pass fills the inferred_* columns).
    if (row.emailMeta) {
      await d.execute(sql`
        INSERT INTO workspace_file_enrichment (org_id, file_index_id, email_meta)
        VALUES (${orgId}, ${fileIndexId}, ${JSON.stringify(row.emailMeta)}::jsonb)
        ON CONFLICT (file_index_id) DO UPDATE SET
          email_meta = EXCLUDED.email_meta, updated_at = now()
      `);
    }
  }

  return {
    async run(orgId: string, batch: number): Promise<IngestRunResult> {
      // DLP config is per-org and stable for the whole run — fetch it once.
      const { dlpConfig } = await getOrgSettings(db, orgId);
      const pending = await d.execute(sql`
        SELECT fi.id, fi.source_id, fi.rel_path, fi.name, fi.size, fi.mtime,
               s.root_path, s.kind AS source_kind, c.content_hash
        FROM workspace_file_index fi
        JOIN workspace_sources s ON s.id = fi.source_id AND s.org_id = fi.org_id
        LEFT JOIN workspace_file_content c ON c.file_index_id = fi.id
        WHERE fi.org_id = ${orgId}
          AND fi.deleted_at IS NULL
          AND fi.is_dir = false
          AND s.kind = 'smb_share'
          AND s.status = 'active'
          AND s.visibility_group_ids = '[]'::jsonb
          ${pendingPredicateSql}
        ORDER BY fi.rel_path
        LIMIT ${batch}
      `) as unknown as PendingRow[];

      const errors: IngestError[] = [];
      let processed = 0;

      for (const file of pending) {
        const source = { id: file.source_id, orgId, kind: file.source_kind, rootPath: file.root_path };
        const sourceSize = file.size === null ? null : Number(file.size);
        const sourceMtime = file.mtime;
        // Once the content row is durably 'extracted', a later failure (entity
        // replace, project upsert) must NOT overwrite it with a failed row —
        // that would destroy good text AND, because the snapshot matches, park
        // the file outside the pending set forever.
        let contentRowWritten = false;
        try {
          const bytes = await deps.reader.read(source, file.rel_path);
          const result = await extractContent(file.name, bytes, maxBytes);

          if (result.status !== 'extracted') {
            // failed / skipped_* — no text, nothing for DLP to inspect.
            await upsertContentRow(orgId, file.id, {
              contentHash: null,
              sourceSize,
              sourceMtime,
              extractedText: null,
              status: result.status,
              errorReason: result.status === 'failed' ? result.errorReason : null,
              emailMeta: null,
              dlpFindings: [],
            });
            contentRowWritten = true;
            processed += 1;
            continue;
          }

          if (file.content_hash === result.contentHash) {
            // Same bytes as last time — refresh the snapshot only. The prior
            // run already applied DLP to these exact bytes, so its verdict
            // (redacted text or blocked_dlp) stands untouched.
            await d.execute(sql`
              UPDATE workspace_file_content
              SET source_size = ${sourceSize}, source_mtime = ${sourceMtime}, updated_at = now()
              WHERE org_id = ${orgId} AND file_index_id = ${file.id}
            `);
            processed += 1;
            continue;
          }

          // DLP runs ONCE, here, between extraction and any persistence/embed.
          const dlp = applyDlpToText(result.text, dlpConfig);
          if (dlp.blocked) {
            // Block before store/embed: persist a blocked_dlp row carrying the
            // findings and the snapshot (so it is skipped, not retried, next
            // run) — no text, no entities, no chunks, no embedder call.
            await upsertContentRow(orgId, file.id, {
              contentHash: null,
              sourceSize,
              sourceMtime,
              extractedText: null,
              status: 'blocked_dlp',
              errorReason: null,
              emailMeta: null,
              dlpFindings: dlp.findings,
            });
            contentRowWritten = true;
            // A PRIOR clean ingest of this same file may have left chunks and
            // regex entities behind; the passages/chunk scope has no join to
            // the content status, so they would stay retrievable after the
            // transition to blocked_dlp. Purge them (same delete idiom the
            // extracted path uses) so a blocked file surfaces nothing.
            await d.execute(sql`
              DELETE FROM workspace_content_chunks
              WHERE org_id = ${orgId} AND file_index_id = ${file.id}
            `);
            await d.execute(sql`
              DELETE FROM workspace_content_entities
              WHERE org_id = ${orgId} AND file_index_id = ${file.id} AND origin = 'regex'
            `);
            processed += 1;
            continue;
          }

          // Redacted (or clean) text is the ONLY text that flows downstream.
          const cleanText = dlp.text;
          await upsertContentRow(orgId, file.id, {
            contentHash: result.contentHash,
            sourceSize,
            sourceMtime,
            extractedText: cleanText,
            status: 'extracted',
            errorReason: null,
            emailMeta: result.emailMeta,
            dlpFindings: dlp.findings,
          });
          contentRowWritten = true;
          await replaceRegexEntities(orgId, file.id, cleanText);
          await upsertDeclaredProject(orgId, file.rel_path);
          if (deps.embedder) {
            const chunks = chunkText(cleanText);
            const vectors = await deps.embedder.embed(chunks, 'document');
            // delete-then-insert per file: stale chunks must never linger
            // after a shrink/rewrite.
            await d.execute(sql`
              DELETE FROM workspace_content_chunks
              WHERE org_id = ${orgId} AND file_index_id = ${file.id}
            `);
            for (let i = 0; i < chunks.length; i += 1) {
              await d.execute(sql`
                INSERT INTO workspace_content_chunks (org_id, file_index_id, chunk_index, text, embedding)
                VALUES (${orgId}, ${file.id}, ${i}, ${chunks[i]}, ${toVectorLiteral(vectors[i])}::vector)
              `);
            }
          }
          processed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!contentRowWritten) {
            // Read/extract/first-write failure: record a failed row WITH the
            // snapshot so the loop advances; re-ingest by touching the file.
            try {
              await upsertContentRow(orgId, file.id, {
                contentHash: null,
                sourceSize,
                sourceMtime,
                extractedText: null,
                status: 'failed',
                errorReason: message,
                emailMeta: null,
                dlpFindings: [],
              });
            } catch { /* keep the original error */ }
          }
          // else: the extraction is durable; only the entity/project pass
          // failed — surface the error but leave the extracted row intact.
          errors.push({ fileIndexId: file.id, relPath: file.rel_path, error: message });
        }
      }

      return { processed, remaining: await pendingCount(orgId), errors };
    },

    async status(orgId: string): Promise<IngestStatus> {
      const [eligibleRes, statusRes, pending] = await Promise.all([
        d.execute(sql`SELECT count(*)::int AS n ${eligibleFilesSql(orgId)}`),
        d.execute(sql`
          SELECT c.status, count(*)::int AS n
          FROM workspace_file_content c
          WHERE c.org_id = ${orgId}
          GROUP BY c.status
        `),
        pendingCount(orgId),
      ]);
      const counts: Record<string, number> = {};
      for (const row of statusRes as unknown as Array<{ status: string; n: number }>) {
        counts[row.status] = Number(row.n);
      }
      return {
        eligible: Number((eligibleRes as unknown as Array<{ n: number }>)[0]?.n ?? 0),
        extracted: counts.extracted ?? 0,
        failed: counts.failed ?? 0,
        skippedTooLarge: counts.skipped_too_large ?? 0,
        skippedBinary: counts.skipped_binary ?? 0,
        pending,
      };
    },
  };
}
