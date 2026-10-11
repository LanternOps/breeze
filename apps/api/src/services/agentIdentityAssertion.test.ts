import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Fixed Ed25519 seed (bytes 1..32). Ed25519 signatures are deterministic, so
// the signature below is pinned verbatim in the agent's identity_sync_test.go:
// the Go verifier must accept exactly what this module signs.
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), SEED]),
  format: 'der',
  type: 'pkcs8',
});
const KEY_ID = 'deploy-2026-10-09-abcdef01';

const getActiveSigningKeyIdMock = vi.fn();
const signBytesWithActiveKeyMock = vi.fn();
vi.mock('./manifestSigning', () => ({
  getActiveSigningKeyId: (...args: unknown[]) => getActiveSigningKeyIdMock(...args),
  signBytesWithActiveKey: (...args: unknown[]) => signBytesWithActiveKeyMock(...args),
}));

const getRedisMock = vi.fn();
vi.mock('./redis', () => ({
  getRedis: () => getRedisMock(),
}));

import {
  AGENT_IDENTITY_ASSERTION_DOMAIN,
  AGENT_IDENTITY_ASSERTION_LIFETIME_MS,
  AGENT_IDENTITY_REJECTION_LOG_TTL_SECONDS,
  AGENT_IDENTITY_REJECTION_TTL_SECONDS,
  agentIdentityAssertionRefused,
  agentIdentityNeedsSync,
  resetAgentIdentityRejectionLogStateForTests,
  canonicalAgentIdentityAssertionBytes,
  normalizeIdentitySyncProtocolVersion,
  signAgentIdentityAssertion,
  type UnsignedAgentIdentityAssertionV1,
} from './agentIdentityAssertion';

const GOLDEN: UnsignedAgentIdentityAssertionV1 = {
  v: 1,
  agentId: 'a'.repeat(64),
  deviceId: '00000000-0000-4000-8000-000000000004',
  orgId: '00000000-0000-4000-8000-000000000001',
  siteId: '00000000-0000-4000-8000-000000000003',
  nonce: '0123456789abcdef0123456789abcdef',
  issuedAt: '2026-10-09T19:00:00Z',
  expiresAt: '2026-10-09T19:15:00Z',
  keyId: KEY_ID,
};
const GOLDEN_SIGNATURE =
  't94V6ntpXHLlLjvAmEd/2qrxj9NlPM7ci/x2FMV/1CSrqTBO7m1RIEjIZsL67lhGSAVnci3Mxh7+yIHsu0O3Dg==';

describe('canonicalAgentIdentityAssertionBytes', () => {
  it('is the domain plus one field per line, in a fixed order (pinned in the agent too)', () => {
    expect(canonicalAgentIdentityAssertionBytes(GOLDEN).toString('utf8')).toBe(
      [
        'breeze-agent-identity-v1',
        'a'.repeat(64),
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000003',
        '0123456789abcdef0123456789abcdef',
        '2026-10-09T19:00:00Z',
        '2026-10-09T19:15:00Z',
        KEY_ID,
      ].join('\n'),
    );
    expect(AGENT_IDENTITY_ASSERTION_DOMAIN).toBe('breeze-agent-identity-v1');
  });

  it('produces the golden signature the agent test verifies', () => {
    const signature = sign(null, canonicalAgentIdentityAssertionBytes(GOLDEN), PRIVATE_KEY).toString('base64');
    expect(signature).toBe(GOLDEN_SIGNATURE);
  });

  it('refuses a field that could smuggle a line break or is empty', () => {
    expect(() => canonicalAgentIdentityAssertionBytes({ ...GOLDEN, orgId: 'org\nsite' })).toThrow(/control character/);
    expect(() => canonicalAgentIdentityAssertionBytes({ ...GOLDEN, siteId: '' })).toThrow(/empty/);
  });

  it('refuses an unknown version', () => {
    expect(() => canonicalAgentIdentityAssertionBytes({ ...GOLDEN, v: 2 as unknown as 1 })).toThrow(/version/);
  });
});

