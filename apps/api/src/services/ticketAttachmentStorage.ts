import type { Readable } from 'node:stream';
import {
  deleteBlob,
  getBlobStream,
  objectKeyFor as blobObjectKeyFor,
  putBlob,
  selectBackend as selectBlobBackend,
  type BlobBackend,
  type BlobBytesRow,
} from './blobStorage';

/**
 * Ticket attachment byte lifecycle (W08 #3902, spec D1/D8).
 *
 * A thin binding over `./blobStorage` with the `ticket-attachments` key prefix.
 * The invariants — backend chosen once at upload, never falling back from 's3'
 * to 'db', object keys carrying no tenant identifier — live in blobStorage.ts.
 *
 * `AttachmentStorageError` is an ALIAS of `BlobStorageError`, not a subclass:
 * one 503 fault type means `putBytes` can delegate without a rewrap, and every
 * existing `instanceof AttachmentStorageError` check keeps matching. The only
 * observable change is `err.name`, now `'BlobStorageError'`; which surface
 * faulted is already carried by the route's own error code and Sentry
 * breadcrumb.
 */

export { BlobStorageError as AttachmentStorageError, deleteBlobKeys as deleteObjectKeys } from './blobStorage';

/**
 * Execution plane W05 (spec §6.3) — a third backend beside the blob store's
 * own two. `BlobBackend` is deliberately NOT widened: the generic blob store
 * knows how to own bytes, and an `artifact` row owns none. It is a POINTER to
 * an `ai_run_artifacts` row, whose lifetime (30-day TTL, its own sweeper) the
 * attachment does not control.
 */
export type AttachmentBackend = BlobBackend | 'artifact';

/**
 * Raised when an artifact-backed attachment's artifact is gone — expired by the
 * 30-day sweeper, or erased with its org. DISTINCT from "attachment not found"
 * on purpose: the ticket still records that a file was attached and by whom,
 * and a technician deserves "this expired" rather than a 404 that suggests they
 * misremembered.
 */
export class AttachmentExpiredError extends Error {
  code = 'ATTACHMENT_EXPIRED';

  status = 410;

  constructor(message = 'This attachment has expired and is no longer stored') {
    super(message);
    this.name = 'AttachmentExpiredError';
  }
}

export interface AttachmentBytesRow {
  storageBackend: AttachmentBackend;
  storageKey: string | null;
  data: Buffer | null;
  /** Set only for `storage_backend = 'artifact'`; null once the artifact expired. */
  artifactId?: string | null;
}

/** Ticket attachments' object-key namespace (spec D8). */
export const TICKET_ATTACHMENT_PREFIX = 'ticket-attachments';

/** 's3' when the platform bucket is configured, else inline bytea. */
export function selectBackend(): AttachmentBackend {
  return selectBlobBackend();
}

/** Opaque object key — attachment id only, never an org/ticket id (spec D8). */
export function objectKeyFor(attachmentId: string): string {
  return blobObjectKeyFor(TICKET_ATTACHMENT_PREFIX, attachmentId);
}

/** Put-before-insert; throws `AttachmentStorageError` (503) on an S3 fault. */
export function putBytes(
  attachmentId: string,
  buf: Buffer,
  contentType: string,
  sha256: string,
): Promise<{ backend: AttachmentBackend; storageKey: string | null; data: Buffer | null }> {
  return putBlob({ prefix: TICKET_ATTACHMENT_PREFIX, id: attachmentId, buffer: buf, contentType, sha256 });
}

/**
 * Open a stored attachment's bytes, routing on the row's backend.
 *
 * `scope` is required for an `artifact` row and ignored otherwise: the handle is
 * resolved against exactly ONE org, never the caller's accessible set, because
 * `resolveArtifact` is what enforces tenancy on the artifact side. Called
 * without it, an artifact row raises `AttachmentExpiredError` rather than
 * resolving unscoped.
 */
export async function openBytes(
  row: AttachmentBytesRow,
  scope?: { orgId: string },
): Promise<{ body: Readable | Buffer | null; contentLength: number | null }> {
  if (row.storageBackend === 'artifact') {
    if (!row.artifactId || !scope) throw new AttachmentExpiredError();
    // Imported LAZILY, and it must stay that way. `artifactService` reads
    // `aiRunArtifacts` off the `db/schema` barrel, and this module is in the
    // static graph of every ticket and portal-ticket route. A top-level import
    // put that table into those routes' module graphs, which broke five suites
    // whose partial `vi.mock('../../db/schema')` factories do not declare it —
    // and would keep breaking new ones. Deferring it costs one dynamic import
    // on the artifact path only, which is already doing network I/O.
    const { resolveArtifact, openArtifactStream } = await import('./artifacts/artifactService');
    const record = await resolveArtifact(row.artifactId, { orgId: scope.orgId });
    if (!record) throw new AttachmentExpiredError();
    return {
      body: (await openArtifactStream(record)) as unknown as Readable,
      contentLength: record.bytes,
    };
  }
  return getBlobStream(row as BlobBytesRow);
}

/** Delete one attachment's bytes (object FIRST for an s3 row; spec D9). */
export async function deleteBytes(row: AttachmentBytesRow): Promise<void> {
  // An artifact-backed row is a POINTER. Deleting the attachment must not
  // delete the artifact: the same artifact can be attached to several tickets
  // and is still listed on its run page. The 30-day sweeper owns its lifetime.
  if (row.storageBackend === 'artifact') return;
  return deleteBlob(row as BlobBytesRow);
}
