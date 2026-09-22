import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { quoteAcceptances } from '../db/schema/quotes';
import { BlobStorageError, deleteBlob, getBlobStream, putBlob, type BlobBackend } from './blobStorage';
import { sniffAttachmentMime } from './attachmentSniff';
import { sanitizeAttachmentFilename } from './attachmentFilename';

/**
 * Evidence file on an accept-on-behalf acceptance (#6633; spec
 * 2026-09-21-quote-accept-on-behalf-design.md §3/§12 follow-up).
 *
 * - ONE file per acceptance, held in the `evidence_*` columns of the
 *   acceptance row itself; a new upload replaces the previous file.
 * - Only the quote's LATEST acceptance, and only when it is `on_behalf`. A
 *   customer acceptance is its own record and never takes an MSP-supplied file
 *   (the DB CHECK quote_acceptances_evidence_origin_chk is the backstop).
 * - The quote row is never touched, so a converted (frozen) quote accepts the
 *   file without being reopened.
 * - Bytes go through services/blobStorage.ts: backend chosen once at upload,
 *   put-before-update, and an update failure deletes the just-put object. The
 *   key is `quote-acceptance-evidence/<uuid>` with no tenant identifier (D8).
 *   Org erasure clears these objects via tenantCascade OBJECT_PRECLEAR_TABLES.
 * - Type is sniffed from the bytes (PDF, PNG, JPEG); the client's
 *   Content-Type is never consulted.
 * - Admin-only. Nothing here is reachable from the customer portal or the
 *   public token routes.
 *
 * Callers must have already enforced org access to the quote (the routes call
 * the org-scoped getQuote first); every query here is additionally filtered by
 * `orgId` on top of the shape-1 RLS policy.
 */

export const QUOTE_ACCEPTANCE_EVIDENCE_PREFIX = 'quote-acceptance-evidence';
export const QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const QUOTE_ACCEPTANCE_EVIDENCE_MIMES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type QuoteAcceptanceEvidenceMime = (typeof QUOTE_ACCEPTANCE_EVIDENCE_MIMES)[number];

export type AcceptanceEvidenceErrorCode =
  | 'QUOTE_NOT_ACCEPTED'
  | 'ACCEPTANCE_NOT_ON_BEHALF'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_EVIDENCE_TYPE'
  | 'EVIDENCE_NOT_FOUND'
  | 'STORAGE_UNAVAILABLE';

export class AcceptanceEvidenceError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 413 | 415 | 503,
    public readonly code: AcceptanceEvidenceErrorCode,
  ) {
    super(message);
    this.name = 'AcceptanceEvidenceError';
  }
}

