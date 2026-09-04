import { describe, it, expect } from 'vitest';
import {
  assertionProofSchema,
  mobileHwKeyProofSchema,
  approvalProofSchema,
  authenticatorPolicySchema,
  mobileHwKeyRegisterSchema,
  mobileAttestationChallengeSchema,
  mobileAttestationVerifySchema,
} from './authenticator';

describe('assertionProofSchema', () => {
  it('accepts a well-formed WebAuthn assertion proof', () => {
    const r = assertionProofSchema.safeParse({
      credentialId: 'abc',
      authenticatorData: 'AA',
      clientDataJSON: 'BB',
      signature: 'CC',
      userHandle: null,
    });
    expect(r.success).toBe(true);
  });
  it('rejects when required fields are missing', () => {
    expect(assertionProofSchema.safeParse({ credentialId: 'x' }).success).toBe(false);
  });
  it('defaults type to webauthn_platform for back-compat (no type on the wire)', () => {
    const r = assertionProofSchema.safeParse({
      credentialId: 'abc',
      authenticatorData: 'AA',
      clientDataJSON: 'BB',
      signature: 'CC',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('webauthn_platform');
  });
});

describe('mobileHwKeyProofSchema', () => {
  it('accepts a well-formed mobile hardware-key proof', () => {
    const r = mobileHwKeyProofSchema.safeParse({
      type: 'mobile_hw_key',
      credentialId: 'dev-uuid',
      nonce: 'nonce-b64url',
      signature: 'sig-b64',
    });
    expect(r.success).toBe(true);
  });
  it('rejects a wrong discriminant', () => {
    const r = mobileHwKeyProofSchema.safeParse({
      type: 'webauthn_platform',
      credentialId: 'dev-uuid',
      nonce: 'n',
      signature: 's',
    });
    expect(r.success).toBe(false);
  });
  it('rejects when required fields are missing', () => {
    expect(
      mobileHwKeyProofSchema.safeParse({ type: 'mobile_hw_key', credentialId: 'x' }).success,
    ).toBe(false);
  });
});

describe('approvalProofSchema (discriminated union)', () => {
  it('accepts the webauthn variant (explicit type)', () => {
    const r = approvalProofSchema.safeParse({
      type: 'webauthn_platform',
      credentialId: 'abc',
      authenticatorData: 'AA',
      clientDataJSON: 'BB',
      signature: 'CC',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('webauthn_platform');
  });
  it('accepts the mobile_hw_key variant', () => {
    const r = approvalProofSchema.safeParse({
      type: 'mobile_hw_key',
      credentialId: 'dev-uuid',
      nonce: 'n',
      signature: 's',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('mobile_hw_key');
  });
  it('rejects an unknown discriminant', () => {
    expect(approvalProofSchema.safeParse({ type: 'totp', code: '123456' }).success).toBe(false);
  });
});

describe('mobileHwKeyRegisterSchema (no password step-up)', () => {
  it('accepts a registration body with no currentPassword', () => {
    const parsed = mobileHwKeyRegisterSchema.safeParse({ publicKey: 'pk', label: 'My iPhone' });
    expect(parsed.success).toBe(true);
  });
  it('rejects an unknown pin field', () => {
    const parsed = mobileHwKeyRegisterSchema.safeParse({ publicKey: 'pk', label: 'x', pin: '1234' });
    // strict schema strips or rejects — assert pin never survives
    if (parsed.success) expect('pin' in parsed.data).toBe(false);
  });
});

describe('authenticatorPolicySchema (Phase 4)', () => {
  it('accepts a well-formed policy and defaults floorOverrides to {}', () => {
    const r = authenticatorPolicySchema.safeParse({ requireEnrollment: true, enforceFrom: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.floorOverrides).toEqual({});
  });
  it('accepts per-tier levels 1-4 and an ISO enforceFrom', () => {
    const r = authenticatorPolicySchema.safeParse({
      floorOverrides: { low: 1, medium: 2, high: 3, critical: 4 },
      requireEnrollment: false,
      enforceFrom: '2026-07-01T00:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });
  it('rejects an out-of-range level and an unknown tier (wire-shape; raise-only is server-side)', () => {
    expect(authenticatorPolicySchema.safeParse({ floorOverrides: { high: 5 }, requireEnrollment: true, enforceFrom: null }).success).toBe(false);
    expect(authenticatorPolicySchema.safeParse({ floorOverrides: { urgent: 3 }, requireEnrollment: true, enforceFrom: null }).success).toBe(false);
  });
  it('preserves a single-tier partial override (partialRecord, not exhaustive z.record)', () => {
    // v4 z.record(enum, V) is exhaustive (all keys required); floorOverrides uses
    // z.partialRecord so an org can raise just one tier. This guards against a
    // revert to z.record, which would reject { high: 3 } and break that.
    const r = authenticatorPolicySchema.safeParse({ floorOverrides: { high: 3 }, requireEnrollment: true, enforceFrom: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.floorOverrides).toEqual({ high: 3 });
  });
});

// --- #1374 W02: attested mobile registration (challenge/verify) ------------

describe('mobileAttestationChallengeSchema', () => {
  it('accepts ios and android', () => {
    expect(mobileAttestationChallengeSchema.safeParse({ platform: 'ios' }).success).toBe(true);
    expect(
      mobileAttestationChallengeSchema.safeParse({ registerGrantId: 'g-1', platform: 'android' }).success,
    ).toBe(true);
  });
  it('rejects an unknown platform', () => {
    expect(mobileAttestationChallengeSchema.safeParse({ platform: 'web' }).success).toBe(false);
  });
  it('is strict — a stray field is rejected', () => {
    expect(
      mobileAttestationChallengeSchema.safeParse({ platform: 'ios', isPlatformBound: true }).success,
    ).toBe(false);
  });
});

describe('mobileAttestationVerifySchema', () => {
  const valid = {
    attemptId: 'a-1',
    publicKey: 'spki',
    publicKeyAlg: 'ES256',
    label: 'iPhone',
    popSignature: 'sig',
    attestation: { platform: 'ios', attestationObject: 'cbor', keyId: 'kid' },
  };

  it('accepts a well-formed iOS body', () => {
    expect(mobileAttestationVerifySchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a well-formed Android body, with and without a Play Integrity token', () => {
    expect(
      mobileAttestationVerifySchema.safeParse({
        ...valid,
        attestation: { platform: 'android', certificateChain: ['a', 'b'], playIntegrityToken: 'jwt' },
      }).success,
    ).toBe(true);
    expect(
      mobileAttestationVerifySchema.safeParse({
        ...valid,
        attestation: { platform: 'android', certificateChain: ['a', 'b'] },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown attestation platform', () => {
    expect(
      mobileAttestationVerifySchema.safeParse({ ...valid, attestation: { platform: 'web' } }).success,
    ).toBe(false);
  });

  it('rejects an unsupported publicKeyAlg', () => {
    expect(mobileAttestationVerifySchema.safeParse({ ...valid, publicKeyAlg: 'HS256' }).success).toBe(false);
    expect(mobileAttestationVerifySchema.safeParse({ ...valid, publicKeyAlg: 'none' }).success).toBe(false);
  });

  it('is strict — a stray field is rejected, not silently kept', () => {
    // The whole point of this wave: a client may no longer assert anything
    // about platform-binding, so this must be a 400 rather than a dropped field.
    expect(mobileAttestationVerifySchema.safeParse({ ...valid, isPlatformBound: true }).success).toBe(false);
    expect(
      mobileAttestationVerifySchema.safeParse({ ...valid, platformBoundBasis: 'ios_se_p256_app_attest' })
        .success,
    ).toBe(false);
  });

  it('is strict INSIDE the attestation branch too', () => {
    expect(
      mobileAttestationVerifySchema.safeParse({
        ...valid,
        attestation: { platform: 'ios', attestationObject: 'cbor', keyId: 'kid', securityLevel: 'StrongBox' },
      }).success,
    ).toBe(false);
  });

  it('requires a full android chain — a lone self-signed leaf proves nothing', () => {
    expect(
      mobileAttestationVerifySchema.safeParse({
        ...valid,
        attestation: { platform: 'android', certificateChain: ['leaf'] },
      }).success,
    ).toBe(false);
  });

  it('rejects missing required fields', () => {
    for (const field of ['attemptId', 'publicKey', 'publicKeyAlg', 'label', 'popSignature', 'attestation']) {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      expect(mobileAttestationVerifySchema.safeParse(body).success).toBe(false);
    }
  });

  it('rejects a blank/whitespace label', () => {
    expect(mobileAttestationVerifySchema.safeParse({ ...valid, label: '   ' }).success).toBe(false);
  });

  it('bounds the unbounded-by-default client blobs', () => {
    expect(
      mobileAttestationVerifySchema.safeParse({ ...valid, publicKey: 'x'.repeat(8193) }).success,
    ).toBe(false);
    expect(
      mobileAttestationVerifySchema.safeParse({
        ...valid,
        attestation: { platform: 'android', certificateChain: Array(9).fill('c') },
      }).success,
    ).toBe(false);
  });
});
