import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { and, asc, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { TICKET_ATTACHMENT_LIMITS, type OrgDocumentCategory } from '@breeze/shared';
import { db } from '../db';
import { orgDocuments, ORG_DOCUMENT_META_COLUMNS } from '../db/schema/orgDocuments';
import { BlobStorageError, deleteBlob, deleteBlobKeys, getBlobStream, putBlob, type BlobBackend } from './blobStorage';
import { sniffAttachmentMime } from './attachmentSniff';
import { sanitizeAttachmentFilename } from './attachmentFilename';
import { DeliverableServiceError, type DeliverableActor } from './serviceDeliverableService';
import { isPgUniqueViolation } from '../utils/pgErrors';

/**
 * Organization document library (service deliverables W03, spec #5573 §4.4,
 * §10, §12). The ONLY writer of `org_documents`.
 *
 * - Every read and write filters by `orgId` as well as the row id — defence in
 *   depth on top of the shape-1 RLS policies. A foreign org, a missing row and
 *   a soft-deleted row are all the same 404 `NOT_FOUND` (never 403).
 * - Bytes are validated by magic-byte sniff only; the client's Content-Type is
 *   never consulted, and the stored `content_type` is the sniffed one.
 * - Put-before-insert: a storage fault writes no row (503); an INSERT fault
 *   deletes the just-put object without masking the original error.
 * - Versions are a backwards linked list (a new document points at the one it
 *   replaces). Only a chain HEAD can be replaced, superseded, or deleted; the
 *   unique index on `supersedes_document_id` is the DB backstop for a lost race.
 * - Delete acts on the DOCUMENT, i.e. every version of the chain from its head:
 *   objects first, then one tombstone UPDATE, so a storage fault leaves every
 *   row (and therefore every key) findable and the delete retryable. Deleting a
 *   single version would strand its predecessor behind a tombstone that still
 *   holds the chain's unique successor slot.
 */

export const ORG_DOCUMENT_PREFIX = 'org-documents';

export interface UploadFile { buffer: Buffer; contentType: string; filename: string }

export interface OrgDocumentView {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  category: OrgDocumentCategory;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string;
  uploadedByUserId: string | null;
  portalVisible: boolean;
  supersedesDocumentId: string | null;
  supersededByDocumentId: string | null;
  createdAt: string;
}

export interface DocumentMetadataPatch {
  title?: string;
  description?: string | null;
  category?: OrgDocumentCategory;
  portalVisible?: boolean;
}

type MetaRow = Omit<OrgDocumentView, 'supersededByDocumentId' | 'createdAt'> & { createdAt: Date };

/** Guards the chain walk against a corrupt (cyclic) chain; real chains are short. */
const MAX_CHAIN_LENGTH = 1000;

const notFound = () => new DeliverableServiceError('Not found', 404, 'NOT_FOUND');
const notHead = (message = 'This document has been replaced by a newer version; act on the current version instead') =>
  new DeliverableServiceError(message, 409, 'NOT_HEAD');
const storageUnavailable = () => new DeliverableServiceError('Document storage is unavailable; try again shortly', 503, 'STORAGE_UNAVAILABLE');

function requireOrgAccess(actor: DeliverableActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) throw notFound();
}

function toView(row: MetaRow, supersededByDocumentId: string | null): OrgDocumentView {
  return { ...row, supersededByDocumentId, createdAt: row.createdAt.toISOString() };
}

const liveKey = (orgId: string, id: string): SQL =>
  and(eq(orgDocuments.id, id), eq(orgDocuments.orgId, orgId), isNull(orgDocuments.deletedAt))!;

/** Validate bytes and return the sniffed type. The client's Content-Type is
 *  NEVER consulted — magic bytes only, same rule as ticket attachments (D4). */
function validateFile(file: UploadFile): { contentType: string; sha256: string } {
  if (file.buffer.length === 0) throw new DeliverableServiceError('Document is empty', 400, 'EMPTY_FILE');
  if (file.buffer.length > TICKET_ATTACHMENT_LIMITS.maxBytes) {
    throw new DeliverableServiceError('Document too large (max 10 MB)', 413, 'FILE_TOO_LARGE');
  }
  const contentType = sniffAttachmentMime(file.buffer);
  if (!contentType) {
    throw new DeliverableServiceError('Only JPEG, PNG, WebP images and PDFs can be stored', 415, 'UNSUPPORTED_DOCUMENT_TYPE');
  }
  return { contentType, sha256: createHash('sha256').update(file.buffer).digest('hex') };
}

async function loadLive(orgId: string, id: string): Promise<MetaRow> {
  const [row] = await db.select(ORG_DOCUMENT_META_COLUMNS).from(orgDocuments).where(liveKey(orgId, id)).limit(1);
  if (!row) throw notFound();
  return row;
}

