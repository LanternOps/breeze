import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { breezeRegion } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiRunArtifacts, wispThreadAttachments, wispThreads } from '../../db/schema';
import { REDACTED_CAPTURE_NAME_INFIX, createArtifact, sanitizeArtifactName, type ArtifactRecord } from '../artifacts/artifactService';
import { BlobStorageUnavailableError, BlobTooLargeError, getBlobStorage } from '../artifacts/blobStorage';
import { redactForCapture } from '../artifacts/captureRedaction';
import { captureException } from '../sentry';
import { CeilingViolationError, assertWithinCeiling, inSystemContext, type GrantCeiling } from './grantAuthority';
import type { WispThread } from './threads';

/**
 * Wisp W04 (w00 A24) — thread attachments.
 *
 * A user hands Wisp a text file (or pasted text) once; every later session on
 * the same thread can page it back through `read_artifact` by handle. There is
 * no attachment store of its own: the bytes go through the execution plane's
 * artifact store as-is (`createArtifact`), REDACTED FIRST (`redactForCapture`
 * — the store is org-downloadable and must never hold credential material),
 * as an `input_capture` artifact named `<base>.redacted.<ext>` so the
 * redacted-marker predicate of `findArtifactForCallerQuery` admits it. The
 * `wisp_thread_attachments` row is the only link from the thread to the
 * artifact; the reach is `ArtifactCallerAnchor.wispThreadId`.
 *
 * Text only, decided from the DECODED BYTES, never a client Content-Type
 * (`classifyAttachmentBytes`; same posture as routes/tickets/attachments.ts).
 * Caps: 20 live attachments per thread, 5 MiB each. Retention is the artifact
 * store's default (30 days); the sweeper's artifact delete cascades the row.
 *
 * BLOB / TRANSACTION ORDERING (addThreadAttachment). One system transaction:
 * lock the thread row, count, `createArtifact`, insert the attachment row.
 * `createArtifact` puts the blob FIRST and inserts its row SECOND through the
 * ambient transaction, so the artifact row and the attachment row commit or
 * roll back together — there is never an artifact without its attachment row
 * or the reverse, and the count + insert are atomic under the lock (no 21st
 * attachment from two concurrent uploads). The one thing a rollback cannot
 * undo is the blob PUT: when the transaction fails after `createArtifact`
 * returned, the blob is deleted best-effort after the rollback. Only when the
 * failure came from INSIDE the transaction body (a statement error or a typed
 * refusal), never from COMMIT itself: an ambiguous commit may have persisted
 * the row, and a row pointing at a deleted blob 404s forever, whereas an
 * orphaned blob is reaped by the bucket lifecycle rule (artifactService.ts's
 * "blob FIRST, row SECOND" contract). The cost is that the thread row stays
 * locked for the duration of one ≤ 5 MiB blob PUT; only writers of the same
 * thread (one per grant) wait on it.
 */

export const THREAD_ATTACHMENT_MAX_PER_THREAD = 20;
export const THREAD_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const LABEL_MAX_CHARS = 200;
const CREATED_BY_TOOL = 'wisp_thread_attachment';

export type ThreadAttachmentContentType =
  | 'text/plain'
  | 'text/csv'
  | 'text/tab-separated-values'
  | 'message/rfc822'
  | 'application/json';

export type ThreadAttachment = {
  id: string;
  threadId: string;
  orgId: string;
  artifactId: string;
  label: string;
  addedByUserId: string | null;
  contentType: ThreadAttachmentContentType;
  bytes: number;
  expiresAt: Date;
  createdAt: Date;
};

export type ThreadAttachmentErrorCode =
  | 'too_many'
  | 'too_large'
  | 'unsupported_type'
  | 'empty'
  | 'org_outside_ceiling'
  /** A site / permission / tool term of the ceiling refused it (not the org itself). */
  | 'outside_ceiling'
  | 'store_unavailable';

