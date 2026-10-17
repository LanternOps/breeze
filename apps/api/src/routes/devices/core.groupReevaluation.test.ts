import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #8832: PATCH /devices/:id writes fields that dynamic-group rules key on
// (tags, displayName, deviceRole, site), and dynamic groups STORE membership —
// so unless the PATCH asks for a re-evaluation the group goes stale until
// someone re-saves it. Custom-field values are requested by
// persistDeviceCustomFieldValues itself (queries.test.ts), not here.
// Scaffold mirrors core.purchaseDateSource.test.ts.

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      canAccessOrg: (orgId: string) => orgId === 'org-123',
      orgCondition: () => undefined,
      token: { mfa: false },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource, action }],
      partnerId: null,
      orgId: 'org-123',
      roleId: 'role-123',
      scope: 'organization',
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job-id'),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }),
}));

vi.mock('../../services/remoteAccessLauncher', () => ({
  resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }),
}));

vi.mock('../agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SELF_UNINSTALL: 'self_uninstall' },
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null),
}));

vi.mock('../../jobs/deviceGroupJobs', () => ({
  requestDeviceGroupReevaluationAfterCommit: vi.fn(),
}));

vi.mock('../../services/customFields/queries', () => ({
  loadVisibleCustomFieldDefinitions: vi.fn(),
  persistDeviceCustomFieldValues: vi.fn(),
}));

import { coreRoutes } from './core';
import { db } from '../../db';
import { requestDeviceGroupReevaluationAfterCommit } from '../../jobs/deviceGroupJobs';

const ORG_ID = 'org-123';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

const ACCESSIBLE_DEVICE: Record<string, unknown> = {
  id: DEVICE_ID,
  orgId: ORG_ID,
  siteId: 'site-1',
  hostname: 'host-1',
  status: 'online' as const,
  customFields: null,
  managementPosture: null,
  purchaseDate: null,
  purchaseDateSource: null,
};

function rigDeviceLookup(device: unknown) {
  const limit = vi.fn().mockResolvedValue(device ? [device] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

function rigPlainUpdate(updatedRow: unknown) {
  const returning = vi.fn().mockResolvedValue([updatedRow]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set };
}

describe('PATCH /devices/:id → dynamic group re-evaluation (#8832)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  async function patch(body: Record<string, unknown>) {
    return app.request(`/devices/${DEVICE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('a tag edit requests a re-evaluation on the tags field', async () => {
    rigDeviceLookup(ACCESSIBLE_DEVICE);
    rigPlainUpdate({ ...ACCESSIBLE_DEVICE, tags: ['retired'] });

    const res = await patch({ tags: ['retired'] });

    expect(res.status).toBe(200);
    expect(requestDeviceGroupReevaluationAfterCommit).toHaveBeenCalledTimes(1);
    expect(requestDeviceGroupReevaluationAfterCommit).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      eventType: 'device.updated',
      changedFields: ['tags'],
      reason: 'device_patch',
    });
  });

  it('clearing every tag still requests a re-evaluation (a device can LEAVE a tag group)', async () => {
    rigDeviceLookup({ ...ACCESSIBLE_DEVICE, tags: ['retired'] });
    rigPlainUpdate({ ...ACCESSIBLE_DEVICE, tags: [] });

    const res = await patch({ tags: [] });

    expect(res.status).toBe(200);
    expect(requestDeviceGroupReevaluationAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ changedFields: ['tags'] }),
    );
  });

  it('displayName and deviceRole edits request those filter fields', async () => {
    rigDeviceLookup(ACCESSIBLE_DEVICE);
    rigPlainUpdate({ ...ACCESSIBLE_DEVICE, displayName: 'renamed', deviceRole: 'server' });

    const res = await patch({ displayName: 'renamed', deviceRole: 'server' });

    expect(res.status).toBe(200);
    const request = vi.mocked(requestDeviceGroupReevaluationAfterCommit).mock.calls[0]?.[0];
    expect(request?.changedFields?.slice().sort()).toEqual(['deviceRole', 'displayName']);
  });

  it('a PATCH that touches no filter field requests nothing', async () => {
    rigDeviceLookup(ACCESSIBLE_DEVICE);
    rigPlainUpdate({ ...ACCESSIBLE_DEVICE, purchaseDate: '2024-01-05', purchaseDateSource: 'manual' });

    const res = await patch({ purchaseDate: '2024-01-05' });

    expect(res.status).toBe(200);
    expect(requestDeviceGroupReevaluationAfterCommit).not.toHaveBeenCalled();
  });

  it('echoing the current site is not a site change and does not request siteId', async () => {
    const SITE_ID = '22222222-2222-4222-8222-222222222222';
    rigDeviceLookup({ ...ACCESSIBLE_DEVICE, siteId: SITE_ID });
    rigPlainUpdate({ ...ACCESSIBLE_DEVICE, siteId: SITE_ID, tags: ['x'] });

    const res = await patch({ siteId: SITE_ID, tags: ['x'] });

    expect(res.status).toBe(200);
    expect(requestDeviceGroupReevaluationAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ changedFields: ['tags'] }),
    );
  });
});
