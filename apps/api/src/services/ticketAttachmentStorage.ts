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

export type AttachmentBackend = BlobBackend;
export type AttachmentBytesRow = BlobBytesRow;

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

/** Open a stored attachment's bytes, routing on the row's backend. */
export function openBytes(
  row: AttachmentBytesRow,
): Promise<{ body: Readable | Buffer | null; contentLength: number | null }> {
  return getBlobStream(row);
}

/** Delete one attachment's bytes (object FIRST for an s3 row; spec D9). */
export function deleteBytes(row: AttachmentBytesRow): Promise<void> {
  return deleteBlob(row);
}
