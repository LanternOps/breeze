/**
 * One-time result sealing for diagnostic reads.
 *
 * The API process generates an X25519 key pair per command, sends the public
 * half in the (signed) command, and keeps the private half only in memory
 * while it waits. The agent seals the listing / file content to it
 * (agent/internal/remote/tools/diagaccess_seal.go), so device_commands.result
 * stores ciphertext that nothing can open once this process lets the key go —
 * including after a crash between the agent's answer and the tool's read.
 *
 *   shared = X25519(agentEphemeral, serverPublic)
 *   key    = HKDF-SHA256(shared, salt = agentEphemeralPub || serverPublic,
 *                        info = "breeze-diag-result-v1|" + authorizationId, 32)
 *   AES-256-GCM (Go layout: ciphertext || 16-byte tag), AAD = authorizationId.
 */
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from 'node:crypto';

const INFO_PREFIX = 'breeze-diag-result-v1|';
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export type SealedDiagnosticResult = {
  v: 1;
  authorizationId: string;
  epk: string;
  nonce: string;
  ct: string;
};

export type ResultKeyPair = { privateKey: KeyObject; publicKeyB64: string };

export function generateResultKeyPair(): ResultKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, publicKeyB64: Buffer.from(spki.subarray(spki.length - 32)).toString('base64') };
}

function rawPublicKey(key: KeyObject): Buffer {
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32));
}

export function isSealedDiagnosticResult(value: unknown): value is SealedDiagnosticResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.v === 1 && typeof v.authorizationId === 'string' && typeof v.epk === 'string'
    && typeof v.nonce === 'string' && typeof v.ct === 'string';
}

/** Opens a sealed result; throws on any mismatch or tampering. */
export function openSealedDiagnosticResult(
  privateKey: KeyObject,
  sealed: SealedDiagnosticResult,
  expectedAuthorizationId: string,
): unknown {
  if (sealed.authorizationId !== expectedAuthorizationId) {
    throw new Error('sealed result is for a different authorization');
  }
  const epk = Buffer.from(sealed.epk, 'base64');
  if (epk.length !== 32) throw new Error('sealed result ephemeral key is malformed');
  const agentPub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, epk]), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey, publicKey: agentPub });
  const salt = Buffer.concat([epk, rawPublicKey(privateKey)]);
  const key = Buffer.from(hkdfSync('sha256', shared, salt, INFO_PREFIX + sealed.authorizationId, 32));
  const nonce = Buffer.from(sealed.nonce, 'base64');
  const body = Buffer.from(sealed.ct, 'base64');
  if (nonce.length !== 12 || body.length < 16) throw new Error('sealed result is malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(sealed.authorizationId, 'utf8'));
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}
