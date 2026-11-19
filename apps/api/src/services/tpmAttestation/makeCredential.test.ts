import { constants, createPrivateKey, privateDecrypt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kdfaSha256, makeCredential } from './makeCredential';
import {
  akTemplateRefusal,
  ekPublicKeySha256,
  ekTemplateRefusal,
  objectName,
  parseRsaPublic,
  TPMA,
  TpmStructureError,
} from './tpm2Public';

/**
 * #8318 T1 (spec 2026-10-12 §12.2 review gate): MakeCredential against
 * go-tpm's tpm2.CreateCredential, through __tests__/vectors/makeCredential.vectors.json
 * (generator: __tests__/vectors/gen). The credential blob is byte-exact for the same
 * seed; the encrypted seed is checked by decrypting it with the EK's private
 * key (OAEP draws its own randomness), both go-tpm's and ours.
 */

type Vector = {
  name: string;
  ekPublic: string;
  ekPrivatePkcs8: string;
  ekSpkiSha256: string;
  akPublic: string;
  akName: string;
  seed: string;
  secret: string;
  credentialBlob: string;
  encryptedSeed: string;
};

const { vectors } = JSON.parse(readFileSync(join(__dirname, '__tests__/vectors/makeCredential.vectors.json'), 'utf8')) as { vectors: Vector[] };
const b = (s: string) => Buffer.from(s, 'base64');

function decryptSeed(v: Vector, encrypted: Buffer): Buffer {
  return privateDecrypt({
    key: createPrivateKey({ key: b(v.ekPrivatePkcs8), format: 'der', type: 'pkcs8' }),
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
    oaepLabel: Buffer.from('IDENTITY\0', 'latin1'),
  }, encrypted);
}

describe('MakeCredential against go-tpm (#8318 T1)', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(3);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s: names, parses and credentials as go-tpm does', (_name, v) => {
    const ek = parseRsaPublic(b(v.ekPublic));
    const ak = parseRsaPublic(b(v.akPublic));
    expect(ekTemplateRefusal(ek)).toBeNull();
    expect(akTemplateRefusal(ak)).toBeNull();
    expect(objectName(ak).toString('base64')).toBe(v.akName);
    expect(ekPublicKeySha256(ek)).toBe(v.ekSpkiSha256);

    const ours = makeCredential(ek, ak, b(v.secret), b(v.seed));
    expect(ours.credentialBlob.toString('base64')).toBe(v.credentialBlob);
    // go-tpm's encrypted seed and ours both open to the seed with the EK.
    expect(decryptSeed(v, b(v.encryptedSeed)).toString('base64')).toBe(v.seed);
    expect(decryptSeed(v, ours.encryptedSecret).toString('base64')).toBe(v.seed);
  });

  it('draws a fresh seed each time', () => {
    const v = vectors[0]!;
    const ek = parseRsaPublic(b(v.ekPublic));
    const ak = parseRsaPublic(b(v.akPublic));
    const one = makeCredential(ek, ak, b(v.secret));
    const two = makeCredential(ek, ak, b(v.secret));
    expect(one.credentialBlob.equals(two.credentialBlob)).toBe(false);
    expect(decryptSeed(v, one.encryptedSecret)).toHaveLength(32);
  });

  it('refuses a secret that does not fit a TPM2B_DIGEST, and a wrong seed size', () => {
    const v = vectors[0]!;
    const ek = parseRsaPublic(b(v.ekPublic));
    const ak = parseRsaPublic(b(v.akPublic));
    expect(() => makeCredential(ek, ak, Buffer.alloc(0))).toThrow();
    expect(() => makeCredential(ek, ak, Buffer.alloc(33))).toThrow();
    expect(() => makeCredential(ek, ak, Buffer.alloc(32), Buffer.alloc(16))).toThrow();
  });
});

describe('KDFa (TPM 2.0 Part 1 §11.4.10.2)', () => {
  it('masks the unused high bits of a bit length that is not a byte multiple', () => {
    const key = Buffer.alloc(16, 7);
    const full = kdfaSha256(key, 'STORAGE', Buffer.alloc(0), Buffer.alloc(0), 16);
    const odd = kdfaSha256(key, 'STORAGE', Buffer.alloc(0), Buffer.alloc(0), 12);
    expect(odd).toHaveLength(2);
    expect(odd[0]! & 0xf0).toBe(0);
    expect(full.length).toBe(2);
  });

  it('spans more than one HMAC block', () => {
    expect(kdfaSha256(Buffer.alloc(16, 1), 'X', Buffer.alloc(0), Buffer.alloc(0), 512)).toHaveLength(64);
  });
});

