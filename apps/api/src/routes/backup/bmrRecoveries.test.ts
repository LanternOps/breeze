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
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'orderBy', 'offset']) {
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
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    jobId: 'backup_snapshots.job_id',
    configId: 'backup_snapshots.config_id',
    snapshotId: 'backup_snapshots.snapshot_id',
    bareMetalRestorable: 'backup_snapshots.bare_metal_restorable',
    bareMetalReasons: 'backup_snapshots.bare_metal_reasons',
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
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => (c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
}));

const writeRouteAuditMock = vi.fn();
const writeAuditEventMock = vi.fn();
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
  writeAuditEvent: (...args: unknown[]) => writeAuditEventMock(...(args as [])),
}));

const authorizeResilienceResourcesMock = vi.fn(async () => ({ ok: true, authorization: { resources: [] } }));
vi.mock('./resilienceAuthorization', () => ({
  authorizeRouteResilienceResources: (...args: unknown[]) => authorizeResilienceResourcesMock(...(args as [])),
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
}));

vi.mock('../../services/recoveryBootstrap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/recoveryBootstrap')>();
  return { ...actual };
});

import { bmrRecoveryRoutes, bmrRecoveryPublicRoutes } from './bmrRecoveries';

describe('bare-metal recoveries routes', () => {
  let app: Hono;
  let publicApp: Hono;

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
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      partnerId: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
    };
    authorizeResilienceResourcesMock.mockResolvedValue({ ok: true, authorization: { resources: [] } });
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
      const inserted = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
      expect(inserted.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(inserted.nonceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(inserted).not.toHaveProperty('nonce');
      expect(writeRouteAuditMock).toHaveBeenCalled();
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

  describe('POST /bmr/recover/exchange', () => {
    it('exchanges a valid code once: mints a token, marks media_booted, returns bootstrap with nonce', async () => {
      const code = 'ABCDEFGHJ';
      selectMock
        .mockReturnValueOnce(chainMock([{
          id: RECOVERY_ID, orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, identity: 'original',
          status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000),
          codeUsedAt: null, nonceHash: 'x'.repeat(64), createdBy: 'user-123',
        }]))
        .mockReturnValueOnce(chainMock([{
          id: SNAPSHOT_ID, orgId: ORG_ID, deviceId: DEVICE_ID, jobId: null, configId: null, snapshotId: 'snap-ext-1',
          label: null, location: null, timestamp: new Date(), size: 1, fileCount: 1, metadata: {},
          hardwareProfile: null, systemStateManifest: null, backupType: 'full', isIncremental: false,
        }]))
        .mockReturnValueOnce(chainMock([{ id: DEVICE_ID, hostname: 'rig-01', osType: 'linux', architecture: 'x86_64', displayName: null }]));
      insertMock.mockReturnValueOnce(chainMock([{ id: 'token-1', orgId: ORG_ID, deviceId: DEVICE_ID, snapshotId: SNAPSHOT_ID, restoreType: 'bare_metal', targetConfig: {}, expiresAt: new Date(Date.now() + 86_400_000), authenticatedAt: new Date() }]));

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

      const updateCall = updateMock.mock.results
        .map((r) => r.value.set.mock.calls[0]?.[0])
        .find((s) => s && 'nonceHash' in s);
      expect(updateCall.nonceHash).toBe(hashRecoveryNonce(body.bootstrap.bootstrap.recovery.nonce));
      expect(updateCall.status).toBe('media_booted');
      expect(updateCall.codeUsedAt).toBeInstanceOf(Date);
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
  });
});
