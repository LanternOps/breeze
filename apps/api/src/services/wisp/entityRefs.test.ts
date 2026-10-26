import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WISP_ENTITY_KINDS, type WispEntityKind } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import type { GrantCeiling } from './grantAuthority';

const loadEntityForPartner = vi.fn();
const getUserPermissions = vi.fn();

vi.mock('./entityLoaders', () => ({ loadEntityForPartner: (...a: unknown[]) => loadEntityForPartner(...a) }));
vi.mock('../permissions', () => ({
  getUserPermissions: (...a: unknown[]) => getUserPermissions(...a),
  hasPermission: (p: { permissions: Array<{ resource: string; action: string }> }, resource: string, action: string) =>
    p.permissions.some((x) => (x.resource === resource || x.resource === '*') && (x.action === action || x.action === '*')),
}));

const { createEntityResolver, ENTITY_READ_PERMISSION, resolveEntityRef } = await import('./entityRefs');

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTITY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SITE = '55555555-5555-4555-8555-555555555555';

function ceiling(over: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: 'g', revisionId: 'r', partnerId: PARTNER, grantorUserId: 'u',
    scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG_A, ORG_B]), siteIds: null,
    permissionKeys: new Set(['*:*']), toolAllowlist: null, deniedTools: new Set(),
    orgTerms: new Map(), status: 'active',
    ...over,
  } as GrantCeiling;
}

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'u', email: 'u@x', name: 'U', isPlatformAdmin: false },
    partnerId: PARTNER, orgId: null, scope: 'partner',
    canAccessOrg: () => true,
    ...over,
  } as unknown as AuthContext;
}

const allPerms = { permissions: [{ resource: '*', action: '*' }] };

function entity(kind: WispEntityKind, orgId: string | null, extra: Record<string, unknown> = {}) {
  return { orgId, orgName: 'Acme', title: `${kind} title`, status: kind === 'site' ? null : 'open', ...extra };
}

beforeEach(() => {
  loadEntityForPartner.mockReset();
  getUserPermissions.mockReset().mockResolvedValue(allPerms);
});

