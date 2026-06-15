import { describe, it, expect } from 'vitest';
import {
  assertionProofSchema,
  mobileHwKeyProofSchema,
  approvalProofSchema,
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
