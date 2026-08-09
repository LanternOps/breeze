import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

let permissionsState: any;
let authState: any;

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));

const withDbAccessContextMock = vi.fn(
  async (_ctx: unknown, fn: () => Promise<unknown>) => fn()
);

vi.mock('../../db', () => ({
  db: { select: (...args: unknown[]) => selectMock(...(args as [])) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  withDbAccessContext: (ctx: unknown, fn: () => Promise<unknown>) =>
    withDbAccessContextMock(ctx, fn),
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.org_id', siteId: 'devices.site_id' },
}));

const reconcileMock = vi.fn();
vi.mock('../../services/backupSnapshotReconcile', async () => {
  class BackupReconcileError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
      this.name = 'BackupReconcileError';
    }
  }
  return {
    BackupReconcileError,
    RECONCILE_MAX_LIMIT: 25,
    reconcileOrphanedBackupSnapshots: (...args: unknown[]) => reconcileMock(...(args as [])),
  };
});

const writeRouteAuditMock = vi.fn();
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: (...args: unknown[]) => writeRouteAuditMock(...(args as [])),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    if (permissionsState) c.set('permissions', permissionsState);
    return next();
  }),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireScope: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
  dbAccessContextFromAuth: vi.fn((auth: any) => ({ scope: auth.scope, orgId: auth.orgId })),
  // Composed rather than passthrough: the route is self-managed (#1448) and the
  // point of the assertion below is that each phase DOES open a scoped context.
  withAuthDbAccessContext: vi.fn((auth: any, fn: () => Promise<unknown>) =>
    withDbAccessContextMock({ scope: auth.scope, orgId: auth.orgId }, fn)),
}));

import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
} from '../../middleware/auth';

// The middleware factories run at MODULE IMPORT time, so their arguments have
// to be captured before any beforeEach clears the mocks — otherwise deleting
// requireMfa() from an endpoint that writes to customer buckets fails nothing.
const registeredMfaCalls = vi.mocked(requireMfa).mock.calls.length;
const registeredPermissions = vi.mocked(requirePermission).mock.calls.map((c) => c.join(':'));
const registeredScopes = vi.mocked(requireScope).mock.calls.map((c) => c.join(','));
import { BackupReconcileError } from '../../services/backupSnapshotReconcile';
import { reconcileRoutes } from './reconcile';

function reconcileResult(overrides: Record<string, unknown> = {}) {
  return {
    configId: CONFIG_ID,
    provider: 's3',
    dryRun: false,
    sharedDestination: false,
    snapshotsInStorage: 1,
    adopted: 1,
    remaining: 0,
    skipped: 0,
    skippedByReason: {},
    candidates: [
      {
        snapshotId: 'snap-1',
        matchedBy: 'job-snapshot-id',
        jobId: 'job-1',
        deviceId: 'device-1',
        writtenAt: '2026-08-01T10:20:00.000Z',
        adopted: true,
        fileCount: 2,
        size: 300,
        skipReason: null,
        error: null,
      },
    ],
    ...overrides,
  };
}