describe('resolveEntityRef', () => {
  it.each(WISP_ENTITY_KINDS.filter((k) => k !== 'user' && k !== 'organization'))(
    '%s: the org comes from the entity, read inside the ceiling partner',
    async (kind) => {
      loadEntityForPartner.mockResolvedValue(entity(kind, ORG_B, kind === 'device' || kind === 'site' ? { siteId: SITE } : {}));
      const out = await resolveEntityRef({ auth: auth(), ceiling: ceiling() }, { kind, id: ENTITY });
      expect(loadEntityForPartner).toHaveBeenCalledWith(kind, ENTITY, PARTNER);
      expect(out).toMatchObject({ ref: { kind, id: ENTITY, orgId: ORG_B }, orgId: ORG_B, label: `${kind} title` });
      expect('href' in out && out.href).toContain(ENTITY);
    },
  );

  it('organization resolves to its own id; user is partner-level (orgId null)', async () => {
    loadEntityForPartner.mockResolvedValueOnce(entity('organization', ORG_A));
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling() }, { kind: 'organization', id: ORG_A }))
      .toMatchObject({ orgId: ORG_A, ref: { orgId: ORG_A } });
    loadEntityForPartner.mockResolvedValueOnce(entity('user', null));
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling() }, { kind: 'user', id: ENTITY }))
      .toMatchObject({ orgId: null, ref: { kind: 'user', orgId: null }, href: `/settings/users#${ENTITY}` });
  });

  it('not_found when the loader finds nothing (missing, deleted, hidden org, other partner)', async () => {
    loadEntityForPartner.mockResolvedValue(null);
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling() }, { kind: 'ticket', id: ENTITY })).toEqual({ reason: 'not_found' });
  });

  it('not_found for a malformed id without touching the database', async () => {
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling() }, { kind: 'ticket', id: "1' OR 1=1" })).toEqual({ reason: 'not_found' });
    expect(loadEntityForPartner).not.toHaveBeenCalled();
  });

  it('forbidden when the caller lacks the kind read permission', async () => {
    loadEntityForPartner.mockResolvedValue(entity('ticket', ORG_A));
    getUserPermissions.mockResolvedValue({ permissions: [{ resource: 'devices', action: 'read' }] });
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling() }, { kind: 'ticket', id: ENTITY })).toEqual({ reason: 'forbidden' });
  });

  it('forbidden when the caller has no permissions at all, or cannot reach the org', async () => {
    loadEntityForPartner.mockResolvedValue(entity('ticket', ORG_A));
    getUserPermissions.mockResolvedValue(null);
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling() }, { kind: 'ticket', id: ENTITY })).toEqual({ reason: 'forbidden' });
    getUserPermissions.mockResolvedValue(allPerms);
    const narrow = auth({ canAccessOrg: (o: string) => o === ORG_B });
    expect(await resolveEntityRef({ auth: narrow, ceiling: ceiling() }, { kind: 'ticket', id: ENTITY })).toEqual({ reason: 'forbidden' });
  });

  it('forbidden for a device-pinned caller: other devices and every non-device kind', async () => {
    const pinned = auth({ allowedDeviceIds: [ENTITY] } as Partial<AuthContext>);
    loadEntityForPartner.mockResolvedValue(entity('device', ORG_A, { siteId: SITE }));
    expect(await resolveEntityRef({ auth: pinned, ceiling: ceiling() }, { kind: 'device', id: ENTITY })).toMatchObject({ orgId: ORG_A });
    expect(await resolveEntityRef({ auth: pinned, ceiling: ceiling() }, { kind: 'device', id: SITE })).toEqual({ reason: 'forbidden' });
    loadEntityForPartner.mockResolvedValue(entity('ticket', ORG_A));
    expect(await resolveEntityRef({ auth: pinned, ceiling: ceiling() }, { kind: 'ticket', id: ENTITY })).toEqual({ reason: 'forbidden' });
  });

  it('forbidden for a site-restricted caller outside the entity site', async () => {
    loadEntityForPartner.mockResolvedValue(entity('device', ORG_A, { siteId: SITE }));
    const a = auth({ scope: 'organization', orgId: ORG_A, canAccessSite: (s: string | null | undefined) => s === 'other' });
    expect(await resolveEntityRef({ auth: a, ceiling: ceiling() }, { kind: 'device', id: ENTITY })).toEqual({ reason: 'forbidden' });
  });

  it('outside_ceiling for an org outside the grant, and a missing ceiling permission', async () => {
    loadEntityForPartner.mockResolvedValue(entity('ticket', ORG_B));
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling({ orgIds: new Set([ORG_A]) }) }, { kind: 'ticket', id: ENTITY }))
      .toEqual({ reason: 'outside_ceiling' });
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling({ permissionKeys: new Set(['devices:read']) }) }, { kind: 'ticket', id: ENTITY }))
      .toEqual({ reason: 'outside_ceiling' });
  });

  it('outside_ceiling for a partner-level entity on an org-scoped or narrowed grant', async () => {
    loadEntityForPartner.mockResolvedValue(entity('user', null));
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling({ scopeOrgId: ORG_A, orgIds: new Set([ORG_A]) }) }, { kind: 'user', id: ENTITY }))
      .toEqual({ reason: 'outside_ceiling' });
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling({ partnerWide: false }) }, { kind: 'user', id: ENTITY }))
      .toEqual({ reason: 'outside_ceiling' });
  });

  it('outside_ceiling for a site-restricted ceiling and an entity without a site axis', async () => {
    loadEntityForPartner.mockResolvedValue(entity('ticket', ORG_A));
    expect(await resolveEntityRef({ auth: auth(), ceiling: ceiling({ siteIds: new Set([SITE]) }) }, { kind: 'ticket', id: ENTITY }))
      .toEqual({ reason: 'outside_ceiling' });
  });

  it('outside_token_scope: an org token on another org, and on a partner-level entity', async () => {
    const orgToken = auth({ scope: 'organization', orgId: ORG_A });
    loadEntityForPartner.mockResolvedValueOnce(entity('ticket', ORG_B));
    expect(await resolveEntityRef({ auth: orgToken, ceiling: ceiling() }, { kind: 'ticket', id: ENTITY })).toEqual({ reason: 'outside_token_scope' });
    loadEntityForPartner.mockResolvedValueOnce(entity('user', null));
    expect(await resolveEntityRef({ auth: orgToken, ceiling: ceiling() }, { kind: 'user', id: ENTITY })).toEqual({ reason: 'outside_token_scope' });
    loadEntityForPartner.mockResolvedValueOnce(entity('ticket', ORG_A));
    expect(await resolveEntityRef({ auth: orgToken, ceiling: ceiling() }, { kind: 'ticket', id: ENTITY })).toMatchObject({ orgId: ORG_A });
  });

  it('caps the label at 200 code points and never returns an empty one', async () => {
    loadEntityForPartner.mockResolvedValueOnce({ ...entity('ticket', ORG_A), title: '😀'.repeat(250) });
    const out = await resolveEntityRef({ auth: auth(), ceiling: ceiling() }, { kind: 'ticket', id: ENTITY });
    expect('label' in out && Array.from(out.label).length).toBe(200);
    loadEntityForPartner.mockResolvedValueOnce({ ...entity('ticket', ORG_A), title: '  \n ' });
    const blank = await resolveEntityRef({ auth: auth(), ceiling: ceiling() }, { kind: 'ticket', id: ENTITY });
    expect('label' in blank && blank.label).toBe('ticket');
  });

  it('a resolver reads the caller permissions once across many refs', async () => {
    loadEntityForPartner.mockResolvedValue(entity('ticket', ORG_A));
    const resolve = createEntityResolver({ auth: auth(), ceiling: ceiling() });
    await resolve({ kind: 'ticket', id: ENTITY });
    await resolve({ kind: 'device', id: ENTITY });
    expect(getUserPermissions).toHaveBeenCalledTimes(1);
  });

  it('without a caller auth (session seed) the live ceiling alone decides', async () => {
    loadEntityForPartner.mockResolvedValue(entity('ticket', ORG_A));
    expect(await resolveEntityRef({ ceiling: ceiling() }, { kind: 'ticket', id: ENTITY })).toMatchObject({ orgId: ORG_A });
    expect(getUserPermissions).not.toHaveBeenCalled();
    expect(await resolveEntityRef({ ceiling: ceiling({ permissionKeys: new Set(['devices:read']) }) }, { kind: 'ticket', id: ENTITY }))
      .toEqual({ reason: 'outside_ceiling' });
  });

  it('every kind names a read permission', () => {
    for (const kind of WISP_ENTITY_KINDS) expect(ENTITY_READ_PERMISSION[kind]).toMatch(/^[a-z_]+:read$/);
  });
});
