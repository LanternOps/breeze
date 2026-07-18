import {
  completeConsentResultSchema,
  readActionResultSchema,
  retestResultSchema,
  type CompleteConsentRequest,
  type CompleteConsentResult,
  type ExecutorFailureCode,
  type ReadActionRequest,
  type ReadActionResult,
  type RetestRequest,
  type RetestResult,
} from '@breeze/shared/m365';
import type { PinnedCertificateProvider } from './credentials/types';
import { GraphClientError, type MicrosoftGraphClient } from './microsoft/graphClient';
import {
  MicrosoftIdentityFailure,
  verifyMicrosoftAdminIdentity,
  type VerifiedMicrosoftAdminIdentity,
} from './microsoft/identity';
import { executeGraphReadAction } from './microsoft/readActions';
import { reconcileCustomerGraphRead } from './microsoft/reconcile';
import {
  createMicrosoftTokenClient,
  MicrosoftTokenClientError,
  type MicrosoftTokenClient,
  type OpaqueIdentityToken,
} from './microsoft/tokenClient';

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
  const reconciled = reconcileCustomerGraphRead(observation);
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

export async function completeConsentOperation(
  request: CompleteConsentRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<CompleteConsentResult> {
  if (request.redirectUri !== dependencies.callbackUrl) return failed('identity_token_invalid');
  const credential = await fetchCredential(dependencies);
  if (typeof credential === 'string') return failed(credential);
  let tokenClient: MicrosoftTokenClient | undefined;
  let identity: VerifiedMicrosoftAdminIdentity;
  try {
    try {
      tokenClient = dependencies.createTokenClient(credential);
    } catch {
      return failed('credential_unavailable');
    }
    let idToken: OpaqueIdentityToken;
    try {
      idToken = await tokenClient.exchangeAuthorizationCode({
        tenantId: request.tenantHint,
        code: request.authorizationCode,
        codeVerifier: request.codeVerifier,
      });
      identity = await dependencies.verifyIdentity(idToken, {
        tenantHint: request.tenantHint,
        clientId: dependencies.clientId,
        nonce: request.nonce,
      });
    } catch (error) {
      return failed(mappedFailure(error, 'identity'));
    }
    try {
      const accessToken = await tokenClient.acquireGraphAppToken({ tenantId: identity.tenantId });
      const observation = await dependencies.graphClient.probeTenant({
        tenantId: identity.tenantId,
        accessToken,
      });
      const proofError = proofFailure(observation, {
        tenantId: identity.tenantId,
        applicationId: dependencies.clientId,
      });
      if (proofError) return failed(proofError);
      return completeConsentResultSchema.parse({
        ...verifiedResult(observation),
        administratorObjectId: identity.administratorObjectId,
      });
    } catch (error) {
      return failed(mappedFailure(error, error instanceof MicrosoftTokenClientError ? 'application' : 'probe'));
    }
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
    try {
      const accessToken = await tokenClient.acquireGraphAppToken({ tenantId: request.tenantId });
      const observation = await dependencies.graphClient.probeTenant({
        tenantId: request.tenantId,
        accessToken,
      });
      const proofError = proofFailure(observation, {
        tenantId: request.tenantId,
        applicationId: dependencies.clientId,
      });
      if (proofError) return failed(proofError);
      return retestResultSchema.parse(verifiedResult(observation));
    } catch (error) {
      return failed(mappedFailure(error, error instanceof MicrosoftTokenClientError ? 'application' : 'probe'));
    }
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}

export async function readActionOperation(
  request: ReadActionRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<ReadActionResult> {
  if (!CANONICAL_UUID.test(request.tenantId)) {
    return { success: false, errorCode: 'graph_response_invalid' };
  }
  const credential = await fetchCredential(dependencies);
  if (typeof credential === 'string') {
    return { success: false, errorCode: credential === 'credential_unavailable' ? 'credential_unavailable' : 'application_token_invalid' };
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
    return readActionResultSchema.parse(await executeGraphReadAction(request.action, {
      accessToken,
      graphClient: dependencies.graphClient,
    }));
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
    retest: (request: RetestRequest) => retestOperation(request, dependencies),
    readAction: (request: ReadActionRequest) => readActionOperation(request, dependencies),
  };
}
