import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    getdel: vi.fn(),
    setex: vi.fn(),
  },
}));

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisMock),
}));

import { getRedis } from './redis';
import {
  consumeMobileAssertionNonce,
  issueMobileAssertionNonce,
  verifyMobileSignature,
} from './mobileHwKey';

const getRedisMock = vi.mocked(getRedis);

function makeDeviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { spkiB64, privateKey };
}
function sign(privateKey: crypto.KeyObject, payload: string) {
  return crypto.sign('RSA-SHA256', Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock as never);
  redisMock.setex.mockResolvedValue('OK');
});

describe('verifyMobileSignature', () => {
  it('verifies a genuine RSA-SHA256 signature over the nonce (the react-native-biometrics contract)', () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const nonce = 'server-nonce-abc';
    const signature = sign(privateKey, nonce);
    expect(verifyMobileSignature({ publicKeySpkiB64: spkiB64, payload: nonce, signatureB64: signature })).toBe(true);
  });

  it('rejects a signature over a different nonce (replay/forgery)', () => {
    const { spkiB64, privateKey } = makeDeviceKeypair();
    const signature = sign(privateKey, 'other-nonce');
    expect(verifyMobileSignature({ publicKeySpkiB64: spkiB64, payload: 'server-nonce-abc', signatureB64: signature })).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const a = makeDeviceKeypair();
    const b = makeDeviceKeypair();
    const signature = sign(b.privateKey, 'n');
    expect(verifyMobileSignature({ publicKeySpkiB64: a.spkiB64, payload: 'n', signatureB64: signature })).toBe(false);
  });

  it('returns false (never throws) on malformed public key', () => {
    const { privateKey } = makeDeviceKeypair();
    const signature = sign(privateKey, 'n');
    expect(verifyMobileSignature({ publicKeySpkiB64: 'not-a-real-key', payload: 'n', signatureB64: signature })).toBe(false);
  });

  it('returns false (never throws) on malformed signature', () => {
    const { spkiB64 } = makeDeviceKeypair();
    expect(verifyMobileSignature({ publicKeySpkiB64: spkiB64, payload: 'n', signatureB64: '@@not base64@@' })).toBe(false);
  });

  it('returns false (never throws) on empty input', () => {
    expect(verifyMobileSignature({ publicKeySpkiB64: '', payload: '', signatureB64: '' })).toBe(false);
  });
});

describe('mobile nonce helpers', () => {
  it('issueMobileAssertionNonce stores <issuedAt>:<nonce> at mobile-assertion:<approvalId>:<userId> for 120s', async () => {
    const before = Date.now();
    const nonce = await issueMobileAssertionNonce('ap1', 'u1');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [key, ttl, stored] = redisMock.setex.mock.calls[0]!;
    expect(key).toBe('mobile-assertion:ap1:u1');
    expect(ttl).toBe(120);
    const sep = (stored as string).indexOf(':');
    const issuedAt = Number((stored as string).slice(0, sep));
    expect((stored as string).slice(sep + 1)).toBe(nonce);
    expect(issuedAt).toBeGreaterThanOrEqual(before);
  });

  it('consumeMobileAssertionNonce getdels the key and returns {nonce, issuedAt} (single-use)', async () => {
    redisMock.getdel.mockResolvedValue('1781000000000:stored-nonce');
    const result = await consumeMobileAssertionNonce('ap1', 'u1');
    expect(redisMock.getdel).toHaveBeenCalledWith('mobile-assertion:ap1:u1');
    expect(result).toEqual({ nonce: 'stored-nonce', issuedAt: 1781000000000 });
  });

  it('consume returns null when the key is absent (expired / never issued)', async () => {
    redisMock.getdel.mockResolvedValue(null);
    expect(await consumeMobileAssertionNonce('ap1', 'u1')).toBeNull();
  });

  it('consume tolerates a legacy bare nonce (no issued-at prefix) as issued-now', async () => {
    const before = Date.now();
    redisMock.getdel.mockResolvedValue('legacy-bare-nonce');
    const result = await consumeMobileAssertionNonce('ap1', 'u1');
    expect(result?.nonce).toBe('legacy-bare-nonce');
    expect(result?.issuedAt).toBeGreaterThanOrEqual(before);
  });

  it('issue throws when redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    await expect(issueMobileAssertionNonce('ap1', 'u1')).rejects.toThrow('redis unavailable');
  });

  it('consume throws when redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    await expect(consumeMobileAssertionNonce('ap1', 'u1')).rejects.toThrow('redis unavailable');
  });
});
