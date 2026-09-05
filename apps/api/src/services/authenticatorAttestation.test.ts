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

// The App Attest verifier has its own exhaustive suite against a synthetic CA
// (attestation/appleAppAttest.test.ts). What is under test HERE is the
// dispatcher's contract with it: which basis a pass maps to, that evidence
// carries digests only, and that a throw is a downgrade rather than a 5xx.
// It cannot be exercised for real through this seam — the dispatcher always
// pins the live Apple root, by design.
const { appAttestMock } = vi.hoisted(() => ({ appAttestMock: { verifyAppAttestAttestation: vi.fn() } }));
// Only the FUNCTION is replaced. `AppAttestVerificationError` stays real, because
// the dispatcher branches on `instanceof` it — a stubbed stand-in class would
// make the "rejection vs. defect" test pass against a fake taxonomy.
vi.mock('./attestation/appleAppAttest', async (importActual) => ({
  ...(await importActual<typeof import('./attestation/appleAppAttest')>()),
  ...appAttestMock,
}));


import { getRedis } from './redis';
import { AppAttestVerificationError } from './attestation/appleAppAttest';
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

describe('verifyPlatformAttestation', () => {
  const transcript = Buffer.alloc(32, 1);
  const iosAttestation = { platform: 'ios' as const, attestationObject: 'cbor', keyId: 'kid' };
  const passingVerifier = {
    attestedPublicKeyDer: Buffer.from('app-attest-key'),
    receiptB64: Buffer.from('receipt').toString('base64'),
  };

  it('maps an ES256 approval key to the L4-trusted Secure-Enclave basis (#1374 W03)', async () => {
    appAttestMock.verifyAppAttestAttestation.mockReturnValue(passingVerifier);
    const result = await verifyPlatformAttestation({
      attestation: iosAttestation,
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    expect(result.basis).toBe('ios_se_p256_app_attest');
    expect(result.verifiedAt).toBeInstanceOf(Date);
    expect(result.appIntegrityVerifiedAt).toBeInstanceOf(Date);
    expect(result.keyId).toBe('kid');
  });

  it('maps an RS256 approval key to the NON-L4 keychain basis — the Secure Enclave holds only P-256', async () => {
    appAttestMock.verifyAppAttestAttestation.mockReturnValue(passingVerifier);
    const result = await verifyPlatformAttestation({
      attestation: iosAttestation,
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'RS256',
    });
    // A PASSING App Attest verification still does not make an RSA key
    // hardware-resident. If this ever flips to ios_se_p256_app_attest the L4
    // bypass this whole plan closes is re-opened.
    expect(result.basis).toBe('ios_keychain_rsa_app_attest');
    expect(result.verifiedAt).toBeInstanceOf(Date);
  });

  it('passes the server-derived transcript through as clientDataHash', async () => {
    appAttestMock.verifyAppAttestAttestation.mockReturnValue(passingVerifier);
    await verifyPlatformAttestation({
      attestation: iosAttestation,
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    expect(appAttestMock.verifyAppAttestAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        attestationObjectB64: 'cbor',
        keyIdB64: 'kid',
        clientDataHash: transcript,
        appId: 'D8W6N2JYMA.com.breeze.rmm',
        environment: 'production',
      }),
    );
    // The pinned root is NOT overridable from here — an injectable trust anchor
    // on the request path would be the whole point of the pinning, undone.
    const call = appAttestMock.verifyAppAttestAttestation.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(call).toBeDefined();
    expect(call?.rootCertificatesPem).toBeUndefined();
  });

  it('stores DIGESTS of the attested key and receipt, never the raw receipt', async () => {
    appAttestMock.verifyAppAttestAttestation.mockReturnValue(passingVerifier);
    const result = await verifyPlatformAttestation({
      attestation: iosAttestation,
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    expect(result.evidence).toEqual({
      verifier: 'apple_app_attest',
      verifierVersion: 1,
      appId: 'D8W6N2JYMA.com.breeze.rmm',
      environment: 'production',
      attestedAppAttestKeySha256: crypto
        .createHash('sha256')
        .update(passingVerifier.attestedPublicKeyDer)
        .digest('hex'),
      receiptSha256: crypto.createHash('sha256').update(Buffer.from('receipt')).digest('hex'),
    });
    // The receipt is a bearer artifact for Apple's fraud-metric endpoint.
    expect(JSON.stringify(result.evidence)).not.toContain(passingVerifier.receiptB64);
  });

  it('downgrades to unattested when the verifier REJECTS — never a 5xx, never a page', async () => {
    appAttestMock.verifyAppAttestAttestation.mockImplementation(() => {
      throw new AppAttestVerificationError('fmt is not apple-appattest');
    });
    const result = await verifyPlatformAttestation({
      attestation: iosAttestation,
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    expect(result).toEqual({
      basis: 'unattested',
      verifiedAt: null,
      keyId: null,
      evidence: {},
      appIntegrityVerifiedAt: null,
      // The reason travels with the result so the route can put it in the
      // audit row. A misconfigured appId/environment rejects 100% of genuine
      // enrolments and looks identical, per request, to one forged blob — a
      // console line cannot be aggregated after the fact, an audit field can.
      failureReason: 'fmt is not apple-appattest',
    });
    // A rejection is the verifier working. Paging on it would make every
    // dev-build probe a Sentry event and train everyone to ignore the channel.
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });

  it('REPORTS a non-rejection throw — a broken verifier is a defect, not attacker noise', async () => {
    // A TypeError out of tiny-cbor or @peculiar/x509 after a dependency bump
    // downgrades every legitimate iOS device in the fleet. No client can
    // provoke this shape, so it must not share a channel with the ones that can.
    appAttestMock.verifyAppAttestAttestation.mockImplementation(() => {
      throw new TypeError('cbor.decode is not a function');
    });
    const result = await verifyPlatformAttestation({
      attestation: iosAttestation,
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    expect(result.basis).toBe('unattested');
    expect(result.failureReason).toBe('verifier error: TypeError');
    expect(sentryMocks.captureException).toHaveBeenCalledWith(
      expect.any(TypeError),
      undefined,
      expect.objectContaining({ reason: 'app_attest_verifier_error' }),
    );
  });

  it('carries NO failureReason for a platform with no verifier wired', async () => {
    const result = await verifyPlatformAttestation({
      attestation: { platform: 'android', certificateChain: ['a', 'b'] },
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    // "Not implemented" and "ran and refused" must stay distinguishable, or the
    // audit signal above cannot be read as evidence of anything.
    expect(result.failureReason).toBeUndefined();
  });

  it('carries NO failureReason on the success path', async () => {
    appAttestMock.verifyAppAttestAttestation.mockReturnValue(passingVerifier);
    const result = await verifyPlatformAttestation({
      attestation: iosAttestation,
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    expect(result.failureReason).toBeUndefined();
  });

  it('resolves unattested for Android — no verifier is wired until W04', async () => {
    const result = await verifyPlatformAttestation({
      attestation: { platform: 'android', certificateChain: ['a', 'b'] },
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    expect(result.basis).toBe('unattested');
    expect(result.verifiedAt).toBeNull();
    expect(appAttestMock.verifyAppAttestAttestation).not.toHaveBeenCalled();
  });

  it('returns a fresh evidence object each call — a caller cannot poison the next registration', async () => {
    appAttestMock.verifyAppAttestAttestation.mockImplementation(() => {
      throw new AppAttestVerificationError('rejected');
    });
    const first = await verifyPlatformAttestation({
      attestation: iosAttestation,
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    (first.evidence as Record<string, unknown>).forged = 'ios_se_p256_app_attest';
    const second = await verifyPlatformAttestation({
      attestation: iosAttestation,
      transcript,
      publicKeySpkiB64: 'spki',
      publicKeyAlg: 'ES256',
    });
    expect(second.evidence).toEqual({});
  });

  // The cross-module half of this contract — that no basis this returns for an
  // unverifiable attestation is in L4_TRUSTED_PLATFORM_BOUND_BASES — is
  // asserted in authenticatorAssurance.test.ts, which already stubs the db
  // layer that importing that module pulls in.
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
