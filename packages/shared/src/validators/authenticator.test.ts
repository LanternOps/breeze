import { describe, it, expect } from 'vitest';
import { assertionProofSchema } from './authenticator';

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
});
