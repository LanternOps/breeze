import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  resolveGrantCeiling: vi.fn(),
  seedContextForSession: vi.fn(),
  selectRows: [] as unknown[],
  selectError: null as Error | null,
  captureException: vi.fn(),
}));

vi.mock('../sentry', () => ({ captureException: shared.captureException }));

vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where']) chain[m] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => {
    if (shared.selectError) throw shared.selectError;
    return shared.selectRows;
  });
  return {
    db: { select: vi.fn(() => chain) },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    getCurrentDbAccessContext: vi.fn(() => undefined),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('./grantAuthority', async (orig) => ({
  ...(await orig<typeof import('./grantAuthority')>()),
  resolveGrantCeiling: shared.resolveGrantCeiling,
  inSystemContext: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('./threads', () => ({ seedContextForSession: shared.seedContextForSession }));

import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { CeilingViolationError, GrantInactiveError, type GrantCeiling } from './grantAuthority';
import {
  WISP_REFUSAL_MESSAGES,
  WispSessionUnavailableError,
  enforceWispCeiling,
  lookupWispGrant,
  narrowAuthToCeiling,
  requiredPermissionKeys,
  targetOrgIdFor,
  unreachableWispAuth,
  wispSeedForSession,
} from './chatCeiling';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const ORG_C = '00000000-0000-4000-8000-00000000000c';

const ceiling = (o: Partial<GrantCeiling> = {}): GrantCeiling => ({
  grantId: 'g-1', revisionId: 'r-1', partnerId: 'p-1', grantorUserId: 'u-1', scopeOrgId: null, partnerWide: true,
  status: 'active', orgIds: new Set([ORG_A, ORG_B]), siteIds: null,
  permissionKeys: new Set(['devices:read', 'alerts:write', 'alerts:read']),
  toolAllowlist: null, deniedTools: new Set(), orgTerms: new Map(), ...o,
});

function auth(o: Partial<AuthContext> = {}): AuthContext {
  const accessibleOrgIds = o.accessibleOrgIds === undefined ? [ORG_A, ORG_B, ORG_C] : o.accessibleOrgIds;
  return {
    user: { id: 'u-1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
    token: null,
    partnerId: 'p-1',
    orgId: null,
    scope: 'partner',
    partnerOrgAccess: 'all',
    ...o,
    accessibleOrgIds,
    ...buildOrgAccessClosures(accessibleOrgIds),
  } as AuthContext;
}

const grant = { grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' };

function enforce(toolName: string, input: Record<string, unknown>, toolAuth = auth()) {
  return enforceWispCeiling({ grant, toolName, input, sessionOrgId: ORG_A, sessionId: 's-1', toolAuth });
}

beforeEach(() => {
  vi.clearAllMocks();
  shared.resolveGrantCeiling.mockResolvedValue(ceiling());
  shared.selectRows = [];
  shared.selectError = null;
});

describe('enforceWispCeiling', () => {
  it('refuses with wisp_grant_inactive when resolveGrantCeiling throws GrantInactiveError', async () => {
    shared.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g-1', 'revoked'));
    await expect(enforce('get_device_details', { deviceId: 'd' })).resolves.toEqual({
      ok: false,
      refusal: { code: 'wisp_grant_inactive', detail: 'inactive', message: WISP_REFUSAL_MESSAGES.inactive },
    });
  });

  it('a corrupt pin or any other ceiling read failure propagates (the caller fails closed)', async () => {
    shared.resolveGrantCeiling.mockRejectedValueOnce(new GrantInactiveError('g-1', 'active', 'bad snapshot', 'corrupt'));
    await expect(enforce('get_device_details', {})).rejects.toBeInstanceOf(GrantInactiveError);
    shared.resolveGrantCeiling.mockRejectedValueOnce(new Error('connection refused'));
    await expect(enforce('get_device_details', {})).rejects.toThrow('connection refused');
  });

  it('refuses a Tier-1 tool whose orgId input is outside ceiling.orgIds with detail "org"', async () => {
    await expect(enforce('get_device_details', { orgId: ORG_C })).resolves.toMatchObject({
      ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'org', message: WISP_REFUSAL_MESSAGES.org },
    });
  });

  it('refuses when a required permission key is missing with detail "permission"', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set() }));
    await expect(enforce('get_device_details', { deviceId: 'd' })).resolves.toMatchObject({
      ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'permission' },
    });
  });

  it('binds the permission check to the target org: a narrower org-level membership term refuses there and only there', async () => {
    // The grantor's organization_users role in org A lacks devices:read.
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({
      orgTerms: new Map([[ORG_A, { permissionKeys: new Set(['alerts:read']), siteIds: null }]]),
    }));
    await expect(enforce('get_device_details', { orgId: ORG_A })).resolves.toMatchObject({
      ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'permission' },
    });
    // The session org is org A, so a call naming no org is refused too.
    await expect(enforce('get_device_details', { deviceId: 'd' })).resolves.toMatchObject({
      ok: false, refusal: { detail: 'permission' },
    });
    // Org B has no membership term: allowed, and org A is out of this call's reach
    // (a device in org A cannot be reached through org B's call).
    const ok = await enforce('get_device_details', { orgId: ORG_B });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.toolAuth.accessibleOrgIds).toEqual([ORG_B]);
    expect(ok.toolAuth.canAccessOrg(ORG_A)).toBe(false);
    // A call org A's term DOES cover still runs in org A.
    const alerts = await enforce('manage_alerts', { action: 'list', orgId: ORG_A });
    expect(alerts.ok && alerts.toolAuth.accessibleOrgIds).toEqual([ORG_A, ORG_B]);
  });

  it('a site-restricted ceiling refuses with detail "site" (a chat call carries no verified site)', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ siteIds: new Set(['site-1']) }));
    await expect(enforce('get_device_details', { siteId: 'site-1' })).resolves.toMatchObject({
      ok: false, refusal: { detail: 'site', message: WISP_REFUSAL_MESSAGES.site },
    });
  });

  it('a tool with no RBAC mapping, or an unknown action, fails closed as a permission refusal', async () => {
    await expect(enforce('no_such_tool', {})).resolves.toMatchObject({ ok: false, refusal: { detail: 'permission' } });
    await expect(enforce('manage_alerts', { action: 'explode' })).resolves.toMatchObject({
      ok: false, refusal: { detail: 'permission', message: expect.stringContaining('Unknown action') },
    });
  });

  it('a never-delegable or non-allowlisted tool is refused with detail "tool"', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ toolAllowlist: new Set(['manage_alerts']) }));
    await expect(enforce('get_device_details', {})).resolves.toMatchObject({ ok: false, refusal: { detail: 'tool' } });
  });

  it('refuses a system-scope or other-partner sign-in', async () => {
    await expect(enforce('get_device_details', {}, auth({ scope: 'system', accessibleOrgIds: null }))).resolves.toMatchObject({
      ok: false, refusal: { detail: 'org' },
    });
    await expect(enforce('get_device_details', {}, auth({ partnerId: 'p-2' }))).resolves.toMatchObject({
      ok: false, refusal: { detail: 'org' },
    });
  });

  it('refuses a target the caller cannot reach even though it is inside the ceiling', async () => {
    await expect(enforce('get_device_details', { orgId: ORG_B }, auth({ accessibleOrgIds: [ORG_A] }))).resolves.toMatchObject({
      ok: false, refusal: { detail: 'org' },
    });
  });

  it('uses the supplied permission requirement for a tenant tool', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['devices:read']) }));
    await expect(enforceWispCeiling({
      grant, toolName: 'mcp__tenant__x', input: {}, sessionOrgId: ORG_A, sessionId: 's-1', toolAuth: auth(),
      permissionRequirement: { resource: 'devices', action: 'execute' },
    })).resolves.toMatchObject({ ok: false, refusal: { detail: 'permission' } });
  });

  it('an ORG-token sign-in under a partner-wide [A,B] ceiling reaches only its own org, never partner breadth', async () => {
    const orgToken = auth({
      scope: 'organization', partnerId: null, orgId: ORG_A, accessibleOrgIds: [ORG_A], partnerOrgAccess: null,
    });
    const r = await enforce('get_device_details', { deviceId: 'd' }, orgToken);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.toolAuth.accessibleOrgIds).toEqual([ORG_A]);
    expect(r.toolAuth.canAccessOrg(ORG_A)).toBe(true);
    expect(r.toolAuth.canAccessOrg(ORG_B)).toBe(false);
    expect(r.toolAuth.partnerOrgAccess).not.toBe('all');

    await expect(enforce('get_device_details', { orgId: ORG_B }, orgToken)).resolves.toMatchObject({
      ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'org' },
    });
  });

  it('on success returns the narrowed per-call auth, the ceiling and the permission keys', async () => {
    const r = await enforce('get_device_details', { deviceId: 'd' });
    expect(r).toMatchObject({ ok: true, permissionKeys: ['devices:read'] });
    if (!r.ok) return;
    expect(r.toolAuth.accessibleOrgIds).toEqual([ORG_A, ORG_B]);
    expect(r.toolAuth.wispGrant).toEqual({ grantId: 'g-1', grantRevisionId: 'r-1', sessionId: 's-1' });
  });
});

