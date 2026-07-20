import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ size: 2 })),
}));

vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => ({ on: vi.fn(), destroy: vi.fn() })),
}));

const resolveSnapshotProviderConfigMock = vi.fn();

vi.mock('./recoveryBootstrap', () => ({
  asRecord: (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  computeRecoveryDownloadExpiry: (authenticatedAt: Date | null, expiresAt: Date) =>
    authenticatedAt ? new Date(Math.min(authenticatedAt.getTime() + 60 * 60 * 1000, expiresAt.getTime())) : null,
  getStringValue: (record: Record<string, unknown> | null, key: string) =>
    record && typeof record[key] === 'string' ? String(record[key]) : null,
  resolveSnapshotProviderConfig: (...args: unknown[]) => resolveSnapshotProviderConfigMock(...args),
}));

const s3ClientCtorMock = vi.fn();
const getSignedUrlMock = vi.fn(async () => 'https://signed.example.com/object');

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class S3Client {
    constructor(config: unknown) {
      s3ClientCtorMock(config);
    }
  },
  GetObjectCommand: class GetObjectCommand {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrlMock(...(args as [])),
}));

import { getAuthenticatedRecoveryDownloadTarget } from './recoveryDownloadService';

describe('getAuthenticatedRecoveryDownloadTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows authenticated tokens to resolve in-scope local snapshot downloads', async () => {
    resolveSnapshotProviderConfigMock.mockResolvedValue({
      snapshot: {
        snapshotId: 'snap-ext-001',
        metadata: {},
      },
      providerType: 'local',
      providerConfig: {
        path: '/var/backups',
      },
    });

    const result = await getAuthenticatedRecoveryDownloadTarget(
      {
        id: 'token-1',
        snapshotId: 'snapshot-db-1',
        status: 'authenticated',
        authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
        expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      } as any,
      'snapshots/snap-ext-001/manifest.json'
    );

    expect(result.unavailable).toBe(false);
  });

  it('rejects used tokens even if they still have authenticatedAt set', async () => {
    const result = await getAuthenticatedRecoveryDownloadTarget(
      {
        id: 'token-2',
        snapshotId: 'snapshot-db-2',
        status: 'used',
        authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
        expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      } as any,
      'snapshots/snap-ext-001/manifest.json'
    );

    expect(result).toEqual({
      unavailable: true,
      reason: 'Token is used',
    });
  });

  it('rejects download paths outside the token snapshot scope', async () => {
    resolveSnapshotProviderConfigMock.mockResolvedValue({
      snapshot: {
        snapshotId: 'snap-ext-001',
        metadata: {},
      },
      providerType: 'local',
      providerConfig: {
        path: '/var/backups',
      },
    });

    const result = await getAuthenticatedRecoveryDownloadTarget(
      {
        id: 'token-3',
        snapshotId: 'snapshot-db-3',
        status: 'authenticated',
        authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
        expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      } as any,
      'snapshots/other-snapshot/manifest.json'
    );

    expect(result).toEqual({
      unavailable: true,
      reason: 'Requested path is outside the allowed snapshot scope.',
    });
  });

  // Sentry BREEZE-P: buildS3Client (private to this file) used to pass a
  // stored endpoint straight to the SDK. A scheme-less value throws an
  // opaque `TypeError: Invalid URL` deep inside @smithy/core instead of a
  // usable message. Exercised here through the public entry point since
  // buildS3Client isn't exported.
  describe('S3 endpoint handling (Sentry BREEZE-P)', () => {
    it('normalizes a scheme-less stored endpoint to https:// before constructing the S3Client', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'snap-ext-001', metadata: {} },
        providerType: 's3',
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          endpoint: 'minio.internal.example.com:9000',
          accessKey: 'key',
          secretKey: 'secret',
        },
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(
        {
          id: 'token-4',
          snapshotId: 'snapshot-db-4',
          status: 'authenticated',
          authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
          expiresAt: new Date('2099-04-02T00:00:00.000Z'),
        } as any,
        'snapshots/snap-ext-001/manifest.json'
      );

      expect(result.unavailable).toBe(false);
      expect(s3ClientCtorMock).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'https://minio.internal.example.com:9000/' }),
      );
    });

    it('throws a clear "not a valid URL" error (not "Invalid URL") for a stored malformed endpoint', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'snap-ext-001', metadata: {} },
        providerType: 's3',
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          endpoint: 'not a valid url with spaces',
          accessKey: 'key',
          secretKey: 'secret',
        },
      });

      await expect(
        getAuthenticatedRecoveryDownloadTarget(
          {
            id: 'token-5',
            snapshotId: 'snapshot-db-5',
            status: 'authenticated',
            authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
            expiresAt: new Date('2099-04-02T00:00:00.000Z'),
          } as any,
          'snapshots/snap-ext-001/manifest.json'
        )
      ).rejects.toThrow(/not a valid URL/);
    });
  });
});
