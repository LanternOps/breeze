import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fixed Ed25519 seed (bytes 1..32), the same seed agentIdentityAssertion.test.ts
// pins. Ed25519 signatures are deterministic, so GOLDEN_SIGNATURE below is
// pinned verbatim in the agent's rebind test (wave 1b-3): the Go verifier
// must accept exactly what this module signs.
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]),
  format: 'der',
  type: 'pkcs8',
});
const KEY_ID = 'deploy-2026-10-09-abcdef01';

const getActiveSigningKeyIdMock = vi.fn();
const signBytesWithActiveKeyMock = vi.fn();
vi.mock('../manifestSigning', () => ({
  getActiveSigningKeyId: (...args: unknown[]) => getActiveSigningKeyIdMock(...args),
  signBytesWithActiveKey: (...args: unknown[]) => signBytesWithActiveKeyMock(...args),
}));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import {
  canonicalRebindDirectiveBytes,
  rebindDirectiveExpiry,
  rebindDirectiveForBeat,
  REBIND_DIRECTIVE_DOMAIN,
  signRebindDirective,
  type UnsignedRebindDirective,
} from './rebindDirective';
import { normalizeRebindProtocolVersion, REBIND_DIRECTIVE_MAX_LIFETIME_MS } from './protocol';

const GOLDEN: UnsignedRebindDirective = {
  intentId: '00000000-0000-4000-8000-0000000000a1',
  sourceAgentId: 'b'.repeat(64),
  targetDeviceId: '00000000-0000-4000-8000-000000000004',
  targetOrgId: '00000000-0000-4000-8000-000000000001',
  targetSiteId: '00000000-0000-4000-8000-000000000003',
  nonce: '0123456789abcdef0123456789abcdef',
  expiresAt: '2026-10-09T19:15:00Z',
  keyId: KEY_ID,
};
const GOLDEN_LINES = [
  'breeze-agent-rebind-v1',
  '00000000-0000-4000-8000-0000000000a1',
  'b'.repeat(64),
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000003',
  '0123456789abcdef0123456789abcdef',
  '2026-10-09T19:15:00Z',
  KEY_ID,
];
const GOLDEN_SIGNATURE =
  'ZQ6AjOV4eLvuSx4kBzwByFeCYBe38VTpclN5DYfmEbtiaSlHAqJ86OjyQrPJIf7WSgLCFileFEYqs9kwYwigDg==';

describe('canonicalRebindDirectiveBytes', () => {
  it('is the domain plus one field per line, in a fixed order (pinned in the agent too)', () => {
    expect(canonicalRebindDirectiveBytes(GOLDEN).toString('utf8')).toBe(GOLDEN_LINES.join('\n'));
    expect(REBIND_DIRECTIVE_DOMAIN).toBe('breeze-agent-rebind-v1');
  });

  it('produces the golden signature the agent test verifies', () => {
    const signature = sign(null, canonicalRebindDirectiveBytes(GOLDEN), PRIVATE_KEY).toString('base64');
    expect(signature).toBe(GOLDEN_SIGNATURE);
  });

  it('refuses a field that could smuggle a line break, or an empty one', () => {
    expect(() => canonicalRebindDirectiveBytes({ ...GOLDEN, targetOrgId: 'org\nsite' })).toThrow(/control character/);
    expect(() => canonicalRebindDirectiveBytes({ ...GOLDEN, nonce: 'a\u0000b' })).toThrow(/control character/);
    expect(() => canonicalRebindDirectiveBytes({ ...GOLDEN, targetSiteId: '' })).toThrow(/empty/);
    expect(() => canonicalRebindDirectiveBytes({ ...GOLDEN, sourceAgentId: '' })).toThrow(/empty/);
  });
});

