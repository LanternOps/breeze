import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  resolveGrantCeiling: vi.fn(),
  seedContextForSession: vi.fn(),
  selectRows: [] as unknown[],
  selectError: null as Error | null,
  captureException: vi.fn(),
  resolveEntityRef: vi.fn(),
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

vi.mock('./entityRefs', () => ({ resolveEntityRef: shared.resolveEntityRef, isResolveFailure: (r: object) => 'reason' in r }));

vi.mock('./threads', () => ({ seedContextForSession: shared.seedContextForSession }));

import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { db } from '../../db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { resolveWritableToolOrgId, WRITE_ORG_AMBIGUOUS_ERROR } from '../aiToolWriteOrg';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { CeilingViolationError, GrantInactiveError, type GrantCeiling } from './grantAuthority';
import {
  WISP_ACTION_NOT_DELEGABLE_MESSAGE,
  WISP_PARTNER_ID_AS_ORG_MESSAGE,
  WISP_REFUSAL_MESSAGES,
  WispSessionUnavailableError,
  enforceWispCeiling,
  lookupWispGrant,
  narrowAuthToCeiling,
  requiredPermissionKeys,
  targetOrgIdFor,
  unreachableWispAuth,
  wispSeedForSession,
  wispSessionToolFilter,
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
  vi.restoreAllMocks();
  vi.clearAllMocks();
  shared.resolveEntityRef.mockReset();
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

  it('manage_monitor_definitions describe passes the permission gate on alerts:read, and refuses without it (#11431)', async () => {
    await expect(enforce('manage_monitor_definitions', { action: 'describe', kind: 'offline' })).resolves.toMatchObject({ ok: true });
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['devices:read']) }));
    await expect(enforce('manage_monitor_definitions', { action: 'describe' })).resolves.toMatchObject({
      ok: false, refusal: { detail: 'permission' },
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

// #11433 (US prod 2026-11-08): Wisp offered "Fleet Design runs for the top few
// orgs" and every `manage_fleet_designs run` was refused at 0 ms with
// WISP_REFUSAL_MESSAGES.tool, under a *:* grant that denied nothing. The chat
// gate and the release (releaseCeiling.ts) both run this function with the
// call's own input, so both see the action.
describe('manage_fleet_designs under a Wisp grant (#11433)', () => {
  const REPORT_RUN = '00000000-0000-4000-8000-0000000000f1';
  const fleet = (o: Partial<GrantCeiling> = {}) => ceiling({
    permissionKeys: new Set(['ai_agents:write', 'ai_agents:read', 'devices:write', 'documents:write']), ...o,
  });
  beforeEach(() => { shared.resolveGrantCeiling.mockResolvedValue(fleet()); });

  it('a run for an org inside the ceiling passes the ceiling, gated on ai_agents:write in that org', async () => {
    const r = await enforce('manage_fleet_designs', { action: 'run', orgId: ORG_B });
    expect(r).toMatchObject({ ok: true, permissionKeys: ['ai_agents:write'] });
    if (!r.ok) return;
    expect(r.toolAuth.canAccessOrg(ORG_B)).toBe(true);
    expect(r.toolAuth.canAccessOrg(ORG_C)).toBe(false);
  });

  it.each([
    ['preview', 'devices:write'],
    ['applied', 'ai_agents:read'],
    ['document', 'documents:write'],
  ])('%s passes on its own permission (%s)', async (action, key) => {
    const r = await enforce('manage_fleet_designs', { action, reportRunId: REPORT_RUN });
    expect(r.ok, action).toBe(true);
    if (!r.ok) return;
    expect(r.permissionKeys).toContain(key);
  });

  it.each(['apply', 'rollback'])('%s stays refused with detail "tool" even for a *:* grantor, saying where it is done', async (action) => {
    shared.resolveGrantCeiling.mockResolvedValue(fleet({ permissionKeys: new Set(['*:*']) }));
    await expect(enforce('manage_fleet_designs', { action, reportRunId: REPORT_RUN })).resolves.toEqual({
      ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'tool', message: WISP_ACTION_NOT_DELEGABLE_MESSAGE },
    });
  });

  it('a run for an org outside the ceiling is refused with detail "org"', async () => {
    await expect(enforce('manage_fleet_designs', { action: 'run', orgId: ORG_C })).resolves.toMatchObject({
      ok: false, refusal: { detail: 'org' },
    });
  });

  it('a run whose grant lacks ai_agents:write is refused with detail "permission"', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(fleet({ permissionKeys: new Set(['ai_agents:read']) }));
    await expect(enforce('manage_fleet_designs', { action: 'run', orgId: ORG_A })).resolves.toMatchObject({
      ok: false, refusal: { detail: 'permission' },
    });
  });

  it('a report-keyed action reaches only the orgs where its own permission holds (the report lookup uses this reach)', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(fleet({
      orgTerms: new Map([[ORG_B, { permissionKeys: new Set(['ai_agents:read']), siteIds: null }]]),
    }));
    const r = await enforce('manage_fleet_designs', { action: 'document', reportRunId: REPORT_RUN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.toolAuth.canAccessOrg(ORG_A)).toBe(true);
    expect(r.toolAuth.canAccessOrg(ORG_B)).toBe(false);
  });

  it('a call with no action never passes', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(fleet({ permissionKeys: new Set(['*:*']) }));
    await expect(enforce('manage_fleet_designs', { orgId: ORG_A })).resolves.toMatchObject({ ok: false });
  });

  it('a revision pinned while the whole tool was on the floor keeps refusing run until the grant is refreshed', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(fleet({ deniedTools: new Set(['manage_fleet_designs']) }));
    await expect(enforce('manage_fleet_designs', { action: 'run', orgId: ORG_A })).resolves.toEqual({
      ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'tool', message: WISP_REFUSAL_MESSAGES.tool },
    });
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

  it('wispSeedForSession reuses the prompt ceiling without a second lookup', async () => {
    const liveCeiling = ceiling();
    shared.seedContextForSession.mockResolvedValueOnce('seed');
    expect(await wispSeedForSession(grant, null, liveCeiling)).toBe('seed');
    expect(shared.seedContextForSession).toHaveBeenCalledWith('t-1', liveCeiling, null);
    expect(shared.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it("passes the turn's model through so the seed names it (#10391), alone or beside the viewing entity", async () => {
    const live = ceiling();
    shared.seedContextForSession.mockResolvedValueOnce('seed');
    await wispSeedForSession(grant, null, live, undefined, 'claude-sonnet-5-5');
    expect(shared.seedContextForSession).toHaveBeenLastCalledWith('t-1', live, null, { model: 'claude-sonnet-5-5' });

    const viewing = { ref: { kind: 'device', id: ORG_C, orgId: ORG_A }, orgId: ORG_A, label: 'x', status: null, href: '/' };
    shared.resolveEntityRef.mockResolvedValueOnce(viewing);
    shared.seedContextForSession.mockResolvedValueOnce('seed');
    await wispSeedForSession(grant, null, live, { type: 'device', id: ORG_C, hostname: 'h' }, 'claude-sonnet-5-5');
    expect(shared.seedContextForSession).toHaveBeenLastCalledWith('t-1', live, null, { viewing, model: 'claude-sonnet-5-5' });
  });

  it.each(['record', 'device', 'alert'] as const)('a %s page context resolves viewing with the caller and live ceiling', async (type) => {
    const live = ceiling(), caller = auth();
    const id = '00000000-0000-4000-8000-000000000123';
    const page = type === 'record' ? { type, kind: 'ticket' as const, id, label: 'Untrusted client label' }
      : type === 'device' ? { type, id, hostname: 'Untrusted client hostname' }
        : { type, id, title: 'Untrusted client title' };
    const viewing = { ref: { kind: type === 'record' ? 'ticket' : type, id, orgId: ORG_A },
      orgId: ORG_A, label: 'Server label', status: null, href: '/' };
    shared.resolveEntityRef.mockResolvedValueOnce(viewing);
    shared.seedContextForSession.mockResolvedValueOnce('seed');
    expect(await wispSeedForSession(grant, caller, live, page)).toBe('seed');
    expect(shared.resolveEntityRef).toHaveBeenCalledExactlyOnceWith({ auth: caller, ceiling: live }, { kind: viewing.ref.kind, id });
    expect(shared.seedContextForSession).toHaveBeenCalledExactlyOnceWith('t-1', live, caller, { viewing });
  });

  it.each(['outside_ceiling', 'not_found', 'forbidden', 'outside_token_scope'])('a viewed record refused with %s adds no seed line', async (reason) => {
    const live = ceiling(), caller = auth();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    shared.resolveEntityRef.mockResolvedValueOnce({ reason });
    shared.seedContextForSession.mockResolvedValueOnce('safe seed');
    expect(await wispSeedForSession(grant, caller, live, { type: 'record', kind: 'ticket', id: ORG_C, label: 'Client label' })).toBe('safe seed');
    expect(shared.seedContextForSession).toHaveBeenCalledExactlyOnceWith('t-1', live, caller);
    expect(debug).toHaveBeenCalledExactlyOnceWith('[Wisp] Viewing context refused; omitting viewing from seed:', {
      reason, kind: 'ticket', grantId: grant.grantId,
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain('Client label');
    debug.mockRestore();
  });

  it('a viewing resolver failure omits viewing, captures the fault, and preserves the seed', async () => {
    const live = ceiling();
    const error = new Error('viewing lookup unavailable');
    shared.resolveEntityRef.mockRejectedValueOnce(error);
    shared.seedContextForSession.mockResolvedValueOnce('safe seed');
    expect(await wispSeedForSession(grant, null, live, { type: 'record', kind: 'ticket', id: ORG_C })).toBe('safe seed');
    expect(shared.captureException).toHaveBeenCalledWith(error, undefined, expect.objectContaining({ op: 'wisp.seed_viewing' }));
    expect(shared.seedContextForSession).toHaveBeenCalledExactlyOnceWith('t-1', live, null);
  });

  it('dashboard context does not resolve a viewing entity', async () => {
    const live = ceiling();
    shared.seedContextForSession.mockResolvedValueOnce('seed');
    expect(await wispSeedForSession(grant, null, live, { type: 'dashboard' })).toBe('seed');
    expect(shared.resolveEntityRef).not.toHaveBeenCalled();
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
    expect(shared.seedContextForSession).toHaveBeenLastCalledWith('t-1', expect.objectContaining({ grantId: 'g-1' }), null);
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

describe('wispSessionToolFilter (#10430)', () => {
  const snapshot = (o: Record<string, unknown> = {}) => ({
    version: 1, permissionKeys: ['*:*'], orgIds: [ORG_A], siteIds: null, toolAllowlist: null, deniedTools: [], ...o,
  });

  it('refuses a tool in the pinned revision\'s deniedTools and admits the rest', async () => {
    shared.selectRows = [{ ceilingSnapshot: snapshot({ deniedTools: ['list_alerts'] }) }];
    const admit = await wispSessionToolFilter(grant);
    expect(admit('list_alerts')).toBe(false);
    expect(admit('query_devices')).toBe(true);
    expect(shared.captureException).not.toHaveBeenCalled();
  });

  it('refuses the agent deny floor even when the snapshot predates a registry entry', async () => {
    shared.selectRows = [{ ceilingSnapshot: snapshot() }];
    const admit = await wispSessionToolFilter(grant);
    expect(admit('list_operator_tasks')).toBe(false);
    expect(admit('launch_specialist')).toBe(true);
  });

  it('offers manage_fleet_designs (its run and reads are delegable), unless the pinned snapshot denies it (#11433)', async () => {
    shared.selectRows = [{ ceilingSnapshot: snapshot() }];
    expect((await wispSessionToolFilter(grant))('manage_fleet_designs')).toBe(true);
    shared.selectRows = [{ ceilingSnapshot: snapshot({ deniedTools: ['manage_fleet_designs'] }) }];
    expect((await wispSessionToolFilter(grant))('manage_fleet_designs')).toBe(false);
  });

  it('applies the pinned allowlist', async () => {
    shared.selectRows = [{ ceilingSnapshot: snapshot({ toolAllowlist: ['query_devices'] }) }];
    const admit = await wispSessionToolFilter(grant);
    expect(admit('query_devices')).toBe(true);
    expect(admit('list_alerts')).toBe(false);
  });

  it.each([
    ['a missing revision row', []],
    ['a malformed snapshot', [{ ceilingSnapshot: { version: 2 } }]],
  ])('falls back to the agent deny floor and reports %s', async (_label, rows) => {
    shared.selectRows = rows;
    const admit = await wispSessionToolFilter(grant);
    expect(admit('list_operator_tasks')).toBe(false);
    expect(admit('query_devices')).toBe(true);
    expect(shared.captureException).toHaveBeenCalledTimes(1);
  });

  it('propagates a DB error', async () => {
    shared.selectError = new Error('db down');
    await expect(wispSessionToolFilter(grant)).rejects.toThrow('db down');
  });
});

// #11432: a partner-wide Wisp chat could not write without the model guessing
// an org. Only a thread focused on the org the call is checked and filed in may
// default an org-less write; nothing else picks a tenant (#6667).
describe('the thread focus as the write default (#11432)', () => {
  const writes = ceiling({ permissionKeys: new Set(['devices:read', 'devices:write']) });
  const create = { action: 'create', name: 'Baseline Monitoring' };

  it('a thread focused on the session org makes it the write default, so a create with no orgId resolves there', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(writes);
    shared.selectRows = [{ focusOrgId: ORG_A }];
    const result = await enforce('manage_configuration_policy', create);
    expect(result).toMatchObject({ ok: true, writeDefaultOrgId: ORG_A });
    if (!result.ok) return;
    expect(result.toolAuth.aiWriteDefaultOrgId).toBe(ORG_A);
    expect(resolveWritableToolOrgId(result.toolAuth)).toEqual({ orgId: ORG_A });
  });

  it('an unfocused (partner-wide) thread sets no default: the create stays ambiguous', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(writes);
    shared.selectRows = [{ focusOrgId: null }];
    const result = await enforce('manage_configuration_policy', create);
    expect(result).toMatchObject({ ok: true, writeDefaultOrgId: null });
    if (!result.ok) return;
    expect(result.toolAuth.aiWriteDefaultOrgId).toBeUndefined();
    expect(resolveWritableToolOrgId(result.toolAuth)).toEqual({ error: WRITE_ORG_AMBIGUOUS_ERROR });
  });

  it('a focus that is not the session org (moved after the session began) sets no default', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(writes);
    shared.selectRows = [{ focusOrgId: ORG_B }];
    const result = await enforce('manage_configuration_policy', create);
    expect(result).toMatchObject({ ok: true, writeDefaultOrgId: null });
    if (!result.ok) return;
    expect(result.toolAuth.aiWriteDefaultOrgId).toBeUndefined();
  });

  it('reads the focus of THIS grant\'s thread, keyed by thread and partner', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(writes);
    shared.selectRows = [{ focusOrgId: ORG_A }];
    await enforce('manage_configuration_policy', create);
    const chain = vi.mocked(db.select).mock.results[0]!.value as { where: ReturnType<typeof vi.fn> };
    const { sql, params } = new PgDialect().sqlToQuery(chain.where.mock.calls[0]![0]);
    expect(sql).toMatch(/"wisp_threads"\."id" = \$\d+ and "wisp_threads"\."partner_id" = \$\d+/);
    expect(params).toEqual(['t-1', 'p-1']);
  });

  it('a read-only call reads no thread: a failed lookup must never deny a query', async () => {
    shared.selectError = new Error('connection refused');
    await expect(enforce('get_device_details', { deviceId: 'd' })).resolves.toMatchObject({ ok: true, writeDefaultOrgId: null });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('a call that names its org, and a tenant tool, read no thread', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(writes);
    await expect(enforce('manage_configuration_policy', { ...create, orgId: ORG_B })).resolves.toMatchObject({ ok: true, writeDefaultOrgId: null });
    await enforceWispCeiling({
      grant, toolName: 'hudu__get_asset', input: {}, sessionOrgId: ORG_A, sessionId: 's-1', toolAuth: auth(),
      permissionRequirement: { resource: 'devices', action: 'read' },
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('a thread read failure propagates, so the caller fails closed', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(writes);
    shared.selectError = new Error('connection refused');
    await expect(enforce('manage_configuration_policy', create)).rejects.toThrow('connection refused');
  });

  it('narrowAuthToCeiling sets the default only for an org inside the narrowed reach', () => {
    expect(narrowAuthToCeiling(auth(), ceiling(), 's-1', [], ORG_A).aiWriteDefaultOrgId).toBe(ORG_A);
    expect(narrowAuthToCeiling(auth(), ceiling(), 's-1', [], ORG_C).aiWriteDefaultOrgId).toBeUndefined();
    expect(narrowAuthToCeiling(auth(), ceiling(), 's-1', [], null).aiWriteDefaultOrgId).toBeUndefined();
  });

  it('the partner id passed as orgId is refused with a message that names both owners', async () => {
    await expect(enforce('manage_configuration_policy', { ...create, orgId: 'p-1' })).resolves.toEqual({
      ok: false, refusal: { code: 'wisp_outside_ceiling', detail: 'org', message: WISP_PARTNER_ID_AS_ORG_MESSAGE },
    });
    expect(WISP_PARTNER_ID_AS_ORG_MESSAGE).toContain('ownerScope: "partner"');
  });
});

// #11432 decision 3: a partner-owned object (ownerScope "partner") is written
// under the grantor's full partner org access. A partner-wide grant whose
// grantor still has it keeps it through the ceiling; anything narrower loses it.
describe('partner-owned writes under a partner-wide grant (#11432)', () => {
  const partnerCreate = { action: 'create', ownerScope: 'partner', name: 'Baseline Monitoring' };

  it('a partner-wide grant that reaches every ceiling org passes the full-partner-access gate', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['devices:write']) }));
    const result = await enforce('manage_configuration_policy', partnerCreate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.toolAuth.partnerOrgAccess).toBe('all');
    expect(canManagePartnerWidePolicies(result.toolAuth)).toBe(true);
  });

  it('loses it when the grantor\'s term in one org lacks the write, or the grant is not partner-wide', async () => {
    shared.resolveGrantCeiling.mockResolvedValue(ceiling({
      permissionKeys: new Set(['devices:write']),
      orgTerms: new Map([[ORG_B, { permissionKeys: new Set(['devices:read']), siteIds: null }]]),
    }));
    const narrower = await enforce('manage_configuration_policy', partnerCreate);
    expect(narrower.ok).toBe(true);
    if (!narrower.ok) return;
    expect(narrower.toolAuth.partnerOrgAccess).toBe('selected');
    expect(canManagePartnerWidePolicies(narrower.toolAuth)).toBe(false);

    shared.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['devices:write']), partnerWide: false, scopeOrgId: ORG_A }));
    const orgGrant = await enforce('manage_configuration_policy', partnerCreate);
    expect(orgGrant.ok).toBe(true);
    if (!orgGrant.ok) return;
    expect(orgGrant.toolAuth.partnerOrgAccess).toBe('selected');
    expect(canManagePartnerWidePolicies(orgGrant.toolAuth)).toBe(false);
  });
});
