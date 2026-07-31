import {
  buildCommsSendEffect,
  buildSendPlan,
  type M365CommsSendRequest,
} from '@breeze/shared/m365';
import { computeCommsEnvelopeDigest, computeCommsPlanDigest } from '@breeze/shared/m365/commsDigests';
import { describe, expect, it, vi } from 'vitest';
import { TokenCacheUnavailableError } from './credentials/delegatedTokenCache';
import type { InternalRequestAuthentication } from './internalAuth';
import { DelegatedCredentialError } from './microsoft/delegatedClient';
import { GraphClientError } from './microsoft/graphClient';
import { MicrosoftIdentityFailure } from './microsoft/identity';
import {
  completeConsentOperation,
  executeActionOperation,
  retestOperation,
  revokeConnectionOperation,
  type CommsOperationDependencies,
} from './operations';

const CLIENT_ID = 'c3333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_OID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-07-29T12:00:00.000Z');

function envelope(overrides: Record<string, unknown> = {}) {
  return buildCommsSendEffect({
    actionVersion: 1,
    connectionId: CONNECTION_ID,
    tenantId: TENANT_ID,
    senderObjectId: USER_OID,
    consentGeneration: 1,
    to: ['recipient@example.com'],
    subject: 'Quarterly report',
    bodyText: 'Please find the numbers below.',
    ...overrides,
  });
}

function sendRequest(theEnvelope = envelope()): M365CommsSendRequest {
  return {
    correlationId: CORRELATION_ID,
    connectionId: CONNECTION_ID,
    tenantId: TENANT_ID,
    expectedUserObjectId: USER_OID,
    consentGeneration: 1,
    envelope: theEnvelope,
  };
}

function claimsFor(theEnvelope = envelope()): InternalRequestAuthentication {
  return {
    correlationId: CORRELATION_ID,
    effectDigest: computeCommsEnvelopeDigest(theEnvelope),
    planDigest: computeCommsPlanDigest(theEnvelope),
    consentGeneration: 1,
  };
}

const NO_CLAIMS: InternalRequestAuthentication = {
  correlationId: CORRELATION_ID,
  effectDigest: null,
  planDigest: null,
  consentGeneration: null,
};

function acquisition(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'opaque-access-token',
    tokenTenantId: TENANT_ID,
    tokenUserObjectId: USER_OID,
    usedCacheGeneration: 3,
    rotated: true,
    ...overrides,
  };
}

function redemption(overrides: Record<string, unknown> = {}) {
  return {
    rawIdToken: 'raw-id-token',
    grantedScopes: ['User.Read', 'Mail.ReadWrite', 'Mail.Send'],
    accessToken: 'consent-access-token',
    serializedCache: 'serialized-msal-cache',
    accountTenantId: TENANT_ID,
    accountUserObjectId: USER_OID,
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}): CommsOperationDependencies {
  return {
    clientId: CLIENT_ID,
    broker: {
      acquireForConnection: vi.fn().mockResolvedValue(acquisition()),
      redeemConsentCode: vi.fn().mockResolvedValue(redemption()),
    },
    tokenCache: {
      peekGeneration: vi.fn().mockResolvedValue({ state: 'active', consentGeneration: 1 }),
      writeConsentRow: vi.fn().mockResolvedValue({ cacheGeneration: 1 }),
      tombstone: vi.fn().mockResolvedValue(true),
    },
    graphClient: {
      post: vi.fn().mockResolvedValue({ status: 202, body: null }),
      readResource: vi.fn().mockResolvedValue({ id: USER_OID, userPrincipalName: 'user@contoso.example', mail: 'user@contoso.example' }),
      readCollection: vi.fn().mockResolvedValue({ items: [], truncated: false }),
    },
    verifyIdentity: vi.fn().mockResolvedValue({ tenantId: TENANT_ID, userObjectId: USER_OID }),
    now: () => NOW,
    ...overrides,
  } as unknown as CommsOperationDependencies;
}

function consentRequest(overrides: Record<string, unknown> = {}) {
  return {
    correlationId: CORRELATION_ID,
    connectionId: CONNECTION_ID,
    consentAttemptId: ATTEMPT_ID,
    claimedConsentGeneration: 1,
    authorizationCode: 'auth-code',
    codeVerifier: 'v'.repeat(43),
    nonce: 'nonce',
    redirectUri: 'https://console.example.test/api/v1/m365/comms-consent/callback',
    expectedTenantId: null,
    ...overrides,
  };
}

