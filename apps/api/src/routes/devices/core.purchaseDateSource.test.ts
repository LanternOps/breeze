import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Hardware Lifecycle report (#5701 review fix): PATCH /devices/:id mirrors
// `purchaseDate` into `purchaseDateSource` the same way
// PATCH /devices/manual/:id does (devices_purchase_date_source_chk) — a
// caller-typed date is always source 'manual', and clearing the date clears
// the source too so the CHECK constraint's "both NULL or both set" invariant
// never gets a device-side violation. Isolated from core.permissions.test.ts's
// larger gate suite so this fix's tests don't collide with unrelated work on
// that file — mirrors core.customFieldValidation.test.ts's scaffold.

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

vi.mock('../../services/customFields/queries', () => ({
  loadVisibleCustomFieldDefinitions: vi.fn(),
  persistDeviceCustomFieldValues: vi.fn(),
}));

import { coreRoutes } from './core';
import { db } from '../../db';

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

describe('PATCH /devices/:id — purchaseDate/purchaseDateSource mirror (#5701)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  it('purchaseDate set → purchaseDateSource: "manual"', async () => {
    rigDeviceLookup(ACCESSIBLE_DEVICE);
    const updateSpy = rigPlainUpdate({ ...ACCESSIBLE_DEVICE, purchaseDate: '2024-01-05', purchaseDateSource: 'manual' });

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchaseDate: '2024-01-05' }),
    });

    expect(res.status).toBe(200);
    expect(updateSpy.set).toHaveBeenCalledWith(expect.objectContaining({
      purchaseDate: '2024-01-05',
      purchaseDateSource: 'manual',
    }));
  });

  it('purchaseDate: null → purchaseDateSource: null (devices_purchase_date_source_chk mirror)', async () => {
    rigDeviceLookup({ ...ACCESSIBLE_DEVICE, purchaseDate: '2024-01-05', purchaseDateSource: 'manual' });
    const updateSpy = rigPlainUpdate({ ...ACCESSIBLE_DEVICE, purchaseDate: null, purchaseDateSource: null });

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchaseDate: null }),
    });

    expect(res.status).toBe(200);
    expect(updateSpy.set).toHaveBeenCalledWith(expect.objectContaining({
      purchaseDate: null,
      purchaseDateSource: null,
    }));
  });

  it('does not touch purchaseDateSource when the PATCH has no purchaseDate key', async () => {
    rigDeviceLookup(ACCESSIBLE_DEVICE);
    const updateSpy = rigPlainUpdate({ ...ACCESSIBLE_DEVICE, displayName: 'renamed' });

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'renamed' }),
    });

    expect(res.status).toBe(200);
    expect(updateSpy.set).not.toHaveBeenCalledWith(expect.objectContaining({ purchaseDateSource: expect.anything() }));
  });
});
