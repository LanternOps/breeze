import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface KekKeyring {
  writerVersion: string;
  /** version → 32-byte key. Boot guarantees writerVersion ∈ keys (config + loadKekKeyring). */
  keys: ReadonlyMap<string, Uint8Array>;
}

export class CorruptCacheCiphertextError extends Error {
  constructor(readonly reason: 'unknown-kek-version' | 'malformed' | 'decrypt-failed') {
    super(`token cache ciphertext unusable: ${reason}`);
    this.name = 'CorruptCacheCiphertextError';
  }
}

/**
 * AES-256-GCM with layout iv(12) ‖ tag(16) ‖ data. The AAD binds a ciphertext
 * to its connection — a row-content swap across connections fails the tag.
 */
function aad(connectionId: string): Buffer {
  return Buffer.from(`m365-comms-token-cache:v1:${connectionId}`, 'utf8');
}

export function encryptCacheBlob(
  keyring: KekKeyring, connectionId: string, plaintext: string,
): { ciphertext: Uint8Array; kekVersion: string } {
  const key = keyring.keys.get(keyring.writerVersion);
  if (!key || key.byteLength !== 32) throw new Error('keyring writer version has no 32-byte key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(connectionId));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), data]),
    kekVersion: keyring.writerVersion,
  };
}

export function decryptCacheBlob(
  keyring: KekKeyring, connectionId: string, ciphertext: Uint8Array, kekVersion: string | null,
): string {
  if (kekVersion === null) throw new CorruptCacheCiphertextError('malformed');
  const key = keyring.keys.get(kekVersion);
  if (!key) throw new CorruptCacheCiphertextError('unknown-kek-version');
  if (ciphertext.byteLength <= IV_BYTES + TAG_BYTES) throw new CorruptCacheCiphertextError('malformed');
  const buffer = Buffer.from(ciphertext);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, IV_BYTES));
    decipher.setAuthTag(buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    decipher.setAAD(aad(connectionId));
    return Buffer.concat([
      decipher.update(buffer.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new CorruptCacheCiphertextError('decrypt-failed');
  }
}
