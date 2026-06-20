import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  parseStreamingMultipart,
  MultipartError,
  type StreamedMultipart,
} from './streamingUpload';

function freshTempPath(): string {
  return join(tmpdir(), `streamingUpload-test-${randomUUID()}.bin`);
}

function multipartRequest(fd: FormData): { contentType: string; body: ReadableStream<Uint8Array> } {
  const req = new Request('http://test/', { method: 'POST', body: fd });
  return {
    contentType: req.headers.get('content-type')!,
    body: req.body as ReadableStream<Uint8Array>,
  };
}

describe('parseStreamingMultipart', () => {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((p) => unlink(p).catch(() => {})));
  });

  it('streams the file to disk, hashes it, and collects text fields', async () => {
    const content = 'hello-breeze-package-payload';
    const expected = createHash('sha256').update(content).digest('hex');
    const tempPath = freshTempPath();
    created.push(tempPath);

    const fd = new FormData();
    fd.append('version', '1.2.3');
    fd.append('architecture', 'x64');
    fd.append('file', new File([content], 'pkg.msi', { type: 'application/octet-stream' }));

    const { contentType, body } = multipartRequest(fd);
    const result: StreamedMultipart = await parseStreamingMultipart({
      contentType,
      body,
      tempPath,
      maxFileSize: 10 * 1024 * 1024,
    });

    expect(result.fields.version).toBe('1.2.3');
    expect(result.fields.architecture).toBe('x64');
    expect(result.file).not.toBeNull();
    expect(result.file!.filename).toBe('pkg.msi');
    expect(result.file!.checksum).toBe(expected);
    expect(result.file!.fileSize).toBe(Buffer.byteLength(content));
    // File actually landed on disk with the exact bytes.
    expect(await readFile(tempPath, 'utf8')).toBe(content);
  });

  it('streams a multi-megabyte file whose disk write outlives parse completion', async () => {
    // Large enough that the disk-write pipeline almost certainly settles AFTER
    // busboy emits `finish` — exercising the parsingDone + filePending gate that
    // the small-payload happy path does not. A regression dropping that gate
    // would resolve with file === null here.
    const big = Buffer.alloc(5 * 1024 * 1024, 0x61); // 5 MiB of 'a'
    const expected = createHash('sha256').update(big).digest('hex');
    const tempPath = freshTempPath();
    created.push(tempPath);

    const fd = new FormData();
    fd.append('file', new File([big], 'big.msi'));

    const { contentType, body } = multipartRequest(fd);
    const result = await parseStreamingMultipart({
      contentType,
      body,
      tempPath,
      maxFileSize: 50 * 1024 * 1024,
    });

    expect(result.file).not.toBeNull();
    expect(result.file!.fileSize).toBe(big.length);
    expect(result.file!.checksum).toBe(expected);
    // The full file must be on disk, not a field-buffered fragment.
    const onDisk = await readFile(tempPath);
    expect(onDisk.length).toBe(big.length);
  });

  it('rejects an over-limit text field with 413 instead of silently truncating', async () => {
    const tempPath = freshTempPath();
    const fd = new FormData();
    fd.append('preInstallScript', 'x'.repeat(2048));
    fd.append('file', new File(['payload'], 'pkg.msi'));

    const { contentType, body } = multipartRequest(fd);
    await expect(
      parseStreamingMultipart({
        contentType,
        body,
        tempPath,
        maxFileSize: 1024 * 1024,
        maxFieldSize: 1024,
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('surfaces a disk-write failure as a non-MultipartError and cleans up', async () => {
    // An un-creatable temp path (parent dir does not exist) makes the file
    // pipeline reject — the one branch that produces a non-MultipartError.
    const tempPath = join(tmpdir(), `no-such-dir-${randomUUID()}`, 'out.bin');
    const fd = new FormData();
    fd.append('file', new File(['payload-bytes'], 'pkg.msi'));

    const { contentType, body } = multipartRequest(fd);
    await expect(
      parseStreamingMultipart({ contentType, body, tempPath, maxFileSize: 1024 * 1024 }),
    ).rejects.toSatisfy((e: unknown) => e instanceof Error && !(e instanceof MultipartError));

    await expect(stat(tempPath)).rejects.toThrow();
  });

  it('returns file: null when no file part is present', async () => {
    const tempPath = freshTempPath();
    const fd = new FormData();
    fd.append('version', '1.0.0');

    const { contentType, body } = multipartRequest(fd);
    const result = await parseStreamingMultipart({
      contentType,
      body,
      tempPath,
      maxFileSize: 1024,
    });

    expect(result.file).toBeNull();
    expect(result.fields.version).toBe('1.0.0');
    // No temp file should have been written.
    await expect(stat(tempPath)).rejects.toThrow();
  });

  it('rejects an oversized file with a 413 and cleans up the temp file', async () => {
    const tempPath = freshTempPath();
    const big = 'x'.repeat(4096);
    const fd = new FormData();
    fd.append('file', new File([big], 'big.msi'));

    const { contentType, body } = multipartRequest(fd);
    await expect(
      parseStreamingMultipart({ contentType, body, tempPath, maxFileSize: 1024 }),
    ).rejects.toMatchObject({ status: 413 });

    // Partially-written temp file must be removed on failure.
    await expect(stat(tempPath)).rejects.toThrow();
  });

  it('lets onFile reject a disallowed file before bytes are written (415)', async () => {
    const tempPath = freshTempPath();
    const fd = new FormData();
    fd.append('file', new File(['payload'], 'evil.sh'));

    const { contentType, body } = multipartRequest(fd);
    await expect(
      parseStreamingMultipart({
        contentType,
        body,
        tempPath,
        maxFileSize: 1024 * 1024,
        onFile: ({ filename }) => {
          if (!filename.endsWith('.msi')) {
            throw new MultipartError('Unsupported file type', 415);
          }
        },
      }),
    ).rejects.toMatchObject({ status: 415, message: 'Unsupported file type' });

    await expect(stat(tempPath)).rejects.toThrow();
  });

  it('rejects a non-multipart content-type with 400', async () => {
    await expect(
      parseStreamingMultipart({
        contentType: 'application/json',
        body: new Request('http://x', { method: 'POST', body: '{}' }).body as ReadableStream<Uint8Array>,
        tempPath: freshTempPath(),
        maxFileSize: 1024,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a missing body with 400', async () => {
    await expect(
      parseStreamingMultipart({
        contentType: 'multipart/form-data; boundary=abc',
        body: null,
        tempPath: freshTempPath(),
        maxFileSize: 1024,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
