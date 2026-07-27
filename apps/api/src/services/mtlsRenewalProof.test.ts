import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'crypto';

// -------------------------------------------------------------------
// In-memory Redis stub — supports GET/SET/EVAL (compare-and-delete) with
// real TTL bookkeeping via explicit "now" advancement (no fake timers needed
// since the service reads Date.now()/process time, not Redis's own clock).
// -------------------------------------------------------------------

const { redisState, redisMock, getRedisMock } = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAtMs: number }>();

  function get(key: string): string | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAtMs) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  const mock = {
    async set(key: string, value: string, _ex: string, ttlSeconds: number) {
      store.set(key, { value, expiresAtMs: Date.now() + ttlSeconds * 1000 });
      return 'OK';
    },
    async get(key: string) {
      return get(key);
    },
    async eval(_script: string, _numKeys: number, key: string, expected: string) {
      const current = get(key);
      if (current === expected) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
  };

  return { redisState: store, redisMock: mock, getRedisMock: vi.fn(() => mock) };
});

vi.mock('./redis', () => ({
  getRedis: getRedisMock,
}));

import {
  buildRenewalProofCanonicalBytes,
  issueRenewalChallenge,
  verifyAndConsumeRenewalProof,
  RENEWAL_CHALLENGE_TTL_SECONDS,
} from './mtlsRenewalProof';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE_ID = '99999999-9999-4999-8999-999999999999';