describe('normalizeIdentitySyncProtocolVersion', () => {
  it('recognizes exactly version 1', () => {
    expect(normalizeIdentitySyncProtocolVersion(1)).toBe(1);
    for (const value of [undefined, null, 0, 2, '1', 1.5]) {
      expect(normalizeIdentitySyncProtocolVersion(value)).toBe(0);
    }
  });
});

describe('agentIdentityNeedsSync', () => {
  const device = { id: 'device-1', orgId: 'org-b', siteId: 'site-b' };

  it('is false when the agent reported nothing (older agent)', () => {
    expect(agentIdentityNeedsSync(undefined, device)).toBe(false);
  });

  it('is false when the reported identity already matches the row', () => {
    expect(agentIdentityNeedsSync({ deviceId: 'device-1', orgId: 'org-b', siteId: 'site-b', nonce: 'n' }, device)).toBe(false);
  });

  it('is true after a move to another org', () => {
    expect(agentIdentityNeedsSync({ deviceId: 'device-1', orgId: 'org-a', siteId: 'site-a', nonce: 'n' }, device)).toBe(true);
  });

  it('is true after a site-only change', () => {
    expect(agentIdentityNeedsSync({ deviceId: 'device-1', orgId: 'org-b', siteId: 'site-a', nonce: 'n' }, device)).toBe(true);
  });

  it('never syncs a different device id', () => {
    expect(agentIdentityNeedsSync({ deviceId: 'device-2', orgId: 'org-a', siteId: 'site-a', nonce: 'n' }, device)).toBe(false);
  });
});

describe('signAgentIdentityAssertion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveSigningKeyIdMock.mockResolvedValue(KEY_ID);
    signBytesWithActiveKeyMock.mockImplementation(async (bytes: Uint8Array) => ({
      keyId: KEY_ID,
      signature: sign(null, Buffer.from(bytes), PRIVATE_KEY).toString('base64'),
    }));
  });

  it('signs the row identity with the active deployment key for a bounded lifetime', async () => {
    const now = new Date('2026-10-09T19:00:00.987Z');
    const assertion = await signAgentIdentityAssertion({
      agentId: GOLDEN.agentId,
      deviceId: GOLDEN.deviceId,
      orgId: GOLDEN.orgId,
      siteId: GOLDEN.siteId,
      nonce: GOLDEN.nonce,
      now,
    });

    expect(assertion).toEqual({ ...GOLDEN, signature: GOLDEN_SIGNATURE });
    if (!assertion) throw new Error('an active key was configured');
    expect(Date.parse(assertion.expiresAt) - Date.parse(assertion.issuedAt)).toBe(AGENT_IDENTITY_ASSERTION_LIFETIME_MS);
    const { signature, ...unsigned } = assertion;
    expect(
      verify(null, canonicalAgentIdentityAssertionBytes(unsigned), createPublicKey(PRIVATE_KEY), Buffer.from(signature, 'base64')),
    ).toBe(true);
  });

  it('returns null and signs nothing when the deployment has no signing key (never creates one)', async () => {
    getActiveSigningKeyIdMock.mockResolvedValueOnce(null);
    await expect(
      signAgentIdentityAssertion({ agentId: 'a', deviceId: 'd', orgId: 'o', siteId: 's', nonce: 'n' }),
    ).resolves.toBeNull();
    expect(signBytesWithActiveKeyMock).not.toHaveBeenCalled();
  });

  it('fails rather than return an assertion whose keyId names a different key', async () => {
    signBytesWithActiveKeyMock.mockResolvedValueOnce({ keyId: 'deploy-rotated', signature: 'x' });
    await expect(
      signAgentIdentityAssertion({ agentId: 'a', deviceId: 'd', orgId: 'o', siteId: 's', nonce: 'n' }),
    ).rejects.toThrow(/rotated/);
  });
});

