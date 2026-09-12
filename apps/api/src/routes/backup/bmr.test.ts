import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { bmrRoutes, bmrPublicRoutes } from './bmr';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TOKEN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const VALID_RECOVERY_TOKEN = `brz_rec_${'a'.repeat(64)}`;
const EXPIRED_RECOVERY_TOKEN = `brz_rec_${'b'.repeat(64)}`;
const REVOKED_RECOVERY_TOKEN = `brz_rec_${'c'.repeat(64)}`;
const USED_RECOVERY_TOKEN = `brz_rec_${'d'.repeat(64)}`;
const LIMITED_RECOVERY_TOKEN = `brz_rec_${'e'.repeat(64)}`;

vi.mock('../../services', () => ({}));

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'onConflictDoNothing', 'orderBy', 'offset']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const authorizeResilienceResourcesMock = vi.fn();
const transactionMock = vi.fn(async (callback: (tx: any) => unknown) => callback({
  select: (...args: unknown[]) => selectMock(...(args as [])),
  insert: (...args: unknown[]) => insertMock(...(args as [])),
  update: (...args: unknown[]) => updateMock(...(args as [])),
}));
let authState = {
  principal: { kind: 'user_session' as const },
  user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};
let permissionsState: any;

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    transaction: (...args: unknown[]) => transactionMock(...(args as [any])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  // Passthrough mock, same shape as restore.test.ts: D9's org-scoping fix
  // wraps everything after the token lookup in withDbAccessContext(...),
  // and this mocked suite doesn't exercise real RLS — it just needs the
  // context param ignored and `fn` invoked so the route logic still runs.
  withDbAccessContext: vi.fn((_context: unknown, fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  bareMetalRecoveries: {
    id: 'bare_metal_recoveries.id',
    orgId: 'bare_metal_recoveries.org_id',
    deviceId: 'bare_metal_recoveries.device_id',
    snapshotId: 'bare_metal_recoveries.snapshot_id',
    recoveryTokenId: 'bare_metal_recoveries.recovery_token_id',
    identity: 'bare_metal_recoveries.identity',
    codeHash: 'bare_metal_recoveries.code_hash',
    codeExpiresAt: 'bare_metal_recoveries.code_expires_at',
    codeUsedAt: 'bare_metal_recoveries.code_used_at',
    nonceHash: 'bare_metal_recoveries.nonce_hash',
    status: 'bare_metal_recoveries.status',
    target: 'bare_metal_recoveries.target',
    plan: 'bare_metal_recoveries.plan',
    result: 'bare_metal_recoveries.result',
    failureReason: 'bare_metal_recoveries.failure_reason',
    warnings: 'bare_metal_recoveries.warnings',
    createdBy: 'bare_metal_recoveries.created_by',
    createdAt: 'bare_metal_recoveries.created_at',
    updatedAt: 'bare_metal_recoveries.updated_at',
    mediaBootedAt: 'bare_metal_recoveries.media_booted_at',
    plannedAt: 'bare_metal_recoveries.planned_at',
    restoringAt: 'bare_metal_recoveries.restoring_at',
    validatedAt: 'bare_metal_recoveries.validated_at',
    rebootedAt: 'bare_metal_recoveries.rebooted_at',
    checkedInAt: 'bare_metal_recoveries.checked_in_at',
    completedAt: 'bare_metal_recoveries.completed_at',
  },
  backupSnapshots: {
    id: 'backup_snapshots.id',
    jobId: 'backup_snapshots.job_id',
    configId: 'backup_snapshots.config_id',
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    size: 'backup_snapshots.size',
    fileCount: 'backup_snapshots.file_count',
    hardwareProfile: 'backup_snapshots.hardware_profile',
    systemStateManifest: 'backup_snapshots.system_state_manifest',
  },
  restoreJobs: {
    id: 'restore_jobs.id',
    status: 'restore_jobs.status',
    recoveryTokenId: 'restore_jobs.recovery_token_id',
  },
  backupJobs: {
    id: 'backup_jobs.id',
    configId: 'backup_jobs.config_id',
  },
  backupConfigs: {
    id: 'backup_configs.id',
    provider: 'backup_configs.provider',
    providerConfig: 'backup_configs.provider_config',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
    hostname: 'devices.hostname',
    osType: 'devices.os_type',
    architecture: 'devices.architecture',
    displayName: 'devices.display_name',
  },
  recoveryMediaArtifacts: {
    id: 'recovery_media_artifacts.id',
    orgId: 'recovery_media_artifacts.org_id',
    tokenId: 'recovery_media_artifacts.token_id',
    snapshotId: 'recovery_media_artifacts.snapshot_id',
    platform: 'recovery_media_artifacts.platform',
    architecture: 'recovery_media_artifacts.architecture',
    status: 'recovery_media_artifacts.status',
    storageKey: 'recovery_media_artifacts.storage_key',
    checksumSha256: 'recovery_media_artifacts.checksum_sha256',
    checksumStorageKey: 'recovery_media_artifacts.checksum_storage_key',
    signatureFormat: 'recovery_media_artifacts.signature_format',
    signatureStorageKey: 'recovery_media_artifacts.signature_storage_key',
    signingKeyId: 'recovery_media_artifacts.signing_key_id',
    metadata: 'recovery_media_artifacts.metadata',
    createdAt: 'recovery_media_artifacts.created_at',
    signedAt: 'recovery_media_artifacts.signed_at',
    completedAt: 'recovery_media_artifacts.completed_at',
  },
  recoveryBootMediaArtifacts: {
    id: 'recovery_boot_media_artifacts.id',
    orgId: 'recovery_boot_media_artifacts.org_id',
    tokenId: 'recovery_boot_media_artifacts.token_id',
    snapshotId: 'recovery_boot_media_artifacts.snapshot_id',
    bundleArtifactId: 'recovery_boot_media_artifacts.bundle_artifact_id',
    platform: 'recovery_boot_media_artifacts.platform',
    architecture: 'recovery_boot_media_artifacts.architecture',
    mediaType: 'recovery_boot_media_artifacts.media_type',
    status: 'recovery_boot_media_artifacts.status',
    storageKey: 'recovery_boot_media_artifacts.storage_key',
    checksumSha256: 'recovery_boot_media_artifacts.checksum_sha256',
    checksumStorageKey: 'recovery_boot_media_artifacts.checksum_storage_key',
    signatureFormat: 'recovery_boot_media_artifacts.signature_format',
    signatureStorageKey: 'recovery_boot_media_artifacts.signature_storage_key',
    signingKeyId: 'recovery_boot_media_artifacts.signing_key_id',
    metadata: 'recovery_boot_media_artifacts.metadata',
    createdAt: 'recovery_boot_media_artifacts.created_at',
    signedAt: 'recovery_boot_media_artifacts.signed_at',
    completedAt: 'recovery_boot_media_artifacts.completed_at',
  },
  recoveryTokens: {
    id: 'recovery_tokens.id',
    orgId: 'recovery_tokens.org_id',
    deviceId: 'recovery_tokens.device_id',
    snapshotId: 'recovery_tokens.snapshot_id',
    tokenHash: 'recovery_tokens.token_hash',
    restoreType: 'recovery_tokens.restore_type',
    targetConfig: 'recovery_tokens.target_config',
    status: 'recovery_tokens.status',
    createdAt: 'recovery_tokens.created_at',
    expiresAt: 'recovery_tokens.expires_at',
    authenticatedAt: 'recovery_tokens.authenticated_at',
    completedAt: 'recovery_tokens.completed_at',
    usedAt: 'recovery_tokens.used_at',
  },
}));

