import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setBackupS3ClientFactoryForTests,
  BackupObjectTooLargeError,
  isBackupObjectNotFound,
  isBackupObjectTooLarge,
  MANIFEST_FETCH_MAX_BYTES,
  MANIFEST_STREAM_MAX_BYTES,
  openBackupObjectStream,
} from './backupSnapshotStorage';

describe('openBackupObjectStream (#11026)', () => {
  const S3 = { bucket: 'b', region: 'us-east-1', accessKey: 'a', secretKey: 's' };
  const read = async (stream: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  };

  afterEach(() => {
    __setBackupS3ClientFactoryForTests(null);
  });

  const s3Returning = (response: Record<string, unknown>) => {
    __setBackupS3ClientFactoryForTests(() => ({ send: vi.fn().mockResolvedValue(response) }) as never);
  };

  it('MANIFEST_STREAM_MAX_BYTES is 2 GiB and the buffered cap is unchanged', () => {
    expect(MANIFEST_STREAM_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(MANIFEST_FETCH_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  it('s3: streams the body', async () => {
    s3Returning({ Body: Readable.from([Buffer.from('hello '), Buffer.from('world')]), ContentLength: 11 });
    const stream = await openBackupObjectStream({ provider: 's3', providerConfig: S3, key: 'k', maxBytes: 100 });
    expect((await read(stream)).toString()).toBe('hello world');
  });

  it('s3: a declared length over the cap rejects before reading and releases the connection', async () => {
    const body = new PassThrough();
    const readSpy = vi.spyOn(body, 'read');
    s3Returning({ Body: body, ContentLength: 101 });
    await expect(openBackupObjectStream({ provider: 's3', providerConfig: S3, key: 'k', maxBytes: 100 })).rejects.toBeInstanceOf(BackupObjectTooLargeError);
    expect(readSpy).not.toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
  });

  it('s3: a body with no declared length errors mid-stream once it passes the cap', async () => {
    s3Returning({ Body: Readable.from([Buffer.alloc(60), Buffer.alloc(60), Buffer.alloc(60)]) });
    const stream = await openBackupObjectStream({ provider: 's3', providerConfig: S3, key: 'k', maxBytes: 100 });
    const failure = await read(stream).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(BackupObjectTooLargeError);
    expect(isBackupObjectTooLarge(failure)).toBe(true);
  });

  it('s3: a body shorter than its declared length is an error, not the end of the object', async () => {
    s3Returning({ Body: Readable.from([Buffer.alloc(10)]), ContentLength: 20 });
    const stream = await openBackupObjectStream({ provider: 's3', providerConfig: S3, key: 'k', maxBytes: 100 });
    await expect(read(stream)).rejects.toThrow(/10 of 20/);
  });

  it('s3: a missing object rejects so the caller can classify it', async () => {
    const notFound = Object.assign(new Error('gone'), { name: 'NoSuchKey' });
    __setBackupS3ClientFactoryForTests(() => ({ send: vi.fn().mockRejectedValue(notFound) }) as never);
    const failure = await openBackupObjectStream({ provider: 's3', providerConfig: S3, key: 'k', maxBytes: 100 }).catch((err: unknown) => err);
    expect(isBackupObjectNotFound(failure)).toBe(true);
  });

  it('s3: a body error reaches the reader', async () => {
    async function* broken() {
      yield Buffer.alloc(5);
      throw new Error('connection reset');
    }
    s3Returning({ Body: Readable.from(broken()) });
    const stream = await openBackupObjectStream({ provider: 's3', providerConfig: S3, key: 'k', maxBytes: 100 });
    await expect(read(stream)).rejects.toThrow('connection reset');
  });

  it('s3: an empty response body is an error', async () => {
    s3Returning({ ContentLength: 0 });
    await expect(openBackupObjectStream({ provider: 's3', providerConfig: S3, key: 'k', maxBytes: 100 })).rejects.toThrow(/Empty response body/);
  });

  describe('local', () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'breeze-stream-local-'));
      await mkdir(join(root, 'snapshots', 's'), { recursive: true });
      await writeFile(join(root, 'snapshots', 's', 'manifest.json'), '0123456789');
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('streams the file', async () => {
      const stream = await openBackupObjectStream({ provider: 'local', providerConfig: { path: root }, key: 'snapshots/s/manifest.json', maxBytes: 10 });
      expect((await read(stream)).toString()).toBe('0123456789');
    });

    it('a file over the cap rejects from its stat, before reading', async () => {
      await expect(openBackupObjectStream({ provider: 'local', providerConfig: { path: root }, key: 'snapshots/s/manifest.json', maxBytes: 9 })).rejects.toBeInstanceOf(BackupObjectTooLargeError);
    });

    it('a missing file rejects so the caller can classify it', async () => {
      const failure = await openBackupObjectStream({ provider: 'local', providerConfig: { path: root }, key: 'snapshots/s/nope.json', maxBytes: 9 }).catch((err: unknown) => err);
      expect(isBackupObjectNotFound(failure)).toBe(true);
    });

    it('a key escaping the root is refused', async () => {
      await expect(openBackupObjectStream({ provider: 'local', providerConfig: { path: root }, key: '../../etc/passwd', maxBytes: 9 })).rejects.toThrow();
    });
  });

  it('refuses a provider it cannot read', async () => {
    await expect(openBackupObjectStream({ provider: 'gcs', providerConfig: {}, key: 'k', maxBytes: 1 })).rejects.toThrow(/does not support/);
  });
});
