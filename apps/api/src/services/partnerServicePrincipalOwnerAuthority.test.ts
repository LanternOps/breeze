import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ownerStatus: 'active' as string | null,
  isPlatformAdmin: false,
}));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'from', 'where']) chain[method] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => (state.ownerStatus === null ? [] : [{ status: state.ownerStatus, isPlatformAdmin: state.isPlatformAdmin }]));
  return {
    db: chain,
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../middleware/bearerTokenAuth', () => ({
  resolvePartnerAccess: vi.fn(),
}));

vi.mock('./permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./permissions')>();
  return { ...actual, getUserPermissions: vi.fn() };
});

import { resolvePartnerAccess } from '../middleware/bearerTokenAuth';
import { getUserPermissions, type UserPermissions } from './permissions';
import { authorizePartnerServicePrincipalOwner } from './partnerServicePrincipalOwnerAuthority';

const OWNER = 'owner-1';
const PARTNER = 'partner-1';
const OWNER_REFUSED = { status: 401, message: 'Partner service principal owner is no longer authorized' };

const ALL = [{ resource: '*', action: '*' }];
const READ_ONLY = [
  { resource: 'organizations', action: 'read' },
  { resource: 'tickets', action: 'read' },
];

function partnerPerms(permissions: UserPermissions['permissions'], overrides: Partial<UserPermissions> = {}): UserPermissions {
  return { permissions, partnerId: PARTNER, orgId: null, roleId: 'role-1', scope: 'partner', orgAccess: 'all', ...overrides };
}

function platformPerms(): UserPermissions {
  return { permissions: ALL, partnerId: null, orgId: null, roleId: 'platform', scope: 'system' };
}

/** Partner-axis answer for `{ partnerId }`, platform answer for `{ scope: 'system' }`. */
function owner(opts: { member?: boolean; partner?: UserPermissions | null; platform?: UserPermissions | null }) {
  vi.mocked(resolvePartnerAccess).mockResolvedValue({ isMember: opts.member ?? true, orgIds: ['org-1', 'org-2'] });
  vi.mocked(getUserPermissions).mockImplementation(async (_userId, context) =>
    (context.scope === 'system' ? (opts.platform ?? null) : (opts.partner ?? null)));
}

function authorize(surface: 'partner_api' | 'mcp', scopes: string[]) {
  return authorizePartnerServicePrincipalOwner({ ownerUserId: OWNER, partnerId: PARTNER, surface, scopes });
}

describe('authorizePartnerServicePrincipalOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.ownerStatus = 'active';
    state.isPlatformAdmin = false;
  });

  it('admits a partner-wide owner whose role backs every scope, with the membership\'s org reach', async () => {
    owner({ partner: partnerPerms(ALL) });
    await expect(authorize('partner_api', ['organizations:write', 'tickets:write'])).resolves.toEqual({ orgIds: ['org-1', 'org-2'] });
    await expect(authorize('mcp', ['ai:read', 'ai:write'])).resolves.toEqual({ orgIds: ['org-1', 'org-2'] });
    // Always the live role, never a cached one.
    expect(getUserPermissions).toHaveBeenCalledWith(OWNER, { partnerId: PARTNER }, { bypassCache: true });
  });

  it('refuses when the owner\'s role no longer backs a scope the principal carries, and admits the scopes it still backs', async () => {
    owner({ partner: partnerPerms(READ_ONLY) });
    await expect(authorize('partner_api', ['organizations:read', 'tickets:write'])).rejects.toMatchObject(OWNER_REFUSED);
    await expect(authorize('partner_api', ['organizations:write'])).rejects.toMatchObject(OWNER_REFUSED);
    await expect(authorize('partner_api', ['organizations:read', 'tickets:read'])).resolves.toEqual({ orgIds: ['org-1', 'org-2'] });
  });

  it.each(['selected', 'none'] as const)('refuses an owner whose org access is %s (never narrows)', async (orgAccess) => {
    owner({ partner: partnerPerms(ALL, { orgAccess }) });
    await expect(authorize('partner_api', ['organizations:read'])).rejects.toMatchObject(OWNER_REFUSED);
    await expect(authorize('mcp', ['ai:read'])).rejects.toMatchObject(OWNER_REFUSED);
  });

  it('refuses an owner whose resolved role is not this partner\'s partner role', async () => {
    owner({ partner: partnerPerms(ALL, { scope: 'organization' }) });
    await expect(authorize('partner_api', ['organizations:read'])).rejects.toMatchObject(OWNER_REFUSED);
    owner({ partner: partnerPerms(ALL, { partnerId: 'partner-2' }) });
    await expect(authorize('partner_api', ['organizations:read'])).rejects.toMatchObject(OWNER_REFUSED);
  });

  it.each(['disabled', 'invited', null])('refuses an owner whose account status is %s without reading roles', async (status) => {
    state.ownerStatus = status;
    owner({ partner: partnerPerms(ALL), platform: platformPerms() });
    await expect(authorize('partner_api', ['organizations:read'])).rejects.toMatchObject(OWNER_REFUSED);
    expect(resolvePartnerAccess).not.toHaveBeenCalled();
    expect(getUserPermissions).not.toHaveBeenCalled();
  });

  it('refuses an owner who is not a member and not a platform admin', async () => {
    owner({ member: false, partner: null, platform: null });
    await expect(authorize('partner_api', ['organizations:read'])).rejects.toMatchObject(OWNER_REFUSED);
  });

  it('admits a platform-admin owner on the Partner API only', async () => {
    state.isPlatformAdmin = true;
    owner({ member: false, partner: null, platform: platformPerms() });
    await expect(authorize('partner_api', ['organizations:write', 'tickets:write'])).resolves.toEqual({ orgIds: [] });
    await expect(authorize('mcp', ['ai:read'])).rejects.toMatchObject(OWNER_REFUSED);
  });

  it.each([
    ['a read-only role', partnerPerms(READ_ONLY)],
    ['selected org access', partnerPerms(ALL, { orgAccess: 'selected' })],
  ])('a platform admin who is a partner member is bounded by that membership: refused with %s', async (_label, perms) => {
    state.isPlatformAdmin = true;
    owner({ member: true, partner: perms, platform: platformPerms() });
    await expect(authorize('partner_api', ['organizations:read', 'tickets:write'])).rejects.toMatchObject(OWNER_REFUSED);
  });

  it('never resolves platform permissions for an owner who is not a platform admin', async () => {
    owner({ member: false, partner: null, platform: null });
    await expect(authorize('partner_api', ['organizations:read'])).rejects.toMatchObject(OWNER_REFUSED);
    expect(getUserPermissions).not.toHaveBeenCalledWith(OWNER, { scope: 'system' });
  });

  it('refuses on any lookup error, with the same answer', async () => {
    vi.mocked(resolvePartnerAccess).mockRejectedValue(new Error('connection reset'));
    await expect(authorize('partner_api', ['organizations:read'])).rejects.toMatchObject(OWNER_REFUSED);
    owner({ partner: partnerPerms(ALL) });
    vi.mocked(getUserPermissions).mockRejectedValue(new Error('connection reset'));
    await expect(authorize('mcp', ['ai:read'])).rejects.toMatchObject(OWNER_REFUSED);
  });
});
