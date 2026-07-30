import {
  buildSendPlan,
  commsCompleteConsentResultSchema,
  commsRetestResultSchema,
  commsRevokeConnectionResultSchema,
  m365CommsFailureCodeSchema,
  m365CommsResultSchema,
  type CommsCompleteConsentRequest,
  type CommsCompleteConsentResult,
  type CommsRetestRequest,
  type CommsRetestResult,
  type CommsRevokeConnectionRequest,
  type CommsRevokeConnectionResult,
  type M365CommsFailureCode,
  type M365CommsRequest,
  type M365CommsResult,
} from '@breeze/shared/m365';
import { computeCommsEnvelopeDigest, computeCommsPlanDigest } from '@breeze/shared/m365/commsDigests';
import { TokenCacheUnavailableError, type DelegatedTokenCache } from './credentials/delegatedTokenCache';
import type { InternalRequestAuthentication } from './internalAuth';
import { executeGraphCommsInlineAction } from './microsoft/commsMailActions';
import {
  DelegatedCredentialError,
  createDelegatedCredentialBroker,
  type ConsentRedemption,
  type DelegatedAcquisition,
} from './microsoft/delegatedClient';
import { GraphClientError, type MicrosoftGraphClient } from './microsoft/graphClient';
import {
  MicrosoftIdentityFailure,
  verifyDelegatedUserIdentity,
  type VerifiedDelegatedUserIdentity,
} from './microsoft/identity';
import { reconcileCommunicationsDelegated } from './microsoft/reconcile';

export interface CommsOperationDependencies {
  clientId: string;
  broker: ReturnType<typeof createDelegatedCredentialBroker>;
  tokenCache: DelegatedTokenCache;
  graphClient: MicrosoftGraphClient;
  verifyIdentity: typeof verifyDelegatedUserIdentity;
  now: () => Date;
}

function failed(errorCode: M365CommsFailureCode, retryAfterSeconds?: number): M365CommsResult {
  return retryAfterSeconds === undefined
    ? { success: false, errorCode }
    : { success: false, errorCode, retryAfterSeconds };
}

function mapCredentialError(error: unknown): M365CommsResult {
  if (error instanceof DelegatedCredentialError || error instanceof TokenCacheUnavailableError) {
    return failed(error.code as M365CommsFailureCode);
  }
  throw error;   // unexpected bugs surface as the app's 500, never a fabricated failure
}

/**
 * Graph failures fold enum-external codes (graph_request_invalid,
 * graph_provider_rejected, …) into graph_response_invalid — the read
 * executor's precedent — so every failure result stays schema-valid.
 */
function mapGraphError(error: unknown): M365CommsResult {
  if (!(error instanceof GraphClientError)) throw error;
  const parsed = m365CommsFailureCodeSchema.safeParse(error.code);
  const errorCode = parsed.success ? parsed.data : 'graph_response_invalid' as const;
  return failed(errorCode, error.retryAfterSeconds);
}

