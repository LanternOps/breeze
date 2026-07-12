import { beforeEach, describe, expect, it, vi } from 'vitest';

const contextState = vi.hoisted(() => ({
  events: [] as string[],
  dbSelect: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: contextState.dbSelect },
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    contextState.events.push('outside');
    return fn();
  }),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    contextState.events.push('system');
    return fn();
  }),
}));

import {
  resolveEffectiveMfaPolicy,
  validateOrganizationMfaPolicySettingsWrite,
  validatePartnerMfaPolicySettingsWrite,
  MfaPolicyConfigurationError,
  MfaPolicyResolutionError,
} from './mfaPolicy';

type Scope = 'system' | 'partner' | 'organization';

function makeTx(rowQueue: unknown[][]) {
  const whereCalls: unknown[] = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn((condition: unknown) => {
        whereCalls.push(condition);
        const rows = rowQueue.shift() ?? [];
        const result = Promise.resolve(rows) as Promise<unknown[]> & { limit: ReturnType<typeof vi.fn> };
        result.limit = vi.fn(async () => rows);
        return result;
      }),
    })),
  }));
  return { tx: { select } as any, whereCalls, select };
}

const activeUser = {
  id: 'user-1',
  partnerId: 'partner-1',
  orgId: 'org-1',
  status: 'active',
};
const activePartner = {
  id: 'partner-1',
  status: 'active',
  deletedAt: null,
  settings: {},
};
const activeOrg = {
  id: 'org-1',
  partnerId: 'partner-1',
  status: 'active',
  deletedAt: null,
  settings: {},
};
const orgMembership = { userId: 'user-1', orgId: 'org-1', roleId: 'role-1' };
const partnerMembership = { userId: 'user-1', partnerId: 'partner-1', roleId: 'role-1' };
const orgRole = {
  id: 'role-1',
  partnerId: null,
  orgId: 'org-1',
  scope: 'organization',
  forceMfa: false,
};
const partnerRole = {
  id: 'role-1',
  partnerId: 'partner-1',
  orgId: null,
  scope: 'partner',
  forceMfa: false,
};

function organizationRows(overrides: {
  user?: Record<string, unknown> | null;
  partner?: Record<string, unknown> | null;
  org?: Record<string, unknown> | null;
  membership?: Record<string, unknown> | null;
  role?: Record<string, unknown> | null;
} = {}) {
  return [
    overrides.user === null ? [] : [{ ...activeUser, ...overrides.user }],
    overrides.partner === null ? [] : [{ ...activePartner, ...overrides.partner }],
    overrides.org === null ? [] : [{ ...activeOrg, ...overrides.org }],
    overrides.membership === null ? [] : [{ ...orgMembership, ...overrides.membership }],
    overrides.role === null ? [] : [{ ...orgRole, ...overrides.role }],
  ];
}

function partnerRows(overrides: {
  user?: Record<string, unknown> | null;
  partner?: Record<string, unknown> | null;
  membership?: Record<string, unknown> | null;
  role?: Record<string, unknown> | null;
} = {}) {
  return [
    overrides.user === null ? [] : [{ ...activeUser, orgId: null, ...overrides.user }],
    overrides.partner === null ? [] : [{ ...activePartner, ...overrides.partner }],
    overrides.membership === null ? [] : [{ ...partnerMembership, ...overrides.membership }],
    overrides.role === null ? [] : [{ ...partnerRole, ...overrides.role }],
  ];
}

async function resolveOrganization(overrides: Parameters<typeof organizationRows>[0] = {}) {
  const { tx } = makeTx(organizationRows(overrides));
  return resolveEffectiveMfaPolicy({
    userId: 'user-1',
    roleId: 'role-1',
    partnerId: 'partner-1',
    orgId: 'org-1',
    scope: 'organization',
    tx,
  });
}

async function resolvePartner(overrides: Parameters<typeof partnerRows>[0] = {}) {
  const { tx } = makeTx(partnerRows(overrides));
  return resolveEffectiveMfaPolicy({
    userId: 'user-1',
    roleId: 'role-1',
    partnerId: 'partner-1',
    orgId: null,
    scope: 'partner',
    tx,
  });
}

