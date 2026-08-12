// Content ingest runner (per-org content flag).
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
import { TransientIngestError, isTransientIngestError } from './ingestErrors';

export interface IngestError {
  fileIndexId: string;
  relPath: string;
  error: string;
}

export interface IngestRunResult {
  processed: number;
  remaining: number;
  errors: IngestError[];
  // A transient (source-likely-down) failure aborts the remaining batch and is
  // reported here; the failed file is left fully pending (no row written). Null
  // when the whole batch drained without a transient abort.
  transient: { reason: string; abortedAfter: number } | null;
}

/** Anything with `.execute` — the db handle or a transaction handle. */
type Executor = Pick<WorkspaceDatabase, 'execute'>;

export interface IngestRunOptions {
  /**
   * Re-scan every eligible file against the CURRENT DlpConfig, bypassing both
   * the snapshot-pending filter and the same-hash short-circuit. Used to
   * re-apply DLP after an org tightens its config without waiting for the
   * underlying bytes to change.
   */
  force?: boolean;
  /**
   * Force-only convergence guard: exclude files whose content row was already
   * refreshed at/after this instant, so a repeated forced sweep terminates.
   * The caller (job runner) passes the job's DB-sourced started_at.
   */
  forceSince?: Date;
}

export interface IngestStatus {
  eligible: number;
  extracted: number;
  failed: number;
  skippedTooLarge: number;
  skippedBinary: number;
  // W3 (Task 6): DLP-blocked files (see status() below). Additive — safe for
  // every existing consumer of this type.
  blockedDlp: number;
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
  // Stored content row state — used by the force re-embed-avoidance check.
  content_status: string | null;
  extracted_text: string | null;
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

