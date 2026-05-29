import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportPKCS8, exportJWK, jwtVerify, importJWK } from 'jose';
import { __mintPrincipalJwtForTest } from './delegantClient';

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
    const p1 = JSON.parse(Buffer.from(t1.split('.')[1], 'base64url').toString());
    const p2 = JSON.parse(Buffer.from(t2.split('.')[1], 'base64url').toString());
    expect(p1.jti).not.toBe(p2.jti);
  });
});
