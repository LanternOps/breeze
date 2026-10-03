import { describe, expect, it } from 'vitest';
import {
  completeConsentRequestSchema,
  completeConsentResultSchema,
  executorFailureCodeSchema,
  retestRequestSchema,
  retestResultSchema,
  verifyConsentIdentityRequestSchema,
  verifyConsentIdentityResultSchema,
} from './executorContracts';

const COMPLETE_CONSENT_REQUEST = {
  correlationId: '11111111-1111-4111-8111-111111111111',
  consentAttemptId: '22222222-2222-4222-8222-222222222222',
  tenantHint: '33333333-3333-4333-8333-333333333333',
  authorizationCode: 'authorization-code',
  codeVerifier: 'v'.repeat(43),
  nonce: 'identity-nonce',
  redirectUri: 'https://api.example.com/api/v1/m365/consent/callback',
} as const;

const RETEST_REQUEST = {
  correlationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '33333333-3333-4333-8333-333333333333',
} as const;

const OBSERVED_GRANT = {
  resourceApplicationId: '00000003-0000-0000-c000-000000000000',
  appRoleId: 'df021288-bdef-4463-88db-98f22de89214',
  value: 'User.Read.All',
} as const;

const VERIFIED_RESULT = {
  success: true,
  tenantId: '33333333-3333-4333-8333-333333333333',
  applicationId: '44444444-4444-4444-8444-444444444444',
  organizationDisplayName: 'Example Organization',
  manifestVersion: 2,
  verifiedAt: '2026-07-14T18:30:00.000Z',
} as const;

describe('M365 executor request schemas', () => {
  it('accepts only the complete-consent request contract', () => {
    expect(completeConsentRequestSchema.safeParse(COMPLETE_CONSENT_REQUEST).success).toBe(true);
    expect(
      completeConsentRequestSchema.safeParse({
        ...COMPLETE_CONSENT_REQUEST,
        clientId: 'not-allowed',
      }).success,
    ).toBe(false);
    expect(
      completeConsentRequestSchema.safeParse({
        ...COMPLETE_CONSENT_REQUEST,
        authorizationCode: '',
      }).success,
    ).toBe(false);
  });

  it('accepts only the retest request contract', () => {
    expect(retestRequestSchema.safeParse(RETEST_REQUEST).success).toBe(true);
    expect(
      retestRequestSchema.safeParse({
        ...RETEST_REQUEST,
        scopes: ['https://graph.microsoft.com/.default'],
      }).success,
    ).toBe(false);
    expect(
      retestRequestSchema.safeParse({
        ...RETEST_REQUEST,
        tenantId: 'not-a-guid',
      }).success,
    ).toBe(false);
  });
});