/**
 * The copy a client sees for each code. A `ThreadAttachmentError`'s own
 * `message` is INTERNAL (it can name grants, orgs and limits) and goes to the
 * log only — the route answers with this map, never `err.message`.
 */
export const THREAD_ATTACHMENT_MESSAGES: Record<ThreadAttachmentErrorCode, string> = {
  too_many: `This conversation already has ${THREAD_ATTACHMENT_MAX_PER_THREAD} attachments. Remove one before adding another.`,
  too_large: 'Attachments are limited to 5 MB.',
  unsupported_type: 'Only text attachments are supported.',
  empty: 'The attachment is empty.',
  org_outside_ceiling: "That organization is outside this Wisp delegation, so the file can't be attached there.",
  outside_ceiling: "Your current Wisp grant doesn't allow attaching files here.",
  store_unavailable: "The attachment store isn't available right now. Try again in a moment.",
};

export class ThreadAttachmentError extends Error {
  constructor(
    public readonly code: ThreadAttachmentErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ThreadAttachmentError';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const EXT_CONTENT_TYPE: Record<string, ThreadAttachmentContentType> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  tab: 'text/tab-separated-values',
  eml: 'message/rfc822',
  json: 'application/json',
};

const CONTENT_TYPE_EXT: Record<ThreadAttachmentContentType, string> = {
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'message/rfc822': 'eml',
  'application/json': 'json',
};

function extensionOf(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Content type from the name's extension within the allowed set; JSON only when the text parses. */
function contentTypeFor(name: string | undefined, text: string): ThreadAttachmentContentType {
  const byExt = EXT_CONTENT_TYPE[extensionOf(name)] ?? 'text/plain';
  if (byExt === 'application/json' && !parsesAsJson(text)) return 'text/plain';
  return byExt;
}

/** Text checks shared by the byte classifier and `addThreadAttachment`. */
function textProblem(text: string): 'unsupported_type' | 'empty' | null {
  // Postgres `text` rejects NUL and a NUL byte is the cheapest binary tell.
  if (text.includes('\u0000')) return 'unsupported_type';
  if (text.trim() === '') return 'empty';
  return null;
}

/**
 * Decide whether uploaded bytes are an acceptable text attachment, from the
 * DECODED BYTES only (the client's Content-Type is never consulted). A NUL
 * byte or invalid UTF-8 is `unsupported_type` whatever the filename claims;
 * more than 5 MiB is `too_large`; empty or whitespace-only is `empty`. The
 * content type comes from the filename's extension within the allowed set
 * (fallback `text/plain`; `application/json` only when the text parses).
 */
export function classifyAttachmentBytes(
  bytes: Uint8Array,
  filename?: string,
):
  | { ok: true; text: string; contentType: ThreadAttachmentContentType; ext: string }
  | { ok: false; code: 'unsupported_type' | 'empty' | 'too_large' } {
  if (bytes.byteLength > THREAD_ATTACHMENT_MAX_BYTES) return { ok: false, code: 'too_large' };
  if (bytes.includes(0)) return { ok: false, code: 'unsupported_type' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'unsupported_type' };
  }
  const problem = textProblem(text);
  if (problem) return { ok: false, code: problem };
  const contentType = contentTypeFor(filename, text);
  return { ok: true, text, contentType, ext: CONTENT_TYPE_EXT[contentType] };
}

/**
 * One line, no control characters (a newline in a label must not forge an
 * extra seed line), ≤ 200 chars (the column).
 */
function normaliseLabel(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, LABEL_MAX_CHARS).trim() || 'attachment';
}

/**
 * `<base>.redacted.<ext>`, ≤ 200 chars. The base is cut BEFORE the suffix is
 * added: `createArtifact` re-sanitises to 200 chars, and a cut there would
 * drop the redacted marker `read_artifact` requires.
 */
function artifactNameFor(label: string, ext: string): string {
  const suffix = `${REDACTED_CAPTURE_NAME_INFIX}${ext}`;
  const withoutExt = label.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const base = sanitizeArtifactName(withoutExt).slice(0, 200 - suffix.length).trim() || 'attachment';
  return `${base}${suffix}`;
}

