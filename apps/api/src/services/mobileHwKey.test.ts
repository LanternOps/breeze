import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    getdel: vi.fn(),
    setex: vi.fn(),
  },
}));

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisMock),
}));

import { getRedis } from './redis';
import {
  consumeMobileAssertionNonce,
  issueMobileAssertionNonce,
  sha256CanonicalSpki,
  toMobileKeyAlg,
  verifyMobileSignature,
} from './mobileHwKey';

const getRedisMock = vi.mocked(getRedis);

function makeDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { spkiB64, privateKey };
}
function sign(privateKey: crypto.KeyObject, payload: string) {
  return crypto.sign('RSA-SHA256', Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock as never);
  redisMock.setex.mockResolvedValue('OK');
});

describe('verifyMobileSignature', () => {
  it('verifies a genuine RSA-SHA256 signature over the nonce (the react-native-biometrics contract)', () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const nonce = 'server-nonce-abc';
    const signature = sign(privateKey, nonce);
    expect(verifyMobileSignature({ publicKeySpkiB64: spkiB64, payload: nonce, signatureB64: signature, alg: 'RS256' })).toBe(true);
  });

  it('rejects a signature over a different nonce (replay/forgery)', () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const signature = sign(privateKey, 'other-nonce');
    expect(verifyMobileSignature({ publicKeySpkiB64: spkiB64, payload: 'server-nonce-abc', signatureB64: signature, alg: 'RS256' })).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const a = makeDeviceKeypair();
    const b = makeDeviceKeypair();
    const signature = sign(b.privateKey, 'n');
    expect(verifyMobileSignature({ publicKeySpkiB64: a.spkiB64, payload: 'n', signatureB64: signature, alg: 'RS256' })).toBe(false);
  });

  it('returns false (never throws) on malformed public key', () => {
    const { privateKey } = makeDeviceKeypair();
    const signature = sign(privateKey, 'n');
    expect(verifyMobileSignature({ publicKeySpkiB64: 'not-a-real-key', payload: 'n', signatureB64: signature, alg: 'RS256' })).toBe(false);
  });

  it('returns false (never throws) on malformed signature', () => {
    const { spkiB64 } = makeDeviceKeypair();
    expect(verifyMobileSignature({ publicKeySpkiB64: spkiB64, payload: 'n', signatureB64: '@@not base64@@', alg: 'RS256' })).toBe(false);
  });

  it('returns false (never throws) on empty input', () => {
    expect(verifyMobileSignature({ publicKeySpkiB64: '', payload: '', signatureB64: '', alg: 'RS256' })).toBe(false);
  });
});

describe('mobile nonce helpers', () => {
  it('issueMobileAssertionNonce stores <issuedAt>:<nonce> at mobile-assertion:<approvalId>:<userId> for 120s', async () => {
    const before = Date.now();
    const nonce = await issueMobileAssertionNonce('ap1', 'u1');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [key, ttl, stored] = redisMock.setex.mock.calls[0]!;
    expect(key).toBe('mobile-assertion:ap1:u1');
    expect(ttl).toBe(120);
    const sep = (stored as string).indexOf(':');
    const issuedAt = Number((stored as string).slice(0, sep));
    expect((stored as string).slice(sep + 1)).toBe(nonce);
    expect(issuedAt).toBeGreaterThanOrEqual(before);
  });

  it('consumeMobileAssertionNonce getdels the key and returns {nonce, issuedAt} (single-use)', async () => {
    redisMock.getdel.mockResolvedValue('1781000000000:stored-nonce');
    const result = await consumeMobileAssertionNonce('ap1', 'u1');
    expect(redisMock.getdel).toHaveBeenCalledWith('mobile-assertion:ap1:u1');
    expect(result).toEqual({ nonce: 'stored-nonce', issuedAt: 1781000000000 });
  });

  it('consume returns null when the key is absent (expired / never issued)', async () => {
    redisMock.getdel.mockResolvedValue(null);
    expect(await consumeMobileAssertionNonce('ap1', 'u1')).toBeNull();
  });

  it('consume tolerates a legacy bare nonce (no issued-at prefix) as issued-now', async () => {
    const before = Date.now();
    redisMock.getdel.mockResolvedValue('legacy-bare-nonce');
    const result = await consumeMobileAssertionNonce('ap1', 'u1');
    expect(result?.nonce).toBe('legacy-bare-nonce');
    expect(result?.issuedAt).toBeGreaterThanOrEqual(before);
  });

  it('issue throws when redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    await expect(issueMobileAssertionNonce('ap1', 'u1')).rejects.toThrow('redis unavailable');
  });

  it('consume throws when redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    await expect(consumeMobileAssertionNonce('ap1', 'u1')).rejects.toThrow('redis unavailable');
  });
});

