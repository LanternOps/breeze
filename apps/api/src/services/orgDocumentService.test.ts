import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Param, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// Controllable Drizzle chain mock (same pattern as serviceDeliverableService.test.ts):
// every builder method returns the same chain; an awaited query consumes the
// next queued result in call order.
type QueuedQuery = { rows: unknown[] } | { error: unknown };
const results: QueuedQuery[] = [];
function queueResult(rows: unknown[]) { results.push({ rows }); }
function queueError(error: unknown) { results.push({ error }); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'innerJoin', 'leftJoin', 'for'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const result = results.shift() ?? { rows: [] };
      return 'error' in result ? reject(result.error) : resolve(result.rows);
    };
    return chain;
  };
  return { db: makeChain() };
});

const putBlob = vi.hoisted(() => vi.fn());
const deleteBlob = vi.hoisted(() => vi.fn(async () => {}));
const deleteBlobKeys = vi.hoisted(() => vi.fn(async () => {}));
const getBlobStream = vi.hoisted(() => vi.fn());
vi.mock('./blobStorage', async () => {
  const actual = await vi.importActual<typeof import('./blobStorage')>('./blobStorage');
  // BlobStorageError stays real, so the service's instanceof check is exercised.
  return { ...actual, putBlob, deleteBlob, deleteBlobKeys, getBlobStream };
});

import { db } from '../db';
import { BlobStorageError } from './blobStorage';
import {
  deleteDocument, getDocument, listDocuments, replaceDocument, streamDocument, supersedeDocument,
  updateDocument, uploadDocument,
} from './orgDocumentService';

type MockCalls = { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
type ChainName = 'select' | 'insert' | 'update' | 'set' | 'values' | 'where' | 'for' | 'transaction';
const chain = db as unknown as Record<ChainName, MockCalls>;
const lastValues = () => chain.values.mock.calls.at(-1)?.[0] as Record<string, unknown>;
const lastSet = () => chain.set.mock.calls.at(-1)?.[0] as Record<string, unknown>;
function boundParams(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof Param) out.push(node.value);
  else if (node instanceof SQL) for (const c of node.queryChunks) boundParams(c, out);
  else if (Array.isArray(node)) for (const c of node) boundParams(c, out);
  return out;
}
const allWhereParams = () => chain.where.mock.calls.flatMap((c) => boundParams(c[0]));
/** Compiled SQL text of the most recent `.where(...)` — asserts on real SQL, not on metadata. */
const lastWhereSql = () => new PgDialect().sqlToQuery(chain.where.mock.calls.at(-1)?.[0] as SQL).sql;

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const foreign = { ...actor, accessibleOrgIds: ['org9'] };
const pdf = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(64, 1)]);
// A lying client type: the stored type must be the sniffed one.
const file = { buffer: pdf, contentType: 'text/html', filename: 'runbook.pdf' };
const created = new Date('2026-10-01T00:00:00Z');
const docRow = (over: Record<string, unknown> = {}) => ({
  id: 'd1', orgId: 'org1', title: 'Runbook', description: null, category: 'runbook', contentType: 'application/pdf',
  byteSize: 69, sha256: 'a'.repeat(64), originalFilename: 'runbook.pdf', uploadedByUserId: 'u1', portalVisible: false,
  supersedesDocumentId: null, createdAt: created, ...over,
});

