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

describe('ticketAttachmentStorage (W08 #3902)', () => {
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
    const { selectBackend } = await import('./ticketAttachmentStorage');
    expect(selectBackend()).toBe('db');
    withS3();
    expect(selectBackend()).toBe('s3');
    delete process.env.S3_SECRET_KEY;
    expect(selectBackend()).toBe('db');
  });

  it('objectKeyFor carries no tenant identifier (spec D8)', async () => {
    const { objectKeyFor } = await import('./ticketAttachmentStorage');
    expect(objectKeyFor('11111111-2222-4333-8444-555555555555'))
      .toBe('ticket-attachments/11111111-2222-4333-8444-555555555555');
  });

  it('putBytes on the db backend stores the buffer inline and never touches S3', async () => {
    const { putBytes } = await import('./ticketAttachmentStorage');
    const buf = Buffer.from('hello');
    const res = await putBytes('id-1', buf, 'image/png', 'a'.repeat(64));
    expect(res).toEqual({ backend: 'db', storageKey: null, data: buf });
    expect(putObjectBuffer).not.toHaveBeenCalled();
  });

  it('putBytes on the s3 backend puts the object and returns a key with no inline data', async () => {
    withS3();
    const { putBytes } = await import('./ticketAttachmentStorage');
    const res = await putBytes('id-2', Buffer.from('hello'), 'application/pdf', 'b'.repeat(64));
    expect(putObjectBuffer).toHaveBeenCalledTimes(1);
    expect(putObjectBuffer).toHaveBeenCalledWith(
      'ticket-attachments/id-2', expect.any(Buffer), 'application/pdf', 'b'.repeat(64),
    );
    expect(res).toEqual({ backend: 's3', storageKey: 'ticket-attachments/id-2', data: null });
  });

  // THE headline assertion of this task.
  it('putBytes NEVER falls back to db when the s3 put fails — it throws STORAGE_UNAVAILABLE', async () => {
    withS3();
    putObjectBuffer.mockRejectedValueOnce(new Error('s3 down') as never);
    const { putBytes, AttachmentStorageError } = await import('./ticketAttachmentStorage');
    let thrown: unknown;
    let returned: unknown;
    try {
      returned = await putBytes('id-3', Buffer.from('hello'), 'image/png', 'c'.repeat(64));
    } catch (e) {
      thrown = e;
    }
    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(AttachmentStorageError);
    expect((thrown as InstanceType<typeof AttachmentStorageError>).code).toBe('STORAGE_UNAVAILABLE');
    expect((thrown as InstanceType<typeof AttachmentStorageError>).status).toBe(503);
    expect(putObjectBuffer).toHaveBeenCalledTimes(1);
  });

  it('openBytes routes by row.storageBackend, never by whether storageKey happens to be set', async () => {
    withS3();
    const { openBytes } = await import('./ticketAttachmentStorage');
    // A db-backed row that also (impossibly) carries a key must still read inline.
    const dbRow = { storageBackend: 'db' as const, storageKey: 'ticket-attachments/oops', data: Buffer.from('inline'), byteSize: 6 };
    const dbRes = await openBytes(dbRow);
    expect(getObjectStream).not.toHaveBeenCalled();
    expect(dbRes.body).toBeInstanceOf(Buffer);

    const s3Row = { storageBackend: 's3' as const, storageKey: 'ticket-attachments/k', data: null, byteSize: 4 };
    await openBytes(s3Row);
    expect(getObjectStream).toHaveBeenCalledWith('ticket-attachments/k');
  });

  it('deleteBytes is a no-op for a db row and deletes the object for an s3 row', async () => {
    withS3();
    const { deleteBytes } = await import('./ticketAttachmentStorage');
    await deleteBytes({ storageBackend: 'db', storageKey: null, data: Buffer.from('x') });
    expect(deleteObjects).not.toHaveBeenCalled();
    await deleteBytes({ storageBackend: 's3', storageKey: 'ticket-attachments/k', data: null });
    expect(deleteObjects).toHaveBeenCalledWith(['ticket-attachments/k']);
  });

  it('deleteObjectKeys forwards to the batching s3 primitive and skips an empty list', async () => {
    withS3();
    const { deleteObjectKeys } = await import('./ticketAttachmentStorage');
    await deleteObjectKeys([]);
    expect(deleteObjects).not.toHaveBeenCalled();
    await deleteObjectKeys(['a', 'b']);
    expect(deleteObjects).toHaveBeenCalledWith(['a', 'b']);
  });
});