// --- #1374 W02: ES256/P-256 alongside RS256 --------------------------------
//
// The Apple Secure Enclave holds ONLY 256-bit EC private keys, and Android
// StrongBox/TEE approval keys are minted as P-256, so an attested platform-bound
// key is necessarily ES256. RS256 stays supported for every key registered
// before this wave (react-native-biometrics mints RSA-2048).

function makeEcKeypair(namedCurve = 'P-256') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve });
  return { spkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey };
}
function signEc(privateKey: crypto.KeyObject, payload: string) {
  // DER (X9.62) is node's default dsaEncoding, and is what
  // SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256) and
  // java Signature("SHA256withECDSA") both emit.
  return crypto.sign('SHA256', Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

describe('verifyMobileSignature — ES256', () => {
  it('verifies an ES256 (P-256) signature against a stored SPKI key', () => {
    const { spkiB64, privateKey } = makeEcKeypair();
    const payload = 'nonce-abc';
    expect(
      verifyMobileSignature({
        publicKeySpkiB64: spkiB64,
        payload,
        signatureB64: signEc(privateKey, payload),
        alg: 'ES256',
      }),
    ).toBe(true);
  });

  it('rejects an ES256 signature over a different payload', () => {
    const { spkiB64, privateKey } = makeEcKeypair();
    expect(
      verifyMobileSignature({
        publicKeySpkiB64: spkiB64,
        payload: 'other',
        signatureB64: signEc(privateKey, 'nonce-abc'),
        alg: 'ES256',
      }),
    ).toBe(false);
  });

  it('rejects an EC key presented as RS256 (algorithm confusion)', () => {
    const { spkiB64, privateKey } = makeEcKeypair();
    expect(
      verifyMobileSignature({
        publicKeySpkiB64: spkiB64,
        payload: 'n',
        signatureB64: signEc(privateKey, 'n'),
        alg: 'RS256',
      }),
    ).toBe(false);
  });

  it('rejects an RSA key presented as ES256 (algorithm confusion, other direction)', () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    expect(
      verifyMobileSignature({
        publicKeySpkiB64: spkiB64,
        payload: 'n',
        signatureB64: sign(privateKey, 'n'),
        alg: 'ES256',
      }),
    ).toBe(false);
  });

  it('rejects a NON-P-256 EC curve under ES256 — the label names the curve', () => {
    // "ES256" is ECDSA-SHA256 over P-256. `crypto.verify` alone would happily
    // accept a P-384 key here, and the ios_se_p256_app_attest basis would then
    // be describing a key the Secure Enclave cannot hold.
    const { spkiB64, privateKey } = makeEcKeypair('P-384');
    expect(
      verifyMobileSignature({
        publicKeySpkiB64: spkiB64,
        payload: 'n',
        signatureB64: signEc(privateKey, 'n'),
        alg: 'ES256',
      }),
    ).toBe(false);
  });

  it('rejects an undersized RSA modulus under RS256', () => {
    // react-native-biometrics mints RSA-2048; anything smaller is forgeable
    // enough that it must not carry an approval, legacy row or not.
    //
    // These are PUBLIC test vectors for a throwaway 1024-bit key: an SPKI and a
    // genuine RSA-SHA256 signature over the payload 'n'. The private key was
    // discarded at generation and nothing is protected with any of this.
    //
    // They are committed rather than minted in-test for two reasons. The
    // signature must be REAL — with a garbage signature the call would return
    // false anyway and this test would be vacuous, proving nothing about the
    // modulus floor it exists to pin. And calling
    // `generateKeyPairSync('rsa', { modulusLength: 1024 })` here trips CodeQL's
    // js/insufficient-key-size (high) — correctly by the letter of the rule,
    // since a weak key really would be generated, even though the whole point
    // is that we REJECT it. Vectors sidestep the sink without weakening the
    // assertion or dismissing a scanner finding.
    //
    // To regenerate:
    //   const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    //   publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    //   crypto.sign('RSA-SHA256', Buffer.from('n', 'utf8'), privateKey).toString('base64');
    const WEAK_RSA1024_SPKI_B64 =
      'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDNgEPIiNLf6ClxhbvERAyoLHOuV8Imla8ko+hkv4Yefg1ARbPBcixO+NDp9uWuy2evCv1VpeVjkSALttH0A1jkircplD9fp+TPOEDCNCzInlVDGBdUxSXcRMyS1YqPa/PwvqlBsk5zy5+VCUXa9WhGepoN0IoO8peDgHljrROnSQIDAQAB';
    const WEAK_RSA1024_SIG_OVER_N_B64 =
      'emOQP1xjbn6AX9SVzSNww8PDVlDgQYAQzBVmMf8yBRe0JKS5bVi9iI7Sk4B6Ju8TlkGaMM3aTzNjozVdoVo6eSPu5XfDSuzU27dYPidsMFVkVs4ew5CB59lsL+W9oLvnmHg+FRFTJWwx3pD1RPN8DlemzTsbfv0mtLxOfuAR+3Y=';

    // Control: the vectors really are a 1024-bit key and a signature that
    // VERIFIES against it. Without this the test could silently degrade into
    // "malformed input returns false" and still pass.
    const key = crypto.createPublicKey({
      key: Buffer.from(WEAK_RSA1024_SPKI_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(1024);
    expect(
      crypto.verify(
        'SHA256',
        Buffer.from('n', 'utf8'),
        key,
        Buffer.from(WEAK_RSA1024_SIG_OVER_N_B64, 'base64'),
      ),
    ).toBe(true);

    // ...and yet the approval verifier refuses it, purely on the modulus floor.
    expect(
      verifyMobileSignature({
        publicKeySpkiB64: WEAK_RSA1024_SPKI_B64,
        payload: 'n',
        signatureB64: WEAK_RSA1024_SIG_OVER_N_B64,
        alg: 'RS256',
      }),
    ).toBe(false);
  });
});

describe('toMobileKeyAlg', () => {
  it('accepts the two supported labels', () => {
    expect(toMobileKeyAlg('RS256')).toBe('RS256');
    expect(toMobileKeyAlg('ES256')).toBe('ES256');
  });

  it('returns null for anything else — an unknown stored label must fail closed, not default to RS256', () => {
    for (const bad of ['HS256', 'none', '', 'rs256', null, undefined]) {
      expect(toMobileKeyAlg(bad as never)).toBeNull();
    }
  });
});

describe('sha256CanonicalSpki', () => {
  it('is a 32-byte digest of the canonical SPKI DER', () => {
    const { spkiB64 } = makeEcKeypair();
    const digest = sha256CanonicalSpki(spkiB64);
    expect(digest).toHaveLength(32);
    expect(digest).toEqual(crypto.createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest());
  });

  it('is stable across a re-encoded but equivalent SPKI (whitespace/padding noise)', () => {
    // A client that base64s with newlines, or omits padding, must not produce a
    // different attested-key digest for the same key.
    const { spkiB64 } = makeEcKeypair();
    const noisy = spkiB64.replace(/=+$/, '').match(/.{1,64}/g)!.join('\n');
    expect(sha256CanonicalSpki(noisy)).toEqual(sha256CanonicalSpki(spkiB64));
  });

  it('returns null (never throws) for an unparseable key', () => {
    expect(sha256CanonicalSpki('not-a-key')).toBeNull();
    expect(sha256CanonicalSpki('')).toBeNull();
  });
});