describe('executeActionOperation — send', () => {
  it('sends exactly buildSendPlan(envelope).body and reports cache metadata', async () => {
    const dependencies = deps();
    const theEnvelope = envelope();

    const result = await executeActionOperation(sendRequest(theEnvelope), claimsFor(theEnvelope), dependencies);

    expect(result).toEqual({
      success: true,
      kind: 'sent',
      sentAt: NOW.toISOString(),
      usedCacheGeneration: 3,
      rotated: true,
    });
    expect(dependencies.graphClient.post).toHaveBeenCalledOnce();
    expect(dependencies.graphClient.post).toHaveBeenCalledWith({
      accessToken: 'opaque-access-token',
      path: '/me/sendMail',
      body: buildSendPlan(theEnvelope).body,
    });
  });

  it('refuses a tampered envelope before the broker is ever called (§9 step 3)', async () => {
    const dependencies = deps();
    const approved = envelope();
    const tampered = envelope({ to: ['attacker@example.com'] });

    const result = await executeActionOperation(sendRequest(tampered), claimsFor(approved), dependencies);

    expect(result).toEqual({ success: false, errorCode: 'effect_digest_mismatch' });
    expect(dependencies.broker.acquireForConnection).not.toHaveBeenCalled();
    expect(dependencies.graphClient.post).not.toHaveBeenCalled();
  });

  it('refuses when the planDigest claim alone is wrong, broker never called', async () => {
    const dependencies = deps();
    const theEnvelope = envelope();
    const authentication = { ...claimsFor(theEnvelope), planDigest: 'a'.repeat(64) };

    const result = await executeActionOperation(sendRequest(theEnvelope), authentication, dependencies);

    expect(result).toEqual({ success: false, errorCode: 'effect_digest_mismatch' });
    expect(dependencies.broker.acquireForConnection).not.toHaveBeenCalled();
  });

  it('refuses a send with absent claims, broker never called', async () => {
    const dependencies = deps();

    const result = await executeActionOperation(sendRequest(), NO_CLAIMS, dependencies);

    expect(result).toEqual({ success: false, errorCode: 'effect_digest_mismatch' });
    expect(dependencies.broker.acquireForConnection).not.toHaveBeenCalled();
  });

  it('refuses when the claim generation disagrees with the body generation', async () => {
    const dependencies = deps();
    const theEnvelope = envelope();
    const authentication = { ...claimsFor(theEnvelope), consentGeneration: 2 };

    const result = await executeActionOperation(sendRequest(theEnvelope), authentication, dependencies);

    expect(result).toEqual({ success: false, errorCode: 'binding_stale' });
    expect(dependencies.broker.acquireForConnection).not.toHaveBeenCalled();
  });

  it('aborts the send when a reconnect promoted mid-flight (§5.2 TOCTOU)', async () => {
    const dependencies = deps();
    (dependencies.tokenCache.peekGeneration as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ state: 'active', consentGeneration: 2 });

    const result = await executeActionOperation(sendRequest(), claimsFor(), dependencies);

    expect(result).toEqual({ success: false, errorCode: 'binding_stale' });
    // Acquisition happened, but the Graph call must never fire.
    expect(dependencies.broker.acquireForConnection).toHaveBeenCalledOnce();
    expect(dependencies.graphClient.post).not.toHaveBeenCalled();
  });

  it('aborts the send when the row was tombstoned mid-flight', async () => {
    const dependencies = deps();
    (dependencies.tokenCache.peekGeneration as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ state: 'tombstoned', consentGeneration: 1 });

    const result = await executeActionOperation(sendRequest(), claimsFor(), dependencies);

    expect(result).toEqual({ success: false, errorCode: 'binding_stale' });
    expect(dependencies.graphClient.post).not.toHaveBeenCalled();
  });

  it('maps a Graph timeout to graph_request_timeout with post called exactly once (§8: no internal retry)', async () => {
    const dependencies = deps();
    (dependencies.graphClient.post as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new GraphClientError('graph_request_timeout'));

    const result = await executeActionOperation(sendRequest(), claimsFor(), dependencies);

    expect(result).toEqual({ success: false, errorCode: 'graph_request_timeout' });
    expect(dependencies.graphClient.post).toHaveBeenCalledOnce();
  });
});

