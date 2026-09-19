import { describe, expect, it } from 'vitest';

import type { AuthContext } from '../middleware/auth';
import {
  captureSensitiveDataAuthority,
  captureSystemSensitiveDataAuthority,
  decodeSensitiveDataAuthority,
  type PersistedSensitiveDataAuthority,
  type SensitiveDataPolicyOwner,
} from './sensitiveDataPolicyAuthority';

const ORG = '11111111-1111-1111-1111-111111111111';
const PARTNER = '22222222-2222-2222-2222-222222222222';
const SITE_A = '33333333-3333-3333-3333-333333333333';
const SITE_B = '44444444-4444-4444-4444-444444444444';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization',
    user: { id: '55555555-5555-5555-5555-555555555555', email: 'actor@example.test', name: 'Actor' },
    orgId: ORG, partnerId: PARTNER, partnerOrgAccess: null,
    accessibleOrgIds: [ORG], orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === ORG,
    allowedSiteIds: [SITE_B, SITE_A, SITE_A],
    canAccessSite: (id: string | null) => id === SITE_A || id === SITE_B,
    ...overrides,
  } as unknown as AuthContext;
}

function row(owner: SensitiveDataPolicyOwner, overrides: Partial<PersistedSensitiveDataAuthority> = {}) {
  const captured = captureSensitiveDataAuthority(auth(), owner)!;
  return { ...owner, ...captured, ...overrides } as PersistedSensitiveDataAuthority;
}

describe('sensitive-data recurring execution authority', () => {
  it('normalizes and verifies an organization selected-site ceiling', () => {
    const decoded = decodeSensitiveDataAuthority(row({ orgId: ORG, partnerId: null }));
    expect(decoded).toMatchObject({
      kind: 'organization_restricted',
      siteIds: [SITE_A, SITE_B],
      principalKind: 'user',
    });
  });

  it('rejects a modified site ceiling and an owner-axis replay', () => {
    const original = row({ orgId: ORG, partnerId: null });
    expect(decodeSensitiveDataAuthority({ ...original, executionAuthoritySiteIds: [SITE_A] })).toBeNull();
    expect(decodeSensitiveDataAuthority({ ...original, orgId: null, partnerId: PARTNER })).toBeNull();
    expect(decodeSensitiveDataAuthority({
      ...original,
      executionAuthorityGeneration: '66666666-6666-4666-8666-666666666666',
    })).toBeNull();
  });

  it('mints a collision-safe generation and fingerprint on every approval', () => {
    const first = captureSensitiveDataAuthority(auth(), { orgId: ORG, partnerId: null })!;
    const second = captureSensitiveDataAuthority(auth(), { orgId: ORG, partnerId: null })!;
    expect(first.executionAuthorityGeneration).not.toBe(second.executionAuthorityGeneration);
    expect(first.executionAuthorityFingerprint).not.toBe(second.executionAuthorityFingerprint);
  });

  it('fails closed for malformed principal, fingerprint, and site-ceiling shapes', () => {
    const original = row({ orgId: ORG, partnerId: null });
    expect(decodeSensitiveDataAuthority({
      ...original,
      executionAuthorityPrincipalKind: 'system',
    })).toBeNull();
    expect(decodeSensitiveDataAuthority({
      ...original,
      executionAuthorityFingerprint: '0'.repeat(64),
    })).toBeNull();
    expect(decodeSensitiveDataAuthority({
      ...original,
      executionAuthoritySiteIds: [],
    })).toBeNull();

    const unrestricted = row(
      { orgId: ORG, partnerId: null },
      captureSensitiveDataAuthority(auth({ allowedSiteIds: undefined }), { orgId: ORG, partnerId: null })!,
    );
    expect(decodeSensitiveDataAuthority({
      ...unrestricted,
      executionAuthoritySiteIds: [SITE_A],
    })).toBeNull();
  });

  it('permits partner-wide capture only for full-partner and keeps HTTP system users creator-bound', () => {
    const owner = { orgId: null, partnerId: PARTNER } as const;
    expect(captureSensitiveDataAuthority(auth({ scope: 'partner', partnerOrgAccess: 'selected' }), owner)).toBeNull();
    expect(captureSensitiveDataAuthority(auth({ scope: 'partner', partnerOrgAccess: 'all' }), owner))
      .toMatchObject({ executionAuthorityKind: 'partner_unrestricted', executionAuthorityPrincipalKind: 'user' });
    expect(captureSensitiveDataAuthority(auth({ scope: 'system' }), owner))
      .toMatchObject({
        executionAuthorityKind: 'partner_unrestricted',
        executionAuthorityPrincipalKind: 'user',
        executionAuthorityUserId: '55555555-5555-5555-5555-555555555555',
      });
    expect(captureSystemSensitiveDataAuthority(owner))
      .toMatchObject({ executionAuthorityKind: 'partner_unrestricted', executionAuthorityPrincipalKind: 'system' });
  });
});
