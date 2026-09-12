import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const putObjectBuffer = vi.fn(async () => {});
const getObjectStream = vi.fn(async () => ({ body: { pipe: () => {} }, contentLength: 4 }));
const deleteObjects = vi.fn(async () => {});

vi.mock('./s3Storage', () => ({
  putObjectBuffer: (...a: unknown[]) => putObjectBuffer(...(a as [])),
  getObjectStream: (...a: unknown[]) => getObjectStream(...(a as [])),
  deleteObjects: (...a: unknown[]) => deleteObjects(...(a as [])),
  isS3Configured: () => !!(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY),
}));

const ORIGINAL_ENV = { ...process.env };

const withS3 = () => {
  process.env.S3_BUCKET = 'b';
  process.env.S3_ACCESS_KEY = 'k';
  process.env.S3_SECRET_KEY = 's';
};

describe('blobStorage (service deliverables W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY;
    delete process.env.S3_SECRET_KEY;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('selectBackend is s3 only when all three S3 env vars are set', async () => {
    const { selectBackend } = await import('./blobStorage');
    expect(selectBackend()).toBe('db');
    withS3();
    expect(selectBackend()).toBe('s3');
    delete process.env.S3_SECRET_KEY;
    expect(selectBackend()).toBe('db');
  });

  it('the key prefix is a parameter and the key carries no tenant identifier', async () => {
    const { objectKeyFor } = await import('./blobStorage');
    expect(objectKeyFor('org-documents', 'd-1')).toBe('org-documents/d-1');
    expect(objectKeyFor('ticket-attachments', 'a-1')).toBe('ticket-attachments/a-1');
  });

  it('putBlob on the db backend stores the buffer inline and never touches S3', async () => {
    const { putBlob } = await import('./blobStorage');
    const buf = Buffer.from('hello');
    const res = await putBlob({ prefix: 'org-documents', id: 'd-0', buffer: buf, contentType: 'image/png', sha256: 'a'.repeat(64) });
    expect(res).toEqual({ backend: 'db', storageKey: null, data: buf });
    expect(putObjectBuffer).not.toHaveBeenCalled();
  });

  it('putBlob writes the object under the caller prefix on the s3 backend', async () => {
    withS3();
    const { putBlob } = await import('./blobStorage');
    const res = await putBlob({ prefix: 'org-documents', id: 'd-2', buffer: Buffer.from('hi'), contentType: 'application/pdf', sha256: 'b'.repeat(64) });
    expect(putObjectBuffer).toHaveBeenCalledWith('org-documents/d-2', expect.any(Buffer), 'application/pdf', 'b'.repeat(64));
    expect(res).toEqual({ backend: 's3', storageKey: 'org-documents/d-2', data: null });
  });

  // THE headline assertion, carried over from the ticket module.
  it('putBlob NEVER falls back to db when the s3 put fails — it throws STORAGE_UNAVAILABLE', async () => {
    withS3();
    putObjectBuffer.mockRejectedValueOnce(new Error('s3 down') as never);
    const { putBlob, BlobStorageError } = await import('./blobStorage');
    let thrown: unknown;
    let returned: unknown;
    try {
      returned = await putBlob({ prefix: 'org-documents', id: 'd-4', buffer: Buffer.from('hi'), contentType: 'application/pdf', sha256: 'd'.repeat(64) });
    } catch (e) {
      thrown = e;
    }
    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(BlobStorageError);
    expect((thrown as InstanceType<typeof BlobStorageError>).status).toBe(503);
    expect((thrown as InstanceType<typeof BlobStorageError>).code).toBe('STORAGE_UNAVAILABLE');
    expect(putObjectBuffer).toHaveBeenCalledTimes(1);
  });

  it('getBlobStream routes by row.storageBackend, never by whether storageKey happens to be set', async () => {
    withS3();
    const { getBlobStream } = await import('./blobStorage');
    const res = await getBlobStream({ storageBackend: 'db', storageKey: 'org-documents/oops', data: Buffer.from('inline') });
    expect(getObjectStream).not.toHaveBeenCalled();
    expect(res.body).toBeInstanceOf(Buffer);
    await getBlobStream({ storageBackend: 's3', storageKey: 'org-documents/k', data: null });
    expect(getObjectStream).toHaveBeenCalledWith('org-documents/k');
  });

  it('getBlobStream maps an s3 transport fault to BlobStorageError (503), never a bare throw', async () => {
    withS3();
    getObjectStream.mockRejectedValueOnce(new Error('connection reset') as never);
    const { getBlobStream, BlobStorageError } = await import('./blobStorage');
    let thrown: unknown;
    try {
      await getBlobStream({ storageBackend: 's3', storageKey: 'org-documents/k', data: null });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(BlobStorageError);
    expect((thrown as InstanceType<typeof BlobStorageError>).status).toBe(503);
  });

  it('getBlobStream answers a null body — not an error — for an s3 row with no key', async () => {
    withS3();
    const { getBlobStream } = await import('./blobStorage');
    expect(await getBlobStream({ storageBackend: 's3', storageKey: null, data: null }))
      .toEqual({ body: null, contentLength: null });
    expect(getObjectStream).not.toHaveBeenCalled();
  });

  it('deleteBlob is a no-op for a db row and deletes the object for an s3 row', async () => {
    withS3();
    const { deleteBlob } = await import('./blobStorage');
    await deleteBlob({ storageBackend: 'db', storageKey: null, data: Buffer.from('x') });
    expect(deleteObjects).not.toHaveBeenCalled();
    await deleteBlob({ storageBackend: 's3', storageKey: 'org-documents/k', data: null });
    expect(deleteObjects).toHaveBeenCalledWith(['org-documents/k']);
  });

  it('deleteBlobKeys forwards to the batching s3 primitive and skips an empty list', async () => {
    withS3();
    const { deleteBlobKeys } = await import('./blobStorage');
    await deleteBlobKeys([]);
    expect(deleteObjects).not.toHaveBeenCalled();
    await deleteBlobKeys(['a', 'b']);
    expect(deleteObjects).toHaveBeenCalledWith(['a', 'b']);
  });
});