describe('executeActionOperation — reads and shared gates', () => {
  function readRequest() {
    return {
      correlationId: CORRELATION_ID,
      connectionId: CONNECTION_ID,
      tenantId: TENANT_ID,
      expectedUserObjectId: USER_OID,
      consentGeneration: 1,
      action: { type: 'm365.comms.mail.list' as const, folder: 'inbox' as const },
    };
  }

  it('executes a read action without any digest requirement and attaches cache metadata', async () => {
    const dependencies = deps();
    (dependencies.graphClient.readCollection as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ id: 'm1', subject: 'S', secretField: 'never' }],
      truncated: false,
    });

    const result = await executeActionOperation(readRequest(), NO_CLAIMS, dependencies);

    expect(result).toEqual({
      success: true,
      kind: 'collection',
      items: [{ id: 'm1', subject: 'S' }],
      truncated: false,
      usedCacheGeneration: 3,
      rotated: true,
    });
  });

  it.each([
    'binding_stale',
    'delegated_reauth_required',
    'credential_rotation_failed',
  ] as const)('maps broker %s through verbatim', async (code) => {
    const dependencies = deps();
    (dependencies.broker.acquireForConnection as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new DelegatedCredentialError(code));

    const result = await executeActionOperation(readRequest(), NO_CLAIMS, dependencies);

    expect(result).toEqual({ success: false, errorCode: code });
  });

  it('maps a token-cache consent_superseded through verbatim', async () => {
    const dependencies = deps();
    (dependencies.broker.acquireForConnection as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new TokenCacheUnavailableError('consent_superseded'));

    const result = await executeActionOperation(readRequest(), NO_CLAIMS, dependencies);

    expect(result).toEqual({ success: false, errorCode: 'consent_superseded' });
  });

  it('re-asserts the pinned tid/oid against the MSAL account claims (§9 step 5)', async () => {
    const wrongTenant = deps();
    (wrongTenant.broker.acquireForConnection as ReturnType<typeof vi.fn>)
      .mockResolvedValue(acquisition({ tokenTenantId: '99999999-9999-4999-8999-999999999999' }));
    await expect(executeActionOperation(readRequest(), NO_CLAIMS, wrongTenant))
      .resolves.toEqual({ success: false, errorCode: 'tenant_mismatch' });

    const wrongUser = deps();
    (wrongUser.broker.acquireForConnection as ReturnType<typeof vi.fn>)
      .mockResolvedValue(acquisition({ tokenUserObjectId: '99999999-9999-4999-8999-999999999999' }));
    await expect(executeActionOperation(readRequest(), NO_CLAIMS, wrongUser))
      .resolves.toEqual({ success: false, errorCode: 'identity_token_invalid' });
  });

  it('re-throws unexpected errors instead of fabricating a failure result', async () => {
    const dependencies = deps();
    (dependencies.broker.acquireForConnection as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new TypeError('implementation bug'));

    await expect(executeActionOperation(readRequest(), NO_CLAIMS, dependencies))
      .rejects.toThrow('implementation bug');
  });
});

