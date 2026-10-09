import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { hashRecoveryCode, hashRecoveryNonce } from '../../services/bareMetalRecoveryCodes';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SNAPSHOT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RECOVERY_ID = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const VALID_RECOVERY_TOKEN = `brz_rec_${'a'.repeat(64)}`;

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'orderBy', 'offset', 'leftJoin', 'innerJoin']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const transactionMock = vi.fn(async (callback: (tx: any) => unknown) => callback({
  select: (...args: unknown[]) => selectMock(...(args as [])),
  insert: (...args: unknown[]) => insertMock(...(args as [])),
  update: (...args: unknown[]) => updateMock(...(args as [])),
}));

let authState: any = {
  principal: { kind: 'user_session' },
  user: { id: 'user-123', email: 'test@example.com' },
  scope: 'organization',
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../db', () => ({
  hasDbAccessContext: () => false,
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    transaction: (...args: unknown[]) => transactionMock(...(args as [any])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
  withDbAccessContext: vi.fn((_context: unknown, fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  BARE_METAL_RECOVERY_TERMINAL: new Set(['checked_in', 'completed', 'failed', 'refused']),
  backupSnapshotOrigins: {
    snapshotDbId: 'backup_snapshot_origins.snapshot_db_id',
    originSnapshotId: 'backup_snapshot_origins.origin_snapshot_id',
    originOrgId: 'backup_snapshot_origins.origin_org_id',
    originDeviceId: 'backup_snapshot_origins.origin_device_id',
    originStorageIdentity: 'backup_snapshot_origins.origin_storage_identity',
  },
  backupSnapshotFiles: {
    id: 'backup_snapshot_files.id',
    snapshotDbId: 'backup_snapshot_files.snapshot_db_id',
    backupPath: 'backup_snapshot_files.backup_path',
  },
  backupSnapshotRetirements: {
    orgId: 'backup_snapshot_retirements.org_id',
    deviceId: 'backup_snapshot_retirements.device_id',
    snapshotId: 'backup_snapshot_retirements.snapshot_id',
    storageIdentity: 'backup_snapshot_retirements.storage_identity',
  },
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
  backupJobs: {
    id: 'backup_jobs.id',
    referencedFiles: 'backup_jobs.referenced_files',
  },
  backupSnapshots: {
    id: 'backup_snapshots.id',
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    jobId: 'backup_snapshots.job_id',
    configId: 'backup_snapshots.config_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    bareMetalRestorable: 'backup_snapshots.bare_metal_restorable',
    bareMetalReasons: 'backup_snapshots.bare_metal_reasons',
    storageIdentity: 'backup_snapshots.storage_identity',
    fileIndexStatus: 'backup_snapshots.file_index_status',
    fileIndexManifestSha256: 'backup_snapshots.file_index_manifest_sha256',
    fileIndexExternalCount: 'backup_snapshots.file_index_external_count',
    fileIndexError: 'backup_snapshots.file_index_error',
  },
  devices: {
    id: 'devices.id',
    hostname: 'devices.hostname',
    osType: 'devices.os_type',
    architecture: 'devices.architecture',
    displayName: 'devices.display_name',
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
    negotiatedCapabilities: 'recovery_tokens.negotiated_capabilities',
  },
}));

// W05a: the cancel / reissue-code routes are asserted to sit behind MFA and
// BACKUP_WRITE, so the middleware mocks are switchable per test.
let mfaSatisfied = true;
let deniedPermission: string | null = null;
vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => (c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => (c: any, next: any) => {
    c.set('auth', authState);
    if (deniedPermission === `${resource}:${action}`) return c.json({ error: 'forbidden' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => (c: any, next: any) => (mfaSatisfied ? next() : c.json({ error: 'mfa_required' }, 403))),
}));

const writeRouteAuditMock = vi.fn();
const writeAuditEventMock = vi.fn();
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
  writeAuditEvent: (...args: unknown[]) => writeAuditEventMock(...(args as [])),
}));
// W05a: create/cancel/reissue audits are written by bareMetalRecoveryService
// through createAuditLogAsync (no Hono context in the DR / Restore-as-VM callers).
const createAuditLogAsyncMock = vi.fn(async () => undefined);
vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: (...args: unknown[]) => createAuditLogAsyncMock(...(args as [])),
}));

const authorizeResilienceResourcesMock = vi.fn(async (): Promise<
  { ok: true; authorization: { resources: unknown[] } } | { ok: false; response: Response }
> => ({ ok: true, authorization: { resources: [] } }));
const resolveRouteAuthorizedDeviceIdsMock = vi.fn(async () => null as string[] | null);
vi.mock('./resilienceAuthorization', () => ({
  authorizeRouteResilienceResources: (...args: unknown[]) => authorizeResilienceResourcesMock(...(args as [])),
  resolveRouteAuthorizedDeviceIds: (...args: unknown[]) => resolveRouteAuthorizedDeviceIdsMock(...(args as [])),
}));

vi.mock('./helpers', () => ({
  resolveScopedOrgId: vi.fn((auth: any) => auth.orgId ?? ORG_ID),
}));

const enforcePublicRateLimitMock = vi.fn(async () => null);
const enforceTokenRateLimitMock = vi.fn(async () => null);
const runInRecoveryOrgContextMock = vi.fn((_orgId: string, fn: () => any) => fn());
vi.mock('./bmr', () => ({
  enforcePublicRateLimit: (...args: unknown[]) => enforcePublicRateLimitMock(...(args as [])),
  enforceTokenRateLimit: (...args: unknown[]) => enforceTokenRateLimitMock(...(args as [])),
  runInRecoveryOrgContext: (...args: unknown[]) => runInRecoveryOrgContextMock(...(args as [any, any])),
  BMR_PROGRESS_IP_LIMIT: 10_000,
}));

