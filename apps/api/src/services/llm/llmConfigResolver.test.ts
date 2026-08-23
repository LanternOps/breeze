import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG_ID = '22222222-2222-4222-8222-222222222222';

const { anthropicOptions, dbState, decryptMock, contextState } = vi.hoisted(() => ({
  anthropicOptions: [] as Array<{ apiKey?: string }>,
  dbState: {
    selectResults: [] as unknown[][],
    updateResults: [] as unknown[][],
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
              returning: vi.fn(() => Promise.resolve(dbState.updateResults.shift() ?? [])),
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

function boundParams(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) {
    for (const chunk of record.queryChunks) boundParams(chunk, out);
  } else if (Array.isArray(node)) {
    for (const chunk of node) boundParams(chunk, out);
  } else if ('encoder' in record && 'value' in record) {
    out.push(record.value);
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  anthropicOptions.length = 0;
  dbState.selectResults.length = 0;
  dbState.updateResults.length = 0;
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

  it('marks an undecryptable active row as errored and returns unavailable', async () => {
    dbState.selectResults.push([row()]);
    dbState.updateResults.push([{ id: CONFIG_ID }]);
    decryptMock.mockImplementation(() => {
      throw new Error('bad auth tag');
    });

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'key_error',
    });
    expect(dbState.updateSets[0]).toMatchObject({ status: 'error', lastError: 'decrypt_failed' });
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
      partnerId: PARTNER_ID,
      configVersion: 3,
      reason: 'anthropic_auth_error:401',
    })).resolves.toBe(false);

    expect(dbState.updateSets[0]).toMatchObject({
      status: 'error',
      lastError: 'anthropic_auth_error:401',
    });
    const params = boundParams(dbState.updateWheres[0]);
    expect(params).toContain(PARTNER_ID);
    expect(params).toContain(3);
  });
});

describe('getAnthropicClientForPartner', () => {
  it('throws LlmUnavailableError instead of constructing a client for unavailable config', async () => {
    dbState.selectResults.push([row({ status: 'error' })]);

    await expect(getAnthropicClientForPartner(PARTNER_ID)).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(anthropicOptions).toHaveLength(0);
  });
});