export async function executeActionOperation(
  request: M365CommsRequest,
  authentication: InternalRequestAuthentication,
  dependencies: CommsOperationDependencies,
): Promise<M365CommsResult> {
  const isSend = 'envelope' in request;

  if (isSend) {
    // §9 step 3: digest verification precedes credential access — an
    // unapproved effect must never even cause a token acquisition. Both
    // claims are required for a send; their values were signed by the API
    // from what was STORED at intent creation, never recomputed at release.
    if (
      authentication.effectDigest === null
      || authentication.planDigest === null
      || authentication.consentGeneration === null
    ) {
      return failed('effect_digest_mismatch');
    }
    if (computeCommsEnvelopeDigest(request.envelope) !== authentication.effectDigest) {
      return failed('effect_digest_mismatch');
    }
    if (computeCommsPlanDigest(request.envelope) !== authentication.planDigest) {
      return failed('effect_digest_mismatch');
    }
    // The body's consentGeneration is asserted EQUAL to the claim — never
    // read instead of it (§5.2). The schema already pinned envelope == body.
    if (authentication.consentGeneration !== request.consentGeneration) {
      return failed('binding_stale');
    }
  }

  let acquisition: DelegatedAcquisition;
  try {
    acquisition = await dependencies.broker.acquireForConnection({
      connectionId: request.connectionId,
      tenantId: request.tenantId,
      expectedUserObjectId: request.expectedUserObjectId,
      consentGeneration: request.consentGeneration,
    });
  } catch (error) {
    return mapCredentialError(error);
  }

  // §9 step 5: the identity gate re-asserts the PINNED tid/oid against MSAL's
  // account claims. No Graph-access-token parsing anywhere.
  if (acquisition.tokenTenantId !== request.tenantId) return failed('tenant_mismatch');
  if (acquisition.tokenUserObjectId !== request.expectedUserObjectId) {
    return failed('identity_token_invalid');
  }

  if (!isSend) {
    const result = await executeGraphCommsInlineAction(request.action, {
      accessToken: acquisition.accessToken,
      graphClient: dependencies.graphClient,
      now: dependencies.now,
    });
    return result.success
      ? { ...result, usedCacheGeneration: acquisition.usedCacheGeneration, rotated: acquisition.rotated }
      : result;
  }

  // §5.2 TOCTOU close: the generation is re-checked from the store
  // immediately before the Graph call — a reconnect promoted between
  // acquisition and here must abort the send.
  const current = await dependencies.tokenCache.peekGeneration(request.connectionId);
  if (!current || current.state !== 'active' || current.consentGeneration !== request.consentGeneration) {
    return failed('binding_stale');
  }

  // §5.3(a): the wire payload IS the verified plan. No construction remains
  // after digest verification, so there is nothing left to get wrong.
  const plan = buildSendPlan(request.envelope);
  try {
    await dependencies.graphClient.post({
      accessToken: acquisition.accessToken,
      path: plan.path,
      // GraphSendMailBody is an interface (no implicit index signature); the
      // value is passed through UNCHANGED — this cast is type-plumbing only.
      body: plan.body as unknown as Record<string, unknown>,
    });
  } catch (error) {
    if (error instanceof GraphClientError) {
      // A timeout mid-send is AMBIGUOUS — the mail may have gone out. Never
      // internally retry a send (§8); the intent terminalizes and Sent Items
      // is the recovery oracle.
      return mapGraphError(error);
    }
    throw error;
  }
  return {
    success: true, kind: 'sent',
    sentAt: dependencies.now().toISOString(),
    usedCacheGeneration: acquisition.usedCacheGeneration,
    rotated: acquisition.rotated,
  };
}

function failedConsent(errorCode: M365CommsFailureCode): CommsCompleteConsentResult {
  return { success: false, errorCode };
}

export async function completeConsentOperation(
  request: CommsCompleteConsentRequest,
  dependencies: CommsOperationDependencies,
): Promise<CommsCompleteConsentResult> {
  // 1. Redeem on the throwaway cache. Nothing durable exists yet.
  let redemption: ConsentRedemption;
  try {
    redemption = await dependencies.broker.redeemConsentCode({
      authorizationCode: request.authorizationCode,
      codeVerifier: request.codeVerifier,
      redirectUri: request.redirectUri,
    });
  } catch (error) { return mapCredentialError(error) as CommsCompleteConsentResult; }

  // 2. Validate the ID token: signature, iss derived from the returned tid,
  //    aud, nonce, exp/nbf — and pin tid/oid from the VALIDATED claims.
  let identity: VerifiedDelegatedUserIdentity;
  try {
    identity = await dependencies.verifyIdentity(redemption.rawIdToken, {
      clientId: dependencies.clientId,
      nonce: request.nonce,
      expectedTenantId: request.expectedTenantId,
    });
  } catch (error) {
    if (error instanceof MicrosoftIdentityFailure) return failedConsent(error.code);
    throw error;
  }

  // 3. Probe GET /me?$select=id,userPrincipalName,mail and assert id === oid.
  //    (User.Read covers this; deliberately NOT /me/mailboxSettings — §4.2.)
  let me: Record<string, unknown>;
  try {
    me = await dependencies.graphClient.readResource({
      accessToken: redemption.accessToken,
      path: '/me',
      select: ['id', 'userPrincipalName', 'mail'],
    });
  } catch (error) {
    return mapGraphError(error) as CommsCompleteConsentResult;
  }
  if (me.id !== identity.userObjectId) return failedConsent('identity_token_invalid');

  // 4. Scope reconciliation from AuthenticationResult.scopes. Fail closed —
  //    a consent missing Mail.Send would produce a mailbox that can never
  //    send; better refused now than degraded on first use.
  const reconciliation = reconcileCommunicationsDelegated(redemption.grantedScopes);
  if (!reconciliation.complete) return failedConsent('graph_permission_missing');

  // 5. ONLY NOW persist: encrypt and commit the serialized cache stamped with
  //    the attempt and the generation this attempt will claim (§4.1 ordering —
  //    the API's promotion UPDATE follows; on supersede it calls
  //    revoke-connection with this attempt id and the row dies inert).
  //    A failure at step 3/4 discards a refresh token Microsoft already
  //    issued — the recorded §4.2 residual: it is unused, unpersisted, and
  //    dies of inactivity. Plan 3's runbook documents it.
  const { cacheGeneration } = await dependencies.tokenCache.writeConsentRow({
    connectionId: request.connectionId,
    consentAttemptId: request.consentAttemptId,
    consentGeneration: request.claimedConsentGeneration,
    plaintext: redemption.serializedCache,
  });

  return {
    success: true,
    tenantId: identity.tenantId,
    userObjectId: identity.userObjectId,
    userPrincipalName: String(me.userPrincipalName),
    mail: me.mail === undefined || me.mail === null ? null : String(me.mail),
    grantedScopes: [...redemption.grantedScopes],
    cacheGeneration,
    verifiedAt: dependencies.now().toISOString(),
  };
}

