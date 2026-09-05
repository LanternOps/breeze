import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

// Redis is the only side effect here; the transcript is pure.
const { redisStore, redisMock, sentryMocks } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    redisStore: store,
    sentryMocks: { captureException: vi.fn() },
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

vi.mock('./sentry', () => ({ ...sentryMocks }));


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

  it('returns null (never throws) when the stored value is corrupt, and REPORTS it', async () => {
    // The caller is told "expired"; the operator must be told the truth. This
    // key is a randomUUID keyspace we wrote ourselves with JSON.stringify
    // moments earlier, so a parse failure is Redis corruption, a namespace
    // collision, or a serialization bug — never caller behaviour. Swallowing it
    // into a bare `null` would make a server defect indistinguishable from an
    // ordinary expiry.
    redisStore.set('authenticator-attest:corrupt', 'not json');
    expect(await consumeRegistrationAttempt('corrupt')).toBeNull();
    expect(sentryMocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      expect.objectContaining({ reason: 'attempt_corrupt' }),
    );
  });

  it('does NOT report a plain miss — an expired or unknown attempt is routine', async () => {
    expect(await consumeRegistrationAttempt('never-issued')).toBeNull();
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
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

  it('resolves unattested for Android when the chain does not verify', async () => {
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

describe('registration proof-of-possession, end to end with real crypto', () => {
  // registrationTranscript and verifyMobileSignature are each proven correct in
  // isolation, and the route suite proves they are WIRED together — but with
  // both mocked. Nothing else builds a real transcript, signs it with a real
  // key, and verifies it through the real verifier in one assertion, so the
  // binding is otherwise true only by inference across three files. This is the
  // exact contract W05/W06 have to reproduce on-device.
  const base = {
    attemptId: '9f1c8b2e-0000-4000-8000-000000000001',
    challenge: crypto.randomBytes(32).toString('base64url'),
  };

  function signTranscript(privateKey: crypto.KeyObject, transcript: Buffer) {
    // The client signs the BASE64 TEXT of the digest, not the raw bytes — that
    // is what the route passes as `payload`, and verifyMobileSignature reads
    // `payload` as utf8.
    return crypto
      .sign('SHA256', Buffer.from(transcript.toString('base64'), 'utf8'), privateKey)
      .toString('base64');
  }

  it('accepts a P-256 signature over the transcript for the key being registered', async () => {
    const { verifyMobileSignature } = await import('./mobileHwKey');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    const transcript = registrationTranscript({
      ...base,
      publicKeyAlg: 'ES256',
      publicKeySpkiB64: spki,
    });

    expect(
      verifyMobileSignature({
        publicKeySpkiB64: spki,
        payload: transcript.toString('base64'),
        signatureB64: signTranscript(privateKey, transcript),
        alg: 'ES256',
      }),
    ).toBe(true);
  });

  it('REJECTS a signature bound to a different challenge — this is the replay defence', async () => {
    const { verifyMobileSignature } = await import('./mobileHwKey');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    // The phone signs the transcript for attempt A...
    const signature = signTranscript(
      privateKey,
      registrationTranscript({ ...base, publicKeyAlg: 'ES256', publicKeySpkiB64: spki }),
    );
    // ...and the server derives the transcript for the attempt it actually
    // consumed, which carries a different challenge.
    const serverTranscript = registrationTranscript({
      ...base,
      challenge: crypto.randomBytes(32).toString('base64url'),
      publicKeyAlg: 'ES256',
      publicKeySpkiB64: spki,
    });

    expect(
      verifyMobileSignature({
        publicKeySpkiB64: spki,
        payload: serverTranscript.toString('base64'),
        signatureB64: signature,
        alg: 'ES256',
      }),
    ).toBe(false);
  });

  it('REJECTS a signature bound to a DIFFERENT key — the transcript commits to the SPKI', async () => {
    // Key substitution: an attacker replays a PoP the victim minted for key A
    // while registering their own key B. The SPKI is inside the transcript, so
    // the signature no longer covers what is being registered.
    const { verifyMobileSignature } = await import('./mobileHwKey');
    const victim = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const attacker = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const victimSpki = victim.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const attackerSpki = attacker.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    const signature = signTranscript(
      victim.privateKey,
      registrationTranscript({ ...base, publicKeyAlg: 'ES256', publicKeySpkiB64: victimSpki }),
    );
    const serverTranscript = registrationTranscript({
      ...base,
      publicKeyAlg: 'ES256',
      publicKeySpkiB64: attackerSpki,
    });

    expect(
      verifyMobileSignature({
        publicKeySpkiB64: attackerSpki,
        payload: serverTranscript.toString('base64'),
        signatureB64: signature,
        alg: 'ES256',
      }),
    ).toBe(false);
  });

  it('binds the algorithm too — an RS256-declared transcript is not satisfied by the ES256 one', async () => {
    const { verifyMobileSignature } = await import('./mobileHwKey');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    const signature = signTranscript(
      privateKey,
      registrationTranscript({ ...base, publicKeyAlg: 'ES256', publicKeySpkiB64: spki }),
    );
    const rsTranscript = registrationTranscript({
      ...base,
      publicKeyAlg: 'RS256',
      publicKeySpkiB64: spki,
    });

    expect(
      verifyMobileSignature({
        publicKeySpkiB64: spki,
        payload: rsTranscript.toString('base64'),
        signatureB64: signature,
        alg: 'ES256',
      }),
    ).toBe(false);
  });
});
