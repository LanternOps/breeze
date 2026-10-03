import { describe, expect, it, vi } from 'vitest';
import type { CompleteConsentRequest, VerifyConsentIdentityRequest } from '@breeze/shared/m365';
import { GraphClientError } from './microsoft/graphClient';
import { MicrosoftIdentityFailure } from './microsoft/identity';
import { MicrosoftTokenClientError } from './microsoft/tokenClient';
import {
  completeConsentOperation,
  createExecutorOperations,
  verifyIdentityOperation,
  type ExecutorOperationDependencies,
} from './operations';

// Same file in both Customer Graph executors (read + actions): the identity
// phase is credential-domain-local but behaviorally identical.

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const CALLBACK_URL = 'https://console.example.test/api/v1/m365/consent/callback';

function dependencies() {
  const tokenClient = {
    exchangeAuthorizationCode: vi.fn().mockResolvedValue('identity-token'),
    acquireGraphAppToken: vi.fn().mockResolvedValue('access-token'),
  };
  const credential = { certificatePem: 'cert', privateKeyPem: 'key' };
  const deps = {
    clientId: CLIENT_ID,
    callbackUrl: CALLBACK_URL,
    certificateProvider: { getConfiguredCertificate: vi.fn().mockResolvedValue(credential) },
    createTokenClient: vi.fn().mockReturnValue(tokenClient),
    verifyIdentity: vi.fn().mockResolvedValue({
      tenantId: TENANT_ID,
      administratorObjectId: ADMIN_ID,
      administratorUsername: 'admin@tenant.example',
    }),
    graphClient: {
      probeTenant: vi.fn().mockResolvedValue({
        tenantId: TENANT_ID,
        applicationId: CLIENT_ID,
        organizationDisplayName: 'Example',
        observedGrants: null,
      }),
    },
  };
  return { deps, tokenClient, credential };
}

function asDeps(deps: ReturnType<typeof dependencies>['deps']): ExecutorOperationDependencies {
  return deps as unknown as ExecutorOperationDependencies;
}

function verifyRequest(overrides: Partial<VerifyConsentIdentityRequest> = {}): VerifyConsentIdentityRequest {
  return {
    correlationId: CORRELATION_ID,
    consentAttemptId: '66666666-6666-4666-8666-666666666666',
    expectedTenantId: null,
    authorizationCode: 'authorization-code',
    codeVerifier: 'v'.repeat(43),
    nonce: 'nonce',
    redirectUri: CALLBACK_URL,
    ...overrides,
  };
}

function completeRequest(overrides: Partial<CompleteConsentRequest> = {}): CompleteConsentRequest {
  return {
    correlationId: CORRELATION_ID,
    consentAttemptId: '66666666-6666-4666-8666-666666666666',
    tenantHint: TENANT_ID,
    authorizationCode: 'authorization-code',
    codeVerifier: 'v'.repeat(43),
    nonce: 'nonce',
    redirectUri: CALLBACK_URL,
    ...overrides,
  };
}