vi.mock('../../db/schema/recoveryTokens', () => ({
  recoveryTokens: {
    id: 'recovery_tokens.id',
    orgId: 'recovery_tokens.org_id',
    deviceId: 'recovery_tokens.device_id',
    snapshotId: 'recovery_tokens.snapshot_id',
    tokenHash: 'recovery_tokens.token_hash',
    restoreType: 'recovery_tokens.restore_type',
    targetConfig: 'recovery_tokens.target_config',
    status: 'recovery_tokens.status',
    createdAt: 'recovery_tokens.created_at',
    expiresAt: 'recovery_tokens.expires_at',
    authenticatedAt: 'recovery_tokens.authenticated_at',
    completedAt: 'recovery_tokens.completed_at',
    usedAt: 'recovery_tokens.used_at',
  },
}));

const writeRouteAuditMock = vi.fn();
const writeAuditEventMock = vi.fn();

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
  writeAuditEvent: (...args: unknown[]) => writeAuditEventMock(...(args as [])),
}));

const rateLimiterMock = vi.fn(async () => ({
  allowed: true,
  remaining: 9,
  resetAt: new Date(Date.now() + 60_000),
}));

vi.mock('../../services/redis', () => ({
  getRedis: vi.fn(() => ({
    multi: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  })),
}));

vi.mock('../../services/rate-limit', () => ({
  rateLimiter: (...args: unknown[]) => rateLimiterMock(...(args as [])),
}));

const getAuthenticatedRecoveryDownloadTargetMock = vi.fn();

vi.mock('../../services/recoveryDownloadService', () => ({
  getAuthenticatedRecoveryDownloadTarget: (...args: unknown[]) =>
    getAuthenticatedRecoveryDownloadTargetMock(...(args as [])),
}));

const enqueueRecoveryMediaBuildMock = vi.fn(async () => 'recovery-media:1');
const capturedAuthorizationSubject = {
  authorizationPrincipalKind: 'user_session' as const,
  authorizationPrincipalId: 'user-123',
  authorizationGrantRevision: `sha256:${'a'.repeat(64)}`,
  authorizationState: 'pending' as const,
  authorizationDenialCode: null,
  authorizationCheckedAt: null,
};
const captureRecoveryAuthorizationSubjectMock = vi.fn(async (): Promise<any> => capturedAuthorizationSubject);

vi.mock('../../services/recoveryAuthorizationSubject', () => ({
  captureRecoveryAuthorizationSubject: (...args: unknown[]) =>
    captureRecoveryAuthorizationSubjectMock(...(args as [])),
  RecoveryAuthorizationDeniedError: class extends Error {},
}));

vi.mock('../../jobs/recoveryMediaWorker', () => ({
  enqueueRecoveryMediaBuild: (...args: unknown[]) => enqueueRecoveryMediaBuildMock(...(args as [])),
}));

const lookupReleaseManifestAssetForDisplayMock = vi.fn(
  async (_assetName: string, _manifestUrl: string): Promise<{ sha256: string; size: number } | null> => null
);

vi.mock('../../services/releaseArtifactManifest', () => ({
  lookupReleaseManifestAssetForDisplay: (...args: unknown[]) =>
    lookupReleaseManifestAssetForDisplayMock(...(args as [string, string])),
}));

