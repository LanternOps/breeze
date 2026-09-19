import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ANDROID_KEYGEN_CHALLENGE_DOMAIN,
  androidKeyGenChallengeB64,
  androidKeyGenChallengePreimage,
  registrationTranscriptB64,
  registrationTranscriptPreimage,
  TRANSCRIPT_DOMAIN,
} from './authenticatorTranscript';

// The SAME vector the API pins in
// `apps/api/src/services/authenticatorAttestation.test.ts`
// ("matches the exact documented pre-image"). Both sides are tied to one set of
// inputs and one digest on purpose: this file existing separately from the
// server implementation is only safe while a single vector holds them together.
const VECTOR_INPUT = {
  attemptId: 'a1',
  challenge: 'c1',
  publicKeyAlg: 'ES256' as const,
  publicKeySpkiB64: 'spki',
};
const VECTOR_PREIMAGE = 'breeze.authenticator.mobile-register.v1\na1\nc1\nES256\nspki';
const VECTOR_DIGEST_B64 = 'lP5an/9r1tXPtdOMA9QHO/78wpGgveu6+Fg1PNeDokQ=';

/** Stand-in for expo-crypto, which cannot load in the Vitest node runtime. */
const nodeSha256B64 = async (utf8: string): Promise<string> =>
  crypto.createHash('sha256').update(utf8, 'utf8').digest('base64');

describe('registrationTranscriptPreimage', () => {
  it('matches the exact pre-image the API pins, byte for byte', () => {
    expect(registrationTranscriptPreimage(VECTOR_INPUT)).toBe(VECTOR_PREIMAGE);
  });

  it('leads with the versioned domain tag', () => {
    expect(TRANSCRIPT_DOMAIN).toBe('breeze.authenticator.mobile-register.v1');
    expect(registrationTranscriptPreimage(VECTOR_INPUT).startsWith(`${TRANSCRIPT_DOMAIN}\n`)).toBe(
      true,
    );
  });

  it.each([
    ['attemptId', { attemptId: 'a2' }],
    ['challenge', { challenge: 'c2' }],
    ['publicKeyAlg', { publicKeyAlg: 'RS256' as const }],
    ['publicKeySpkiB64', { publicKeySpkiB64: 'other' }],
  ])('changes when %s changes', (_name, patch) => {
    expect(registrationTranscriptPreimage({ ...VECTOR_INPUT, ...patch })).not.toBe(
      registrationTranscriptPreimage(VECTOR_INPUT),
    );
  });

  it('is not confusable across field boundaries', () => {
    // 'ab' + 'c' must not collide with 'a' + 'bc' — the newline separator is
    // load-bearing, so assert it rather than trusting it.
    expect(
      registrationTranscriptPreimage({ ...VECTOR_INPUT, attemptId: 'ab', challenge: 'c' }),
    ).not.toBe(registrationTranscriptPreimage({ ...VECTOR_INPUT, attemptId: 'a', challenge: 'bc' }));
  });
});

describe('registrationTranscriptB64', () => {
  it('reproduces the API-pinned digest for the pinned inputs', async () => {
    await expect(registrationTranscriptB64(VECTOR_INPUT, nodeSha256B64)).resolves.toBe(
      VECTOR_DIGEST_B64,
    );
  });

  it('the pinned digest really is SHA-256 of the pinned pre-image', async () => {
    // Guards the vector itself: if someone edits VECTOR_DIGEST_B64 to make a
    // broken implementation pass, this fails too.
    expect(await nodeSha256B64(VECTOR_PREIMAGE)).toBe(VECTOR_DIGEST_B64);
  });

  it('hashes the pre-image, not the raw field concatenation', async () => {
    const naive = await nodeSha256B64(['a1', 'c1', 'ES256', 'spki'].join('\n'));
    await expect(registrationTranscriptB64(VECTOR_INPUT, nodeSha256B64)).resolves.not.toBe(naive);
  });

  it('returns standard base64 (the wire form the server base64-decodes)', async () => {
    const out = await registrationTranscriptB64(VECTOR_INPUT, nodeSha256B64);
    expect(out).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // SHA-256 -> 32 bytes -> 44 base64 chars including one '=' pad.
    expect(out).toHaveLength(44);
    expect(Buffer.from(out, 'base64')).toHaveLength(32);
  });
});