describe('signRebindDirective', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveSigningKeyIdMock.mockResolvedValue(KEY_ID);
    signBytesWithActiveKeyMock.mockImplementation(async (bytes: Uint8Array) => ({
      keyId: KEY_ID,
      signature: sign(null, Buffer.from(bytes), PRIVATE_KEY).toString('base64'),
    }));
  });

  it('signs the golden directive at second precision, and never sends the source agent id', async () => {
    const directive = await signRebindDirective({
      intentId: GOLDEN.intentId,
      sourceAgentId: GOLDEN.sourceAgentId,
      targetDeviceId: GOLDEN.targetDeviceId,
      targetOrgId: GOLDEN.targetOrgId,
      targetSiteId: GOLDEN.targetSiteId,
      nonce: GOLDEN.nonce,
      expiresAt: new Date('2026-10-09T19:15:00.987Z'),
    });
    expect(directive).toEqual({
      intentId: GOLDEN.intentId,
      nonce: GOLDEN.nonce,
      targetDeviceId: GOLDEN.targetDeviceId,
      targetOrgId: GOLDEN.targetOrgId,
      targetSiteId: GOLDEN.targetSiteId,
      expiresAt: '2026-10-09T19:15:00Z',
      keyId: KEY_ID,
      signature: GOLDEN_SIGNATURE,
    });
    expect(directive).not.toHaveProperty('sourceAgentId');
    const { signature, ...wire } = directive!;
    expect(
      verify(
        null,
        canonicalRebindDirectiveBytes({ ...wire, sourceAgentId: GOLDEN.sourceAgentId }),
        createPublicKey(PRIVATE_KEY),
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true);
    // Bound to the source install: another agent id never verifies.
    expect(
      verify(
        null,
        canonicalRebindDirectiveBytes({ ...wire, sourceAgentId: 'c'.repeat(64) }),
        createPublicKey(PRIVATE_KEY),
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(false);
  });

  it('returns null and signs nothing without a deployment key (never creates one)', async () => {
    getActiveSigningKeyIdMock.mockResolvedValueOnce(null);
    await expect(signRebindDirective({ ...GOLDEN, expiresAt: new Date() })).resolves.toBeNull();
    expect(signBytesWithActiveKeyMock).not.toHaveBeenCalled();
  });

  it('fails rather than return a directive whose keyId names a different key', async () => {
    signBytesWithActiveKeyMock.mockResolvedValueOnce({ keyId: 'deploy-rotated', signature: 'x' });
    await expect(signRebindDirective({ ...GOLDEN, expiresAt: new Date() })).rejects.toThrow(/rotated/);
  });
});

describe('rebindDirectiveExpiry', () => {
  it('is the intent expiry when that is sooner than 15 minutes', () => {
    const now = new Date('2026-10-09T19:00:00Z');
    const intentExpiry = new Date('2026-10-09T19:05:00Z');
    expect(rebindDirectiveExpiry(intentExpiry, now)).toEqual(intentExpiry);
  });

  it('is capped at 15 minutes for a longer-lived intent', () => {
    const now = new Date('2026-10-09T19:00:00Z');
    const intentExpiry = new Date('2026-10-09T20:00:00Z');
    expect(rebindDirectiveExpiry(intentExpiry, now).getTime()).toBe(now.getTime() + REBIND_DIRECTIVE_MAX_LIFETIME_MS);
  });
});

describe('normalizeRebindProtocolVersion', () => {
  it('recognizes exactly version 1', () => {
    expect(normalizeRebindProtocolVersion(1)).toBe(1);
    for (const value of [undefined, null, 0, 2, -1, '1', 1.5, true]) {
      expect(normalizeRebindProtocolVersion(value)).toBe(0);
    }
  });
});

describe('rebindDirectiveForBeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveSigningKeyIdMock.mockResolvedValue(KEY_ID);
    signBytesWithActiveKeyMock.mockImplementation(async (bytes: Uint8Array) => ({
      keyId: KEY_ID,
      signature: sign(null, Buffer.from(bytes), PRIVATE_KEY).toString('base64'),
    }));
  });

  it('does not look anything up for a device without the capability', async () => {
    await expect(
      rebindDirectiveForBeat({ deviceId: 'd', agentId: 'a', rebindProtocolVersion: 0 }),
    ).resolves.toBeUndefined();
    expect(getActiveSigningKeyIdMock).not.toHaveBeenCalled();
  });

  it('never throws into the heartbeat: a failed lookup costs only this beat its directive', async () => {
    // `db` is an empty object here, so the lookup itself throws.
    await expect(
      rebindDirectiveForBeat({ deviceId: 'd', agentId: 'a', rebindProtocolVersion: 1 }),
    ).resolves.toBeUndefined();
  });
});