vi.mock('../../services/recoverySigning', () => ({
  getCurrentRecoverySigningKey: vi.fn(() => ({
    keyId: 'current',
    format: 'minisign',
    publicKey: 'RWQTESTMINISIGNPUBLICKEY',
    isCurrent: true,
  })),
  getRecoverySigningKeys: vi.fn(() => [
    {
      keyId: 'current',
      format: 'minisign',
      publicKey: 'RWQTESTMINISIGNPUBLICKEY',
      isCurrent: true,
    },
  ]),
  getRecoverySigningKey: vi.fn((keyId: string) =>
    keyId === 'current'
      ? {
          keyId: 'current',
          format: 'minisign',
          publicKey: 'RWQTESTMINISIGNPUBLICKEY',
          isCurrent: true,
        }
      : null
  ),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    if (permissionsState) {
      c.set('permissions', permissionsState);
    }
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../services/resilienceSiteAuthorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/resilienceSiteAuthorization')>();
  return {
    ...actual,
    authorizeResilienceResources: (...args: unknown[]) => authorizeResilienceResourcesMock(...args),
  };
});

import { authMiddleware } from '../../middleware/auth';
import { ResilienceAuthorizationError } from '../../services/resilienceSiteAuthorization';

describe('bmr routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    insertMock.mockReset();
    insertMock.mockImplementation(() => chainMock([]));
    updateMock.mockReset();
    updateMock.mockImplementation(() => chainMock([]));
    transactionMock.mockClear();
    transactionMock.mockImplementation(async (callback: (tx: any) => unknown) => callback({
      select: (...args: unknown[]) => selectMock(...(args as [])),
      insert: (...args: unknown[]) => insertMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    }));
    authState = {
      principal: { kind: 'user_session' },
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    authorizeResilienceResourcesMock.mockResolvedValue({ resources: [] });
    permissionsState = undefined;
    rateLimiterMock.mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
    });
    getAuthenticatedRecoveryDownloadTargetMock.mockReset();
    captureRecoveryAuthorizationSubjectMock.mockClear();
    captureRecoveryAuthorizationSubjectMock.mockResolvedValue(capturedAuthorizationSubject);
    lookupReleaseManifestAssetForDisplayMock.mockReset();
    lookupReleaseManifestAssetForDisplayMock.mockResolvedValue(null);
    delete process.env.BMR_RECOVERY_ALLOW_QUERY_TOKEN;
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      if (permissionsState) {
        c.set('permissions', permissionsState);
      }
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', bmrPublicRoutes);
    app.route('/backup', bmrRoutes);
  });

  it('denies source-site recovery token creation before token or metadata side effects', async () => {
    authorizeResilienceResourcesMock.mockRejectedValueOnce(
      new ResilienceAuthorizationError(403, 'site_access_denied')
    );

    const res = await app.request('/backup/bmr/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        expiresInHours: 24,
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(enqueueRecoveryMediaBuildMock).not.toHaveBeenCalled();
  });

  it('denies an explicit out-of-scope recovery token device filter for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock.mockReturnValueOnce(chainMock([
      { id: DEVICE_ID, siteId: SITE_A },
    ]));

    const res = await app.request(`/backup/bmr/tokens?deviceId=${OTHER_DEVICE_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'site_access_denied' });
  });

  it('narrows recovery token lists to allowed device sites for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock
      .mockReturnValueOnce(chainMock([
        { id: DEVICE_ID, siteId: SITE_A },
        { id: OTHER_DEVICE_ID, siteId: SITE_B },
      ]))
      .mockReturnValueOnce(chainMock([
        { id: SNAPSHOT_ID },
      ]))
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([
        makeTokenSummary({ deviceId: DEVICE_ID }),
      ]));

    const res = await app.request('/backup/bmr/tokens', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((row: any) => row.deviceId)).toEqual([DEVICE_ID]);
  });

  it('keeps unrestricted recovery token list behavior unchanged', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([
        makeTokenSummary({ deviceId: DEVICE_ID }),
        makeTokenSummary({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', deviceId: OTHER_DEVICE_ID }),
      ]));

    const res = await app.request('/backup/bmr/tokens', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(2);
  });

  it('creates a recovery token', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, orgId: ORG_ID, deviceId: DEVICE_ID }]));
    insertMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      restoreType: 'bare_metal',
      expiresAt: new Date('2026-03-30T00:00:00.000Z'),
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
    }]));

    const res = await app.request('/backup/bmr/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        expiresInHours: 24,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(TOKEN_ID);
    expect(body.token.startsWith('brz_rec_')).toBe(true);
  });

  it('returns enriched token metadata without the hash', async () => {
    updateMock.mockReturnValueOnce(chainMock([]));
    selectMock
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([{
        id: TOKEN_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        targetConfig: { diskLayout: 'auto' },
        status: 'active',
        createdAt: new Date('2026-03-29T00:00:00.000Z'),
        expiresAt: new Date('2026-03-30T00:00:00.000Z'),
        authenticatedAt: null,
        completedAt: null,
        usedAt: null,
      }]))
      .mockReturnValueOnce(chainMock([{
        id: SNAPSHOT_ID,
        orgId: ORG_ID,
        jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        deviceId: DEVICE_ID,
        configId: '99999999-9999-4999-8999-999999999999',
        snapshotId: 'snap-ext-001',
        label: 'Backup 2026-03-29',
        location: 's3://breeze-backups/org-001/dev-001/2026-03-29',
        timestamp: new Date('2026-03-29T12:34:56.000Z'),
        size: 1234,
        fileCount: 12,
        metadata: { providerType: 's3', storagePrefix: 's3://breeze-backups/org-001/dev-001/2026-03-29' },
        backupType: 'file',
        isIncremental: false,
        hardwareProfile: { cpuCores: 4 },
        systemStateManifest: { drivers: 3 },
      }]))
      .mockReturnValueOnce(chainMock([{
        id: '99999999-9999-4999-8999-999999999999',
        orgId: ORG_ID,
        name: 'Primary S3',
        provider: 's3',
        providerConfig: {
          bucket: 'breeze-backups',
          region: 'us-east-1',
          accessKey: 'abc',
          secretKey: 'def',
        },
        type: 'file',
        schedule: { frequency: 'daily', time: '02:00', timezone: 'UTC' },
        retention: { preset: 'standard' },
        isActive: true,
      }]))
      .mockReturnValueOnce(chainMock([{
        id: DEVICE_ID,
        hostname: 'srv-01',
        displayName: 'Server 01',
        osType: 'windows',
        architecture: 'amd64',
      }]))
      .mockReturnValueOnce(chainMock([]));

    const res = await app.request(`/backup/bmr/tokens/${TOKEN_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(TOKEN_ID);
    expect(body.tokenHash).toBeUndefined();
    expect(body.authenticatedAt).toBeNull();
    expect(body.device.hostname).toBe('srv-01');
    expect(body.bootstrap.version).toBe(1);
    expect(body.bootstrap.minHelperVersion).toBeTruthy();
    expect(body.bootstrap.commandTemplate).toContain('breeze-backup bmr-recover');
    expect(body.bootstrap.download).toMatchObject({
      type: 'breeze_proxy',
      pathPrefix: 'snapshots/snap-ext-001',
    });
    expect(body.linkedRestoreJob).toBeNull();
  });

  it('revokes a recovery token', async () => {
    updateMock.mockReturnValueOnce(chainMock([{ id: TOKEN_ID }]));

    const res = await app.request(`/backup/bmr/tokens/${TOKEN_ID}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: TOKEN_ID, status: 'revoked' });
  });

  it('authenticates a valid recovery token', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{
        id: TOKEN_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        targetConfig: { diskLayout: 'auto' },
        status: 'active',
        createdAt: new Date('2026-03-29T00:00:00.000Z'),
        expiresAt: new Date('2099-04-01T00:00:00.000Z'),
        authenticatedAt: null,
        completedAt: null,
      }]))
      .mockReturnValueOnce(chainMock([{
        id: SNAPSHOT_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        configId: null,
        snapshotId: 'snap-ext-001',
        label: 'Backup 2026-03-29',
        location: 's3://breeze-backups/org-001/dev-001/2026-03-29',
        timestamp: new Date('2026-03-29T12:34:56.000Z'),
        size: 1234,
        fileCount: 12,
        metadata: { providerType: 's3', storagePrefix: 's3://breeze-backups/org-001/dev-001/2026-03-29' },
        backupType: 'file',
        isIncremental: false,
        hardwareProfile: { cpuCores: 4 },
        systemStateManifest: { drivers: 3 },
      }]))
      .mockReturnValueOnce(chainMock([{
        configId: '99999999-9999-4999-8999-999999999999',
      }]))
      .mockReturnValueOnce(chainMock([{
        id: '99999999-9999-4999-8999-999999999999',
        orgId: ORG_ID,
        name: 'Primary S3',
        provider: 's3',
        providerConfig: {
          bucket: 'breeze-backups',
          region: 'us-east-1',
          accessKey: 'abc',
          secretKey: 'def',
        },
        type: 'file',
        schedule: { frequency: 'daily', time: '02:00', timezone: 'UTC' },
        retention: { preset: 'standard' },
        isActive: true,
      }]))
      .mockReturnValueOnce(chainMock([{
        id: DEVICE_ID,
        hostname: 'srv-01',
        osType: 'windows',
      }]));
    updateMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: VALID_RECOVERY_TOKEN }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokenId).toBe(TOKEN_ID);
    expect(body.device.hostname).toBe('srv-01');
    expect(body.snapshot.id).toBe(SNAPSHOT_ID);
    expect(body.snapshot.metadata.providerType).toBe('s3');
    expect(body.version).toBe(1);
    expect(body.minHelperVersion).toBeTruthy();
    expect(body.bootstrap.version).toBe(1);
    expect(body.bootstrap.providerType).toBe('s3');
    expect(body.bootstrap.backupConfig).toMatchObject({
      id: '99999999-9999-4999-8999-999999999999',
      provider: 's3',
      name: 'Primary S3',
    });
    expect(body.bootstrap.download).toMatchObject({
      type: 'breeze_proxy',
      method: 'GET',
      pathPrefix: 'snapshots/snap-ext-001',
    });
    expect(body.bootstrap.snapshot).toMatchObject({
      id: SNAPSHOT_ID,
      snapshotId: 'snap-ext-001',
      metadata: {
        providerType: 's3',
        storagePrefix: 's3://breeze-backups/org-001/dev-001/2026-03-29',
      },
    });
    expect(body.authenticatedAt).toBeTruthy();
  });

  it('rejects an expired recovery token', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      restoreType: 'bare_metal',
      targetConfig: null,
      status: 'active',
      createdAt: new Date('2026-03-28T00:00:00.000Z'),
      expiresAt: new Date('2026-03-28T01:00:00.000Z'),
      authenticatedAt: null,
      completedAt: null,
    }]));
    updateMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: EXPIRED_RECOVERY_TOKEN }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Token has expired');
  });

  it('rejects malformed recovery tokens before lookup', async () => {
    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-valid-token' }),
    });

    expect(res.status).toBe(401);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('should reject authentication with revoked token', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      restoreType: 'bare_metal',
      targetConfig: null,
      status: 'revoked',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      expiresAt: new Date('2099-04-01T00:00:00.000Z'),
      authenticatedAt: null,
      completedAt: null,
    }]));

    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: REVOKED_RECOVERY_TOKEN }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Token is revoked');
  });

  it('should reject authentication with already-completed token', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      restoreType: 'bare_metal',
      targetConfig: null,
      status: 'used',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      expiresAt: new Date('2099-04-01T00:00:00.000Z'),
      authenticatedAt: new Date('2026-03-29T12:00:00.000Z'),
      completedAt: new Date('2026-03-29T13:00:00.000Z'),
      usedAt: new Date('2026-03-29T12:00:00.000Z'),
    }]));

    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: USED_RECOVERY_TOKEN }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Token is used');
  });

  it('normalizes legacy used tokens without completion into authenticated state', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{
        id: TOKEN_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        targetConfig: null,
        status: 'used',
        createdAt: new Date('2026-03-29T00:00:00.000Z'),
        expiresAt: new Date('2099-04-01T00:00:00.000Z'),
        authenticatedAt: new Date('2026-03-29T12:00:00.000Z'),
        completedAt: null,
        usedAt: new Date('2026-03-29T12:00:00.000Z'),
      }]))
      .mockReturnValueOnce(chainMock([{
        id: SNAPSHOT_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        configId: null,
        snapshotId: 'snap-ext-001',
        label: 'Backup 2026-03-29',
        location: 's3://breeze-backups/org-001/dev-001/2026-03-29',
        timestamp: new Date('2026-03-29T12:34:56.000Z'),
        size: 1234,
        fileCount: 12,
        metadata: { providerType: 's3', storagePrefix: 's3://breeze-backups/org-001/dev-001/2026-03-29' },
        backupType: 'file',
        isIncremental: false,
        hardwareProfile: null,
        systemStateManifest: null,
      }]))
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([{
        id: DEVICE_ID,
        hostname: 'srv-01',
        osType: 'windows',
      }]));

    updateMock.mockReturnValueOnce(chainMock([]));

    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: USED_RECOVERY_TOKEN }),
    });

    expect(res.status).toBe(200);
    const updateSetArgs = updateMock.mock.results
      .map((entry) => entry.value?.set?.mock?.calls?.[0]?.[0])
      .filter(Boolean);
    expect(updateSetArgs).toContainEqual(expect.objectContaining({ status: 'authenticated' }));
  });

  it('re-authenticating an already-authenticated token slides the download session window', async () => {
    // KIT W04b proof (2026-09-12): a 105k-file rebuild ran past
    // RECOVERY_DOWNLOAD_SESSION_TTL (1 h from authenticated_at). Downloads
    // then 401'd with "Re-authenticate to continue", the console
    // re-authenticated (200), but authenticated_at was left at its original
    // value, so the window never moved and every later download still 401'd.
    const staleAuthenticatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    selectMock
      .mockReturnValueOnce(chainMock([{
        id: TOKEN_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        targetConfig: null,
        status: 'authenticated',
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 21 * 60 * 60 * 1000),
        authenticatedAt: staleAuthenticatedAt,
        completedAt: null,
        usedAt: staleAuthenticatedAt,
      }]))
      .mockReturnValueOnce(chainMock([{
        id: SNAPSHOT_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        configId: null,
        snapshotId: 'snap-ext-001',
        label: 'Backup 2026-03-29',
        location: 's3://breeze-backups/org-001/dev-001/2026-03-29',
        timestamp: new Date('2026-03-29T12:34:56.000Z'),
        size: 1234,
        fileCount: 12,
        metadata: { providerType: 's3', storagePrefix: 's3://breeze-backups/org-001/dev-001/2026-03-29' },
        backupType: 'system_image',
        isIncremental: false,
        hardwareProfile: null,
        systemStateManifest: null,
      }]))
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([{
        id: DEVICE_ID,
        hostname: 'srv-01',
        osType: 'linux',
      }]));

    updateMock.mockReturnValueOnce(chainMock([]));

    const before = Date.now();
    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: VALID_RECOVERY_TOKEN }),
    });
    expect(res.status).toBe(200);

    const updateSetArgs = updateMock.mock.results
      .map((entry) => entry.value?.set?.mock?.calls?.[0]?.[0])
      .filter(Boolean) as Array<{ authenticatedAt?: Date }>;
    const slid = updateSetArgs.find((args) => args.authenticatedAt instanceof Date);
    expect(slid, 'authenticated_at must be rewritten on re-authentication').toBeDefined();
    expect(slid!.authenticatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const body = await res.json() as { authenticatedAt: string; bootstrap: { download: { expiresAt: string } } };
    expect(new Date(body.authenticatedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The returned download window must be a fresh hour, not the stale one.
    expect(new Date(body.bootstrap.download.expiresAt).getTime()).toBeGreaterThan(before + 50 * 60 * 1000);
  });

  it('rate limits public authenticate requests', async () => {
    rateLimiterMock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: LIMITED_RECOVERY_TOKEN }),
    });

    expect(res.status).toBe(429);
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'bmr.recovery.authenticate',
        result: 'denied',
      })
    );
  });

  it('rate limits repeated authenticate attempts for the same token', async () => {
    rateLimiterMock
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 9,
        resetAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 60_000),
      });

    const res = await app.request('/backup/bmr/recover/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: LIMITED_RECOVERY_TOKEN }),
    });

    expect(res.status).toBe(429);
  });

  it('records recovery completion for an authenticated token', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      restoreType: 'bare_metal',
      targetConfig: { diskLayout: 'auto' },
      status: 'authenticated',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      expiresAt: new Date('2026-04-01T00:00:00.000Z'),
      authenticatedAt: new Date('2026-03-29T12:00:00.000Z'),
      completedAt: null,
      usedAt: null,
    }]));
    const restoreJobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    let insertedValues: Record<string, unknown> | null = null;
    const insertChain = chainMock([{
      id: restoreJobId,
      orgId: ORG_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      restoreType: 'bare_metal',
      status: 'completed',
    }]);
    insertChain.values = vi.fn((value: Record<string, unknown>) => {
      insertedValues = value;
      return insertChain;
    });
    insertMock.mockReturnValueOnce(insertChain);
    updateMock.mockReturnValue(chainMock([]));

    const res = await app.request('/backup/bmr/recover/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: VALID_RECOVERY_TOKEN,
        result: {
          status: 'completed',
          filesRestored: 500,
          bytesRestored: 1048576,
          stateApplied: true,
          driversInjected: 2,
          validated: true,
          warnings: ['driver warning'],
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restoreJobId).toBe(restoreJobId);
    expect(body.status).toBe('completed');
    expect(insertedValues).toMatchObject({
      restoredSize: 1048576,
      restoredFiles: 500,
      targetConfig: {
        diskLayout: 'auto',
        result: {
          status: 'completed',
          filesRestored: 500,
          bytesRestored: 1048576,
          stateApplied: true,
          driversInjected: 2,
          validated: true,
          warnings: ['driver warning'],
          error: null,
        },
      },
    });
  });

  // D14: failedFiles is the per-file failure count for a partially-successful
  // recovery (mirrors errorCount on the ordinary backup-result path) and must
  // land in the persisted restore job's targetConfig.result JSON alongside the
  // other completion fields.
  it('persists failedFiles from a partial recovery completion', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      restoreType: 'bare_metal',
      targetConfig: { diskLayout: 'auto' },
      status: 'authenticated',
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      expiresAt: new Date('2026-04-01T00:00:00.000Z'),
      authenticatedAt: new Date('2026-03-29T12:00:00.000Z'),
      completedAt: null,
      usedAt: null,
    }]));
    const restoreJobId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    let insertedValues: Record<string, unknown> | null = null;
    const insertChain = chainMock([{
      id: restoreJobId,
      orgId: ORG_ID,
      snapshotId: SNAPSHOT_ID,
      deviceId: DEVICE_ID,
      restoreType: 'bare_metal',
      status: 'partial',
    }]);
    insertChain.values = vi.fn((value: Record<string, unknown>) => {
      insertedValues = value;
      return insertChain;
    });
    insertMock.mockReturnValueOnce(insertChain);
    updateMock.mockReturnValue(chainMock([]));

    const res = await app.request('/backup/bmr/recover/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: VALID_RECOVERY_TOKEN,
        result: {
          status: 'partial',
          filesRestored: 9_800,
          failedFiles: 47,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(insertedValues).toMatchObject({
      targetConfig: {
        result: {
          status: 'partial',
          failedFiles: 47,
        },
      },
    });
  });

  it('returns the existing restore job for repeated completion calls', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{
        id: TOKEN_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        targetConfig: { diskLayout: 'auto' },
        status: 'used',
        createdAt: new Date('2026-03-29T00:00:00.000Z'),
        expiresAt: new Date('2026-04-01T00:00:00.000Z'),
        authenticatedAt: new Date('2026-03-29T12:00:00.000Z'),
        completedAt: new Date('2026-03-29T13:00:00.000Z'),
        usedAt: new Date('2026-03-29T13:00:00.000Z'),
      }]))
      .mockReturnValueOnce(chainMock([{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        status: 'completed',
      }]));

    const res = await app.request('/backup/bmr/recover/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: VALID_RECOVERY_TOKEN,
        result: { status: 'completed' },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      restoreJobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      status: 'completed',
    });
  });

  it('streams authenticated recovery downloads through the public endpoint', async () => {
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      snapshotId: SNAPSHOT_ID,
      status: 'authenticated',
      authenticatedAt: new Date('2026-03-31T13:00:00.000Z'),
      expiresAt: new Date('2026-04-01T00:00:00.000Z'),
    }]));
    getAuthenticatedRecoveryDownloadTargetMock.mockResolvedValueOnce({
      unavailable: false,
      type: 'stream',
      contentType: 'application/json',
      contentLength: 2,
      stream: Readable.from(Buffer.from('{}')),
    });

    const res = await app.request(
      '/backup/bmr/recover/download?path=snapshots/snap-ext-001/manifest.json',
      { headers: { Authorization: `Bearer ${VALID_RECOVERY_TOKEN}` } },
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
    expect(getAuthenticatedRecoveryDownloadTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: TOKEN_ID }),
      'snapshots/snap-ext-001/manifest.json'
    );
  });

  it('rate limits repeated recovery downloads for the same token', async () => {
    rateLimiterMock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request(
      '/backup/bmr/recover/download?path=snapshots/snap-ext-001/manifest.json',
      { headers: { 'X-Recovery-Token': VALID_RECOVERY_TOKEN } },
    );

    expect(res.status).toBe(429);
    expect(getAuthenticatedRecoveryDownloadTargetMock).not.toHaveBeenCalled();
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  // D13: a bare-metal recovery fetches one object PER FILE
  // (getAuthenticatedRecoveryDownloadTarget is called once per download
  // request), so a legitimate 10,000+ file recovery must not be throttled by
  // the per-token limit. Pin the raised constants directly rather than only
  // asserting the 429 shape above, so a regression back toward the old
  // 100/minute limit fails loudly here instead of silently reappearing in
  // production telemetry.
  it('sizes the per-token download rate limit for a large bare-metal recovery, not a 100-object window', async () => {
    rateLimiterMock.mockResolvedValueOnce({
      allowed: true,
      remaining: 9_999,
      resetAt: new Date(Date.now() + 60_000),
    });
    getAuthenticatedRecoveryDownloadTargetMock.mockResolvedValueOnce({
      unavailable: false,
      type: 'stream',
      contentType: 'application/json',
      contentLength: 2,
      stream: Readable.from(Buffer.from('{}')),
    });
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      snapshotId: SNAPSHOT_ID,
      status: 'authenticated',
      authenticatedAt: new Date('2026-03-31T13:00:00.000Z'),
      expiresAt: new Date('2026-04-01T00:00:00.000Z'),
    }]));

    await app.request(
      '/backup/bmr/recover/download?path=snapshots/snap-ext-001/manifest.json',
      { headers: { 'X-Recovery-Token': VALID_RECOVERY_TOKEN } },
    );

    expect(rateLimiterMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^bmr:download:token:/),
      10_000,
      60
    );
  });

  it('rejects recovery download query tokens by default', async () => {
    const res = await app.request(
      `/backup/bmr/recover/download?token=${VALID_RECOVERY_TOKEN}&path=snapshots/snap-ext-001/manifest.json`
    );

    expect(res.status).toBe(400);
    expect(rateLimiterMock).not.toHaveBeenCalled();
    expect(getAuthenticatedRecoveryDownloadTargetMock).not.toHaveBeenCalled();
  });

  it('allows recovery download query tokens only behind the compatibility flag', async () => {
    process.env.BMR_RECOVERY_ALLOW_QUERY_TOKEN = 'true';
    selectMock.mockReturnValueOnce(chainMock([{
      id: TOKEN_ID,
      snapshotId: SNAPSHOT_ID,
      status: 'authenticated',
      authenticatedAt: new Date('2026-03-31T13:00:00.000Z'),
      expiresAt: new Date('2026-04-01T00:00:00.000Z'),
    }]));
    getAuthenticatedRecoveryDownloadTargetMock.mockResolvedValueOnce({
      unavailable: false,
      type: 'stream',
      contentType: 'application/json',
      contentLength: 2,
      stream: Readable.from(Buffer.from('{}')),
    });

    const res = await app.request(
      `/backup/bmr/recover/download?token=${VALID_RECOVERY_TOKEN}&path=snapshots/snap-ext-001/manifest.json`
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
  });

  it('creates a recovery media build job', async () => {
    updateMock.mockReturnValueOnce(chainMock([]));
    selectMock
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([{
        id: TOKEN_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        status: 'active',
        createdAt: new Date('2026-03-29T00:00:00.000Z'),
        expiresAt: new Date('2026-04-01T00:00:00.000Z'),
      }]))
      .mockReturnValueOnce(chainMock([]));
    insertMock.mockReturnValueOnce(chainMock([{
      id: 'media-artifact-1',
      orgId: ORG_ID,
      tokenId: TOKEN_ID,
      snapshotId: SNAPSHOT_ID,
      platform: 'linux',
      architecture: 'amd64',
      status: 'pending',
      storageKey: null,
      checksumSha256: null,
      metadata: {},
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      completedAt: null,
    }]));

    const res = await app.request('/backup/bmr/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        tokenId: TOKEN_ID,
        platform: 'linux',
        architecture: 'amd64',
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.id).toBe('media-artifact-1');
    expect(body.status).toBe('pending');
    expect(enqueueRecoveryMediaBuildMock).toHaveBeenCalledWith('media-artifact-1');
    expect(captureRecoveryAuthorizationSubjectMock).toHaveBeenCalledWith(authState, ORG_ID, 'media');
    const insertChain = insertMock.mock.results.at(-1)!.value;
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining(capturedAuthorizationSubject));
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('observes an existing pending media build without replacing its authorization subject', async () => {
    updateMock.mockReturnValueOnce(chainMock([]));
    selectMock
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([{
        id: TOKEN_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        status: 'active',
      }]))
      .mockReturnValueOnce(chainMock([{
        id: 'media-artifact-1',
        orgId: ORG_ID,
        tokenId: TOKEN_ID,
        snapshotId: SNAPSHOT_ID,
        platform: 'linux',
        architecture: 'amd64',
        status: 'pending',
        storageKey: null,
        checksumSha256: null,
        metadata: {},
        createdAt: new Date('2026-03-29T00:00:00.000Z'),
        completedAt: null,
        authorizationPrincipalKind: 'oauth_grant',
        authorizationPrincipalId: 'grant-original',
        authorizationGrantRevision: 'sha256:original',
      }]));

    const res = await app.request('/backup/bmr/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ tokenId: TOKEN_ID, platform: 'linux', architecture: 'amd64' }),
    });

    expect(res.status).toBe(202);
    expect(captureRecoveryAuthorizationSubjectMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(enqueueRecoveryMediaBuildMock).not.toHaveBeenCalled();
  });

  it('atomically replaces the durable subject when a different authorized caller retries failed media', async () => {
    authState = {
      ...authState,
      principal: { kind: 'oauth_grant', grantId: 'grant-new', clientId: 'client-1' } as any,
    };
    const replacement = {
      ...capturedAuthorizationSubject,
      authorizationPrincipalKind: 'oauth_grant' as const,
      authorizationPrincipalId: 'grant-new',
      authorizationGrantRevision: `sha256:${'b'.repeat(64)}`,
    };
    captureRecoveryAuthorizationSubjectMock.mockResolvedValueOnce(replacement);
    updateMock.mockReturnValueOnce(chainMock([]));
    selectMock
      .mockReturnValueOnce(chainMock([]))
      .mockReturnValueOnce(chainMock([{
        id: TOKEN_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        snapshotId: SNAPSHOT_ID,
        restoreType: 'bare_metal',
        status: 'active',
      }]))
      .mockReturnValueOnce(chainMock([{
        id: 'media-artifact-1',
        orgId: ORG_ID,
        tokenId: TOKEN_ID,
        snapshotId: SNAPSHOT_ID,
        platform: 'linux',
        architecture: 'amd64',
        status: 'failed',
        metadata: {},
        createdAt: new Date('2026-03-29T00:00:00.000Z'),
        completedAt: new Date('2026-03-29T00:10:00.000Z'),
      }]));
    updateMock.mockReturnValueOnce(chainMock([{
      id: 'media-artifact-1',
      orgId: ORG_ID,
      tokenId: TOKEN_ID,
      snapshotId: SNAPSHOT_ID,
      platform: 'linux',
      architecture: 'amd64',
      status: 'pending',
      metadata: {},
      createdAt: new Date('2026-03-29T00:00:00.000Z'),
      completedAt: null,
      ...replacement,
    }]));

    const res = await app.request('/backup/bmr/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ tokenId: TOKEN_ID, platform: 'linux', architecture: 'amd64' }),
    });

    expect(res.status).toBe(202);
    expect(captureRecoveryAuthorizationSubjectMock).toHaveBeenCalledWith(authState, ORG_ID, 'media');
    const updateChain = updateMock.mock.results.at(-1)!.value;
    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining(replacement));
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(enqueueRecoveryMediaBuildMock).toHaveBeenCalledWith('media-artifact-1');
  });

  it('lists recovery signing keys', async () => {
    const res = await app.request('/backup/bmr/signing-keys', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      expect.objectContaining({
        keyId: 'current',
        format: 'minisign',
      }),
    ]);
  });

  it('returns the current recovery signing key', async () => {
    const res = await app.request('/backup/bmr/signing-key', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({
      keyId: 'current',
      format: 'minisign',
      publicKey: 'RWQTESTMINISIGNPUBLICKEY',
    }));
  });

  // W04b: the per-token ISO builder (POST /bmr/boot-media, etc.) is retired.
  // GET /bmr/boot-media now advertises the release-built Linux recovery ISO
  // catalog instead — see agent/recovery-media/ and
  // routes/agents/download.ts's /download/recovery-iso/linux/:arch.
  it('returns the linux recovery media catalog with manifest checksums', async () => {
    lookupReleaseManifestAssetForDisplayMock.mockImplementation(async (assetName: string) => {
      if (assetName === 'breeze-recovery-linux-amd64.iso') {
        return { sha256: 'a'.repeat(64), size: 419430400 };
      }
      return null;
    });

    const res = await app.request('/backup/bmr/boot-media', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      expect.objectContaining({
        platform: 'linux',
        arch: 'amd64',
        filename: 'breeze-recovery-linux-amd64.iso',
        downloadUrl: '/api/v1/agents/download/recovery-iso/linux/amd64',
        sha256: 'a'.repeat(64),
        size: 419430400,
      }),
      expect.objectContaining({
        platform: 'linux',
        arch: 'arm64',
        filename: 'breeze-recovery-linux-arm64.iso',
        downloadUrl: '/api/v1/agents/download/recovery-iso/linux/arm64',
        sha256: null,
        size: null,
      }),
    ]);
  });

  it('degrades to null checksums when the release manifest cannot be resolved', async () => {
    lookupReleaseManifestAssetForDisplayMock.mockResolvedValue(null);

    const res = await app.request('/backup/bmr/boot-media', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    for (const entry of body.data) {
      expect(entry.sha256).toBeNull();
      expect(entry.size).toBeNull();
    }
  });
});

function makeTokenSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: TOKEN_ID,
    deviceId: DEVICE_ID,
    snapshotId: SNAPSHOT_ID,
    restoreType: 'bare_metal',
    status: 'active',
    createdAt: new Date('2026-03-29T00:00:00.000Z'),
    expiresAt: new Date('2026-03-30T00:00:00.000Z'),
    authenticatedAt: null,
    completedAt: null,
    usedAt: null,
    ...overrides,
  };
}
