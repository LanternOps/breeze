import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { configsRoutes } from './configs';

const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'set', 'values']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const checkBackupProviderCapabilitiesMock = vi.fn();
const s3SendMock = vi.fn();
const s3ClientCtorMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    // Default-destination demote + promote run in one transaction so a failed
    // write can't leave the org with no default. The tx routes through the same
    // insert/update mocks, so assertions below see every statement.
    transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        select: (...args: unknown[]) => selectMock(...(args as [])),
        insert: (...args: unknown[]) => insertMock(...(args as [])),
        update: (...args: unknown[]) => updateMock(...(args as [])),
      }),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    name: 'backup_configs.name',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
  },
}));

vi.mock('../../services/backupSnapshotStorage', () => ({
  checkBackupProviderCapabilities: (...args: unknown[]) => checkBackupProviderCapabilitiesMock(...(args as [])),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      token: { sub: 'user-1' },
    });
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

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
  DeleteObjectCommand: class DeleteObjectCommand {
    constructor(public input: unknown) {}
  },
}));

import { authMiddleware } from '../../middleware/auth';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: CONFIG_ID,
    orgId: ORG_ID,
    name: 'Primary S3',
    type: 'file',
    provider: 's3',
    providerConfig: {
      bucket: 'backups',
      region: 'us-east-1',
      accessKey: 'key',
      secretKey: 'secret',
    },
    providerCapabilities: null,
    providerCapabilitiesCheckedAt: null,
    isActive: true,
    createdAt: new Date('2026-03-31T00:00:00.000Z'),
    updatedAt: new Date('2026-03-31T00:00:00.000Z'),
    ...overrides,
  };
}

