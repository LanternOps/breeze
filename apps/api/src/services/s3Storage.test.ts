import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

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

// Every test here calls `vi.resetModules()` then `await import('./s3Storage')`,
// so the first one to run pays the cold transform of the @aws-sdk/client-s3
// graph. On a loaded machine that alone can exceed the 5s default and fail
// whichever test happens to be first — nothing to do with the assertion. Give
// the dynamic-import suites headroom instead of letting them flake.
const IMPORT_TIMEOUT_MS = 30_000;

// Sentry BREEZE-P: S3_ENDPOINT is operator-set (not per-tenant user input),
// but a scheme-less value used to reach the SDK unmodified and fail opaquely
// inside @smithy/core's endpoint resolver the first time S3 was used, instead
// of naming the misconfigured env var. Note the two shapes fail differently:
// a bare host ("s3.example.com") throws `TypeError: Invalid URL`, while
// "minio.local:9000" parses into a URL with an empty host and fails later as
// a connection error — see coerceS3EndpointUrl.
describe('s3Storage getS3Client (via uploadBinary)', { timeout: IMPORT_TIMEOUT_MS }, () => {
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
    const { uploadBinary, S3ConfigError } = await import('./s3Storage');

    await expect(uploadBinary('/tmp/binary', 'binaries/agent.bin')).rejects.toThrow(
      /Invalid S3_ENDPOINT env var/,
    );
    await expect(uploadBinary('/tmp/binary', 'binaries/agent.bin')).rejects.toBeInstanceOf(
      S3ConfigError,
    );
    expect(s3ClientCtorMock).not.toHaveBeenCalled();
  });

  // `coerceS3EndpointUrl` quotes the offending value back in its message, and an
  // S3-compatible endpoint can carry inline credentials. The upload route
  // returns this error's text to the caller, so the client-facing variant must
  // name the env var without echoing the value (#2794).
  it('keeps inline endpoint credentials out of the client-facing message', async () => {
    process.env.S3_ENDPOINT = 's3://AKIAIOSFODNN7EXAMPLE:sUp3r-s3cr3t@bucket.example.com';
    const { uploadBinary, S3ConfigError } = await import('./s3Storage');

    const err = (await uploadBinary('/tmp/binary', 'binaries/agent.bin').catch(
      (e: unknown) => e,
    )) as InstanceType<typeof S3ConfigError>;

    expect(err).toBeInstanceOf(S3ConfigError);
    expect(err.clientMessage).toMatch(/S3_ENDPOINT/);
    expect(err.clientMessage).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(err.clientMessage).not.toMatch(/sUp3r-s3cr3t/);
  });

  // `message` is not returned to an API caller, but it does reach Sentry and
  // any logger that prints `err.message`. Neither is a place for a secret, so
  // the userinfo is stripped at construction — the rest of the bad value stays
  // so the operator can still see what they typed wrong (#2794).
  it('redacts inline endpoint credentials from the detailed message too', async () => {
    process.env.S3_ENDPOINT = 's3://AKIAIOSFODNN7EXAMPLE:sUp3r-s3cr3t@bucket.example.com';
    const { uploadBinary } = await import('./s3Storage');

    const err = (await uploadBinary('/tmp/binary', 'binaries/agent.bin').catch(
      (e: unknown) => e,
    )) as Error;

    expect(err.message).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(err.message).not.toMatch(/sUp3r-s3cr3t/);
    // Still diagnosable: the env var, the redaction marker, and the host.
    expect(err.message).toMatch(/Invalid S3_ENDPOINT env var/);
    expect(err.message).toMatch(/s3:\/\/\*\*\*@bucket\.example\.com/);
  });
});