describe('narrowAuthToCeiling', () => {
  it('narrows toolAuth.accessibleOrgIds to the ceiling, rebuilds closures, and stamps wispGrant', () => {
    const c = ceiling({ orgIds: new Set([ORG_B]) });
    const out = narrowAuthToCeiling(auth({ accessibleOrgIds: [ORG_A, ORG_B, ORG_C] }), c, undefined, []);
    expect(out.accessibleOrgIds).toEqual([ORG_B]);
    expect(out.canAccessOrg(ORG_C)).toBe(false);
    expect(out.canAccessOrg(ORG_B)).toBe(true);
    expect(out.wispGrant).toEqual({ grantId: c.grantId, grantRevisionId: c.revisionId, sessionId: null });
  });

  it('stamps wispGrant.sessionId when a session id is passed (w00 A23)', () => {
    expect(narrowAuthToCeiling(auth(), ceiling(), 's-1', []).wispGrant?.sessionId).toBe('s-1');
  });

  it('a null accessibleOrgIds (unrestricted) becomes exactly the ceiling orgs', () => {
    expect(narrowAuthToCeiling(auth({ accessibleOrgIds: null }), ceiling(), undefined, []).accessibleOrgIds).toEqual([ORG_A, ORG_B]);
  });

  it('keeps partner breadth only for a partner-wide ceiling it reaches whole; otherwise downgrades to selected', () => {
    expect(narrowAuthToCeiling(auth(), ceiling(), undefined, []).partnerOrgAccess).toBe('all');
    expect(narrowAuthToCeiling(auth(), ceiling({ partnerWide: false, scopeOrgId: ORG_A, orgIds: new Set([ORG_A]) }), undefined, []).partnerOrgAccess).toBe('selected');
    const termNarrowed = ceiling({ orgTerms: new Map([[ORG_B, { permissionKeys: new Set(), siteIds: null }]]) });
    expect(narrowAuthToCeiling(auth(), termNarrowed, undefined, ['devices:read']).partnerOrgAccess).toBe('selected');
  });

  it('drops a site-restricted org from reach and intersects the site allowlist', () => {
    const c = ceiling({ orgTerms: new Map([[ORG_B, { permissionKeys: new Set(['devices:read']), siteIds: new Set(['s-b']) }]]) });
    expect(narrowAuthToCeiling(auth(), c, undefined, []).accessibleOrgIds).toEqual([ORG_A]);
    const siteCeiling = narrowAuthToCeiling(auth({ allowedSiteIds: ['s-1', 's-2'] }), ceiling({ siteIds: new Set(['s-2', 's-3']) }), undefined, []);
    expect(siteCeiling.allowedSiteIds).toEqual(['s-2']);
    expect(siteCeiling.canAccessSite?.('s-1')).toBe(false);
  });
});

