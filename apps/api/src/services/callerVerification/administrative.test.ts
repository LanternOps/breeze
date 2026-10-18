import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ref = vi.hoisted(() => ({
  db: null as any, stub: false, policy: vi.fn(), bindings: vi.fn(), eligible: vi.fn(), consume: vi.fn(), perms: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: new Proxy({}, { get: (_, key) => ref.db[key] }),
  assertInTransaction: vi.fn(),
  runOutsideDbContext: (f: () => unknown) => f(),
  withSystemDbAccessContext: (f: () => unknown) => f(),
  getCurrentDbAccessContext: () => ({ scope: 'organization' }),
}));
vi.mock('./effects', () => ({ recordEffect: vi.fn() }));
vi.mock('./rejection', () => ({ handleRejection: vi.fn() }));
vi.mock('./gate', () => ({ fencedUntil: async () => null }));
vi.mock('./policy', async (original) => ({ ...await original<typeof import('./policy')>(), getEffectivePolicy: ref.policy }));
vi.mock('./subjects', () => ({ bindingsForContact: ref.bindings }));
vi.mock('./locks', () => ({ lockContact: vi.fn(), withSubjectLocks: (_db: unknown, _ids: unknown, f: () => unknown) => f() }));
vi.mock('./deviceSuggestions', () => ({ deviceSuggestions: vi.fn() }));
vi.mock('./ports', () => ({ callerVerificationPorts: { prepare: vi.fn(), available: vi.fn(), deliver: vi.fn() } }));
vi.mock('../permissions', async (original) => ({ ...await original<typeof import('../permissions')>(), getUserPermissions: ref.perms }));
// The factory test stubs the live check; the eligibility tests run the real one.
vi.mock('./administrative', async (original) => {
  const actual = await original<typeof import('./administrative')>();
  return { ...actual, administrativeEligible: (...a: Parameters<typeof actual.administrativeEligible>) => (ref.stub ? ref.eligible(...a) : actual.administrativeEligible(...a)) };
});
vi.mock('../mfaStepUpGrant', async (original) => ({
  ...await original<typeof import('../mfaStepUpGrant')>(), consumeStepUpGrant: ref.consume,
}));

import { makeDbMock } from './testing';
import { resolveEffectivePolicy } from './policy';
import { recordEffect } from './effects';
import { administrativeProofFor, withAdministrativeProof } from './administrativeContext';
import { administrativeEligible, administrativeEligibleForRow } from './administrative';
import { callerVerificationAdministrativeDigest } from '../mfaStepUpGrant';
import { createAdministrative } from './service';
import type { CallerVerificationActor, VerificationRow } from './types';

const org = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const bindingId = '44444444-4444-4444-8444-444444444444';
const actor: CallerVerificationActor = { userId: user, partnerId: null, scope: 'organization', accessibleOrgIds: [org], allowedSiteIds: null, displayName: 'Technician' };
const binding = { id: bindingId, orgId: org, contactId, entraTenantId: 'tenant-1', entraOid: 'oid-1', upnSnapshot: 'a@example.test', revokedAt: null };
const contact = { id: contactId, orgId: org, siteId: null, name: 'Alex' };
const reason = 'Confirmed employee offboarding with the authorized HR manager.';
const proof = { userId: user, sid: 'family-1', authEpoch: 2, mfaEpoch: 3 };
let state: ReturnType<typeof makeDbMock>;

