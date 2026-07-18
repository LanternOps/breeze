import { describe, expect, it, vi } from 'vitest';
import { completeConsentOperation, readActionOperation, retestOperation } from './operations';
import { MicrosoftTokenClientError } from './microsoft/tokenClient';
import { executeGraphReadAction } from './microsoft/readActions';

vi.mock('./microsoft/readActions', () => ({
  executeGraphReadAction: vi.fn(),
}));

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const CALLBACK_URL = 'https://console.example.test/api/v1/m365/consent/callback';
const READ_ACTION_CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

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
    graphClient: {
      probeTenant: vi.fn().mockResolvedValue({ tenantId: TENANT_ID, applicationId: CLIENT_ID, organizationDisplayName: 'Example', observedGrants: null, ...observation }),
      readResource: vi.fn(),
      readCollection: vi.fn(),
    },
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

describe('readActionOperation', () => {
  const action = { type: 'm365.org.get' } as const;

  it('rejects a malformed tenant id without contacting Graph', async () => {
    const deps = dependencies();
    const result = await readActionOperation({
      correlationId: READ_ACTION_CORRELATION_ID,
      tenantId: 'not-a-guid',
      action,
    }, deps);
    expect(result).toEqual({ success: false, errorCode: 'graph_response_invalid' });
    expect(deps.certificateProvider.getConfiguredCertificate).not.toHaveBeenCalled();
    expect(executeGraphReadAction).not.toHaveBeenCalled();
  });

  it('maps a credential provider failure to credential_unavailable', async () => {
    const deps = dependencies();
    deps.certificateProvider.getConfiguredCertificate.mockRejectedValue(new Error('vault unavailable'));
    const result = await readActionOperation({
      correlationId: READ_ACTION_CORRELATION_ID,
      tenantId: TENANT_ID,
      action,
    }, deps);
    expect(result).toEqual({ success: false, errorCode: 'credential_unavailable' });
  });

  it('maps an application token failure from acquireGraphAppToken to application_token_invalid', async () => {
    const deps = dependencies();
    deps.createTokenClient.mockReturnValue({
      exchangeAuthorizationCode: vi.fn(),
      acquireGraphAppToken: vi.fn().mockRejectedValue(new MicrosoftTokenClientError('token_provider_rejected')),
    });
    const result = await readActionOperation({
      correlationId: READ_ACTION_CORRELATION_ID,
      tenantId: TENANT_ID,
      action,
    }, deps);
    expect(result).toEqual({ success: false, errorCode: 'application_token_invalid' });
  });

  it('returns the stubbed executeGraphReadAction result verbatim and requests the token for the request tenant', async () => {
    const deps = dependencies();
    const stubbedResult = { success: true as const, kind: 'resource' as const, resource: { id: TENANT_ID } };
    vi.mocked(executeGraphReadAction).mockResolvedValue(stubbedResult);
    const result = await readActionOperation({
      correlationId: READ_ACTION_CORRELATION_ID,
      tenantId: TENANT_ID,
      action,
    }, deps);
    expect(result).toEqual(stubbedResult);
    const tokenClient = deps.createTokenClient.mock.results[0]?.value;
    expect(tokenClient.acquireGraphAppToken).toHaveBeenCalledWith({ tenantId: TENANT_ID });
  });

  it('scrubs the certificate PEM fields after completion', async () => {
    const deps = dependencies();
    vi.mocked(executeGraphReadAction).mockResolvedValue({
      success: true, kind: 'resource', resource: { id: TENANT_ID },
    });
    const credential = { certificatePem: 'cert', privateKeyPem: 'key' };
    deps.certificateProvider.getConfiguredCertificate.mockResolvedValue(credential);
    await readActionOperation({
      correlationId: READ_ACTION_CORRELATION_ID,
      tenantId: TENANT_ID,
      action,
    }, deps);
    expect(credential.certificatePem).toBe('');
    expect(credential.privateKeyPem).toBe('');
  });
});