export async function retestOperation(
  request: CommsRetestRequest,
  dependencies: CommsOperationDependencies,
): Promise<CommsRetestResult> {
  let acquisition: DelegatedAcquisition;
  try {
    acquisition = await dependencies.broker.acquireForConnection({
      connectionId: request.connectionId,
      tenantId: request.tenantId,
      expectedUserObjectId: request.expectedUserObjectId,
      consentGeneration: request.consentGeneration,
    });
  } catch (error) {
    return mapCredentialError(error) as CommsRetestResult;
  }

  if (acquisition.tokenTenantId !== request.tenantId) {
    return failed('tenant_mismatch') as CommsRetestResult;
  }
  if (acquisition.tokenUserObjectId !== request.expectedUserObjectId) {
    return failed('identity_token_invalid') as CommsRetestResult;
  }

  let me: Record<string, unknown>;
  try {
    me = await dependencies.graphClient.readResource({
      accessToken: acquisition.accessToken,
      path: '/me',
      select: ['id', 'userPrincipalName'],
    });
  } catch (error) {
    return mapGraphError(error) as CommsRetestResult;
  }
  if (me.id !== request.expectedUserObjectId) {
    return failed('identity_token_invalid') as CommsRetestResult;
  }

  return {
    success: true,
    userPrincipalName: String(me.userPrincipalName),
    usedCacheGeneration: acquisition.usedCacheGeneration,
    verifiedAt: dependencies.now().toISOString(),
  };
}

export async function revokeConnectionOperation(
  request: CommsRevokeConnectionRequest,
  dependencies: CommsOperationDependencies,
): Promise<CommsRevokeConnectionResult> {
  // Idempotent from the API's perspective: an absent row is not an error,
  // it reports tombstoned: false.
  const tombstoned = await dependencies.tokenCache.tombstone(
    request.connectionId,
    request.consentAttemptId,
  );
  return { success: true, tombstoned };
}

export function createExecutorOperations(config: {
  clientId: string;
  broker: ReturnType<typeof createDelegatedCredentialBroker>;
  tokenCache: DelegatedTokenCache;
  graphClient: MicrosoftGraphClient;
  verifyIdentity?: typeof verifyDelegatedUserIdentity;
  now?: () => Date;
}) {
  const dependencies: CommsOperationDependencies = {
    clientId: config.clientId,
    broker: config.broker,
    tokenCache: config.tokenCache,
    graphClient: config.graphClient,
    verifyIdentity: config.verifyIdentity ?? verifyDelegatedUserIdentity,
    now: config.now ?? (() => new Date()),
  };
  return {
    completeConsent: async (request: CommsCompleteConsentRequest) =>
      commsCompleteConsentResultSchema.parse(await completeConsentOperation(request, dependencies)),
    retest: async (request: CommsRetestRequest) =>
      commsRetestResultSchema.parse(await retestOperation(request, dependencies)),
    revokeConnection: async (request: CommsRevokeConnectionRequest) =>
      commsRevokeConnectionResultSchema.parse(await revokeConnectionOperation(request, dependencies)),
    executeAction: async (request: M365CommsRequest, authentication: InternalRequestAuthentication) =>
      m365CommsResultSchema.parse(await executeActionOperation(request, authentication, dependencies)),
  };
}