function spkiBase64Of(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

function makeEcKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function makeRsaKeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

async function issueAndSign(
  privateKey: Parameters<typeof sign>[2],
  spkiBase64: string,
  deviceId = DEVICE_ID,
) {
  const challenge = await issueRenewalChallenge(deviceId, spkiBase64);
  if (!challenge) throw new Error('test setup: challenge issuance failed');
  const bytes = buildRenewalProofCanonicalBytes(deviceId, challenge.challengeId, challenge.expiresUnix);
  const signatureBase64 = sign('sha256', bytes, privateKey).toString('base64');
  return {
    challenge,
    proof: {
      challengeId: challenge.challengeId,
      expiresUnix: challenge.expiresUnix,
      signatureBase64,
    },
  };
}

describe('mtlsRenewalProof', () => {
  beforeEach(() => {
    redisState.clear();
    getRedisMock.mockReturnValue(redisMock);
  });

  describe('buildRenewalProofCanonicalBytes', () => {
    it('produces the exact documented canonical byte sequence', () => {
      const bytes = buildRenewalProofCanonicalBytes(DEVICE_ID, 'chal-1', 1234567890);
      expect(bytes.toString('utf8')).toBe(
        ['breeze-mtls-renew-v1', DEVICE_ID, 'chal-1', '1234567890'].join('\n'),
      );
    });
  });

  describe('issueRenewalChallenge', () => {
    it('returns a challengeId and an expiresUnix five minutes out', async () => {
      const before = Math.floor(Date.now() / 1000);
      const challenge = await issueRenewalChallenge(DEVICE_ID, 'spki-b64');
      expect(challenge).not.toBeNull();
      expect(challenge!.challengeId).toMatch(/^[0-9a-f]{32}$/);
      expect(challenge!.expiresUnix).toBeGreaterThanOrEqual(before + RENEWAL_CHALLENGE_TTL_SECONDS);
      expect(challenge!.expiresUnix).toBeLessThanOrEqual(before + RENEWAL_CHALLENGE_TTL_SECONDS + 5);
    });

    it('returns null when Redis is unavailable', async () => {
      getRedisMock.mockReturnValueOnce(null as any);
      const challenge = await issueRenewalChallenge(DEVICE_ID, 'spki-b64');
      expect(challenge).toBeNull();
    });
  });

  describe('verifyAndConsumeRenewalProof — valid signatures', () => {
    it('accepts a valid P-256 (EC) signature and consumes the challenge', async () => {
      const { privateKey, publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const { proof } = await issueAndSign(privateKey, spkiBase64);

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, proof);
      expect(result).toEqual({ ok: true });
    });

    it('accepts a valid RSA signature and consumes the challenge', async () => {
      const { privateKey, publicKey } = makeRsaKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const { proof } = await issueAndSign(privateKey, spkiBase64);

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, proof);
      expect(result).toEqual({ ok: true });
    });
  });

  describe('verifyAndConsumeRenewalProof — replay', () => {
    it('rejects a second presentation of an already-consumed valid proof', async () => {
      const { privateKey, publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const { proof } = await issueAndSign(privateKey, spkiBase64);

      const first = await verifyAndConsumeRenewalProof(DEVICE_ID, proof);
      expect(first.ok).toBe(true);

      const second = await verifyAndConsumeRenewalProof(DEVICE_ID, proof);
      expect(second).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  describe('verifyAndConsumeRenewalProof — expiry', () => {
    it('rejects a proof once the challenge has fallen out of the Redis TTL (expired)', async () => {
      const { privateKey, publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const { proof } = await issueAndSign(privateKey, spkiBase64);

      // Simulate TTL expiry by directly evicting the stored key.
      redisState.clear();

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, proof);
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('rejects a body expiresUnix that does not match what was issued', async () => {
      const { privateKey, publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const { challenge } = await issueAndSign(privateKey, spkiBase64);

      // Sign a DIFFERENT (tampered) expiry than what was actually issued.
      const tamperedExpiry = challenge.expiresUnix + 1;
      const bytes = buildRenewalProofCanonicalBytes(DEVICE_ID, challenge.challengeId, tamperedExpiry);
      const signatureBase64 = sign('sha256', bytes, privateKey).toString('base64');

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, {
        challengeId: challenge.challengeId,
        expiresUnix: tamperedExpiry,
        signatureBase64,
      });
      expect(result).toEqual({ ok: false, reason: 'expiry_mismatch' });
    });
  });

  describe('verifyAndConsumeRenewalProof — wrong device / wrong key', () => {
    it('rejects when verifying against a different deviceId than the challenge was issued for', async () => {
      const { privateKey, publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const { proof } = await issueAndSign(privateKey, spkiBase64, DEVICE_ID);

      // The Redis key itself is namespaced by deviceId, so presenting the
      // proof against a different device can't even find the challenge.
      const result = await verifyAndConsumeRenewalProof(OTHER_DEVICE_ID, proof);
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('rejects a signature produced by the WRONG private key', async () => {
      const { publicKey } = makeEcKeyPair();
      const { privateKey: wrongPrivateKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);

      const challenge = await issueRenewalChallenge(DEVICE_ID, spkiBase64);
      if (!challenge) throw new Error('setup failed');
      const bytes = buildRenewalProofCanonicalBytes(DEVICE_ID, challenge.challengeId, challenge.expiresUnix);
      const signatureBase64 = sign('sha256', bytes, wrongPrivateKey).toString('base64');

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, {
        challengeId: challenge.challengeId,
        expiresUnix: challenge.expiresUnix,
        signatureBase64,
      });
      expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
    });
  });

  describe('verifyAndConsumeRenewalProof — tampered canonical bytes', () => {
    it('rejects a signature that covers a different challengeId than presented', async () => {
      const { privateKey, publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const challenge = await issueRenewalChallenge(DEVICE_ID, spkiBase64);
      if (!challenge) throw new Error('setup failed');

      // Sign bytes for a DIFFERENT challengeId than what was actually issued.
      const bytes = buildRenewalProofCanonicalBytes(DEVICE_ID, 'some-other-challenge-id', challenge.expiresUnix);
      const signatureBase64 = sign('sha256', bytes, privateKey).toString('base64');

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, {
        challengeId: challenge.challengeId,
        expiresUnix: challenge.expiresUnix,
        signatureBase64,
      });
      expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
    });

    it('rejects malformed base64 signature material without throwing', async () => {
      const { publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const challenge = await issueRenewalChallenge(DEVICE_ID, spkiBase64);
      if (!challenge) throw new Error('setup failed');

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, {
        challengeId: challenge.challengeId,
        expiresUnix: challenge.expiresUnix,
        signatureBase64: 'not-valid-base64-signature!!!',
      });
      expect(result.ok).toBe(false);
    });

    it('rejects when the stored public key material is malformed', async () => {
      const challenge = await issueRenewalChallenge(DEVICE_ID, 'not-a-real-spki');
      if (!challenge) throw new Error('setup failed');

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, {
        challengeId: challenge.challengeId,
        expiresUnix: challenge.expiresUnix,
        signatureBase64: Buffer.from('irrelevant').toString('base64'),
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_key' });
    });
  });

  describe('verifyAndConsumeRenewalProof — unknown/never-issued challenge', () => {
    it('rejects a challengeId that was never issued', async () => {
      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, {
        challengeId: 'never-issued',
        expiresUnix: Math.floor(Date.now() / 1000) + 300,
        signatureBase64: Buffer.from('irrelevant').toString('base64'),
      });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  describe('verifyAndConsumeRenewalProof — Redis failure', () => {
    it('fails closed when Redis is unavailable', async () => {
      getRedisMock.mockReturnValueOnce(null as any);
      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, {
        challengeId: 'whatever',
        expiresUnix: Math.floor(Date.now() / 1000) + 300,
        signatureBase64: 'irrelevant',
      });
      expect(result).toEqual({ ok: false, reason: 'redis_unavailable' });
    });

    it('fails closed when the Redis GET call throws', async () => {
      const { publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const challenge = await issueRenewalChallenge(DEVICE_ID, spkiBase64);
      if (!challenge) throw new Error('setup failed');

      getRedisMock.mockReturnValueOnce({
        get: vi.fn(async () => {
          throw new Error('redis down');
        }),
      } as any);

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, {
        challengeId: challenge.challengeId,
        expiresUnix: challenge.expiresUnix,
        signatureBase64: 'irrelevant',
      });
      expect(result).toEqual({ ok: false, reason: 'redis_unavailable' });
    });

    it('fails closed when the Redis EVAL (consume) call throws', async () => {
      const { privateKey, publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const { proof } = await issueAndSign(privateKey, spkiBase64);

      const realGet = redisMock.get.bind(redisMock);
      getRedisMock.mockReturnValueOnce({
        get: realGet,
        eval: vi.fn(async () => {
          throw new Error('redis down');
        }),
      } as any);

      const result = await verifyAndConsumeRenewalProof(DEVICE_ID, proof);
      expect(result).toEqual({ ok: false, reason: 'redis_unavailable' });
    });
  });

  describe('verifyAndConsumeRenewalProof — concurrent replay race', () => {
    it('only the first of two concurrent presentations of the same valid proof succeeds', async () => {
      const { privateKey, publicKey } = makeEcKeyPair();
      const spkiBase64 = spkiBase64Of(publicKey);
      const { proof } = await issueAndSign(privateKey, spkiBase64);

      const [first, second] = await Promise.all([
        verifyAndConsumeRenewalProof(DEVICE_ID, proof),
        verifyAndConsumeRenewalProof(DEVICE_ID, proof),
      ]);

      const results = [first, second];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
    });
  });
});
