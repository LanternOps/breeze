import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

// Redis is the only side effect here; the transcript is pure.
const { redisStore, redisMock } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    redisStore: store,
    redisMock: {
      setex: vi.fn(async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      // Real getdel semantics: atomic read-and-delete. This is what makes an
      // attempt single-use, so faking it as a plain `get` would make the
      // replay test below vacuous.
      getdel: vi.fn(async (key: string) => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      }),
    },
  };
});

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisMock),
}));


import { getRedis } from './redis';
import {
  ATTEMPT_TTL_SECONDS,
  consumeRegistrationAttempt,
  issueRegistrationAttempt,
  registrationTranscript,
  verifyPlatformAttestation,
} from './authenticatorAttestation';

const getRedisMock = vi.mocked(getRedis);

beforeEach(() => {
  vi.clearAllMocks();
  redisStore.clear();
  getRedisMock.mockReturnValue(redisMock as never);
});

describe('registrationTranscript', () => {
  const base = {
    attemptId: 'a1',
    challenge: 'c1',
    publicKeyAlg: 'ES256' as const,
    publicKeySpkiB64: 'spki',
  };

  it('is a 32-byte digest', () => {
    expect(registrationTranscript(base)).toHaveLength(32);
  });

  it('is domain-separated — the same field values without the tag differ', () => {
    // Guards against a signature minted for one Breeze flow being replayed into
    // registration. The tag is inside the hashed input, so this is structural.
    expect(registrationTranscript(base).toString('hex')).not.toBe(
      crypto.createHash('sha256').update(['a1', 'c1', 'ES256', 'spki'].join('\n')).digest('hex'),
    );
  });

  it('matches the exact documented pre-image — the client must reproduce it byte for byte', () => {
    // W05/W06 mint this digest on-device. Pinning the pre-image here means a
    // silent change to the field order or separator fails CI instead of
    // failing every phone in the field.
    expect(registrationTranscript(base)).toEqual(
      crypto
        .createHash('sha256')
        .update(['breeze.authenticator.mobile-register.v1', 'a1', 'c1', 'ES256', 'spki'].join('\n'), 'utf8')
        .digest(),
    );
  });

  it.each([
    ['attemptId', { attemptId: 'a2' }],
    ['challenge', { challenge: 'c2' }],
    ['publicKeyAlg', { publicKeyAlg: 'RS256' as const }],
    ['publicKeySpkiB64', { publicKeySpkiB64: 'other' }],
  ])('changes when %s changes', (_name, patch) => {
    expect(registrationTranscript({ ...base, ...patch })).not.toEqual(registrationTranscript(base));
  });

  it('is not confusable across field boundaries', () => {
    // 'ab' + 'c' must not collide with 'a' + 'bc'. The newline separator is
    // load-bearing; assert it rather than trusting it.
    expect(registrationTranscript({ ...base, attemptId: 'ab', challenge: 'c' })).not.toEqual(
      registrationTranscript({ ...base, attemptId: 'a', challenge: 'bc' }),
    );
  });
});

describe('registration attempt lifecycle', () => {
  it('issues a uuid attempt with 32 random bytes of challenge, stored under the documented key/TTL', async () => {
    const before = Date.now();
    const attempt = await issueRegistrationAttempt('user-1', 'ios');

    expect(attempt.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // 32 bytes base64url = 43 chars, unpadded.
    expect(attempt.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.userId).toBe('user-1');
    expect(attempt.platform).toBe('ios');
    expect(attempt.issuedAt).toBeGreaterThanOrEqual(before);

    const [key, ttl] = redisMock.setex.mock.calls[0]!;
    expect(key).toBe(`authenticator-attest:${attempt.attemptId}`);
    expect(ttl).toBe(ATTEMPT_TTL_SECONDS);
    expect(ATTEMPT_TTL_SECONDS).toBe(300);
  });

  it('issues a distinct challenge every time (no reuse across attempts)', async () => {
    const a = await issueRegistrationAttempt('user-1', 'ios');
    const b = await issueRegistrationAttempt('user-1', 'ios');
    expect(a.attemptId).not.toBe(b.attemptId);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it('is single-use — a second consume returns null', async () => {
    const a = await issueRegistrationAttempt('user-1', 'ios');
    expect(await consumeRegistrationAttempt(a.attemptId)).toMatchObject({
      attemptId: a.attemptId,
      userId: 'user-1',
      platform: 'ios',
      challenge: a.challenge,
    });
    expect(await consumeRegistrationAttempt(a.attemptId)).toBeNull();
    expect(redisMock.getdel).toHaveBeenCalledWith(`authenticator-attest:${a.attemptId}`);
  });

  it('returns null for an unknown attempt id', async () => {
    expect(await consumeRegistrationAttempt('nope')).toBeNull();
  });

  it('returns null (never throws) when the stored value is corrupt', async () => {
    redisStore.set('authenticator-attest:corrupt', 'not json');
    expect(await consumeRegistrationAttempt('corrupt')).toBeNull();
  });

  it('throws when redis is unavailable — an attempt that cannot be stored must not be issued', async () => {
    getRedisMock.mockReturnValue(null as never);
    await expect(issueRegistrationAttempt('user-1', 'ios')).rejects.toThrow('redis unavailable');
    await expect(consumeRegistrationAttempt('a-1')).rejects.toThrow('redis unavailable');
  });
});

describe('verifyPlatformAttestation (W02 stub)', () => {
  const transcript = Buffer.alloc(32, 1);

  it('resolves unattested for iOS — no verifier is wired until W03', async () => {
    const result = await verifyPlatformAttestation({
      attestation: { platform: 'ios', attestationObject: 'cbor', keyId: 'kid' },
      transcript,
      publicKeySpkiB64: 'spki',
    });
    expect(result).toEqual({
      basis: 'unattested',
      verifiedAt: null,
      keyId: null,
      evidence: {},
      appIntegrityVerifiedAt: null,
    });
  });

  it('resolves unattested for Android — no verifier is wired until W04', async () => {
    const result = await verifyPlatformAttestation({
      attestation: { platform: 'android', certificateChain: ['a', 'b'] },
      transcript,
      publicKeySpkiB64: 'spki',
    });
    expect(result.basis).toBe('unattested');
    expect(result.verifiedAt).toBeNull();
  });

  it('returns a fresh evidence object each call — a caller cannot poison the next registration', async () => {
    const first = await verifyPlatformAttestation({
      attestation: { platform: 'ios', attestationObject: 'x', keyId: 'k' },
      transcript,
      publicKeySpkiB64: 'spki',
    });
    (first.evidence as Record<string, unknown>).forged = 'ios_se_p256_app_attest';
    const second = await verifyPlatformAttestation({
      attestation: { platform: 'ios', attestationObject: 'y', keyId: 'k2' },
      transcript,
      publicKeySpkiB64: 'spki',
    });
    expect(second.evidence).toEqual({});
  });

  // The cross-module half of this contract — that whatever this stub returns is
  // NOT in L4_TRUSTED_PLATFORM_BOUND_BASES — is asserted in
  // authenticatorAssurance.test.ts, which already stubs the db layer that
  // importing that module pulls in.
});
