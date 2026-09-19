import { describe, it, expect, vi } from 'vitest';

const { mfaState } = vi.hoisted(() => ({ mfaState: { satisfied: true } }));

vi.mock('../../middleware/auth', () => ({
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));

import { checkHpCmslWriteAllowed, warrantyLinkEnablesCollection } from './hpCmslGate';
import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';

const CONSENT = {
  acceptedByUserId: 'user-1',
  acceptedAt: '2026-09-10T00:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

const auth = { token: { mfa: true } } as any;
const perms = (grants: Array<{ resource: string; action: string }>) =>
  ({ permissions: grants } as any);

const EXECUTE = [{ resource: 'devices', action: 'execute' }];
const WRITE_ONLY = [{ resource: 'devices', action: 'write' }];

describe('checkHpCmslWriteAllowed', () => {
  it('allows a caller with devices.execute and satisfied MFA', () => {
    mfaState.satisfied = true;
    expect(checkHpCmslWriteAllowed(auth, perms(EXECUTE))).toEqual({ allowed: true });
  });

  it('denies devices.write-only with a coded body, not an MFA message', () => {
    mfaState.satisfied = true;
    const res = checkHpCmslWriteAllowed(auth, perms(WRITE_ONLY));
    expect(res.allowed).toBe(false);
    expect(res).toMatchObject({ body: { code: 'HP_CMSL_EXECUTE_REQUIRED' } });
  });

  it('denies an execute-capable caller who has not satisfied MFA, with the MFA_REQUIRED code', () => {
    mfaState.satisfied = false;
    const res = checkHpCmslWriteAllowed(auth, perms(EXECUTE));
    expect(res.allowed).toBe(false);
    expect(res).toMatchObject({ body: { error: 'MFA required', code: 'MFA_REQUIRED' } });
  });

  it('fails closed when permissions were never resolved', () => {
    mfaState.satisfied = true;
    expect(checkHpCmslWriteAllowed(auth, undefined).allowed).toBe(false);
  });
});

describe('warrantyLinkEnablesCollection', () => {
  it('is true for a warranty link with a current consent', () => {
    expect(
      warrantyLinkEnablesCollection([
        { featureType: 'patch', inlineSettings: {} },
        { featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: true, consent: CONSENT } } },
      ]),
    ).toBe(true);
  });

  it('is false with no warranty link, a disabled block, or no links at all', () => {
    expect(warrantyLinkEnablesCollection([{ featureType: 'patch', inlineSettings: {} }])).toBe(false);
    expect(
      warrantyLinkEnablesCollection([{ featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: false } } }]),
    ).toBe(false);
    expect(warrantyLinkEnablesCollection([])).toBe(false);
    expect(warrantyLinkEnablesCollection(undefined)).toBe(false);
  });
});
