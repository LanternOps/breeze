import { describe, expect, it, vi, beforeEach } from 'vitest';

const hasPermission = vi.fn();
vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  hasPermission: (...a: unknown[]) => hasPermission(...a),
}));
const getDeciderPermissionsForOrg = vi.fn();
vi.mock('./deciderPermissions', () => ({
  getDeciderPermissionsForOrg: (...a: unknown[]) => getDeciderPermissionsForOrg(...a),
}));
vi.mock('../../routes/auth/schemas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../routes/auth/schemas')>()),
  ENABLE_2FA: true,
}));

import { resolveStrictAcknowledgement } from './strictAcknowledgement';

const STRICT = ['PowerShell HKLM write', 'Credential dump utility'];
const auth = (mfa: boolean) => ({
  user: { id: '22222222-2222-4222-8222-222222222222' }, scope: 'organization',
  orgId: '11111111-1111-4111-8111-111111111111', partnerId: null, token: { mfa },
}) as never;
const proposal = { strictHits: STRICT, orgId: '11111111-1111-4111-8111-111111111111' };

beforeEach(() => { vi.clearAllMocks(); getDeciderPermissionsForOrg.mockResolvedValue({}); hasPermission.mockReturnValue(true); });

describe('resolveStrictAcknowledgement', () => {
  it('is a no-op pass when the proposal has no strict hits', async () => {
    expect(await resolveStrictAcknowledgement({ auth: auth(false), proposal: { ...proposal, strictHits: [] }, submitted: [] }))
      .toEqual({ ok: true, acknowledged: [] });
    expect(hasPermission).not.toHaveBeenCalled();
    expect(getDeciderPermissionsForOrg).not.toHaveBeenCalled();
  });

  it('refuses a decider without scripts:write', async () => {
    hasPermission.mockReturnValue(false);
    expect(await resolveStrictAcknowledgement({ auth: auth(true), proposal, submitted: STRICT }))
      .toEqual({ ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'scripts:write' });
  });

  it('refuses a decider whose permissions cannot be resolved for the proposal org', async () => {
    getDeciderPermissionsForOrg.mockResolvedValue(null);
    expect(await resolveStrictAcknowledgement({ auth: auth(true), proposal, submitted: STRICT }))
      .toEqual({ ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'scripts:write' });
  });

  it('refuses a decider without a fresh MFA claim, before touching permissions', async () => {
    expect(await resolveStrictAcknowledgement({ auth: auth(false), proposal, submitted: STRICT }))
      .toEqual({ ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'mfa' });
    expect(getDeciderPermissionsForOrg).not.toHaveBeenCalled();
  });

  it('takes the second factor the decide core established for this decision', async () => {
    expect(await resolveStrictAcknowledgement({
      auth: auth(false), secondFactorSatisfied: true, proposal, submitted: STRICT,
    })).toEqual({ ok: true, acknowledged: STRICT });
    expect(await resolveStrictAcknowledgement({
      auth: auth(true), secondFactorSatisfied: false, proposal, submitted: STRICT,
    })).toEqual({ ok: false, error: 'strict_acknowledgement_not_permitted', requirement: 'mfa' });
  });

  it('resolves permissions for the PROPOSAL org, not the token org', async () => {
    await resolveStrictAcknowledgement({
      auth: { ...(auth(true) as object), orgId: 'other-org' } as never, proposal, submitted: STRICT,
    });
    expect(getDeciderPermissionsForOrg).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222', proposal.orgId,
    );
  });

  it('intersects the submitted set with strict_hits and drops unmatched entries', async () => {
    const r = await resolveStrictAcknowledgement({
      auth: auth(true), proposal, submitted: [...STRICT, 'Something the content does not match'],
    });
    expect(r).toEqual({ ok: true, acknowledged: STRICT });
  });

  it('refuses a partial acknowledgement and names what is missing', async () => {
    expect(await resolveStrictAcknowledgement({ auth: auth(true), proposal, submitted: [STRICT[0]!] }))
      .toEqual({ ok: false, error: 'strict_acknowledgement_incomplete', missing: [STRICT[1]] });
  });
});
