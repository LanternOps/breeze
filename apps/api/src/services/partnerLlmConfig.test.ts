import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONFIG_ID = '33333333-3333-4333-8333-333333333333';
const CATALOG_ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const CATALOG_REVISION_ID = '55555555-5555-4555-8555-555555555555';
const API_KEY = 'sk-ant-api03-unit-test-key-1234567890';

const { anthropicState, captureExceptionMock, dbState, catalogState } = vi.hoisted(() => {
  class MockAnthropicApiError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
      this.name = 'APIError';
    }
  }

  return {
    anthropicState: {
      constructorOptions: [] as Array<{ apiKey?: string }>,
      create: vi.fn(),
      apiErrorClass: MockAnthropicApiError,
    },
    captureExceptionMock: vi.fn(),
    dbState: {
      insertResults: [] as unknown[][],
      selectResults: [] as unknown[][],
      updateResults: [] as unknown[][],
      deleteResults: [] as unknown[][],
      insertedValues: [] as Array<Record<string, unknown>>,
      updateSets: [] as Array<Record<string, unknown>>,
      updateWheres: [] as unknown[],
      deleteWheres: [] as unknown[],
    },
    catalogState: {
      catalogEnabled: true,
      getListedProviderByEntryId: vi.fn(),
    },
  };
});

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    static APIError = anthropicState.apiErrorClass;
    messages = { create: anthropicState.create };
    constructor(options: { apiKey?: string }) {
      anthropicState.constructorOptions.push(options);
    }
  }
  return { default: MockAnthropic };
});

vi.mock('./aiModel', () => ({
  resolveDefaultModel: () => 'claude-sonnet-4-6',
}));

vi.mock('./sentry', () => ({
  captureException: captureExceptionMock,
}));

vi.mock('./llmProviderCatalog', () => ({
  getListedProviderByEntryId: catalogState.getListedProviderByEntryId,
}));

// Only the feature flag is stubbed. `buildCatalogEndpointSnapshot` stays REAL:
// it is the single shared definition of "usable endpoint + wire model", and a
// hand-rolled copy here would let this file's probe assertions pass against a
// mapping the resolver no longer performs.
vi.mock('./llm/llmConfigResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llm/llmConfigResolver')>()),
  isLlmProviderCatalogEnabled: () => catalogState.catalogEnabled,
}));

vi.mock('./llm/guardedLlmFetch', () => {
  class MockLlmEgressViolationError extends Error {
    readonly status = 502;
    readonly code = 'llm_egress_blocked';
  }
  return {
    buildGuardedLlmFetch: vi.fn(() => 'guarded-fetch-sentinel'),
    LlmEgressViolationError: MockLlmEgressViolationError,
  };
});

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        dbState.insertedValues.push(values);
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(dbState.insertResults.shift() ?? [])),
          })),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(dbState.selectResults.shift() ?? [])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        dbState.updateSets.push(values);
        return {
          where: vi.fn((condition: unknown) => {
            dbState.updateWheres.push(condition);
            return {
              returning: vi.fn(() => Promise.resolve(dbState.updateResults.shift() ?? [])),
            };
          }),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((condition: unknown) => {
        dbState.deleteWheres.push(condition);
        return {
          returning: vi.fn(() => Promise.resolve(dbState.deleteResults.shift() ?? [])),
        };
      }),
    })),
  },
}));

import { decryptSecret, encryptSecret } from './secretCrypto';
import { columnAad, encryptedColumnRegistry } from './encryptedColumnRegistry';
import {
  deletePartnerLlmConfig,
  getPartnerLlmStatus,
  PartnerLlmError,
  savePartnerLlmKey,
  updatePartnerLlmConfig,
  updatePartnerLlmEndpoint,
} from './partnerLlmConfig';
import { buildGuardedLlmFetch, LlmEgressViolationError } from './llm/guardedLlmFetch';
import { captureException } from './sentry';

const originalEncryptionEnv = {
  key: process.env.APP_ENCRYPTION_KEY,
  keyId: process.env.APP_ENCRYPTION_KEY_ID,
  keyring: process.env.APP_ENCRYPTION_KEYRING,
};

