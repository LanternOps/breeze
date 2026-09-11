import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, getUserPermissionsMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: { select: selectMock } }));
vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  users: {
    id: 'users.id', partnerId: 'users.partnerId', status: 'users.status',
    isPlatformAdmin: 'users.isPlatformAdmin', authEpoch: 'users.authEpoch', mfaEpoch: 'users.mfaEpoch',
  },
}));
vi.mock('./permissions', () => ({
  getUserPermissions: getUserPermissionsMock,
  canAccessOrg: vi.fn((permissions, orgId) => {
    if (permissions.scope === 'organization') return permissions.orgId === orgId;
    if (permissions.scope === 'partner') {
      if (permissions.orgAccess === 'all') return true;
      if (permissions.orgAccess === 'selected') return permissions.allowedOrgIds?.includes(orgId) ?? false;
      return false;
    }
    return true;
  }),
  hasPermission: vi.fn((permissions) => permissions.permissions.some((permission: { resource: string; action: string }) => (
    permission.resource === 'devices' && permission.action === 'execute'
  ))),
  PERMISSIONS: { DEVICES_EXECUTE: { resource: 'devices', action: 'execute' } },
}));

import type { AuthContext } from '../middleware/auth';
import {
  captureLogReadAuthority,
  correlationResultWithinCurrentDeviceCeiling,
  resolveCurrentLogReadDeviceIds,
  revalidateLogReadAuthority,
} from './logReadAuthority';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SITE_A = '44444444-4444-4444-8444-444444444444';
const SITE_B = '55555555-5555-4555-8555-555555555555';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' }, scope: 'organization', orgId: ORG, partnerId: PARTNER,
    user: { id: USER, email: 'actor@example.test', name: 'Actor', isPlatformAdmin: false },
    token: { aep: 7, mep: 9, mfa: true }, allowedSiteIds: [SITE_B, SITE_A, SITE_A],
    accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG,
    orgCondition: () => undefined,
    ...overrides,
  } as unknown as AuthContext;
}

function chain(rows: unknown[], limited = false) {
  const result = Promise.resolve(rows);
  const builder: Record<string, unknown> = {};
  builder.from = vi.fn(() => builder);
  builder.where = vi.fn(() => limited ? builder : result);
  builder.limit = vi.fn(() => result);
  return builder;
}

