import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wispGrantRevisions, wispGrants } from '../../db/schema';

/**
 * Guard / shape tests for services/wisp/grants.ts. DB behaviour (RLS, the
 * update trigger, the one-live-per-scope index) is proven against real
 * Postgres in wispGrantsRls.integration.test.ts.
 *
 * `db` is a chain fake: every builder method records itself and returns the
 * chain; awaiting the chain resolves the next queued result (an Error rejects).
 */
const h = vi.hoisted(() => {
  const results: unknown[] = [];
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const next = () => (results.length ? results.shift() : []);
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function noop() {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = next();
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)).then(res, rej);
        }
        return (...args: unknown[]) => {
          calls.push({ op: String(prop), args });
          return proxy;
        };
      },
    });
    return proxy;
  };
  const db: Record<string, unknown> = {};
  for (const op of ['select', 'insert', 'update', 'delete', 'execute']) {
    db[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return chain();
    };
  }
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return {
    results,
    calls,
    db,
    consumeStepUpGrant: vi.fn(),
    getUserEpochs: vi.fn(),
    computeLiveHumanTerm: vi.fn(),
    createAuditLogAsync: vi.fn(),
    loadWispEntitlement: vi.fn(),
    getEntitlements: vi.fn(),
    hasSatisfiedMfa: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db: h.db,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../mfaStepUpGrant', async (orig) => ({
  ...(await orig<typeof import('../mfaStepUpGrant')>()),
  consumeStepUpGrant: h.consumeStepUpGrant,
}));
vi.mock('../authEpochs', () => ({ getUserEpochs: h.getUserEpochs }));
vi.mock('../auditService', () => ({ createAuditLogAsync: h.createAuditLogAsync }));
vi.mock('./wispEntitlementLimits', () => ({ loadWispEntitlement: h.loadWispEntitlement }));
// W05 plan budget default (spec §16): createGrant reads the partner's plan.
vi.mock('../entitlements', async (orig) => ({
  ...(await orig<typeof import('../entitlements')>()),
  getEntitlements: h.getEntitlements,
}));
vi.mock('../../middleware/auth', () => ({ hasSatisfiedMfa: h.hasSatisfiedMfa }));
vi.mock('./grantAuthority', async (orig) => ({
  ...(await orig<typeof import('./grantAuthority')>()),
  computeLiveHumanTerm: h.computeLiveHumanTerm,
}));

import {
  createGrant,
  refreshGrant,
  revokeGrant,
  pauseGrant,
  resumeGrant,
  userPauseGrant,
  userResumeGrant,
  updateGrantSettings,
  wideningAvailable,
  resolveMaxGrants,
  listGrants,
  previewGrantCeiling,
  WispGrantError,
  GrantLimitReachedError,
} from './grants';
import { ceilingSnapshotHash } from './grantAuthority';
import { EntitlementResolutionError } from '../entitlements';
import { wispGrantResourceDigest } from '../mfaStepUpGrant';
import type { AuthContext } from '../../middleware/auth';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';

function auth(o: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: USER, email: 'tech@example.test', name: 'Tech', isPlatformAdmin: false },
    token: { sid: 'sid-1', mfa: true } as never,
    partnerId: PARTNER,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: 'selected',
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === ORG,
    ...o,
  } as AuthContext;
}

const LIVE = { ok: true as const, permissionKeys: ['ai_sessions:use', 'devices:read'], orgIds: [ORG], siteIds: null, partnerOrgAccess: 'selected' as const };

const grantRow = (o: Record<string, unknown> = {}) => ({
  id: 'g1', partnerId: PARTNER, orgId: null, grantorUserId: USER, grantee: 'wisp', currentRevisionId: 'r1',
  status: 'active', pausedReason: null, pausedAt: null, revokedAt: null, revokedByUserId: null,
  expiresAt: new Date(Date.now() + 30 * 86_400_000), budgetCentsPerDay: 200, floorTickMinutes: 30,
  createdAt: new Date(), updatedAt: new Date(), ...o,
});