beforeEach(() => {
  state = makeDbMock();
  ref.db = state.db;
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  ref.policy.mockResolvedValue({ ...resolveEffectivePolicy(null, null), allowAdministrativeDisable: true, maxAttemptsPerHour: 3 });
  ref.bindings.mockReset().mockResolvedValue([binding]);
  ref.eligible.mockReset();
  ref.consume.mockReset().mockResolvedValue(true);
  vi.mocked(recordEffect).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('administrative proof context', () => {
  it('requires an interactive proof context and does not leak it', async () => {
    expect(() => administrativeProofFor('u')).toThrow('Interactive step-up required');
    await withAdministrativeProof({ userId: 'u', sid: 'family', authEpoch: 2, mfaEpoch: 3 }, async () => {
      expect(administrativeProofFor('u').sid).toBe('family');
      expect(() => administrativeProofFor('other')).toThrow();
      await Promise.resolve();
      expect(administrativeProofFor('u').mfaEpoch).toBe(3);
    });
    expect(() => administrativeProofFor('u')).toThrow();
  });

  it('throws a validation error carrying interactive_stepup_required', () => {
    try { administrativeProofFor('u'); expect.unreachable(); } catch (e) {
      expect(e).toMatchObject({ code: 'interactive_stepup_required' });
    }
  });
});

describe('administrativeEligible (live checks)', () => {
  const base = { orgId: org, userId: user, sid: 'family-1', authEpoch: 2, mfaEpoch: 3, verifiedAt: new Date(), ttlMinutes: 30 };
  const goodPerms = { permissions: [{ resource: 'organizations', action: 'write' }, { resource: '*', action: '*' }], partnerId: null, orgId: org, roleId: 'r', scope: 'organization' };
  beforeEach(() => { ref.perms.mockReset().mockResolvedValue(goodPerms); });

  it('accepts a live family, equal epochs and a permitted user', async () => {
    state.results.push([{ authEpoch: 2, mfaEpoch: 3 }], [{ partnerId: 'p' }]);
    expect(await administrativeEligible(base)).toBe(true);
  });
  it('refuses a proof from the future, an expired proof and a non-finite proof without touching the db', async () => {
    expect(await administrativeEligible({ ...base, verifiedAt: new Date(Date.now() + 60_000) })).toBe(false);
    expect(await administrativeEligible({ ...base, verifiedAt: new Date(Date.now() - 31 * 60_000) })).toBe(false);
    expect(await administrativeEligible({ ...base, verifiedAt: new Date(NaN) })).toBe(false);
    expect(state.calls).toEqual([]);
  });
  it('refuses when the family/user join finds nothing (revoked, expired, inactive)', async () => {
    state.results.push([]);
    expect(await administrativeEligible(base)).toBe(false);
  });
  it('refuses when either live epoch moved', async () => {
    state.results.push([{ authEpoch: 3, mfaEpoch: 3 }]);
    expect(await administrativeEligible(base)).toBe(false);
    state.results.push([{ authEpoch: 2, mfaEpoch: 4 }]);
    expect(await administrativeEligible(base)).toBe(false);
  });
  it('refuses an unknown org and a user without permissions', async () => {
    state.results.push([{ authEpoch: 2, mfaEpoch: 3 }], []);
    expect(await administrativeEligible(base)).toBe(false);
    state.results.push([{ authEpoch: 2, mfaEpoch: 3 }], [{ partnerId: 'p' }]);
    ref.perms.mockResolvedValueOnce(null);
    expect(await administrativeEligible(base)).toBe(false);
  });
  it('refuses a user who lost ORGS_WRITE, lost org access, or has a different partner', async () => {
    state.results.push([{ authEpoch: 2, mfaEpoch: 3 }], [{ partnerId: 'p' }]);
    ref.perms.mockResolvedValueOnce({ ...goodPerms, permissions: [{ resource: 'organizations', action: 'read' }] });
    expect(await administrativeEligible(base)).toBe(false);
    state.results.push([{ authEpoch: 2, mfaEpoch: 3 }], [{ partnerId: 'p' }]);
    ref.perms.mockResolvedValueOnce({ ...goodPerms, orgId: 'other' });
    expect(await administrativeEligible(base)).toBe(false);
    state.results.push([{ authEpoch: 2, mfaEpoch: 3 }], [{ partnerId: 'p' }]);
    ref.perms.mockResolvedValueOnce({ ...goodPerms, scope: 'partner', partnerId: 'q', orgAccess: 'all' });
    expect(await administrativeEligible(base)).toBe(false);
  });
  it('row adapter refuses a row missing any stored proof field', async () => {
    const row = { orgId: org, initiatedByUserId: user, stepupSessionId: 'f', stepupAuthEpoch: 2, stepupMfaEpoch: 3, stepupVerifiedAt: new Date() } as VerificationRow;
    for (const patch of [{ initiatedByUserId: null }, { stepupSessionId: null }, { stepupAuthEpoch: null }, { stepupMfaEpoch: null }, { stepupVerifiedAt: null }]) {
      expect(await administrativeEligibleForRow({ ...row, ...patch } as unknown as VerificationRow)).toBe(false);
    }
    expect(state.calls).toEqual([]);
  });
  it('row adapter reads the policy TTL itself', async () => {
    ref.policy.mockResolvedValue({ ...resolveEffectivePolicy(null, null), verificationTtlMinutes: 1 });
    const row = { orgId: org, initiatedByUserId: user, stepupSessionId: 'f', stepupAuthEpoch: 2, stepupMfaEpoch: 3, stepupVerifiedAt: new Date(Date.now() - 5 * 60_000) } as VerificationRow;
    expect(await administrativeEligibleForRow(row)).toBe(false);
    expect(ref.policy).toHaveBeenCalledWith(org);
  });
});

describe('createAdministrative', () => {
  const input = { orgId: org, targetContactId: contactId, reason, stepUpGrantId: '55555555-5555-4555-8555-555555555555' };
  const expectedBind = {
    userId: user, operation: 'caller_verification_administrative_disable', sid: proof.sid, authEpoch: proof.authEpoch,
    mfaEpoch: proof.mfaEpoch,
    resourceDigest: callerVerificationAdministrativeDigest({ orgId: org, entraTenantId: 'tenant-1', entraOid: 'oid-1', reason }),
  };
  // The live-state check is a separate unit; stub it here so only the factory's ordering is under test.
  const run = (i = input) => withAdministrativeProof(proof, () => createAdministrative(actor, i));

  beforeEach(() => { ref.stub = true; ref.eligible.mockResolvedValue(true); });
  afterEach(() => { ref.stub = false; });

  it('refuses without an interactive proof context before any database work', async () => {
    await expect(createAdministrative(actor, input)).rejects.toMatchObject({ code: 'interactive_stepup_required' });
    expect(state.calls).toEqual([]);
    expect(ref.consume).not.toHaveBeenCalled();
  });

  it('refuses a proof context minted for a different user', async () => {
    await expect(withAdministrativeProof({ ...proof, userId: 'someone-else' }, () => createAdministrative(actor, input)))
      .rejects.toMatchObject({ code: 'interactive_stepup_required' });
  });

  it('rejects out-of-range reasons and a disabled policy', async () => {
    await expect(run({ ...input, reason: 'too short' })).rejects.toMatchObject({ code: 'invalid_reason' });
    await expect(run({ ...input, reason: 'x'.repeat(2001) })).rejects.toMatchObject({ code: 'invalid_reason' });
    ref.policy.mockResolvedValue({ ...resolveEffectivePolicy(null, null), allowAdministrativeDisable: false });
    state.results.push([contact]);
    await expect(run()).rejects.toMatchObject({ code: 'administrative_disabled' });
    expect(ref.consume).not.toHaveBeenCalled();
  });

  it('requires exactly one current binding', async () => {
    ref.bindings.mockResolvedValue([binding, { ...binding, id: 'b2' }]);
    state.results.push([contact]);
    await expect(run()).rejects.toMatchObject({ code: 'subject_unmatched' });
    ref.bindings.mockResolvedValue([{ ...binding, revokedAt: new Date() }]);
    state.results.push([contact]);
    await expect(run()).rejects.toMatchObject({ code: 'subject_unmatched' });
    expect(ref.consume).not.toHaveBeenCalled();
  });

  it('enforces the hourly cap BEFORE consuming the grant', async () => {
    state.results.push([contact], [{ count: 3 }]);
    await expect(run()).rejects.toMatchObject({ code: 'attempt_cap' });
    expect(ref.consume).not.toHaveBeenCalled();
    expect(ref.eligible).not.toHaveBeenCalled();
  });

  it('refuses a no-longer-live session BEFORE consuming the grant', async () => {
    ref.eligible.mockResolvedValue(false);
    state.results.push([contact], [{ count: 0 }]);
    await expect(run()).rejects.toMatchObject({ code: 'stepup_invalidated' });
    expect(ref.consume).not.toHaveBeenCalled();
  });

  it('consumes with the exact bind (operation, sid, epochs, digest) and maps a failed consume to stepup_invalidated', async () => {
    ref.consume.mockResolvedValue(false);
    state.results.push([contact], [{ count: 0 }]);
    await expect(run()).rejects.toMatchObject({ code: 'stepup_invalidated' });
    expect(ref.consume).toHaveBeenCalledWith(input.stepUpGrantId, expectedBind);
    expect(state.calls.some((c) => c.name === 'insert')).toBe(false);
  });

  it('binds a different reason, tenant or oid to a different digest (cross-resource grant cannot match)', async () => {
    const other = callerVerificationAdministrativeDigest({ orgId: org, entraTenantId: 'tenant-1', entraOid: 'oid-2', reason });
    expect(other).not.toBe(expectedBind.resourceDigest);
    expect(callerVerificationAdministrativeDigest({ orgId: org, entraTenantId: 'tenant-2', entraOid: 'oid-1', reason })).not.toBe(expectedBind.resourceDigest);
    expect(callerVerificationAdministrativeDigest({ orgId: org, entraTenantId: 'tenant-1', entraOid: 'oid-1', reason: `${reason} x` })).not.toBe(expectedBind.resourceDigest);
  });

  it('inserts a verified administrative row with proof fields and records the effect', async () => {
    const at = new Date();
    const row = { id: 'v1', orgId: org, contactId, method: 'administrative_stepup', status: 'verified', expiresAt: at, createdAt: at, decidedAt: at };
    state.results.push([contact], [{ count: 1 }], [row], [{ count: 2 }], []);
    await run();
    const values = state.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      orgId: org, contactId, requesterBindingId: null, targetBindingId: bindingId, method: 'administrative_stepup',
      status: 'verified', actionScope: 'disable_user', tier: 3, tierReason: 'administrative', reason,
      stepupSessionId: proof.sid, stepupAuthEpoch: proof.authEpoch, stepupMfaEpoch: proof.mfaEpoch,
      initiatedByUserId: user, attemptNo: 2,
    });
    expect(values.stepupVerifiedAt).toBeInstanceOf(Date);
    expect(recordEffect).toHaveBeenCalledWith(row, 'administrative_created', user);
  });
});
