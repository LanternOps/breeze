import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPair, exportPKCS8, exportJWK, jwtVerify, importJWK } from 'jose';
import { __mintPrincipalJwtForTest, invokeDelegantTool } from './delegantClient';

let privatePem: string;
let publicJwk: any;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privatePem = await exportPKCS8(privateKey);
  publicJwk = await exportJWK(publicKey);
});

describe('mintPrincipalJwt', () => {
  it('mints a breeze_ai_agent token with the acting-user chain and required claims', async () => {
    const token = await __mintPrincipalJwtForTest({
      signingKeyPem: privatePem,
      kid: 'kid-1',
      agentPrincipalId: 'agent-123',
      breezeOrgId: 'should-not-be-used',
      delegantOrgId: 'dorg-456',
      actingUserBreezeId: 'tech-1',
      actingUserDelegantId: 'duser-789',
      sessionId: 'sess-1',
      nowSeconds: 1_000_000,
    });
    const pubKey = await importJWK(publicJwk, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(token, pubKey, {
      issuer: 'breeze-api', audience: 'delegant',
      // Token is minted with nowSeconds=1_000_000; verify against that same
      // clock so jose's temporal (exp/iat) checks use the token's mint time
      // rather than the real wall clock.
      currentDate: new Date(1_000_000 * 1000),
    });
    expect(protectedHeader.kid).toBe('kid-1');
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.sub).toBe('agent-123');
    expect(payload.principal_type).toBe('breeze_ai_agent');
    expect(payload.breeze_org_id).toBe('dorg-456'); // delegant org, not breeze org
    expect(payload.breeze_acting_user_id).toBe('duser-789');
    expect(payload.breeze_user_id).toBe('tech-1');
    expect(payload.breeze_session_id).toBe('sess-1');
    expect(payload.exp).toBe(1_000_060); // now + 60
    expect(typeof payload.jti).toBe('string');
  });

  it('produces a unique jti on each call', async () => {
    const args = {
      signingKeyPem: privatePem, kid: 'kid-1', agentPrincipalId: 'a',
      breezeOrgId: 'b', delegantOrgId: 'd', actingUserBreezeId: 't',
      actingUserDelegantId: 'u', sessionId: 's', nowSeconds: 1,
    };
    const t1 = await __mintPrincipalJwtForTest(args);
    const t2 = await __mintPrincipalJwtForTest(args);
    const p1 = JSON.parse(Buffer.from(t1.split('.')[1]!, 'base64url').toString());
    const p2 = JSON.parse(Buffer.from(t2.split('.')[1]!, 'base64url').toString());
    expect(p1.jti).not.toBe(p2.jti);
  });
});

function mockFetchOnce(status: number, body: unknown, opts: { throwNetwork?: boolean } = {}) {
  if (opts.throwNetwork) {
    return vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  }
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

const baseArgs = () => ({
  connection: {
    id: 'conn-1', orgId: 'org-1', customerLabel: 'pinnacle',
    customerDisplayName: 'Pinnacle', delegantOrgId: 'dorg-1',
    delegantConnectionId: 'dconn-1', m365TenantId: 'tid-1',
    status: 'active', lastVerifiedAt: null, createdAt: new Date(), updatedAt: new Date(),
  } as any,
  toolName: 'get_user' as const,
  parameters: { userId: 'u1' },
  actingUser: { breezeUserId: 'tech-1', delegantPrincipalId: 'duser-1' },
  agent: { delegantPrincipalId: 'agent-1' },
  sessionId: 'sess-1',
});

describe('invokeDelegantTool response mapping', () => {
  const env = {
    DELEGANT_BASE_URL: 'https://delegant.example',
    DELEGANT_SERVICE_TOKEN: 'svc',
    DELEGANT_PRINCIPAL_SIGNING_KEY: '',
    DELEGANT_PRINCIPAL_KID: 'kid-1',
  };
  beforeAll(() => { env.DELEGANT_PRINCIPAL_SIGNING_KEY = privatePem; });

  it('maps 200 + {isError:false,data} to ok', async () => {
    const fetchMock = mockFetchOnce(200, { isError: false, data: { id: 'u1' } });
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    expect(res).toEqual({ kind: 'ok', data: { id: 'u1' } });
  });

  it('maps 200 + {isError:false,data,toolCallId} to ok with toolCallId', async () => {
    const fetchMock = mockFetchOnce(200, { isError: false, data: { id: 'u1' }, toolCallId: 'tc-123' });
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    expect(res).toEqual({ kind: 'ok', data: { id: 'u1' }, toolCallId: 'tc-123' });
  });

  it('maps 200 + {isError:true,message} to error/tool_error', async () => {
    const fetchMock = mockFetchOnce(200, { isError: true, message: 'user not found' });
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    expect(res).toEqual({ kind: 'error', code: 'tool_error', message: 'user not found' });
  });

  it('maps 200 + {pending:true} to error/unexpected_pending (fail loud)', async () => {
    const fetchMock = mockFetchOnce(200, { isError: false, pending: true, approvalRequestId: 'a1' });
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    expect(res).toMatchObject({ kind: 'error', code: 'unexpected_pending' });
  });

  it('maps 401 to error/auth_failed', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(401, { error: 'unauthorized' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'auth_failed' });
  });

  it('maps 403 to error/forbidden', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(403, { error: 'forbidden_principal_type' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'forbidden' });
  });

  it('maps 400 to error/bad_request', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(400, { error: 'missing toolName' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'bad_request' });
  });

  it('maps 404 to error/not_found', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(404, { error: 'unknown tool' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'not_found' });
  });

  it('maps 500 to error/delegant_unavailable', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(500, { isError: true, message: 'Internal error' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'delegant_unavailable' });
  });

  it('maps a network throw to error/delegant_unreachable', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(0, null, { throwNetwork: true }) });
    expect(res).toMatchObject({ kind: 'error', code: 'delegant_unreachable' });
  });

  it('sends the service token and principal header', async () => {
    const fetchMock = mockFetchOnce(200, { isError: false, data: {} });
    await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://delegant.example/v1/tools/invoke');
    expect(init.headers['Authorization']).toBe('Bearer svc');
    expect(typeof init.headers['X-Delegant-Principal']).toBe('string');
    expect(JSON.parse(init.body)).toEqual({ toolName: 'get_user', parameters: { userId: 'u1' } });
  });

  it('pins redirect:error so a 3xx cannot forward the bearer token + principal JWT off-host', async () => {
    const fetchMock = mockFetchOnce(200, { isError: false, data: {} });
    await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.redirect).toBe('error');
  });

  it('does not log tool parameters', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = baseArgs();
    args.parameters = { userId: 'jane.doe@pinnacle.dental' };
    await invokeDelegantTool(args, { env, fetchImpl: mockFetchOnce(200, { isError: false, data: {} }) });
    const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('jane.doe@pinnacle.dental');
    spy.mockRestore();
  });
});
