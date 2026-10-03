import {
  completeConsentResultSchema,
  retestResultSchema,
  verifyConsentIdentityResultSchema,
  writeActionResultSchema,
  type CompleteConsentRequest,
  type CompleteConsentResult,
  type ExecutorFailureCode,
  type IdentityFailureCode,
  type RetestRequest,
  type RetestResult,
  type VerifyConsentIdentityRequest,
  type VerifyConsentIdentityResult,
  type WriteActionRequest,
  type WriteActionResult,
} from '@breeze/shared/m365';
import type { PinnedCertificateProvider } from './credentials/types';
import { ORGANIZATIONS_AUTHORITY } from './microsoft/clientAssertion';
import { GraphClientError, type MicrosoftGraphClient } from './microsoft/graphClient';
import {
  MicrosoftIdentityFailure,
  verifyMicrosoftAdminIdentity,
  type VerifiedMicrosoftAdminIdentity,
} from './microsoft/identity';
import { reconcileCustomerGraphActions } from './microsoft/reconcile';
import {
  createMicrosoftTokenClient,
  MicrosoftTokenClientError,
  type MicrosoftTokenClient,
  type OpaqueIdentityToken,
} from './microsoft/tokenClient';
import { executeGraphWriteAction } from './microsoft/writeActions';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type TokenClientFactory = (credential: {
  certificatePem: string;
  privateKeyPem: string;
}) => MicrosoftTokenClient;

export interface ExecutorOperationDependencies {
  clientId: string;
  callbackUrl: string;
  certificateProvider: PinnedCertificateProvider;
  createTokenClient: TokenClientFactory;
  verifyIdentity: typeof verifyMicrosoftAdminIdentity;
  graphClient: MicrosoftGraphClient;
}

function failed(errorCode: ExecutorFailureCode) {
  return { success: false as const, errorCode };
}

function tokenFailure(stage: 'identity' | 'application'): ExecutorFailureCode {
  return stage === 'identity' ? 'identity_token_invalid' : 'application_token_invalid';
}

function mappedFailure(error: unknown, stage: 'credential' | 'identity' | 'application' | 'probe'):
ExecutorFailureCode {
  if (error instanceof MicrosoftIdentityFailure) return error.code;
  if (error instanceof GraphClientError) {
    return error.code === 'application_token_invalid'
      ? 'application_token_invalid'
      : 'organization_probe_failed';
  }
  if (error instanceof MicrosoftTokenClientError) {
    return tokenFailure(stage === 'identity' ? 'identity' : 'application');
  }
  if (stage === 'credential') return 'credential_unavailable';
  if (stage === 'identity') return 'identity_token_invalid';
  if (stage === 'application') return 'application_token_invalid';
  return 'organization_probe_failed';
}

function verifiedResult(observation: Awaited<ReturnType<MicrosoftGraphClient['probeTenant']>>) {
  const reconciled = reconcileCustomerGraphActions(observation);
  const common = {
    success: true as const,
    tenantId: reconciled.tenantId,
    applicationId: reconciled.applicationId,
    organizationDisplayName: reconciled.organizationDisplayName,
    manifestVersion: reconciled.manifestVersion,
    verifiedAt: reconciled.verifiedAt,
  };
  if (reconciled.grantReconciliation === 'unavailable') {
    return {
      ...common,
      grantReconciliation: 'unavailable' as const,
      errorCode: 'grant_reconciliation_unavailable' as const,
      observedGrants: null,
      missingGrants: null,
      unexpectedGrants: null,
      grantsVerifiedAt: null,
    };
  }
  return {
    ...common,
    grantReconciliation: 'complete' as const,
    observedGrants: reconciled.observedGrants,
    missingGrants: reconciled.missingGrants,
    unexpectedGrants: reconciled.unexpectedGrants,
    grantsVerifiedAt: reconciled.grantsVerifiedAt,
  };
}

function proofFailure(
  observation: Awaited<ReturnType<MicrosoftGraphClient['probeTenant']>>,
  expected: { tenantId: string; applicationId: string },
): ExecutorFailureCode | undefined {
  if (observation.tenantId !== expected.tenantId) return 'tenant_mismatch';
  if (observation.applicationId !== expected.applicationId) return 'application_token_invalid';
  return undefined;
}

