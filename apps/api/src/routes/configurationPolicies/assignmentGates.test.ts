import { describe, it, expect, vi, beforeEach } from 'vitest';

const { canManagePartnerWideMock, mfaState } = vi.hoisted(() => ({
  canManagePartnerWideMock: vi.fn(),
  mfaState: { satisfied: true },
}));

// Mocked on the module the single POST's tests mock it on, so the gate module
// must read it from there too (a different import path would bypass the mock).
vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return { ...original, canManagePartnerWidePolicies: canManagePartnerWideMock };
});
vi.mock('../../middleware/auth', () => ({
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));

import { checkAddArming, checkAddLevel, checkPolicyAssignableBy } from './assignmentGates';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/configurationPolicy';
import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '66666666-6666-6666-6666-666666666666';

const AUTH = { scope: 'partner', partnerId: PARTNER_ID, orgId: null, user: { id: 'user-1' }, token: {} } as any;
const WRITE_ONLY = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
const EXECUTE = { permissions: [{ resource: 'devices', action: 'execute' }] } as any;

const BRANDED_HELPER = { featureType: 'helper', inlineSettings: { enabled: true, branding: { displayName: 'Example Assist' } } };
const COLLECTING_LINK = {
  id: 'link-1',
  featureType: 'warranty',
  inlineSettings: {
    hpCmsl: { enabled: true, consent: { acceptedByUserId: 'user-1', acceptedAt: '2026-09-10T00:00:00.000Z', eulaId: HP_CMSL_EULA_ID } },
  },
};
const ARMED_OEM = {
  id: 'oem-link',
  featureType: 'oem_updates',
  inlineSettings: {
    version: 1, enabled: true,
    schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
    catchUpNights: 7, reboot: 'overnight',
    vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
  },
};

function policy(over: Record<string, unknown> = {}): any {
  return {
    id: 'policy-1', orgId: ORG_ID, partnerId: null, name: 'P',
    parentPolicyId: null, parentPolicy: null, featureLinks: [], ...over,
  };
}

describe('assignment gates (one module for the single POST and Apply)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaState.satisfied = true;
    canManagePartnerWideMock.mockReturnValue(true);
  });

  describe('checkPolicyAssignableBy', () => {
    it('refuses a partner-owned policy without full partner access', () => {
      canManagePartnerWideMock.mockReturnValue(false);
      const result = checkPolicyAssignableBy(AUTH, policy({ orgId: null, partnerId: PARTNER_ID }));
      expect(result).toEqual({ ok: false, status: 403, body: { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE } });
      expect(canManagePartnerWideMock).toHaveBeenCalledWith(AUTH);
    });

    it('admits a partner-owned policy with full partner access', () => {
      expect(checkPolicyAssignableBy(AUTH, policy({ orgId: null, partnerId: PARTNER_ID }))).toEqual({ ok: true });
    });

    it('never consults the partner capability for an org-owned policy', () => {
      canManagePartnerWideMock.mockReturnValue(false);
      expect(checkPolicyAssignableBy(AUTH, policy())).toEqual({ ok: true });
      expect(canManagePartnerWideMock).not.toHaveBeenCalled();
    });
  });

  describe('checkAddLevel (helper branding)', () => {
    it.each(['site', 'device_group', 'device'] as const)('refuses a %s add on a branded policy with 409', (level) => {
      const result = checkAddLevel(policy({ featureLinks: [BRANDED_HELPER] }), level);
      expect(result).toMatchObject({ ok: false, status: 409 });
      if (!result.ok) expect(result.body.error).toMatch(/Helper branding/);
    });

    it.each(['partner', 'organization'] as const)('admits a %s add on a branded policy', (level) => {
      expect(checkAddLevel(policy({ featureLinks: [BRANDED_HELPER] }), level)).toEqual({ ok: true });
    });

    it('admits a site add when the helper link carries no branding', () => {
      const helper = { featureType: 'helper', inlineSettings: { enabled: true } };
      expect(checkAddLevel(policy({ featureLinks: [helper] }), 'site')).toEqual({ ok: true });
    });
  });

  describe('checkAddArming', () => {
    it('admits a policy that arms nothing for a write-only caller', () => {
      expect(checkAddArming(AUTH, WRITE_ONLY, policy())).toEqual({ ok: true });
    });

    it('refuses an own HP CMSL collecting link without execute', () => {
      const result = checkAddArming(AUTH, WRITE_ONLY, policy({ featureLinks: [COLLECTING_LINK] }));
      expect(result).toMatchObject({ ok: false, status: 403, body: { code: 'HP_CMSL_EXECUTE_REQUIRED' } });
    });

    it('refuses an inherited HP CMSL collecting link without execute', () => {
      const result = checkAddArming(AUTH, WRITE_ONLY, policy({
        parentPolicyId: 'parent', parentPolicy: { id: 'parent', featureLinks: [COLLECTING_LINK] },
      }));
      expect(result).toMatchObject({ ok: false, status: 403, body: { code: 'HP_CMSL_EXECUTE_REQUIRED' } });
    });

    it('an own collection-off warranty link overrides a collecting parent', () => {
      const own = { id: 'own', featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: false } } };
      expect(checkAddArming(AUTH, WRITE_ONLY, policy({
        parentPolicyId: 'parent', featureLinks: [own], parentPolicy: { id: 'parent', featureLinks: [COLLECTING_LINK] },
      }))).toEqual({ ok: true });
    });

    it('an unresolvable parent fails closed', () => {
      const result = checkAddArming(AUTH, WRITE_ONLY, policy({ parentPolicyId: 'parent', parentPolicy: null }));
      expect(result).toMatchObject({ ok: false, status: 403, body: { code: 'HP_CMSL_EXECUTE_REQUIRED' } });
    });

    it('refuses armed oem_updates without execute', () => {
      const result = checkAddArming(AUTH, WRITE_ONLY, policy({ featureLinks: [ARMED_OEM] }));
      expect(result).toMatchObject({ ok: false, status: 403, body: { code: 'oem_updates_execute_required' } });
    });

    it('refuses armed oem_updates with execute but no MFA', () => {
      mfaState.satisfied = false;
      const result = checkAddArming(AUTH, EXECUTE, policy({ featureLinks: [ARMED_OEM] }));
      expect(result).toMatchObject({ ok: false, status: 403, body: { code: 'MFA_REQUIRED' } });
    });

    it('admits armed oem_updates and HP CMSL with execute and MFA', () => {
      expect(checkAddArming(AUTH, EXECUTE, policy({ featureLinks: [ARMED_OEM, COLLECTING_LINK] }))).toEqual({ ok: true });
    });

    it('fails closed when permissions were never resolved', () => {
      const result = checkAddArming(AUTH, undefined, policy({ featureLinks: [ARMED_OEM] }));
      expect(result).toMatchObject({ ok: false, status: 403 });
    });
  });
});
