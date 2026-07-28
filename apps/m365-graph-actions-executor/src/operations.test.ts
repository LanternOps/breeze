import { describe, it, expect, vi } from 'vitest';
import {
  completeConsentOperation,
  executeActionOperation,
  retestOperation,
  type ExecutorOperationDependencies,
} from './operations';
import type { MicrosoftGraphClient } from './microsoft/graphClient';
import { MicrosoftTokenClientError } from './microsoft/tokenClient';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const CALLBACK_URL = 'https://console.example.test/api/v1/m365/actions-consent/callback';

function deps(over: Partial<ExecutorOperationDependencies> = {}): ExecutorOperationDependencies {
  const cert = { certificatePem: 'C', privateKeyPem: 'K' };
  const graphClient = {
    probeTenant: vi.fn().mockResolvedValue({
      tenantId: TENANT,
      applicationId: CLIENT_ID,
      organizationDisplayName: 'Example',
      observedGrants: null,
    }),
    readResource: vi.fn().mockResolvedValue({ id: USER_ID }),
    readCollection: vi.fn(),
    patch: vi.fn().mockResolvedValue(undefined),
  } as unknown as MicrosoftGraphClient;
  return {
    clientId: CLIENT_ID,
    callbackUrl: CALLBACK_URL,
    certificateProvider: { getConfiguredCertificate: vi.fn().mockResolvedValue(cert) },
    createTokenClient: () => ({
      exchangeAuthorizationCode: vi.fn().mockResolvedValue('identity-token'),
      acquireGraphAppToken: vi.fn().mockResolvedValue('access-token'),
    } as never),
    verifyIdentity: vi.fn().mockResolvedValue({
      tenantId: TENANT,
      administratorObjectId: '55555555-5555-4555-8555-555555555555',
    }),
    graphClient,
    ...over,
  } as ExecutorOperationDependencies;
}

describe('executeActionOperation', () => {
  it('rejects a non-canonical tenantId with tenant_mismatch', async () => {
    const result = await executeActionOperation(
      { correlationId: '00000000-0000-4000-8000-000000000001', tenantId: 'not-a-uuid', idempotencyKey: 'i',
        action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' } },
      deps(),
    );
    expect(result).toEqual({ success: false, errorCode: 'tenant_mismatch' });
  });

  it('mints a token and runs the mutation on the happy path', async () => {
    const d = deps();
    const result = await executeActionOperation(
      { correlationId: '00000000-0000-4000-8000-000000000001', tenantId: TENANT, idempotencyKey: 'i',
        action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' } },
      d,
    );
    expect(result).toEqual({ success: true, action: 'm365.user.disable', userId: USER_ID });
  });

  it('returns credential_unavailable when the cert provider throws', async () => {
    const d = deps({ certificateProvider: { getConfiguredCertificate: vi.fn().mockRejectedValue(new Error('vault down')) } });
    const result = await executeActionOperation(
      { correlationId: '00000000-0000-4000-8000-000000000001', tenantId: TENANT, idempotencyKey: 'i',
        action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' } },
      d,
    );
    expect(result).toEqual({ success: false, errorCode: 'credential_unavailable' });
  });
});

describe('completeConsentOperation / retestOperation', () => {
  it('preserves verified tenant proof when grant reconciliation is unavailable', async () => {
    const result = await completeConsentOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      consentAttemptId: '22222222-2222-4222-8222-222222222222',
      tenantHint: TENANT,
      authorizationCode: 'authorization-code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'nonce',
      redirectUri: CALLBACK_URL,
    }, deps());

    expect(result).toMatchObject({
      success: true,
      tenantId: TENANT,
      applicationId: CLIENT_ID,
      organizationDisplayName: 'Example',
      manifestVersion: 1,
      grantReconciliation: 'unavailable',
      errorCode: 'grant_reconciliation_unavailable',
      observedGrants: null,
      missingGrants: null,
      unexpectedGrants: null,
      grantsVerifiedAt: null,
      administratorObjectId: '55555555-5555-4555-8555-555555555555',
    });
  });

  it('rejects a redirectUri that does not match the configured callback', async () => {
    const result = await completeConsentOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      consentAttemptId: '22222222-2222-4222-8222-222222222222',
      tenantHint: TENANT,
      authorizationCode: 'authorization-code',
      codeVerifier: 'v'.repeat(43),
      nonce: 'nonce',
      redirectUri: 'https://attacker.example.test/callback',
    }, deps());

    expect(result).toEqual({ success: false, errorCode: 'identity_token_invalid' });
  });

  it('reconciles observed grants against the fixed customer-graph-actions manifest', async () => {
    const observedGrants = [
      { resourceApplicationId: '00000003-0000-0000-c000-000000000000', appRoleId: '204e0828-b5ca-4ad8-b9f3-f32a958e7cc4', value: 'User.ReadWrite.All' },
      { resourceApplicationId: '00000003-0000-0000-c000-000000000000', appRoleId: '56760768-b641-451f-8906-e1b8ab31bca7', value: 'User-PasswordProfile.ReadWrite.All' },
    ];
    const d = deps();
    d.graphClient.probeTenant = vi.fn().mockResolvedValue({
      tenantId: TENANT,
      applicationId: CLIENT_ID,
      organizationDisplayName: 'Example',
      observedGrants,
    });

    const result = await retestOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT,
    }, d);

    expect(result).toMatchObject({
      success: true,
      grantReconciliation: 'complete',
      observedGrants,
      missingGrants: [],
      unexpectedGrants: [],
    });
  });

  it('fails closed when the application proof does not match the fixed configured app', async () => {
    const d = deps();
    d.graphClient.probeTenant = vi.fn().mockResolvedValue({
      tenantId: TENANT,
      applicationId: '66666666-6666-4666-8666-666666666666',
      organizationDisplayName: 'Example',
      observedGrants: null,
    });
    const result = await retestOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT,
    }, d);

    expect(result).toEqual({ success: false, errorCode: 'application_token_invalid' });
  });

  it('rejects a non-canonical retest tenantId with tenant_mismatch', async () => {
    const result = await retestOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: 'not-a-guid',
    }, deps());
    expect(result).toEqual({ success: false, errorCode: 'tenant_mismatch' });
  });

  it('maps credential provider details to the stable credential code only', async () => {
    const d = deps();
    d.certificateProvider.getConfiguredCertificate = vi.fn().mockRejectedValue(
      new Error('secret value at akv://vault/private-version'),
    );
    const result = await retestOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT,
    }, d);
    expect(result).toEqual({ success: false, errorCode: 'credential_unavailable' });
    expect(JSON.stringify(result)).not.toMatch(/secret|vault|private/i);
  });

  it('maps an application token failure to application_token_invalid', async () => {
    const d = deps();
    d.createTokenClient = vi.fn().mockReturnValue({
      exchangeAuthorizationCode: vi.fn(),
      acquireGraphAppToken: vi.fn().mockRejectedValue(new MicrosoftTokenClientError('token_provider_rejected')),
    }) as never;
    const result = await retestOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT,
    }, d);
    expect(result).toEqual({ success: false, errorCode: 'application_token_invalid' });
  });

  it('scrubs the certificate PEM fields after completion', async () => {
    const d = deps();
    const credential = { certificatePem: 'cert', privateKeyPem: 'key' };
    d.certificateProvider.getConfiguredCertificate = vi.fn().mockResolvedValue(credential);
    await retestOperation({
      correlationId: '11111111-1111-4111-8111-111111111111',
      tenantId: TENANT,
    }, d);
    expect(credential.certificatePem).toBe('');
    expect(credential.privateKeyPem).toBe('');
  });
});
