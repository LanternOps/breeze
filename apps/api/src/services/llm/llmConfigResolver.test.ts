import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG_ID = '22222222-2222-4222-8222-222222222222';

const { anthropicOptions, captureExceptionMock, dbState, decryptMock, contextState } = vi.hoisted(() => ({
  anthropicOptions: [] as Array<{ apiKey?: string }>,
  captureExceptionMock: vi.fn(),
  dbState: {
    selectResults: [] as unknown[][],
    updateResults: [] as unknown[][],
    updateError: null as unknown,
    updateSets: [] as Array<Record<string, unknown>>,
    updateWheres: [] as unknown[],
  },
  decryptMock: vi.fn(),
  contextState: { outsideCalls: 0, systemCalls: 0 },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(options: { apiKey?: string }) {
      anthropicOptions.push(options);
    }
  },
}));

vi.mock('../aiAgent', () => ({
  resolveDefaultModel: () => 'claude-sonnet-4-6',
}));

vi.mock('../partnerLlmConfig', () => ({
  decryptPartnerLlmApiKey: decryptMock,
}));

vi.mock('../sentry', () => ({
  captureException: captureExceptionMock,
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => {
    contextState.outsideCalls += 1;
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => unknown) => {
    contextState.systemCalls += 1;
    return fn();
  },
  db: {
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
              returning: vi.fn(() => dbState.updateError
                ? Promise.reject(dbState.updateError)
                : Promise.resolve(dbState.updateResults.shift() ?? [])),
            };
          }),
        };
      }),
    })),
  },
}));

import {
  getAnthropicClientForPartner,
  LlmUnavailableError,
  markPartnerLlmError,
  resolveLlmConfig,
} from './llmConfigResolver';
import { SecretKeyMaterialError } from '../secretCrypto';
import { captureException } from '../sentry';

const originalPlatformKey = process.env.ANTHROPIC_API_KEY;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CONFIG_ID,
    partnerId: PARTNER_ID,
    apiKeyEncrypted: 'ciphertext',
    defaultModel: null,
    status: 'active',
    configVersion: 4,
    ...overrides,
  };
}

function compileWhere(condition: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = new PgDialect().sqlToQuery(condition as never);
  return { sql, params };
}

beforeEach(() => {
  vi.clearAllMocks();
  anthropicOptions.length = 0;
  dbState.selectResults.length = 0;
  dbState.updateResults.length = 0;
  dbState.updateError = null;
  dbState.updateSets.length = 0;
  dbState.updateWheres.length = 0;
  contextState.outsideCalls = 0;
  contextState.systemCalls = 0;
  decryptMock.mockReturnValue('partner-plaintext-key');
  process.env.ANTHROPIC_API_KEY = 'platform-key';
});

