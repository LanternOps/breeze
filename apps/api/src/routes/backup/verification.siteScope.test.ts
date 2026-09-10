import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const state = vi.hoisted(() => ({ allowedSiteIds: undefined as string[] | undefined }));
const listBackupVerificationsMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>[]>>(async () => []));
const listRecoveryReadinessMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>[]>>(async () => []));
const getBackupHealthSummaryMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
  verification: { total: 0, passedLast24h: 0, failedLast24h: 0, partialLast24h: 0, coveragePercent: 100 },
  readiness: { averageScore: 0, lowReadinessCount: 0, criticalDevicesAtRisk: 0 },
  escalations: { verificationFailures: 0, criticalVerificationFailures: 0 },
})));
const recalculateReadinessScoresMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0));

vi.mock('../../middleware/auth', () => ({
  requirePermission: vi.fn(() => (c: any, next: any) => {
    c.set('auth', { orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scope: 'organization', user: { id: 'user-1' } });
    c.set('permissions', { allowedSiteIds: state.allowedSiteIds });
    return next();
  }),
  requireScope: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  canAccessSite: vi.fn(() => true),
}));

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('./helpers', () => ({
  resolveScopedOrgId: (auth: { orgId?: string }) => auth.orgId,
  toDateOrNull: () => null,
}));
vi.mock('./verificationService', () => ({
  BACKUP_HIGH_READINESS_THRESHOLD: 85,
  BACKUP_LOW_READINESS_THRESHOLD: 60,
  BackupVerificationDispatchError: class BackupVerificationDispatchError extends Error {},
  getBackupHealthSummary: (...args: unknown[]) => getBackupHealthSummaryMock(...args),
  listBackupVerifications: (...args: unknown[]) => listBackupVerificationsMock(...args),
  listRecoveryReadiness: (...args: unknown[]) => listRecoveryReadinessMock(...args),
  recalculateReadinessScores: (...args: unknown[]) => recalculateReadinessScoresMock(...args),
  runBackupVerification: vi.fn(),
  toVerificationListItem: (row: { details?: Record<string, unknown> | null }) => ({
    ...row,
    details: row.details?.simulated === true ? { simulated: true } : null,
  }),
}));

import { backupVerificationRoutes } from './verification';

describe('backup verification read site scope', () => {
  const app = new Hono().route('/backup', backupVerificationRoutes);

  beforeEach(() => {
    vi.clearAllMocks();
    state.allowedSiteIds = undefined;
  });

  it('propagates a selected-site ceiling through lists, aggregates, and refresh', async () => {
    state.allowedSiteIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];

    expect((await app.request('/backup/verifications')).status).toBe(200);
    expect((await app.request('/backup/recovery-readiness?refresh=true')).status).toBe(200);
    expect((await app.request('/backup/health?refresh=true')).status).toBe(200);

    expect(listBackupVerificationsMock).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expect.objectContaining({ allowedSiteIds: state.allowedSiteIds }),
    );
    expect(listRecoveryReadinessMock).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      state.allowedSiteIds,
    );
    expect(getBackupHealthSummaryMock).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      state.allowedSiteIds,
    );
    expect(recalculateReadinessScoresMock).toHaveBeenCalledTimes(2);
    expect(recalculateReadinessScoresMock).toHaveBeenNthCalledWith(
      1,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      state.allowedSiteIds,
    );
  });

  it('returns zero-safe shapes for an empty ceiling without service or DB work', async () => {
    state.allowedSiteIds = [];

    const list = await (await app.request('/backup/verifications')).json();
    const readiness = await (await app.request('/backup/recovery-readiness?refresh=true')).json();
    const health = await (await app.request('/backup/health?refresh=true')).json();

    expect(list.data).toEqual([]);
    expect(readiness.data).toEqual({
      summary: { devices: 0, averageScore: 0, lowReadiness: 0, highReadiness: 0 },
      devices: [],
    });
    expect(health.data.verification.total).toBe(0);
    expect(getBackupHealthSummaryMock).not.toHaveBeenCalled();
    expect(listBackupVerificationsMock).not.toHaveBeenCalled();
    expect(listRecoveryReadinessMock).not.toHaveBeenCalled();
    expect(recalculateReadinessScoresMock).not.toHaveBeenCalled();
  });

  it('preserves unrestricted behavior with an undefined ceiling', async () => {
    await app.request('/backup/verifications');
    await app.request('/backup/recovery-readiness');
    await app.request('/backup/health');

    expect(listBackupVerificationsMock).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      expect.objectContaining({ allowedSiteIds: undefined }),
    );
    expect(listRecoveryReadinessMock).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      undefined,
    );
    expect(getBackupHealthSummaryMock).toHaveBeenCalledWith(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      undefined,
    );
  });

  it('projects verification details to the shipped simulated marker only', async () => {
    listBackupVerificationsMock.mockResolvedValueOnce([
      {
        id: 'verification-1',
        details: {
          simulated: true,
          restorePath: '/private/customer/restore',
          failedFiles: ['/private/customer/secret.txt'],
          commandId: 'command-internal',
          stdout: 'agent-controlled output',
        },
      },
      {
        id: 'verification-2',
        details: {
          simulated: false,
          restorePath: '/private/customer/other',
          commandId: 'other-command',
        },
      },
    ]);

    const response = await app.request('/backup/verifications');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      { id: 'verification-1', details: { simulated: true } },
      { id: 'verification-2', details: null },
    ]);
    expect(JSON.stringify(body)).not.toContain('restorePath');
    expect(JSON.stringify(body)).not.toContain('failedFiles');
    expect(JSON.stringify(body)).not.toContain('command-internal');
    expect(JSON.stringify(body)).not.toContain('agent-controlled output');
  });
});
