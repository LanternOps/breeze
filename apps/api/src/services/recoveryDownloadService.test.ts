import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ size: 2 })),
}));

vi.mock('node:fs', async () => {
  // The `.gz` branch pipes the raw read stream into a real zlib gunzip via
  // `node:stream`'s `pipeline`, which needs a genuine stream interface
  // (`.once`, `.pipe`, readable-state introspection, etc.) — a hand-rolled
  // `{ on, destroy }` stub isn't enough. The default bytes must also be a
  // VALID (if empty) gzip stream: many tests exercising other branches
  // (capability/authorization refusals, etc.) happen to use `.gz`-suffixed
  // remote paths and never override this mock, so a real gunzip is always
  // attached and will actually try to decode whatever this returns — raw
  // empty bytes fail zlib parsing asynchronously with an unhandled stream
  // error those tests never listen for.
  const { Readable } = await import('node:stream');
  const { gzipSync } = await import('node:zlib');
  return {
    createReadStream: vi.fn(() => Readable.from(gzipSync(Buffer.alloc(0)))),
  };
});

const resolveSnapshotProviderConfigMock = vi.fn();
// FIFO queue of rows returned by successive `db.select().from().where().limit()`
// calls, in call order. `getAuthenticatedRecoveryDownloadTarget` always issues
// the lineage select first; for an external-reference download,
// `authorizeExternalReference` (W09 Task 6) then issues, in order: the token
// snapshot's file_index_status, the backup_snapshot_files membership row, and
// the backup_snapshot_origins row.
const lineageRows = vi.hoisted(() => [] as Array<Array<Record<string, unknown>>>);
const innerJoins = vi.hoisted(() => [] as unknown[][]);
const wheres = vi.hoisted(() => [] as unknown[]);

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, any> = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn((cond: unknown) => {
        wheres.push(cond);
        return chain;
      });
      chain.leftJoin = vi.fn(() => chain);
      chain.innerJoin = vi.fn((...args: unknown[]) => {
        innerJoins.push(args);
        return chain;
      });
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
import { createReadStream as createReadStreamMock } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { getAuthenticatedRecoveryDownloadTarget } from './recoveryDownloadService';

// The identity normalizeStorageIdentity() derives for providerConfig
// { path: '/var/backups' } — i.e. the pinned identity a snapshot written to
// that local root carries.
const LOCAL_IDENTITY = 'local::/var/backups';

describe('getAuthenticatedRecoveryDownloadTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lineageRows.length = 0;
    lineageRows.push([{ orgId: 'org-1', deviceId: 'device-1', keyLayout: 'legacy_flat' }]);
  });

  it.each([['device_scoped'], [undefined]])(
    'refuses a snapshot whose key layout (%s) this server cannot read, before loading provider credentials',
    async (keyLayout) => {
      lineageRows[0] = [{ orgId: 'org-1', deviceId: 'device-1', keyLayout }];

      const result = await getAuthenticatedRecoveryDownloadTarget(
        {
          id: 'token-layout',
          orgId: 'org-1',
          deviceId: 'device-1',
          snapshotId: 'snapshot-db-layout',
          status: 'authenticated',
          authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
          expiresAt: new Date('2099-04-02T00:00:00.000Z'),
          negotiatedCapabilities: null,
        },
        'snapshots/snap-ext-001/manifest.json'
      );

      expect(result).toEqual({
        unavailable: true,
        reason: 'This backup was written in a storage format this server version cannot read.',
      });
      expect(resolveSnapshotProviderConfigMock).not.toHaveBeenCalled();
    },
  );

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

  // #6398: the agent's S3 provider has never applied the destination's
  // `prefix` — every snapshot object lands at `snapshots/<id>/...` verbatim.
  // Presigning `<prefix>/snapshots/...` 404'd every token-mode recovery on a
  // prefixed destination. The configured prefix must NOT be applied to
  // snapshot keys; only a per-snapshot recorded `storagePrefix` may relocate
  // them.
  describe('destination prefix (#6398)', () => {
    const tokenRow = {
      id: 'token-prefix',
      orgId: 'org-1',
      deviceId: 'device-1',
      snapshotId: 'snapshot-db-prefix',
      status: 'authenticated',
      authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
      expiresAt: new Date('2099-04-02T00:00:00.000Z'),
    };
    const prefixedConfig = {
      bucket: 'backups',
      region: 'us-east-1',
      accessKey: 'key',
      secretKey: 'secret',
      prefix: 'w05',
    };
    const presignedKey = () => {
      expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
      const [, command] = (getSignedUrlMock.mock.calls[0] as unknown) as [unknown, { input: { Key: string } }];
      return command.input.Key;
    };

    it('does not apply the configured destination prefix to a snapshot recorded without a storagePrefix', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'snap-ext-001', metadata: {} },
        providerType: 's3',
        providerConfig: prefixedConfig,
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/snap-ext-001/layout.json');

      expect(result.unavailable).toBe(false);
      expect(presignedKey()).toBe('snapshots/snap-ext-001/layout.json');
    });

    it('does not apply the configured prefix to a snapshot whose recorded storagePrefix is the bare agent layout', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'snap-ext-001', metadata: { storagePrefix: 'snapshots/snap-ext-001' } },
        providerType: 's3',
        providerConfig: prefixedConfig,
      });

      await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/snap-ext-001/manifest.json');

      expect(presignedKey()).toBe('snapshots/snap-ext-001/manifest.json');
    });

    it('still honors a per-snapshot recorded storagePrefix that carries a base prefix', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'snap-ext-001', metadata: { storagePrefix: 's3://backups/legacy/snapshots/snap-ext-001' } },
        providerType: 's3',
        providerConfig: prefixedConfig,
      });

      await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/snap-ext-001/manifest.json');

      expect(presignedKey()).toBe('legacy/snapshots/snap-ext-001/manifest.json');
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

    function mockCurrentSnapshotLocal(storageIdentity = LOCAL_IDENTITY) {
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
      mockCurrentSnapshotLocal(LOCAL_IDENTITY);
      lineageRows.push([{ fileIndexStatus: 'complete' }]); // token snapshot file index
      lineageRows.push([{ id: 'file-row-1' }]); // membership
      lineageRows.push([
        {
          originOrgId: 'org-1',
          originDeviceId: 'device-1',
          originStorageIdentity: LOCAL_IDENTITY,
          originStoragePrefix: 'archive-2025',
        },
      ]); // origin

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/a.gz');

      expect(result.unavailable).toBe(false);
      const [filePathArg] = (statMock as any).mock.calls[0];
      expect(filePathArg).toContain('archive-2025/snapshots/older/files/a.gz');
      expect(filePathArg).not.toContain('/current/');
    });

    it("R6 + #6489: an authorized external .gz reference is gunzipped from the ORIGIN-prefixed physical path, not left compressed", async () => {
      // Regression guard for a plausible break the R6 test above can't catch
      // on its own: R6 only asserts which path `stat()` was called with, but
      // never reads the returned stream — so a bug that opened the correct
      // origin-prefixed file yet fed the WRONG bytes into gunzip (or skipped
      // gunzip entirely for external references) would pass R6 and still
      // ship broken.
      mockCurrentSnapshotLocal(LOCAL_IDENTITY);
      lineageRows.push([{ fileIndexStatus: 'complete' }]); // token snapshot file index
      lineageRows.push([{ id: 'file-row-1' }]); // membership
      lineageRows.push([
        {
          originOrgId: 'org-1',
          originDeviceId: 'device-1',
          originStorageIdentity: LOCAL_IDENTITY,
          originStoragePrefix: 'archive-2025',
        },
      ]); // origin

      const original = Buffer.from('origin-prefixed external reference payload for #6489');
      (createReadStreamMock as any).mockImplementationOnce((requestedPath: string) => {
        expect(requestedPath).toContain('archive-2025/snapshots/older/files/a.gz');
        return Readable.from(gzipSync(original));
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/a.gz');

      expect(result.unavailable).toBe(false);
      if (result.unavailable) throw new Error('unreachable');
      expect(result.contentLength).toBeNull();

      const chunks: Buffer[] = [];
      for await (const chunk of result.stream as unknown as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks).equals(original)).toBe(true);
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

    it('an external key is refused when the index was not built from the manifest bytes the attestation names', async () => {
      mockCurrentSnapshotLocal();
      lineageRows.push([{ fileIndexStatus: 'complete', fileIndexManifestSha256: 'a'.repeat(64), attestation: { status: 'verified', manifestSha256: 'b'.repeat(64) } }]);
      lineageRows.push([{ id: 'file-row-1' }]);
      lineageRows.push([{ originOrgId: 'org-1', originDeviceId: 'device-1', originStorageIdentity: 'store-1', originStoragePrefix: null }]);

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/a.gz');

      expect(result).toMatchObject({ unavailable: true });
    });

    it('an external key is refused when the attestation did not match', async () => {
      mockCurrentSnapshotLocal();
      lineageRows.push([{ fileIndexStatus: 'complete', fileIndexManifestSha256: 'a'.repeat(64), attestation: { status: 'mismatch', manifestSha256: 'a'.repeat(64) } }]);
      lineageRows.push([{ id: 'file-row-1' }]);
      lineageRows.push([{ originOrgId: 'org-1', originDeviceId: 'device-1', originStorageIdentity: 'store-1', originStoragePrefix: null }]);

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/a.gz');

      expect(result).toMatchObject({ unavailable: true });
    });

    it('an external key bound to a matching attestation is authorized, and membership is read against the approved index', async () => {
      mockCurrentSnapshotLocal('store-1');
      innerJoins.length = 0;
      lineageRows.push([{ fileIndexStatus: 'complete', fileIndexManifestSha256: 'a'.repeat(64), attestation: { status: 'pending', manifestSha256: 'a'.repeat(64) } }]);
      lineageRows.push([{ id: 'file-row-1' }]);
      lineageRows.push([{ originOrgId: 'org-1', originDeviceId: 'device-1', originStorageIdentity: 'store-1', originStoragePrefix: null }]);

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/a.gz');

      expect(result.unavailable).toBe(false);
      expect(innerJoins).toHaveLength(1);
    });

    it('reads membership only against the index state it approved, in the same statement', async () => {
      mockCurrentSnapshotLocal('store-1');
      wheres.length = 0;
      const digest = 'c'.repeat(64);
      lineageRows.push([{ fileIndexStatus: 'complete', fileIndexManifestSha256: digest, attestation: { status: 'verified', manifestSha256: digest } }]);
      lineageRows.push([{ id: 'file-row-1' }]);
      lineageRows.push([{ originOrgId: 'org-1', originDeviceId: 'device-1', originStorageIdentity: 'store-1', originStoragePrefix: null }]);

      await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/a.gz');

      // wheres: lineage, token snapshot, membership, origin.
      const { PgDialect } = await import('drizzle-orm/pg-core');
      const query = new PgDialect().sqlToQuery(wheres[2] as any);
      const text = query.sql.toLowerCase().replace(/\s+/g, ' ');
      expect(text).toContain('"backup_snapshot_files"."backup_path" = $');
      expect(text).toContain('"backup_snapshots"."file_index_status" = $');
      expect(text).toContain('"backup_snapshots"."file_index_manifest_sha256" is not distinct from $');
      expect(text).toContain("<> 'attestation_failed'");
      expect(text).toContain('"backup_snapshot_attestations"."manifest_sha256" = "backup_snapshots"."file_index_manifest_sha256"');
      expect(query.params).toEqual(expect.arrayContaining(['snapshot-db-current', 'snapshots/older/files/a.gz', 'complete', digest]));
    });

    it("an external key is refused when the snapshot's file_index_status is not complete (e.g. agent)", async () => {
      mockCurrentSnapshotLocal();
      lineageRows.push([{ fileIndexStatus: 'agent' }]);

      const result = await getAuthenticatedRecoveryDownloadTarget(baseTokenRow as any, 'snapshots/older/files/a.gz');

      expect(result).toMatchObject({ unavailable: true });
    });
  });

  describe('pinned storage identity (#6490)', () => {
    const DRIFT_REASON =
      'The backup destination for this device has changed since this snapshot was written. Restore the previous destination settings or choose a snapshot written to the current destination.';
    const tokenRow = {
      id: 'token-drift',
      orgId: 'org-1',
      deviceId: 'device-1',
      snapshotId: 'snapshot-db-drift',
      status: 'authenticated' as const,
      authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
      expiresAt: new Date('2099-04-02T00:00:00.000Z'),
      negotiatedCapabilities: null,
    };

    it('refuses an own-prefix LOCAL download when the live root no longer matches the pinned identity, before touching the filesystem', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'current', metadata: {}, storageIdentity: 'local::/srv/old-backups' },
        providerType: 'local',
        providerConfig: { path: '/var/backups' },
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/current/manifest.json');

      expect(result).toEqual({ unavailable: true, reason: DRIFT_REASON });
      expect(statMock).not.toHaveBeenCalled();
      expect(createReadStreamMock).not.toHaveBeenCalled();
    });

    it('refuses an own-prefix S3 download when the live bucket no longer matches the pinned identity, without presigning', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'current', metadata: {}, storageIdentity: 's3::minio.example.com::old-bucket' },
        providerType: 's3',
        providerConfig: { bucket: 'new-bucket', region: 'us-east-1', endpoint: 'https://minio.example.com' },
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/current/files/a.gz');

      expect(result).toEqual({ unavailable: true, reason: DRIFT_REASON });
      expect(getSignedUrlMock).not.toHaveBeenCalled();
      expect(s3ClientCtorMock).not.toHaveBeenCalled();
    });

    it('refuses when the provider TYPE changed (pinned s3, live local)', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'current', metadata: {}, storageIdentity: 's3::minio.example.com::old-bucket' },
        providerType: 'local',
        providerConfig: { path: '/var/backups' },
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/current/manifest.json');

      expect(result).toEqual({ unavailable: true, reason: DRIFT_REASON });
      expect(statMock).not.toHaveBeenCalled();
    });

    it('allows an own-prefix S3 download whose live config normalizes to the pinned identity (credential/prefix edits are not drift)', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'current', metadata: {}, storageIdentity: 's3::minio.example.com::same-bucket' },
        providerType: 's3',
        providerConfig: {
          bucket: 'same-bucket',
          region: 'us-east-1',
          endpoint: 'https://MINIO.example.com/',
          prefix: 'rotated-prefix',
          accessKeyId: 'rotated-key',
          secretAccessKey: 'rotated-secret',
        },
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/current/files/a.gz');

      expect(result).toMatchObject({ unavailable: false, type: 'redirect' });
      expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
    });

    it('allows an own-prefix LOCAL download whose live root matches the pinned identity', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'current', metadata: {}, storageIdentity: LOCAL_IDENTITY },
        providerType: 'local',
        providerConfig: { path: '/var/backups' },
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/current/manifest.json');

      expect(result.unavailable).toBe(false);
    });

    it('still allows a legacy snapshot with NO pinned identity (nothing to compare against)', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'current', metadata: {}, storageIdentity: null },
        providerType: 'local',
        providerConfig: { path: '/var/backups' },
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/current/manifest.json');

      expect(result.unavailable).toBe(false);
    });

    it('treats an EMPTY-string pinned identity as drift (fail closed), not as a legacy snapshot', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'current', metadata: {}, storageIdentity: '' },
        providerType: 'local',
        providerConfig: { path: '/var/backups' },
      });

      const result = await getAuthenticatedRecoveryDownloadTarget(tokenRow as any, 'snapshots/current/manifest.json');

      expect(result).toEqual({ unavailable: true, reason: DRIFT_REASON });
      expect(statMock).not.toHaveBeenCalled();
    });

    it('refuses an otherwise-authorized EXTERNAL key when the live config drifted from the pinned identity', async () => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'current', metadata: {}, storageIdentity: 'local::/srv/old-backups' },
        providerType: 'local',
        providerConfig: { path: '/var/backups' },
      });
      // Origin verified against the PINNED identity — this is the case the
      // origin check alone cannot catch, since it never looks at the live config.
      lineageRows.push([{ fileIndexStatus: 'complete' }]);
      lineageRows.push([{ id: 'file-row-1' }]);
      lineageRows.push([{ originOrgId: 'org-1', originDeviceId: 'device-1', originStorageIdentity: 'local::/srv/old-backups', originStoragePrefix: null }]);

      const result = await getAuthenticatedRecoveryDownloadTarget(
        { ...tokenRow, negotiatedCapabilities: ['snapshot-file-membership-v1'] } as any,
        'snapshots/older/files/a.gz'
      );

      expect(result).toEqual({ unavailable: true, reason: DRIFT_REASON });
      expect(statMock).not.toHaveBeenCalled();
    });
  });

  describe('local provider .gz byte contract (#6489)', () => {
    // agent/internal/backup/providers/local.go gzip-compresses on Upload and
    // gunzips on Download, keyed purely off the `.gz` key suffix — S3 keys
    // hold raw bytes even when they end in `.gz` (Part 0 of the W09 plan:
    // "never add or strip .gz"). Token-mode recovery reads local-provider
    // storage directly, so the SERVER must mirror that gunzip for local
    // objects, or a bare-metal recovery counts compressed bytes as
    // "restored". Decision recorded on the issue: server gunzips.
    const gzTokenRow = {
      id: 'token-gz',
      orgId: 'org-1',
      deviceId: 'device-1',
      snapshotId: 'snapshot-db-gz',
      status: 'authenticated' as const,
      authenticatedAt: new Date('2099-04-01T00:00:00.000Z'),
      expiresAt: new Date('2099-04-02T00:00:00.000Z'),
    };

    beforeEach(() => {
      resolveSnapshotProviderConfigMock.mockResolvedValue({
        snapshot: { snapshotId: 'snap-ext-001', metadata: {} },
        providerType: 'local',
        providerConfig: { path: '/var/backups' },
      });
    });

    async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    it('round-trips a gzipped local object through the token-mode download path, matching the original bytes and the SHA-256 the manifest would record', async () => {
      const original = Buffer.from('bare-metal recovery payload — round trip fixture for #6489\n'.repeat(50));
      const expectedSha256 = createHash('sha256').update(original).digest('hex');
      (createReadStreamMock as any).mockImplementationOnce(() => Readable.from(gzipSync(original)));

      const result = await getAuthenticatedRecoveryDownloadTarget(
        gzTokenRow as any,
        'snapshots/snap-ext-001/files/payload.dat.gz'
      );

      expect(result.unavailable).toBe(false);
      if (result.unavailable) throw new Error('unreachable');
      expect(result.type).toBe('stream');
      // The decompressed length isn't knowable without decompressing, so a
      // fixed Content-Length must NOT be claimed for a local .gz object.
      expect(result.contentLength).toBeNull();

      const decompressed = await readAll(result.stream as unknown as NodeJS.ReadableStream);
      expect(decompressed.equals(original)).toBe(true);
      expect(createHash('sha256').update(decompressed).digest('hex')).toBe(expectedSha256);
    });

    it('streams a local object whose key does NOT end in .gz verbatim, unchanged', async () => {
      const raw = Buffer.from('already-uncompressed manifest bytes, unrelated to gzip');
      (createReadStreamMock as any).mockImplementationOnce(() => Readable.from(raw));
      (statMock as any).mockResolvedValueOnce({ size: raw.length });

      const result = await getAuthenticatedRecoveryDownloadTarget(
        gzTokenRow as any,
        'snapshots/snap-ext-001/files/payload.dat'
      );

      expect(result.unavailable).toBe(false);
      if (result.unavailable) throw new Error('unreachable');
      expect(result.contentLength).toBe(raw.length);

      const streamed = await readAll(result.stream as unknown as NodeJS.ReadableStream);
      expect(streamed.equals(raw)).toBe(true);
    });

    it('surfaces a corrupt gzip object as an explicit stream error, not truncated success', async () => {
      const corrupt = Buffer.from('this is not a valid gzip stream at all');
      (createReadStreamMock as any).mockImplementationOnce(() => Readable.from(corrupt));

      const result = await getAuthenticatedRecoveryDownloadTarget(
        gzTokenRow as any,
        'snapshots/snap-ext-001/files/broken.dat.gz'
      );

      expect(result.unavailable).toBe(false);
      if (result.unavailable) throw new Error('unreachable');
      await expect(readAll(result.stream as unknown as NodeJS.ReadableStream)).rejects.toThrow();
    });
  });
});
