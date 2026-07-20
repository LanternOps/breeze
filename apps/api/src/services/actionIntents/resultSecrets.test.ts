import { beforeEach, describe, expect, it, vi } from 'vitest';

const { encryptSecretMock, decryptSecretMock, updateMock } = vi.hoisted(() => ({
  // The fake ciphertext base64-encodes the plaintext rather than embedding it
  // verbatim, so it never contains the plaintext as an ASCII substring —
  // matching the real encryptSecret (AES-256-GCM) guarantee that tests assert
  // against via JSON.stringify non-containment checks.
  encryptSecretMock: vi.fn((v: string | null | undefined, opts?: { aad?: string }) =>
    v == null ? null : `enc:v3:test:${opts?.aad}:${Buffer.from(v).toString('base64')}`,
  ),
  decryptSecretMock: vi.fn(
    (v: string | null | undefined, opts?: { aad?: string; strict?: boolean }) => {
      if (v == null) return null;
      const prefix = `enc:v3:test:${opts?.aad}:`;
      if (!v.startsWith(prefix)) throw new Error('AAD mismatch / tampered ciphertext');
      return Buffer.from(v.slice(prefix.length), 'base64').toString();
    },
  ),
  updateMock: vi.fn(),
}));

vi.mock('../secretCrypto', () => ({
  encryptSecret: encryptSecretMock,
  decryptSecret: decryptSecretMock,
}));
vi.mock('../../db', () => ({ db: { update: updateMock } }));
vi.mock('../../db/schema/actionIntents', () => ({
  actionIntents: { id: 'action_intents.id', result: 'action_intents.result' },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join('?'), vals }),
    { raw: (s: string) => s },
  ),
}));

import {
  ACTION_INTENT_RESULT_AAD,
  burnTemporaryPassword,
  hasSealedTemporaryPassword,
  sealActionResultSecrets,
  unsealTemporaryPassword,
} from './resultSecrets';

const RESET_RESULT = {
  success: true,
  action: 'm365.user.reset_password',
  userId: 'target-user-1',
  temporaryPassword: 'Tmp-Pass-1234!',
  forceChangeNextSignIn: true,
};

function mockBurnReturning(rows: Array<{ id: string }>) {
  updateMock.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sealActionResultSecrets', () => {
  it('replaces temporaryPassword with AAD-bound ciphertext for reset results', () => {
    const sealed = sealActionResultSecrets(RESET_RESULT);
    expect(sealed.temporaryPasswordEnc).toBe(
      `enc:v3:test:${ACTION_INTENT_RESULT_AAD}:VG1wLVBhc3MtMTIzNCE=`,
    );
    expect(sealed).not.toHaveProperty('temporaryPassword');
    expect(JSON.stringify(sealed)).not.toContain('Tmp-Pass-1234!');
    // Non-secret fields pass through untouched.
    expect(sealed.userId).toBe('target-user-1');
    expect(sealed.forceChangeNextSignIn).toBe(true);
    expect(encryptSecretMock).toHaveBeenCalledWith('Tmp-Pass-1234!', {
      aad: ACTION_INTENT_RESULT_AAD,
    });
  });

  it('passes non-reset results through unchanged', () => {
    const other = { success: true, action: 'm365.user.disable', userId: 'u' };
    expect(sealActionResultSecrets(other)).toBe(other);
    expect(encryptSecretMock).not.toHaveBeenCalled();
  });

  it('passes a reset result with no password string through unchanged', () => {
    const noPw = { success: true, action: 'm365.user.reset_password', userId: 'u' };
    expect(sealActionResultSecrets(noPw)).toBe(noPw);
  });
});

describe('hasSealedTemporaryPassword', () => {
  it('detects the sealed key, the legacy plaintext key, and neither', () => {
    expect(hasSealedTemporaryPassword({ temporaryPasswordEnc: 'enc:v3:x' })).toBe(true);
    expect(hasSealedTemporaryPassword({ temporaryPassword: 'plain' })).toBe(true);
    expect(hasSealedTemporaryPassword({ temporaryPasswordRevealed: {} })).toBe(false);
    expect(hasSealedTemporaryPassword({})).toBe(false);
  });
});

describe('unsealTemporaryPassword', () => {
  it('decrypts the sealed key with strict AAD binding', () => {
    const sealed = sealActionResultSecrets(RESET_RESULT);
    expect(unsealTemporaryPassword(sealed)).toBe('Tmp-Pass-1234!');
    expect(decryptSecretMock).toHaveBeenCalledWith(sealed.temporaryPasswordEnc, {
      aad: ACTION_INTENT_RESULT_AAD,
      strict: true,
    });
  });

  it('returns legacy plaintext as-is', () => {
    expect(unsealTemporaryPassword({ temporaryPassword: 'Legacy-1!' })).toBe('Legacy-1!');
    expect(decryptSecretMock).not.toHaveBeenCalled();
  });

  it('returns null when no secret is present', () => {
    expect(unsealTemporaryPassword({ temporaryPasswordRevealed: {} })).toBeNull();
  });

  it('propagates decrypt failures (tampered ciphertext) instead of swallowing them', () => {
    expect(() => unsealTemporaryPassword({ temporaryPasswordEnc: 'enc:v3:wrong-aad:x' })).toThrow();
  });
});

describe('burnTemporaryPassword', () => {
  it('returns true when the CAS update burned a row', async () => {
    mockBurnReturning([{ id: 'intent-1' }]);
    await expect(
      burnTemporaryPassword('intent-1', { revealedByUserId: 'user-1' }),
    ).resolves.toBe(true);
  });

  it('returns false when the secret was already gone (lost the race)', async () => {
    mockBurnReturning([]);
    await expect(burnTemporaryPassword('intent-1', { expired: true })).resolves.toBe(false);
  });
});