vi.mock('../../services/recoveryBootstrap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/recoveryBootstrap')>();
  return { ...actual };
});

const resolveRestoreIntegrityMock = vi.hoisted(() => vi.fn(async (_snapshotDbId: string): Promise<unknown> => null));
vi.mock('../../services/backupRestoreIntegrity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/backupRestoreIntegrity')>()),
  resolveRestoreIntegrity: (id: string) => resolveRestoreIntegrityMock(id),
}));

// Integrity checks themselves are covered in restoreIntegrityGate.test.ts and
// backupRecoveryIntegrityGate.test.ts; here only how the routes use them.
const ATTESTED_BLOCK = {
  v: 1, mode: 'attested', trust: 'server_verified', snapshotId: 'snap-ext-1',
  objects: [{ role: 'manifest', key: 'snapshots/snap-ext-1/manifest.json', sha256: 'a'.repeat(64), size: 9 }],
};
const integrityGate = vi.hoisted(() => ({ check: vi.fn(), record: vi.fn(), evaluate: vi.fn() }));
vi.mock('./restoreIntegrityGate', () => ({
  checkRestoreIntegrityRequest: (...args: unknown[]) => integrityGate.check(...args),
  recordRequestAuthorization: (...args: unknown[]) => integrityGate.record(...args),
  restoreIntegrityResponse: (c: any, check: any) => c.json(check.body, check.status),
}));
vi.mock('../../services/backupRecoveryIntegrityGate', () => ({
  evaluateRecoveryIntegrity: (...args: unknown[]) => integrityGate.evaluate(...args),
}));

const enqueueSnapshotFileIndexHydrationMock = vi.fn(async (..._args: unknown[]) => 'job-1');
vi.mock('../../jobs/backupSnapshotFileIndexWorker', () => ({
  enqueueSnapshotFileIndexHydration: (...args: unknown[]) => enqueueSnapshotFileIndexHydrationMock(...(args as [])),
}));

import { bmrRecoveryRoutes, bmrRecoveryPublicRoutes } from './bmrRecoveries';
import { BMR_MIN_HELPER_VERSION } from '../../services/recoveryBootstrap';

