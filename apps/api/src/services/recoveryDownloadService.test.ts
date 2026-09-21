import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ size: 2 })),
}));

vi.mock('node:fs', () => ({
  createReadStream: vi.fn(() => ({ on: vi.fn(), destroy: vi.fn() })),
}));

const resolveSnapshotProviderConfigMock = vi.fn();
// FIFO queue of rows returned by successive `db.select().from().where().limit()`
// calls, in call order. `getAuthenticatedRecoveryDownloadTarget` always issues
// the lineage select first; for an external-reference download,
// `authorizeExternalReference` (W09 Task 6) then issues, in order: the token
// snapshot's file_index_status, the backup_snapshot_files membership row, and
// the backup_snapshot_origins row.
const lineageRows = vi.hoisted(() => [] as Array<Array<Record<string, unknown>>>);

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, any> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(async () => lineageRows.shift() ?? []);
      return chain;
    }),
  },
}));

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

import { stat as statMock } from 'node:fs/promises';
import { getAuthenticatedRecoveryDownloadTarget } from './recoveryDownloadService';

describe('getAuthenticatedRecoveryDownloadTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lineageRows.length = 0;
    lineageRows.push([{ orgId: 'org-1', deviceId: 'device-1' }]);
  });

  it('rejects a token whose pinned snapshot lineage changed before loading provider credentials', async () => {
    lineageRows[0] = [{ orgId: 'org-2', deviceId: 'device-2' }];

    const result = await getAuthenticatedRecoveryDownloadTarget(
      {
        id: 'token-moved',
        orgId: 'org-1',
        deviceId: 'device-1',
        snapshotId: 'snapshot-db-moved',
        status: 'authenticated',
        authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
        expiresAt: new Date('2099-04-02T00:00:00.000Z'),
        negotiatedCapabilities: null,
      },
      'snapshots/snap-ext-001/manifest.json'
    );

    expect(result).toEqual({
      unavailable: true,
      reason: 'Recovery snapshot lineage is unavailable.',
    });
    expect(resolveSnapshotProviderConfigMock).not.toHaveBeenCalled();
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
        orgId: 'org-1',
        deviceId: 'device-1',
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
        orgId: 'org-1',
        deviceId: 'device-1',
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
        orgId: 'org-1',
        deviceId: 'device-1',
        snapshotId: 'snapshot-db-3',
        status: 'authenticated',
        authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
        expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      } as any,
      'snapshots/other-snapshot/manifest.json'
    );

    // W09 (#6464) Task 6: a key under a DIFFERENT snapshot id is now a
    // structurally-valid "external reference" (classifyBackupObjectKey),
    // not an out-of-scope path — so a token that never negotiated
    // snapshot-file-membership-v1 (this tokenRow carries no
    // negotiatedCapabilities field at all) is refused with the
    // capability-denial reason rather than the old blanket "outside the
    // allowed snapshot scope" text. The case this test guards — a foreign
    // snapshot id is never silently served — still holds; only the reason
    // string changed. See R7/R12 cases below for the full authorization
    // matrix this reason now participates in.
    expect(result).toEqual({
      unavailable: true,
      reason: 'Requested path references an object this recovery is not authorized to read.',
    });
  });

  it('rejects a remotePath with a leading slash instead of silently normalizing it into scope', async () => {
    resolveSnapshotProviderConfigMock.mockResolvedValue({
      snapshot: { snapshotId: 'snap-ext-001', metadata: {} },
      providerType: 'local',
      providerConfig: { path: '/var/backups' },
    });

    // A leading slash must NOT be stripped before classification — the
    // shared object-key contract treats `/snapshots/a/x` as invalid (it
    // does not match the `snapshots/...` grammar), so a client sending one
    // is out of scope, not silently rewritten into a valid own-prefix key.
    const result = await getAuthenticatedRecoveryDownloadTarget(
      {
        id: 'token-4',
        orgId: 'org-1',
        deviceId: 'device-1',
        snapshotId: 'snapshot-db-4',
        status: 'authenticated',
        authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
        expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      } as any,
      '/snapshots/snap-ext-001/manifest.json'
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
          orgId: 'org-1',
          deviceId: 'device-1',
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
            orgId: 'org-1',
            deviceId: 'device-1',
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

  describe('external-reference downloads (W09, #6464)', () => {
    const baseTokenRow = {
      id: 'token-ext',
      orgId: 'org-1',
      deviceId: 'device-1',
      snapshotId: 'snapshot-db-current',
      status: 'authenticated' as const,
      authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
      expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      negotiatedCapabilities: ['snapshot-file-membership-v1'],
    };

    function mockCurrentSnapshotLocal(storageIdentity = 'store-1') {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: {
          snapshotId: 'current',
          metadata: {},
          storageIdentity,
        },
        providerType: 'local',
        providerConfig: { path: '/var/backups' },
      });
    }

    it("R6: an external key that IS a member of the snapshot index, with a verified origin, is authorized — physical key uses the ORIGIN prefix, not the token snapshot's", async () => {
      mockCurrentSnapshotLocal('store-1');
      lineageRows.push([{ fileIndexStatus: 'complete' }]); // token snapshot file index
      lineageRows.push([{ id: 'file-row-1' }]); // membership
      lineageRows.push([
        {
          originOrgId: 'org-1',
          originDeviceId: 'device-1',
          originStorageIdentity: 'store-1',
          originStoragePrefix: 'archive-2025',
        },
      ]); // origin

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/a.gz');

      expect(result.unavailable).toBe(false);
      const [filePathArg] = (statMock as any).mock.calls[0];
      expect(filePathArg).toContain('archive-2025/snapshots/older/files/a.gz');
      expect(filePathArg).not.toContain('/current/');
    });

    it('R7 (a): a sibling file of a referenced origin snapshot that is NOT itself in the index is refused', async () => {
      mockCurrentSnapshotLocal();
      lineageRows.push([{ fileIndexStatus: 'complete' }]);
      lineageRows.push([]); // no membership row

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/not-referenced.gz');

      expect(result).toMatchObject({
        unavailable: true,
        reason: 'Requested path references an object this recovery is not authorized to read.',
      });
    });

    it('logs the specific internal refusal reason server-side even though the public reason is generic', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockCurrentSnapshotLocal();
      lineageRows.push([{ fileIndexStatus: 'complete' }]);
      lineageRows.push([]); // no membership row -> internal reason distinct from the public one

      await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/not-referenced.gz');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('token-ext'),
        expect.objectContaining({
          tokenId: 'token-ext',
          snapshotDbId: 'snapshot-db-current',
          key: 'snapshots/older/files/not-referenced.gz',
          reason: 'key is not a member of the snapshot file index',
        }),
      );
      warnSpy.mockRestore();
    });

    it('R7 (b): a key under an ANCESTOR manifest object itself (not a content file) is refused unless it is also indexed', async () => {
      mockCurrentSnapshotLocal();
      lineageRows.push([{ fileIndexStatus: 'complete' }]);
      lineageRows.push([]); // manifest.json is not itself a member of the file index

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/manifest.json');

      expect(result).toMatchObject({ unavailable: true });
    });

    it('R7 (c): a key under a newer, UNREFERENCED snapshot is refused', async () => {
      mockCurrentSnapshotLocal();
      lineageRows.push([{ fileIndexStatus: 'complete' }]);
      lineageRows.push([]); // never referenced, never indexed

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/newer-unrelated/files/x.gz');

      expect(result).toMatchObject({ unavailable: true });
    });

    it('R12: an own-prefix key is unaffected by capability negotiation — allowed even with no negotiated capabilities', async () => {
      mockCurrentSnapshotLocal();

      const result = await getAuthenticatedRecoveryDownloadTarget(
        { ...baseTokenRow, negotiatedCapabilities: null } as any,
        'snapshots/current/manifest.json'
      );

      expect(result.unavailable).toBe(false);
    });

    it('an external key is refused when the token never negotiated the membership capability, even if the key IS indexed', async () => {
      mockCurrentSnapshotLocal();

      const result = await getAuthenticatedRecoveryDownloadTarget(
        { ...baseTokenRow, negotiatedCapabilities: null } as any,
        'snapshots/older/files/a.gz'
      );

      expect(result).toMatchObject({
        unavailable: true,
        reason: 'Requested path references an object this recovery is not authorized to read.',
      });
    });

    it("an external key is refused when the snapshot's file_index_status is not complete (e.g. agent)", async () => {
      mockCurrentSnapshotLocal();
      lineageRows.push([{ fileIndexStatus: 'agent' }]);

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/a.gz');

      expect(result).toMatchObject({ unavailable: true });
    });
  });
});