describe('verifyIdentityOperation', () => {
  it('redeems at organizations when no tenant is expected and returns only the verified identity', async () => {
    const { deps, tokenClient } = dependencies();
    const result = await verifyIdentityOperation(verifyRequest(), asDeps(deps));

    expect(tokenClient.exchangeAuthorizationCode).toHaveBeenCalledWith({
      authority: 'organizations',
      code: 'authorization-code',
      codeVerifier: 'v'.repeat(43),
    });
    expect(deps.verifyIdentity).toHaveBeenCalledWith('identity-token', {
      expectedTenantId: null,
      clientId: CLIENT_ID,
      nonce: 'nonce',
    });
    expect(result).toEqual({
      success: true,
      tenantId: TENANT_ID,
      administratorObjectId: ADMIN_ID,
      administratorUsername: 'admin@tenant.example',
      verifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(JSON.stringify(result)).not.toContain('identity-token');
    expect(JSON.stringify(result)).not.toContain('authorization-code');
  });

  it('redeems at the expected tenant authority and requires that tenant (reconnect / upgrade)', async () => {
    const { deps, tokenClient } = dependencies();
    await verifyIdentityOperation(verifyRequest({ expectedTenantId: TENANT_ID }), asDeps(deps));
    expect(tokenClient.exchangeAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({ authority: TENANT_ID }));
    expect(deps.verifyIdentity).toHaveBeenCalledWith('identity-token', expect.objectContaining({ expectedTenantId: TENANT_ID }));
  });

  it('never acquires an application token or probes Graph', async () => {
    const { deps, tokenClient } = dependencies();
    await verifyIdentityOperation(verifyRequest(), asDeps(deps));
    expect(tokenClient.acquireGraphAppToken).not.toHaveBeenCalled();
    expect(deps.graphClient.probeTenant).not.toHaveBeenCalled();
  });

  it('fails closed on a redirect URI that does not byte-match configuration', async () => {
    const { deps } = dependencies();
    expect(await verifyIdentityOperation(verifyRequest({ redirectUri: `${CALLBACK_URL}/` }), asDeps(deps)))
      .toEqual({ success: false, errorCode: 'identity_token_invalid' });
    expect(deps.certificateProvider.getConfiguredCertificate).not.toHaveBeenCalled();
    expect(deps.createTokenClient).not.toHaveBeenCalled();
  });

  it('fails closed on a non-canonical expected tenant before touching the credential', async () => {
    const { deps } = dependencies();
    expect(await verifyIdentityOperation(verifyRequest({ expectedTenantId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }), asDeps(deps)))
      .toEqual({ success: false, errorCode: 'identity_token_invalid' });
    expect(deps.certificateProvider.getConfiguredCertificate).not.toHaveBeenCalled();
  });

  it.each([
    ['the token endpoint rejected the code (replayed code)', 'exchange', new MicrosoftTokenClientError('token_provider_rejected'), 'identity_token_invalid'],
    ['the token request timed out', 'exchange', new MicrosoftTokenClientError('token_request_timeout'), 'identity_token_invalid'],
    ['an invalid id_token', 'verify', new MicrosoftIdentityFailure('identity_token_invalid'), 'identity_token_invalid'],
    ['a tenant mismatch', 'verify', new MicrosoftIdentityFailure('tenant_mismatch'), 'tenant_mismatch'],
    ['a missing admin role', 'verify', new MicrosoftIdentityFailure('admin_role_required'), 'admin_role_required'],
    ['an unexpected error', 'verify', new Error('provider body with secret'), 'identity_token_invalid'],
    ['a stray graph error', 'verify', new GraphClientError('graph_provider_rejected'), 'identity_token_invalid'],
  ] as const)('maps %s to an identity-only failure', async (_label, stage, error, code) => {
    const { deps, tokenClient } = dependencies();
    if (stage === 'exchange') tokenClient.exchangeAuthorizationCode.mockRejectedValue(error);
    else deps.verifyIdentity.mockRejectedValue(error);
    const result = await verifyIdentityOperation(verifyRequest(), asDeps(deps));
    expect(result).toEqual({ success: false, errorCode: code });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('maps credential failures to credential_unavailable', async () => {
    const { deps } = dependencies();
    deps.certificateProvider.getConfiguredCertificate.mockRejectedValue(new Error('vault down: private-key-material'));
    expect(await verifyIdentityOperation(verifyRequest(), asDeps(deps)))
      .toEqual({ success: false, errorCode: 'credential_unavailable' });

    const second = dependencies();
    second.deps.createTokenClient.mockImplementation(() => { throw new Error('bad key'); });
    expect(await verifyIdentityOperation(verifyRequest(), asDeps(second.deps)))
      .toEqual({ success: false, errorCode: 'credential_unavailable' });
    expect(second.credential).toEqual({ certificatePem: '', privateKeyPem: '' });
  });

  it('fails closed when the verifier returns an identity outside the contract', async () => {
    const { deps } = dependencies();
    deps.verifyIdentity.mockResolvedValue({ tenantId: 'not-a-guid', administratorObjectId: ADMIN_ID, administratorUsername: null });
    expect(await verifyIdentityOperation(verifyRequest(), asDeps(deps)))
      .toEqual({ success: false, errorCode: 'identity_token_invalid' });
  });

  it.each(['success', 'failure'] as const)('wipes the credential PEMs on %s', async (outcome) => {
    const { deps, credential } = dependencies();
    if (outcome === 'failure') deps.verifyIdentity.mockRejectedValue(new Error('boom'));
    await verifyIdentityOperation(verifyRequest(), asDeps(deps));
    expect(credential).toEqual({ certificatePem: '', privateKeyPem: '' });
  });

  it('is exposed by createExecutorOperations', () => {
    const operations = createExecutorOperations({
      clientId: CLIENT_ID,
      callbackUrl: CALLBACK_URL,
      certificateProvider: { getConfiguredCertificate: vi.fn() },
      graphClient: {},
      sync: {},
    } as never);
    expect(typeof operations.verifyIdentity).toBe('function');
  });
});

describe('completeConsentOperation (legacy flow, unchanged behavior)', () => {
  it('redeems at the tenant hint, requires it, and proves the app with one credential and one token client', async () => {
    const { deps, tokenClient, credential } = dependencies();
    const result = await completeConsentOperation(completeRequest(), asDeps(deps));

    expect(deps.certificateProvider.getConfiguredCertificate).toHaveBeenCalledOnce();
    expect(deps.createTokenClient).toHaveBeenCalledOnce();
    expect(tokenClient.exchangeAuthorizationCode).toHaveBeenCalledWith({
      authority: TENANT_ID,
      code: 'authorization-code',
      codeVerifier: 'v'.repeat(43),
    });
    expect(deps.verifyIdentity).toHaveBeenCalledWith('identity-token', {
      expectedTenantId: TENANT_ID,
      clientId: CLIENT_ID,
      nonce: 'nonce',
    });
    expect(tokenClient.acquireGraphAppToken).toHaveBeenCalledWith({ tenantId: TENANT_ID });
    expect(deps.graphClient.probeTenant).toHaveBeenCalledWith({ tenantId: TENANT_ID, accessToken: 'access-token' });
    expect(result).toMatchObject({ success: true, tenantId: TENANT_ID, administratorObjectId: ADMIN_ID });
    // the legacy result carries no username
    expect(result).not.toHaveProperty('administratorUsername');
    expect(credential).toEqual({ certificatePem: '', privateKeyPem: '' });
  });

  it.each([
    ['tenant mismatch from identity', 'verify', new MicrosoftIdentityFailure('tenant_mismatch'), 'tenant_mismatch'],
    ['missing admin role', 'verify', new MicrosoftIdentityFailure('admin_role_required'), 'admin_role_required'],
    ['rejected code', 'exchange', new MicrosoftTokenClientError('token_provider_rejected'), 'identity_token_invalid'],
    ['rejected app token', 'app', new MicrosoftTokenClientError('token_provider_rejected'), 'application_token_invalid'],
    ['failed probe', 'probe', new GraphClientError('graph_provider_rejected'), 'organization_probe_failed'],
  ] as const)('keeps mapping %s', async (_label, stage, error, code) => {
    const { deps, tokenClient } = dependencies();
    if (stage === 'verify') deps.verifyIdentity.mockRejectedValue(error);
    if (stage === 'exchange') tokenClient.exchangeAuthorizationCode.mockRejectedValue(error);
    if (stage === 'app') tokenClient.acquireGraphAppToken.mockRejectedValue(error);
    if (stage === 'probe') deps.graphClient.probeTenant.mockRejectedValue(error);
    expect(await completeConsentOperation(completeRequest(), asDeps(deps))).toEqual({ success: false, errorCode: code });
  });

  it('keeps failing a probe for a different tenant as tenant_mismatch', async () => {
    const { deps } = dependencies();
    deps.graphClient.probeTenant.mockResolvedValue({
      tenantId: '77777777-7777-4777-8777-777777777777', applicationId: CLIENT_ID, organizationDisplayName: 'Other', observedGrants: null,
    });
    expect(await completeConsentOperation(completeRequest(), asDeps(deps))).toEqual({ success: false, errorCode: 'tenant_mismatch' });
  });
});