describe('resolveEffectiveMfaPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextState.events.length = 0;
  });

  it.each([
    { label: 'none', role: false, partner: false, org: false, required: false, sources: [] },
    { label: 'role', role: true, partner: false, org: false, required: true, sources: ['role'] },
    { label: 'partner', role: false, partner: true, org: false, required: true, sources: ['partner'] },
    { label: 'organization', role: false, partner: false, org: true, required: true, sources: ['organization'] },
    { label: 'all', role: true, partner: true, org: true, required: true, sources: ['role', 'partner', 'organization'] },
  ])('uses strict OR across the $label requirement sources', async ({ role, partner, org, required, sources }) => {
    const result = await resolveOrganization({
      role: { forceMfa: role },
      partner: { settings: { security: { requireMfa: partner } } },
      org: { settings: { security: { requireMfa: org } } },
    });

    expect(result.required).toBe(required);
    expect(result.sources).toEqual(sources);
  });

  it('does not let an unspecified level restrict an explicit allowlist', async () => {
    const result = await resolveOrganization({
      partner: { settings: {} },
      org: { settings: { security: { allowedMethods: { passkey: true } } } },
    });

    expect(result.allowedMethods).toEqual(new Set(['passkey', 'recovery_code']));
  });

  it('intersects every explicit primary-factor allowlist', async () => {
    const result = await resolveOrganization({
      partner: { settings: { security: { allowedMethods: { totp: true, passkey: true } } } },
      org: { settings: { security: { allowedMethods: { passkey: true, sms: true } } } },
    });

    expect(result.allowedMethods).toEqual(new Set(['passkey', 'recovery_code']));
  });

  it('keeps recovery codes eligible as a recovery credential', async () => {
    const result = await resolveOrganization({
      partner: { settings: { security: { allowedMethods: { totp: true } } } },
      org: { settings: { security: { allowedMethods: { totp: true } } } },
    });

    expect(result.allowedMethods).toContain('recovery_code');
  });

  it('accepts the legacy read alias only when the canonical field is absent', async () => {
    const legacy = await resolveOrganization({
      partner: { settings: { security: { allowedMfaMethods: { sms: true } } } },
      org: { settings: {} },
    });
    expect(legacy.allowedMethods).toEqual(new Set(['sms', 'recovery_code']));

    const canonicalWins = await resolveOrganization({
      partner: {
        settings: {
          security: {
            allowedMethods: { passkey: true },
            allowedMfaMethods: { sms: true },
          },
        },
      },
    });
    expect(canonicalWins.allowedMethods).toEqual(new Set(['passkey', 'recovery_code']));
  });

  it('fails closed on an empty explicit intersection', async () => {
    await expect(resolveOrganization({
      partner: { settings: { security: { allowedMethods: { totp: true } } } },
      org: { settings: { security: { allowedMethods: { sms: true } } } },
    })).rejects.toBeInstanceOf(MfaPolicyResolutionError);
  });

  it('fails closed on a malformed stored requirement instead of treating it as false', async () => {
    await expect(resolveOrganization({
      partner: { settings: { security: { requireMfa: 'yes' } } },
    })).rejects.toBeInstanceOf(MfaPolicyResolutionError);
  });

  it('resolves partner scope without applying an organization level', async () => {
    const result = await resolvePartner({
      partner: {
        settings: {
          security: { requireMfa: true, allowedMethods: { passkey: true } },
        },
      },
    });

    expect(result).toEqual({
      required: true,
      allowedMethods: new Set(['passkey', 'recovery_code']),
      sources: ['partner'],
    });
  });

  it('resolves an active system user without tenant policy levels', async () => {
    const { tx } = makeTx([[{ ...activeUser, isPlatformAdmin: true }]]);

    const result = await resolveEffectiveMfaPolicy({
      userId: 'user-1',
      roleId: null,
      partnerId: null,
      orgId: null,
      scope: 'system',
      tx,
    });

    expect(result).toEqual({
      required: false,
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      sources: [],
    });
  });

  it('rejects system scope when live platform-admin state was removed', async () => {
    const { tx } = makeTx([[{ ...activeUser, isPlatformAdmin: false }]]);

    await expect(resolveEffectiveMfaPolicy({
      userId: 'user-1',
      roleId: null,
      partnerId: null,
      orgId: null,
      scope: 'system',
      tx,
    })).rejects.toBeInstanceOf(MfaPolicyResolutionError);
  });

  it('applies an exact system role requirement and rejects a mismatched role axis', async () => {
    const systemRole = {
      id: 'system-role',
      partnerId: null,
      orgId: null,
      scope: 'system',
      forceMfa: true,
    };
    const { tx } = makeTx([[{ ...activeUser, isPlatformAdmin: true }], [systemRole]]);

    await expect(resolveEffectiveMfaPolicy({
      userId: 'user-1',
      roleId: 'system-role',
      partnerId: null,
      orgId: null,
      scope: 'system',
      tx,
    })).resolves.toMatchObject({ required: true, sources: ['role'] });

    const mismatch = makeTx([
      [{ ...activeUser, isPlatformAdmin: true }],
      [{ ...systemRole, partnerId: 'partner-1' }],
    ]);
    await expect(resolveEffectiveMfaPolicy({
      userId: 'user-1',
      roleId: 'system-role',
      partnerId: null,
      orgId: null,
      scope: 'system',
      tx: mismatch.tx,
    })).rejects.toBeInstanceOf(MfaPolicyResolutionError);
  });

  it.each([
    ['missing user', { user: null }],
    ['inactive user', { user: { status: 'disabled' } }],
    ['missing partner', { partner: null }],
    ['inactive partner', { partner: { status: 'suspended' } }],
    ['missing organization', { org: null }],
    ['inactive organization', { org: { status: 'suspended' } }],
    ['missing membership', { membership: null }],
    ['mismatched membership role', { membership: { roleId: 'role-2' } }],
    ['missing role', { role: null }],
    ['mismatched role scope', { role: { scope: 'partner' } }],
    ['mismatched role organization', { role: { orgId: 'org-2' } }],
  ] as const)('fails closed for organization scope with %s', async (_label, overrides) => {
    await expect(resolveOrganization(overrides as any)).rejects.toBeInstanceOf(MfaPolicyResolutionError);
  });

  it.each([
    ['missing membership', { membership: null }],
    ['mismatched membership partner', { membership: { partnerId: 'partner-2' } }],
    ['mismatched role scope', { role: { scope: 'organization' } }],
    ['mismatched role partner', { role: { partnerId: 'partner-2' } }],
  ] as const)('fails closed for partner scope with %s', async (_label, overrides) => {
    await expect(resolvePartner(overrides as any)).rejects.toBeInstanceOf(MfaPolicyResolutionError);
  });

  it.each([
    { scope: 'partner' as Scope, partnerId: null, orgId: null },
    { scope: 'partner' as Scope, partnerId: 'partner-1', orgId: 'org-1' },
    { scope: 'organization' as Scope, partnerId: 'partner-1', orgId: null },
    { scope: 'system' as Scope, partnerId: 'partner-1', orgId: null },
  ])('rejects invalid $scope scope axes', async ({ scope, partnerId, orgId }) => {
    const { tx } = makeTx([]);
    await expect(resolveEffectiveMfaPolicy({
      userId: 'user-1',
      roleId: scope === 'system' ? null : 'role-1',
      partnerId,
      orgId,
      scope,
      tx,
    })).rejects.toBeInstanceOf(MfaPolicyResolutionError);
    expect(tx.select).not.toHaveBeenCalled();
  });

  it('uses the supplied transaction without opening a system context', async () => {
    await resolvePartner();
    expect(contextState.events).toEqual([]);
  });

  it('escapes any caller context before opening the system read context when tx is absent', async () => {
    const { tx } = makeTx(partnerRows());
    contextState.dbSelect.mockImplementation(tx.select);

    const result = await resolveEffectiveMfaPolicy({
      userId: 'user-1',
      roleId: 'role-1',
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
    });

    expect(result.required).toBe(false);
    expect(contextState.events).toEqual(['outside', 'system']);
  });
});

