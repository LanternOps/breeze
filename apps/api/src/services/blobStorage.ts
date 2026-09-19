import type { Readable } from 'node:stream';
import { deleteObjects, getObjectStream, isS3Configured, putObjectBuffer } from './s3Storage';

/**
 * Generic blob byte lifecycle (extracted from ticket attachments W08 #3902,
 * spec D1/D8; shared with org documents by service deliverables W03).
 *
 * KEY RULE: backend selection happens ONCE, at upload time. A row's
 * `storage_backend` is authoritative forever after — rows written before an
 * operator configured S3 keep serving from `data`, and rows written after keep
 * serving from the bucket. Nothing here ever re-derives a row's backend from
 * the current environment, and nothing ever falls back from 's3' to 'db': a
 * silent fallback would scatter one tenant's bytes across two stores, so an S3
 * fault on the upload path is a 503 (`STORAGE_UNAVAILABLE`) and no row is
 * written.
 *
 * Object keys carry NO tenant identifier (spec D8) — an org or device move
 * re-stamps `org_id` on rows only, and objects never move. The `prefix` is the
 * SURFACE (`ticket-attachments`, `org-documents`), never a tenant.
 */

export class BlobStorageError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE' as const;
  readonly status = 503 as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BlobStorageError';
  }
}

export type BlobBackend = 's3' | 'db';

/** Minimal row shape the byte paths need — deliberately not the full Drizzle row. */
export interface BlobBytesRow {
  storageBackend: BlobBackend;
  storageKey: string | null;
  data: Buffer | null;
}

/** 's3' when the platform bucket is configured, else inline bytea. */
export function selectBackend(): BlobBackend {
  return isS3Configured() ? 's3' : 'db';
}

/** Opaque object key — surface prefix plus row id, never an org/ticket id. */
export function objectKeyFor(prefix: string, id: string): string {
  return `${prefix}/${id}`;
}

/**
 * Write the bytes for a not-yet-inserted row.
 *
 * Put-before-insert: a put failure leaves no row at all; the caller compensates
 * an INSERT failure with `deleteBlob`. Throws `BlobStorageError` (503) when the
 * S3 backend is selected and the put fails — it NEVER degrades to `db`.
 */
export async function putBlob(args: {
  prefix: string;
  id: string;
  buffer: Buffer;
  contentType: string;
  sha256: string;
}): Promise<{ backend: BlobBackend; storageKey: string | null; data: Buffer | null }> {
  const backend = selectBackend();
  if (backend === 'db') {
    return { backend, storageKey: null, data: args.buffer };
  }
  const storageKey = objectKeyFor(args.prefix, args.id);
  try {
    await putObjectBuffer(storageKey, args.buffer, args.contentType, args.sha256);
  } catch (err) {
    throw new BlobStorageError('Blob storage is unavailable', { cause: err });
  }
  return { backend, storageKey, data: null };
}

/**
 * Open a stored blob's bytes. Routes on the ROW's backend, never on whether
 * `storageKey` happens to be populated. A `body` of null means the object is
 * genuinely absent (serve a 404 and log); a transport fault throws.
 */
export async function getBlobStream(
  row: BlobBytesRow,
): Promise<{ body: Readable | Buffer | null; contentLength: number | null }> {
  if (row.storageBackend === 'db') {
    const data = row.data ?? null;
    return { body: data, contentLength: data ? data.length : null };
  }
  if (!row.storageKey) return { body: null, contentLength: null };
  try {
    return await getObjectStream(row.storageKey);
  } catch (err) {
    throw new BlobStorageError('Blob storage is unavailable', { cause: err });
  }
}

/**
 * Delete the bytes for one row. A `db` row is a no-op — the row DELETE (or the
 * UPDATE that clears `data`) carries its own bytes. An `s3` row deletes the
 * object FIRST so a failure leaves the row (and therefore the key) findable;
 * see spec D9.
 */
export async function deleteBlob(row: BlobBytesRow): Promise<void> {
  if (row.storageBackend !== 's3' || !row.storageKey) return;
  await deleteObjects([row.storageKey]);
}

/** Batch object delete for reapers and the org-erasure pre-clear (spec D9). */
export async function deleteBlobKeys(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await deleteObjects(keys);
}