// #8382 — an agent that refused the assertion for a target reports it, and the
// server holds back new assertions for that device and target for a while.
describe('agentIdentityAssertionRefused', () => {
  const DEVICE = '00000000-0000-4000-8000-000000000004';
  const TARGET = { orgId: '00000000-0000-4000-8000-0000000000b1', siteId: '00000000-0000-4000-8000-0000000000b2' };
  const OLDER = { orgId: '00000000-0000-4000-8000-0000000000c1', siteId: '00000000-0000-4000-8000-0000000000c2' };
  const AGENT = 'a'.repeat(64);

  function fakeRedis(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    return {
      store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, ...options: unknown[]) => {
        if (options.includes('NX') && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
    };
  }

  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    getRedisMock.mockReset();
    resetAgentIdentityRejectionLogStateForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return () => warn.mockRestore();
  });

  function refused(rejection?: { code: 'env_override' | 'gave_up' | 'unpinned_key' | 'invalid'; orgId: string; siteId: string }) {
    return agentIdentityAssertionRefused({ agentId: AGENT, deviceId: DEVICE, target: TARGET, rejection });
  }

  it('records a refusal of the current target with a TTL and holds back the assertion until it expires', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);

    await expect(refused({ code: 'unpinned_key', ...TARGET })).resolves.toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      `identity-sync:rejected:device:${DEVICE}`,
      JSON.stringify({ code: 'unpinned_key', ...TARGET }),
      'EX',
      AGENT_IDENTITY_REJECTION_TTL_SECONDS,
    );
    // Later beats carry no report (the agent got nothing to refuse) and stay held back.
    await expect(refused()).resolves.toBe(true);
    await expect(refused()).resolves.toBe(true);

    // The TTL lapses: the server signs again so the agent can re-check.
    redis.store.delete(`identity-sync:rejected:device:${DEVICE}`);
    await expect(refused()).resolves.toBe(false);
  });

  it('logs one structured warning per device, target and code', async () => {
    getRedisMock.mockReturnValue(fakeRedis());

    await refused({ code: 'env_override', ...TARGET });
    await refused({ code: 'env_override', ...TARGET });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      agentId: AGENT,
      deviceId: DEVICE,
      orgId: TARGET.orgId,
      siteId: TARGET.siteId,
      code: 'env_override',
      retryAfterSeconds: AGENT_IDENTITY_REJECTION_TTL_SECONDS,
    });
    expect(String(warn.mock.calls[0]?.[1]?.hint)).toContain('BREEZE_ORG_ID');

    // A different reason for the same target is a new warning.
    await refused({ code: 'gave_up', ...TARGET });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('dedupes the warning with a day-long NX key', async () => {
    const redis = fakeRedis();
    getRedisMock.mockReturnValue(redis);
    await refused({ code: 'invalid', ...TARGET });
    expect(redis.set).toHaveBeenCalledWith(
      `identity-sync:rejection-logged:device:${DEVICE}:${TARGET.orgId}:${TARGET.siteId}:invalid`,
      '1',
      'EX',
      AGENT_IDENTITY_REJECTION_LOG_TTL_SECONDS,
      'NX',
    );
  });

  it('signs at once for a device moved again: a refusal of an older target does not count', async () => {
    const redis = fakeRedis({ [`identity-sync:rejected:device:${DEVICE}`]: JSON.stringify({ code: 'gave_up', ...OLDER }) });
    getRedisMock.mockReturnValue(redis);

    await expect(refused()).resolves.toBe(false);
    await expect(refused({ code: 'gave_up', ...OLDER })).resolves.toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a stored value it cannot read', async () => {
    getRedisMock.mockReturnValue(fakeRedis({ [`identity-sync:rejected:device:${DEVICE}`]: 'not json' }));
    await expect(refused()).resolves.toBe(false);
  });

  it('fails open when Redis errors, and still holds back the beat that reports the refusal', async () => {
    getRedisMock.mockReturnValue({
      get: vi.fn().mockRejectedValue(new Error('redis down')),
      set: vi.fn().mockRejectedValue(new Error('redis down')),
    });
    await expect(refused()).resolves.toBe(false);
    await expect(refused({ code: 'unpinned_key', ...TARGET })).resolves.toBe(true);
  });

  it('without Redis holds back only the beat that reports the refusal, and rate-limits the warning', async () => {
    getRedisMock.mockReturnValue(null);
    await expect(refused({ code: 'unpinned_key', ...TARGET })).resolves.toBe(true);
    await expect(refused({ code: 'unpinned_key', ...TARGET })).resolves.toBe(true);
    await expect(refused()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
