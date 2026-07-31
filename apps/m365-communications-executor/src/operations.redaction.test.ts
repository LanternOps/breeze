import { buildCommsSendEffect, type M365CommsSendRequest } from '@breeze/shared/m365';
import { computeCommsEnvelopeDigest, computeCommsPlanDigest } from '@breeze/shared/m365/commsDigests';
import { describe, expect, it, vi } from 'vitest';
import { TokenCacheUnavailableError } from './credentials/delegatedTokenCache';
import type { InternalRequestAuthentication } from './internalAuth';
import { DelegatedCredentialError } from './microsoft/delegatedClient';
import { GraphClientError, type GraphClientErrorCode } from './microsoft/graphClient';
import { MicrosoftIdentityFailure } from './microsoft/identity';
import {
  completeConsentOperation,
  executeActionOperation,
  retestOperation,
  type CommsOperationDependencies,
} from './operations';

/**
 * Risk #1 made mechanical (design §9): correspondence must never ride an
 * error path into logs. Sentinel strings stand in for the subject, a
 * recipient, and the body; every reachable failure path is driven and the
 * result — or the thrown error — must stringify without any of them.
 */
const SENTINELS = ['LEAK-SUBJECT-9f3a', 'leak-recipient-9f3a@example.com', 'LEAK-BODY-9f3a'];

const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_OID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';

const SENTINEL_ENVELOPE = buildCommsSendEffect({
  actionVersion: 1,
  connectionId: CONNECTION_ID,
  tenantId: TENANT_ID,
  senderObjectId: USER_OID,
  consentGeneration: 1,
  to: ['leak-recipient-9f3a@example.com'],
  subject: 'LEAK-SUBJECT-9f3a',
  bodyText: 'LEAK-BODY-9f3a',
});

const SEND_REQUEST: M365CommsSendRequest = {
  correlationId: CORRELATION_ID,
  connectionId: CONNECTION_ID,
  tenantId: TENANT_ID,
  expectedUserObjectId: USER_OID,
  consentGeneration: 1,
  envelope: SENTINEL_ENVELOPE,
};

const VALID_CLAIMS: InternalRequestAuthentication = {
  correlationId: CORRELATION_ID,
  effectDigest: computeCommsEnvelopeDigest(SENTINEL_ENVELOPE),
  planDigest: computeCommsPlanDigest(SENTINEL_ENVELOPE),
  consentGeneration: 1,
};

function expectNoSentinel(value: unknown) {
  const serialized = JSON.stringify(value) ?? String(value);
  for (const sentinel of SENTINELS) {
    expect(serialized).not.toContain(sentinel);
  }
  if (value instanceof Error) {
    for (const sentinel of SENTINELS) {
      expect(value.message).not.toContain(sentinel);
      expect(String(value.stack ?? '')).not.toContain(sentinel);
    }
  }
}

function deps(overrides: Record<string, unknown> = {}): CommsOperationDependencies {
  return {
    clientId: 'c3333333-3333-4333-8333-333333333333',
    broker: {
      acquireForConnection: vi.fn().mockResolvedValue({
        accessToken: 'opaque-access-token',
        tokenTenantId: TENANT_ID,
        tokenUserObjectId: USER_OID,
        usedCacheGeneration: 1,
        rotated: false,
      }),
      redeemConsentCode: vi.fn().mockResolvedValue({
        rawIdToken: 'raw-id-token',
        grantedScopes: ['User.Read', 'Mail.ReadWrite', 'Mail.Send'],
        accessToken: 'consent-access-token',
        serializedCache: 'serialized-msal-cache',
        accountTenantId: TENANT_ID,
        accountUserObjectId: USER_OID,
      }),
    },
    tokenCache: {
      peekGeneration: vi.fn().mockResolvedValue({ state: 'active', consentGeneration: 1 }),
      writeConsentRow: vi.fn().mockResolvedValue({ cacheGeneration: 1 }),
      tombstone: vi.fn().mockResolvedValue(true),
    },
    graphClient: {
      post: vi.fn().mockResolvedValue({ status: 202, body: null }),
      readResource: vi.fn().mockResolvedValue({ id: USER_OID, userPrincipalName: 'user@contoso.example', mail: null }),
      readCollection: vi.fn().mockResolvedValue({ items: [], truncated: false }),
    },
    verifyIdentity: vi.fn().mockResolvedValue({ tenantId: TENANT_ID, userObjectId: USER_OID }),
    now: () => new Date('2026-07-29T12:00:00.000Z'),
  } as unknown as CommsOperationDependencies;
}