describe('M365 executor result schemas', () => {
  it('accepts every stable executor failure code and rejects unknown codes', () => {
    const codes = [
      'admin_role_required',
      'tenant_mismatch',
      'credential_unavailable',
      'identity_token_invalid',
      'application_token_invalid',
      'organization_probe_failed',
    ] as const;

    for (const code of codes) {
      expect(executorFailureCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(executorFailureCodeSchema.safeParse('executor_unavailable').success).toBe(false);
  });

  it('accepts a complete-consent result with complete grant reconciliation', () => {
    const result = {
      ...VERIFIED_RESULT,
      administratorObjectId: '55555555-5555-4555-8555-555555555555',
      grantReconciliation: 'complete',
      observedGrants: [OBSERVED_GRANT],
      missingGrants: [],
      unexpectedGrants: [],
      grantsVerifiedAt: '2026-07-14T18:30:00.000Z',
    } as const;

    expect(completeConsentResultSchema.safeParse(result).success).toBe(true);
    expect(retestResultSchema.safeParse(result).success).toBe(false);
  });

  it('accepts a retest result with complete grant reconciliation', () => {
    const result = {
      ...VERIFIED_RESULT,
      grantReconciliation: 'complete',
      observedGrants: [OBSERVED_GRANT],
      missingGrants: [],
      unexpectedGrants: [],
      grantsVerifiedAt: '2026-07-14T18:30:00.000Z',
    } as const;

    expect(retestResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts verified tenant proof when grant reconciliation is unavailable', () => {
    const result = {
      ...VERIFIED_RESULT,
      grantReconciliation: 'unavailable',
      errorCode: 'grant_reconciliation_unavailable',
      observedGrants: null,
      missingGrants: null,
      unexpectedGrants: null,
      grantsVerifiedAt: null,
    } as const;

    expect(retestResultSchema.safeParse(result).success).toBe(true);
  });

  it('accepts typed failures and rejects unknown response fields', () => {
    expect(
      completeConsentResultSchema.safeParse({
        success: false,
        errorCode: 'admin_role_required',
      }).success,
    ).toBe(true);
    expect(
      retestResultSchema.safeParse({
        success: false,
        errorCode: 'organization_probe_failed',
        providerDescription: 'sensitive provider body',
      }).success,
    ).toBe(false);
  });
});

const GUID_A = '11111111-1111-4111-8111-111111111111';
const GUID_B = '22222222-2222-4222-8222-222222222222';

function verifyRequest(overrides: Record<string, unknown> = {}) {
  return {
    correlationId: GUID_A,
    consentAttemptId: GUID_B,
    expectedTenantId: null,
    authorizationCode: 'code',
    codeVerifier: 'v'.repeat(43),
    nonce: 'n',
    redirectUri: 'https://breeze.example/api/v1/m365/consent/callback',
    ...overrides,
  };
}

const VERIFIED_IDENTITY = {
  success: true,
  tenantId: GUID_A,
  administratorObjectId: GUID_B,
  administratorUsername: 'admin@tenant.example',
  verifiedAt: '2026-10-03T12:00:00.000Z',
} as const;

describe('verify-identity contract', () => {
  it('accepts a null expected tenant (organizations authority) and a GUID', () => {
    expect(verifyConsentIdentityRequestSchema.safeParse(verifyRequest()).success).toBe(true);
    expect(verifyConsentIdentityRequestSchema.safeParse(verifyRequest({ expectedTenantId: GUID_A })).success).toBe(true);
  });

  it('rejects the literal organizations, a domain, a missing key, and extra keys', () => {
    for (const expectedTenantId of ['organizations', 'common', 'contoso.example', '']) {
      expect(verifyConsentIdentityRequestSchema.safeParse(verifyRequest({ expectedTenantId })).success).toBe(false);
    }
    const { expectedTenantId: _omit, ...missing } = verifyRequest();
    expect(verifyConsentIdentityRequestSchema.safeParse(missing).success).toBe(false);
    expect(verifyConsentIdentityRequestSchema.safeParse(verifyRequest({ tenantHint: GUID_A })).success).toBe(false);
  });

  it('rejects malformed code, verifier, nonce, redirect URI and correlation id', () => {
    for (const overrides of [
      { authorizationCode: '' },
      { codeVerifier: 'v'.repeat(42) },
      { codeVerifier: 'v'.repeat(129) },
      { nonce: '' },
      { redirectUri: 'not a url' },
      { correlationId: 'not-a-guid' },
      { consentAttemptId: 'not-a-guid' },
    ]) {
      expect(verifyConsentIdentityRequestSchema.safeParse(verifyRequest(overrides)).success).toBe(false);
    }
  });

  it('accepts only identity-scoped success and failure results', () => {
    expect(verifyConsentIdentityResultSchema.safeParse(VERIFIED_IDENTITY).success).toBe(true);
    expect(verifyConsentIdentityResultSchema.safeParse({
      ...VERIFIED_IDENTITY, administratorUsername: null,
    }).success).toBe(true);
    for (const errorCode of ['admin_role_required', 'tenant_mismatch', 'credential_unavailable', 'identity_token_invalid']) {
      expect(verifyConsentIdentityResultSchema.safeParse({ success: false, errorCode }).success).toBe(true);
    }
    // application-proof failures belong to retest, never to identity
    expect(verifyConsentIdentityResultSchema.safeParse({ success: false, errorCode: 'application_token_invalid' }).success).toBe(false);
    expect(verifyConsentIdentityResultSchema.safeParse({ success: false, errorCode: 'organization_probe_failed' }).success).toBe(false);
    // no grant/probe fields on an identity result
    expect(verifyConsentIdentityResultSchema.safeParse({ ...VERIFIED_IDENTITY, observedGrants: [] }).success).toBe(false);
  });

  it('never carries a token on an identity result', () => {
    for (const field of ['idToken', 'id_token', 'accessToken', 'authorizationCode']) {
      expect(verifyConsentIdentityResultSchema.safeParse({ ...VERIFIED_IDENTITY, [field]: 'secret' }).success).toBe(false);
    }
  });

  it('bounds the administrator username', () => {
    expect(verifyConsentIdentityResultSchema.safeParse({ ...VERIFIED_IDENTITY, administratorUsername: '' }).success).toBe(false);
    expect(verifyConsentIdentityResultSchema.safeParse({ ...VERIFIED_IDENTITY, administratorUsername: 'x'.repeat(257) }).success).toBe(false);
  });
});