describe('TPMT_PUBLIC checks (§12.1, §12.2)', () => {
  const v = vectors[0]!;
  const withAttributes = (raw: Buffer, attributes: number) => {
    const copy = Buffer.from(raw);
    copy.writeUInt32BE(attributes >>> 0, 4);
    return parseRsaPublic(copy);
  };

  it('refuses an EK that is not the default template', () => {
    const ek = b(v.ekPublic);
    expect(ekTemplateRefusal(withAttributes(ek, parseRsaPublic(ek).attributes & ~TPMA.fixedTPM))).toBe('ek_attributes');
    const policy = Buffer.from(ek);
    policy[10] = policy[10]! ^ 0xff; // first byte of the authPolicy digest
    expect(ekTemplateRefusal(parseRsaPublic(policy))).toBe('ek_policy');
  });

  it('refuses an AK that is not a restricted signing key bound to its TPM', () => {
    const ak = b(v.akPublic);
    const attrs = parseRsaPublic(ak).attributes;
    for (const bit of [TPMA.restricted, TPMA.sign, TPMA.fixedTPM, TPMA.fixedParent, TPMA.sensitiveDataOrigin]) {
      expect(akTemplateRefusal(withAttributes(ak, attrs & ~bit))).toBe('ak_attributes');
    }
    expect(akTemplateRefusal(withAttributes(ak, attrs | TPMA.decrypt))).toBe('ak_attributes');
  });

  it('refuses an AK with a symmetric algorithm or a scheme other than RSASSA/RSAPSS over SHA-256', () => {
    const ak = b(v.akPublic);
    const area = parseRsaPublic(ak);
    expect(akTemplateRefusal(area)).toBeNull();
    // Layout after the 4-byte attributes: authPolicy (TPM2B), then symmetric (u16 NULL), then scheme, hash.
    const policyLen = ak.readUInt16BE(8);
    const sym = 10 + policyLen;
    const withScheme = (scheme: number, hash: number) => {
      const copy = Buffer.from(ak);
      copy.writeUInt16BE(scheme, sym + 2);
      copy.writeUInt16BE(hash, sym + 4);
      return parseRsaPublic(copy);
    };
    expect(akTemplateRefusal(withScheme(0x0016, 0x000b))).toBeNull(); // RSAPSS, SHA-256
    expect(akTemplateRefusal(withScheme(0x0014, 0x000c))).toBe('ak_scheme'); // RSASSA, SHA-384
    expect(akTemplateRefusal(withScheme(0x0017, 0x000b))).toBe('ak_scheme'); // OAEP
    // A symmetric definition: algorithm, keyBits and mode inserted after the policy.
    const withSym = Buffer.concat([ak.subarray(0, sym), Buffer.from([0x00, 0x06, 0x00, 0x80, 0x00, 0x43]), ak.subarray(sym + 2)]);
    expect(akTemplateRefusal(parseRsaPublic(withSym))).toBe('ak_symmetric');
  });

  it('reads an RSAES scheme, which carries no hash', () => {
    const ak = b(v.akPublic);
    const sym = 10 + ak.readUInt16BE(8);
    // RSAES replaces RSASSA and its hash: 2 bytes shorter.
    const rsaes = Buffer.concat([ak.subarray(0, sym + 2), Buffer.from([0x00, 0x15]), ak.subarray(sym + 6)]);
    const area = parseRsaPublic(rsaes);
    expect(area.scheme).toEqual({ algorithm: 0x0015, hashAlg: null });
    expect(akTemplateRefusal(area)).toBe('ak_scheme');
  });

  it('refuses a malformed area', () => {
    const ak = b(v.akPublic);
    expect(() => parseRsaPublic(ak.subarray(0, ak.length - 1))).toThrow(TpmStructureError);
    expect(() => parseRsaPublic(Buffer.concat([ak, Buffer.from([0])]))).toThrow(TpmStructureError);
    const ecc = Buffer.from(ak);
    ecc.writeUInt16BE(0x0023, 0);
    expect(() => parseRsaPublic(ecc)).toThrow(TpmStructureError);
  });
});
