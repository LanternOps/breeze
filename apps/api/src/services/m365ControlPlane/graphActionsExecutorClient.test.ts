import { describe, it, expect, vi } from 'vitest';
import { createGraphActionsExecutorClient, GraphActionsExecutorClientError } from './graphActionsExecutorClient';
import { generateKeyPair, exportJWK } from 'jose';

const UUID = '00000000-0000-4000-8000-000000000001';
const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';

async function signingConfig() {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(privateKey);
  return { signingPrivateJwk: { ...jwk, kty: 'OKP', crv: 'Ed25519' }, signingKid: 'kid-1' };
}

function req() {
  return {
    correlationId: UUID, tenantId: TENANT, idempotencyKey: 'intent-1',
    action: { type: 'm365.user.disable' as const, userIdentifier: 'a@b.com', reason: 'x' },
  };
}

describe('createGraphActionsExecutorClient', () => {
  it('POSTs a signed request and parses a success result', async () => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true, action: 'm365.user.disable', userId: USER }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = createGraphActionsExecutorClient({
      executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor',
      signingPrivateJwk, signingKid, fetch: fetchImpl as never,
    });
    const result = await client.executeWriteAction(req());
    expect(result).toEqual({ success: true, action: 'm365.user.disable', userId: USER });
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe('https://actions.internal/v1/execute-action');
    expect(call[1].headers.authorization).toMatch(/^Bearer /);
  });

  it('throws executor_unavailable on a non-200', async () => {
    const { signingPrivateJwk, signingKid } = await signingConfig();
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 502 }));
    const client = createGraphActionsExecutorClient({
      executorUrl: 'https://actions.internal/', executorAudience: 'm365-graph-actions-executor',
      signingPrivateJwk, signingKid, fetch: fetchImpl as never,
    });
    await expect(client.executeWriteAction(req())).rejects.toBeInstanceOf(GraphActionsExecutorClientError);
  });
});