describe('log read authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      scope: 'organization', orgId: ORG, partnerId: PARTNER,
      allowedSiteIds: [SITE_A], permissions: [{ resource: 'devices', action: 'execute' }],
    });
  });

  it('binds requester, org, epochs, MFA claim and a normalized site ceiling', () => {
    const envelope = captureLogReadAuthority(auth(), ORG);
    expect(envelope).toMatchObject({
      requesterId: USER, orgId: ORG, authEpoch: 7, mfaEpoch: 9,
      mfaClaim: true, siteIds: [SITE_A, SITE_B],
    });
    expect(envelope.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed for a modified envelope before any database read', async () => {
    const envelope = captureLogReadAuthority(auth(), ORG);
    await expect(revalidateLogReadAuthority({ ...envelope, orgId: 'other' })).resolves.toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('intersects captured and current sites and resolves only current devices', async () => {
    const envelope = captureLogReadAuthority(auth(), ORG);
    selectMock
      .mockReturnValueOnce(chain([{
        id: USER, partnerId: PARTNER, status: 'active', isPlatformAdmin: false,
        authEpoch: 7, mfaEpoch: 9,
      }], true))
      .mockReturnValueOnce(chain([{ id: 'visible-device' }]));
    await expect(revalidateLogReadAuthority(envelope)).resolves.toEqual({
      authority: envelope,
      allowedDeviceIds: ['visible-device'],
      allowedSiteIds: [SITE_A],
    });
    expect(getUserPermissionsMock).toHaveBeenCalledWith(USER, {
      partnerId: PARTNER, orgId: ORG,
    }, { bypassCache: true });
  });

  it.each([
    ['partner-all', auth({
      scope: 'partner', orgId: null, allowedSiteIds: undefined,
      canAccessOrg: () => true,
    })],
    ['platform-system', auth({
      scope: 'system', orgId: null, partnerId: null, allowedSiteIds: undefined,
      user: { id: USER, email: 'platform@example.test', name: 'Platform', isPlatformAdmin: true },
      canAccessOrg: () => true,
    })],
  ])('keeps an unrestricted %s fleet read unrestricted without a synthetic bound org', async (_name, caller) => {
    await expect(resolveCurrentLogReadDeviceIds(caller)).resolves.toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('preserves explicit partner target-org accessibility for selected and denied organizations', async () => {
    const selected = auth({
      scope: 'partner', orgId: null, allowedSiteIds: undefined,
      canAccessOrg: (id: string) => id === ORG,
    });
    await expect(resolveCurrentLogReadDeviceIds(selected, ORG)).resolves.toBeNull();
    await expect(resolveCurrentLogReadDeviceIds(selected, '99999999-9999-4999-8999-999999999999')).resolves.toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('revalidates a partner envelope on the captured partner axis despite a lower org membership', async () => {
    const envelope = captureLogReadAuthority(auth({
      scope: 'partner', orgId: null, allowedSiteIds: undefined,
      canAccessOrg: (id: string) => id === ORG,
    }), ORG);
    selectMock.mockReturnValueOnce(chain([{
      id: USER, partnerId: PARTNER, status: 'active', isPlatformAdmin: false,
      authEpoch: 7, mfaEpoch: 9,
    }], true));
    getUserPermissionsMock.mockResolvedValueOnce({
      scope: 'partner', partnerId: PARTNER, orgAccess: 'selected', allowedOrgIds: [ORG],
      permissions: [{ resource: 'devices', action: 'execute' }],
    });
    await expect(revalidateLogReadAuthority(envelope)).resolves.toEqual({
      authority: envelope, allowedDeviceIds: null, allowedSiteIds: null,
    });
    expect(getUserPermissionsMock).toHaveBeenCalledWith(USER, { partnerId: PARTNER }, { bypassCache: true });

    selectMock.mockReturnValueOnce(chain([{
      id: USER, partnerId: PARTNER, status: 'active', isPlatformAdmin: false,
      authEpoch: 7, mfaEpoch: 9,
    }], true));
    getUserPermissionsMock.mockResolvedValueOnce({
      scope: 'organization', orgId: ORG, partnerId: PARTNER,
      permissions: [{ resource: 'devices', action: 'execute' }],
    });
    await expect(revalidateLogReadAuthority(envelope)).resolves.toBeNull();
  });

  it('revalidates a genuine captured system envelope only for a live platform administrator', async () => {
    const envelope = captureLogReadAuthority(auth({
      scope: 'system', orgId: null, partnerId: null, allowedSiteIds: undefined,
      user: { id: USER, email: 'platform@example.test', name: 'Platform', isPlatformAdmin: true },
      canAccessOrg: () => true,
    }), ORG);
    selectMock.mockReturnValueOnce(chain([{
      id: USER, partnerId: null, status: 'active', isPlatformAdmin: true,
      authEpoch: 7, mfaEpoch: 9,
    }], true));
    await expect(revalidateLogReadAuthority(envelope)).resolves.toEqual({
      authority: envelope, allowedDeviceIds: null, allowedSiteIds: null,
    });
    expect(getUserPermissionsMock).not.toHaveBeenCalled();
  });

  it('rejects inactive, epoch-stale, and execute-revoked requesters', async () => {
    const envelope = captureLogReadAuthority(auth(), ORG);
    selectMock.mockReturnValueOnce(chain([{
      id: USER, partnerId: PARTNER, status: 'disabled', isPlatformAdmin: false,
      authEpoch: 7, mfaEpoch: 9,
    }], true));
    await expect(revalidateLogReadAuthority(envelope)).resolves.toBeNull();

    selectMock.mockReturnValueOnce(chain([{
      id: USER, partnerId: PARTNER, status: 'active', isPlatformAdmin: false,
      authEpoch: 8, mfaEpoch: 9,
    }], true));
    await expect(revalidateLogReadAuthority(envelope)).resolves.toBeNull();

    getUserPermissionsMock.mockResolvedValueOnce({
      scope: 'organization', orgId: ORG, partnerId: PARTNER, permissions: [],
    });
    selectMock.mockReturnValueOnce(chain([{
      id: USER, partnerId: PARTNER, status: 'active', isPlatformAdmin: false,
      authEpoch: 7, mfaEpoch: 9,
    }], true));
    await expect(revalidateLogReadAuthority(envelope)).resolves.toBeNull();
  });

  it('rejects completed results containing any newly hidden device', async () => {
    const result = {
      result: {
        affectedDevices: [{ deviceId: 'visible' }, { deviceId: 'hidden' }],
        sampleLogs: [{ deviceId: 'visible' }],
      },
    };
    selectMock.mockReturnValueOnce(chain([{ id: 'visible' }]));
    await expect(correlationResultWithinCurrentDeviceCeiling(result, ORG, [SITE_A])).resolves.toBe(false);
    selectMock.mockReturnValueOnce(chain([{ id: 'visible' }, { id: 'hidden' }]));
    await expect(correlationResultWithinCurrentDeviceCeiling(result, ORG, null)).resolves.toBe(true);
  });
});