process.env.APP_ENCRYPTION_KEY = 'partner-llm-unit-test-key-material';
process.env.APP_ENCRYPTION_KEY_ID = 'partner-llm-test';
delete process.env.APP_ENCRYPTION_KEYRING;

function expectedFingerprint(value: string): string {
  const encryptionKey = createHash('sha256')
    .update('partner-llm-unit-test-key-material')
    .digest();
  const hex = createHmac('sha256', encryptionKey).update(value).digest('hex');
  return `fp1:partner-llm-test:${hex}`;
}

function apiKeyAad(id: string): string {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'partner_llm_configs' && entry.column === 'api_key_encrypted',
  );
  if (!spec) throw new Error('partner LLM encrypted-column registration missing');
  return columnAad(spec, id);
}

function compileSql(expression: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = new PgDialect().sqlToQuery(expression as never);
  return { sql, params };
}

beforeEach(() => {
  vi.clearAllMocks();
  anthropicState.constructorOptions.length = 0;
  dbState.insertResults.length = 0;
  dbState.selectResults.length = 0;
  dbState.updateResults.length = 0;
  dbState.deleteResults.length = 0;
  dbState.insertedValues.length = 0;
  dbState.updateSets.length = 0;
  dbState.updateWheres.length = 0;
  dbState.deleteWheres.length = 0;
  anthropicState.create.mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  catalogState.catalogEnabled = true;
  catalogState.getListedProviderByEntryId.mockReset();
  vi.mocked(buildGuardedLlmFetch).mockClear();
  vi.mocked(buildGuardedLlmFetch).mockReturnValue('guarded-fetch-sentinel' as never);
});

function listedProvider(overrides: Record<string, unknown> = {}) {
  return {
    entryId: CATALOG_ENTRY_ID,
    slug: 'openrouter',
    name: 'OpenRouter',
    revisionId: CATALOG_REVISION_ID,
    revision: 3,
    baseUrl: 'https://openrouter.ai/api/v1',
    authMode: 'x-api-key' as const,
    modelMap: {
      'claude-sonnet-4-6': {
        providerModel: 'anthropic/claude-sonnet-4-6',
        inputCentsPerM: 300,
        outputCentsPerM: 1500,
        cacheReadCentsPerM: 30,
        cacheWriteCentsPerM: 375,
      },
    },
    dataNote: null as string | null,
    verifiedModels: ['claude-sonnet-4-6'],
    ...overrides,
  };
}

