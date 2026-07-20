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
  const setMock = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  });
  updateMock.mockReturnValueOnce({ set: setMock });
  // Expose the `.set()`/`.where()` mocks so callers can assert on the exact
  // arguments the CAS update/predicate were constructed with, not just the
  // final resolved boolean. `getWhereMock` is a function (not a getter
  // evaluated at destructure time) because `.set()` hasn't been called yet
  // when `mockBurnReturning` returns — it's only populated after the
  // production code awaits through the chain.
  return {
    setMock,
    getWhereMock: () => setMock.mock.results[0]!.value.where as ReturnType<typeof vi.fn>,
  };
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
  it('returns true when the CAS update burned a row, and builds the revealed marker + removal + CAS predicate correctly', async () => {
    const { setMock, getWhereMock } = mockBurnReturning([{ id: 'intent-1' }]);
    await expect(
      burnTemporaryPassword('intent-1', { revealedByUserId: 'user-1' }),
    ).resolves.toBe(true);
    const whereMock = getWhereMock();

    // .set({ result: ... }) removes both secret keys and OR-merges in the
    // revealed marker (never the expired marker) for a revealedByUserId call.
    const setArg = setMock.mock.calls[0]![0] as { result: { sql: string; vals: unknown[] } };
    expect(setArg.result.sql).toBe(
      "(coalesce(?, '{}'::jsonb) - ?::text - ?::text) || ?",
    );
    const [resultCol, encKey, legacyKey, markerSql] = setArg.result.vals as [
      unknown,
      string,
      string,
      { sql: string; vals: unknown[] },
    ];
    expect(resultCol).toBe('action_intents.result');
    expect(encKey).toBe('temporaryPasswordEnc');
    expect(legacyKey).toBe('temporaryPassword');
    // The revealed-branch marker embeds the revealed key and the calling
    // user's id, and does NOT build the expired marker.
    expect(markerSql.sql).toBe(
      "jsonb_build_object(?::text, jsonb_build_object('revealedAt', to_jsonb(now()), 'revealedByUserId', ?::text))",
    );
    expect(markerSql.vals).toEqual(['temporaryPasswordRevealed', 'user-1']);
    expect(markerSql.sql).not.toContain('temporaryPasswordExpired');

    // .where(and(eq(id, intentId), CAS predicate)) requires the id match AND
    // at least one of the two secret keys still present (?| bitmap operator).
    const whereArg = whereMock.mock.calls[0]![0] as {
      op: string;
      args: [
        { op: string; args: [unknown, string] },
        { sql: string; vals: unknown[] },
      ];
    };
    expect(whereArg.op).toBe('and');
    const [eqClause, casClause] = whereArg.args;
    expect(eqClause).toEqual({ op: 'eq', args: ['action_intents.id', 'intent-1'] });
    expect(casClause.sql).toBe('? ?| array[?::text, ?::text]');
    expect(casClause.vals).toEqual(['action_intents.result', 'temporaryPasswordEnc', 'temporaryPassword']);
  });

  it('returns false when the secret was already gone (lost the race), and builds the expired marker (not revealed) for an expiry burn', async () => {
    const { setMock } = mockBurnReturning([]);
    await expect(burnTemporaryPassword('intent-1', { expired: true })).resolves.toBe(false);

    const setArg = setMock.mock.calls[0]![0] as { result: { vals: unknown[] } };
    const markerSql = setArg.result.vals[3] as { sql: string; vals: unknown[] };
    expect(markerSql.sql).toBe('jsonb_build_object(?::text, true)');
    expect(markerSql.vals).toEqual(['temporaryPasswordExpired']);
    expect(markerSql.sql).not.toContain('temporaryPasswordRevealed');
  });
});
