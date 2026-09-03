import { createHmac } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const keyState = vi.hoisted(() => ({
  active: { keyId: 'current', key: Buffer.alloc(32, 0x11) },
  retained: [
    { keyId: 'current', key: Buffer.alloc(32, 0x11) },
    { keyId: 'old', key: Buffer.alloc(32, 0x22) },
  ],
}));

vi.mock('./secretCrypto', () => ({
  getSecretDerivedKeyMaterials: vi.fn(() => keyState),
}));

import {
  mintExtensionAssetToken,
  verifyExtensionAssetToken,
  EXTENSION_ASSET_TOKEN_PATTERN,
  type ExtensionAssetTokenClaims,
} from './extensionAssetToken';

const NAME = 'workspace';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const SCOPE = { partnerId: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222' };
const OTHER_SCOPE = { partnerId: '33333333-3333-4333-8333-333333333333', orgId: '44444444-4444-4444-8444-444444444444' };
const BINDING = { name: NAME, digest: DIGEST };

/** 2027-01-01T00:00:00Z — a whole 15-minute bucket boundary. */
const T0 = 1_798_761_600_000;

function decodeClaims(token: string): ExtensionAssetTokenClaims {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

/** Re-sign an arbitrary claims object with the active test key, so a test can
 *  present a token that is genuinely signed but carries hostile claims. */
function forgeWithActiveKey(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = createHmac('sha256', keyState.active.key)
    .update(`extension-web-asset-token:v1:${payload}`)
    .digest()
    .toString('base64url');
  return `v1.${payload}.${sig}`;
}

describe('extension web-asset tokens', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips a valid token bound to the requested name + digest', () => {
    const token = mintExtensionAssetToken(BINDING, SCOPE);
    expect(EXTENSION_ASSET_TOKEN_PATTERN.test(token)).toBe(true);

    const verified = verifyExtensionAssetToken(token, BINDING);
    expect(verified).not.toBeNull();
    expect(verified!.claims).toEqual({
      v: 1,
      aud: 'breeze.extensions.web-asset',
      name: NAME,
      digest: DIGEST,
      partnerId: SCOPE.partnerId,
      orgId: SCOPE.orgId,
      iat: T0 / 1000,
      exp: T0 / 1000 + 3600,
    });
    expect(verified!.signingKeyId).toBe('current');
    expect(verified!.remainingSeconds).toBe(3600);
  });

  it('is a single URL path segment (no slash, dot-delimited base64url)', () => {
    const token = mintExtensionAssetToken(BINDING, SCOPE);
    expect(token).not.toContain('/');
    expect(token).toBe(encodeURIComponent(token).replace(/%2E/gi, '.'));
  });

  it('mints the SAME bytes across a 15-minute bucket, and rotates at the boundary', () => {
    const atBucketStart = mintExtensionAssetToken(BINDING, SCOPE);
    vi.setSystemTime(new Date(T0 + 14 * 60 * 1000 + 59_000));
    expect(mintExtensionAssetToken(BINDING, SCOPE)).toBe(atBucketStart);

    vi.setSystemTime(new Date(T0 + 15 * 60 * 1000));
    const nextBucket = mintExtensionAssetToken(BINDING, SCOPE);
    expect(nextBucket).not.toBe(atBucketStart);
    // Still verifies, and still carries most of its life.
    expect(verifyExtensionAssetToken(nextBucket, BINDING)!.remainingSeconds).toBe(3600);
  });

  it('never hands out a token with less than TTL minus one bucket of life', () => {
    vi.setSystemTime(new Date(T0 + 14 * 60 * 1000 + 59_000));
    const token = mintExtensionAssetToken(BINDING, SCOPE);
    expect(verifyExtensionAssetToken(token, BINDING)!.remainingSeconds).toBeGreaterThanOrEqual(3600 - 900);
  });

  it('rejects an EXPIRED token (and accepts it one second earlier)', () => {
    const token = mintExtensionAssetToken(BINDING, SCOPE);

    vi.setSystemTime(new Date(T0 + 3600 * 1000 - 1000));
    expect(verifyExtensionAssetToken(token, BINDING)).not.toBeNull();

    vi.setSystemTime(new Date(T0 + 3600 * 1000));
    expect(verifyExtensionAssetToken(token, BINDING)).toBeNull();
  });

  it('rejects a token bound to a DIFFERENT digest (superseded bundle)', () => {
    const token = mintExtensionAssetToken({ name: NAME, digest: OTHER_DIGEST }, SCOPE);
    expect(verifyExtensionAssetToken(token, BINDING)).toBeNull();
    // ...and the correctly-bound one still works, so this isn't vacuous.
    expect(verifyExtensionAssetToken(token, { name: NAME, digest: OTHER_DIGEST })).not.toBeNull();
  });

  it('rejects a token bound to a DIFFERENT extension name', () => {
    const token = mintExtensionAssetToken({ name: 'other-ext', digest: DIGEST }, SCOPE);
    expect(verifyExtensionAssetToken(token, BINDING)).toBeNull();
  });

  it('cannot be RE-SCOPED to another tenant: editing the tenant claims breaks the signature', () => {
    const token = mintExtensionAssetToken(BINDING, SCOPE);
    const claims = decodeClaims(token);
    expect(claims.partnerId).toBe(SCOPE.partnerId);

    const rescopedPayload = Buffer.from(
      JSON.stringify({ ...claims, partnerId: OTHER_SCOPE.partnerId, orgId: OTHER_SCOPE.orgId }),
      'utf8',
    ).toString('base64url');
    const tampered = `v1.${rescopedPayload}.${token.split('.')[2]}`;

    expect(verifyExtensionAssetToken(tampered, BINDING)).toBeNull();
  });

  it('rejects a token signed with an unknown key', () => {
    const token = mintExtensionAssetToken(BINDING, SCOPE);
    const payload = token.split('.')[1]!;
    const foreign = createHmac('sha256', Buffer.alloc(32, 0x99))
      .update(`extension-web-asset-token:v1:${payload}`)
      .digest()
      .toString('base64url');
    expect(verifyExtensionAssetToken(`v1.${payload}.${foreign}`, BINDING)).toBeNull();
  });

  it('accepts a token signed under a RETAINED (rotated-out) key', () => {
    const token = mintExtensionAssetToken(BINDING, SCOPE);
    const payload = token.split('.')[1]!;
    const oldKeySig = createHmac('sha256', keyState.retained[1]!.key)
      .update(`extension-web-asset-token:v1:${payload}`)
      .digest()
      .toString('base64url');
    const verified = verifyExtensionAssetToken(`v1.${payload}.${oldKeySig}`, BINDING);
    expect(verified?.signingKeyId).toBe('old');
  });

  it.each([
    ['empty', ''],
    ['no dots', 'notatoken'],
    ['wrong version prefix', 'v2.abc.def'],
    ['two parts only', 'v1.abc'],
    ['non-base64url payload', 'v1.a+b/c.def'],
    ['oversized', `v1.${'a'.repeat(2000)}.def`],
  ])('rejects a malformed token (%s)', (_label, token) => {
    expect(verifyExtensionAssetToken(token, BINDING)).toBeNull();
  });

  it('rejects a signed token whose audience is wrong', () => {
    const token = forgeWithActiveKey({
      v: 1, aud: 'breeze.something-else', name: NAME, digest: DIGEST,
      partnerId: SCOPE.partnerId, orgId: SCOPE.orgId, iat: T0 / 1000, exp: T0 / 1000 + 3600,
    });
    expect(verifyExtensionAssetToken(token, BINDING)).toBeNull();
  });

  it('rejects a signed token claiming a longer life than we ever mint', () => {
    const token = forgeWithActiveKey({
      v: 1, aud: 'breeze.extensions.web-asset', name: NAME, digest: DIGEST,
      partnerId: SCOPE.partnerId, orgId: SCOPE.orgId,
      iat: T0 / 1000, exp: T0 / 1000 + 3601,
    });
    expect(verifyExtensionAssetToken(token, BINDING)).toBeNull();
  });

  it('rejects a signed token issued materially in the future', () => {
    const token = forgeWithActiveKey({
      v: 1, aud: 'breeze.extensions.web-asset', name: NAME, digest: DIGEST,
      partnerId: SCOPE.partnerId, orgId: SCOPE.orgId,
      iat: T0 / 1000 + 3600, exp: T0 / 1000 + 3600 + 60,
    });
    expect(verifyExtensionAssetToken(token, BINDING)).toBeNull();
  });

  it('rejects a re-ordered (non-canonical) encoding of otherwise valid claims', () => {
    const token = forgeWithActiveKey({
      aud: 'breeze.extensions.web-asset', v: 1, digest: DIGEST, name: NAME,
      partnerId: SCOPE.partnerId, orgId: SCOPE.orgId, iat: T0 / 1000, exp: T0 / 1000 + 3600,
    });
    expect(verifyExtensionAssetToken(token, BINDING)).toBeNull();
  });

  it('rejects a signed token carrying an extra claim', () => {
    const token = forgeWithActiveKey({
      v: 1, aud: 'breeze.extensions.web-asset', name: NAME, digest: DIGEST,
      partnerId: SCOPE.partnerId, orgId: SCOPE.orgId, iat: T0 / 1000, exp: T0 / 1000 + 3600,
      isPlatformAdmin: true,
    });
    expect(verifyExtensionAssetToken(token, BINDING)).toBeNull();
  });

  it('rejects verification against an empty binding', () => {
    const token = mintExtensionAssetToken(BINDING, SCOPE);
    expect(verifyExtensionAssetToken(token, { name: '', digest: DIGEST })).toBeNull();
    expect(verifyExtensionAssetToken(token, { name: NAME, digest: '' })).toBeNull();
  });

  it('mints for a partner-scoped principal with no org', () => {
    const token = mintExtensionAssetToken(BINDING, { partnerId: SCOPE.partnerId, orgId: null });
    expect(verifyExtensionAssetToken(token, BINDING)!.claims.orgId).toBeNull();
  });

  it('produces a DIFFERENT token per tenant scope', () => {
    const a = mintExtensionAssetToken(BINDING, SCOPE);
    const b = mintExtensionAssetToken(BINDING, OTHER_SCOPE);
    expect(a).not.toBe(b);
  });
});