describe('bare-metal recoveries routes', () => {
  let app: Hono;
  let publicApp: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    integrityGate.check.mockReset();
    integrityGate.check.mockResolvedValue({ ok: true, authorizationReason: null });
    integrityGate.record.mockReset();
    integrityGate.record.mockResolvedValue('authorization-1');
    integrityGate.evaluate.mockReset();
    integrityGate.evaluate.mockResolvedValue({ ok: true, integrity: ATTESTED_BLOCK });
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
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    authorizeResilienceResourcesMock.mockResolvedValue({ ok: true, authorization: { resources: [] } });
    resolveRouteAuthorizedDeviceIdsMock.mockResolvedValue(null);
    mfaSatisfied = true;
    deniedPermission = null;
    enforcePublicRateLimitMock.mockResolvedValue(null);
    enforceTokenRateLimitMock.mockResolvedValue(null);
    runInRecoveryOrgContextMock.mockImplementation((_orgId: string, fn: () => any) => fn());

    app = new Hono();
    app.use('*', (c, next) => {
      c.set('auth', authState);
      return next();
    });
    app.route('/backup', bmrRecoveryRoutes);

    publicApp = new Hono();
    publicApp.route('/backup', bmrRecoveryPublicRoutes);
  });

  describe('GET /backup/bmr/recoveries (W09, #6464)', () => {
    it('exposes the token snapshot file-index status on each summary', async () => {
      const row = {
        id: RECOVERY_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, recoveryTokenId: null, identity: 'original',
        status: 'created', codeExpiresAt: new Date(), codeUsedAt: null, nonceHash: 'x'.repeat(64),
        target: null, plan: null, result: null, failureReason: null, warnings: null,
        createdAt: new Date(), updatedAt: new Date(), mediaBootedAt: null, plannedAt: null, restoringAt: null,
        validatedAt: null, rebootedAt: null, checkedInAt: null, completedAt: null,
      };
      selectMock.mockReturnValueOnce(chainMock([{ row, fileIndexStatus: 'hydrating' }]));

      const res = await app.request('/backup/bmr/recoveries', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ id: RECOVERY_ID, fileIndexStatus: 'hydrating' });
    });

    it('short-circuits to an empty list for a site-restricted caller with no allowed devices, without querying recoveries', async () => {
      // Mirrors the resolver's real contract: null means unrestricted, an
      // empty array means site-restricted with zero allowed devices in this
      // org. The route must not fall through to an unfiltered query in that
      // case — it has nothing to intersect against.
      resolveRouteAuthorizedDeviceIdsMock.mockResolvedValueOnce([]);
      const row = {
        id: RECOVERY_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, recoveryTokenId: null, identity: 'original',
        status: 'created', codeExpiresAt: new Date(), codeUsedAt: null, nonceHash: 'x'.repeat(64),
        target: null, plan: null, result: null, failureReason: null, warnings: null,
        createdAt: new Date(), updatedAt: new Date(), mediaBootedAt: null, plannedAt: null, restoringAt: null,
        validatedAt: null, rebootedAt: null, checkedInAt: null, completedAt: null,
      };
      // If the route fails to apply the site filter, this row would still
      // be returned by an unfiltered recoveries query.
      selectMock.mockReturnValueOnce(chainMock([{ row, fileIndexStatus: null }]));

      const res = await app.request('/backup/bmr/recoveries', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(selectMock).not.toHaveBeenCalled();
    });

    it('rejects an explicit out-of-scope device filter for a site-restricted caller', async () => {
      resolveRouteAuthorizedDeviceIdsMock.mockResolvedValueOnce(['other-device-id']);

      const res = await app.request(`/backup/bmr/recoveries?deviceId=${DEVICE_ID}`, { method: 'GET' });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'site_access_denied' });
    });

    it('includes platform on each summary', async () => {
      const row = {
        id: RECOVERY_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, recoveryTokenId: null, identity: 'original',
        status: 'created', codeExpiresAt: new Date(), codeUsedAt: null, nonceHash: 'x'.repeat(64),
        target: null, plan: null, result: null, failureReason: null, warnings: null,
        createdAt: new Date(), updatedAt: new Date(), mediaBootedAt: null, plannedAt: null, restoringAt: null,
        validatedAt: null, rebootedAt: null, checkedInAt: null, completedAt: null, platform: 'windows',
      };
      selectMock.mockReturnValueOnce(chainMock([{ row, fileIndexStatus: null }]));

      const res = await app.request('/backup/bmr/recoveries', { method: 'GET' });
      const body = await res.json();
      expect(body.data[0].platform).toBe('windows');
    });
  });

  describe('GET /backup/bmr/recoveries/:id', () => {
    const row = {
      id: RECOVERY_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, recoveryTokenId: null, identity: 'original',
      status: 'created', codeExpiresAt: new Date(), codeUsedAt: null, nonceHash: 'x'.repeat(64),
      target: null, plan: null, result: null, failureReason: null, warnings: null,
      createdAt: new Date(), updatedAt: new Date(), mediaBootedAt: null, plannedAt: null, restoringAt: null,
      validatedAt: null, rebootedAt: null, checkedInAt: null, completedAt: null, platform: 'windows',
    };

    it('returns a recovery whose device site is authorized', async () => {
      selectMock.mockReturnValueOnce(chainMock([row]));

      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}`, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(authorizeResilienceResourcesMock).toHaveBeenCalledWith(
        expect.anything(),
        ORG_ID,
        [{ kind: 'device', id: DEVICE_ID, role: 'target' }],
        'read',
      );
      const body = await res.json();
      expect(body).toMatchObject({ id: RECOVERY_ID });
    });

    it('includes platform', async () => {
      selectMock.mockReturnValueOnce(chainMock([row]));

      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}`, { method: 'GET' });
      const body = await res.json();
      expect(body.platform).toBe('windows');
    });

    it('denies a recovery on a hidden-site device for a site-restricted caller', async () => {
      selectMock.mockReturnValueOnce(chainMock([row]));
      authorizeResilienceResourcesMock.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) });

      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}`, { method: 'GET' });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /backup/bmr/recoveries', () => {
    it('creates a recovery for a bare-metal-restorable snapshot and returns a formatted one-time code', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, deviceId: DEVICE_ID, orgId: ORG_ID, bareMetalRestorable: true, bareMetalReasons: [] }]))
        .mockReturnValueOnce(chainMock([]));
      insertMock.mockReturnValueOnce(chainMock([{
        id: RECOVERY_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, recoveryTokenId: null, identity: 'original',
        status: 'created', codeExpiresAt: new Date(), codeUsedAt: null, nonceHash: 'x'.repeat(64),
        target: null, plan: null, result: null, failureReason: null, warnings: null,
        createdAt: new Date(), updatedAt: new Date(), mediaBootedAt: null, plannedAt: null, restoringAt: null,
        validatedAt: null, rebootedAt: null, checkedInAt: null, completedAt: null,
      }]));

      const res = await app.request('/backup/bmr/recoveries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId: SNAPSHOT_ID, identity: 'original' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
      expect(body).not.toHaveProperty('codeHash');
      // W05b Task 6: the summary exposes the DR linkage and rebuild host (null for boot media).
      expect(body).toMatchObject({ executingDeviceId: null, drExecutionId: null, drGroupId: null });
      const inserted = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
      expect(inserted.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(inserted.nonceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(inserted).not.toHaveProperty('nonce');
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
        action: 'bmr.recovery.create',
        actorId: 'user-123',
        details: expect.objectContaining({ source: 'route', identity: 'original' }),
      }));
    });

    it('answers a step-up request for an unattested snapshot without creating a recovery', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, deviceId: DEVICE_ID, orgId: ORG_ID, bareMetalRestorable: true, bareMetalReasons: [] }]))
        .mockReturnValueOnce(chainMock([]));
      integrityGate.check.mockResolvedValueOnce({ ok: false, status: 403, body: { code: 'STEP_UP_REQUIRED', error: 'confirm' } });
      const res = await app.request('/backup/bmr/recoveries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId: SNAPSHOT_ID, stepUpGrant: '66666666-6666-4666-8666-666666666666' }),
      });
      expect(res.status).toBe(403);
      expect(insertMock).not.toHaveBeenCalled();
      expect(integrityGate.check).toHaveBeenCalledWith(expect.anything(), {
        orgId: ORG_ID,
        snapshotDbId: SNAPSHOT_ID,
        targetDeviceId: DEVICE_ID,
        commandType: 'bmr_recover',
        stepUpGrant: '66666666-6666-4666-8666-666666666666',
        confirmUnattestedRestore: undefined,
      });
    });

    it('records a confirmed recovery\'s authorization bound to the recovery, in the same transaction', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, deviceId: DEVICE_ID, orgId: ORG_ID, bareMetalRestorable: true, bareMetalReasons: [] }]))
        .mockReturnValueOnce(chainMock([]));
      insertMock.mockReturnValueOnce(chainMock([{
        id: RECOVERY_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, recoveryTokenId: null, identity: 'original',
        status: 'created', codeExpiresAt: new Date(), codeUsedAt: null, nonceHash: 'x'.repeat(64),
        target: null, plan: null, result: null, failureReason: null, warnings: null,
        createdAt: new Date(), updatedAt: new Date(), mediaBootedAt: null, plannedAt: null, restoringAt: null,
        validatedAt: null, rebootedAt: null, checkedInAt: null, completedAt: null,
      }]));
      integrityGate.check.mockResolvedValueOnce({ ok: true, authorizationReason: 'unattested_legacy', confirmationMethod: 'mfa' });
      const res = await app.request('/backup/bmr/recoveries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId: SNAPSHOT_ID }),
      });
      expect(res.status).toBe(201);
      expect(integrityGate.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ snapshotDbId: SNAPSHOT_ID, targetDeviceId: DEVICE_ID, commandType: 'bmr_recover' }),
        'unattested_legacy',
        { recoveryId: RECOVERY_ID },
        { inCurrentTransaction: true, confirmationMethod: 'mfa' },
      );
    });

    it('refuses a snapshot the guard marked non-restorable, naming the reasons', async () => {
      selectMock.mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, deviceId: DEVICE_ID, orgId: ORG_ID, bareMetalRestorable: false, bareMetalReasons: ['LVM volumes are not supported'] }]));
      const res = await app.request('/backup/bmr/recoveries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId: SNAPSHOT_ID }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'snapshot_not_bare_metal_restorable', reasons: ['LVM volumes are not supported'] });
    });

    it('refuses when the device already has a recovery in progress', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{ id: SNAPSHOT_ID, deviceId: DEVICE_ID, orgId: ORG_ID, bareMetalRestorable: true, bareMetalReasons: [] }]))
        .mockReturnValueOnce(chainMock([{ id: 'rec-0', status: 'restoring' }]));
      const res = await app.request('/backup/bmr/recoveries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotId: SNAPSHOT_ID }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'recovery_in_progress', recoveryId: 'rec-0', status: 'restoring' });
    });
  });

  function fullRecoveryRow(overrides: Record<string, unknown> = {}) {
    return {
      id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, recoveryTokenId: null, identity: 'new',
      status: 'created', codeHash: 'a'.repeat(64), codeExpiresAt: new Date(), codeUsedAt: null, nonceHash: 'x'.repeat(64),
      target: null, plan: null, result: null, failureReason: null, warnings: null, createdBy: 'user-123',
      createdAt: new Date(), updatedAt: new Date(), mediaBootedAt: null, plannedAt: null, restoringAt: null,
      validatedAt: null, rebootedAt: null, checkedInAt: null, completedAt: null,
      ...overrides,
    };
  }

  describe('POST /backup/bmr/recoveries/:id/cancel', () => {
    it('cancels a non-terminal recovery, authorizes the device, and audits bmr.recovery.cancel', async () => {
      selectMock.mockReturnValue(chainMock([fullRecoveryRow({ status: 'restoring' })]));
      updateMock.mockReturnValueOnce(chainMock([fullRecoveryRow({ status: 'failed', failureReason: 'cancelled' })]));

      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'stuck rehearsal' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: RECOVERY_ID, status: 'failed', failureReason: 'cancelled' });
      expect(authorizeResilienceResourcesMock).toHaveBeenCalledWith(
        expect.anything(), ORG_ID, [{ kind: 'device', id: DEVICE_ID, role: 'target' }], 'revoke',
      );
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'bmr.recovery.cancel', resourceId: RECOVERY_ID }));
    });

    it('409s invalid_state for a terminal recovery', async () => {
      selectMock.mockReturnValue(chainMock([fullRecoveryRow({ status: 'completed' })]));
      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/cancel`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'invalid_state' });
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('404s an unknown recovery before any authorization side effect', async () => {
      selectMock.mockReturnValueOnce(chainMock([]));
      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/cancel`, { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('requires MFA', async () => {
      mfaSatisfied = false;
      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/cancel`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(selectMock).not.toHaveBeenCalled();
    });

    it('requires backup:write', async () => {
      deniedPermission = 'backup:write';
      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/cancel`, { method: 'POST' });
      expect(res.status).toBe(403);
      expect(selectMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /backup/bmr/recoveries/:id/reissue-code', () => {
    it('rotates the code, rate-limits per recovery, and returns the new code once', async () => {
      selectMock.mockReturnValue(chainMock([fullRecoveryRow({ status: 'media_booted' })]));
      updateMock.mockReturnValueOnce(chainMock([fullRecoveryRow({ status: 'media_booted' })]));

      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/reissue-code`, { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
      expect(body).not.toHaveProperty('codeHash');
      expect(enforceTokenRateLimitMock).toHaveBeenCalledWith(expect.anything(), 'reissue', RECOVERY_ID, 5, 3600);
      expect(authorizeResilienceResourcesMock).toHaveBeenCalledWith(
        expect.anything(), ORG_ID, [{ kind: 'device', id: DEVICE_ID, role: 'target' }], 'token',
      );
      const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
      expect(set.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(set.codeHash).not.toBe('a'.repeat(64));
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'bmr.recovery.reissue_code', resourceId: RECOVERY_ID }));
    });

    it('returns the rate-limit response without touching the row', async () => {
      enforceTokenRateLimitMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }) as never);
      selectMock.mockReturnValue(chainMock([fullRecoveryRow({ status: 'created' })]));
      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/reissue-code`, { method: 'POST' });
      expect(res.status).toBe(429);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('409s invalid_state once the helper has moved past media_booted', async () => {
      selectMock.mockReturnValue(chainMock([fullRecoveryRow({ status: 'planned' })]));
      const res = await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/reissue-code`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'invalid_state' });
    });

    it('requires MFA and backup:write', async () => {
      mfaSatisfied = false;
      expect((await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/reissue-code`, { method: 'POST' })).status).toBe(403);
      mfaSatisfied = true;
      deniedPermission = 'backup:write';
      expect((await app.request(`/backup/bmr/recoveries/${RECOVERY_ID}/reissue-code`, { method: 'POST' })).status).toBe(403);
      expect(selectMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /bmr/recover/exchange', () => {
    it('exchanges a valid code once: mints a token, marks media_booted, returns bootstrap with nonce', async () => {
      const code = 'ABCDEFGHJ';
      selectMock
        .mockReturnValueOnce(chainMock([{
          id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
          status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
          codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
        }]))
        // readSnapshotFileIndexState (negotiation, called first): self-contained
        // snapshot (jobId null -> referencedFiles null) short-circuits to "not needed".
        .mockReturnValueOnce(chainMock([{
          status: 'none', manifestSha256: null, externalCount: null, error: null, jobId: null, storageIdentity: null,
        }]))
        // resolveSnapshotProviderConfig (negotiation, called second, and its
        // result is reused for the bootstrap — no second call).
        .mockReturnValueOnce(chainMock([{
          id: SNAPSHOT_ID, orgId: ORG_ID, deviceId: DEVICE_ID, jobId: null, configId: null, snapshotId: 'snap-ext-1',
          label: null, location: null, timestamp: new Date(), size: 1, fileCount: 1, metadata: {},
          hardwareProfile: null, systemStateManifest: null, backupType: 'full', isIncremental: false,
          storageIdentity: null,
        }]))
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, hostname: 'rig-01', osType: 'linux', architecture: 'x86_64', displayName: null }]));
      insertMock.mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, restoreType: 'bare_metal', targetConfig: {}, expiresAt: new Date(Date.now() + 86_400_000), authenticatedAt: new Date() }]));
      // The conditional one-time-claim UPDATE (review fix) must return the
      // claimed row for the exchange to proceed — an empty result models
      // "someone else claimed it first" and is covered by a separate test.
      updateMock.mockReturnValueOnce(chainMock([{ id: RECOVERY_ID, status: 'media_booted' }]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toMatch(/^brz_rec_[0-9a-f]{64}$/);
      expect(body.bootstrap.bootstrap.recovery).toMatchObject({ id: RECOVERY_ID, identity: 'original', deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID });
      expect(body.bootstrap.bootstrap.recovery.nonce).toMatch(/^[0-9a-f]{64}$/);
      // The helper derives ExpectSystemState from backupType (#5412,
      // bmr.SnapshotExpectsSystemState): the exchange bootstrap must carry
      // it alongside systemStateManifest, exactly as authenticate does.
      expect(body.bootstrap.bootstrap.snapshot).toMatchObject({ snapshotId: 'snap-ext-1', backupType: 'full', systemStateManifest: null });
      // The decided integrity block rides on the bootstrap.
      expect(body.bootstrap.integrity).toEqual(ATTESTED_BLOCK);
      expect(integrityGate.evaluate).toHaveBeenCalledWith({
        snapshotDbId: SNAPSHOT_ID,
        targetDeviceId: DEVICE_ID,
        clientIntegrityProtocolVersion: undefined,
        recoveryId: RECOVERY_ID,
      });

      const updateCall = updateMock.mock.results
        .map((r) => r.value.set.mock.calls[0]?.[0])
        .find((s) => s && 'nonceHash' in s);
      expect(updateCall.nonceHash).toBe(hashRecoveryNonce(body.bootstrap.bootstrap.recovery.nonce));
      expect(updateCall.status).toBe('media_booted');
      expect(updateCall.codeUsedAt).toBeInstanceOf(Date);
    });

    it('the exchange bootstrap carries the decided integrity block (override for a confirmed unattested restore)', async () => {
      const code = 'ABCDEFGHJ';
      const block = { v: 1, mode: 'unattested_override', snapshotId: 'snap-ext-1', authorizationId: 'auth-1' };
      integrityGate.evaluate.mockResolvedValueOnce({ ok: true, integrity: block });
      selectMock
        .mockReturnValueOnce(chainMock([{
          id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
          status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
          codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
        }]))
        .mockReturnValueOnce(chainMock([{
          status: 'none', manifestSha256: null, externalCount: null, error: null, jobId: null, storageIdentity: null,
        }]))
        .mockReturnValueOnce(chainMock([{
          id: SNAPSHOT_ID, orgId: ORG_ID, deviceId: DEVICE_ID, jobId: null, configId: null, snapshotId: 'snap-ext-1',
          label: null, location: null, timestamp: new Date(), size: 1, fileCount: 1, metadata: {},
          hardwareProfile: null, systemStateManifest: null, backupType: 'full', isIncremental: false,
          storageIdentity: null,
        }]))
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, hostname: 'rig-01', osType: 'linux', architecture: 'x86_64', displayName: null }]));
      insertMock.mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, restoreType: 'bare_metal', targetConfig: {}, expiresAt: new Date(Date.now() + 86_400_000), authenticatedAt: new Date() }]));
      updateMock.mockReturnValueOnce(chainMock([{ id: RECOVERY_ID, status: 'media_booted' }]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj', integrityProtocolVersion: 2 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bootstrap.integrity).toEqual(block);
      expect(body.bootstrap.bootstrap.integrity).toEqual(block);
      expect(integrityGate.evaluate).toHaveBeenCalledWith(expect.objectContaining({ clientIntegrityProtocolVersion: 2 }));
    });

    it('an integrity refusal is a terminal 409 BEFORE the code is claimed', async () => {
      const code = 'ABCDEFGHJ';
      integrityGate.evaluate.mockResolvedValueOnce({
        ok: false, status: 409, body: { error: 'recovery_client_update_required', message: 'This recovery tool is too old to check backup integrity.' },
      });
      selectMock.mockReturnValueOnce(chainMock([{
        id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
        status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
        codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
      }]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj' }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'recovery_client_update_required',
        message: 'This recovery tool is too old to check backup integrity.',
      });
      expect(insertMock).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it('#5629: helper older than the server floor — 409 helper_version_too_old BEFORE the code is claimed', async () => {
      const code = 'ABCDEFGHJ';
      selectMock.mockReturnValueOnce(chainMock([{
        id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
        status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
        codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
      }]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj', helperVersion: '0.0.1' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('helper_version_too_old');
      expect(body.details).toMatchObject({ helperVersion: '0.0.1', minHelperVersion: BMR_MIN_HELPER_VERSION });
      expect(body.message).toContain(BMR_MIN_HELPER_VERSION);
      // The one-time code must survive: no token minted, no claim UPDATE,
      // and the gate runs before negotiation's snapshot reads.
      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
      expect(selectMock).toHaveBeenCalledTimes(1);
      expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'bmr.recovery.exchange',
        result: 'failure',
        details: expect.objectContaining({ reason: 'helper_version_too_old' }),
      }));
    });

    it('W07: media platform mismatch — 409 media_platform_mismatch BEFORE the code is claimed', async () => {
      const code = 'ABCDEFGHJ';
      selectMock.mockReturnValueOnce(chainMock([{
        id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
        platform: 'linux',
        status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
        codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
      }]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj', mediaPlatform: 'windows' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('media_platform_mismatch');
      expect(body.message).toContain('The recovery code was not used');
      expect(body.details).toMatchObject({ recoveryPlatform: 'linux', mediaPlatform: 'windows' });
      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
      expect(selectMock).toHaveBeenCalledTimes(1);
      expect(writeAuditEventMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'bmr.recovery.exchange',
        result: 'failure',
        details: expect.objectContaining({ reason: 'media_platform_mismatch' }),
      }));
    });

    it('W07: an unknown mediaPlatform value is rejected by the schema (400)', async () => {
      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj', mediaPlatform: 'darwin' }),
      });
      expect(res.status).toBe(400);
      expect(updateMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    });

    it.each([
      ['mediaPlatform omitted (old media)', 'linux', undefined],
      ['rec.platform null (legacy row)', null, 'windows'],
      ['matching platform', 'windows', 'windows'],
    ])('W07: %s — platform gate does not fire', async (_name, recPlatform, mediaPlatform) => {
      const code = 'ABCDEFGHJ';
      // Only the code lookup is mocked; whatever negotiation does afterwards
      // is irrelevant — we assert the platform gate did not refuse.
      selectMock.mockReturnValueOnce(chainMock([{
        id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: null, identity: 'original',
        platform: recPlatform,
        status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
        codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
      }]));
      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj', ...(mediaPlatform ? { mediaPlatform } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      expect(body.error).not.toBe('media_platform_mismatch');
      expect(writeAuditEventMock).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: expect.objectContaining({ reason: 'media_platform_mismatch' }),
      }));
    });

    it('#5629: a "dev" helper build is below any floor and is refused before the claim', async () => {
      const code = 'ABCDEFGHJ';
      selectMock.mockReturnValueOnce(chainMock([{
        id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
        status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
        codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
      }]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj', helperVersion: 'dev' }),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('helper_version_too_old');
      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('#5629: an invalid code still 404s code_invalid even when the helper is too old', async () => {
      selectMock.mockReturnValueOnce(chainMock([]));
      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj', helperVersion: '0.0.1' }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('code_invalid');
    });

    it('exchange R2: referenced snapshot, legacy client — 409, code NOT consumed, no token row inserted', async () => {
      const code = 'ABCDEFGHJ';
      selectMock
        .mockReturnValueOnce(chainMock([{
          id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
          status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
          codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
        }]))
        .mockReturnValueOnce(chainMock([{
          status: 'complete', manifestSha256: 'a'.repeat(64), externalCount: 3, error: null,
          jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storageIdentity: 's3::::my-bucket',
        }]))
        .mockReturnValueOnce(chainMock([{ referencedFiles: 8 }]))
        .mockReturnValueOnce(chainMock([{ originSnapshotId: 'older' }]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj' }),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('client_capability_required');
      expect(insertMock).not.toHaveBeenCalled();
      expect(updateMock.mock.calls.some((c: any[]) => c[0]?.codeUsedAt)).toBe(false);
    });

    it('exchange R3: referenced snapshot, index pending — 409 snapshot_index_pending, enqueues hydration, code not consumed', async () => {
      const code = 'ABCDEFGHJ';
      selectMock
        .mockReturnValueOnce(chainMock([{
          id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
          status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
          codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
        }]))
        .mockReturnValueOnce(chainMock([{
          status: 'none', manifestSha256: null, externalCount: null, error: null,
          jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storageIdentity: 's3::::my-bucket',
        }]))
        .mockReturnValueOnce(chainMock([{ referencedFiles: 8 }]))
        .mockReturnValueOnce(chainMock([{
          id: SNAPSHOT_ID, orgId: ORG_ID, deviceId: DEVICE_ID, jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          configId: null, snapshotId: 'snap-ext-1', label: null, location: null, timestamp: new Date(),
          size: 1, fileCount: 1, metadata: { providerType: 's3', providerConfig: { bucket: 'my-bucket' } },
          hardwareProfile: null, systemStateManifest: null, backupType: 'full', isIncremental: true,
          storageIdentity: 's3::::my-bucket',
        }]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj', capabilities: ['snapshot-file-membership-v1'] }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('snapshot_index_pending');
      expect(body.retryAfterSeconds).toBe(30);
      expect(enqueueSnapshotFileIndexHydrationMock).toHaveBeenCalledWith(SNAPSHOT_ID, 'exchange');
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('exchange R4: complete index + capability — mints token with negotiatedCapabilities persisted, returns fileIndex', async () => {
      const code = 'ABCDEFGHJ';
      selectMock
        .mockReturnValueOnce(chainMock([{
          id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
          status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
          codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
        }]))
        .mockReturnValueOnce(chainMock([{
          status: 'complete', manifestSha256: 'a'.repeat(64), externalCount: 3, error: null,
          jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storageIdentity: 's3::::my-bucket',
        }]))
        .mockReturnValueOnce(chainMock([{ referencedFiles: 8 }]))
        .mockReturnValueOnce(chainMock([{ originSnapshotId: 'older' }]))
        .mockReturnValueOnce(chainMock([{
          id: SNAPSHOT_ID, orgId: ORG_ID, deviceId: DEVICE_ID, jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          configId: null, snapshotId: 'snap-ext-1', label: null, location: null, timestamp: new Date(),
          size: 1, fileCount: 1, metadata: { providerType: 's3', providerConfig: { bucket: 'my-bucket' } },
          hardwareProfile: null, systemStateManifest: null, backupType: 'full', isIncremental: true,
          storageIdentity: 's3::::my-bucket',
        }]))
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, hostname: 'rig-01', osType: 'linux', architecture: 'x86_64', displayName: null }]));
      insertMock.mockReturnValueOnce(chainMock([{
        id: 'token-1', orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, restoreType: 'bare_metal',
        targetConfig: {}, expiresAt: new Date(Date.now() + 86_400_000), authenticatedAt: new Date(),
      }]));
      updateMock.mockReturnValueOnce(chainMock([{ id: RECOVERY_ID, status: 'media_booted' }]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj', capabilities: ['snapshot-file-membership-v1'] }),
      });

      expect(res.status).toBe(200);
      const inserted = insertMock.mock.results.find((r) => r.value?.values)?.value.values.mock.calls[0]?.[0];
      expect(inserted).toMatchObject({ negotiatedCapabilities: ['snapshot-file-membership-v1'] });
      expect((await res.json()).bootstrap.bootstrap.snapshot.fileIndex.status).toBe('complete');
    });

    it('returns 404 code_invalid for unknown, expired and already-used codes alike', async () => {
      const cases = [
        [],
        [{ id: RECOVERY_ID, status: 'created', codeHash: 'h', nonceHash: 'n', codeExpiresAt: new Date(Date.now() - 1000), codeUsedAt: null, orgId: ORG_ID }],
        [{ id: RECOVERY_ID, status: 'created', codeHash: 'h', nonceHash: 'n', codeExpiresAt: new Date(Date.now() + 60_000), codeUsedAt: new Date(), orgId: ORG_ID }],
      ];
      for (const rows of cases) {
        selectMock.mockReset();
        selectMock.mockReturnValueOnce(chainMock(rows));
        const res = await publicApp.request('/backup/bmr/recover/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'ABC-DEF-GHJ' }),
        });
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('code_invalid');
      }
    });

    it('returns 404 code_invalid and mints no lasting token when the conditional claim loses the race', async () => {
      const code = 'ABCDEFGHJ';
      selectMock.mockReturnValueOnce(chainMock([{
        id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
        status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
        codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
      }]));
      insertMock.mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, restoreType: 'bare_metal', targetConfig: {}, expiresAt: new Date(Date.now() + 86_400_000), authenticatedAt: new Date() }]));
      // A concurrent request already claimed the row: the conditional
      // UPDATE's WHERE no longer matches, so it returns zero rows.
      updateMock.mockReturnValueOnce(chainMock([]));

      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'abc-def-ghj' }),
      });

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('code_invalid');
    });

    it('rejects malformed codes with 400 before touching the database', async () => {
      const res = await publicApp.request('/backup/bmr/recover/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'ABC-DEF-GH0' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('code_invalid');
      expect(selectMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /bmr/recover/progress', () => {
    it('returns the rate-limit response before validating the token format, using a per-IP backstop', async () => {
      enforcePublicRateLimitMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }) as never);
      const res = await publicApp.request('/backup/bmr/recover/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'not-even-a-valid-token-format', status: 'restoring' }),
      });
      expect(res.status).toBe(429);
      expect(enforcePublicRateLimitMock).toHaveBeenCalledWith(expect.anything(), 'progress', expect.any(Number));
      expect(selectMock).not.toHaveBeenCalled();
    });

    it('advances forward, stores plan/result/timestamps, and refuses backwards moves', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, status: 'authenticated', expiresAt: new Date(Date.now() + 60_000) }]))
        .mockReturnValueOnce(chainMock([{ id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, identity: 'original', status: 'planned', rebootedAt: null, validatedAt: null }]));

      const res = await publicApp.request('/backup/bmr/recover/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: VALID_RECOVERY_TOKEN, status: 'restoring' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: RECOVERY_ID, status: 'restoring' });
      const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
      expect(set.status).toBe('restoring');
      expect(set.restoringAt).toBeInstanceOf(Date);

      // Now attempt a backwards move.
      selectMock.mockReset();
      selectMock
        .mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, status: 'authenticated', expiresAt: new Date(Date.now() + 60_000) }]))
        .mockReturnValueOnce(chainMock([{ id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, identity: 'original', status: 'restoring', rebootedAt: null, validatedAt: null }]));
      const res2 = await publicApp.request('/backup/bmr/recover/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: VALID_RECOVERY_TOKEN, status: 'planned' }),
      });
      expect(res2.status).toBe(409);
      expect(await res2.json()).toMatchObject({ error: 'invalid_transition', from: 'restoring', to: 'planned' });
    });

    it('validated on a new-identity recovery completes it', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, status: 'authenticated', expiresAt: new Date(Date.now() + 60_000) }]))
        .mockReturnValueOnce(chainMock([{ id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, identity: 'new', status: 'restoring', rebootedAt: null, validatedAt: null }]));
      const res = await publicApp.request('/backup/bmr/recover/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: VALID_RECOVERY_TOKEN, status: 'validated', result: { status: 'completed' } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'completed' });
      const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
      expect(set.status).toBe('completed');
      expect(set.completedAt).toBeInstanceOf(Date);
    });

    it('validated on a new-identity recovery stores the Hyper-V VM outcome with the result (W06d)', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, status: 'authenticated', expiresAt: new Date(Date.now() + 60_000) }]))
        .mockReturnValueOnce(chainMock([{ id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, identity: 'new', status: 'restoring', rebootedAt: null, validatedAt: null }]));
      const res = await publicApp.request('/backup/bmr/recover/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: VALID_RECOVERY_TOKEN,
          status: 'validated',
          result: { status: 'completed', vmCreated: false, vmError: 'New-VM: access denied' },
          warnings: ['hyperv VM creation failed: New-VM: access denied'],
        }),
      });
      expect(res.status).toBe(200);
      const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
      expect(set.status).toBe('completed');
      expect(set.result).toMatchObject({ vmCreated: false, vmError: 'New-VM: access denied' });
      expect(set.warnings).toEqual(['hyperv VM creation failed: New-VM: access denied']);
    });

    it('failed stores the reason and the engine result', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, status: 'authenticated', expiresAt: new Date(Date.now() + 60_000) }]))
        .mockReturnValueOnce(chainMock([{ id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, identity: 'original', status: 'restoring', rebootedAt: null, validatedAt: null }]));
      const res = await publicApp.request('/backup/bmr/recover/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: VALID_RECOVERY_TOKEN, status: 'failed', result: { status: 'failed', error: 'grub-install: no such device' } }),
      });
      expect(res.status).toBe(200);
      const set = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
      expect(set.failureReason).toBe('grub-install: no such device');
    });

    it('progress: a failedFilesSample over 50 entries is rejected by the schema (400), never reaches the handler', async () => {
      const sample = Array.from({ length: 98411 }, (_, i) => `file-${i}.gz`);
      const res = await publicApp.request('/backup/bmr/recover/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: VALID_RECOVERY_TOKEN, status: 'failed', result: { failedFilesSample: sample } }),
      });
      expect(res.status).toBe(400);
    });

    it('progress: a 50-entry failedFilesSample is accepted and the failed status persists', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, status: 'authenticated', expiresAt: new Date(Date.now() + 60_000) }]))
        .mockReturnValueOnce(chainMock([{ id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, identity: 'original', status: 'restoring', rebootedAt: null, validatedAt: null }]));
      const sample = Array.from({ length: 50 }, (_, i) => `file-${i}.gz`);
      const res = await publicApp.request('/backup/bmr/recover/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: VALID_RECOVERY_TOKEN, status: 'failed', result: { failedFilesSample: sample, error: '98,411 files refused' } }),
      });
      expect(res.status).toBe(200);
    });

    it('progress: an oversized result payload (>768KB serialized) is rejected by the schema', async () => {
      const huge = { blob: 'x'.repeat(800 * 1024) };
      const res = await publicApp.request('/backup/bmr/recover/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: VALID_RECOVERY_TOKEN, status: 'restoring', result: huge }),
      });
      expect(res.status).toBe(400);
    });
  });
});
