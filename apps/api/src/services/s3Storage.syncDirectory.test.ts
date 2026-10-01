import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #7574: syncBinaries() registers the new release in agent_versions BEFORE it
// mirrors the staged files to S3. If one upload fails, the previous release's
// object stays at that key and every download route presigns it — agents get
// old bytes under the new checksum (the #7516 checksum-loop shape). These
// tests drive the real syncDirectory() against a fake bucket and assert the
// stale object is never handed out again by the read primitives every
// download path uses (getPresignedUrl / getObjectStream).

type FakeObject = { body: Buffer; sha256?: string };
const bucket = new Map<string, FakeObject>();
const failPutFor = new Map<string, number>(); // key -> remaining failures (Infinity = always)
let failDelete = false;

function s3Error(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

const s3SendMock = vi.fn(async (command: { kind: string; input: Record<string, any> }) => {
  const key = command.input.Key as string;
  switch (command.kind) {
    case 'head': {
      const obj = bucket.get(key);
      if (!obj) throw s3Error('NotFound');
      return { ContentLength: obj.body.length, Metadata: obj.sha256 ? { sha256: obj.sha256 } : {} };
    }
    case 'get': {
      const obj = bucket.get(key);
      if (!obj) throw s3Error('NoSuchKey');
      return { Body: obj.body, ContentLength: obj.body.length };
    }
    case 'put': {
      const remaining = failPutFor.get(key) ?? 0;
      if (remaining > 0) {
        failPutFor.set(key, remaining - 1);
        // Drain the stream so the fd closes, then fail like a provider 5xx.
        for await (const _ of command.input.Body) { /* discard */ }
        throw s3Error('InternalError');
      }
      const chunks: Buffer[] = [];
      for await (const chunk of command.input.Body) chunks.push(chunk as Buffer);
      bucket.set(key, { body: Buffer.concat(chunks), sha256: command.input.Metadata?.sha256 });
      return {};
    }
    case 'delete': {
      if (failDelete) throw s3Error('AccessDenied');
      bucket.delete(key);
      return {};
    }
    default:
      throw new Error(`unexpected command ${command.kind}`);
  }
});

vi.mock('@aws-sdk/client-s3', () => {
  const cmd = (kind: string) =>
    class {
      kind = kind;
      constructor(public input: Record<string, unknown>) {}
    };
  return {
    S3Client: class S3Client {
      send = s3SendMock;
    },
    PutObjectCommand: cmd('put'),
    GetObjectCommand: cmd('get'),
    HeadObjectCommand: cmd('head'),
    DeleteObjectCommand: cmd('delete'),
    DeleteObjectsCommand: cmd('deleteMany'),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: { input: { Key: string } }) =>
    `https://signed.example.com/${command.input.Key}`,
  ),
}));

const ORIGINAL_ENV = { ...process.env };
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const OLD_AGENT = Buffer.from('agent-v1.0.0-bytes');
const NEW_AGENT = Buffer.from('agent-v1.1.0-bytes-new');
const NEW_WATCHDOG = Buffer.from('watchdog-v1.1.0-bytes');

