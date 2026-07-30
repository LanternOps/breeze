import { describe, expect, it } from 'vitest';
import {
  CorruptCacheCiphertextError,
  decryptCacheBlob,
  encryptCacheBlob,
  type KekKeyring,
} from './tokenCacheCrypto';

const CONNECTION = '11111111-1111-4111-8111-111111111111';
const OTHER_CONNECTION = '22222222-2222-4222-8222-222222222222';
const V1 = 'a'.repeat(32);
const V2 = 'b'.repeat(32);

function keyring(writerVersion: string, versions: string[]): KekKeyring {
  return {
    writerVersion,
    keys: new Map(versions.map((version, index) => [
      version,
      new Uint8Array(Buffer.alloc(32, index + 1)),
    ])),
  };
}

describe('token cache KEK crypto', () => {
  it('round-trips a serialized cache blob', () => {
    const ring = keyring(V1, [V1]);
    const { ciphertext, kekVersion } = encryptCacheBlob(ring, CONNECTION, 'serialized-msal-cache');
    expect(kekVersion).toBe(V1);
    expect(decryptCacheBlob(ring, CONNECTION, ciphertext, kekVersion)).toBe('serialized-msal-cache');
  });

  it('lets a reader-only version decrypt what an older writer wrapped (rollover window)', () => {
    const oldRing = keyring(V1, [V1]);
    const { ciphertext, kekVersion } = encryptCacheBlob(oldRing, CONNECTION, 'wrapped-under-v1');
    // After rollover the writer moved to V2 but V1 stays in the reader set.
    const newRing: KekKeyring = { writerVersion: V2, keys: new Map([...keyring(V2, [V2]).keys, ...oldRing.keys]) };
    expect(decryptCacheBlob(newRing, CONNECTION, ciphertext, kekVersion)).toBe('wrapped-under-v1');
  });

  it('fails closed on a tampered ciphertext byte', () => {
    const ring = keyring(V1, [V1]);
    const { ciphertext } = encryptCacheBlob(ring, CONNECTION, 'plaintext');
    const tampered = new Uint8Array(ciphertext);
    tampered[tampered.length - 1]! ^= 0x01;
    expect(() => decryptCacheBlob(ring, CONNECTION, tampered, V1))
      .toThrowError(new CorruptCacheCiphertextError('decrypt-failed'));
  });

  it('fails the auth tag when the ciphertext is presented for a different connection', () => {
    // The connection id rides the AAD: a cross-connection row swap fails closed.
    const ring = keyring(V1, [V1]);
    const { ciphertext } = encryptCacheBlob(ring, CONNECTION, 'plaintext');
    expect(() => decryptCacheBlob(ring, OTHER_CONNECTION, ciphertext, V1))
      .toThrowError(new CorruptCacheCiphertextError('decrypt-failed'));
  });

  it('reports an unknown kek version distinctly', () => {
    const ring = keyring(V1, [V1]);
    const { ciphertext } = encryptCacheBlob(ring, CONNECTION, 'plaintext');
    expect(() => decryptCacheBlob(keyring(V2, [V2]), CONNECTION, ciphertext, V1))
      .toThrowError(new CorruptCacheCiphertextError('unknown-kek-version'));
  });

  it('reports a null kek version as malformed', () => {
    const ring = keyring(V1, [V1]);
    const { ciphertext } = encryptCacheBlob(ring, CONNECTION, 'plaintext');
    expect(() => decryptCacheBlob(ring, CONNECTION, ciphertext, null))
      .toThrowError(new CorruptCacheCiphertextError('malformed'));
  });

  it('reports a truncated ciphertext as malformed', () => {
    const ring = keyring(V1, [V1]);
    expect(() => decryptCacheBlob(ring, CONNECTION, new Uint8Array(28), V1))
      .toThrowError(new CorruptCacheCiphertextError('malformed'));
  });
});