async function fetchCredential(
  dependencies: ExecutorOperationDependencies,
): Promise<{ certificatePem: string; privateKeyPem: string } | ExecutorFailureCode> {
  try {
    return await dependencies.certificateProvider.getConfiguredCertificate();
  } catch (error) {
    return mappedFailure(error, 'credential');
  }
}

type IdentityFailureResult = { success: false; errorCode: IdentityFailureCode };

function identityFailed(errorCode: IdentityFailureCode): IdentityFailureResult {
  return { success: false, errorCode };
}

/** Only the two administrator-actionable identity outcomes survive; all else is invalid. */
function identityFailureCode(error: unknown): IdentityFailureCode {
  if (
    error instanceof MicrosoftIdentityFailure
    && (error.code === 'tenant_mismatch' || error.code === 'admin_role_required')
  ) {
    return error.code;
  }
  return 'identity_token_invalid';
}

/**
 * Identity proof: redeem the v2 OIDC code at the expected tenant's authority
 * (or `organizations` when none is expected) and verify the id_token. Throws
 * the token-client / identity failure for the caller to map.
 */
async function proveAdministratorIdentity(
  tokenClient: MicrosoftTokenClient,
  input: { expectedTenantId: string | null; code: string; codeVerifier: string; nonce: string },
  dependencies: ExecutorOperationDependencies,
): Promise<VerifiedMicrosoftAdminIdentity> {
  const idToken: OpaqueIdentityToken = await tokenClient.exchangeAuthorizationCode({
    authority: input.expectedTenantId ?? ORGANIZATIONS_AUTHORITY,
    code: input.code,
    codeVerifier: input.codeVerifier,
  });
  return await dependencies.verifyIdentity(idToken, {
    expectedTenantId: input.expectedTenantId,
    clientId: dependencies.clientId,
    nonce: input.nonce,
  });
}

/**
 * Application proof: app-only token for exactly `tenantId`, organization probe,
 * and grant reconciliation. `finish` runs inside the same failure mapping so a
 * result-schema rejection is still reported as a probe failure.
 */
async function proveApplication<T>(
  tokenClient: MicrosoftTokenClient,
  tenantId: string,
  dependencies: ExecutorOperationDependencies,
  finish: (verified: ReturnType<typeof verifiedResult>) => T,
): Promise<T | ReturnType<typeof failed>> {
  try {
    const accessToken = await tokenClient.acquireGraphAppToken({ tenantId });
    const observation = await dependencies.graphClient.probeTenant({ tenantId, accessToken });
    const proofError = proofFailure(observation, {
      tenantId,
      applicationId: dependencies.clientId,
    });
    if (proofError) return failed(proofError);
    return finish(verifiedResult(observation));
  } catch (error) {
    return failed(mappedFailure(error, error instanceof MicrosoftTokenClientError ? 'application' : 'probe'));
  }
}

/**
 * Identity-first consent, phase 1. Proves who the administrator is and which
 * tenant they belong to; never acquires an application token or touches Graph,
 * and returns no token material.
 */
