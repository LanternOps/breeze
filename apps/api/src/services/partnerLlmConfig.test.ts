import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONFIG_ID = '33333333-3333-4333-8333-333333333333';
const API_KEY = 'sk-ant-api03-unit-test-key-1234567890';

const { anthropicState, captureExceptionMock, dbState } = vi.hoisted(() => {
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
      deleteWheres: [] as unknown[],
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

vi.mock('./aiAgent', () => ({
  resolveDefaultModel: () => 'claude-sonnet-4-6',
}));

vi.mock('./sentry', () => ({
  captureException: captureExceptionMock,
}));

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
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(dbState.updateResults.shift() ?? [])),
          })),
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

import { decryptSecret } from './secretCrypto';
import { columnAad, encryptedColumnRegistry } from './encryptedColumnRegistry';
import {
  deletePartnerLlmConfig,
  getPartnerLlmStatus,
  PartnerLlmError,
  savePartnerLlmKey,
  updatePartnerLlmConfig,
} from './partnerLlmConfig';
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

beforeEach(() => {
  vi.clearAllMocks();
  anthropicState.constructorOptions.length = 0;
  dbState.insertResults.length = 0;
  dbState.selectResults.length = 0;
  dbState.updateResults.length = 0;
  dbState.deleteResults.length = 0;
  dbState.insertedValues.length = 0;
  dbState.updateSets.length = 0;
  dbState.deleteWheres.length = 0;
  anthropicState.create.mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 1 } });
});

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
    dbState.selectResults.push([{ id: CONFIG_ID, defaultModel: 'claude-haiku-4-5' }]);
    dbState.updateResults.push([{ configVersion: 8 }]);

    const result = await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID });

    const updates = dbState.updateSets[0]!;
    expect(decryptSecret(String(updates.apiKeyEncrypted), { aad: apiKeyAad(CONFIG_ID) })).toBe(API_KEY);
    expect(updates.status).toBe('active');
    expect(updates.lastError).toBeNull();
    expect(result).toMatchObject({ model: 'claude-haiku-4-5', configVersion: 8 });
  });
});

describe('updatePartnerLlmConfig', () => {
  it('rejects an unknown default model without writing', async () => {
    await expect(
      updatePartnerLlmConfig({ partnerId: PARTNER_ID, defaultModel: 'claude-made-up-model' }),
    ).rejects.toMatchObject({ name: 'PartnerLlmError', status: 400 });
    expect(dbState.updateSets).toHaveLength(0);
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
    }]);

    await expect(getPartnerLlmStatus(PARTNER_ID)).resolves.toMatchObject({
      configured: true,
      defaultModel: null,
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
  });
});