describe('artifact-backed attachments (execution-plane spec §6.3)', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const ART = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  /**
   * `artifactService` is mocked per-test rather than at module scope: the suite
   * above imports `./ticketAttachmentStorage` dynamically after setting env, and
   * a module-scope mock of a module it only transitively reaches would apply to
   * those tests too.
   */
  async function loadWithArtifactService(overrides: {
    resolveArtifact?: ReturnType<typeof vi.fn>;
    openArtifactStream?: ReturnType<typeof vi.fn>;
  }) {
    const resolveArtifact = overrides.resolveArtifact ?? vi.fn();
    const openArtifactStream = overrides.openArtifactStream ?? vi.fn();
    vi.doMock('./artifacts/artifactService', () => ({ resolveArtifact, openArtifactStream }));
    const mod = await import('./ticketAttachmentStorage');
    return { ...mod, resolveArtifact, openArtifactStream };
  }

  it('streams the artifact when the row points at one', async () => {
    const stream = { pipe: () => {} };
    const { openBytes, resolveArtifact, openArtifactStream } = await loadWithArtifactService({
      resolveArtifact: vi.fn(async () => ({ id: ART, orgId: ORG, bytes: 8, blobKey: 'eu/a' })),
      openArtifactStream: vi.fn(async () => stream),
    });

    const opened = await openBytes(
      { storageBackend: 'artifact', storageKey: null, data: null, artifactId: ART },
      { orgId: ORG },
    );

    expect(resolveArtifact).toHaveBeenCalledWith(ART, { orgId: ORG });
    expect(opened.contentLength).toBe(8);
    expect(opened.body).toBe(stream);
    expect(openArtifactStream).toHaveBeenCalledTimes(1);
  });

  it('raises a 410 when the artifact has expired out from under the row', async () => {
    // ON DELETE SET NULL nulled the pointer: the attachment row survives, the
    // bytes do not. This must be distinguishable from "no such attachment".
    const { openBytes } = await loadWithArtifactService({});
    await expect(
      openBytes(
        { storageBackend: 'artifact', storageKey: null, data: null, artifactId: null },
        { orgId: ORG },
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED', status: 410 });
  });

  it('raises a 410 when no org scope is supplied — never resolves a handle unscoped', async () => {
    const { openBytes, resolveArtifact } = await loadWithArtifactService({});
    await expect(
      openBytes({ storageBackend: 'artifact', storageKey: null, data: null, artifactId: ART }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED', status: 410 });
    expect(resolveArtifact).not.toHaveBeenCalled();
  });

  it('raises a 410 when the pointer is set but the artifact no longer resolves in this org', async () => {
    const { openBytes } = await loadWithArtifactService({
      resolveArtifact: vi.fn(async () => null),
    });
    await expect(
      openBytes(
        { storageBackend: 'artifact', storageKey: null, data: null, artifactId: ART },
        { orgId: ORG },
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_EXPIRED', status: 410 });
  });

  it('deletes nothing of its own for an artifact row — the artifact owns the blob', async () => {
    const { deleteBytes } = await loadWithArtifactService({});
    await deleteBytes({ storageBackend: 'artifact', storageKey: null, data: null, artifactId: ART });
    expect(deleteObjects).not.toHaveBeenCalled();
  });
});