// The SAME vector the API pins in `authenticatorAttestation.test.ts`
// ("matches the exact documented pre-image — W06 Kotlin passes this to
// setAttestationChallenge"). The Kotlin decodes this base64 and hands the 32
// raw bytes to `KeyGenParameterSpec.Builder.setAttestationChallenge`, so a
// drift here is a drift in every leaf certificate the fleet produces.
const KEYGEN_VECTOR_INPUT = {
  attemptId: 'a1',
  challenge: 'c1',
  publicKeyAlg: 'ES256' as const,
};
const KEYGEN_VECTOR_PREIMAGE = 'breeze.authenticator.mobile-register.keygen.v1\na1\nc1\nES256';
const KEYGEN_VECTOR_DIGEST_B64 = '0tpRJBSE1f4xgpEwx3ORQm0ZFEUNrEynv217InW04yE=';

describe('androidKeyGenChallengePreimage', () => {
  it('matches the exact pre-image the API pins, byte for byte', () => {
    expect(androidKeyGenChallengePreimage(KEYGEN_VECTOR_INPUT)).toBe(KEYGEN_VECTOR_PREIMAGE);
  });

  it('leads with its own versioned domain tag', () => {
    expect(ANDROID_KEYGEN_CHALLENGE_DOMAIN).toBe('breeze.authenticator.mobile-register.keygen.v1');
    expect(
      androidKeyGenChallengePreimage(KEYGEN_VECTOR_INPUT).startsWith(
        `${ANDROID_KEYGEN_CHALLENGE_DOMAIN}\n`,
      ),
    ).toBe(true);
  });

  it('is domain-separated from the registration transcript', () => {
    // Not merely "different because the SPKI field is absent": the tags differ,
    // so no choice of inputs can make one digest serve as the other.
    expect(ANDROID_KEYGEN_CHALLENGE_DOMAIN).not.toBe(TRANSCRIPT_DOMAIN);
    expect(androidKeyGenChallengePreimage(KEYGEN_VECTOR_INPUT)).not.toBe(
      registrationTranscriptPreimage({ ...KEYGEN_VECTOR_INPUT, publicKeySpkiB64: '' }),
    );
  });

  it('does NOT commit to the SPKI — it cannot, the key does not exist yet', () => {
    expect(androidKeyGenChallengePreimage(KEYGEN_VECTOR_INPUT)).not.toContain('spki');
  });

  it.each([
    ['attemptId', { attemptId: 'a2' }],
    ['challenge', { challenge: 'c2' }],
    ['publicKeyAlg', { publicKeyAlg: 'RS256' as const }],
  ])('changes when %s changes', (_name, patch) => {
    expect(androidKeyGenChallengePreimage({ ...KEYGEN_VECTOR_INPUT, ...patch })).not.toBe(
      androidKeyGenChallengePreimage(KEYGEN_VECTOR_INPUT),
    );
  });
});

describe('androidKeyGenChallengeB64', () => {
  it('reproduces the API-pinned digest for the pinned inputs', async () => {
    await expect(androidKeyGenChallengeB64(KEYGEN_VECTOR_INPUT, nodeSha256B64)).resolves.toBe(
      KEYGEN_VECTOR_DIGEST_B64,
    );
  });

  it('the pinned digest really is SHA-256 of the pinned pre-image', async () => {
    expect(await nodeSha256B64(KEYGEN_VECTOR_PREIMAGE)).toBe(KEYGEN_VECTOR_DIGEST_B64);
  });

  it('is not the raw server challenge (the bug this replaced)', async () => {
    // The first cut passed `challenge` straight through as the KeyStore
    // attestation challenge. The server never expected that value, so every
    // Android registration would have failed verification.
    await expect(androidKeyGenChallengeB64(KEYGEN_VECTOR_INPUT, nodeSha256B64)).resolves.not.toBe(
      KEYGEN_VECTOR_INPUT.challenge,
    );
  });

  it('is 32 decoded bytes, well under Android\'s 128-byte challenge cap', async () => {
    const out = await androidKeyGenChallengeB64(KEYGEN_VECTOR_INPUT, nodeSha256B64);
    expect(out).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(out, 'base64')).toHaveLength(32);
  });

  it('differs from the registration transcript for the same attempt', async () => {
    const keygen = await androidKeyGenChallengeB64(KEYGEN_VECTOR_INPUT, nodeSha256B64);
    const transcript = await registrationTranscriptB64(VECTOR_INPUT, nodeSha256B64);
    expect(keygen).not.toBe(transcript);
  });
});