afterEach(() => {
  if (originalPlatformKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalPlatformKey;
});

describe('resolveLlmConfig', () => {
  it('returns the platform config for a null partner without reading the database', async () => {
    await expect(resolveLlmConfig(null)).resolves.toEqual({
      source: 'platform',
      apiKey: 'platform-key',
      model: 'claude-sonnet-4-6',
    });
    expect(contextState.systemCalls).toBe(0);
  });

  it.each([
    ['claude-haiku-4-5', 'claude-haiku-4-5'],
    [null, 'claude-sonnet-4-6'],
  ])('returns a decrypted partner config using the row model %s and fallback %s', async (defaultModel, expectedModel) => {
    dbState.selectResults.push([row({ defaultModel })]);

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'partner',
      partnerId: PARTNER_ID,
      apiKey: 'partner-plaintext-key',
      model: expectedModel,
      configId: CONFIG_ID,
      configVersion: 4,
    });
    expect(decryptMock).toHaveBeenCalledWith({ id: CONFIG_ID, apiKeyEncrypted: 'ciphertext' });
    expect(contextState.outsideCalls).toBe(1);
    expect(contextState.systemCalls).toBe(1);
  });

  it('marks a deterministic decrypt failure by config id and returns unavailable', async () => {
    dbState.selectResults.push([row()]);
    dbState.updateResults.push([{ id: CONFIG_ID }]);
    const error = new Error('bad auth tag');
    decryptMock.mockImplementation(() => {
      throw error;
    });

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'key_error',
    });
    expect(dbState.updateSets[0]).toMatchObject({ status: 'error', lastError: 'decrypt_failed' });
    const compiled = compileWhere(dbState.updateWheres[0]);
    expect(compiled.sql).toBe('(\"partner_llm_configs\".\"id\" = $1 and \"partner_llm_configs\".\"config_version\" = $2)');
    expect(compiled.params).toEqual([CONFIG_ID, 4]);
    expect(captureException).toHaveBeenCalledWith(error, undefined, {
      service: 'llmConfigResolver',
      partnerId: PARTNER_ID,
    });
  });

  it('returns unavailable without persisting when decrypt fails from node key material', async () => {
    dbState.selectResults.push([row()]);
    const error = new SecretKeyMaterialError('Unknown encrypted secret key ID');
    decryptMock.mockImplementation(() => {
      throw error;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'key_error',
    });
    expect(dbState.updateSets).toHaveLength(0);
    expect(captureException).toHaveBeenCalledWith(error, undefined, {
      service: 'llmConfigResolver',
      partnerId: PARTNER_ID,
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[llmConfigResolver] partner config cannot be decrypted with this node key material',
      { partnerId: PARTNER_ID, error },
    );
    consoleError.mockRestore();
  });

  it('captures a failure to persist deterministic decrypt status', async () => {
    dbState.selectResults.push([row()]);
    const decryptError = new Error('bad auth tag');
    const persistError = new Error('database unavailable');
    decryptMock.mockImplementation(() => {
      throw decryptError;
    });
    dbState.updateError = persistError;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toMatchObject({ source: 'unavailable' });

    expect(captureException).toHaveBeenNthCalledWith(1, decryptError, undefined, {
      service: 'llmConfigResolver',
      partnerId: PARTNER_ID,
    });
    expect(captureException).toHaveBeenNthCalledWith(2, persistError, undefined, {
      service: 'llmConfigResolver',
      partnerId: PARTNER_ID,
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[llmConfigResolver] failed to mark unreadable partner config',
      { partnerId: PARTNER_ID, configVersion: 4, error: persistError },
    );
    consoleError.mockRestore();
  });

  it('returns unavailable for an error row without attempting decryption', async () => {
    dbState.selectResults.push([row({ status: 'error' })]);

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'key_error',
    });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(dbState.updateSets).toHaveLength(0);
  });
});

describe('markPartnerLlmError', () => {
  it('is a no-op when the config version is stale', async () => {
    dbState.updateResults.push([]);

    await expect(markPartnerLlmError({
      configId: CONFIG_ID,
      configVersion: 3,
      reason: 'auth_rejected',
    })).resolves.toBe(false);

    expect(dbState.updateSets[0]).toMatchObject({
      status: 'error',
      lastError: 'auth_rejected',
    });
    const compiled = compileWhere(dbState.updateWheres[0]);
    expect(compiled.sql).toBe('(\"partner_llm_configs\".\"id\" = $1 and \"partner_llm_configs\".\"config_version\" = $2)');
    expect(compiled.params).toEqual([CONFIG_ID, 3]);
  });
});

describe('getAnthropicClientForPartner', () => {
  it('throws LlmUnavailableError instead of constructing a client for unavailable config', async () => {
    dbState.selectResults.push([row({ status: 'error' })]);

    await expect(getAnthropicClientForPartner(PARTNER_ID)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(anthropicOptions).toHaveLength(0);
  });

  it('reports a deployment configuration error when the platform key is blank', async () => {
    process.env.ANTHROPIC_API_KEY = '   ';

    await expect(getAnthropicClientForPartner(null)).rejects.toMatchObject({
      name: 'LlmUnavailableError',
      message: 'AI is not configured on this deployment.',
    });
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'LlmUnavailableError',
        message: 'AI is not configured on this deployment.',
      }),
      undefined,
      { service: 'llmConfigResolver' },
    );
    expect(anthropicOptions).toHaveLength(0);
  });
});