describe('backup config routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    checkBackupProviderCapabilitiesMock.mockReset();
    s3SendMock.mockReset();
    s3ClientCtorMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    insertMock.mockImplementation(() => chainMock([]));
    updateMock.mockImplementation(() => chainMock([]));
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', configsRoutes);
  });

  it('redacts storage credentials from config list responses', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig({
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        accessKey: 'AKIA-PLAINTEXT',
        secretKey: 'secret-plaintext',
        credentials: {
          token: 'nested-token-plaintext',
        },
      },
    })]));

    const res = await app.request('/backup/configs', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].details.bucket).toBe('backups');
    expect(body.data[0].details.accessKey).toEqual({
      redacted: true,
      hasSecret: true,
      masked: '********',
    });
    expect(JSON.stringify(body)).not.toContain('AKIA-PLAINTEXT');
    expect(JSON.stringify(body)).not.toContain('secret-plaintext');
    expect(JSON.stringify(body)).not.toContain('nested-token-plaintext');
  });

  it('redacts storage credentials from single config responses', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig()]));

    const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.details.secretKey).toEqual({
      redacted: true,
      hasSecret: true,
      masked: '********',
    });
    expect(JSON.stringify(body)).not.toContain('"secret"');
    expect(JSON.stringify(body)).not.toContain('"key"');
  });

  it('returns explicit object lock support on successful S3 config tests', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig()]));
    updateMock.mockReturnValueOnce(chainMock([makeConfig({
      providerCapabilities: {
        objectLock: {
          supported: true,
          error: null,
        },
      },
      providerCapabilitiesCheckedAt: new Date('2026-03-31T01:00:00.000Z'),
    })]));
    s3SendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    checkBackupProviderCapabilitiesMock.mockResolvedValueOnce({
      objectLock: {
        supported: true,
        error: null,
      },
    });

    const res = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerCapabilities).toEqual({
      objectLock: {
        supported: true,
        checkedAt: expect.any(String),
        error: null,
      },
    });
    expect(body.config.providerCapabilities.objectLock.supported).toBe(true);
  });

  it('rejects encryption-required configs without enforceable storage encryption', async () => {
    const res = await app.request('/backup/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Local backups',
        provider: 'local',
        encryption: true,
        details: { path: '/tmp/backups' },
      }),
    });

    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates S3 configs with explicit SSE-KMS encryption enabled', async () => {
    insertMock.mockReturnValueOnce(chainMock([makeConfig({
      encryption: true,
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        accessKey: 'key',
        secretKey: 'secret',
        serverSideEncryption: 'aws:kms',
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abcd',
      },
    })]));

    const res = await app.request('/backup/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'S3 encrypted backups',
        provider: 's3',
        encryption: true,
        details: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          serverSideEncryption: 'aws:kms',
          kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abcd',
        },
      }),
    });

    expect(res.status).toBe(201);
    const insertValues = insertMock.mock.results[0]?.value?.values;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      encryption: true,
    }));
    const body = await res.json();
    expect(body.encryption).toMatchObject({
      enabled: true,
      status: 'enforced',
      mode: 's3-sse-kms',
    });
  });

  it('returns explicit unsupported object lock state for local configs', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig({
      provider: 'local',
      providerConfig: { path: '/tmp/backups' },
    })]));
    updateMock.mockReturnValueOnce(chainMock([makeConfig({
      provider: 'local',
      providerConfig: { path: '/tmp/backups' },
      providerCapabilities: {
        objectLock: {
          supported: false,
          error: 'Object lock is only supported for S3 providers',
        },
      },
      providerCapabilitiesCheckedAt: new Date('2026-03-31T01:00:00.000Z'),
    })]));
    checkBackupProviderCapabilitiesMock.mockResolvedValueOnce({
      objectLock: {
        supported: false,
        error: 'Object lock is only supported for S3 providers',
      },
    });

    const res = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerCapabilities.objectLock).toMatchObject({
      supported: false,
      error: 'Object lock is only supported for S3 providers',
    });
  });

  it('returns an explicit unsupported capability result when object lock cannot be verified', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig()]));
    updateMock.mockReturnValueOnce(chainMock([makeConfig({
      providerCapabilities: {
        objectLock: {
          supported: false,
          error: 'Access denied checking object lock configuration',
        },
      },
      providerCapabilitiesCheckedAt: new Date('2026-03-31T01:00:00.000Z'),
    })]));
    s3SendMock.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    checkBackupProviderCapabilitiesMock.mockResolvedValueOnce({
      objectLock: {
        supported: false,
        error: 'Access denied checking object lock configuration',
      },
    });

    const res = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerCapabilities.objectLock).toMatchObject({
      supported: false,
      error: 'Access denied checking object lock configuration',
    });
  });

  it('clears provider capabilities when config details change', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig()]));
    updateMock.mockReturnValueOnce(chainMock([makeConfig({
      providerConfig: {
        bucket: 'archive',
        accessKey: 'key',
        secretKey: 'secret',
      },
      providerCapabilities: null,
      providerCapabilitiesCheckedAt: null,
      updatedAt: new Date('2026-03-31T02:00:00.000Z'),
    })]));

    const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        details: { bucket: 'archive', region: 'us-east-1' },
      }),
    });

    expect(res.status).toBe(200);
    const updateSet = updateMock.mock.results[0]?.value?.set;
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: { bucket: 'archive', region: 'us-east-1', accessKey: 'key', secretKey: 'secret' },
      providerCapabilities: null,
      providerCapabilitiesCheckedAt: null,
    }));
  });

  it('preserves existing secrets when clients send masked secret placeholders', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig({
      providerConfig: {
        bucket: 'backups',
        region: 'us-east-1',
        accessKey: 'existing-access-key',
        secretKey: 'existing-secret-key',
        credentials: {
          token: 'existing-nested-token',
        },
      },
    })]));
    updateMock.mockReturnValueOnce(chainMock([makeConfig({
      providerConfig: {
        bucket: 'archive',
        region: 'us-east-1',
        accessKey: 'existing-access-key',
        secretKey: 'existing-secret-key',
        credentials: {
          token: 'existing-nested-token',
        },
      },
      updatedAt: new Date('2026-03-31T02:00:00.000Z'),
    })]));

    const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        details: {
          bucket: 'archive',
          region: 'us-east-1',
          secretKey: { redacted: true, hasSecret: true, masked: '********' },
          credentials: {
            token: '********',
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const updateSet = updateMock.mock.results[0]?.value?.set;
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: {
        bucket: 'archive',
        region: 'us-east-1',
        secretKey: 'existing-secret-key',
        credentials: {
          token: 'existing-nested-token',
        },
        accessKey: 'existing-access-key',
      },
    }));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('existing-secret-key');
    expect(JSON.stringify(body)).not.toContain('existing-nested-token');
  });

  it('rejects S3 config creation without a region or region-bearing endpoint', async () => {
    const res = await app.request('/backup/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'MinIO backups',
        provider: 's3',
        details: {
          bucket: 'backups',
          region: '',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 'minio.internal.example.com',
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('derives and persists the region from an S3-compatible endpoint on create', async () => {
    insertMock.mockReturnValueOnce(chainMock([makeConfig({
      providerConfig: {
        bucket: 'backups',
        region: 'us-west-004',
        accessKey: 'key',
        secretKey: 'secret',
        endpoint: 's3.us-west-004.backblazeb2.com',
      },
    })]));

    const res = await app.request('/backup/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'B2 backups',
        provider: 's3',
        details: {
          bucket: 'backups',
          region: '',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 's3.us-west-004.backblazeb2.com',
        },
      }),
    });

    expect(res.status).toBe(201);
    const insertValues = insertMock.mock.results[0]?.value?.values;
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ region: 'us-west-004' }),
    }));
  });

  it('rejects S3 config updates that drop the region without a derivable endpoint', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig()]));

    const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        details: { bucket: 'archive', region: '', accessKey: 'key', secretKey: 'secret' },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('region');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('derives the probe region from the endpoint when a stored region is empty', async () => {
    selectMock.mockReturnValueOnce(chainMock([makeConfig({
      providerConfig: {
        bucket: 'backups',
        region: '',
        accessKey: 'key',
        secretKey: 'secret',
        endpoint: 's3.us-west-004.backblazeb2.com',
      },
    })]));
    updateMock.mockReturnValueOnce(chainMock([makeConfig()]));
    s3SendMock.mockResolvedValue({});
    checkBackupProviderCapabilitiesMock.mockResolvedValue({
      objectLock: { supported: true, error: null },
    });

    const res = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(s3ClientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-004' }),
    );
  });

  // Sentry BREEZE-P: a scheme-less or otherwise unparseable endpoint used to
  // reach the AWS SDK unmodified and throw a bare `TypeError: Invalid URL`
  // deep inside @smithy/core's endpoint resolver. These tests cover the two
  // places that guard against it: rejecting a bad endpoint at save time
  // (validateS3Details), and normalizing/erroring gracefully at probe time
  // for configs saved before that validation existed.
  describe('S3 endpoint validation (Sentry BREEZE-P)', () => {
    it('rejects S3 config creation with a genuinely malformed endpoint, with a clear message', async () => {
      const res = await app.request('/backup/configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Broken endpoint',
          provider: 's3',
          details: {
            bucket: 'backups',
            region: 'us-east-1',
            accessKey: 'key',
            secretKey: 'secret',
            endpoint: 'not a valid url with spaces',
          },
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body)).toContain('not a valid URL');
      // Deliberately case-insensitive: the raw SDK failure is the string
      // "Invalid URL", and our message is "...is not a valid URL...". A
      // case-SENSITIVE `not.toContain('Invalid URL')` can never fire against
      // our own message, so it would assert nothing.
      expect(JSON.stringify(body)).not.toMatch(/TypeError|\bInvalid URL\b/i);
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('accepts a scheme-less endpoint on create (still just a host:port)', async () => {
      insertMock.mockReturnValueOnce(chainMock([makeConfig({
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 'minio.internal.example.com:9000',
        },
      })]));

      const res = await app.request('/backup/configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'MinIO backups',
          provider: 's3',
          details: {
            bucket: 'backups',
            region: 'us-east-1',
            accessKey: 'key',
            secretKey: 'secret',
            endpoint: 'minio.internal.example.com:9000',
          },
        }),
      });

      expect(res.status).toBe(201);
      expect(insertMock).toHaveBeenCalled();

      // The NORMALIZED endpoint must be what lands in the database, not the
      // raw scheme-less string. providerConfig.endpoint is shipped verbatim to
      // the Go agent (jobs/backupWorker.ts -> agent/internal/backup/providers/
      // s3.go), which does no coercion of its own — so persisting the raw value
      // would let this config pass its own connectivity test while every real
      // backup run kept failing on the device.
      const insertValues = insertMock.mock.results[0]?.value?.values;
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
        providerConfig: expect.objectContaining({
          endpoint: 'https://minio.internal.example.com:9000/',
        }),
      }));
    });

    it('persists the normalized endpoint on update (PATCH), not the raw value', async () => {
      selectMock.mockReturnValueOnce(chainMock([makeConfig()]));
      updateMock.mockReturnValueOnce(chainMock([makeConfig({
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 'https://minio.internal.example.com:9000/',
        },
      })]));

      const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          details: {
            bucket: 'backups',
            region: 'us-east-1',
            accessKey: 'key',
            secretKey: 'secret',
            endpoint: 'minio.internal.example.com:9000',
          },
        }),
      });

      expect(res.status).toBe(200);
      const updateValues = updateMock.mock.results[0]?.value?.set;
      expect(updateValues).toHaveBeenCalledWith(expect.objectContaining({
        providerConfig: expect.objectContaining({
          endpoint: 'https://minio.internal.example.com:9000/',
        }),
      }));
    });

    it('rejects a malformed endpoint on update (PATCH) — configUpdateSchema has no superRefine', async () => {
      // The ONLY guard on this path is the hand-rolled validateS3Details call
      // in the PATCH handler: configUpdateSchema cannot carry a superRefine
      // because `provider` is not part of an update payload. If that call is
      // ever removed, this test is what catches it.
      selectMock.mockReturnValueOnce(chainMock([makeConfig()]));

      const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          details: {
            bucket: 'backups',
            region: 'us-east-1',
            accessKey: 'key',
            secretKey: 'secret',
            endpoint: 'not a valid url with spaces',
          },
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body)).toContain('not a valid URL');
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('rejects a non-http(s) scheme on create (e.g. a pasted s3:// bucket URI)', async () => {
      const res = await app.request('/backup/configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Pasted s3 URI',
          provider: 's3',
          details: {
            bucket: 'backups',
            region: 'us-east-1',
            accessKey: 'key',
            secretKey: 'secret',
            endpoint: 's3://my-bucket',
          },
        }),
      });

      expect(res.status).toBe(400);
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('normalizes a stored scheme-less endpoint to https:// before probing', async () => {
      selectMock.mockReturnValueOnce(chainMock([makeConfig({
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 'minio.internal.example.com:9000',
        },
      })]));
      updateMock.mockReturnValueOnce(chainMock([makeConfig()]));
      s3SendMock.mockResolvedValue({});
      checkBackupProviderCapabilitiesMock.mockResolvedValue({
        objectLock: { supported: true, error: null },
      });

      const res = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('success');
      expect(s3ClientCtorMock).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'https://minio.internal.example.com:9000/' }),
      );
    });

    it('surfaces a clear error (not "Invalid URL") when testing a config with a pre-existing malformed endpoint', async () => {
      // Simulates a row saved before endpoint validation existed at the
      // config-save boundary.
      selectMock.mockReturnValueOnce(chainMock([makeConfig({
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 'not a valid url with spaces',
        },
      })]));
      updateMock.mockReturnValueOnce(chainMock([makeConfig()]));
      checkBackupProviderCapabilitiesMock.mockResolvedValue({
        objectLock: { supported: false, error: null },
      });

      const res = await app.request(`/backup/configs/${CONFIG_ID}/test`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.status).toBe('failed');
      expect(body.error).toContain('not a valid URL');
      expect(body.error).not.toBe('Invalid URL');
      expect(s3ClientCtorMock).not.toHaveBeenCalled();
    });
  });

  // The org DEFAULT destination is what every partner-wide and profile-linked
  // backup resolves to at job time. Demoting the current default and THEN
  // bailing out on a validation/existence error would silently leave the org
  // with no default at all — and their scheduled backups would start skipping
  // with no obvious cause. Validate first; demote+promote atomically.
  describe('default destination', () => {
    it('does not demote the current default when the target config does not exist', async () => {
      selectMock.mockReturnValue(chainMock([])); // no such config in this org

      const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });

      expect(res.status).toBe(404);
      // Nothing was written — the previous default is untouched.
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('does not demote the current default when the update fails validation', async () => {
      // Existing local-provider config; enabling encryption on it is rejected.
      selectMock.mockReturnValue(
        chainMock([makeConfig({ provider: 'local', providerConfig: { path: '/backups' } })]),
      );

      const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true, encryption: true }),
      });

      expect(res.status).toBe(400);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('demotes the previous default when promoting a config', async () => {
      selectMock.mockReturnValue(chainMock([makeConfig()]));
      updateMock.mockReturnValue(chainMock([makeConfig({ isDefault: true })]));

      const res = await app.request(`/backup/configs/${CONFIG_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      });

      expect(res.status).toBe(200);
      // One UPDATE demotes the old default, one promotes this config.
      expect(updateMock).toHaveBeenCalledTimes(2);
      const sets = updateMock.mock.results.flatMap((r: any) =>
        r.value.set.mock.calls.map((c: any[]) => c[0]),
      );
      expect(sets).toContainEqual(expect.objectContaining({ isDefault: false }));
      expect(sets).toContainEqual(expect.objectContaining({ isDefault: true }));
    });
  });
});
