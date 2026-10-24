import { createHash } from 'node:crypto';
import { MigrationWindowError } from '../migrationWindows';
import type { ImportedAttachmentClaim } from '../ticketService';
import { putBytes } from '../ticketAttachmentStorage';
import {
  fetchedBytesSkip,
  IMPORT_ATTACHMENT_MAX_BYTES,
  sniffImportedAttachment,
  type ImportAttachmentSkipReason,
} from './importAttachments';

/**
 * The store step of an imported attachment (#8313 W1; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §4.3 step 2), between its reservation and its claim. It runs with no DB
 * context (F21): a download and a put must never hold a pooled connection.
 */

/**
 * Reads one source file's original bytes, at most `maxBytes` (the module's
 * `ImportTicketOptions.fetchAttachment`). Its failures say whether they are
 * permanent: an `ImportAttachmentFetchError` with `not_found` (the source
 * answers 404 or 403 for the file) or `too_large` (the file is over
 * `maxBytes`) skips the file for good. Anything else, including an
 * `ImportAttachmentFetchError` with `transient` (a timeout, a 5xx after the
 * module's own retries), fails the ticket for this pass and keeps its pending
 * rows, so the next run retries the file. A transient failure never becomes a
 * permanent skip, or a repeat pass could not recover the file.
 */
export type FetchImportAttachment = (sourceId: string, maxBytes: number) => Promise<Uint8Array>;

export type ImportAttachmentFetchFailure = 'not_found' | 'too_large' | 'transient';

export class ImportAttachmentFetchError extends Error {
  constructor(
    public readonly failure: ImportAttachmentFetchFailure,
    message = `The source file could not be read (${failure})`,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ImportAttachmentFetchError';
  }

  get permanent(): boolean {
    return this.failure !== 'transient';
  }
}

export type StoreOutcome =
  | { kind: 'stored'; claim: ImportedAttachmentClaim }
  | { kind: 'skipped'; reason: ImportAttachmentSkipReason };

function transient(attachmentSourceId: string, stage: 'fetch' | 'store', cause: unknown): MigrationWindowError {
  return new MigrationWindowError(
    'TICKET_IMPORT_ATTACHMENT_UNAVAILABLE',
    'An attachment could not be read from the source or stored; the ticket is retried on the next run',
    503,
    { attachmentSourceId, stage },
    { cause },
  );
}

/**
 * Stores one reserved file (§4.3 step 2): charges the byte bucket with the
 * declared size (the cap when none is declared), downloads the original with
 * `maxBytes` = 10 MiB, sniffs it (§4.4), hashes it and puts it to the
 * reserved key `ticket-attachments/<id>`, overwriting any earlier put of a
 * crashed pass. A permanent failure returns the skip and puts nothing; a
 * transient one throws `503 TICKET_IMPORT_ATTACHMENT_UNAVAILABLE`, and a
 * refused byte charge `429 MIGRATION_WINDOW_RATE_LIMITED`. Either way the
 * reservation stays for the next run, or for the reaper.
 */
export async function storeReservedAttachment(input: {
  id: string;
  sourceId: string;
  declaredBytes?: number;
  fetchAttachment: FetchImportAttachment;
  chargeBytes: (bytes: number) => Promise<void>;
}): Promise<StoreOutcome> {
  const declared = input.declaredBytes;
  await input.chargeBytes(declared !== undefined && declared > 0 ? Math.min(declared, IMPORT_ATTACHMENT_MAX_BYTES) : IMPORT_ATTACHMENT_MAX_BYTES);

  let bytes: Uint8Array;
  try {
    bytes = await input.fetchAttachment(input.sourceId, IMPORT_ATTACHMENT_MAX_BYTES);
  } catch (err) {
    if (err instanceof ImportAttachmentFetchError && err.permanent) {
      return { kind: 'skipped', reason: err.failure as ImportAttachmentSkipReason };
    }
    throw transient(input.sourceId, 'fetch', err);
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sizeSkip = fetchedBytesSkip(buf.length);
  if (sizeSkip) return { kind: 'skipped', reason: sizeSkip };
  const sniffed = sniffImportedAttachment(buf);
  if (sniffed.blocked) return { kind: 'skipped', reason: 'blocked_type' };

  const sha256 = createHash('sha256').update(buf).digest('hex');
  let stored: Awaited<ReturnType<typeof putBytes>>;
  try {
    stored = await putBytes(input.id, buf, sniffed.contentType, sha256);
  } catch (err) {
    throw transient(input.sourceId, 'store', err);
  }
  // The reservation names an 's3' key, and putBytes selects the backend
  // itself: an import never lands bytes in `data` (§4.1).
  if (stored.backend !== 's3') {
    throw new MigrationWindowError(
      'TICKET_IMPORT_OBJECT_STORAGE_REQUIRED',
      'Importing attachments needs object storage (S3)',
      409,
      { attachmentSourceId: input.sourceId },
    );
  }
  return { kind: 'stored', claim: { id: input.id, contentType: sniffed.contentType, byteSize: buf.length, sha256 } };
}