describe('unreachableWispAuth', () => {
  it('reaches no org and no partner breadth', () => {
    const closed = unreachableWispAuth(auth());
    expect(closed.accessibleOrgIds).toEqual([]);
    expect(closed.canAccessOrg(ORG_A)).toBe(false);
    expect(closed.partnerOrgAccess).toBe('none');
  });
});

describe('helpers', () => {
  it('requiredPermissionKeys maps an action-dependent tool by input.action', () => {
    expect(requiredPermissionKeys('manage_alerts', { action: 'resolve' })).toEqual(['alerts:write']);
    expect(requiredPermissionKeys('manage_alerts', { action: 'list' })).toEqual(['alerts:read']);
    expect(requiredPermissionKeys('no_such_tool', {})).toEqual([]);
  });

  it('targetOrgIdFor prefers a string input.orgId, else the session org', () => {
    expect(targetOrgIdFor({ orgId: ORG_B }, ORG_A)).toBe(ORG_B);
    expect(targetOrgIdFor({ orgId: 7 }, ORG_A)).toBe(ORG_A);
    expect(targetOrgIdFor({}, ORG_A)).toBe(ORG_A);
  });

  it('wispSeedForSession returns "" when the grant is inactive', async () => {
    shared.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g-1', 'paused'));
    await expect(wispSeedForSession(grant)).resolves.toBe('');
    expect(shared.seedContextForSession).not.toHaveBeenCalled();
  });

  it('wispSeedForSession on a CORRUPT pin still returns "" but logs and captures it (with the grant id)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const corrupt = new GrantInactiveError('g-1', 'active', 'malformed ceiling snapshot', 'corrupt');
    shared.resolveGrantCeiling.mockRejectedValue(corrupt);
    await expect(wispSeedForSession(grant)).resolves.toBe('');
    expect(shared.captureException).toHaveBeenCalledWith(corrupt, undefined, expect.objectContaining({ grantId: 'g-1' }));
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes('g-1'))).toBe(true);
    errSpy.mockRestore();
  });

  it('wispSeedForSession does not capture an ordinary inactive grant', async () => {
    shared.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError('g-1', 'revoked'));
    await expect(wispSeedForSession(grant)).resolves.toBe('');
    expect(shared.captureException).not.toHaveBeenCalled();
  });

  it('wispSeedForSession returns "" when the focus fell outside the ceiling, and the seed otherwise', async () => {
    shared.seedContextForSession.mockRejectedValueOnce(new CeilingViolationError('org', 'focus outside'));
    await expect(wispSeedForSession(grant)).resolves.toBe('');
    shared.seedContextForSession.mockResolvedValueOnce('## Wisp thread\nsummary');
    await expect(wispSeedForSession(grant)).resolves.toBe('## Wisp thread\nsummary');
    expect(shared.seedContextForSession).toHaveBeenLastCalledWith('t-1', expect.objectContaining({ grantId: 'g-1' }));
  });
});

describe('lookupWispGrant', () => {
  it('returns null for an ordinary session', async () => {
    shared.selectRows = [{ grantId: null, revisionId: null, threadId: null }];
    await expect(lookupWispGrant('s-1')).resolves.toBeNull();
  });

  it('returns { grantId, revisionId, threadId } for a linked Wisp session', async () => {
    shared.selectRows = [{ grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' }];
    await expect(lookupWispGrant('s-1')).resolves.toEqual(grant);
  });

  it.each([
    ['session_not_found', []],
    ['grant_unpinned', [{ grantId: 'g-1', revisionId: null, threadId: 't-1' }]],
    ['thread_unlinked', [{ grantId: 'g-1', revisionId: 'r-1', threadId: null }]],
  ])('fails closed (%s) instead of returning null', async (reason, rows) => {
    shared.selectRows = rows;
    await expect(lookupWispGrant('s-1')).rejects.toMatchObject({ name: 'WispSessionUnavailableError', reason });
  });

  it('propagates a DB error', async () => {
    shared.selectError = new Error('db down');
    await expect(lookupWispGrant('s-1')).rejects.toThrow('db down');
    expect(WispSessionUnavailableError).toBeDefined();
  });
});