// #2794: every object-storage fault used to propagate to the global error
// handler as `500 {error:'Internal Server Error'}`, so a self-hoster saw
// "Failed to upload version" with no path to a cause. These lock in the mapping
// from the codes the SDK / Node net+TLS layers actually emit onto hints that
// name the env var to fix.
describe('classifyS3Failure', { timeout: IMPORT_TIMEOUT_MS }, () => {
  /** An AWS SDK service error: code on `name`, message may echo request detail. */
  function awsError(name: string, extra: Record<string, unknown> = {}): Error {
    const err = new Error(`provider response mentioning ${name}`);
    err.name = name;
    return Object.assign(err, extra);
  }

  const cases: Array<[string, Error, string, RegExp]> = [
    ['InvalidAccessKeyId', awsError('InvalidAccessKeyId'), 'credentials_invalid', /S3_ACCESS_KEY/],
    ['SignatureDoesNotMatch', awsError('SignatureDoesNotMatch'), 'credentials_signature', /S3_SECRET_KEY/],
    ['NoSuchBucket', awsError('NoSuchBucket'), 'bucket_missing', /S3_BUCKET/],
    ['AccessDenied', awsError('AccessDenied'), 'access_denied', /s3:PutObject/],
    ['PermanentRedirect', awsError('PermanentRedirect'), 'region_mismatch', /S3_REGION/],
    ['RequestTimeTooSkewed', awsError('RequestTimeTooSkewed'), 'clock_skew', /NTP/],
    ['ECONNREFUSED', awsError('Error', { code: 'ECONNREFUSED' }), 'endpoint_refused', /S3_ENDPOINT/],
    ['ENOTFOUND', awsError('Error', { code: 'ENOTFOUND' }), 'endpoint_dns', /resolve/i],
    ['ETIMEDOUT', awsError('Error', { code: 'ETIMEDOUT' }), 'endpoint_unreachable', /firewall/],
    [
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      awsError('Error', { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
      'endpoint_tls',
      /self-signed/,
    ],
  ];

  for (const [label, err, expectedCode, messagePattern] of cases) {
    it(`maps ${label} to ${expectedCode} with an actionable hint`, async () => {
      const { classifyS3Failure } = await import('./s3Storage');
      const result = classifyS3Failure(err);
      expect(result.code).toBe(expectedCode);
      expect(result.message).toMatch(messagePattern);
    });
  }

  it('matches any OpenSSL CERT_* variant by prefix', async () => {
    const { classifyS3Failure } = await import('./s3Storage');
    expect(classifyS3Failure(awsError('Error', { code: 'CERT_HAS_EXPIRED' })).code).toBe(
      'endpoint_tls',
    );
    expect(classifyS3Failure(awsError('Error', { code: 'CERT_SIGNATURE_FAILURE' })).code).toBe(
      'endpoint_tls',
    );
  });

  it('finds the code on a wrapped cause chain, not just the top-level error', async () => {
    const { classifyS3Failure } = await import('./s3Storage');
    const socketErr = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const wrapped = new Error('failed to send request', { cause: socketErr });

    expect(classifyS3Failure(wrapped).code).toBe('endpoint_refused');
  });

  it('falls back to provider_error for a 5xx with no recognizable code', async () => {
    const { classifyS3Failure } = await import('./s3Storage');
    const err = awsError('InternalError', { $metadata: { httpStatusCode: 503 } });

    const result = classifyS3Failure(err);
    expect(result.code).toBe('provider_error');
    expect(result.message).toMatch(/HTTP 503/);
  });

  it('echoes an unmapped provider code so MinIO-specific faults stay greppable', async () => {
    const { classifyS3Failure } = await import('./s3Storage');
    const result = classifyS3Failure(awsError('XMinioServerNotInitialized'));

    expect(result.code).toBe('unknown');
    expect(result.message).toMatch(/XMinioServerNotInitialized/);
  });

  it('returns a generic hint when there is no code at all', async () => {
    const { classifyS3Failure } = await import('./s3Storage');
    const result = classifyS3Failure(new Error('boom'));

    expect(result.code).toBe('unknown');
    expect(result.message).toMatch(/unrecognized reason/);
  });

  it('strips characters that could inject a newline into a log line', async () => {
    const { classifyS3Failure } = await import('./s3Storage');
    const result = classifyS3Failure(awsError('Bad\nCode\rInjected'));

    expect(result.message).not.toMatch(/[\n\r]/);
  });

  // The classification message is returned to an API caller, and provider
  // responses for signature/permission faults can echo the access key id and
  // the string-to-sign. Curated text only — never the raw provider message.
  it('never echoes the raw provider message, which can contain credentials', async () => {
    const { classifyS3Failure } = await import('./s3Storage');
    const leaky = new Error(
      'SignatureDoesNotMatch: AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE StringToSign=PUT\nsecret-material-here',
    );
    leaky.name = 'SignatureDoesNotMatch';

    const result = classifyS3Failure(leaky);
    expect(result.message).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(result.message).not.toMatch(/StringToSign/);
    expect(result.message).not.toMatch(/secret-material-here/);
  });
});

describe('uploadBinary object-storage error handling', { timeout: IMPORT_TIMEOUT_MS }, () => {
  const FAKE_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  const FAKE_SECRET_KEY = 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY';
  let consoleErrorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    process.env.S3_BUCKET = 'binaries';
    process.env.S3_ACCESS_KEY = FAKE_ACCESS_KEY;
    process.env.S3_SECRET_KEY = FAKE_SECRET_KEY;
    process.env.S3_ENDPOINT = 'https://minio.internal.example:9000/some/path';
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
  });

  it('throws S3OperationError carrying the mapped hint, code, and original cause', async () => {
    const { uploadBinary, S3OperationError } = await import('./s3Storage');
    const original = Object.assign(new Error('nope'), { name: 'NoSuchBucket' });
    s3SendMock.mockRejectedValueOnce(original);

    const err = await uploadBinary('/tmp/binary', 'software/org-1/cat-2/ver-3/setup.msi').catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(S3OperationError);
    const opErr = err as InstanceType<typeof S3OperationError>;
    expect(opErr.failureCode).toBe('bucket_missing');
    expect(opErr.operation).toBe('uploadBinary');
    expect(opErr.message).toMatch(/S3_BUCKET/);
    // Preserved so Sentry still receives the full underlying error.
    expect(opErr.cause).toBe(original);
  });

  it('logs the bucket, endpoint host, and key prefix so the fault is greppable', async () => {
    const { uploadBinary } = await import('./s3Storage');
    s3SendMock.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    );

    await uploadBinary('/tmp/binary', 'software/org-1/cat-2/ver-3/setup.msi').catch(() => {});

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const line = String(consoleErrorSpy.mock.calls[0]![0]);
    expect(line).toContain('reason=endpoint_refused');
    expect(line).toContain('providerCode=ECONNREFUSED');
    expect(line).toContain('bucket=binaries');
    // HOST only — no scheme, no path, no userinfo.
    expect(line).toContain('endpoint=minio.internal.example:9000');
    expect(line).not.toContain('/some/path');
    expect(line).toContain('keyPrefix=software/org-1/cat-2/ver-3/');
  });

  it('never writes credentials or the operator-supplied filename into the log', async () => {
    const { uploadBinary } = await import('./s3Storage');
    s3SendMock.mockRejectedValueOnce(
      Object.assign(
        new Error('AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE StringToSign=PUT/secret-material'),
        { name: 'SignatureDoesNotMatch' },
      ),
    );

    await uploadBinary(
      '/tmp/binary',
      'software/org-1/cat-2/ver-3/evil\nINJECTED-LOG-LINE.msi',
    ).catch(() => {});

    const line = String(consoleErrorSpy.mock.calls[0]![0]);
    expect(line).not.toContain(FAKE_ACCESS_KEY);
    expect(line).not.toContain(FAKE_SECRET_KEY);
    expect(line).not.toContain('StringToSign');
    expect(line).not.toContain('secret-material');
    // Final path segment is an operator-supplied filename => untrusted log input.
    expect(line).not.toContain('INJECTED-LOG-LINE');
    expect(line).not.toMatch(/[\n\r]/);
  });

  // The log line reports the endpoint so an operator can tell which storage
  // target failed, and it derives that from `URL.host` precisely because host
  // drops userinfo. An endpoint configured as `https://key:secret@host` must
  // therefore log as the bare host (#2794).
  it('logs only the endpoint host when S3_ENDPOINT carries inline credentials', async () => {
    process.env.S3_ENDPOINT = 'https://AKIAIOSFODNN7EXAMPLE:sUp3r-s3cr3t@minio.internal.example:9000';
    const { uploadBinary } = await import('./s3Storage');
    s3SendMock.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    );

    await uploadBinary('/tmp/binary', 'software/org-1/cat-2/ver-3/setup.msi').catch(() => {});

    const line = String(consoleErrorSpy.mock.calls[0]![0]);
    expect(line).toContain('endpoint=minio.internal.example:9000');
    expect(line).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(line).not.toContain('sUp3r-s3cr3t');
  });

  it('clamps S3_BUCKET so a stray newline cannot break the log line', async () => {
    process.env.S3_BUCKET = 'binaries\nFAKE-LOG-LINE';
    const { uploadBinary } = await import('./s3Storage');
    s3SendMock.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    );

    await uploadBinary('/tmp/binary', 'software/org-1/cat-2/ver-3/setup.msi').catch(() => {});

    const line = String(consoleErrorSpy.mock.calls[0]![0]);
    expect(line).not.toMatch(/[\n\r]/);
    // Collapsed onto one field rather than forging a second log record.
    expect(line).toContain('bucket=binariesFAKE-LOG-LINE endpoint=');
  });

  it('resolves normally when the upload succeeds (no error path regression)', async () => {
    const { uploadBinary } = await import('./s3Storage');

    await expect(
      uploadBinary('/tmp/binary', 'software/org-1/cat-2/ver-3/setup.msi'),
    ).resolves.toBeUndefined();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
