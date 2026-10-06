import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalDiagnosticAuthorizationBytes, type DiagnosticAuthorizationV1 } from './authorization';
import { openSealedDiagnosticResult, type SealedDiagnosticResult } from './seal';

// Shared with agent/internal/remote/tools/diagaccess_interop_test.go: the agent
// must verify these exact canonical bytes, and the API must open this exact
// agent-sealed result.
const vector = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../../agent/internal/remote/tools/testdata/diagnostic_interop_vector.json'),
    'utf8',
  ),
) as {
  authorizationVector: { publicKey: string; authorization: DiagnosticAuthorizationV1; canonicalB64: string };
  sealVector: { serverPrivateKey: string; sealed: SealedDiagnosticResult; plaintext: Record<string, unknown> };
};

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function serverKey() {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(vector.sealVector.serverPrivateKey, 'base64')]),
    format: 'der',
    type: 'pkcs8',
  });
}

describe('diagnostic access wire interop with the agent', () => {
  it('produces the canonical bytes the agent verifies', () => {
    const { signature: _s, ...unsigned } = vector.authorizationVector.authorization;
    const bytes = canonicalDiagnosticAuthorizationBytes(unsigned);
    expect(bytes.toString('base64')).toBe(vector.authorizationVector.canonicalB64);
    const pub = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(vector.authorizationVector.publicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    expect(verify(null, bytes, pub, Buffer.from(vector.authorizationVector.authorization.signature, 'base64'))).toBe(true);
  });

  it('binds every field: changing any one breaks the signature', () => {
    const { signature, ...unsigned } = vector.authorizationVector.authorization;
    const pub = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(vector.authorizationVector.publicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    const mutations: Array<Partial<typeof unsigned>> = [
      { commandId: '00000000-0000-4000-8000-000000000000' },
      { deviceId: '00000000-0000-4000-8000-000000000001' },
      { orgId: '00000000-0000-4000-8000-000000000002' },
      { operation: 'list' },
      { requestPath: 'C:\\Users\\alice\\AppData\\Roaming\\secret.txt' },
      { offset: 0 },
      { maxBytes: 1 },
      { roots: [{ path: 'C:\\', recursive: true }] },
      { sensitiveClasses: ['session_tokens', 'browser_secrets', 'private_keys'] },
      { expiresAt: '2027-01-01T00:00:00Z' },
      { resultPublicKey: Buffer.alloc(32, 1).toString('base64') },
    ];
    for (const m of mutations) {
      const bytes = canonicalDiagnosticAuthorizationBytes({ ...unsigned, ...m });
      expect(verify(null, bytes, pub, Buffer.from(signature, 'base64'))).toBe(false);
    }
  });

  it('refuses control characters that could forge an extra canonical line', () => {
    const { signature: _s, ...unsigned } = vector.authorizationVector.authorization;
    expect(() => canonicalDiagnosticAuthorizationBytes({ ...unsigned, requestPath: 'C:\\a\nC:\\b' })).toThrow(/control character/);
    expect(() => canonicalDiagnosticAuthorizationBytes({ ...unsigned, offset: -1 })).toThrow(/numeric/);
  });

  it('opens a result sealed by the agent', () => {
    const plain = openSealedDiagnosticResult(serverKey(), vector.sealVector.sealed, vector.sealVector.sealed.authorizationId);
    expect(plain).toEqual(vector.sealVector.plaintext);
  });

  it('refuses a sealed result for another authorization or with tampered ciphertext', () => {
    const sealed = vector.sealVector.sealed;
    expect(() => openSealedDiagnosticResult(serverKey(), sealed, 'other-authorization')).toThrow(/different authorization/);
    const ct = Buffer.from(sealed.ct, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    expect(() => openSealedDiagnosticResult(serverKey(), { ...sealed, ct: ct.toString('base64') }, sealed.authorizationId)).toThrow();
    // Relabelled for a different authorization id: the AAD/HKDF binding fails.
    expect(() =>
      openSealedDiagnosticResult(serverKey(), { ...sealed, authorizationId: 'x' }, 'x'),
    ).toThrow();
  });
});
