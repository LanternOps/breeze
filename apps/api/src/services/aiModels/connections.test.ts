import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ inserted: [] as Array<Record<string, unknown>>, selected: [] as unknown[], returned: [] as unknown[][], rejectNext: null as unknown }));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.inserted.push(values);
        return { returning: vi.fn((fields: Record<string, unknown>) => {
          state.selected.push(fields);
          if (state.rejectNext) {
            const error = state.rejectNext;
            state.rejectNext = null;
            return Promise.reject(error);
          }
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
  createGatewayConnectionRow,
  decryptConnectionKey,
  encryptConnectionKey,
  getConnection,
  listConnections,
  PARTNER_AI_CONNECTION_KEY_SPEC,
} from './connections';
import { RegistryWriteError } from './registryWriteErrors';

const ID = '44444444-4444-4444-8444-444444444444';
const PARTNER = '55555555-5555-4555-8555-555555555555';
const saved = { key: process.env.APP_ENCRYPTION_KEY, keyId: process.env.APP_ENCRYPTION_KEY_ID };

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = 'connections-unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'connections-test';
  state.inserted.length = 0;
  state.selected.length = 0;
  state.returned.length = 0;
  state.rejectNext = null;
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

describe('createGatewayConnectionRow (W06 #7604)', () => {
  it('keyless: all three key columns NULL, base_url kept, active, config_version 1, public columns returned', async () => {
    state.returned.push([{ id: ID, partnerId: PARTNER, kind: 'openai_compatible' }]);
    await createGatewayConnectionRow({ id: ID, partnerId: PARTNER, kind: 'openai_compatible', name: 'Ollama', baseUrl: 'http://ollama.lan:11434/v1', connectedBy: null });
    expect(state.inserted[0]).toMatchObject({
      id: ID, partnerId: PARTNER, kind: 'openai_compatible', name: 'Ollama', baseUrl: 'http://ollama.lan:11434/v1',
      apiKeyEncrypted: null, keyLast4: null, keyFingerprint: null, catalogEntryId: null, inferenceGeo: null,
      providerConfig: null, status: 'active', configVersion: 1, verifiedAt: null,
    });
    expect(Object.keys(state.selected[0] as object)).not.toContain('apiKeyEncrypted');
    expect(Object.keys(state.selected[0] as object)).not.toContain('keyFingerprint');
  });

  it('keyed: seals the trimmed key to the row id under the registry AAD, last4 + fingerprint', async () => {
    state.returned.push([{ id: ID }]);
    await createGatewayConnectionRow({ id: ID, partnerId: PARTNER, kind: 'openai_compatible', name: 'OR', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '  sk-or-v1-0000wxyz ', connectedBy: null });
    const values = state.inserted[0]!;
    expect(decryptSecret(String(values.apiKeyEncrypted), { aad: columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, ID) })).toBe('sk-or-v1-0000wxyz');
    expect(values.keyLast4).toBe('wxyz');
    expect(String(values.keyFingerprint)).toMatch(/^fp1:/);
    expect(JSON.stringify(values)).not.toContain('sk-or-v1-0000wxyz');
  });

  it('refuses an enc: paste and a key under 8 chars before any insert', async () => {
    await expect(createGatewayConnectionRow({ partnerId: PARTNER, kind: 'openai_compatible', name: 'x', baseUrl: 'https://a.example.com', apiKey: 'enc:v3:abcdefgh', connectedBy: null }))
      .rejects.toMatchObject({ code: 'key_rejected' });
    await expect(createGatewayConnectionRow({ partnerId: PARTNER, kind: 'openai_compatible', name: 'x', baseUrl: 'https://a.example.com', apiKey: 'short', connectedBy: null }))
      .rejects.toMatchObject({ code: 'key_rejected' });
    expect(state.inserted).toEqual([]);
  });

  it('scrubs an insert failure into a RegistryWriteError (no ciphertext in the surfaced error)', async () => {
    state.rejectNext = Object.assign(new Error('Failed query: insert params: enc:v3:SECRETCIPHERTEXT'), {
      name: 'DrizzleQueryError', params: ['enc:v3:SECRETCIPHERTEXT'],
      cause: Object.assign(new Error('check'), { code: '23514', constraint_name: 'partner_ai_connections_shape_chk', parameters: ['enc:v3:SECRETCIPHERTEXT'] }),
    });
    const err = await createGatewayConnectionRow({ partnerId: PARTNER, kind: 'openai_compatible', name: 'x', baseUrl: 'https://a.example.com', apiKey: 'sk-or-v1-0000wxyz', connectedBy: null }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryWriteError);
    expect(`${err.message} ${String(err.cause)}`).not.toContain('SECRET');
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

describe('createConnection error scrubbing (PR #7665 handoff)', () => {
  function drizzleInsertError(code: string, params: unknown[]): Error {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code, constraint_name: 'partner_ai_connections_compat_uq', severity: 'ERROR', query: 'insert', parameters: params,
    });
    return Object.assign(new Error(`Failed query: insert … params: ${params.join(',')}`), {
      name: 'DrizzleQueryError', query: 'insert', params, cause: pg,
    });
  }

  it('throws a scrubbed RegistryWriteError when the insert fails with query values', async () => {
    state.rejectNext = drizzleInsertError('23505', ['enc:v3:SECRETCIPHERTEXT', 'SECRETFINGERPRINT']);
    const err = await createConnection({
      partnerId: PARTNER, kind: 'anthropic_byok', name: 'Anthropic', apiKey: 'sk-ant-' + 'x'.repeat(40),
      connectedBy: null, verifiedAt: null,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryWriteError);
    expect(err.code).toBe('conflict');
    expect(err.status).toBe(409);
    expect(err.details).toEqual({ constraint: 'partner_ai_connections_compat_uq' });
    const surfaced = `${String(err.message)} ${String(err.cause)} ${JSON.stringify(err.details)}`;
    expect(surfaced).not.toContain('SECRET');
    expect((err.cause as { code?: string }).code).toBe('23505');
  });

  it('maps a non-constraint insert failure to a 500 write_failed with a safe message', async () => {
    state.rejectNext = drizzleInsertError('XX000', ['enc:v3:SECRETCIPHERTEXT']);
    const err = await createConnection({
      partnerId: PARTNER, kind: 'anthropic_byok', name: 'Anthropic', apiKey: 'sk-ant-' + 'x'.repeat(40),
      connectedBy: null, verifiedAt: null,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryWriteError);
    expect([err.code, err.status, err.message]).toEqual(['write_failed', 500, 'Could not save the AI connection.']);
    expect(String(err.cause)).not.toContain('SECRET');
  });

  it('leaves a key-sealing failure as a ConnectionKeyError (the facade keeps "Could not store the API key.")', async () => {
    // A whitespace-only key seals to null: encryptConnectionKey throws before any DB call.
    const err = await createConnection({
      partnerId: PARTNER, kind: 'anthropic_byok', name: 'Anthropic', apiKey: '   ',
      connectedBy: null, verifiedAt: null,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionKeyError);
    expect(err).not.toBeInstanceOf(RegistryWriteError);
    expect(state.inserted).toEqual([]);
  });
});
