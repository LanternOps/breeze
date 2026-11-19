import { constants, createCipheriv, createHmac, publicEncrypt, randomBytes } from 'node:crypto';
import { objectName, rsaPublicKey, type RsaPublicArea } from './tpm2Public';

/**
 * TPM2_MakeCredential, done in software by the server (#8318 T1; spec
 * 2026-10-12 §12.2; TPM 2.0 Library Part 1 §24 and annex B.10.4). It binds a
 * secret to two keys at once: only the TPM holding the EK's private key can
 * recover the seed, and that TPM releases the secret only to an object whose
 * name is the AK's (TPM2_ActivateCredential).
 *
 * For an RSA EK with AES-128 (the default template):
 *   seed            = 32 random bytes (the EK's OAEP digest size: Part 1
 *                     rev 1.83 B.10.3, as tpm2-tools and go-tpm's tpm2 do)
 *   encryptedSecret = RSA-OAEP(EK, seed, SHA-256, label "IDENTITY\0")
 *   symKey          = KDFa(SHA-256, seed, "STORAGE", AKname, ∅, 128)
 *   encIdentity     = AES-128-CFB(symKey, IV 0, TPM2B(secret))
 *   hmacKey         = KDFa(SHA-256, seed, "INTEGRITY", ∅, ∅, 256)
 *   integrity       = HMAC-SHA-256(hmacKey, encIdentity || AKname)
 *   credentialBlob  = TPM2B(integrity) || encIdentity
 *
 * `credentialBlob` and `encryptedSecret` are the buffers of TPM2B_ID_OBJECT
 * and TPM2B_ENCRYPTED_SECRET, without their size: what the agent passes to
 * TPM2_ActivateCredential. Checked byte for byte against go-tpm's
 * tpm2.CreateCredential (__tests__/vectors/, makeCredential.test.ts). Never log any of it.
 */

const SEED_BYTES = 32;
const SYM_KEY_BITS = 128;
const HASH_BITS = 256;

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** KDFa (Part 1 §11.4.10.2) with HMAC-SHA-256: counter, label with its NUL, contexts, bit length. */
export function kdfaSha256(key: Buffer, label: string, contextU: Buffer, contextV: Buffer, bits: number): Buffer {
  const bytes = Math.ceil(bits / 8);
  const blocks: Buffer[] = [];
  let total = 0;
  for (let counter = 1; total < bytes; counter += 1) {
    const block = createHmac('sha256', key)
      .update(u32(counter))
      .update(Buffer.from(label, 'latin1'))
      .update(Buffer.from([0]))
      .update(contextU)
      .update(contextV)
      .update(u32(bits))
      .digest();
    blocks.push(block);
    total += block.length;
  }
  const out = Buffer.concat(blocks).subarray(0, bytes);
  const mask = bits % 8;
  if (mask > 0) out[0] = out[0]! & ((1 << mask) - 1);
  return out;
}

export type Credential = { credentialBlob: Buffer; encryptedSecret: Buffer };

/**
 * `secret` is at most 32 bytes (a TPM2B_DIGEST under SHA-256). `seed` is for
 * the test vectors only; production draws it at random.
 */
export function makeCredential(ek: RsaPublicArea, ak: RsaPublicArea, secret: Buffer, seed: Buffer = randomBytes(SEED_BYTES)): Credential {
  if (secret.length < 1 || secret.length > 32) throw new Error('the credential secret must be 1 to 32 bytes');
  if (seed.length !== SEED_BYTES) throw new Error('the seed must be 32 bytes');
  const akName = objectName(ak);

  const encryptedSecret = publicEncrypt(
    {
      key: rsaPublicKey(ek),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
      oaepLabel: Buffer.from('IDENTITY\0', 'latin1'),
    },
    seed,
  );

  const symKey = kdfaSha256(seed, 'STORAGE', akName, Buffer.alloc(0), SYM_KEY_BITS);
  const cipher = createCipheriv('aes-128-cfb', symKey, Buffer.alloc(16));
  const encIdentity = Buffer.concat([cipher.update(Buffer.concat([u16(secret.length), secret])), cipher.final()]);

  const hmacKey = kdfaSha256(seed, 'INTEGRITY', Buffer.alloc(0), Buffer.alloc(0), HASH_BITS);
  const integrity = createHmac('sha256', hmacKey).update(encIdentity).update(akName).digest();

  return { credentialBlob: Buffer.concat([u16(integrity.length), integrity, encIdentity]), encryptedSecret };
}