/** '' for none; else one line per item: `- <label> — handle <artifactId> (<bytes> B, <contentType>)`. */
export function attachmentSeedLines(items: ThreadAttachment[]): string {
  return items
    .map((a) => `- ${a.label} — handle ${a.artifactId} (${a.bytes} B, ${a.contentType})`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Joined `wisp_thread_attachments` × `ai_run_artifacts` projection. */
const ATTACHMENT_COLUMNS = {
  id: wispThreadAttachments.id,
  threadId: wispThreadAttachments.threadId,
  orgId: wispThreadAttachments.orgId,
  artifactId: wispThreadAttachments.artifactId,
  label: wispThreadAttachments.label,
  addedByUserId: wispThreadAttachments.addedByUserId,
  contentType: aiRunArtifacts.contentType,
  bytes: aiRunArtifacts.bytes,
  expiresAt: aiRunArtifacts.expiresAt,
  createdAt: wispThreadAttachments.createdAt,
} as const;

export async function addThreadAttachment(input: {
  thread: WispThread;
  ceiling: GrantCeiling;
  orgId: string;
  label: string;
  text: string;
  addedByUserId: string;
  /**
   * The type `classifyAttachmentBytes` picked for an uploaded file. Optional:
   * without it the type is derived from `label`'s extension the same way.
   */
  contentType?: ThreadAttachmentContentType;
}): Promise<ThreadAttachment> {
  const { thread, ceiling, orgId, addedByUserId } = input;

  // Authority first, before any write: the org must be inside the grant's
  // ceiling NOW, and the thread must belong to that grant's partner.
  try {
    assertWithinCeiling(ceiling, { orgId });
  } catch (err) {
    // An inactive grant is not an org problem — let its own error through.
    if (err instanceof CeilingViolationError && err.code !== 'inactive') {
      throw new ThreadAttachmentError(err.code === 'org' ? 'org_outside_ceiling' : 'outside_ceiling', err.message, { cause: err });
    }
    throw err;
  }
  if (thread.partnerId !== ceiling.partnerId || thread.grantId !== ceiling.grantId) {
    throw new ThreadAttachmentError('org_outside_ceiling', 'the thread does not belong to this delegation grant');
  }

  const problem = textProblem(input.text);
  if (problem) throw new ThreadAttachmentError(problem, problem === 'empty' ? 'the attachment is empty' : 'only text attachments are supported');
  if (Buffer.byteLength(input.text, 'utf8') > THREAD_ATTACHMENT_MAX_BYTES) {
    throw new ThreadAttachmentError('too_large', `attachments are limited to ${THREAD_ATTACHMENT_MAX_BYTES} bytes`);
  }

  const label = normaliseLabel(input.label);
  const contentType = input.contentType ?? contentTypeFor(label, input.text);
  const name = artifactNameFor(label, CONTENT_TYPE_EXT[contentType]);
  // Redact-then-store (A-W05 Q5): pure, so it runs before the transaction.
  const body = Buffer.from(redactForCapture(input.text), 'utf8');

  let stored: ArtifactRecord | null = null;
  let bodyCompleted = false;
  try {
    // Its OWN top-level transaction, never joined to an ambient one: the
    // blob compensation below relies on a failure here meaning a rollback.
    const result = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [locked] = await db
        .select({ id: wispThreads.id })
        .from(wispThreads)
        .where(and(eq(wispThreads.id, thread.id), eq(wispThreads.partnerId, thread.partnerId)))
        .for('update');
      if (!locked) throw new Error(`wisp thread ${thread.id} not found`);

      const [live] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(wispThreadAttachments)
        .innerJoin(aiRunArtifacts, eq(aiRunArtifacts.id, wispThreadAttachments.artifactId))
        .where(and(eq(wispThreadAttachments.threadId, thread.id), gt(aiRunArtifacts.expiresAt, sql`now()`)));
      if (Number(live?.n ?? 0) >= THREAD_ATTACHMENT_MAX_PER_THREAD) {
        throw new ThreadAttachmentError('too_many', `a thread holds at most ${THREAD_ATTACHMENT_MAX_PER_THREAD} attachments`);
      }

      try {
        stored = await createArtifact({
          orgId,
          runId: null,
          sessionId: null,
          kind: 'input_capture',
          name,
          contentType,
          body,
          maxBytes: THREAD_ATTACHMENT_MAX_BYTES,
          createdByTool: CREATED_BY_TOOL,
          region: breezeRegion(),
        });
      } catch (err) {
        if (err instanceof BlobTooLargeError) {
          throw new ThreadAttachmentError('too_large', `attachments are limited to ${THREAD_ATTACHMENT_MAX_BYTES} bytes after redaction`, { cause: err });
        }
        if (err instanceof BlobStorageUnavailableError) {
          throw new ThreadAttachmentError('store_unavailable', 'the attachment store is unavailable', { cause: err });
        }
        throw err;
      }
      const artifact: ArtifactRecord = stored;

      const [row] = await db
        .insert(wispThreadAttachments)
        .values({
          threadId: thread.id,
          partnerId: thread.partnerId,
          orgId,
          artifactId: artifact.id,
          addedByUserId,
          label,
        })
        .returning({
          id: wispThreadAttachments.id,
          threadId: wispThreadAttachments.threadId,
          orgId: wispThreadAttachments.orgId,
          artifactId: wispThreadAttachments.artifactId,
          label: wispThreadAttachments.label,
          addedByUserId: wispThreadAttachments.addedByUserId,
          createdAt: wispThreadAttachments.createdAt,
        });
      if (!row) throw new Error('wisp_thread_attachments insert returned no row');

      bodyCompleted = true;
      return {
        ...row,
        contentType,
        bytes: artifact.bytes,
        expiresAt: artifact.expiresAt,
      } satisfies ThreadAttachment;
    }, 'wisp.threadAttachments.add'));
    return result;
  } catch (err) {
    const orphan = stored as ArtifactRecord | null;
    if (orphan && !bodyCompleted) {
      // The body threw after the blob PUT → the transaction rolled back the
      // artifact row, so nothing will ever index this key. A commit-time
      // failure (bodyCompleted) is ambiguous and keeps the blob.
      try {
        await getBlobStorage().delete(orphan.blobKey);
      } catch (cleanupErr) {
        captureException(cleanupErr);
        console.error('[wisp] compensating blob delete failed after a rolled-back thread attachment', cleanupErr);
      }
    }
    throw err;
  }
}

/** Live attachments of a thread (artifact not expired), newest first. */
export async function listThreadAttachments(threadId: string): Promise<ThreadAttachment[]> {
  const rows = await inSystemContext(() =>
    db
      .select(ATTACHMENT_COLUMNS)
      .from(wispThreadAttachments)
      .innerJoin(aiRunArtifacts, eq(aiRunArtifacts.id, wispThreadAttachments.artifactId))
      .where(and(eq(wispThreadAttachments.threadId, threadId), gt(aiRunArtifacts.expiresAt, sql`now()`)))
      .orderBy(desc(wispThreadAttachments.createdAt), desc(wispThreadAttachments.id)),
  );
  return rows.map((r) => ({ ...r, contentType: asAttachmentContentType(r.contentType) }));
}

/**
 * The stored artifact type, narrowed. Only `addThreadAttachment` writes these
 * rows, always with a `ThreadAttachmentContentType`; anything else (a row
 * edited by hand) is shown as plain text rather than trusted.
 */
function asAttachmentContentType(raw: string): ThreadAttachmentContentType {
  return Object.hasOwn(CONTENT_TYPE_EXT, raw) ? (raw as ThreadAttachmentContentType) : 'text/plain';
}
