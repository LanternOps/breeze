import { randomUUID } from 'crypto';
import { exportJWK, generateKeyPair } from 'jose';

(async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const kid = randomUUID();
  const priv = { ...(await exportJWK(privateKey)), kid, alg: 'EdDSA', use: 'sig' };
  const pub = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
  process.stdout.write(`OAUTH_JWKS_PRIVATE_JWK=${JSON.stringify(priv)}\n`);
  process.stdout.write(`OAUTH_JWKS_PUBLIC_JWK=${JSON.stringify(pub)}\n`);
})();