describe('POST /backup/reconcile', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]) as any);
    permissionsState = undefined;
    authState = {
      user: { id: SITE_A, email: 'test@example.com', name: 'Test User' },
      scope: 'organization' as const,
      partnerId: null,
      orgId: ORG_ID,
      // authMiddleware always installs this closure (buildOrgAccessClosures);
      // resolveScopedOrgId relies on it to police an explicit ?orgId=.
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      token: { sub: SITE_A },
    };
    reconcileMock.mockReset();
    reconcileMock.mockResolvedValue(reconcileResult());
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', authState);
      if (permissionsState) c.set('permissions', permissionsState);
      return next();
    });
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/backup', reconcileRoutes);
  });

  function post(body: unknown, query = '') {
    return app.request(`/backup/reconcile${query}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('reconciles the caller’s own org destination', async () => {
    const res = await post({ configId: CONFIG_ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: reconcileResult() });
    expect(reconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, configId: CONFIG_ID, allowedDeviceIds: null })
    );
  });

  // Cross-tenant negative: an org-scoped caller must not be able to aim
  // reconcile — which enumerates and writes against a customer bucket — at
  // another tenant by passing ?orgId=. The service is never even reached.
  it('never reconciles under an orgId the caller cannot access', async () => {
    const res = await post({ configId: CONFIG_ID }, `?orgId=${OTHER_ORG_ID}`);

    expect(res.status).toBe(400);
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('honours an explicit orgId the caller CAN access', async () => {
    authState = { ...authState, canAccessOrg: () => true };

    const res = await post({ configId: CONFIG_ID }, `?orgId=${OTHER_ORG_ID}`);

    expect(res.status).toBe(200);
    expect(reconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: OTHER_ORG_ID })
    );
  });

  it('404s a destination that is not the caller’s', async () => {
    reconcileMock.mockRejectedValue(
      new BackupReconcileError('config_not_found', 'Backup destination not found')
    );

    const res = await post({ configId: CONFIG_ID });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Backup destination not found',
      code: 'config_not_found',
    });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('400s an unsupported provider without leaking a stack trace', async () => {
    reconcileMock.mockRejectedValue(
      new BackupReconcileError('provider_unsupported', 'Provider azure_blob is not supported')
    );

    const res = await post({ configId: CONFIG_ID });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('provider_unsupported');
  });

  it('502s an unreadable destination — an upstream failure, not a bad request', async () => {
    // A wrong secret key, a deleted bucket, or a provider 5xx is not the
    // caller's fault, and 400 would make it indistinguishable from
    // provider_unsupported for clients and monitoring alike.
    reconcileMock.mockRejectedValue(
      new BackupReconcileError('destination_unreadable', 'Could not list the backup destination: AccessDenied')
    );

    const res = await post({ configId: CONFIG_ID });

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('destination_unreadable');
  });

  it('is gated by MFA, backup:write and an org/partner/system scope', async () => {
    // Captured at import time — see the note by the constants.
    expect(registeredMfaCalls).toBeGreaterThan(0);
    expect(registeredPermissions).toContain('backup:write');
    expect(registeredScopes).toContain('organization,partner,system');
  });

  it('runs its DB work in short self-managed contexts, not one held transaction', async () => {
    // The route opts out of the auto request-transaction (#1448) because it
    // pages a whole bucket listing and fetches multi-MB manifests from a
    // tenant-controlled host; pinning a pooled connection across that is the
    // #1105 pool-poison class.
    await post({ configId: CONFIG_ID });

    expect(withDbAccessContextMock).toHaveBeenCalled();
    expect(typeof reconcileMock.mock.calls[0]![0].runInDbContext).toBe('function');
  });

  it('passes the site-allowed device ids for a site-restricted caller', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    selectMock.mockReturnValueOnce(
      chainMock([
        { id: 'device-in', siteId: SITE_A },
        { id: 'device-out', siteId: SITE_B },
      ]) as any
    );

    await post({ configId: CONFIG_ID });

    expect(reconcileMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDeviceIds: ['device-in'] })
    );
  });

  it('records an audit event naming the adopted snapshots', async () => {
    await post({ configId: CONFIG_ID });

    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    const event = writeRouteAuditMock.mock.calls[0]![1];
    expect(event).toMatchObject({
      orgId: ORG_ID,
      action: 'backup.reconcile.adopt',
      resourceType: 'backup_config',
      resourceId: CONFIG_ID,
    });
    expect(event.details.adoptedSnapshotIds).toEqual(['snap-1']);
  });

  it('audits why nothing was adopted, not just that nothing was', async () => {
    // Without the per-reason breakdown, a run that recovered nothing from 50
    // stranded snapshots leaves a trail indistinguishable from a run against a
    // healthy destination.
    reconcileMock.mockResolvedValue(
      reconcileResult({
        adopted: 0,
        skipped: 50,
        skippedByReason: { 'shared-destination-ambiguous': 50 },
        candidates: [],
      })
    );

    await post({ configId: CONFIG_ID });

    const details = writeRouteAuditMock.mock.calls[0]![1].details;
    expect(details.skipped).toBe(50);
    expect(details.skippedByReason).toEqual({ 'shared-destination-ambiguous': 50 });
  });

  it('audits a dry run under its own action', async () => {
    reconcileMock.mockResolvedValue(reconcileResult({ dryRun: true, adopted: 0 }));

    await post({ configId: CONFIG_ID, dryRun: true });

    expect(writeRouteAuditMock.mock.calls[0]![1].action).toBe('backup.reconcile.preview');
  });

  it('rejects a non-uuid configId and an out-of-range limit', async () => {
    expect((await post({ configId: 'not-a-uuid' })).status).toBe(400);
    expect((await post({ configId: CONFIG_ID, limit: 500 })).status).toBe(400);
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('400s when a partner-scoped caller supplies no resolvable org', async () => {
    authState = { ...authState, scope: 'partner', orgId: null, accessibleOrgIds: [] };

    const res = await post({ configId: CONFIG_ID });

    expect(res.status).toBe(400);
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
