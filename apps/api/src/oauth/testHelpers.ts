import { randomUUID } from 'crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export interface TestKeypair {
  privateJwk: JWK;
  publicJwk: JWK;
  kid: string;
}

export async function generateTestKeypair(): Promise<TestKeypair> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const kid = randomUUID();

  return {
    privateJwk: { ...(await exportJWK(privateKey)), kid, alg: 'EdDSA', use: 'sig' },
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' },
    kid,
  };
}

export async function signTestJwt(
  privateJwk: JWK,
  kid: string,
  claims: Record<string, unknown>,
  opts: { issuer: string; audience: string; ttlSeconds?: number } = {
    issuer: 'https://test',
    audience: 'https://test/mcp/server',
  }
): Promise<string> {
  const { importJWK } = await import('jose');
  const key = await importJWK(privateJwk, 'EdDSA');

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setIssuedAt()
    .setExpirationTime(`${opts.ttlSeconds ?? 600}s`)
    .setJti((claims.jti as string) ?? randomUUID())
    .sign(key);
}