describe('syncDirectory: a failed upload never leaves the stale object servable (#7574)', { timeout: 30_000 }, () => {
  let dir: string;

  beforeEach(async () => {
    vi.resetModules();
    s3SendMock.mockClear();
    bucket.clear();
    failPutFor.clear();
    failDelete = false;
    process.env = { ...ORIGINAL_ENV, S3_BUCKET: 'binaries', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's' };
    dir = await mkdtemp(join(tmpdir(), 'binsync-7574-'));
    await writeFile(join(dir, 'breeze-agent-linux-amd64'), NEW_AGENT);
    await writeFile(join(dir, 'breeze-watchdog-linux-amd64'), NEW_WATCHDOG);
    // The previous release's object is already in the bucket under the key.
    bucket.set('agent/breeze-agent-linux-amd64', { body: OLD_AGENT, sha256: sha256(OLD_AGENT) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the failed key and removes the previous release object so readers fall back to disk', async () => {
    failPutFor.set('agent/breeze-agent-linux-amd64', Infinity);
    const s3 = await import('./s3Storage');

    const result = await s3.syncDirectory(dir, 'agent', { retryDelayMs: 0 });

    expect(result.uploaded).toBe(1); // the watchdog
    expect(result.failedKeys).toEqual(['agent/breeze-agent-linux-amd64']);
    expect(result.errors).toHaveLength(1);

    const presign = s3.getPresignedUrl('agent/breeze-agent-linux-amd64');
    await expect(presign).rejects.toSatisfy((err: unknown) => s3.isS3NotFound(err));
    expect((await s3.getObjectStream('agent/breeze-agent-linux-amd64')).body).toBeNull();
    // The old bytes are gone from the bucket, so other API replicas miss too.
    expect(bucket.has('agent/breeze-agent-linux-amd64')).toBe(false);

    // Siblings that uploaded fine are still offloaded to S3.
    await expect(s3.getPresignedUrl('agent/breeze-watchdog-linux-amd64')).resolves.toContain(
      'agent/breeze-watchdog-linux-amd64',
    );
  });

  it('still refuses to serve the stale object when the compensating delete also fails', async () => {
    failPutFor.set('agent/breeze-agent-linux-amd64', Infinity);
    failDelete = true;
    const s3 = await import('./s3Storage');

    const result = await s3.syncDirectory(dir, 'agent', { retryDelayMs: 0 });

    expect(result.failedKeys).toEqual(['agent/breeze-agent-linux-amd64']);
    // The old object is physically still there...
    expect(bucket.get('agent/breeze-agent-linux-amd64')?.body.equals(OLD_AGENT)).toBe(true);
    // ...but this process never presigns or streams it (no S3 read is even sent).
    const sentBeforeReads = s3SendMock.mock.calls.length;
    await expect(s3.getPresignedUrl('agent/breeze-agent-linux-amd64')).rejects.toSatisfy((err: unknown) =>
      s3.isS3NotFound(err),
    );
    expect((await s3.getObjectStream('agent/breeze-agent-linux-amd64')).body).toBeNull();
    expect(s3SendMock.mock.calls.length).toBe(sentBeforeReads);
  });

  it('retries a transient upload failure and serves the new object', async () => {
    failPutFor.set('agent/breeze-agent-linux-amd64', 1);
    const s3 = await import('./s3Storage');

    const result = await s3.syncDirectory(dir, 'agent', { retryDelayMs: 0 });

    expect(result.failedKeys).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.uploaded).toBe(2);
    expect(bucket.get('agent/breeze-agent-linux-amd64')?.body.equals(NEW_AGENT)).toBe(true);
    await expect(s3.getPresignedUrl('agent/breeze-agent-linux-amd64')).resolves.toContain(
      'agent/breeze-agent-linux-amd64',
    );
  });

  it('after one file exhausts its retries, later files get a single attempt (bounded boot delay)', async () => {
    failPutFor.set('agent/breeze-agent-linux-amd64', Infinity);
    failPutFor.set('agent/breeze-watchdog-linux-amd64', Infinity);
    const s3 = await import('./s3Storage');

    const result = await s3.syncDirectory(dir, 'agent', { retryDelayMs: 0 });

    expect([...result.failedKeys].sort()).toEqual([
      'agent/breeze-agent-linux-amd64',
      'agent/breeze-watchdog-linux-amd64',
    ]);
    const puts = s3SendMock.mock.calls.filter(([c]) => c.kind === 'put').length;
    expect(puts).toBe(3 + 1);
  });

  it('a later successful upload of the key makes it servable again', async () => {
    failPutFor.set('agent/breeze-agent-linux-amd64', Infinity);
    failDelete = true;
    const s3 = await import('./s3Storage');
    await s3.syncDirectory(dir, 'agent', { retryDelayMs: 0 });

    failPutFor.clear();
    const result = await s3.syncDirectory(dir, 'agent', { retryDelayMs: 0 });

    expect(result.failedKeys).toEqual([]);
    expect(bucket.get('agent/breeze-agent-linux-amd64')?.body.equals(NEW_AGENT)).toBe(true);
    await expect(s3.getPresignedUrl('agent/breeze-agent-linux-amd64')).resolves.toContain(
      'agent/breeze-agent-linux-amd64',
    );
  });
});