const DELEGATED_CODES = [
  'delegated_reauth_required',
  'credential_rotation_failed',
  'credential_unavailable',
  'identity_token_invalid',
  'binding_stale',
] as const;

const TOKEN_CACHE_CODES = [
  'delegated_reauth_required',
  'binding_stale',
  'credential_rotation_failed',
  'consent_superseded',
] as const;

const GRAPH_CODES: GraphClientErrorCode[] = [
  'graph_request_invalid',
  'graph_request_timeout',
  'graph_transport_failed',
  'graph_response_too_large',
  'graph_response_invalid',
  'graph_provider_rejected',
  'organization_probe_failed',
  'application_token_invalid',
  'graph_permission_missing',
  'graph_license_required',
  'graph_not_found',
  'graph_throttled',
];

describe('send failure paths never leak correspondence', () => {
  it('digest mismatch (tampered claims)', async () => {
    const result = await executeActionOperation(
      SEND_REQUEST,
      { ...VALID_CLAIMS, effectDigest: 'a'.repeat(64) },
      deps(),
    );
    expect(result.success).toBe(false);
    expectNoSentinel(result);
  });

  it('absent claims', async () => {
    const result = await executeActionOperation(SEND_REQUEST, {
      correlationId: CORRELATION_ID, effectDigest: null, planDigest: null, consentGeneration: null,
    }, deps());
    expect(result.success).toBe(false);
    expectNoSentinel(result);
  });

  it('binding stale (claim generation)', async () => {
    const result = await executeActionOperation(
      SEND_REQUEST, { ...VALID_CLAIMS, consentGeneration: 2 }, deps(),
    );
    expect(result).toEqual({ success: false, errorCode: 'binding_stale' });
    expectNoSentinel(result);
  });

  it('binding stale (TOCTOU re-check)', async () => {
    const dependencies = deps();
    (dependencies.tokenCache.peekGeneration as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await executeActionOperation(SEND_REQUEST, VALID_CLAIMS, dependencies);
    expect(result.success).toBe(false);
    expectNoSentinel(result);
  });

  it.each(DELEGATED_CODES)('broker DelegatedCredentialError %s', async (code) => {
    const dependencies = deps();
    (dependencies.broker.acquireForConnection as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new DelegatedCredentialError(code));
    const result = await executeActionOperation(SEND_REQUEST, VALID_CLAIMS, dependencies);
    expect(result.success).toBe(false);
    expectNoSentinel(result);
  });

  it.each(TOKEN_CACHE_CODES)('token cache TokenCacheUnavailableError %s', async (code) => {
    const dependencies = deps();
    (dependencies.broker.acquireForConnection as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new TokenCacheUnavailableError(code));
    const result = await executeActionOperation(SEND_REQUEST, VALID_CLAIMS, dependencies);
    expect(result.success).toBe(false);
    expectNoSentinel(result);
  });

  it.each(GRAPH_CODES)('Graph send failure %s', async (code) => {
    const dependencies = deps();
    (dependencies.graphClient.post as ReturnType<typeof vi.fn>)
      .mockRejectedValue(code === 'graph_throttled'
        ? new GraphClientError(code, 30)
        : new GraphClientError(code));
    const result = await executeActionOperation(SEND_REQUEST, VALID_CLAIMS, dependencies);
    expect(result.success).toBe(false);
    expectNoSentinel(result);
  });

  it('identity gate mismatches', async () => {
    const dependencies = deps();
    (dependencies.broker.acquireForConnection as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessToken: 'opaque-access-token',
      tokenTenantId: '99999999-9999-4999-8999-999999999999',
      tokenUserObjectId: USER_OID,
      usedCacheGeneration: 1,
      rotated: false,
    });
    const result = await executeActionOperation(SEND_REQUEST, VALID_CLAIMS, dependencies);
    expect(result.success).toBe(false);
    expectNoSentinel(result);
  });

  it('the mapCredentialError re-throw path rethrows without decorating the error', async () => {
    const dependencies = deps();
    const bug = new TypeError('implementation bug');
    (dependencies.broker.acquireForConnection as ReturnType<typeof vi.fn>).mockRejectedValue(bug);
    const thrown = await executeActionOperation(SEND_REQUEST, VALID_CLAIMS, dependencies)
      .catch((error: unknown) => error);
    expect(thrown).toBe(bug);   // re-thrown as-is, never wrapped with request context
    expectNoSentinel(thrown);
  });
});