const callsOf = (op: string) => h.calls.filter((c) => c.op === op);
const valuesInserted = () => callsOf('values').map((c) => c.args[0] as Record<string, unknown>);
const setsApplied = () => callsOf('set').map((c) => c.args[0] as Record<string, unknown>);

beforeEach(() => {
  h.results.length = 0;
  h.calls.length = 0;
  vi.clearAllMocks();
  h.hasSatisfiedMfa.mockReturnValue(true);
  h.getUserEpochs.mockResolvedValue({ authEpoch: 3, mfaEpoch: 4 });
  h.consumeStepUpGrant.mockResolvedValue(true);
  h.computeLiveHumanTerm.mockResolvedValue(LIVE);
  h.loadWispEntitlement.mockResolvedValue({ enabled: true, limits: null });
  h.getEntitlements.mockResolvedValue({ plan: 'pro', entitlements: { wisp: { state: 'enabled', limits: null } } });
});

describe('createGrant', () => {
  const scope = { partnerId: PARTNER, orgId: null };

  it('refuses a non-user_session principal with not_user_session before touching step-up', async () => {
    await expect(createGrant({ auth: auth({ principal: { kind: 'api_key' } } as never), scope, stepUpGrantId: 's' }))
      .rejects.toMatchObject({ code: 'not_user_session' });
    expect(h.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('refuses auth.partnerId !== scope.partnerId with partner_mismatch', async () => {
    await expect(createGrant({ auth: auth({ partnerId: 'other' }), scope, stepUpGrantId: 's' }))
      .rejects.toMatchObject({ code: 'partner_mismatch' });
  });

  it('refuses an organization-scoped caller with partner_mismatch', async () => {
    await expect(createGrant({ auth: auth({ scope: 'organization' }), scope, stepUpGrantId: 's' }))
      .rejects.toMatchObject({ code: 'partner_mismatch' });
  });

  it('refuses an orgId the caller cannot reach (auth.canAccessOrg false) with org_out_of_reach', async () => {
    await expect(createGrant({ auth: auth(), scope: { partnerId: PARTNER, orgId: 'not-mine' }, stepUpGrantId: 's' }))
      .rejects.toMatchObject({ code: 'org_out_of_reach' });
    expect(h.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('refuses when hasSatisfiedMfa(auth) is false with mfa_required', async () => {
    h.hasSatisfiedMfa.mockReturnValue(false);
    await expect(createGrant({ auth: auth(), scope, stepUpGrantId: 's' })).rejects.toMatchObject({ code: 'mfa_required' });
  });

  it('maps a failed live term to its reason before consuming the step-up', async () => {
    h.computeLiveHumanTerm.mockResolvedValue({ ok: false, reason: 'grantor_access_lost' });
    await expect(createGrant({ auth: auth(), scope, stepUpGrantId: 's' })).rejects.toMatchObject({ code: 'grantor_access_lost' });
    expect(h.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('binds the consumed step-up to the grantor, scope and live ceiling hash; a false consume is step_up_required', async () => {
    h.consumeStepUpGrant.mockResolvedValue(false);
    await expect(createGrant({ auth: auth(), scope: { partnerId: PARTNER, orgId: ORG }, stepUpGrantId: 'step-1' }))
      .rejects.toMatchObject({ code: 'step_up_required' });
    const [id, bind] = h.consumeStepUpGrant.mock.calls[0]!;
    expect(id).toBe('step-1');
    expect(bind).toMatchObject({ userId: USER, operation: 'wisp_grant', authEpoch: 3, mfaEpoch: 4, sid: 'sid-1' });
    expect(bind.resourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(valuesInserted()).toEqual([]);
  });

  it('the digest it consumes is exactly the one the preview hash yields', async () => {
    const preview = await previewGrantCeiling({ auth: auth(), scope: { partnerId: PARTNER, orgId: ORG } });
    expect(preview.ceilingHash).toBe(ceilingSnapshotHash(preview.ceilingSnapshot));
    h.consumeStepUpGrant.mockResolvedValue(false);
    await expect(createGrant({ auth: auth(), scope: { partnerId: PARTNER, orgId: ORG }, stepUpGrantId: 'step-1' })).rejects.toThrow();
    const [, bind] = h.consumeStepUpGrant.mock.calls[0]!;
    expect(bind.resourceDigest).toBe(wispGrantResourceDigest({ grantorUserId: USER, partnerId: PARTNER, orgId: ORG, requestedCeilingHash: preview.ceilingHash }));
  });

  it('pins partnerWide only for a partner-wide scope held with org_access all', async () => {
    h.computeLiveHumanTerm.mockResolvedValue({ ...LIVE, partnerOrgAccess: 'all' });
    const wide = await previewGrantCeiling({ auth: auth(), scope: { partnerId: PARTNER, orgId: null } });
    expect(wide.ceilingSnapshot.partnerWide).toBe(true);
    const scoped = await previewGrantCeiling({ auth: auth(), scope: { partnerId: PARTNER, orgId: ORG } });
    expect(scoped.ceilingSnapshot.partnerWide).toBe(false);
    h.computeLiveHumanTerm.mockResolvedValue(LIVE); // selected
    const selected = await previewGrantCeiling({ auth: auth(), scope: { partnerId: PARTNER, orgId: null } });
    expect(selected.ceilingSnapshot.partnerWide).toBe(false);
  });

  it('writes grant + revision 1 + current pointer; factor_proof is { method, verifiedAt } only; defaults', async () => {
    h.results.push([grantRow({ currentRevisionId: null })]); // insert grant returning
    h.results.push([{ id: 'r1' }]); // insert revision returning
    h.results.push([grantRow()]); // update current_revision_id returning
    const before = Date.now();
    const grant = await createGrant({ auth: auth(), scope, stepUpGrantId: 'step-1' });

    expect(grant).toMatchObject({ id: 'g1', currentRevisionId: 'r1', grantee: 'wisp', budgetCentsPerDay: 200, floorTickMinutes: 30 });
    const [grantValues, revisionValues] = valuesInserted();
    expect(callsOf('insert').map((c) => c.args[0])).toEqual([wispGrants, wispGrantRevisions]);
    expect(grantValues).toMatchObject({ partnerId: PARTNER, orgId: null, grantorUserId: USER, grantee: 'wisp', budgetCentsPerDay: 200, floorTickMinutes: 30 });
    const expiresAt = grantValues!.expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 90 * 86_400_000 - 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 90 * 86_400_000 + 1000);
    expect(revisionValues).toMatchObject({ grantId: 'g1', partnerId: PARTNER, revision: 1 });
    expect(Object.keys(revisionValues!.factorProof as object).sort()).toEqual(['method', 'verifiedAt']);
    expect(JSON.stringify(revisionValues)).not.toContain('step-1');
    expect(setsApplied()).toContainEqual({ currentRevisionId: 'r1' });
    expect(h.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'wisp.grant.created', resourceType: 'wisp_grant', resourceId: 'g1' }));
  });

  it.each([
    ['pro', 200],
    ['enterprise', 500],
    ['unlimited', 1000],
  ])('stores the plan budget default (spec §16): %s → budgetCentsPerDay %i', async (plan, cents) => {
    h.getEntitlements.mockResolvedValue({ plan, entitlements: { wisp: { state: 'enabled', limits: null } } });
    h.results.push([grantRow({ currentRevisionId: null, budgetCentsPerDay: cents })], [{ id: 'r1' }], [grantRow({ budgetCentsPerDay: cents })]);
    const grant = await createGrant({ auth: auth(), scope, stepUpGrantId: 'step-1' });
    expect(h.getEntitlements).toHaveBeenCalledWith(PARTNER);
    expect(valuesInserted()[0]).toMatchObject({ budgetCentsPerDay: cents });
    expect(grant.budgetCentsPerDay).toBe(cents);
  });

  it('an unresolvable plan read is entitlement_check_failed before the step-up is consumed', async () => {
    h.getEntitlements.mockRejectedValue(new EntitlementResolutionError(PARTNER, new Error('db down')));
    const err = await createGrant({ auth: auth(), scope, stepUpGrantId: 's' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'WispGrantError', code: 'entitlement_check_failed' });
    expect(h.consumeStepUpGrant).not.toHaveBeenCalled();
    expect(callsOf('insert')).toEqual([]);
  });

  it('maps the one-live-per-scope unique violation to already_active', async () => {
    h.results.push(Object.assign(new Error('dup'), { code: '23505', constraint_name: 'wisp_grants_one_live_per_scope_uq' }));
    await expect(createGrant({ auth: auth(), scope, stepUpGrantId: 'step-1' })).rejects.toMatchObject({ code: 'already_active' });
  });

  it('throws GrantLimitReachedError when active grants ≥ maxGrants, before consuming the step-up and before any insert', async () => {
    h.loadWispEntitlement.mockResolvedValue({ enabled: true, limits: { maxGrants: 2, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 } });
    h.results.push([{ count: 2 }]);
    const err = await createGrant({ auth: auth(), scope, stepUpGrantId: 's' }).catch((e) => e);
    expect(err).toBeInstanceOf(GrantLimitReachedError);
    expect(err).toMatchObject({ code: 'grant_limit_reached', maxGrants: 2, active: 2, partnerId: PARTNER });
    expect(h.consumeStepUpGrant).not.toHaveBeenCalled();
    expect(callsOf('insert')).toEqual([]);
  });

  // Which statuses count is proven against real rows in wispGrantsRls.integration.test.ts.
  it('admits when active count < maxGrants (count 1 of 2)', async () => {
    h.loadWispEntitlement.mockResolvedValue({ enabled: true, limits: { maxGrants: 2, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 } });
    h.results.push([{ count: 1 }], [grantRow({ currentRevisionId: null })], [{ id: 'r1' }], [grantRow()]);
    await expect(createGrant({ auth: auth(), scope, stepUpGrantId: 's' })).resolves.toMatchObject({ id: 'g1' });
  });

  it('applies no cap when the entitlement is enabled with no limits (A21)', async () => {
    h.loadWispEntitlement.mockResolvedValue({ enabled: true, limits: null });
    h.results.push([grantRow({ currentRevisionId: null })], [{ id: 'r1' }], [grantRow()]);
    await expect(createGrant({ auth: auth(), scope, stepUpGrantId: 's' })).resolves.toMatchObject({ id: 'g1' });
    // No count(*) was issued: had one run, it would have consumed the grant row queued for the insert.
  });

  it('fails closed when the wisp entitlement is disabled: entitlement_required, step-up not consumed, nothing inserted', async () => {
    h.loadWispEntitlement.mockResolvedValue({ enabled: false });
    const err = await createGrant({ auth: auth(), scope, stepUpGrantId: 's' }).catch((e) => e);
    expect(err).toBeInstanceOf(WispGrantError);
    expect(err).toMatchObject({ code: 'entitlement_required' });
    expect(h.consumeStepUpGrant).not.toHaveBeenCalled();
    expect(callsOf('insert')).toEqual([]);
  });

  it('fails closed when entitlements cannot be resolved: entitlement_check_failed, step-up not consumed, nothing inserted', async () => {
    h.loadWispEntitlement.mockRejectedValue(new EntitlementResolutionError(PARTNER, new Error('db down')));
    const err = await createGrant({ auth: auth(), scope, stepUpGrantId: 's' }).catch((e) => e);
    expect(err).toBeInstanceOf(WispGrantError);
    expect(err).toMatchObject({ code: 'entitlement_check_failed' });
    expect(h.consumeStepUpGrant).not.toHaveBeenCalled();
    expect(callsOf('insert')).toEqual([]);
  });
});

describe('resolveMaxGrants', () => {
  it('enabled → limits.maxGrants; enabled with no limits → null (no cap)', async () => {
    h.loadWispEntitlement.mockResolvedValueOnce({ enabled: true, limits: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 } });
    expect(await resolveMaxGrants(PARTNER)).toBe(25);
    h.loadWispEntitlement.mockResolvedValueOnce({ enabled: true, limits: { maxGrants: 0, budgetCentsPerDayCeiling: 0, minFloorTickMinutes: 15 } });
    expect(await resolveMaxGrants(PARTNER)).toBe(0);
    h.loadWispEntitlement.mockResolvedValueOnce({ enabled: true, limits: null });
    expect(await resolveMaxGrants(PARTNER)).toBeNull();
  });

  it('disabled → WispGrantError entitlement_required; unresolvable → entitlement_check_failed', async () => {
    h.loadWispEntitlement.mockResolvedValueOnce({ enabled: false });
    await expect(resolveMaxGrants(PARTNER)).rejects.toMatchObject({ name: 'WispGrantError', code: 'entitlement_required' });
    h.loadWispEntitlement.mockRejectedValueOnce(new EntitlementResolutionError(PARTNER, new Error('db down')));
    await expect(resolveMaxGrants(PARTNER)).rejects.toMatchObject({ name: 'WispGrantError', code: 'entitlement_check_failed' });
  });

  it('any other error is a bug and propagates as itself (never read as "no cap")', async () => {
    const bug = new TypeError('fold bug');
    h.loadWispEntitlement.mockRejectedValueOnce(bug);
    await expect(resolveMaxGrants(PARTNER)).rejects.toBe(bug);
  });
});

describe('refreshGrant', () => {
  it('inserts revision n+1, moves the pointer and expiry, and never updates the previous revision row', async () => {
    h.results.push([grantRow()]); // load grant
    h.results.push([{ maxRevision: 3 }]); // max revision
    h.results.push([{ id: 'r4' }]); // insert revision
    h.results.push([grantRow({ currentRevisionId: 'r4' })]); // update grant
    const g = await refreshGrant({ auth: auth(), grantId: 'g1', stepUpGrantId: 'step-1' });
    expect(g.currentRevisionId).toBe('r4');
    expect(callsOf('insert').map((c) => c.args[0])).toEqual([wispGrantRevisions]);
    expect(valuesInserted()[0]).toMatchObject({ grantId: 'g1', revision: 4 });
    expect(callsOf('update').map((c) => c.args[0])).toEqual([wispGrants]);
    expect(Object.keys(setsApplied()[0]!).sort()).toEqual(['currentRevisionId', 'expiresAt']);
    expect(setsApplied()[0]).toMatchObject({ currentRevisionId: 'r4', expiresAt: expect.any(Date) });
  });

  it('never consults the entitlement: an existing grant refreshes even after wisp is disabled for the partner', async () => {
    h.loadWispEntitlement.mockResolvedValue({ enabled: false });
    h.results.push([grantRow()], [{ maxRevision: 1 }], [{ id: 'r2' }], [grantRow({ currentRevisionId: 'r2' })]);
    await expect(refreshGrant({ auth: auth(), grantId: 'g1', stepUpGrantId: 'step-1' })).resolves.toMatchObject({ currentRevisionId: 'r2' });
    expect(h.loadWispEntitlement).not.toHaveBeenCalled();
  });

  it('refreshing a PAUSED grant re-pins it but leaves it paused (no status in the update)', async () => {
    h.results.push([grantRow({ status: 'paused', pausedReason: 'user_paused' })], [{ maxRevision: 1 }], [{ id: 'r2' }],
      [grantRow({ status: 'paused', pausedReason: 'user_paused', currentRevisionId: 'r2' })]);
    const g = await refreshGrant({ auth: auth(), grantId: 'g1', stepUpGrantId: 'step-1' });
    expect(g).toMatchObject({ status: 'paused', currentRevisionId: 'r2' });
    expect(setsApplied()[0]).not.toHaveProperty('status');
  });

  it('a concurrent refresh that loses the revision race is a 409-class not_active, not a 500', async () => {
    h.results.push([grantRow()], [{ maxRevision: 1 }], Object.assign(new Error('dup'), { cause: { code: '23505', constraint_name: 'wisp_grant_revisions_grant_rev_uq' } }));
    await expect(refreshGrant({ auth: auth(), grantId: 'g1', stepUpGrantId: 'step-1' })).rejects.toMatchObject({ code: 'not_active' });
  });

  it('refuses a non-grantor with forbidden', async () => {
    h.results.push([grantRow({ grantorUserId: ADMIN })]);
    await expect(refreshGrant({ auth: auth(), grantId: 'g1', stepUpGrantId: 's' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses a revoked grant with not_active', async () => {
    h.results.push([grantRow({ status: 'revoked' })]);
    await expect(refreshGrant({ auth: auth(), grantId: 'g1', stepUpGrantId: 's' })).rejects.toMatchObject({ code: 'not_active' });
  });
});

describe('updateGrantSettings', () => {
  it('the grantor may change budget/tick; currentRevisionId is untouched', async () => {
    h.results.push([grantRow()], [grantRow({ floorTickMinutes: 60 })]);
    const g = await updateGrantSettings({ auth: auth(), grantId: 'g1', patch: { floorTickMinutes: 60 } });
    expect(g.floorTickMinutes).toBe(60);
    expect(setsApplied()[0]).toEqual({ floorTickMinutes: 60 });
    expect(h.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'wisp.grant.settings_changed' }));
  });

  it('a partner admin (canManagePartnerWidePolicies) may too; another tech → forbidden', async () => {
    h.results.push([grantRow({ grantorUserId: ADMIN })], [grantRow({ grantorUserId: ADMIN, budgetCentsPerDay: 500 })]);
    await expect(updateGrantSettings({ auth: auth({ partnerOrgAccess: 'all' }), grantId: 'g1', patch: { budgetCentsPerDay: 500 } }))
      .resolves.toMatchObject({ budgetCentsPerDay: 500 });
    h.results.push([grantRow({ grantorUserId: ADMIN })]);
    await expect(updateGrantSettings({ auth: auth(), grantId: 'g1', patch: { budgetCentsPerDay: 500 } }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects floorTickMinutes 14 and 241, a budget above the max, and an empty patch (settings_out_of_bounds)', async () => {
    for (const patch of [{ floorTickMinutes: 14 }, { floorTickMinutes: 241 }, { budgetCentsPerDay: 5001 }, { budgetCentsPerDay: -1 }, {}]) {
      await expect(updateGrantSettings({ auth: auth(), grantId: 'g1', patch })).rejects.toMatchObject({ code: 'settings_out_of_bounds' });
    }
    expect(callsOf('update')).toEqual([]);
  });

  it('caller bounds can never lower the 15-minute tick floor (the DB CHECK)', async () => {
    await expect(updateGrantSettings({ auth: auth(), grantId: 'g1', patch: { floorTickMinutes: 10 }, bounds: { budgetCentsPerDayMax: 1000, minFloorTickMinutes: 5 } }))
      .rejects.toMatchObject({ code: 'settings_out_of_bounds' });
  });

  it('honours caller-supplied plan bounds', async () => {
    await expect(updateGrantSettings({ auth: auth(), grantId: 'g1', patch: { budgetCentsPerDay: 1500 }, bounds: { budgetCentsPerDayMax: 1000, minFloorTickMinutes: 30 } }))
      .rejects.toMatchObject({ code: 'settings_out_of_bounds' });
    await expect(updateGrantSettings({ auth: auth(), grantId: 'g1', patch: { floorTickMinutes: 20 }, bounds: { budgetCentsPerDayMax: 1000, minFloorTickMinutes: 30 } }))
      .rejects.toMatchObject({ code: 'settings_out_of_bounds' });
  });
});

describe('wideningAvailable', () => {
  const snap = (o = {}) => ({ version: 1, permissionKeys: ['ai_sessions:use', 'devices:read'], orgIds: [ORG], siteIds: null, toolAllowlist: null, deniedTools: [], ...o });

  it('true when live orgIds or permissionKeys exceed the current snapshot', async () => {
    h.results.push([{ ...grantRow(), ceilingSnapshot: snap() }]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ...LIVE, orgIds: [ORG, 'org-new'] });
    expect(await wideningAvailable('g1')).toBe(true);
    h.results.push([{ ...grantRow(), ceilingSnapshot: snap() }]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ...LIVE, permissionKeys: [...LIVE.permissionKeys, 'scripts:execute'] });
    expect(await wideningAvailable('g1')).toBe(true);
  });

  it('false when equal, narrower, or the live term is ok:false', async () => {
    h.results.push([{ ...grantRow(), ceilingSnapshot: snap() }]);
    expect(await wideningAvailable('g1')).toBe(false);
    h.results.push([{ ...grantRow(), ceilingSnapshot: snap() }]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ...LIVE, permissionKeys: ['ai_sessions:use'] });
    expect(await wideningAvailable('g1')).toBe(false);
    h.results.push([{ ...grantRow(), ceilingSnapshot: snap() }]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ok: false, reason: 'grantor_suspended' });
    expect(await wideningAvailable('g1')).toBe(false);
  });

  it('a partner-wide grant whose grantor gained org_access all since the pin offers a widening', async () => {
    h.results.push([{ ...grantRow(), ceilingSnapshot: snap({ partnerWide: false }) }]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ...LIVE, partnerOrgAccess: 'all' });
    expect(await wideningAvailable('g1')).toBe(true);
    h.results.push([{ ...grantRow(), ceilingSnapshot: snap({ partnerWide: true }) }]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ...LIVE, partnerOrgAccess: 'all' });
    expect(await wideningAvailable('g1')).toBe(false);
  });

  it('a new org outside an org-scoped grant is not a widening', async () => {
    h.results.push([{ ...grantRow({ orgId: ORG }), ceilingSnapshot: snap() }]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ...LIVE, orgIds: [ORG, 'org-new'] });
    expect(await wideningAvailable('g1')).toBe(false);
  });
});

describe('revokeGrant', () => {
  it('by a non-grantor who is not canManagePartnerWidePolicies → forbidden', async () => {
    h.results.push([grantRow({ grantorUserId: ADMIN })]);
    await expect(revokeGrant({ auth: auth(), grantId: 'g1' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(callsOf('update')).toEqual([]);
  });

  it('by a partner admin succeeds and stamps revoked_by_user_id = admin', async () => {
    h.results.push([grantRow()], [grantRow({ status: 'revoked' })]);
    await revokeGrant({ auth: auth({ user: { id: ADMIN, email: 'a@example.test', name: 'A', isPlatformAdmin: false }, partnerOrgAccess: 'all' }), grantId: 'g1' });
    expect(setsApplied()[0]).toMatchObject({ status: 'revoked', revokedByUserId: ADMIN, pausedReason: null, revokedAt: expect.any(Date) });
    expect(h.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'wisp.grant.revoked', actorId: ADMIN }));
  });

  it('an unknown grant is not_found', async () => {
    h.results.push([]);
    await expect(revokeGrant({ auth: auth(), grantId: 'g1' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('pauseGrant / resumeGrant (system paths)', () => {
  it('pauseGrant is a no-op on a revoked grant (never resurrects a terminal row)', async () => {
    h.results.push([grantRow({ status: 'revoked' })]);
    await pauseGrant('g1', 'grantor_access_lost');
    expect(callsOf('update')).toEqual([]);
  });

  it('pauseGrant moves active → paused with the reason', async () => {
    h.results.push([grantRow()], [grantRow({ status: 'paused', pausedReason: 'grantor_suspended' })]);
    await pauseGrant('g1', 'grantor_suspended');
    expect(setsApplied()[0]).toMatchObject({ status: 'paused', pausedReason: 'grantor_suspended', pausedAt: expect.any(Date) });
  });

  it('a system reason overwrites user_paused; a later system reason never overwrites an earlier one', async () => {
    h.results.push([grantRow({ status: 'paused', pausedReason: 'user_paused' })], [grantRow()]);
    await pauseGrant('g1', 'grantor_access_lost');
    expect(setsApplied()[0]).toMatchObject({ pausedReason: 'grantor_access_lost' });
    h.calls.length = 0;
    h.results.push([grantRow({ status: 'paused', pausedReason: 'budget_exhausted' })]);
    await pauseGrant('g1', 'grantor_access_lost');
    expect(callsOf('update')).toEqual([]);
  });

  it('pauseGrant({ onlyFromActive }) leaves an already-paused grant (incl. user_paused) untouched', async () => {
    h.results.push([grantRow({ status: 'paused', pausedReason: 'user_paused' })]);
    await pauseGrant('g1', 'grantor_access_lost', { onlyFromActive: true });
    expect(callsOf('update')).toEqual([]);
  });

  it('resumeGrant(id, expectedReason) resumes only the pause the caller judged', async () => {
    h.results.push([grantRow({ status: 'paused', pausedReason: 'budget_exhausted' })]);
    await resumeGrant('g1', 'grantor_access_lost');
    expect(callsOf('update')).toEqual([]);
    h.results.push([grantRow({ status: 'paused', pausedReason: 'grantor_access_lost' })], [grantRow()]);
    await resumeGrant('g1', 'grantor_access_lost');
    expect(setsApplied()[0]).toMatchObject({ status: 'active' });
  });

  it('resumeGrant only moves paused → active, and never a user_paused grant', async () => {
    h.results.push([grantRow()]);
    await resumeGrant('g1');
    expect(callsOf('update')).toEqual([]);
    h.results.push([grantRow({ status: 'paused', pausedReason: 'user_paused' })]);
    await resumeGrant('g1');
    expect(callsOf('update')).toEqual([]);
    h.results.push([grantRow({ status: 'paused', pausedReason: 'grantor_access_lost' })], [grantRow()]);
    await resumeGrant('g1');
    expect(setsApplied()[0]).toMatchObject({ status: 'active', pausedReason: null, pausedAt: null });
  });
});

describe('userPauseGrant / userResumeGrant (w00 A29)', () => {
  it('userPauseGrant by a non-grantor → forbidden', async () => {
    h.results.push([grantRow({ grantorUserId: ADMIN })]);
    await expect(userPauseGrant({ auth: auth(), grantId: 'g1' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('userPauseGrant: active → paused/user_paused', async () => {
    h.results.push([grantRow()], [grantRow({ status: 'paused', pausedReason: 'user_paused' })]);
    const g = await userPauseGrant({ auth: auth(), grantId: 'g1' });
    expect(g).toMatchObject({ status: 'paused', pausedReason: 'user_paused' });
    expect(setsApplied()[0]).toMatchObject({ status: 'paused', pausedReason: 'user_paused' });
    expect(h.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'wisp.grant.paused', details: expect.objectContaining({ reason: 'user_paused' }) }));
  });

  it('userResumeGrant on paused_reason entitlement_lost → not_user_paused', async () => {
    h.results.push([grantRow({ status: 'paused', pausedReason: 'entitlement_lost' })]);
    await expect(userResumeGrant({ auth: auth(), grantId: 'g1' })).rejects.toMatchObject({ code: 'not_user_paused' });
    expect(callsOf('update')).toEqual([]);
  });

  it('userResumeGrant on user_paused → active with the same currentRevisionId', async () => {
    h.results.push([grantRow({ status: 'paused', pausedReason: 'user_paused' })], [grantRow()], []);
    const g = await userResumeGrant({ auth: auth(), grantId: 'g1' });
    expect(g).toMatchObject({ status: 'active', currentRevisionId: 'r1' });
    expect(setsApplied()[0]).toEqual({ status: 'active', pausedReason: null, pausedAt: null });
  });

  it('userResumeGrant fails closed when the grantor lost standing meanwhile', async () => {
    h.results.push([grantRow({ status: 'paused', pausedReason: 'user_paused' })]);
    h.computeLiveHumanTerm.mockResolvedValueOnce({ ok: false, reason: 'grantor_suspended' });
    await expect(userResumeGrant({ auth: auth(), grantId: 'g1' })).rejects.toMatchObject({ code: 'grantor_suspended' });
  });
});

describe('listGrants', () => {
  it('view=partner requires canManagePartnerWidePolicies', async () => {
    await expect(listGrants({ auth: auth(), view: 'partner' })).rejects.toMatchObject({ code: 'forbidden' });
    h.results.push([grantRow()]);
    await expect(listGrants({ auth: auth({ partnerOrgAccess: 'all' }), view: 'partner' })).resolves.toHaveLength(1);
  });

  it('WispGrantError carries its code', () => {
    expect(new WispGrantError('not_found', 'x').code).toBe('not_found');
  });
});
