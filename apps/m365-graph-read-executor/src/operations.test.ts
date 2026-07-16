import { describe, expect, it, vi } from 'vitest';
import { completeConsentOperation, retestOperation } from './operations';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const CALLBACK_URL = 'https://console.example.test/api/v1/m365/consent/callback';

function dependencies(observation: Record<string, unknown> = {}) {
  return {
    clientId: CLIENT_ID,
    callbackUrl: CALLBACK_URL,
    certificateProvider: { getConfiguredCertificate: vi.fn().mockResolvedValue({ certificatePem: 'cert', privateKeyPem: 'key' }) },
    createTokenClient: vi.fn().mockReturnValue({
      exchangeAuthorizationCode: vi.fn().mockResolvedValue('identity-token'),
      acquireGraphAppToken: vi.fn().mockResolvedValue('access-token'),
    }),
    verifyIdentity: vi.fn().mockResolvedValue({ tenantId: TENANT_ID, administratorObjectId: '55555555-5555-4555-8555-555555555555' }),
    graphClient: { probeTenant: vi.fn().mockResolvedValue({ tenantId: TENANT_ID, applicationId: CLIENT_ID, organizationDisplayName: 'Example', observedGrants: null, ...observation }) },
  };
}

describe('executor operations', () => {
  it('preserves verified tenant proof when grant reconciliation is unavailable', async () => {
    const result = await completeConsentOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      consentAttemptId: '22222222-2222-4222-8222-222222222222',
      tenantHint: TENANT_ID,
      authorizationCode: 'authorization-code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'nonce',
      redirectUri: CALLBACK_URL,
    }, dependencies());

    expect(result).toMatchObject({
      success: true,
      tenantId: TENANT_ID,
      applicationId: CLIENT_ID,
      organizationDisplayName: 'Example',
      manifestVersion: 2,
      grantReconciliation: 'unavailable',
      errorCode: 'grant_reconciliation_unavailable',
      observedGrants: null,
      missingGrants: null,
      unexpectedGrants: null,
      grantsVerifiedAt: null,
      administratorObjectId: '55555555-5555-4555-8555-555555555555',
    });
  });

  it('fails closed when the application proof does not match the fixed configured app', async () => {
    const result = await retestOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT_ID,
    }, dependencies({ applicationId: '66666666-6666-4666-8666-666666666666' }));

    expect(result).toEqual({ success: false, errorCode: 'application_token_invalid' });
  });

  it('maps credential provider details to the stable credential code only', async () => {
    const deps = dependencies();
    deps.certificateProvider.getConfiguredCertificate.mockRejectedValue(
      new Error('secret value at akv://vault/private-version'),
    );
    const result = await retestOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT_ID,
    }, deps);
    expect(result).toEqual({ success: false, errorCode: 'credential_unavailable' });
    expect(JSON.stringify(result)).not.toMatch(/secret|vault|private/i);
  });

  it('maps an unusable certificate to credential unavailable without leaking material', async () => {
    const deps = dependencies();
    deps.createTokenClient.mockImplementation(() => {
      throw new Error('private key parse failed: private-key-material');
    });
    const result = await retestOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT_ID,
    }, deps);
    expect(result).toEqual({ success: false, errorCode: 'credential_unavailable' });
    expect(JSON.stringify(result)).not.toContain('private-key-material');
  });
});