describe('MFA policy settings writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an organization allowlist with no primary-factor overlap with its partner', async () => {
    const { tx } = makeTx([
      [{ id: 'org-1', partnerId: 'partner-1' }],
      [{ id: 'partner-1', settings: { security: { allowedMethods: { totp: true } } } }],
    ]);

    await expect(validateOrganizationMfaPolicySettingsWrite({
      tx,
      orgId: 'org-1',
      settings: { security: { allowedMethods: { sms: true } } },
    })).rejects.toBeInstanceOf(MfaPolicyConfigurationError);
  });

  it('allows an organization allowlist with at least one partner-approved primary factor', async () => {
    const { tx } = makeTx([
      [{ id: 'org-1', partnerId: 'partner-1' }],
      [{ id: 'partner-1', settings: { security: { allowedMethods: { totp: true, passkey: true } } } }],
    ]);

    await expect(validateOrganizationMfaPolicySettingsWrite({
      tx,
      orgId: 'org-1',
      settings: { security: { allowedMethods: { passkey: true } } },
    })).resolves.toBeUndefined();
  });

  it('rejects a partner allowlist that would conflict with any organization policy', async () => {
    const { tx } = makeTx([[
      { id: 'org-1', settings: { security: { allowedMethods: { totp: true } } } },
      { id: 'org-2', settings: { security: { allowedMethods: { sms: true } } } },
    ]]);

    await expect(validatePartnerMfaPolicySettingsWrite({
      tx,
      partnerId: 'partner-1',
      settings: { security: { allowedMethods: { totp: true } } },
    })).rejects.toBeInstanceOf(MfaPolicyConfigurationError);
  });

  it('does not query counterpart policy when the write does not specify an allowlist', async () => {
    const { tx, select } = makeTx([]);

    await validatePartnerMfaPolicySettingsWrite({
      tx,
      partnerId: 'partner-1',
      settings: { security: { requireMfa: true } },
    });

    expect(select).not.toHaveBeenCalled();
  });
});