  // Force-aware pending count: how many eligible files THIS sweep has not yet
  // re-walked. A forced run re-visits every eligible file regardless of its
  // snapshot, so the non-force pendingCount (already 0 for an extracted estate)
  // cannot measure force progress — an estate larger than one batch would report
  // remaining=0 after the first batch and the job would phase-complete having
  // visited only a fraction of it. A file is "visited" once its content row is
  // refreshed at/after forceSince (every processed file bumps updated_at), so
  // this mirrors the force SELECT arm and drains to 0 exactly when the whole
  // estate has been re-walked. Without forceSince the sweep has no convergence
  // guard, so every eligible file still counts as pending.
  async function forcePendingCount(orgId: string, forceSince?: Date): Promise<number> {
    const unvisitedArm = forceSince
      ? sql`AND (c.updated_at IS NULL OR c.updated_at < ${forceSince.toISOString()}::timestamptz)`
      : sql``;
    const res = await d.execute(sql`
      SELECT count(*)::int AS n
      FROM workspace_file_index fi
      JOIN workspace_sources s ON s.id = fi.source_id AND s.org_id = fi.org_id
      LEFT JOIN workspace_file_content c ON c.file_index_id = fi.id
      WHERE fi.org_id = ${orgId}
        AND fi.deleted_at IS NULL
        AND fi.is_dir = false
        AND s.kind = 'smb_share'
        AND s.status = 'active'
        AND s.visibility_group_ids = '[]'::jsonb
        ${unvisitedArm}
    `);
    return Number((res as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  }

  async function replaceRegexEntities(
    exec: Executor,
    orgId: string,
    fileIndexId: string,
    text: string,
  ): Promise<void> {
    const entities = extractEntities(text);
    await exec.execute(sql`
      DELETE FROM workspace_content_entities
      WHERE org_id = ${orgId} AND file_index_id = ${fileIndexId} AND origin = 'regex'
    `);
    for (const e of entities) {
      await exec.execute(sql`
        INSERT INTO workspace_content_entities (org_id, file_index_id, entity_type, value_norm, value_raw, origin)
        VALUES (${orgId}, ${fileIndexId}, ${e.type}, ${e.valueNorm}, ${e.valueRaw}, 'regex')
        ON CONFLICT (org_id, file_index_id, entity_type, value_norm) DO NOTHING
      `);
    }
  }

  async function upsertDeclaredProject(exec: Executor, orgId: string, relPath: string): Promise<void> {
    const declared = deriveDeclaredProject(relPath);
    if (!declared) return;
    const label = declared.label ?? declared.key;
    // A real label (folder name) may replace a key-only placeholder, never the
    // other way round.
    await exec.execute(sql`
      INSERT INTO workspace_projects (org_id, project_key, label)
      VALUES (${orgId}, ${declared.key}, ${label})
      ON CONFLICT (org_id, project_key) DO UPDATE
        SET label = EXCLUDED.label, updated_at = now()
        WHERE workspace_projects.label = workspace_projects.project_key
          AND EXCLUDED.label <> EXCLUDED.project_key
    `);
  }

  async function upsertContentRow(
    exec: Executor,
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
    await exec.execute(sql`
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
      await exec.execute(sql`
        INSERT INTO workspace_file_enrichment (org_id, file_index_id, email_meta)
        VALUES (${orgId}, ${fileIndexId}, ${JSON.stringify(row.emailMeta)}::jsonb)
        ON CONFLICT (file_index_id) DO UPDATE SET
          email_meta = EXCLUDED.email_meta, updated_at = now()
      `);
    }
  }

  return {
    async run(orgId: string, batch: number, opts?: IngestRunOptions): Promise<IngestRunResult> {
      // DLP config is per-org and stable for the whole run — fetch it once.
      const { dlpConfig } = await getOrgSettings(db, orgId);
      const force = opts?.force === true;
      const forceSince = force ? opts?.forceSince : undefined;
      // Force re-scans EVERY eligible file against the current DlpConfig, so it
      // drops the snapshot-mismatch arm of pendingPredicateSql (the single
      // non-force truth) and instead adds a convergence guard: a file whose
      // content row was already refreshed at/after forceSince in this sweep is
      // excluded, so a repeated forced sweep terminates. Non-force keeps the
      // shared snapshot predicate untouched.
      const pendingArm = force
        ? (forceSince
          // forceSince is a DB-origin timestamp (the job's started_at) round-
          // tripped through the host as a Date. Bind it as an ISO string with an
          // explicit ::timestamptz cast — the postgres.js driver cannot serialize
          // a raw Date parameter (it lands in Buffer.byteLength and throws), and
          // the rest of the extension already crosses the driver boundary as
          // toISOString() strings (contentSearchService/dashboardService/etc.).
          ? sql`AND (c.updated_at IS NULL OR c.updated_at < ${forceSince.toISOString()}::timestamptz)`
          : sql``)
        : pendingPredicateSql;
      const pending = await d.execute(sql`
        SELECT fi.id, fi.source_id, fi.rel_path, fi.name, fi.size, fi.mtime,
               s.root_path, s.kind AS source_kind,
               c.content_hash, c.status AS content_status, c.extracted_text
        FROM workspace_file_index fi
        JOIN workspace_sources s ON s.id = fi.source_id AND s.org_id = fi.org_id
        LEFT JOIN workspace_file_content c ON c.file_index_id = fi.id
        WHERE fi.org_id = ${orgId}
          AND fi.deleted_at IS NULL
          AND fi.is_dir = false
          AND s.kind = 'smb_share'
          AND s.status = 'active'
          AND s.visibility_group_ids = '[]'::jsonb
          ${pendingArm}
        ORDER BY fi.rel_path
        LIMIT ${batch}
      `) as unknown as PendingRow[];

      const errors: IngestError[] = [];
      let processed = 0;
      let transient: IngestRunResult['transient'] = null;

      for (const file of pending) {
        const source = { id: file.source_id, orgId, kind: file.source_kind, rootPath: file.root_path };
        const sourceSize = file.size === null ? null : Number(file.size);
        const sourceMtime = file.mtime;
        // Guards the failed-row fallback in the catch: once the file's new
        // version is durably persisted (or a failed/blocked row is written),
        // a later throw must NOT overwrite it with a failed row.
        let contentRowWritten = false;
        try {
          // Byte fetch is the transient seam: a source that is down (SMB read
          // refused) must not park the file as failed — it aborts the batch and
          // is retried whole. Everything thrown AFTER bytes are in hand
          // (extraction/parsing) stays permanent.
          let bytes: Buffer;
          try {
            bytes = await deps.reader.read(source, file.rel_path);
          } catch (readError) {
            throw new TransientIngestError(
              `reader: ${readError instanceof Error ? readError.message : String(readError)}`,
              { cause: readError },
            );
          }
          const result = await extractContent(file.name, bytes, maxBytes);

          if (result.status !== 'extracted') {
            // failed / skipped_* — no text, nothing for DLP to inspect.
            await upsertContentRow(d, orgId, file.id, {
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

          if (!force && file.content_hash === result.contentHash) {
            // Same bytes as last time — refresh the snapshot only. The prior
            // run already applied DLP to these exact bytes, so its verdict
            // (redacted text or blocked_dlp) stands untouched. Force skips this
            // arm so DLP re-applies with the CURRENT config.
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
            // run) — no text, no entities, no chunks, no embedder call. Under
            // force this is also the clean→blocked transition path when a
            // newly-tightened config now blocks a previously-clean file.
            await upsertContentRow(d, orgId, file.id, {
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

          // Force re-embed avoidance: if the file is already stored as
          // 'extracted' with byte-identical text, the (possibly changed) config
          // did not affect this file. Refresh snapshot + findings + updated_at
          // only; skip the entity/chunk rewrite and the embedder call entirely.
          if (force && file.content_status === 'extracted' && file.extracted_text === cleanText) {
            await d.execute(sql`
              UPDATE workspace_file_content
              SET source_size = ${sourceSize}, source_mtime = ${sourceMtime},
                  content_hash = ${result.contentHash},
                  dlp_findings = ${JSON.stringify(dlp.findings)}::jsonb,
                  updated_at = now()
              WHERE org_id = ${orgId} AND file_index_id = ${file.id}
            `);
            processed += 1;
            continue;
          }

          // Embed BEFORE opening the transaction — never hold a tx across a
          // network call. A transient embed failure throws here, before any
          // write, leaving the file's old content row and old chunks fully
          // intact (and pending, since the snapshot is untouched).
          let chunks: string[] = [];
          let vectors: number[][] = [];
          if (deps.embedder) {
            chunks = chunkText(cleanText);
            vectors = await deps.embedder.embed(chunks, 'document');
            // The embedder fills a fixed-length array from a remote response
            // keyed by the item's own `index`, so a short or misindexed
            // response leaves holes rather than a shorter array. Unchecked,
            // that surfaces as a TypeError inside the transaction below when a
            // hole reaches toVectorLiteral. A service-response fault is
            // transient by this module's taxonomy: abort the batch and leave
            // the file pending rather than persisting a `failed` row that
            // would park it out of the retry set.
            if (vectors.length !== chunks.length || vectors.some((v) => v === undefined)) {
              throw new TransientIngestError(
                `embedder returned ${vectors.length} usable vectors for ${chunks.length} chunks`,
              );
            }
          }

          // Persist the whole new version atomically: content row + entities +
          // project + chunks land together or not at all (savepoint rollback),
          // so extracted_text and chunks can never diverge.
          await d.transaction(async (tx) => {
            await upsertContentRow(tx, orgId, file.id, {
              contentHash: result.contentHash,
              sourceSize,
              sourceMtime,
              extractedText: cleanText,
              status: 'extracted',
              errorReason: null,
              emailMeta: result.emailMeta,
              dlpFindings: dlp.findings,
            });
            await replaceRegexEntities(tx, orgId, file.id, cleanText);
            await upsertDeclaredProject(tx, orgId, file.rel_path);
            if (deps.embedder) {
              // delete-then-insert per file: stale chunks must never linger
              // after a shrink/rewrite.
              await tx.execute(sql`
                DELETE FROM workspace_content_chunks
                WHERE org_id = ${orgId} AND file_index_id = ${file.id}
              `);
              for (let i = 0; i < chunks.length; i += 1) {
                await tx.execute(sql`
                  INSERT INTO workspace_content_chunks (org_id, file_index_id, chunk_index, text, embedding)
                  VALUES (${orgId}, ${file.id}, ${i}, ${chunks[i]}, ${toVectorLiteral(vectors[i]!)}::vector)
                `);
              }
            }
          });
          contentRowWritten = true;
          processed += 1;
        } catch (error) {
          if (isTransientIngestError(error)) {
            // Source likely down — abort the rest of the batch and leave this
            // file fully pending (no row written, no snapshot refresh).
            transient = { reason: error.message, abortedAfter: processed };
            break;
          }
          const message = error instanceof Error ? error.message : String(error);
          if (!contentRowWritten) {
            // Permanent read/extract/first-write failure: record a failed row
            // WITH the snapshot so the loop advances; re-ingest by touching the
            // file.
            try {
              await upsertContentRow(d, orgId, file.id, {
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
          // else: a durable row already exists for this file; surface the error
          // but leave that row intact.
          errors.push({ fileIndexId: file.id, relPath: file.rel_path, error: message });
        }
      }

      // A force sweep converges on the force-aware count (files not yet
      // re-walked this sweep); non-force stays on the single snapshot-pending
      // truth. Reporting the non-force count for a force job is the estate-
      // sized-batch bug that let a job phase-complete after one batch.
      const remaining = force
        ? await forcePendingCount(orgId, forceSince)
        : await pendingCount(orgId);
      return { processed, remaining, errors, transient };
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
        blockedDlp: counts.blocked_dlp ?? 0,
        pending,
      };
    },
  };
}