afterAll(() => {
  if (originalEncryptionEnv.key === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = originalEncryptionEnv.key;
  if (originalEncryptionEnv.keyId === undefined) delete process.env.APP_ENCRYPTION_KEY_ID;
  else process.env.APP_ENCRYPTION_KEY_ID = originalEncryptionEnv.keyId;
  if (originalEncryptionEnv.keyring === undefined) delete process.env.APP_ENCRYPTION_KEYRING;
  else process.env.APP_ENCRYPTION_KEYRING = originalEncryptionEnv.keyring;
});

describe('savePartnerLlmKey', () => {
  it('leaves the existing row untouched when Anthropic rejects the probe', async () => {
    anthropicState.create.mockRejectedValue(new anthropicState.apiErrorClass('rejected', 401));

    await expect(
      savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }),
    ).rejects.toMatchObject({
      name: 'PartnerLlmError',
      status: 400,
      message: expect.stringContaining('rejected'),
    });

    expect(dbState.insertedValues).toHaveLength(0);
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('maps an Anthropic permission rejection to 409 without persisting', async () => {
    anthropicState.create.mockRejectedValue(new anthropicState.apiErrorClass('forbidden', 403));

    await expect(
      savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 409 });

    expect(dbState.insertedValues).toHaveLength(0);
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('rethrows a non-APIError from the probe without wrapping or persisting', async () => {
    const error = new Error('unexpected programming failure');
    anthropicState.create.mockRejectedValue(error);

    await expect(
      savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }),
    ).rejects.toBe(error);

    expect(dbState.insertedValues).toHaveLength(0);
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('maps another Anthropic 4xx rejection to 400 without exposing the response body', async () => {
    const error = new anthropicState.apiErrorClass('sensitive upstream response', 404);
    anthropicState.create.mockRejectedValue(error);

    await expect(
      savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }),
    ).rejects.toMatchObject({
      name: 'PartnerLlmError',
      status: 400,
      message: 'Anthropic rejected the verification request (HTTP 404). The probe model may be unavailable — contact support if this persists.',
    });

    expect(captureException).toHaveBeenCalledWith(error, undefined, { service: 'partnerLlmConfig' });
    expect(dbState.insertedValues).toHaveLength(0);
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('maps Anthropic rate limiting to a transient 503 without persisting', async () => {
    anthropicState.create.mockRejectedValue(new anthropicState.apiErrorClass('rate limited', 429));

    await expect(
      savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 503 });

    expect(dbState.insertedValues).toHaveLength(0);
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('rejects an encrypted-envelope paste before probing or writing', async () => {
    await expect(
      savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: 'enc:v3:key:pretend.payload.here', userId: USER_ID }),
    ).rejects.toBeInstanceOf(PartnerLlmError);

    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(dbState.insertedValues).toHaveLength(0);
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('probes first and persists a row-bound ciphertext, last4, HMAC fingerprint, and version 1', async () => {
    dbState.insertResults.push([{ id: CONFIG_ID, configVersion: 1 }]);

    const result = await savePartnerLlmKey({
      partnerId: PARTNER_ID,
      apiKey: `  ${API_KEY}  `,
      userId: USER_ID,
    });

    expect(anthropicState.constructorOptions).toEqual([{ apiKey: API_KEY }]);
    expect(anthropicState.create).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const values = dbState.insertedValues[0]!;
    expect(values.apiKeyEncrypted).not.toBe(API_KEY);
    expect(String(values.apiKeyEncrypted)).not.toContain(API_KEY);
    expect(decryptSecret(String(values.apiKeyEncrypted), { aad: apiKeyAad(String(values.id)) })).toBe(API_KEY);
    expect(values.keyLast4).toBe('7890');
    expect(values.keyFingerprint).toBe(expectedFingerprint(API_KEY));
    expect(values.configVersion).toBe(1);
    expect(values.status).toBe('active');
    expect(values.lastError).toBeNull();
    expect(result).toMatchObject({
      last4: '7890',
      model: 'claude-sonnet-4-6',
      configVersion: 1,
      verifiedAt: expect.any(Date),
    });
  });

  it('re-encrypts against the existing row id and increments the version on replacement', async () => {
    dbState.insertResults.push([]);
    // First select: the pre-probe lookup of the partner's currently-selected
    // endpoint (none here, so the probe targets direct Anthropic as before).
    dbState.selectResults.push([{ catalogEntryId: null, defaultModel: 'claude-haiku-4-5' }]);
    // Second select: the existing insert/update flow's on-conflict fallback.
    dbState.selectResults.push([{ id: CONFIG_ID, defaultModel: 'claude-haiku-4-5' }]);
    dbState.updateResults.push([{ configVersion: 8 }]);

    const result = await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID });

    const updates = dbState.updateSets[0]!;
    expect(decryptSecret(String(updates.apiKeyEncrypted), { aad: apiKeyAad(CONFIG_ID) })).toBe(API_KEY);
    expect(updates.status).toBe('active');
    expect(updates.lastError).toBeNull();
    expect(compileSql(updates.configVersion)).toEqual({
      sql: '"partner_llm_configs"."config_version" + 1',
      params: [],
    });
    expect(compileSql(dbState.updateWheres[0])).toEqual({
      sql: '("partner_llm_configs"."partner_id" = $1 and "partner_llm_configs"."id" = $2)',
      params: [PARTNER_ID, CONFIG_ID],
    });
    expect(result).toMatchObject({ model: 'claude-haiku-4-5', configVersion: 8 });
  });

  it('probes the currently-selected catalog endpoint instead of direct Anthropic when rotating the key', async () => {
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    dbState.selectResults.push([{ catalogEntryId: CATALOG_ENTRY_ID, defaultModel: 'claude-sonnet-4-6' }]);
    dbState.insertResults.push([]);
    dbState.selectResults.push([{ id: CONFIG_ID, defaultModel: 'claude-sonnet-4-6' }]);
    dbState.updateResults.push([{ configVersion: 4 }]);

    await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID });

    expect(catalogState.getListedProviderByEntryId).toHaveBeenCalledWith(CATALOG_ENTRY_ID);
    expect(buildGuardedLlmFetch).toHaveBeenCalledWith(
      expect.objectContaining({ allowedOrigin: 'https://openrouter.ai' }),
    );
    expect(anthropicState.constructorOptions).toEqual([{
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: API_KEY,
      authToken: null,
      fetch: 'guarded-fetch-sentinel',
    }]);
    expect(anthropicState.create).toHaveBeenCalledWith({
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it('rejects a key rotation when the currently-selected catalog endpoint was delisted, without persisting', async () => {
    catalogState.getListedProviderByEntryId.mockResolvedValue(null);
    dbState.selectResults.push([{ catalogEntryId: CATALOG_ENTRY_ID, defaultModel: 'claude-sonnet-4-6' }]);

    await expect(
      savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 409 });

    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(dbState.insertedValues).toHaveLength(0);
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('rejects a key rotation targeting a catalog endpoint while catalog selection is disabled', async () => {
    catalogState.catalogEnabled = false;
    dbState.selectResults.push([{ catalogEntryId: CATALOG_ENTRY_ID, defaultModel: 'claude-sonnet-4-6' }]);

    await expect(
      savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 409 });

    expect(catalogState.getListedProviderByEntryId).not.toHaveBeenCalled();
    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(dbState.insertedValues).toHaveLength(0);
  });
});

describe('updatePartnerLlmConfig', () => {
  it('rejects an unknown default model without writing', async () => {
    await expect(
      updatePartnerLlmConfig({ partnerId: PARTNER_ID, defaultModel: 'claude-made-up-model' }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 400 });
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('increments the config version with SQL when updating the default model', async () => {
    dbState.updateResults.push([{ configVersion: 9 }]);

    await expect(updatePartnerLlmConfig({
      partnerId: PARTNER_ID,
      defaultModel: 'claude-haiku-4-5',
    })).resolves.toEqual({
      defaultModel: 'claude-haiku-4-5',
      configVersion: 9,
    });

    expect(compileSql(dbState.updateSets[0]?.configVersion)).toEqual({
      sql: '"partner_llm_configs"."config_version" + 1',
      params: [],
    });
    expect(compileSql(dbState.updateWheres[0])).toEqual({
      sql: '"partner_llm_configs"."partner_id" = $1',
      params: [PARTNER_ID],
    });
  });
});

describe('getPartnerLlmStatus', () => {
  it('preserves null defaultModel so callers can distinguish platform inheritance', async () => {
    dbState.selectResults.push([{
      provider: 'anthropic',
      keyLast4: '7890',
      defaultModel: null,
      status: 'active',
      verifiedAt: new Date('2026-08-23T12:00:00.000Z'),
      lastError: null,
      catalogEntryId: null,
    }]);

    await expect(getPartnerLlmStatus(PARTNER_ID)).resolves.toMatchObject({
      configured: true,
      defaultModel: null,
      catalogEntryId: null,
    });
  });

  it('surfaces the selected catalog entry id', async () => {
    dbState.selectResults.push([{
      provider: 'anthropic',
      keyLast4: '7890',
      defaultModel: 'claude-sonnet-4-6',
      status: 'active',
      verifiedAt: new Date('2026-08-23T12:00:00.000Z'),
      lastError: null,
      catalogEntryId: CATALOG_ENTRY_ID,
    }]);

    await expect(getPartnerLlmStatus(PARTNER_ID)).resolves.toMatchObject({
      catalogEntryId: CATALOG_ENTRY_ID,
    });
  });

  it('reports catalogEntryId null when unconfigured', async () => {
    dbState.selectResults.push([]);

    await expect(getPartnerLlmStatus(PARTNER_ID)).resolves.toMatchObject({
      configured: false,
      catalogEntryId: null,
    });
  });
});

describe('deletePartnerLlmConfig', () => {
  it.each([
    [[{ id: CONFIG_ID }], true],
    [[], false],
  ] as const)('returns whether a config row was deleted', async (deletedRows, expected) => {
    dbState.deleteResults.push([...deletedRows]);

    await expect(deletePartnerLlmConfig(PARTNER_ID)).resolves.toBe(expected);
    expect(compileSql(dbState.deleteWheres[0])).toEqual({
      sql: '"partner_llm_configs"."partner_id" = $1',
      params: [PARTNER_ID],
    });
  });
});

function encryptedApiKeyRow(): string {
  const encrypted = encryptSecret(API_KEY, { aad: apiKeyAad(CONFIG_ID) });
  if (!encrypted) throw new Error('test setup: could not encrypt fixture API key');
  return encrypted;
}

describe('updatePartnerLlmEndpoint', () => {
  it('rejects when no Anthropic key is connected yet', async () => {
    dbState.selectResults.push([]);

    await expect(
      updatePartnerLlmEndpoint({
        partnerId: PARTNER_ID,
        catalogEntryId: CATALOG_ENTRY_ID,
        acknowledgeDataNote: true,
        userId: USER_ID,
      }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 409 });
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('reverts to direct Anthropic without probing when catalogEntryId is null', async () => {
    dbState.selectResults.push([{ id: CONFIG_ID, apiKeyEncrypted: encryptedApiKeyRow(), defaultModel: 'claude-sonnet-4-6' }]);
    dbState.updateResults.push([{ configVersion: 5 }]);

    const result = await updatePartnerLlmEndpoint({
      partnerId: PARTNER_ID,
      catalogEntryId: null,
      acknowledgeDataNote: false,
      userId: USER_ID,
    });

    expect(result).toEqual({ catalogEntryId: null, configVersion: 5, slug: null, revision: null });
    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(catalogState.getListedProviderByEntryId).not.toHaveBeenCalled();
    expect(dbState.updateSets[0]).toMatchObject({ catalogEntryId: null });
    expect(compileSql(dbState.updateSets[0]?.configVersion)).toEqual({
      sql: '"partner_llm_configs"."config_version" + 1',
      params: [],
    });
  });

  it('rejects selecting a delisted catalog entry, without persisting', async () => {
    dbState.selectResults.push([{ id: CONFIG_ID, apiKeyEncrypted: encryptedApiKeyRow(), defaultModel: 'claude-sonnet-4-6' }]);
    catalogState.getListedProviderByEntryId.mockResolvedValue(null);

    await expect(
      updatePartnerLlmEndpoint({
        partnerId: PARTNER_ID,
        catalogEntryId: CATALOG_ENTRY_ID,
        acknowledgeDataNote: true,
        userId: USER_ID,
      }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 409 });

    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('requires acknowledgeDataNote when the active revision carries a data note', async () => {
    dbState.selectResults.push([{ id: CONFIG_ID, apiKeyEncrypted: encryptedApiKeyRow(), defaultModel: 'claude-sonnet-4-6' }]);
    catalogState.getListedProviderByEntryId.mockResolvedValue(
      listedProvider({ dataNote: 'Prompts transit OpenRouter.' }),
    );

    await expect(
      updatePartnerLlmEndpoint({
        partnerId: PARTNER_ID,
        catalogEntryId: CATALOG_ENTRY_ID,
        acknowledgeDataNote: false,
        userId: USER_ID,
      }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 400 });

    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('does not require consent when the active revision carries no data note', async () => {
    dbState.selectResults.push([{ id: CONFIG_ID, apiKeyEncrypted: encryptedApiKeyRow(), defaultModel: 'claude-sonnet-4-6' }]);
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider({ dataNote: null }));
    dbState.updateResults.push([{ configVersion: 2 }]);

    await expect(
      updatePartnerLlmEndpoint({
        partnerId: PARTNER_ID,
        catalogEntryId: CATALOG_ENTRY_ID,
        acknowledgeDataNote: false,
        userId: USER_ID,
      }),
    ).resolves.toMatchObject({ catalogEntryId: CATALOG_ENTRY_ID, configVersion: 2 });
  });

  it('rejects when the model configured for this partner is not verified on the entry', async () => {
    dbState.selectResults.push([{ id: CONFIG_ID, apiKeyEncrypted: encryptedApiKeyRow(), defaultModel: 'claude-haiku-4-5' }]);
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider({ dataNote: null }));

    await expect(
      updatePartnerLlmEndpoint({
        partnerId: PARTNER_ID,
        catalogEntryId: CATALOG_ENTRY_ID,
        acknowledgeDataNote: true,
        userId: USER_ID,
      }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 409 });

    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('rejects selection while catalog selection is disabled, without persisting', async () => {
    catalogState.catalogEnabled = false;
    dbState.selectResults.push([{ id: CONFIG_ID, apiKeyEncrypted: encryptedApiKeyRow(), defaultModel: 'claude-sonnet-4-6' }]);

    await expect(
      updatePartnerLlmEndpoint({
        partnerId: PARTNER_ID,
        catalogEntryId: CATALOG_ENTRY_ID,
        acknowledgeDataNote: true,
        userId: USER_ID,
      }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 409 });

    expect(catalogState.getListedProviderByEntryId).not.toHaveBeenCalled();
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('probes the selected endpoint through the guarded client and persists nothing on probe failure', async () => {
    dbState.selectResults.push([{ id: CONFIG_ID, apiKeyEncrypted: encryptedApiKeyRow(), defaultModel: 'claude-sonnet-4-6' }]);
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider({ dataNote: null }));
    anthropicState.create.mockRejectedValue(new anthropicState.apiErrorClass('rejected', 401));

    await expect(
      updatePartnerLlmEndpoint({
        partnerId: PARTNER_ID,
        catalogEntryId: CATALOG_ENTRY_ID,
        acknowledgeDataNote: true,
        userId: USER_ID,
      }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 400 });

    expect(buildGuardedLlmFetch).toHaveBeenCalledWith(
      expect.objectContaining({ allowedOrigin: 'https://openrouter.ai' }),
    );
    expect(anthropicState.create).toHaveBeenCalledWith({
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('maps a blocked-egress probe failure to a 503 without persisting', async () => {
    dbState.selectResults.push([{ id: CONFIG_ID, apiKeyEncrypted: encryptedApiKeyRow(), defaultModel: 'claude-sonnet-4-6' }]);
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider({ dataNote: null }));
    anthropicState.create.mockRejectedValue(new LlmEgressViolationError('blocked'));

    await expect(
      updatePartnerLlmEndpoint({
        partnerId: PARTNER_ID,
        catalogEntryId: CATALOG_ENTRY_ID,
        acknowledgeDataNote: true,
        userId: USER_ID,
      }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 503 });

    expect(dbState.updateSets).toHaveLength(0);
  });

  it('sets catalogEntryId and bumps configVersion on a successful probe, returning slug + revision for auditing', async () => {
    dbState.selectResults.push([{ id: CONFIG_ID, apiKeyEncrypted: encryptedApiKeyRow(), defaultModel: 'claude-sonnet-4-6' }]);
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider({ dataNote: null }));
    dbState.updateResults.push([{ configVersion: 6 }]);

    const result = await updatePartnerLlmEndpoint({
      partnerId: PARTNER_ID,
      catalogEntryId: CATALOG_ENTRY_ID,
      acknowledgeDataNote: true,
      userId: USER_ID,
    });

    expect(result).toEqual({
      catalogEntryId: CATALOG_ENTRY_ID,
      configVersion: 6,
      slug: 'openrouter',
      revision: 3,
    });
    expect(dbState.updateSets[0]).toMatchObject({ catalogEntryId: CATALOG_ENTRY_ID });
    expect(compileSql(dbState.updateSets[0]?.configVersion)).toEqual({
      sql: '"partner_llm_configs"."config_version" + 1',
      params: [],
    });
  });
});
