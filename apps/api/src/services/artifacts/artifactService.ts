import { isUtf8 } from 'node:buffer';
import { and, desc, eq, gt, like, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { isTextArtifactContentType, type AiArtifactKind, type AiRunArtifactDto } from '@breeze/shared';
import { db } from '../../db';
import { aiRunArtifacts } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { redactAiToolOutputText, shrinkToJsonBudget } from '../aiToolOutput';
import { captureException } from '../sentry';
import { getBlobStorage, type BlobRegion } from './blobStorage';

/**
 * Artifact records (execution-plane spec 2026-09-13 §5.2, §6.1, §8, §9).
 *
 * ORDER IS THE CONTRACT, in both directions:
 *
 *   create — blob FIRST, row SECOND. A row pointing at a key that was never
 *     written would 404 on download forever; a key with no row is merely
 *     orphaned bytes, which the bucket lifecycle rule reaps. An insert failure
 *     therefore compensates with a blob delete and rethrows.
 *   delete — blob FIRST, row SECOND. The row is the ONLY index to the key, so
 *     a row deleted before its blob strands customer bytes with nothing left to
 *     find them by — the precise GDPR failure erasure exists to prevent. A blob
 *     fault therefore leaves the row and rethrows, which is what makes the
 *     sweeper and org erasure rerunnable (same reasoning as the ticket-attachment
 *     pre-clear in tenantCascade.ts step 1a).
 *
 * `resolveArtifact` returns `null` for a missing row AND for a row outside the
 * caller's org or run, and never distinguishes them: a handle is opaque (§5.2),
 * so "this exists but is not yours" is itself a disclosure. RLS is the real
 * boundary; the org predicate here is defence-in-depth for the mocked-db unit
 * path (same posture as GET /runs/:runId, routes/aiAgents.ts).
 */

export const ARTIFACT_PREVIEW_BYTES = 2048;
export const ARTIFACT_DEFAULT_TTL_DAYS = 30;

const UUID = z.string().guid();

export interface ArtifactRecord {
  id: string;
  orgId: string;
  runId: string | null;
  sessionId: string | null;
  kind: AiArtifactKind;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /**
   * Opaque `<region>/<yyyy>/<mm>/<uuid>`. Never serialised into any API
   * response or DTO — `toArtifactDto` omits it, so no wire path ever echoes it
   * back to a client. It IS included in the platform-admin tenant export
   * (`tenantExportPolicyRegistry.ts`), which is an authenticated export of the
   * customer's own data, not an API response — see the rationale comment on
   * the `ai_run_artifacts` entry there.
   */
  blobKey: string;
  headPreview: string;
  tailPreview: string;
  sourceDeviceId: string | null;
  createdByTool: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateArtifactInput {
  orgId: string;
  /** Null for a chat capture with no agent run in flight (spec §5.4). */
  runId: string | null;
  sessionId?: string | null;
  kind: AiArtifactKind;
  name: string;
  contentType: string;
  body: Buffer | NodeJS.ReadableStream;
  maxBytes: number;
  sourceDeviceId?: string | null;
  createdByTool: string;
  region: BlobRegion;
  ttlDays?: number;
}

const ARTIFACT_COLUMNS = {
  id: aiRunArtifacts.id,
  orgId: aiRunArtifacts.orgId,
  runId: aiRunArtifacts.runId,
  sessionId: aiRunArtifacts.sessionId,
  kind: aiRunArtifacts.kind,
  name: aiRunArtifacts.name,
  contentType: aiRunArtifacts.contentType,
  bytes: aiRunArtifacts.bytes,
  sha256: aiRunArtifacts.sha256,
  blobKey: aiRunArtifacts.blobKey,
  headPreview: aiRunArtifacts.headPreview,
  tailPreview: aiRunArtifacts.tailPreview,
  sourceDeviceId: aiRunArtifacts.sourceDeviceId,
  createdByTool: aiRunArtifacts.createdByTool,
  expiresAt: aiRunArtifacts.expiresAt,
  createdAt: aiRunArtifacts.createdAt,
} as const;

/**
 * Reduce a model- or tool-supplied name to a safe BASENAME (≤ 200, matching the
 * column CHECK). This value is echoed in `Content-Disposition`, so a quote,
 * backslash, CR or LF here is a header-injection vector — removed outright, not
 * escaped, exactly as `sanitizeAttachmentFilename` does for ticket attachments.
 */
export function sanitizeArtifactName(raw: string): string {
  const base = raw.split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return cleaned.slice(0, 200).trim() || 'artifact';
}

/** Workspace outputs arrive with a generic MIME type; infer only known extensions. */
function artifactContentType(contentType: string, name: string): string {
  if (contentType.trim().toLowerCase() !== 'application/octet-stream') return contentType;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const known: Record<string, string> = {
    txt: 'text/plain', log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
    json: 'application/json', jsonl: 'application/jsonl', ndjson: 'application/x-ndjson',
    md: 'text/markdown', pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return known[extension] ?? contentType;
}

/**
 * Head/tail of the RAW content (spec §5.2), NOT a compacted or rendered form —
 * the whole point is that the technician can see what the model saw. A Buffer
 * that is not valid UTF-8, or contains a NUL byte, gets NO preview at all
 * (both slices come back empty) — a text MIME label cannot make arbitrary
 * binary bytes safe to display. A string input has NUL stripped (Postgres
 * `text` rejects it outright) rather than being blanked, since a caller that
 * already decoded the bytes to a string has vouched for them being text.
 * Bare secrets are redacted with the same patterns the chat path already
 * applies.
 */
export function buildPreviews(raw: Buffer | string): { headPreview: string; tailPreview: string } {
  // A text MIME label cannot make arbitrary binary bytes safe to display.
  if (Buffer.isBuffer(raw) && (!isUtf8(raw) || raw.includes(0))) {
    return { headPreview: '', tailPreview: '' };
  }
  const text = (typeof raw === 'string' ? raw : raw.toString('utf8')).replace(/\u0000/g, '');
  const head = redactAiToolOutputText(text.slice(0, ARTIFACT_PREVIEW_BYTES));
  const tail = redactAiToolOutputText(text.slice(-ARTIFACT_PREVIEW_BYTES));
  // Redaction can only ever lengthen a slice ([REDACTED] vs a short token), so
  // re-clamp rather than trusting the slice width.
  return {
    headPreview: head.slice(0, ARTIFACT_PREVIEW_BYTES),
    tailPreview: tail.slice(-ARTIFACT_PREVIEW_BYTES),
  };
}

export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord> {
  const blobs = getBlobStorage();
  const contentType = artifactContentType(input.contentType, input.name);
  // Buffer the body once when it is already a Buffer so the previews describe
  // exactly the bytes that were stored. A stream body is previewed from the
  // head/tail the blob layer read back (see below).
  const put = await blobs.put({
    region: input.region,
    contentType,
    body: input.body,
    maxBytes: input.maxBytes,
  });

  // Previews are gated by CONTENT, not the content-type label —
  // `buildPreviews` already refuses non-UTF-8/NUL bytes. `workspace_collect`
  // stores unknown extensions as `application/octet-stream`, so gating by
  // name here would permanently blank previews for legitimate text outputs
  // (`findings`, `summary.out`, …). `isTextArtifactContentType` remains a
  // render-time gate only (see `toArtifactDto`).
  const previewSource = Buffer.isBuffer(input.body)
    ? input.body
    // A stream was consumed by `put`; re-read the head/tail from the stored
    // object rather than guessing. Small and bounded: two 2 KiB slices.
    : await readPreviewSlice(put.key, put.bytes);

  const { headPreview, tailPreview } = buildPreviews(previewSource);
  // `artifactContentType` above only promotes a KNOWN extension; an unnamed or
  // unrecognised one (e.g. `findings`, `summary.out`) is left as
  // application/octet-stream even though `buildPreviews` just proved the
  // content decodes as valid, printable UTF-8 text (that's the only way it
  // produced a non-empty preview — see the doc on `buildPreviews`). Persist
  // text/plain in that case so `isTextArtifactContentType` — the render-time
  // gate in `toArtifactDto` and the web preview toggle
  // (RunArtifactsSection.tsx) — doesn't blank a preview we already know is
  // safe. A genuinely binary octet-stream artifact produces an empty preview
  // and is left unpromoted.
  const persistedContentType = contentType.trim().toLowerCase() === 'application/octet-stream'
    && (headPreview !== '' || tailPreview !== '')
    ? 'text/plain'
    : contentType;
  const ttlDays = input.ttlDays ?? ARTIFACT_DEFAULT_TTL_DAYS;

  try {
    const [row] = await db
      .insert(aiRunArtifacts)
      .values({
        orgId: input.orgId,
        runId: input.runId,
        sessionId: input.sessionId ?? null,
        kind: input.kind,
        name: sanitizeArtifactName(input.name),
        contentType: persistedContentType.slice(0, 128),
        bytes: put.bytes,
        sha256: put.sha256,
        blobKey: put.key,
        headPreview,
        tailPreview,
        sourceDeviceId: input.sourceDeviceId ?? null,
        createdByTool: input.createdByTool.slice(0, 128),
        expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
      })
      .returning(ARTIFACT_COLUMNS);
    if (!row) throw new Error('artifact insert returned no row');
    return row as ArtifactRecord;
  } catch (err) {
    // Compensating delete: without it the key is unreachable forever (no row
    // indexes it) and only the bucket lifecycle rule would ever reap it.
    // Best-effort — a failure here must not mask the real insert error.
    try {
      await blobs.delete(put.key);
    } catch (cleanupErr) {
      captureException(cleanupErr);
      console.error('[artifacts] compensating blob delete failed after a failed row insert', cleanupErr);
    }
    throw err;
  }
}

/** Two bounded reads used only when the caller handed us a stream. */
async function readPreviewSlice(key: string, bytes: number): Promise<Buffer> {
  if (bytes === 0) return Buffer.alloc(0);
  const stream = await getBlobStorage().openStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  const wanted = Math.min(bytes, ARTIFACT_PREVIEW_BYTES * 2);
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    chunks.push(chunk);
    total += chunk.length;
    if (total >= wanted) break;
  }
  return Buffer.concat(chunks, total);
}

export async function resolveArtifact(
  handle: string,
  scope: { orgId: string; runId?: string },
): Promise<ArtifactRecord | null> {
  // A non-uuid must never reach the query: Postgres raises 22P02 on the cast
  // and that poisons the whole request transaction, turning a 404 into a 500
  // at COMMIT (the trap `uuidParam` in routes/aiAgents.ts documents).
  if (!UUID.safeParse(handle).success || !UUID.safeParse(scope.orgId).success) return null;
  if (scope.runId !== undefined && !UUID.safeParse(scope.runId).success) return null;

  const [row] = await db
    .select(ARTIFACT_COLUMNS)
    .from(aiRunArtifacts)
    .where(and(
      eq(aiRunArtifacts.id, handle),
      eq(aiRunArtifacts.orgId, scope.orgId),
      ...(scope.runId ? [eq(aiRunArtifacts.runId, scope.runId)] : []),
    ))
    .limit(1);
  return (row as ArtifactRecord | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// A-W05 (D13a/D13b) — `read_artifact` tool support: ranged reads, and a
// scope stricter than the REST download below.
// ---------------------------------------------------------------------------

/** A `read_artifact` page never exceeds this many characters, whatever `maxChars` asks for. */
export const ARTIFACT_READ_MAX_CHARS = 6_000;

/**
 * Fix 4a: the JSON-escaped/quoted length `text` may cost inside the tool's
 * response, leaving headroom under MAX_TOOL_RESULT_CHARS for the rest of the
 * `read_artifact` envelope (handle, name, contentType, bytes, offset,
 * nextOffset, hasMore).
 */
const ARTIFACT_READ_JSON_BUDGET_CHARS = 7_000;

/** Index of the last byte that ends a complete UTF-8 sequence in `buf`, or 0 when none does. */
function utf8Boundary(buf: Buffer): number {
  const end = buf.length;
  let i = end - 1;
  while (i >= 0 && i >= end - 4 && (buf[i]! & 0xc0) === 0x80) i--;
  if (i < 0) return 0;
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end - i >= need ? end : i;
}

async function collect(stream: NodeJS.ReadableStream, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    chunks.push(chunk);
    total += chunk.length;
    if (total >= cap) break;
  }
  return Buffer.concat(chunks, Math.min(total, cap));
}

/**
 * A-W05 (D13a): a character window read through a byte Range. Never splits a
 * UTF-8 sequence; `nextOffset` is the byte offset of the first byte NOT
 * returned, so passing it straight back in continues exactly where this left
 * off. `maxChars` is clamped to `ARTIFACT_READ_MAX_CHARS` regardless of what
 * the caller asked for.
 */
export async function readArtifactWindow(
  record: ArtifactRecord,
  offset: number,
  maxChars: number,
): Promise<{ text: string; nextOffset: number; hasMore: boolean }> {
  const start = Math.max(0, Math.trunc(offset));
  const want = Math.min(Math.max(1, Math.trunc(maxChars) || ARTIFACT_READ_MAX_CHARS), ARTIFACT_READ_MAX_CHARS);
  if (start >= record.bytes) return { text: '', nextOffset: record.bytes, hasMore: false };
  const end = Math.min(record.bytes - 1, start + want * 4 - 1); // 4 bytes/char is the UTF-8 worst case
  const buf = await collect(await getBlobStorage().openRange(record.blobKey, start, end), end - start + 1);
  let cut = utf8Boundary(buf);
  if (cut === 0 && buf.length > 0) cut = buf.length; // undecodable tail at EOF: emit lossy rather than loop forever
  let text = buf.toString('utf8', 0, cut);
  const chars = Array.from(text);
  if (chars.length > want) text = chars.slice(0, want).join('');
  // Fix 4a: shrink further so the JSON-escaped cost fits the budget —
  // escape-heavy content sized only by raw char count can still overflow
  // compactToolResultForChat and get replaced by a digest, silently
  // dropping text `nextOffset` told the caller it could read.
  text = shrinkToJsonBudget(text, ARTIFACT_READ_JSON_BUDGET_CHARS);
  const used = Buffer.byteLength(text, 'utf8');
  const nextOffset = start + used;
  return { text, nextOffset, hasMore: nextOffset < record.bytes };
}

/**
 * A-W05 (D13b/Q5) — the redact-then-capture marker. `captureLargeToolResult`
 * names every artifact it writes `<tool>.redacted.<ext>` (REDACTED_CAPTURE_NAME_INFIX),
 * and only a row carrying that marker is readable back through `read_artifact`.
 * A legacy `input_capture` row written before redact-then-capture shipped is
 * named `<tool>.<ext>` and may hold raw credential material, so it is excluded
 * — deterministically, with no deploy-time cutoff date to get wrong.
 */
export const REDACTED_CAPTURE_NAME_INFIX = '.redacted.';
export const REDACTED_CAPTURE_NAME_PATTERN = `%${REDACTED_CAPTURE_NAME_INFIX}%`;

/**
 * What `executeTool` resolves a call's capture attribution to (the same
 * anchor `captureContextFrom`/`CaptureContext` in toolResultCapture.ts
 * produces on the write side) — threaded through by the tool registration
 * layer, not derived here.
 */
export interface ArtifactCallerAnchor {
  orgId: string;
  /** Set when the caller is inside an agent run. Wins over `sessionId` when both are present — one anchor per artifact, same rule the write side uses. */
  runId?: string | null;
  /** The CALLER'S CURRENT chat session only — never "any session belonging to this user" (Q4). */
  sessionId?: string | null;
}

/**
 * The real query, exported UNAWAITED so a dedicated SQL-compiled test can
 * prove the predicate without a vacuous mocked-`where` assertion (see
 * artifactService.callerScope.sql.test.ts) — same pattern as
 * `ticketPush.ts`'s `anySlaSubscribersQuery`. `findArtifactForCaller` below
 * is the only real caller.
 */
export function findArtifactForCallerQuery(handle: string, anchor: ArtifactCallerAnchor) {
  const runId = anchor.runId ?? null;
  const sessionId = runId ? null : (anchor.sessionId ?? null);
  const ownership = runId
    ? eq(aiRunArtifacts.runId, runId)
    : eq(aiRunArtifacts.sessionId, sessionId as string);
  return db
    .select(ARTIFACT_COLUMNS)
    .from(aiRunArtifacts)
    .where(and(
      eq(aiRunArtifacts.id, handle),
      eq(aiRunArtifacts.orgId, anchor.orgId),
      ownership,
      gt(aiRunArtifacts.expiresAt, new Date()),
      // Q5: an export is an intentional bulk write, never redacted, and never
      // meant to be paged back through this tool.
      ne(aiRunArtifacts.createdByTool, 'export_dataset'),
      // Q5: a legacy raw capture (written before redact-then-capture shipped)
      // may still hold credential material — only a marked capture is
      // readable. Any other kind is not gated on the marker.
      or(
        ne(aiRunArtifacts.kind, 'input_capture'),
        like(aiRunArtifacts.name, REDACTED_CAPTURE_NAME_PATTERN),
      ),
    ))
    .limit(1);
}

/**
 * Tool-side resolve for `read_artifact` (A-W05 D13a/Q4): STRONGER than the
 * REST download (`findArtifactForAuth` below, org-wide) — an artifact is
 * visible only to the run or chat session it was captured under, matched
 * EXACTLY. "Any session of this user" is deliberately NOT an ownership test:
 * a prompt-injected agent running in session B must not be able to read what
 * the same user captured in session A.
 *
 * Returns `null` — never a distinguishable "forbidden" — for a missing row,
 * a wrong-scope row, an expired row, an `export_dataset` row, and a
 * legacy unmarked (raw) `input_capture` row alike: a handle is opaque, so "this
 * exists but is not yours" is itself a disclosure (same posture as
 * `resolveArtifact`/`findArtifactForAuth`).
 */
export async function findArtifactForCaller(
  handle: string,
  anchor: ArtifactCallerAnchor,
): Promise<ArtifactRecord | null> {
  // A non-uuid must never reach the query (22P02 poisons the transaction —
  // the `uuidParam` trap `resolveArtifact` above already documents).
  if (!UUID.safeParse(handle).success || !UUID.safeParse(anchor.orgId).success) return null;
  if (!anchor.runId && !anchor.sessionId) return null;
  const [row] = await findArtifactForCallerQuery(handle, anchor);
  return (row as ArtifactRecord | undefined) ?? null;
}

/**
 * The ONLY content types an artifact download (REST or `read_artifact`) may
 * echo. Everything else — html, svg, xml, any script type, anything
 * unrecognised — becomes octet-stream. An allowlist, never a denylist: a new
 * active type must not become renderable by default.
 *
 * A-W05 (D13a): lives here rather than in `routes/aiArtifacts.ts` (its
 * original home) so `aiToolsArtifacts.ts` can import it without dragging that
 * route module's `new Hono()` + middleware side effects into the `aiTools.ts`
 * hub — `services/aiToolNames.ts`'s header documents exactly this failure
 * shape for a different import (`workerEntrypointClosure.contract.test.ts`).
 * `routes/aiArtifacts.ts` re-exports this symbol so its own callers and test
 * are unaffected.
 */
const SAFE_DOWNLOAD_CONTENT_TYPES = new Set([
  'application/json',
  'application/jsonl',
  'text/plain; charset=utf-8',
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'application/gzip',
  'application/zip',
  'application/pdf',
]);

export function artifactDownloadContentType(stored: string): string {
  const normalised = stored.trim().toLowerCase();
  return SAFE_DOWNLOAD_CONTENT_TYPES.has(normalised) ? normalised : 'application/octet-stream';
}

/** Route-side resolve: scoped by `auth.orgCondition`, which is `undefined` (no filter) for system scope. */
export async function findArtifactForAuth(handle: string, auth: AuthContext): Promise<ArtifactRecord | null> {
  if (!UUID.safeParse(handle).success) return null;
  const [row] = await db
    .select(ARTIFACT_COLUMNS)
    .from(aiRunArtifacts)
    .where(and(eq(aiRunArtifacts.id, handle), auth.orgCondition(aiRunArtifacts.orgId)))
    .limit(1);
  return (row as ArtifactRecord | undefined) ?? null;
}

export async function listArtifactsForAuth(runId: string, auth: AuthContext): Promise<ArtifactRecord[]> {
  if (!UUID.safeParse(runId).success) return [];
  const rows = await db
    .select(ARTIFACT_COLUMNS)
    .from(aiRunArtifacts)
    .where(and(eq(aiRunArtifacts.runId, runId), auth.orgCondition(aiRunArtifacts.orgId)))
    .orderBy(desc(aiRunArtifacts.createdAt));
  return rows as ArtifactRecord[];
}

export async function openArtifactStream(record: ArtifactRecord): Promise<NodeJS.ReadableStream> {
  return getBlobStorage().openStream(record.blobKey);
}

export async function deleteArtifact(record: ArtifactRecord): Promise<void> {
  // Blob FIRST. A throw here leaves the row — and therefore the key — findable,
  // which is exactly what makes the sweeper and org erasure rerunnable.
  await getBlobStorage().delete(record.blobKey);
  await db.delete(aiRunArtifacts).where(eq(aiRunArtifacts.id, record.id));
}

/** Wire projection. `blobKey` is omitted BY CONSTRUCTION, not by deletion. */
export function toArtifactDto(record: ArtifactRecord): AiRunArtifactDto {
  return {
    id: record.id,
    runId: record.runId,
    sessionId: record.sessionId,
    kind: record.kind,
    name: record.name,
    contentType: record.contentType,
    bytes: record.bytes,
    sha256: record.sha256,
    headPreview: isTextArtifactContentType(record.contentType) ? record.headPreview : '',
    tailPreview: isTextArtifactContentType(record.contentType) ? record.tailPreview : '',
    sourceDeviceId: record.sourceDeviceId,
    createdByTool: record.createdByTool,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    downloadPath: `/api/v1/ai/artifacts/${record.id}`,
  };
}