/** Any row naming `id` as its predecessor — including a tombstone, which still
 *  occupies the unique successor slot. */
async function successorOf(orgId: string, id: string): Promise<string | null> {
  const [row] = await db.select({ id: orgDocuments.id }).from(orgDocuments)
    .where(and(eq(orgDocuments.supersedesDocumentId, id), eq(orgDocuments.orgId, orgId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Put the bytes, then insert the row in a nested transaction. Under a request's
 * `withDbAccessContext` the nested transaction is a SAVEPOINT, so a unique
 * violation rolls back to it and the request transaction stays usable — the
 * mapped 409 reaches the client instead of becoming a 500 at commit.
 */
async function insertWithBytes(
  values: {
    orgId: string; title: string; description: string | null; category: OrgDocumentCategory;
    portalVisible: boolean; supersedesDocumentId: string | null;
  },
  file: UploadFile,
  actor: DeliverableActor,
): Promise<MetaRow> {
  const { contentType, sha256 } = validateFile(file);
  const id = randomUUID();
  let stored: { backend: BlobBackend; storageKey: string | null; data: Buffer | null };
  try {
    stored = await putBlob({ prefix: ORG_DOCUMENT_PREFIX, id, buffer: file.buffer, contentType, sha256 });
  } catch (err) {
    if (err instanceof BlobStorageError) throw storageUnavailable();
    throw err;
  }
  try {
    const [row] = await db.transaction(async (tx) => tx.insert(orgDocuments).values({
      id,
      ...values,
      storageBackend: stored.backend,
      storageKey: stored.storageKey,
      data: stored.data,
      contentType,
      byteSize: file.buffer.length,
      sha256,
      originalFilename: sanitizeAttachmentFilename(file.filename),
      uploadedByUserId: actor.userId,
    }).returning(ORG_DOCUMENT_META_COLUMNS));
    if (!row) throw new Error('org_documents insert returned no row');
    return row;
  } catch (err) {
    try {
      await deleteBlob({ storageBackend: stored.backend, storageKey: stored.storageKey, data: null });
    } catch (cleanupErr) {
      // Never mask the insert fault. The object is orphaned under an opaque key
      // with no row pointing at it; log enough to find it.
      console.error('[orgDocumentService] failed to delete object after insert failure', {
        documentId: id, storageKey: stored.storageKey, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }
    if (isPgUniqueViolation(err)) throw notHead();
    throw err;
  }
}

export async function listDocuments(
  orgId: string, q: { category?: OrgDocumentCategory; includeSuperseded?: boolean }, actor: DeliverableActor,
): Promise<OrgDocumentView[]> {
  requireOrgAccess(actor, orgId);
  const successor = alias(orgDocuments, 'successor');
  const conditions: SQL[] = [eq(orgDocuments.orgId, orgId), isNull(orgDocuments.deletedAt)];
  if (q.category) conditions.push(eq(orgDocuments.category, q.category));
  if (!q.includeSuperseded) conditions.push(isNull(successor.id));
  const rows = await db
    .select({ ...ORG_DOCUMENT_META_COLUMNS, supersededByDocumentId: successor.id })
    .from(orgDocuments)
    .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
    .where(and(...conditions))
    .orderBy(desc(orgDocuments.createdAt));
  return rows.map(({ supersededByDocumentId, ...row }) => toView(row, supersededByDocumentId ?? null));
}

export async function getDocument(orgId: string, id: string, actor: DeliverableActor): Promise<OrgDocumentView> {
  requireOrgAccess(actor, orgId);
  const row = await loadLive(orgId, id);
  return toView(row, await successorOf(orgId, id));
}

export async function uploadDocument(
  orgId: string,
  input: { title: string; description?: string | null; category: OrgDocumentCategory; portalVisible?: boolean; file: UploadFile },
  actor: DeliverableActor,
): Promise<OrgDocumentView> {
  requireOrgAccess(actor, orgId);
  const row = await insertWithBytes({
    orgId,
    title: input.title,
    description: input.description ?? null,
    category: input.category,
    portalVisible: input.portalVisible ?? false,
    supersedesDocumentId: null,
  }, input.file, actor);
  return toView(row, null);
}

export async function replaceDocument(
  orgId: string, id: string, input: DocumentMetadataPatch & { file: UploadFile }, actor: DeliverableActor,
): Promise<OrgDocumentView> {
  requireOrgAccess(actor, orgId);
  // Reject bad bytes before any DB work; insertWithBytes re-validates (cheap).
  validateFile(input.file);
  const target = await loadLive(orgId, id);
  if (await successorOf(orgId, id)) throw notHead();
  const row = await insertWithBytes({
    orgId,
    title: input.title ?? target.title,
    description: input.description !== undefined ? input.description : target.description,
    category: input.category ?? target.category,
    portalVisible: input.portalVisible ?? target.portalVisible,
    supersedesDocumentId: target.id,
  }, input.file, actor);
  return toView(row, null);
}

export async function updateDocument(
  orgId: string, id: string, patch: DocumentMetadataPatch, actor: DeliverableActor,
): Promise<OrgDocumentView> {
  requireOrgAccess(actor, orgId);
  // Whitelist explicitly: callers include the MCP tool layer, and nothing but
  // these four metadata columns may ever be set through this path.
  const values: DocumentMetadataPatch = {};
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.category !== undefined) values.category = patch.category;
  if (patch.portalVisible !== undefined) values.portalVisible = patch.portalVisible;
  if (Object.keys(values).length === 0) {
    throw new DeliverableServiceError('At least one field must be provided', 400, 'EMPTY_PATCH');
  }
  const [row] = await db.update(orgDocuments).set(values).where(liveKey(orgId, id)).returning(ORG_DOCUMENT_META_COLUMNS);
  if (!row) throw notFound();
  return toView(row, await successorOf(orgId, id));
}

/**
 * Link two EXISTING documents: `id` becomes the newer version of
 * `supersedesDocumentId`. Both must be chain heads and `id` must not already
 * supersede anything, checked under row locks taken in id order — without the
 * locks two crossed calls (A→B and B→A) could each pass their checks and
 * commit a cycle that the unique index cannot see.
 */
export async function supersedeDocument(
  orgId: string, id: string, supersedesDocumentId: string, actor: DeliverableActor,
): Promise<OrgDocumentView> {
  requireOrgAccess(actor, orgId);
  if (id === supersedesDocumentId) {
    throw new DeliverableServiceError('A document cannot supersede itself', 400, 'INVALID_SUPERSEDE');
  }
  try {
    const row = await db.transaction(async (tx) => {
      const locked = await tx.select(ORG_DOCUMENT_META_COLUMNS).from(orgDocuments)
        .where(and(inArray(orgDocuments.id, [id, supersedesDocumentId]), eq(orgDocuments.orgId, orgId), isNull(orgDocuments.deletedAt)))
        .orderBy(asc(orgDocuments.id))
        .for('update');
      const doc = locked.find((r) => r.id === id);
      const target = locked.find((r) => r.id === supersedesDocumentId);
      if (!doc || !target) throw notFound();
      if (doc.supersedesDocumentId) {
        throw new DeliverableServiceError('This document already replaces another version', 409, 'ALREADY_SUPERSEDES');
      }
      const successors = await tx.select({ id: orgDocuments.id, supersedesDocumentId: orgDocuments.supersedesDocumentId })
        .from(orgDocuments)
        .where(and(inArray(orgDocuments.supersedesDocumentId, [id, supersedesDocumentId]), eq(orgDocuments.orgId, orgId)));
      if (successors.some((s) => s.supersedesDocumentId === supersedesDocumentId)) throw notHead();
      if (successors.some((s) => s.supersedesDocumentId === id)) {
        throw notHead('Only the current version of a document can be linked as a newer version of another');
      }
      const [updated] = await tx.update(orgDocuments)
        .set({ supersedesDocumentId })
        .where(and(liveKey(orgId, id), isNull(orgDocuments.supersedesDocumentId)))
        .returning(ORG_DOCUMENT_META_COLUMNS);
      if (!updated) throw notFound();
      return updated;
    });
    return toView(row, null);
  } catch (err) {
    if (isPgUniqueViolation(err)) throw notHead();
    throw err;
  }
}

export async function deleteDocument(orgId: string, id: string, actor: DeliverableActor): Promise<void> {
  requireOrgAccess(actor, orgId);
  const bytesColumns = {
    id: orgDocuments.id,
    supersedesDocumentId: orgDocuments.supersedesDocumentId,
    storageBackend: orgDocuments.storageBackend,
    storageKey: orgDocuments.storageKey,
  };

  // ONE transaction, start to finish. The head is locked FOR UPDATE, the
  // "is it still a head?" question is asked inside that lock, and the tombstone
  // commits under the same lock — a plain SELECT does not wait on another
  // transaction's row lock, so a concurrent supersede/replace could otherwise
  // commit a successor between the check and the UPDATE and leave the survivor
  // pointing at a soft-deleted predecessor that every read path 404s.
  //
  // The object delete sits inside the transaction too, BEFORE the UPDATE: the
  // rows are the only index to the keys, so a storage fault must roll back
  // with every row (and key) still findable and the delete still retryable.
  await db.transaction(async (tx) => {
    const [head] = await tx.select(bytesColumns).from(orgDocuments).where(liveKey(orgId, id)).limit(1).for('update');
    if (!head) throw notFound();
    const [successor] = await tx.select({ id: orgDocuments.id }).from(orgDocuments)
      .where(and(eq(orgDocuments.supersedesDocumentId, id), eq(orgDocuments.orgId, orgId)))
      .limit(1);
    if (successor) {
      throw notHead('Only the current version can be deleted; deleting it removes every version of the document');
    }

    const versions = [head];
    const seen = new Set([head.id]);
    let cursor = head.supersedesDocumentId;
    while (cursor && !seen.has(cursor)) {
      if (versions.length >= MAX_CHAIN_LENGTH) {
        // Only reachable through corrupt data (the unique index and the
        // no-self-supersede CHECK make a cycle unconstructible through this
        // service). Say so rather than silently tombstoning a prefix.
        console.error('[orgDocumentService] version chain exceeded the walk bound; deleting the prefix only', {
          documentId: id, walked: versions.length,
        });
        break;
      }
      const [prev] = await tx.select(bytesColumns).from(orgDocuments).where(liveKey(orgId, cursor)).limit(1).for('update');
      if (!prev) {
        // A live row pointing at a missing or already-deleted predecessor is a
        // data-integrity anomaly, not a normal delete — leave a breadcrumb.
        console.error('[orgDocumentService] version chain breaks at a missing predecessor', {
          documentId: id, missingPredecessor: cursor, walked: versions.length,
        });
        break;
      }
      versions.push(prev);
      seen.add(prev.id);
      cursor = prev.supersedesDocumentId;
    }

    const keys = versions
      .filter((v) => v.storageBackend === 's3' && v.storageKey)
      .map((v) => v.storageKey as string);
    if (keys.length > 0) {
      try {
        await deleteBlobKeys(keys);
      } catch (err) {
        console.error('[orgDocumentService] object delete failed; nothing stamped, delete is retryable', {
          documentId: id, keys: keys.length, error: err instanceof Error ? err.message : String(err),
        });
        throw storageUnavailable();
      }
    }

    const stamped = await tx.update(orgDocuments)
      .set({ deletedAt: new Date(), deletedBy: actor.userId, storageKey: null, data: null })
      .where(and(inArray(orgDocuments.id, versions.map((v) => v.id)), eq(orgDocuments.orgId, orgId), isNull(orgDocuments.deletedAt)))
      .returning({ id: orgDocuments.id });
    if (stamped.length === 0) {
      // Never report success for an UPDATE that touched nothing.
      throw new DeliverableServiceError(
        'The document changed while this request was in flight; reload and retry', 409, 'CONCURRENT_MODIFICATION',
      );
    }
  });
}

/** Strong ETag for a document version: its content digest, quoted. */
export const documentEtag = (sha256: string): string => `"${sha256}"`;

export async function streamDocument(
  orgId: string, id: string, actor: DeliverableActor, opts: { ifNoneMatch?: string | null } = {},
): Promise<{
  view: OrgDocumentView;
  contentType: string;
  originalFilename: string;
  sha256: string;
  /** True when `opts.ifNoneMatch` matched: `body` is null and nothing was read. */
  notModified: boolean;
  body: Readable | Buffer | null;
  contentLength: number | null;
}> {
  requireOrgAccess(actor, orgId);
  const [row] = await db
    .select({ ...ORG_DOCUMENT_META_COLUMNS, storageBackend: orgDocuments.storageBackend, storageKey: orgDocuments.storageKey })
    .from(orgDocuments)
    .where(liveKey(orgId, id))
    .limit(1);
  if (!row) throw notFound();
  const { storageBackend, storageKey, ...meta } = row;
  const view = toView(meta, await successorOf(orgId, id));
  const base = { view, contentType: meta.contentType, originalFilename: meta.originalFilename, sha256: meta.sha256 };

  // Short-circuit BEFORE opening the bytes — a 304 that still fetched from the
  // object store is a silent egress bill.
  if (opts.ifNoneMatch && opts.ifNoneMatch === documentEtag(meta.sha256)) {
    return { ...base, notModified: true, body: null, contentLength: null };
  }

  // An s3 row never pulls the bytea column; a db row reads it on this path only.
  let data: Buffer | null = null;
  if (storageBackend === 'db') {
    const [bytes] = await db.select({ data: orgDocuments.data }).from(orgDocuments).where(liveKey(orgId, id)).limit(1);
    data = bytes?.data ?? null;
  }
  try {
    const { body, contentLength } = await getBlobStream({ storageBackend, storageKey: storageBackend === 's3' ? storageKey : null, data });
    return { ...base, notModified: false, body, contentLength };
  } catch (err) {
    if (err instanceof BlobStorageError) throw storageUnavailable();
    throw err;
  }
}
