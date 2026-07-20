import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s3ClientCtorMock = vi.fn();
const s3SendMock = vi.fn(async () => ({}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class S3Client {
    constructor(config: unknown) {
      s3ClientCtorMock(config);
    }
    send = s3SendMock;
  },
  PutObjectCommand: class PutObjectCommand {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class GetObjectCommand {
    constructor(public input: unknown) {}
  },
  HeadObjectCommand: class HeadObjectCommand {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://signed.example.com/object'),
}));

vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => ({})),
  statSync: vi.fn(() => ({ size: 42 })),
}));

const ORIGINAL_ENV = { ...process.env };

// Sentry BREEZE-P: S3_ENDPOINT is operator-set (not per-tenant user input),
// but a scheme-less value used to reach the SDK unmodified and fail opaquely
// inside @smithy/core's endpoint resolver the first time S3 was used, instead
// of naming the misconfigured env var. Note the two shapes fail differently:
// a bare host ("s3.example.com") throws `TypeError: Invalid URL`, while
// "minio.local:9000" parses into a URL with an empty host and fails later as
// a connection error — see coerceS3EndpointUrl.
describe('s3Storage getS3Client (via uploadBinary)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    process.env.S3_BUCKET = 'binaries';
    process.env.S3_ACCESS_KEY = 'key';
    process.env.S3_SECRET_KEY = 'secret';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('normalizes a scheme-less S3_ENDPOINT to https:// before constructing the client', async () => {
    process.env.S3_ENDPOINT = 'minio.local:9000';
    const { uploadBinary } = await import('./s3Storage');

    await uploadBinary('/tmp/binary', 'binaries/agent.bin');

    expect(s3ClientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://minio.local:9000/' }),
    );
  });

  it('passes through an already-schemed S3_ENDPOINT unchanged', async () => {
    process.env.S3_ENDPOINT = 'https://minio.local:9000';
    const { uploadBinary } = await import('./s3Storage');

    await uploadBinary('/tmp/binary', 'binaries/agent.bin');

    expect(s3ClientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://minio.local:9000/' }),
    );
  });

  it('omits endpoint entirely when S3_ENDPOINT is unset (default AWS endpoint)', async () => {
    delete process.env.S3_ENDPOINT;
    const { uploadBinary } = await import('./s3Storage');

    await uploadBinary('/tmp/binary', 'binaries/agent.bin');

    expect(s3ClientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: undefined }),
    );
  });

  it('throws a clear error naming S3_ENDPOINT (not "Invalid URL") for a malformed value', async () => {
    process.env.S3_ENDPOINT = 'not a valid url with spaces';
    const { uploadBinary } = await import('./s3Storage');

    await expect(uploadBinary('/tmp/binary', 'binaries/agent.bin')).rejects.toThrow(
      /Invalid S3_ENDPOINT env var/,
    );
    expect(s3ClientCtorMock).not.toHaveBeenCalled();
  });
});
