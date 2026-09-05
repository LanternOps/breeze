import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #3257 W04: PATCH /devices/:id validates a `customFields` payload against
// its definition too, sharing services/customFields/validateValueMap.ts with
// PATCH /devices/:id/custom-fields (customFieldValues.ts). Isolated from
// core.permissions.test.ts's larger gate suite so this wave's tests don't
// collide with unrelated work on that file.

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

// The PATCH handler now runs every `customFields` map through
// validateCustomFieldMap, which calls loadVisibleCustomFieldDefinitions under
// a SYSTEM db context. Mocked at the module boundary (see
// customFieldValues.test.ts for the same pattern).
vi.mock('../../services/customFields/queries', () => ({
  loadVisibleCustomFieldDefinitions: vi.fn(),
}));

import { coreRoutes } from './core';
import { db } from '../../db';
import { loadVisibleCustomFieldDefinitions } from '../../services/customFields/queries';
import type { VisibleCustomFieldDefinition } from '../../services/customFields/queries';

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

function mockVisibleDefinitions(defs: Array<Partial<VisibleCustomFieldDefinition> & { fieldKey: string }>) {
  const full: VisibleCustomFieldDefinition[] = defs.map((d) => ({
    id: d.id ?? `def-${d.fieldKey}`,
    fieldKey: d.fieldKey,
    name: d.name ?? d.fieldKey,
    type: d.type ?? 'text',
    options: d.options ?? null,
    deviceTypes: d.deviceTypes ?? null,
    required: d.required ?? false,
    scriptWrite: d.scriptWrite ?? false,
    orgId: d.orgId ?? ORG_ID,
    partnerId: d.partnerId ?? null,
  }));
  vi.mocked(loadVisibleCustomFieldDefinitions).mockResolvedValue(full);
}

describe('PATCH /devices/:id — custom field value validation (#3257 W04)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  it('rejects an invalid custom field on PATCH /devices/:id and writes nothing', async () => {
    mockVisibleDefinitions([{ fieldKey: 'purchase_date', type: 'date' }]);
    rigDeviceLookup(ACCESSIBLE_DEVICE);
    const updateSpy = rigPlainUpdate(ACCESSIBLE_DEVICE);

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: { purchase_date: 'never' } }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid-custom-field-value');
    expect(body.fields).toEqual([{ fieldKey: 'purchase_date', reason: 'invalid_date' }]);
    expect(updateSpy.set).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown custom field key on PATCH /devices/:id', async () => {
    mockVisibleDefinitions([]);
    rigDeviceLookup(ACCESSIBLE_DEVICE);
    rigPlainUpdate(ACCESSIBLE_DEVICE);

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: { nope: 'x' } }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).fields).toEqual([{ fieldKey: 'nope', reason: 'unknown_field' }]);
  });

  it('accepts a valid custom field value and stores the coerced value on PATCH /devices/:id', async () => {
    mockVisibleDefinitions([{ fieldKey: 'rack_units', type: 'number' }]);
    rigDeviceLookup(ACCESSIBLE_DEVICE);
    let written: Record<string, unknown> | undefined;
    vi.mocked(db.update).mockReturnValue({
      set: (v: Record<string, unknown>) => {
        written = v;
        return { where: () => ({ returning: async () => [{ ...ACCESSIBLE_DEVICE, ...v }] }) };
      },
    } as never);

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: { rack_units: '4' } }),
    });

    expect(res.status).toBe(200);
    expect((written?.customFields as Record<string, unknown> | undefined)?.rack_units).toBe(4);
  });

  it('does not touch definitions or validation when the PATCH has no customFields key', async () => {
    rigDeviceLookup(ACCESSIBLE_DEVICE);
    rigPlainUpdate({ ...ACCESSIBLE_DEVICE, displayName: 'renamed' });

    const res = await app.request(`/devices/${DEVICE_ID}`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'renamed' }),
    });

    expect(res.status).toBe(200);
    expect(loadVisibleCustomFieldDefinitions).not.toHaveBeenCalled();
  });
});
