import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

/**
 * TPMT_PUBLIC, as much of it as TPM attestation needs (#8318 T1; spec
 * 2026-10-12 §12.2; TPM 2.0 Library Part 2 §12.2.4). Big-endian, TPM2B
 * buffers carry a 2-byte size. Only RSA areas are read: the EK is the RSA-2048
 * default template (§12.1), and the agent creates an RSA AK.
 */

export const TPM_ALG_RSA = 0x0001;
export const TPM_ALG_SHA256 = 0x000b;
export const TPM_ALG_AES = 0x0006;
export const TPM_ALG_CFB = 0x0043;
export const TPM_ALG_NULL = 0x0010;
export const TPM_ALG_RSASSA = 0x0014;

/** TPMA_OBJECT bits (Part 2 §8.3). */
export const TPMA = {
  fixedTPM: 1 << 1,
  stClear: 1 << 2,
  fixedParent: 1 << 4,
  sensitiveDataOrigin: 1 << 5,
  userWithAuth: 1 << 6,
  adminWithPolicy: 1 << 7,
  noDA: 1 << 10,
  encryptedDuplication: 1 << 11,
  restricted: 1 << 16,
  decrypt: 1 << 17,
  sign: 1 << 18,
} as const;

export type RsaPublicArea = {
  /** The marshalled TPMT_PUBLIC, exactly as received: what the object's name hashes. */
  raw: Buffer;
  nameAlg: number;
  attributes: number;
  authPolicy: Buffer;
  /** TPMT_SYM_DEF_OBJECT: TPM_ALG_NULL, or an algorithm with its key bits and mode. */
  symmetric: { algorithm: number; keyBits: number; mode: number } | { algorithm: typeof TPM_ALG_NULL };
  scheme: { algorithm: number; hashAlg: number | null };
  keyBits: number;
  /** 0 in the area means the default, 65537. */
  exponent: number;
  modulus: Buffer;
};

export class TpmStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TpmStructureError';
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  tpm2b(): Buffer {
    const size = this.u16();
    this.need(size);
    const v = this.buf.subarray(this.offset, this.offset + size);
    this.offset += size;
    return Buffer.from(v);
  }
  end(): void {
    if (this.offset !== this.buf.length) throw new TpmStructureError('trailing bytes after the public area');
  }
  private need(n: number): void {
    if (this.offset + n > this.buf.length) throw new TpmStructureError('the public area is truncated');
  }
}

/** Parses an RSA TPMT_PUBLIC; anything else, or a malformed area, throws TpmStructureError. */
export function parseRsaPublic(raw: Buffer): RsaPublicArea {
  const r = new Reader(raw);
  const type = r.u16();
  if (type !== TPM_ALG_RSA) throw new TpmStructureError('not an RSA public area');
  const nameAlg = r.u16();
  const attributes = r.u32();
  const authPolicy = r.tpm2b();
  const symAlg = r.u16();
  const symmetric = symAlg === TPM_ALG_NULL
    ? { algorithm: TPM_ALG_NULL as typeof TPM_ALG_NULL }
    : { algorithm: symAlg, keyBits: r.u16(), mode: r.u16() };
  const schemeAlg = r.u16();
  // Every RSA scheme but NULL carries one hash algorithm (TPMS_SCHEME_HASH).
  const scheme = { algorithm: schemeAlg, hashAlg: schemeAlg === TPM_ALG_NULL ? null : r.u16() };
  const keyBits = r.u16();
  const exponent = r.u32();
  const modulus = r.tpm2b();
  r.end();
  if (modulus.length * 8 !== keyBits) throw new TpmStructureError('the modulus does not match keyBits');
  return { raw: Buffer.from(raw), nameAlg, attributes, authPolicy, symmetric, scheme, keyBits, exponent, modulus };
}

/** TPM2B_NAME of an object: nameAlg (2 bytes) || H_nameAlg(TPMT_PUBLIC). SHA-256 only. */
export function objectName(area: RsaPublicArea): Buffer {
  if (area.nameAlg !== TPM_ALG_SHA256) throw new TpmStructureError('only SHA-256 names are supported');
  const alg = Buffer.alloc(2);
  alg.writeUInt16BE(area.nameAlg);
  return Buffer.concat([alg, createHash('sha256').update(area.raw).digest()]);
}

/** The RSA public key of an area, as a Node key object. */
export function rsaPublicKey(area: RsaPublicArea): KeyObject {
  const e = area.exponent === 0 ? 65537 : area.exponent;
  const eBytes = Buffer.alloc(4);
  eBytes.writeUInt32BE(e);
  const trimmed = eBytes.subarray(eBytes.findIndex((b) => b !== 0));
  return createPublicKey({
    key: { kty: 'RSA', n: area.modulus.toString('base64url'), e: trimmed.toString('base64url') },
    format: 'jwk',
  });
}

/**
 * The EK baseline (§12.2 `tpm_ek_pub_sha256`): SHA-256 of the key's DER
 * SubjectPublicKeyInfo, hex. It names the key, not its TPM encoding, so the
 * same EK reads the same whatever template bytes an agent sends.
 */
export function ekPublicKeySha256(area: RsaPublicArea): string {
  const spki = rsaPublicKey(area).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

/**
 * PolicySecret(TPM_RH_ENDORSEMENT) with SHA-256: the authPolicy of the TCG
 * default EK templates (EK Credential Profile §B.3.3).
 */
export const DEFAULT_EK_POLICY = Buffer.from('837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa', 'hex');

/** The attributes of the TCG RSA-2048 default EK template (0x000300b2). */
export const DEFAULT_EK_ATTRIBUTES = TPMA.fixedTPM | TPMA.fixedParent | TPMA.sensitiveDataOrigin
  | TPMA.adminWithPolicy | TPMA.restricted | TPMA.decrypt;

/** Why an EK area is refused, or null: the RSA-2048 default template, with its key (§12.1). */
export function ekTemplateRefusal(ek: RsaPublicArea): string | null {
  if (ek.nameAlg !== TPM_ALG_SHA256) return 'ek_name_alg';
  if (ek.attributes !== DEFAULT_EK_ATTRIBUTES) return 'ek_attributes';
  if (!ek.authPolicy.equals(DEFAULT_EK_POLICY)) return 'ek_policy';
  if (ek.symmetric.algorithm !== TPM_ALG_AES || !('keyBits' in ek.symmetric) || ek.symmetric.keyBits !== 128 || ek.symmetric.mode !== TPM_ALG_CFB) {
    return 'ek_symmetric';
  }
  if (ek.scheme.algorithm !== TPM_ALG_NULL) return 'ek_scheme';
  if (ek.keyBits !== 2048) return 'ek_key_bits';
  if (ek.exponent !== 0 && ek.exponent !== 65537) return 'ek_exponent';
  return null;
}

/**
 * Why an AK area is refused, or null (§12.2): a restricted signing key that
 * never left its TPM — restricted, sign, fixedTPM, fixedParent,
 * sensitiveDataOrigin — and not a decryption key, named with SHA-256.
 */
export function akTemplateRefusal(ak: RsaPublicArea): string | null {
  if (ak.nameAlg !== TPM_ALG_SHA256) return 'ak_name_alg';
  const required = TPMA.restricted | TPMA.sign | TPMA.fixedTPM | TPMA.fixedParent | TPMA.sensitiveDataOrigin;
  if ((ak.attributes & required) !== required) return 'ak_attributes';
  if ((ak.attributes & TPMA.decrypt) !== 0) return 'ak_attributes';
  if (ak.keyBits < 2048) return 'ak_key_bits';
  return null;
}