describe('inline-action failure paths never leak the search term or ids', () => {
  it.each(GRAPH_CODES)('list failing with %s', async (code) => {
    const dependencies = deps();
    (dependencies.graphClient.readCollection as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new GraphClientError(code));
    const result = await executeActionOperation({
      correlationId: CORRELATION_ID,
      connectionId: CONNECTION_ID,
      tenantId: TENANT_ID,
      expectedUserObjectId: USER_OID,
      consentGeneration: 1,
      action: { type: 'm365.comms.mail.list', folder: 'inbox', search: 'LEAK-SUBJECT-9f3a' },
    }, VALID_CLAIMS, dependencies);
    expect(result.success).toBe(false);
    expectNoSentinel(result);
  });
});

describe('consent and retest failure paths never leak', () => {
  const consentRequest = {
    correlationId: CORRELATION_ID,
    connectionId: CONNECTION_ID,
    consentAttemptId: ATTEMPT_ID,
    claimedConsentGeneration: 1,
    authorizationCode: 'auth-code',
    codeVerifier: 'v'.repeat(43),
    nonce: 'nonce',
    redirectUri: 'https://console.example.test/api/v1/m365/comms-consent/callback',
    expectedTenantId: null,
  };

  it('redemption, identity, probe, and reconciliation failures', async () => {
    const redeemFails = deps();
    (redeemFails.broker.redeemConsentCode as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new DelegatedCredentialError('credential_unavailable'));
    expectNoSentinel(await completeConsentOperation(consentRequest, redeemFails));

    const identityFails = deps();
    (identityFails.verifyIdentity as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new MicrosoftIdentityFailure('tenant_mismatch'));
    expectNoSentinel(await completeConsentOperation(consentRequest, identityFails));

    const probeFails = deps();
    (probeFails.graphClient.readResource as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new GraphClientError('graph_permission_missing'));
    expectNoSentinel(await completeConsentOperation(consentRequest, probeFails));

    const scopesMissing = deps();
    (scopesMissing.broker.redeemConsentCode as ReturnType<typeof vi.fn>).mockResolvedValue({
      rawIdToken: 'raw-id-token',
      grantedScopes: ['User.Read'],
      accessToken: 'consent-access-token',
      serializedCache: 'serialized-msal-cache',
      accountTenantId: TENANT_ID,
      accountUserObjectId: USER_OID,
    });
    expectNoSentinel(await completeConsentOperation(consentRequest, scopesMissing));
  });

  it('retest failures', async () => {
    const dependencies = deps();
    (dependencies.broker.acquireForConnection as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new DelegatedCredentialError('delegated_reauth_required'));
    expectNoSentinel(await retestOperation({
      correlationId: CORRELATION_ID,
      connectionId: CONNECTION_ID,
      tenantId: TENANT_ID,
      expectedUserObjectId: USER_OID,
      consentGeneration: 1,
    }, dependencies));
  });
});

describe('error classes carry enum words only', () => {
  it('GraphClientError and DelegatedCredentialError messages match the enum-word shape', () => {
    for (const code of GRAPH_CODES) {
      expect(new GraphClientError(code).message).toMatch(/^[a-z0-9_ :]+$/i);
    }
    for (const code of DELEGATED_CODES) {
      expect(new DelegatedCredentialError(code).message).toMatch(/^[a-z0-9_ :]+$/i);
    }
    for (const code of TOKEN_CACHE_CODES) {
      expect(new TokenCacheUnavailableError(code).message).toMatch(/^[a-z0-9_ :]+$/i);
    }
  });
});