export async function verifyIdentityOperation(
  request: VerifyConsentIdentityRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<VerifyConsentIdentityResult> {
  if (request.redirectUri !== dependencies.callbackUrl) return identityFailed('identity_token_invalid');
  if (request.expectedTenantId !== null && !CANONICAL_UUID.test(request.expectedTenantId)) {
    return identityFailed('identity_token_invalid');
  }
  const credential = await fetchCredential(dependencies);
  if (typeof credential === 'string') return identityFailed('credential_unavailable');
  let tokenClient: MicrosoftTokenClient | undefined;
  try {
    try {
      tokenClient = dependencies.createTokenClient(credential);
    } catch {
      return identityFailed('credential_unavailable');
    }
    let identity: VerifiedMicrosoftAdminIdentity;
    try {
      identity = await proveAdministratorIdentity(tokenClient, {
        expectedTenantId: request.expectedTenantId,
        code: request.authorizationCode,
        codeVerifier: request.codeVerifier,
        nonce: request.nonce,
      }, dependencies);
    } catch (error) {
      return identityFailed(identityFailureCode(error));
    }
    const result = verifyConsentIdentityResultSchema.safeParse({
      success: true,
      tenantId: identity.tenantId,
      administratorObjectId: identity.administratorObjectId,
      administratorUsername: identity.administratorUsername,
      verifiedAt: new Date().toISOString(),
    });
    return result.success ? result.data : identityFailed('identity_token_invalid');
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}

/**
 * Legacy single-call flow (tenant hint from /adminconsent): identity proof
 * pinned to the hint, then application proof, with one credential fetch and one
 * token client. Removed in W4 of #7910.
 */
export async function completeConsentOperation(
  request: CompleteConsentRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<CompleteConsentResult> {
  if (request.redirectUri !== dependencies.callbackUrl) return failed('identity_token_invalid');
  const credential = await fetchCredential(dependencies);
  if (typeof credential === 'string') return failed(credential);
  let tokenClient: MicrosoftTokenClient | undefined;
  try {
    try {
      tokenClient = dependencies.createTokenClient(credential);
    } catch {
      return failed('credential_unavailable');
    }
    let identity: VerifiedMicrosoftAdminIdentity;
    try {
      identity = await proveAdministratorIdentity(tokenClient, {
        expectedTenantId: request.tenantHint,
        code: request.authorizationCode,
        codeVerifier: request.codeVerifier,
        nonce: request.nonce,
      }, dependencies);
    } catch (error) {
      return failed(mappedFailure(error, 'identity'));
    }
    return await proveApplication(tokenClient, identity.tenantId, dependencies, (verified) => (
      completeConsentResultSchema.parse({
        ...verified,
        administratorObjectId: identity.administratorObjectId,
      })
    ));
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}

export async function retestOperation(
  request: RetestRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<RetestResult> {
  if (!CANONICAL_UUID.test(request.tenantId)) return failed('tenant_mismatch');
  const credential = await fetchCredential(dependencies);
  if (typeof credential === 'string') return failed(credential);
  let tokenClient: MicrosoftTokenClient | undefined;
  try {
    try {
      tokenClient = dependencies.createTokenClient(credential);
    } catch {
      return failed('credential_unavailable');
    }
    return await proveApplication(tokenClient, request.tenantId, dependencies, (verified) => (
      retestResultSchema.parse(verified)
    ));
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}

export async function executeActionOperation(
  request: WriteActionRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<WriteActionResult> {
  if (!CANONICAL_UUID.test(request.tenantId)) {
    return { success: false, errorCode: 'tenant_mismatch' };
  }

  let credential: { certificatePem: string; privateKeyPem: string };
  try {
    credential = await dependencies.certificateProvider.getConfiguredCertificate();
  } catch {
    return { success: false, errorCode: 'credential_unavailable' };
  }

  let tokenClient: MicrosoftTokenClient | undefined;
  try {
    try {
      tokenClient = dependencies.createTokenClient(credential);
    } catch {
      return { success: false, errorCode: 'credential_unavailable' };
    }
    let accessToken;
    try {
      accessToken = await tokenClient.acquireGraphAppToken({ tenantId: request.tenantId });
    } catch {
      return { success: false, errorCode: 'application_token_invalid' };
    }
    return writeActionResultSchema.parse(
      await executeGraphWriteAction(request.action, { accessToken, graphClient: dependencies.graphClient }),
    );
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}

export function createExecutorOperations(config: {
  clientId: string;
  callbackUrl: string;
  certificateProvider: PinnedCertificateProvider;
  graphClient: MicrosoftGraphClient;
}) {
  const dependencies: ExecutorOperationDependencies = {
    ...config,
    createTokenClient: (credential) => createMicrosoftTokenClient({
      clientId: config.clientId,
      callbackUrl: config.callbackUrl,
      ...credential,
    }),
    verifyIdentity: verifyMicrosoftAdminIdentity,
  };
  return {
    completeConsent: (request: CompleteConsentRequest) => completeConsentOperation(request, dependencies),
    verifyIdentity: (request: VerifyConsentIdentityRequest) => verifyIdentityOperation(request, dependencies),
    retest: (request: RetestRequest) => retestOperation(request, dependencies),
    executeAction: (request: WriteActionRequest) => executeActionOperation(request, dependencies),
  };
}