describe('orgDocumentService (service deliverables W03)', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    putBlob.mockImplementation(async (args: { prefix: string; id: string }) => ({ backend: 's3', storageKey: `${args.prefix}/${args.id}`, data: null }));
  });

  describe('org access', () => {
    it('every exported function 404s — never 403 — a foreign org without touching the db or the bucket', async () => {
      const calls: Array<Promise<unknown>> = [
        listDocuments('org1', {}, foreign),
        getDocument('org1', 'd1', foreign),
        uploadDocument('org1', { title: 'x', category: 'other', file }, foreign),
        replaceDocument('org1', 'd1', { file }, foreign),
        updateDocument('org1', 'd1', { title: 'y' }, foreign),
        supersedeDocument('org1', 'd2', 'd1', foreign),
        deleteDocument('org1', 'd1', foreign),
        streamDocument('org1', 'd1', foreign),
      ];
      for (const p of calls) await expect(p).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(chain.select.mock.calls).toHaveLength(0);
      expect(chain.insert.mock.calls).toHaveLength(0);
      expect(chain.update.mock.calls).toHaveLength(0);
      expect(putBlob).not.toHaveBeenCalled();
      expect(deleteBlobKeys).not.toHaveBeenCalled();
    });
  });

  describe('uploadDocument', () => {
    it('stores the SNIFFED content type, never the client-supplied one', async () => {
      queueResult([docRow()]);
      const view = await uploadDocument('org1', { title: 'Runbook', category: 'runbook', file }, actor);
      expect(putBlob).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'org-documents', contentType: 'application/pdf' }));
      expect(lastValues()).toMatchObject({
        orgId: 'org1', contentType: 'application/pdf', storageBackend: 's3', data: null, byteSize: pdf.length,
        originalFilename: 'runbook.pdf', uploadedByUserId: 'u1', supersedesDocumentId: null, portalVisible: false,
      });
      expect(lastValues().storageKey).toBe(`org-documents/${lastValues().id}`);
      expect(lastValues().sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(view).toMatchObject({ id: 'd1', supersededByDocumentId: null, createdAt: created.toISOString() });
      expect(view).not.toHaveProperty('storageKey');
      expect(view).not.toHaveProperty('data');
    });

    it('the object key is the new row id — no tenant identifier', async () => {
      queueResult([docRow()]);
      await uploadDocument('org1', { title: 'Runbook', category: 'runbook', file }, actor);
      const { id } = putBlob.mock.calls[0]![0] as { id: string };
      expect(lastValues().id).toBe(id);
      expect(JSON.stringify(putBlob.mock.calls[0]![0])).not.toContain('org1');
    });

    it('sanitises the client filename to a basename', async () => {
      queueResult([docRow()]);
      await uploadDocument('org1', { title: 'x', category: 'other', file: { ...file, filename: '../../etc/"evil\r\n.pdf' } }, actor);
      expect(lastValues().originalFilename).toBe('evil.pdf');
    });

    it('rejects an unsniffable payload with 415 and never puts an object', async () => {
      await expect(uploadDocument('org1', { title: 'x', category: 'other', file: { ...file, buffer: Buffer.from('<html>') } }, actor))
        .rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_DOCUMENT_TYPE' });
      expect(putBlob).not.toHaveBeenCalled();
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('rejects an empty buffer with 400 EMPTY_FILE', async () => {
      await expect(uploadDocument('org1', { title: 'x', category: 'other', file: { ...file, buffer: Buffer.alloc(0) } }, actor))
        .rejects.toMatchObject({ status: 400, code: 'EMPTY_FILE' });
      expect(putBlob).not.toHaveBeenCalled();
    });

    it('rejects 10 MiB + 1 byte with 413 FILE_TOO_LARGE and never puts an object', async () => {
      const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 - 4)]);
      expect(big.length).toBe(10 * 1024 * 1024 + 1);
      await expect(uploadDocument('org1', { title: 'x', category: 'other', file: { ...file, buffer: big } }, actor))
        .rejects.toMatchObject({ status: 413, code: 'FILE_TOO_LARGE' });
      expect(putBlob).not.toHaveBeenCalled();
    });

    it('maps a storage fault to 503 and writes no row', async () => {
      putBlob.mockRejectedValueOnce(new BlobStorageError('down'));
      await expect(uploadDocument('org1', { title: 'x', category: 'other', file }, actor))
        .rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
      expect(chain.insert.mock.calls).toHaveLength(0);
    });

    it('an INSERT failure deletes the just-put object and surfaces the ORIGINAL error', async () => {
      const boom = new Error('insert exploded');
      queueError(boom);
      deleteBlob.mockRejectedValueOnce(new Error('cleanup also failed'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(uploadDocument('org1', { title: 'x', category: 'other', file }, actor)).rejects.toBe(boom);
      expect(deleteBlob).toHaveBeenCalledWith(expect.objectContaining({ storageBackend: 's3', storageKey: expect.stringMatching(/^org-documents\//) }));
      err.mockRestore();
    });
  });

  describe('replaceDocument', () => {
    it('refuses to replace a document that already has a successor (409 NOT_HEAD) before putting any bytes', async () => {
      queueResult([docRow()]);          // target load
      queueResult([{ id: 'd2' }]);      // successor exists
      await expect(replaceDocument('org1', 'd1', { file }, actor)).rejects.toMatchObject({ status: 409, code: 'NOT_HEAD' });
      expect(putBlob).not.toHaveBeenCalled();
    });

    it('404s a missing or soft-deleted target', async () => {
      queueResult([]);
      await expect(replaceDocument('org1', 'd1', { file }, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(putBlob).not.toHaveBeenCalled();
    });

    it('inserts a new version pointing at the target and inherits omitted metadata', async () => {
      queueResult([docRow({ title: 'Firewall baseline', category: 'baseline', portalVisible: true, description: 'v1' })]);
      queueResult([]);                                   // no successor
      queueResult([docRow({ id: 'd2', supersedesDocumentId: 'd1' })]);
      const view = await replaceDocument('org1', 'd1', { file }, actor);
      expect(lastValues()).toMatchObject({
        supersedesDocumentId: 'd1', title: 'Firewall baseline', category: 'baseline', portalVisible: true, description: 'v1',
      });
      expect(view).toMatchObject({ id: 'd2', supersedesDocumentId: 'd1', supersededByDocumentId: null });
    });

    it('explicit metadata on the replace wins over the inherited value', async () => {
      queueResult([docRow({ title: 'Old', portalVisible: true })]);
      queueResult([]);
      queueResult([docRow({ id: 'd2' })]);
      await replaceDocument('org1', 'd1', { file, title: 'New', portalVisible: false }, actor);
      expect(lastValues()).toMatchObject({ title: 'New', portalVisible: false });
    });

    it('a 23505 from the insert (lost race on the head check) maps to 409 NOT_HEAD and cleans up the object', async () => {
      queueResult([docRow()]);
      queueResult([]);
      queueError(Object.assign(new Error('duplicate key'), { code: '23505' }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(replaceDocument('org1', 'd1', { file }, actor)).rejects.toMatchObject({ status: 409, code: 'NOT_HEAD' });
      expect(deleteBlob).toHaveBeenCalledTimes(1);
      // The insert ran inside a nested transaction (a SAVEPOINT under the
      // request's context) so the unique violation cannot abort the request tx.
      expect(chain.transaction.mock.calls.length).toBeGreaterThanOrEqual(1);
      err.mockRestore();
    });
  });

  describe('listDocuments', () => {
    it('returns chain heads only, never soft-deleted rows, newest first by default', async () => {
      queueResult([{ ...docRow(), supersededByDocumentId: null }]);
      const rows = await listDocuments('org1', {}, actor);
      expect(rows).toHaveLength(1);
      const sqlText = lastWhereSql();
      expect(sqlText).toContain('"org_documents"."deleted_at" is null');
      // heads filter: the successor alias must be required NULL
      expect(sqlText).toContain('"successor"."id" is null');
    });

    it('includes superseded rows under the flag, keeping the soft-delete filter', async () => {
      queueResult([{ ...docRow(), supersededByDocumentId: 'd2' }, { ...docRow({ id: 'd2', supersedesDocumentId: 'd1' }), supersededByDocumentId: null }]);
      const rows = await listDocuments('org1', { includeSuperseded: true }, actor);
      expect(rows.map((r) => r.supersededByDocumentId)).toEqual(['d2', null]);
      const sqlText = lastWhereSql();
      expect(sqlText).toContain('"org_documents"."deleted_at" is null');
      expect(sqlText).not.toContain('"successor"');
    });

    it('binds the category filter when given', async () => {
      queueResult([]);
      await listDocuments('org1', { category: 'runbook' }, actor);
      expect(allWhereParams()).toEqual(expect.arrayContaining(['org1', 'runbook']));
    });
  });

  describe('updateDocument', () => {
    it('404s a soft-deleted or missing row (the UPDATE matched nothing)', async () => {
      queueResult([]);
      await expect(updateDocument('org1', 'd1', { title: 'x' }, actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('sets only whitelisted metadata columns', async () => {
      queueResult([docRow({ portalVisible: true })]);
      queueResult([]);
      await updateDocument('org1', 'd1', { portalVisible: true, storageKey: 'org-documents/evil' } as never, actor);
      expect(lastSet()).toEqual({ portalVisible: true });
    });
  });

  describe('supersedeDocument', () => {
    it('rejects a document superseding itself with 400 INVALID_SUPERSEDE', async () => {
      await expect(supersedeDocument('org1', 'd1', 'd1', actor)).rejects.toMatchObject({ status: 400, code: 'INVALID_SUPERSEDE' });
      expect(chain.select.mock.calls).toHaveLength(0);
    });

    it('rejects a document that already supersedes something with 409 ALREADY_SUPERSEDES', async () => {
      queueResult([docRow({ id: 'd1' }), docRow({ id: 'd2', supersedesDocumentId: 'd0' })]);
      await expect(supersedeDocument('org1', 'd2', 'd1', actor)).rejects.toMatchObject({ status: 409, code: 'ALREADY_SUPERSEDES' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('rejects a target that is not a chain head with 409 NOT_HEAD', async () => {
      queueResult([docRow({ id: 'd1' }), docRow({ id: 'd2' })]);
      queueResult([{ id: 'd3', supersedesDocumentId: 'd1' }]);
      await expect(supersedeDocument('org1', 'd2', 'd1', actor)).rejects.toMatchObject({ status: 409, code: 'NOT_HEAD' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('rejects a superseding document that itself has a successor (would close a cycle) with 409 NOT_HEAD', async () => {
      // d1 <- d2 already (d2 supersedes d1). Letting d1 supersede anything
      // would turn the list into a tree walked from two ends; with d3 = d2 it
      // would close the cycle d1 <-> d2. The superseding doc must be a head.
      queueResult([docRow({ id: 'd1' }), docRow({ id: 'd3' })]);
      queueResult([{ id: 'd2', supersedesDocumentId: 'd1' }]);
      await expect(supersedeDocument('org1', 'd1', 'd3', actor)).rejects.toMatchObject({ status: 409, code: 'NOT_HEAD' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('404s when either document is missing in this org', async () => {
      queueResult([docRow({ id: 'd1' })]);
      await expect(supersedeDocument('org1', 'd2', 'd1', actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });

    it('locks both rows before checking, then links them', async () => {
      queueResult([docRow({ id: 'd1' }), docRow({ id: 'd2' })]);
      queueResult([]);
      queueResult([docRow({ id: 'd2', supersedesDocumentId: 'd1' })]);
      const view = await supersedeDocument('org1', 'd2', 'd1', actor);
      expect(chain.for.mock.calls[0]?.[0]).toBe('update');
      expect(lastSet()).toEqual({ supersedesDocumentId: 'd1' });
      expect(view).toMatchObject({ id: 'd2', supersedesDocumentId: 'd1' });
    });

    it('maps a 23505 on the link to 409 NOT_HEAD', async () => {
      queueResult([docRow({ id: 'd1' }), docRow({ id: 'd2' })]);
      queueResult([]);
      queueError(Object.assign(new Error('duplicate key'), { code: '23505' }));
      await expect(supersedeDocument('org1', 'd2', 'd1', actor)).rejects.toMatchObject({ status: 409, code: 'NOT_HEAD' });
    });
  });

  describe('deleteDocument', () => {
    const s3 = (over: Record<string, unknown> = {}) => ({ id: 'd1', supersedesDocumentId: null, storageBackend: 's3', storageKey: 'org-documents/d1', ...over });

    it('deletes the object BEFORE stamping the tombstone', async () => {
      const order: string[] = [];
      deleteBlobKeys.mockImplementation(async () => { order.push('object'); });
      (chain.update as unknown as { mockImplementation: (f: () => unknown) => void }).mockImplementation(() => { order.push('update'); return chain; });
      queueResult([s3()]);          // head load
      queueResult([]);              // no successor
      queueResult([{ id: 'd1' }]);  // tombstone UPDATE
      await deleteDocument('org1', 'd1', actor);
      expect(order).toEqual(['object', 'update']);
      expect(lastSet()).toMatchObject({ deletedBy: 'u1', storageKey: null, data: null });
      expect(lastSet().deletedAt).toBeInstanceOf(Date);
    });

    it('removes EVERY version of the chain from its head, objects in one batch', async () => {
      queueResult([s3({ id: 'd3', supersedesDocumentId: 'd2', storageKey: 'org-documents/d3' })]);
      queueResult([]);
      queueResult([s3({ id: 'd2', supersedesDocumentId: 'd1', storageKey: 'org-documents/d2' })]);
      queueResult([{ id: 'd1', supersedesDocumentId: null, storageBackend: 'db', storageKey: null }]);
      queueResult([{ id: 'd3' }, { id: 'd2' }, { id: 'd1' }]);
      await deleteDocument('org1', 'd3', actor);
      expect(deleteBlobKeys).toHaveBeenCalledTimes(1);
      expect(deleteBlobKeys).toHaveBeenCalledWith(['org-documents/d3', 'org-documents/d2']);
      const updateParams = boundParams(chain.where.mock.calls.at(-1)?.[0]);
      expect(updateParams).toEqual(expect.arrayContaining(['d3', 'd2', 'd1', 'org1']));
    });

    it('refuses to delete a superseded version (409 NOT_HEAD) — delete acts on the current version', async () => {
      queueResult([s3()]);
      queueResult([{ id: 'd2' }]);
      await expect(deleteDocument('org1', 'd1', actor)).rejects.toMatchObject({ status: 409, code: 'NOT_HEAD' });
      expect(deleteBlobKeys).not.toHaveBeenCalled();
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('a storage fault is a 503 and nothing is stamped, so the delete is retryable', async () => {
      deleteBlobKeys.mockRejectedValueOnce(new Error('bucket down'));
      queueResult([s3()]);
      queueResult([]);
      await expect(deleteDocument('org1', 'd1', actor)).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
      expect(chain.update.mock.calls).toHaveLength(0);
    });

    it('404s a missing or already-deleted document', async () => {
      queueResult([]);
      await expect(deleteDocument('org1', 'd1', actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
  });

  describe('streamDocument', () => {
    it('never selects the bytea column for an s3 row and never returns a URL', async () => {
      queueResult([{ ...docRow(), storageBackend: 's3', storageKey: 'org-documents/d1' }]);
      queueResult([]);
      getBlobStream.mockResolvedValueOnce({ body: Buffer.from('x'), contentLength: 1 });
      const res = await streamDocument('org1', 'd1', actor);
      expect(getBlobStream).toHaveBeenCalledWith({ storageBackend: 's3', storageKey: 'org-documents/d1', data: null });
      const selected = chain.select.mock.calls.map((c) => Object.keys((c[0] ?? {}) as object));
      expect(selected.flat()).not.toContain('data');
      expect(JSON.stringify({ ...res, body: null })).not.toMatch(/https?:/);
      expect(res).toMatchObject({ contentType: 'application/pdf', originalFilename: 'runbook.pdf', sha256: 'a'.repeat(64) });
    });

    it('reads inline bytes for a db row', async () => {
      queueResult([{ ...docRow(), storageBackend: 'db', storageKey: null }]);
      queueResult([]);
      queueResult([{ data: Buffer.from('%PDF-') }]);
      getBlobStream.mockImplementationOnce(async (row: { data: Buffer }) => ({ body: row.data, contentLength: row.data.length }));
      const res = await streamDocument('org1', 'd1', actor);
      expect(res.body).toBeInstanceOf(Buffer);
    });

    it('maps a storage fault to 503', async () => {
      queueResult([{ ...docRow(), storageBackend: 's3', storageKey: 'org-documents/d1' }]);
      queueResult([]);
      getBlobStream.mockRejectedValueOnce(new BlobStorageError('down'));
      await expect(streamDocument('org1', 'd1', actor)).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
    });

    it('404s a soft-deleted document', async () => {
      queueResult([]);
      await expect(streamDocument('org1', 'd1', actor)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(getBlobStream).not.toHaveBeenCalled();
    });
  });

  describe('getDocument', () => {
    it('reports the successor id so the UI can badge a superseded version', async () => {
      queueResult([docRow()]);
      queueResult([{ id: 'd2' }]);
      const view = await getDocument('org1', 'd1', actor);
      expect(view.supersededByDocumentId).toBe('d2');
    });
  });
});
