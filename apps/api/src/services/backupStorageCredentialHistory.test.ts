import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  withSystemDbAccessContext: <T>(fn: () => T): T => fn(),
  withDbAccessContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
}));

import {
  SEALED_PREVIOUS_SECRET_RETENTION_MS,
  classifyProbeError,
  credentialFingerprint,
  openSealedConnection,
  probeS3Credential,
  s3CredentialOf,
  sealConnection,
} from './backupStorageCredentialHistory';

const CONNECTION = {
  endpoint: 'https://storage.example',
  region: 'us-east-1',
  bucket: 'backups',
  accessKey: 'AKIA-SYNTHETIC-OLD',
  secretKey: 'synthetic-old-secret-value',
};

beforeAll(() => {
  // A key id makes the row binding real (without one, every deployment's
  // secrets use the legacy format, which ignores the binding).
  process.env.APP_ENCRYPTION_KEY = 'unit-test-app-encryption-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'unit';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('credentialFingerprint', () => {
  it('is sha256 hex of `<access key id>|<storage identity>`', () => {
    const expected = createHash('sha256').update('AKIA-SYNTHETIC-OLD|s3::storage.example::backups').digest('hex');
    expect(credentialFingerprint('AKIA-SYNTHETIC-OLD', 's3::storage.example::backups')).toBe(expected);
  });

  it('is stable, and differs by key and by storage', () => {
    const a = credentialFingerprint('AK1', 'id-1');
    expect(credentialFingerprint('AK1', 'id-1')).toBe(a);
    expect(credentialFingerprint('AK2', 'id-1')).not.toBe(a);
    expect(credentialFingerprint('AK1', 'id-2')).not.toBe(a);
  });
});

describe('s3CredentialOf', () => {
  it('reads the canonical and the AWS spellings of the key pair', () => {
    const a = s3CredentialOf('s3', CONNECTION);
    const b = s3CredentialOf('s3', {
      endpoint: CONNECTION.endpoint,
      region: CONNECTION.region,
      bucket: CONNECTION.bucket,
      accessKeyId: CONNECTION.accessKey,
      secretAccessKey: CONNECTION.secretKey,
    });
    expect(a).not.toBeNull();
    expect(b?.fingerprint).toBe(a?.fingerprint);
    expect(a?.connection).toEqual(CONNECTION);
  });

  it('has no credential for a local destination, a non-S3 provider or a destination without a key pair', () => {
    expect(s3CredentialOf('local', { path: '/backups' })).toBeNull();
    expect(s3CredentialOf('azure_blob', { accountKey: 'k' })).toBeNull();
    expect(s3CredentialOf('s3', { ...CONNECTION, accessKey: '' })).toBeNull();
    expect(s3CredentialOf('s3', { ...CONNECTION, secretKey: undefined })).toBeNull();
    expect(s3CredentialOf('s3', null)).toBeNull();
  });

  it('changes when the secret changes even if the key id does not', () => {
    const a = s3CredentialOf('s3', CONNECTION)!;
    const b = s3CredentialOf('s3', { ...CONNECTION, secretKey: 'another-secret' })!;
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.secretDigest).not.toBe(a.secretDigest);
  });
});

describe('sealed connection settings', () => {
  const ROW = '11111111-1111-4111-8111-111111111111';
  const OTHER_ROW = '22222222-2222-4222-8222-222222222222';

  it('round-trips, and never holds the secret in the clear', () => {
    const sealed = sealConnection(ROW, CONNECTION);
    expect(sealed).not.toContain(CONNECTION.secretKey);
    expect(sealed).not.toContain(CONNECTION.accessKey);
    expect(openSealedConnection(ROW, sealed)).toEqual(CONNECTION);
  });

  it('is bound to its row: another row cannot open it', () => {
    const sealed = sealConnection(ROW, CONNECTION);
    expect(() => openSealedConnection(OTHER_ROW, sealed)).toThrow();
  });

  it('is kept for 30 days at most', () => {
    expect(SEALED_PREVIOUS_SECRET_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

function awsError(name: string, httpStatusCode = 403): Error {
  const err = new Error(`${name} message`) as Error & { name: string; Code?: string; $metadata?: { httpStatusCode: number } };
  err.name = name;
  err.Code = name;
  err.$metadata = { httpStatusCode };
  return err;
}

describe('classifyProbeError', () => {
  it.each(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied'])('reads %s as the key being refused', (code) => {
    expect(classifyProbeError(awsError(code))).toEqual({ outcome: 'denied', code });
  });

  it.each([
    ['a network error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['a timeout', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['a missing bucket', awsError('NoSuchBucket', 404)],
    ['a server error', awsError('InternalError', 500)],
    ['a refused endpoint', new Error('Refusing to connect to a private network address')],
  ])('never reads %s as the key being refused', (_name, err) => {
    expect(classifyProbeError(err).outcome).toBe('inconclusive');
  });
});

describe('probeS3Credential', () => {
  it('lists at most one key with the old credential and reports it still works on success', async () => {
    const send = vi.fn(async () => ({ KeyCount: 0 }));
    const build = vi.fn(() => ({ bucket: 'backups', client: { send, destroy: vi.fn() } }));
    const res = await probeS3Credential(CONNECTION, { buildClient: build as never });
    expect(res).toEqual({ outcome: 'live', code: null });
    expect(build).toHaveBeenCalledWith(CONNECTION);
    const [command] = send.mock.calls[0] as unknown as [{ input: Record<string, unknown> }];
    expect(command.input).toMatchObject({ Bucket: 'backups', MaxKeys: 1 });
  });

  it('reports a refused key as denied', async () => {
    const send = vi.fn(async () => { throw awsError('InvalidAccessKeyId'); });
    const res = await probeS3Credential(CONNECTION, {
      buildClient: (() => ({ bucket: 'backups', client: { send, destroy: vi.fn() } })) as never,
    });
    expect(res).toEqual({ outcome: 'denied', code: 'InvalidAccessKeyId' });
  });

  it('reports a client that cannot be built (bad endpoint) as inconclusive, not denied', async () => {
    const res = await probeS3Credential(CONNECTION, {
      buildClient: (() => { throw new Error('S3 backup storage is misconfigured'); }) as never,
    });
    expect(res.outcome).toBe('inconclusive');
  });

  it('never writes the secret or the key id to the log', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(JSON.stringify(args)); });
    }
    const send = vi.fn(async () => { throw Object.assign(new Error(`bad ${CONNECTION.secretKey}`), { code: 'ECONNRESET' }); });
    await probeS3Credential(CONNECTION, {
      buildClient: (() => ({ bucket: 'backups', client: { send, destroy: vi.fn() } })) as never,
    });
    expect(logged.join('\n')).not.toContain(CONNECTION.secretKey);
    expect(logged.join('\n')).not.toContain(CONNECTION.accessKey);
  });
});