/** What the admin quote detail and the upload response expose. Never the key. */
export interface AcceptanceEvidenceMeta {
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

/**
 * The evidence METADATA columns — never `evidenceData`. Any read of
 * quote_acceptances that is not the byte-serving path below must select from
 * this (or narrower), or it drags up to 10 MB of inline bytes per row.
 */
export const QUOTE_ACCEPTANCE_EVIDENCE_META = {
  evidenceStorageBackend: quoteAcceptances.evidenceStorageBackend,
  evidenceStorageKey: quoteAcceptances.evidenceStorageKey,
  evidenceFilename: quoteAcceptances.evidenceFilename,
  evidenceContentType: quoteAcceptances.evidenceContentType,
  evidenceSizeBytes: quoteAcceptances.evidenceSizeBytes,
  evidenceSha256: quoteAcceptances.evidenceSha256,
  evidenceUploadedAt: quoteAcceptances.evidenceUploadedAt,
} as const;

type EvidenceMetaRow = {
  evidenceStorageBackend: BlobBackend | null;
  evidenceStorageKey: string | null;
  evidenceFilename: string | null;
  evidenceContentType: string | null;
  evidenceSizeBytes: number | null;
  evidenceSha256: string | null;
  evidenceUploadedAt: Date | null;
};

/** Project a row's evidence columns to the client shape; null when there is none. */
export function toAcceptanceEvidenceMeta(row: EvidenceMetaRow): AcceptanceEvidenceMeta | null {
  if (!row.evidenceStorageBackend || !row.evidenceFilename || !row.evidenceContentType
    || row.evidenceSizeBytes == null || !row.evidenceUploadedAt) {
    return null;
  }
  return {
    filename: row.evidenceFilename,
    contentType: row.evidenceContentType,
    sizeBytes: row.evidenceSizeBytes,
    uploadedAt: row.evidenceUploadedAt.toISOString(),
  };
}

/** Magic-byte sniff restricted to the evidence types. WebP is a ticket
 *  attachment type but not an evidence type. */
export function sniffEvidenceMime(buf: Buffer): QuoteAcceptanceEvidenceMime | null {
  const mime = sniffAttachmentMime(buf);
  return mime && (QUOTE_ACCEPTANCE_EVIDENCE_MIMES as readonly string[]).includes(mime)
    ? (mime as QuoteAcceptanceEvidenceMime)
    : null;
}

async function loadLatestAcceptance(quoteId: string, orgId: string) {
  const [row] = await db
    .select({ id: quoteAcceptances.id, origin: quoteAcceptances.origin, ...QUOTE_ACCEPTANCE_EVIDENCE_META })
    .from(quoteAcceptances)
    .where(and(eq(quoteAcceptances.quoteId, quoteId), eq(quoteAcceptances.orgId, orgId)))
    // Same "latest" rule as the admin detail and the portal read.
    .orderBy(desc(quoteAcceptances.signedAt))
    .limit(1);
  return row as ({ id: string; origin: string } & EvidenceMetaRow) | undefined;
}

export interface AttachEvidenceResult {
  acceptanceId: string;
  evidence: AcceptanceEvidenceMeta;
  sha256: string;
  replaced: boolean;
}

export async function attachAcceptanceEvidence(args: {
  quoteId: string;
  orgId: string;
  actorUserId: string | null;
  file: { buffer: Buffer; filename: string };
}): Promise<AttachEvidenceResult> {
  const latest = await loadLatestAcceptance(args.quoteId, args.orgId);
  if (!latest) {
    throw new AcceptanceEvidenceError('This quote has no recorded acceptance', 409, 'QUOTE_NOT_ACCEPTED');
  }
  if (latest.origin !== 'on_behalf') {
    throw new AcceptanceEvidenceError(
      'Evidence can only be attached to an acceptance recorded on behalf of the customer',
      409,
      'ACCEPTANCE_NOT_ON_BEHALF',
    );
  }

  const { buffer } = args.file;
  if (buffer.length === 0) throw new AcceptanceEvidenceError('The evidence file is empty', 400, 'EMPTY_FILE');
  if (buffer.length > QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES) {
    throw new AcceptanceEvidenceError('Evidence file too large (max 10 MB)', 413, 'FILE_TOO_LARGE');
  }
  const contentType = sniffEvidenceMime(buffer);
  if (!contentType) {
    throw new AcceptanceEvidenceError('Evidence must be a PDF, PNG or JPEG file', 415, 'UNSUPPORTED_EVIDENCE_TYPE');
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const filename = sanitizeAttachmentFilename(args.file.filename);

  let stored: { backend: BlobBackend; storageKey: string | null; data: Buffer | null };
  try {
    stored = await putBlob({ prefix: QUOTE_ACCEPTANCE_EVIDENCE_PREFIX, id: randomUUID(), buffer, contentType, sha256 });
  } catch (err) {
    if (err instanceof BlobStorageError) {
      throw new AcceptanceEvidenceError('Evidence storage is unavailable; try again shortly', 503, 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }

  const uploadedAt = new Date();
  let previous: EvidenceMetaRow | undefined;
  try {
    // Nested transaction = SAVEPOINT under the request's context. The row is
    // locked before its old key is read, so two concurrent uploads serialise
    // and each one deletes exactly the object the other replaced.
    previous = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select(QUOTE_ACCEPTANCE_EVIDENCE_META)
        .from(quoteAcceptances)
        .where(and(eq(quoteAcceptances.id, latest.id), eq(quoteAcceptances.orgId, args.orgId)))
        .for('update');
      const [updated] = await tx
        .update(quoteAcceptances)
        .set({
          evidenceStorageBackend: stored.backend,
          evidenceStorageKey: stored.storageKey,
          evidenceData: stored.data,
          evidenceFilename: filename,
          evidenceContentType: contentType,
          evidenceSizeBytes: buffer.length,
          evidenceSha256: sha256,
          evidenceUploadedAt: uploadedAt,
          evidenceUploadedByUserId: args.actorUserId,
        })
        .where(and(
          eq(quoteAcceptances.id, latest.id),
          eq(quoteAcceptances.orgId, args.orgId),
          eq(quoteAcceptances.origin, 'on_behalf'),
        ))
        .returning({ id: quoteAcceptances.id });
      if (!updated) throw new Error('quote_acceptances evidence update matched no row');
      return locked as EvidenceMetaRow | undefined;
    });
  } catch (err) {
    try {
      await deleteBlob({ storageBackend: stored.backend, storageKey: stored.storageKey, data: null });
    } catch (cleanupErr) {
      // Never mask the update fault. The object is orphaned under an opaque key
      // with no row pointing at it; log enough to find it.
      console.error('[quoteAcceptanceEvidence] failed to delete object after update failure', {
        acceptanceId: latest.id, storageKey: stored.storageKey,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    throw err;
  }

  const replaced = !!previous?.evidenceStorageBackend;
  if (previous?.evidenceStorageBackend === 's3' && previous.evidenceStorageKey
    && previous.evidenceStorageKey !== stored.storageKey) {
    // The row already points at the new file; the old object is now
    // unreferenced. A failure here leaves an orphan, never a broken row — log
    // the key so it can be removed by hand.
    try {
      await deleteBlob({ storageBackend: 's3', storageKey: previous.evidenceStorageKey, data: null });
    } catch (err) {
      console.error('[quoteAcceptanceEvidence] failed to delete replaced evidence object', {
        acceptanceId: latest.id, storageKey: previous.evidenceStorageKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    acceptanceId: latest.id,
    evidence: { filename, contentType, sizeBytes: buffer.length, uploadedAt: uploadedAt.toISOString() },
    sha256,
    replaced,
  };
}

export interface OpenedEvidence {
  meta: AcceptanceEvidenceMeta;
  body: Readable | Buffer;
  contentLength: number | null;
}

/** Open the latest acceptance's evidence bytes. 404 when there is none. */
export async function openAcceptanceEvidence(args: { quoteId: string; orgId: string }): Promise<OpenedEvidence> {
  const latest = await loadLatestAcceptance(args.quoteId, args.orgId);
  const meta = latest ? toAcceptanceEvidenceMeta(latest) : null;
  if (!latest || !meta || !latest.evidenceStorageBackend) {
    throw new AcceptanceEvidenceError('No evidence file is attached to this acceptance', 404, 'EVIDENCE_NOT_FOUND');
  }
  let data: Buffer | null = null;
  if (latest.evidenceStorageBackend === 'db') {
    const [row] = await db
      .select({ evidenceData: quoteAcceptances.evidenceData })
      .from(quoteAcceptances)
      .where(and(eq(quoteAcceptances.id, latest.id), eq(quoteAcceptances.orgId, args.orgId)))
      .limit(1);
    data = row?.evidenceData ?? null;
  }
  let opened: Awaited<ReturnType<typeof getBlobStream>>;
  try {
    opened = await getBlobStream({ storageBackend: latest.evidenceStorageBackend, storageKey: latest.evidenceStorageKey, data });
  } catch (err) {
    if (err instanceof BlobStorageError) {
      throw new AcceptanceEvidenceError('Evidence storage is unavailable; try again shortly', 503, 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }
  if (!opened.body) {
    console.error('[quoteAcceptanceEvidence] evidence object missing for row', {
      acceptanceId: latest.id, backend: latest.evidenceStorageBackend, storageKey: latest.evidenceStorageKey,
    });
    throw new AcceptanceEvidenceError('No evidence file is attached to this acceptance', 404, 'EVIDENCE_NOT_FOUND');
  }
  return { meta, body: opened.body, contentLength: opened.contentLength };
}