describe('completeConsentOperation — §4.2 in order', () => {
  it('runs redeem → verify → probe → reconcile → persist, in that order, and succeeds', async () => {
    const dependencies = deps();

    const result = await completeConsentOperation(consentRequest(), dependencies);

    expect(result).toEqual({
      success: true,
      tenantId: TENANT_ID,
      userObjectId: USER_OID,
      userPrincipalName: 'user@contoso.example',
      mail: 'user@contoso.example',
      grantedScopes: ['User.Read', 'Mail.ReadWrite', 'Mail.Send'],
      cacheGeneration: 1,
      verifiedAt: NOW.toISOString(),
    });
    const redeemOrder = (dependencies.broker.redeemConsentCode as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const verifyOrder = (dependencies.verifyIdentity as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const probeOrder = (dependencies.graphClient.readResource as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const persistOrder = (dependencies.tokenCache.writeConsentRow as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(redeemOrder).toBeLessThan(verifyOrder);
    expect(verifyOrder).toBeLessThan(probeOrder);
    expect(probeOrder).toBeLessThan(persistOrder);
    expect(dependencies.tokenCache.writeConsentRow).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      consentGeneration: 1,
      plaintext: 'serialized-msal-cache',
    });
    expect(dependencies.graphClient.readResource).toHaveBeenCalledWith({
      accessToken: 'consent-access-token',
      path: '/me',
      select: ['id', 'userPrincipalName', 'mail'],
    });
  });

  it('persists nothing when redemption fails', async () => {
    const dependencies = deps();
    (dependencies.broker.redeemConsentCode as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new DelegatedCredentialError('credential_unavailable'));

    const result = await completeConsentOperation(consentRequest(), dependencies);

    expect(result).toEqual({ success: false, errorCode: 'credential_unavailable' });
    expect(dependencies.tokenCache.writeConsentRow).not.toHaveBeenCalled();
    expect(dependencies.verifyIdentity).not.toHaveBeenCalled();
  });

  it('persists nothing when the ID token fails verification', async () => {
    const dependencies = deps();
    (dependencies.verifyIdentity as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new MicrosoftIdentityFailure('identity_token_invalid'));

    const result = await completeConsentOperation(consentRequest(), dependencies);

    expect(result).toEqual({ success: false, errorCode: 'identity_token_invalid' });
    expect(dependencies.tokenCache.writeConsentRow).not.toHaveBeenCalled();
    expect(dependencies.graphClient.readResource).not.toHaveBeenCalled();
  });

  it('persists nothing when the /me probe id disagrees with the validated oid', async () => {
    const dependencies = deps();
    (dependencies.graphClient.readResource as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ id: '99999999-9999-4999-8999-999999999999', userPrincipalName: 'x@y.example' });

    const result = await completeConsentOperation(consentRequest(), dependencies);

    expect(result).toEqual({ success: false, errorCode: 'identity_token_invalid' });
    expect(dependencies.tokenCache.writeConsentRow).not.toHaveBeenCalled();
  });

  it('fails closed with graph_permission_missing when Mail.Send is not granted (decision 5)', async () => {
    const dependencies = deps();
    (dependencies.broker.redeemConsentCode as ReturnType<typeof vi.fn>)
      .mockResolvedValue(redemption({ grantedScopes: ['User.Read', 'Mail.ReadWrite'] }));

    const result = await completeConsentOperation(consentRequest(), dependencies);

    expect(result).toEqual({ success: false, errorCode: 'graph_permission_missing' });
    expect(dependencies.tokenCache.writeConsentRow).not.toHaveBeenCalled();
  });

  it('refuses a reconnect tenant mismatch with nothing persisted', async () => {
    const dependencies = deps();
    (dependencies.verifyIdentity as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new MicrosoftIdentityFailure('tenant_mismatch'));

    const result = await completeConsentOperation(
      consentRequest({ expectedTenantId: TENANT_ID }),
      dependencies,
    );

    expect(result).toEqual({ success: false, errorCode: 'tenant_mismatch' });
    expect(dependencies.tokenCache.writeConsentRow).not.toHaveBeenCalled();
  });
});

describe('retestOperation', () => {
  function retestRequest() {
    return {
      correlationId: CORRELATION_ID,
      connectionId: CONNECTION_ID,
      tenantId: TENANT_ID,
      expectedUserObjectId: USER_OID,
      consentGeneration: 1,
    };
  }

  it('acquires, re-asserts identity, probes /me, and reports the used generation', async () => {
    const dependencies = deps();
    (dependencies.graphClient.readResource as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ id: USER_OID, userPrincipalName: 'user@contoso.example' });

    const result = await retestOperation(retestRequest(), dependencies);

    expect(result).toEqual({
      success: true,
      userPrincipalName: 'user@contoso.example',
      usedCacheGeneration: 3,
      verifiedAt: NOW.toISOString(),
    });
    expect(dependencies.graphClient.readResource).toHaveBeenCalledWith({
      accessToken: 'opaque-access-token',
      path: '/me',
      select: ['id', 'userPrincipalName'],
    });
  });

  it('maps broker and identity failures exactly as execute does', async () => {
    const reauth = deps();
    (reauth.broker.acquireForConnection as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new DelegatedCredentialError('delegated_reauth_required'));
    await expect(retestOperation(retestRequest(), reauth))
      .resolves.toEqual({ success: false, errorCode: 'delegated_reauth_required' });

    const probeMismatch = deps();
    (probeMismatch.graphClient.readResource as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ id: '99999999-9999-4999-8999-999999999999', userPrincipalName: 'x@y.example' });
    await expect(retestOperation(retestRequest(), probeMismatch))
      .resolves.toEqual({ success: false, errorCode: 'identity_token_invalid' });
  });
});

describe('revokeConnectionOperation', () => {
  it('honors the conditional attempt id', async () => {
    const dependencies = deps();

    const result = await revokeConnectionOperation(
      { correlationId: CORRELATION_ID, connectionId: CONNECTION_ID, consentAttemptId: ATTEMPT_ID },
      dependencies,
    );

    expect(result).toEqual({ success: true, tombstoned: true });
    expect(dependencies.tokenCache.tombstone).toHaveBeenCalledWith(CONNECTION_ID, ATTEMPT_ID);
  });

  it('reports tombstoned: false for an absent row instead of erroring (idempotent revoke)', async () => {
    const dependencies = deps();
    (dependencies.tokenCache.tombstone as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await revokeConnectionOperation(
      { correlationId: CORRELATION_ID, connectionId: CONNECTION_ID, consentAttemptId: null },
      dependencies,
    );

    expect(result).toEqual({ success: true, tombstoned: false });
    expect(dependencies.tokenCache.tombstone).toHaveBeenCalledWith(CONNECTION_ID, null);
  });
});
