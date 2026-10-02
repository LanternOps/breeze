import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ inserted: [] as Array<Record<string, unknown>>, selected: [] as unknown[], returned: [] as unknown[][] }));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.inserted.push(values);
        return { returning: vi.fn((fields: Record<string, unknown>) => {
          state.selected.push(fields);
          return Promise.resolve(state.returned.shift() ?? []);
        }) };
      }),
    })),
    select: vi.fn((fields: Record<string, unknown>) => {
      state.selected.push(fields);
      const chain = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(state.returned.shift() ?? [])),
        then: (resolve: (rows: unknown[]) => unknown) => resolve(state.returned.shift() ?? []),
      };
      return chain;
    }),
  },
}));

import { columnAad, encryptedColumnRegistry } from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../secretCrypto';
import {
  ConnectionKeyError,
  createConnection,
  decryptConnectionKey,
  encryptConnectionKey,
  getConnection,
  listConnections,
  PARTNER_AI_CONNECTION_KEY_SPEC,
} from './connections';

const ID = '44444444-4444-4444-8444-444444444444';
const PARTNER = '55555555-5555-4555-8555-555555555555';
const saved = { key: process.env.APP_ENCRYPTION_KEY, keyId: process.env.APP_ENCRYPTION_KEY_ID };

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = 'connections-unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'connections-test';
  state.inserted.length = 0;
  state.selected.length = 0;
  state.returned.length = 0;
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = saved.key;
  if (saved.keyId === undefined) delete process.env.APP_ENCRYPTION_KEY_ID; else process.env.APP_ENCRYPTION_KEY_ID = saved.keyId;
});

describe('connections key material (#7600 W02)', () => {
  it('uses the registry spec: row-bound under the legacy partner_llm_configs tag', () => {
    const registered = encryptedColumnRegistry.find((s) => s.table === 'partner_ai_connections' && s.column === 'api_key_encrypted');
    expect(PARTNER_AI_CONNECTION_KEY_SPEC).toBe(registered);
    expect(columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, ID)).toBe(`partner_llm_configs.api_key_encrypted:${ID}`);
  });

  it('decrypts a ciphertext sealed by the legacy partnerLlmConfig writer for the same id (quorum #13)', () => {
    const legacySpec = encryptedColumnRegistry.find((s) => s.table === 'partner_llm_configs' && s.column === 'api_key_encrypted')!;
    const legacyCiphertext = encryptSecret('sk-ant-api03-legacy-unit', { aad: columnAad(legacySpec, ID) })!;
    expect(decryptConnectionKey({ id: ID, apiKeyEncrypted: legacyCiphertext })).toBe('sk-ant-api03-legacy-unit');
  });

  it('round-trips its own ciphertext and refuses another row id', () => {
    const sealed = encryptConnectionKey(ID, 'sk-ant-api03-own');
    expect(decryptConnectionKey({ id: ID, apiKeyEncrypted: sealed })).toBe('sk-ant-api03-own');
    expect(() => decryptConnectionKey({ id: '66666666-6666-4666-8666-666666666666', apiKeyEncrypted: sealed })).toThrow();
  });

  it('a connection without a key raises ConnectionKeyError(key_missing)', () => {
    expect(() => decryptConnectionKey({ id: ID, apiKeyEncrypted: null })).toThrow(ConnectionKeyError);
    try { decryptConnectionKey({ id: ID, apiKeyEncrypted: null }); } catch (e) { expect((e as ConnectionKeyError).code).toBe('key_missing'); }
  });
});

describe('createConnection (#7600 W02)', () => {
  it('rejects an encrypted-envelope paste and a catalog kind without an entry, writing nothing', async () => {
    await expect(createConnection({ partnerId: PARTNER, kind: 'anthropic_byok', name: 'k', apiKey: 'enc:v3:x', connectedBy: null, verifiedAt: null }))
      .rejects.toMatchObject({ code: 'key_rejected' });
    await expect(createConnection({ partnerId: PARTNER, kind: 'catalog', name: 'k', apiKey: 'sk-ant-api03-x', connectedBy: null, verifiedAt: null }))
      .rejects.toThrow(/catalog entry/);
    expect(state.inserted).toEqual([]);
  });

  it('seals the trimmed key to the row id, stores last4 + fingerprint, and never returns key material', async () => {
    state.returned.push([{ id: ID, partnerId: PARTNER, kind: 'anthropic_byok', name: 'k', keyLast4: 'abcd' }]);
    const created = await createConnection({ id: ID, partnerId: PARTNER, kind: 'anthropic_byok', name: 'k', apiKey: '  sk-ant-api03-zzzzabcd  ', connectedBy: null, verifiedAt: null });
    const values = state.inserted[0]!;
    expect(values).toMatchObject({ id: ID, partnerId: PARTNER, kind: 'anthropic_byok', keyLast4: 'abcd', status: 'active', configVersion: 1 });
    expect(decryptSecret(String(values.apiKeyEncrypted), { aad: columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, ID) })).toBe('sk-ant-api03-zzzzabcd');
    expect(String(values.keyFingerprint)).toMatch(/^fp1:/);
    expect(Object.keys(state.selected[0] as object)).not.toContain('apiKeyEncrypted');
    expect(created).not.toHaveProperty('apiKeyEncrypted');
  });
});

describe('connection reads never select key material (#7600 W02)', () => {
  it('listConnections and getConnection project the public columns only', async () => {
    state.returned.push([], []);
    await listConnections(PARTNER);
    await getConnection(ID);
    for (const fields of state.selected) {
      expect(Object.keys(fields as object)).not.toContain('apiKeyEncrypted');
      expect(Object.keys(fields as object)).not.toContain('keyFingerprint');
    }
  });
});
