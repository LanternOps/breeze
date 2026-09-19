import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG_ID = '22222222-2222-4222-8222-222222222222';

const CATALOG_ENTRY_ID = '33333333-3333-4333-8333-333333333333';
const CATALOG_REVISION_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '99999999-9999-4999-8999-999999999999';

const {
  anthropicOptions,
  captureExceptionMock,
  captureMessageMock,
  dbState,
  decryptMock,
  contextState,
  getListedProviderByEntryIdMock,
  buildGuardedLlmFetchMock,
  guardedFetchOptions,
  recordLlmEgressEventMock,
} = vi.hoisted(() => ({
  anthropicOptions: [] as Array<Record<string, unknown>>,
  captureExceptionMock: vi.fn(),
  captureMessageMock: vi.fn(),
  dbState: {
    selectResults: [] as unknown[][],
    selectErrors: [] as unknown[],
    selectFields: [] as unknown[],
    selectWheres: [] as unknown[],
    updateResults: [] as unknown[][],
    updateError: null as unknown,
    updateSets: [] as Array<Record<string, unknown>>,
    updateWheres: [] as unknown[],
  },
  decryptMock: vi.fn(),
  contextState: { outsideCalls: 0, systemCalls: 0 },
  getListedProviderByEntryIdMock: vi.fn(),
  buildGuardedLlmFetchMock: vi.fn(),
  guardedFetchOptions: [] as Array<{
    allowedOrigin: string;
    recordEgress: (attempt: { host: string; resolvedIp: string | null; blocked: boolean }) => void;
  }>,
  recordLlmEgressEventMock: vi.fn(),
}));

/**
 * Stable identity so a test can assert the Anthropic client was handed exactly
 * the guarded fetch (and that a direct/platform client was handed none).
 */
const GUARDED_FETCH_SENTINEL = function guardedFetchSentinel() {
  return Promise.resolve(new Response(null));
};

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(options: Record<string, unknown>) {
      anthropicOptions.push(options);
    }
  },
}));

vi.mock('../llmProviderCatalog', () => ({
  getListedProviderByEntryId: getListedProviderByEntryIdMock,
}));

vi.mock('./guardedLlmFetch', () => ({
  buildGuardedLlmFetch: buildGuardedLlmFetchMock,
}));

vi.mock('./llmEgressRecorder', () => ({
  recordLlmEgressEvent: recordLlmEgressEventMock,
}));

vi.mock('../aiModel', () => ({
  resolveDefaultModel: () => 'claude-sonnet-4-6',
}));

vi.mock('../partnerLlmConfig', () => ({
  decryptPartnerLlmApiKey: decryptMock,
}));

vi.mock('../sentry', () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
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
    select: vi.fn((fields: unknown) => {
      dbState.selectFields.push(fields);
      return ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          dbState.selectWheres.push(condition);
          return ({
          limit: vi.fn(() => {
            const error = dbState.selectErrors.shift();
            return error
              ? Promise.reject(error)
              : Promise.resolve(dbState.selectResults.shift() ?? []);
          }),
          });
        }),
      })),
      });
    }),
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
  buildCatalogEndpointSnapshot,
  getAnthropicClientForPartner,
  getLlmBillingSourceForOrg,
  LlmOrgResolutionError,
  LlmUnavailableError,
  markPartnerLlmError,
  resolveLlmConfig,
  resolveLlmConfigForOrg,
  resolveWireModel,
  type UsableLlmConfig,
} from './llmConfigResolver';
import { SecretKeyMaterialError } from '../secretCrypto';
import { captureException, captureMessage } from '../sentry';

const originalPlatformKey = process.env.ANTHROPIC_API_KEY;
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalCatalogFlag = process.env.LLM_PROVIDER_CATALOG_ENABLED;

/**
 * Frozen copies of what `getAnthropicClientForPartner` constructed BEFORE the
 * catalog work (#3922 W3 Task 3.2). Catalog support must not perturb either of
 * these by a single key: a partner with no `catalog_entry_id` still gets the
 * #1412-pinned public endpoint with environment auth-token inheritance
 * disabled, and the platform client stays fully environment-aware. Asserted
 * with `toEqual` against these constants so an extra option (a stray `fetch`,
 * a `baseURL` on the platform path) fails loudly rather than passing a
 * `toMatchObject`.
 */
const PRE_CHANGE_DIRECT_PARTNER_CLIENT_OPTIONS = Object.freeze({
  apiKey: 'partner-plaintext-key',
  authToken: null,
  baseURL: 'https://api.anthropic.com',
});
const PRE_CHANGE_PLATFORM_CLIENT_OPTIONS = Object.freeze({ apiKey: 'platform-key' });

const ONE_SHOT_SURFACE = { surface: 'one_shot_ticket_draft', orgId: ORG_ID } as const;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: CONFIG_ID,
    partnerId: PARTNER_ID,
    apiKeyEncrypted: 'ciphertext',
    defaultModel: null,
    catalogEntryId: null,
    status: 'active',
    configVersion: 4,
    ...overrides,
  };
}

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
    dataNote: 'Prompts transit OpenRouter.',
    verifiedModels: ['claude-sonnet-4-6'],
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
  dbState.selectErrors.length = 0;
  dbState.selectFields.length = 0;
  dbState.selectWheres.length = 0;
  dbState.updateResults.length = 0;
  dbState.updateError = null;
  dbState.updateSets.length = 0;
  dbState.updateWheres.length = 0;
  contextState.outsideCalls = 0;
  contextState.systemCalls = 0;
  decryptMock.mockReturnValue('partner-plaintext-key');
  guardedFetchOptions.length = 0;
  buildGuardedLlmFetchMock.mockImplementation((opts: (typeof guardedFetchOptions)[number]) => {
    guardedFetchOptions.push(opts);
    return GUARDED_FETCH_SENTINEL;
  });
  getListedProviderByEntryIdMock.mockResolvedValue(null);
  process.env.ANTHROPIC_API_KEY = 'platform-key';
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.LLM_PROVIDER_CATALOG_ENABLED;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalCatalogFlag === undefined) delete process.env.LLM_PROVIDER_CATALOG_ENABLED;
  else process.env.LLM_PROVIDER_CATALOG_ENABLED = originalCatalogFlag;
  if (originalPlatformKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalPlatformKey;
  if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
  if (originalAnthropicAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
});

describe('resolveLlmConfigForOrg', () => {
  it('resolves the partner from the organization under system DB context', async () => {
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [row()]);

    await expect(resolveLlmConfigForOrg('33333333-3333-4333-8333-333333333333')).resolves.toMatchObject({
      source: 'partner',
      partnerId: PARTNER_ID,
      apiKey: 'partner-plaintext-key',
    });

    expect(contextState.outsideCalls).toBe(2);
    expect(contextState.systemCalls).toBe(2);
  });

  it('throws the typed org-resolution error when the organization is missing', async () => {
    dbState.selectResults.push([]);

    const promise = resolveLlmConfigForOrg('33333333-3333-4333-8333-333333333333');
    await expect(promise).rejects.toBeInstanceOf(LlmOrgResolutionError);
    await expect(promise).rejects.toMatchObject({
      name: 'LlmOrgResolutionError',
      orgId: '33333333-3333-4333-8333-333333333333',
    });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(contextState.outsideCalls).toBe(1);
    expect(contextState.systemCalls).toBe(1);
  });
});

describe('getLlmBillingSourceForOrg', () => {
  it.each([
    ['active', { id: CONFIG_ID, status: 'active' }],
    ['error', { id: CONFIG_ID, status: 'error' }],
  ] as const)('returns partner_key when a partner config row exists in %s status', async (_status, configRow) => {
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [configRow]);

    await expect(
      getLlmBillingSourceForOrg('33333333-3333-4333-8333-333333333333'),
    ).resolves.toBe('partner_key');

    expect(Object.keys(dbState.selectFields[1] as Record<string, unknown>)).toEqual(['id']);
    expect(decryptMock).not.toHaveBeenCalled();
    expect(dbState.updateSets).toHaveLength(0);
    expect(contextState.outsideCalls).toBe(2);
    expect(contextState.systemCalls).toBe(2);
  });

  it('returns platform when the partner has no config row', async () => {
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], []);

    await expect(
      getLlmBillingSourceForOrg('44444444-4444-4444-8444-444444444444'),
    ).resolves.toBe('platform');
    expect(decryptMock).not.toHaveBeenCalled();
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('returns platform when the organization is missing', async () => {
    dbState.selectResults.push([]);

    await expect(
      getLlmBillingSourceForOrg('55555555-5555-4555-8555-555555555555'),
    ).resolves.toBe('platform');
    expect(decryptMock).not.toHaveBeenCalled();
    expect(contextState.systemCalls).toBe(1);
  });

  it('captures lookup failures at most hourly and never throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    const error = new Error('database unavailable');
    const orgId = '66666666-6666-4666-8666-666666666666';
    dbState.selectErrors.push(error, error, error);

    await expect(getLlmBillingSourceForOrg(orgId)).resolves.toBe('platform');
    await expect(getLlmBillingSourceForOrg(orgId)).resolves.toBe('platform');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60 * 60 * 1000);
    await expect(getLlmBillingSourceForOrg(orgId)).resolves.toBe('platform');
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
    expect(captureExceptionMock).toHaveBeenLastCalledWith(error, undefined, {
      service: 'llmConfigResolver',
      orgId,
    });
  });

  it('returns platform when the partner-config existence lookup fails', async () => {
    const error = new Error('config lookup unavailable');
    const orgId = '77777777-7777-4777-8777-777777777777';
    dbState.selectResults.push([{ partnerId: PARTNER_ID }]);
    dbState.selectErrors.push(null, error);

    await expect(getLlmBillingSourceForOrg(orgId)).resolves.toBe('platform');
    expect(captureExceptionMock).toHaveBeenCalledWith(error, undefined, {
      service: 'llmConfigResolver',
      orgId,
    });
    expect(decryptMock).not.toHaveBeenCalled();
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('returns platform even when telemetry capture throws', async () => {
    const lookupError = new Error('database unavailable');
    const telemetryError = new Error('telemetry unavailable');
    const orgId = '88888888-8888-4888-8888-888888888888';
    dbState.selectErrors.push(lookupError);
    captureExceptionMock.mockImplementationOnce(() => {
      throw telemetryError;
    });

    await expect(getLlmBillingSourceForOrg(orgId)).resolves.toBe('platform');
  });
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

  it('returns the platform config when the partner has no configuration row', async () => {
    dbState.selectResults.push([]);

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'platform',
      apiKey: 'platform-key',
      model: 'claude-sonnet-4-6',
    });
    expect(contextState.outsideCalls).toBe(1);
    expect(contextState.systemCalls).toBe(1);
    expect(decryptMock).not.toHaveBeenCalled();
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
      endpoint: { kind: 'anthropic' },
    });
    expect(decryptMock).toHaveBeenCalledWith({ id: CONFIG_ID, apiKeyEncrypted: 'ciphertext' });
    expect(contextState.outsideCalls).toBe(1);
    expect(contextState.systemCalls).toBe(1);
    // A row with no catalog_entry_id must never reach the catalog at all —
    // not even to be told "not listed".
    expect(getListedProviderByEntryIdMock).not.toHaveBeenCalled();
  });

  it('reads catalog_entry_id keyed by partner id', async () => {
    dbState.selectResults.push([row()]);

    await resolveLlmConfig(PARTNER_ID);

    expect(Object.keys(dbState.selectFields[0] as Record<string, unknown>)).toContain(
      'catalogEntryId',
    );
    const compiled = compileWhere(dbState.selectWheres[0]);
    expect(compiled.sql).toBe('"partner_llm_configs"."partner_id" = $1');
    expect(compiled.params).toEqual([PARTNER_ID]);
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
      reason: 'key_material',
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

  it('throttles node key-material captures per partner for one hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    const partnerId = '44444444-4444-4444-8444-444444444444';
    const error = new SecretKeyMaterialError('Unknown encrypted secret key ID');
    dbState.selectResults.push([row()], [row()], [row()]);
    decryptMock.mockImplementation(() => {
      throw error;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await resolveLlmConfig(partnerId);
    await resolveLlmConfig(partnerId);
    expect(captureException).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60 * 60 * 1000);
    await resolveLlmConfig(partnerId);
    expect(captureException).toHaveBeenCalledTimes(2);
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

describe('resolveLlmConfig — catalog endpoints (#3922 W3)', () => {
  const catalogRow = (overrides: Record<string, unknown> = {}) =>
    row({ catalogEntryId: CATALOG_ENTRY_ID, ...overrides });

  it('fails closed with catalog_disabled when the feature flag is off', async () => {
    dbState.selectResults.push([catalogRow()]);

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'catalog_disabled',
    });
    // Never a silent fallback to direct Anthropic, and never a catalog read.
    expect(getListedProviderByEntryIdMock).not.toHaveBeenCalled();
  });

  it.each([['false'], ['TRUE '], ['']])(
    'treats LLM_PROVIDER_CATALOG_ENABLED=%j as off',
    async (flag) => {
      process.env.LLM_PROVIDER_CATALOG_ENABLED = flag;
      dbState.selectResults.push([catalogRow()]);

      await expect(resolveLlmConfig(PARTNER_ID)).resolves.toMatchObject({
        source: 'unavailable',
        reason: 'catalog_disabled',
      });
    },
  );

  it('fails closed with provider_delisted when the entry is not listed with an active revision', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    dbState.selectResults.push([catalogRow()]);
    // getListedProviderByEntryId only ever returns entries that are BOTH
    // status='listed' AND joined to an active revision, so a missing entry, a
    // delisted one and one with no active revision all arrive here as null.
    getListedProviderByEntryIdMock.mockResolvedValue(null);

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'provider_delisted',
    });
    expect(getListedProviderByEntryIdMock).toHaveBeenCalledWith(CATALOG_ENTRY_ID);
  });

  it('fails closed with model_unverified when the effective model is unmapped', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    dbState.selectResults.push([catalogRow({ defaultModel: 'claude-opus-4-8' })]);
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider());

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'model_unverified',
    });
  });

  it('fails closed with model_unverified when the mapped model has no passing verification', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    dbState.selectResults.push([catalogRow()]);
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider({ verifiedModels: [] }));

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'model_unverified',
    });
  });

  it('resolves a catalog endpoint with the provider model and a pricing snapshot', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    dbState.selectResults.push([catalogRow()]);
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider());

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'partner',
      partnerId: PARTNER_ID,
      apiKey: 'partner-plaintext-key',
      // The LOGICAL model stays the platform id — metering, budgets and the
      // model picker all key off it. Only the wire id is remapped.
      model: 'claude-sonnet-4-6',
      configId: CONFIG_ID,
      configVersion: 4,
      endpoint: {
        kind: 'catalog',
        catalogEntryId: CATALOG_ENTRY_ID,
        revisionId: CATALOG_REVISION_ID,
        baseUrl: 'https://openrouter.ai/api/v1',
        authMode: 'x-api-key',
        providerModel: 'anthropic/claude-sonnet-4-6',
        pricing: {
          catalogEntryId: CATALOG_ENTRY_ID,
          revisionId: CATALOG_REVISION_ID,
          inputCentsPerM: 300,
          outputCentsPerM: 1500,
          cacheReadCentsPerM: 30,
          cacheWriteCentsPerM: 375,
        },
        // The whole verified ∩ mapped set travels with the snapshot: sessions
        // and one-shot surfaces can run a model other than the partner
        // default, and none of them may re-read the catalog mid-flight.
        models: {
          'claude-sonnet-4-6': {
            providerModel: 'anthropic/claude-sonnet-4-6',
            pricing: {
              catalogEntryId: CATALOG_ENTRY_ID,
              revisionId: CATALOG_REVISION_ID,
              inputCentsPerM: 300,
              outputCentsPerM: 1500,
              cacheReadCentsPerM: 30,
              cacheWriteCentsPerM: 375,
            },
          },
        },
      },
    });
  });

  it('omits a mapped-but-unverified model from the endpoint model map', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    dbState.selectResults.push([catalogRow()]);
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider({
      modelMap: {
        'claude-sonnet-4-6': {
          providerModel: 'anthropic/claude-sonnet-4-6',
          inputCentsPerM: 300,
          outputCentsPerM: 1500,
          cacheReadCentsPerM: 30,
          cacheWriteCentsPerM: 375,
        },
        // Mapped by the revision but never verified at the current harness
        // version — must not become reachable through the model map.
        'claude-haiku-4-5': {
          providerModel: 'anthropic/claude-haiku-4-5',
          inputCentsPerM: 100,
          outputCentsPerM: 500,
          cacheReadCentsPerM: 10,
          cacheWriteCentsPerM: 125,
        },
      },
      verifiedModels: ['claude-sonnet-4-6'],
    }));

    const resolved = await resolveLlmConfig(PARTNER_ID);
    expect(resolved.source).toBe('partner');
    const endpoint = (resolved as Extract<typeof resolved, { source: 'partner' }>).endpoint;
    expect(endpoint.kind).toBe('catalog');
    expect(Object.keys((endpoint as Extract<typeof endpoint, { kind: 'catalog' }>).models))
      .toEqual(['claude-sonnet-4-6']);
  });

  it('keys catalog lookup on the row default model, not the platform default', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    dbState.selectResults.push([catalogRow({ defaultModel: 'claude-haiku-4-5' })]);
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider({
      modelMap: {
        'claude-haiku-4-5': {
          providerModel: 'anthropic/claude-haiku-4-5',
          inputCentsPerM: 100,
          outputCentsPerM: 500,
          cacheReadCentsPerM: 10,
          cacheWriteCentsPerM: 125,
        },
      },
      verifiedModels: ['claude-haiku-4-5'],
    }));

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toMatchObject({
      source: 'partner',
      model: 'claude-haiku-4-5',
      endpoint: { providerModel: 'anthropic/claude-haiku-4-5' },
    });
  });

  it('still fails on the key before consulting the catalog', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    dbState.selectResults.push([catalogRow({ status: 'error' })]);

    await expect(resolveLlmConfig(PARTNER_ID)).resolves.toEqual({
      source: 'unavailable',
      partnerId: PARTNER_ID,
      reason: 'key_error',
    });
    expect(getListedProviderByEntryIdMock).not.toHaveBeenCalled();
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
  it('pins partner clients to public Anthropic and disables environment auth-token inheritance', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://operator-proxy.example';
    process.env.ANTHROPIC_AUTH_TOKEN = 'operator-bearer-token';
    dbState.selectResults.push([row()]);

    const result = await getAnthropicClientForPartner(PARTNER_ID, ONE_SHOT_SURFACE);

    expect(result.resolved).toMatchObject({ source: 'partner', apiKey: 'partner-plaintext-key' });
    // Byte-identical to the pre-catalog construction: no `fetch`, no egress
    // recorder, no proxy — a direct partner must not pay for catalog wiring.
    expect(anthropicOptions).toEqual([PRE_CHANGE_DIRECT_PARTNER_CLIENT_OPTIONS]);
    expect(anthropicOptions[0]?.apiKey).not.toBe('platform-key');
    expect(buildGuardedLlmFetchMock).not.toHaveBeenCalled();
    expect(recordLlmEgressEventMock).not.toHaveBeenCalled();
  });

  it('leaves platform client endpoint and auth-token selection environment-aware', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://operator-proxy.example';
    process.env.ANTHROPIC_AUTH_TOKEN = 'operator-bearer-token';

    const result = await getAnthropicClientForPartner(null, ONE_SHOT_SURFACE);

    expect(result.resolved).toMatchObject({ source: 'platform', apiKey: 'platform-key' });
    expect(anthropicOptions).toEqual([PRE_CHANGE_PLATFORM_CLIENT_OPTIONS]);
    expect(buildGuardedLlmFetchMock).not.toHaveBeenCalled();
  });

  it('throws LlmUnavailableError instead of constructing a client for unavailable config', async () => {
    dbState.selectResults.push([row({ status: 'error' })]);

    await expect(getAnthropicClientForPartner(PARTNER_ID, ONE_SHOT_SURFACE))
      .rejects.toBeInstanceOf(LlmUnavailableError);
    expect(anthropicOptions).toHaveLength(0);
  });

  it('reports a deployment configuration error when the platform key is blank', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    process.env.ANTHROPIC_API_KEY = '   ';

    await expect(getAnthropicClientForPartner(null, ONE_SHOT_SURFACE)).rejects.toMatchObject({
      name: 'LlmUnavailableError',
      message: 'AI is not configured on this deployment.',
    });
    await expect(getAnthropicClientForPartner(null, ONE_SHOT_SURFACE))
      .rejects.toBeInstanceOf(LlmUnavailableError);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'AI is not configured on this deployment.',
      { eventCode: 'llm_platform_key_missing' },
    );

    vi.advanceTimersByTime(60 * 60 * 1000);
    await expect(getAnthropicClientForPartner(null, ONE_SHOT_SURFACE))
      .rejects.toBeInstanceOf(LlmUnavailableError);
    expect(captureMessage).toHaveBeenCalledTimes(2);
    expect(anthropicOptions).toHaveLength(0);
  });
});

describe('getAnthropicClientForPartner — catalog clients (#3922 W3)', () => {
  beforeEach(() => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider());
  });

  it('builds an x-api-key catalog client on the guarded fetch pinned to the endpoint origin', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://operator-proxy.example';
    process.env.ANTHROPIC_AUTH_TOKEN = 'operator-bearer-token';
    dbState.selectResults.push([row({ catalogEntryId: CATALOG_ENTRY_ID })]);

    await getAnthropicClientForPartner(PARTNER_ID, ONE_SHOT_SURFACE);

    expect(anthropicOptions).toEqual([{
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'partner-plaintext-key',
      authToken: null,
      fetch: GUARDED_FETCH_SENTINEL,
    }]);
    // Origin, not the full base URL — the pin is on scheme+host+port.
    expect(guardedFetchOptions[0]?.allowedOrigin).toBe('https://openrouter.ai');
  });

  it('builds a bearer catalog client that scrubs apiKey', async () => {
    dbState.selectResults.push([row({ catalogEntryId: CATALOG_ENTRY_ID })]);
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider({ authMode: 'bearer' }));

    await getAnthropicClientForPartner(PARTNER_ID, ONE_SHOT_SURFACE);

    expect(anthropicOptions).toEqual([{
      baseURL: 'https://openrouter.ai/api/v1',
      authToken: 'partner-plaintext-key',
      apiKey: null,
      fetch: GUARDED_FETCH_SENTINEL,
    }]);
  });

  it('records every guarded-fetch attempt against the caller surface and catalog provenance', async () => {
    dbState.selectResults.push([row({ catalogEntryId: CATALOG_ENTRY_ID })]);

    await getAnthropicClientForPartner(PARTNER_ID, {
      surface: 'one_shot_catalog_enrichment',
      orgId: ORG_ID,
    });

    guardedFetchOptions[0]?.recordEgress({
      host: 'openrouter.ai',
      resolvedIp: '104.18.0.1',
      blocked: false,
    });
    guardedFetchOptions[0]?.recordEgress({
      host: 'evil.example',
      resolvedIp: null,
      blocked: true,
    });

    expect(recordLlmEgressEventMock).toHaveBeenNthCalledWith(1, {
      orgId: ORG_ID,
      partnerId: PARTNER_ID,
      surface: 'one_shot_catalog_enrichment',
      host: 'openrouter.ai',
      resolvedIp: '104.18.0.1',
      blocked: false,
      catalogEntryId: CATALOG_ENTRY_ID,
      revisionId: CATALOG_REVISION_ID,
    });
    expect(recordLlmEgressEventMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      host: 'evil.example',
      resolvedIp: null,
      blocked: true,
    }));
  });

  it('warns once instead of throwing when there is no org to attribute egress to', async () => {
    dbState.selectResults.push([row({ catalogEntryId: CATALOG_ENTRY_ID })]);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await getAnthropicClientForPartner(PARTNER_ID, {
      surface: 'one_shot_catalog_enrichment',
      orgId: null,
    });

    guardedFetchOptions[0]?.recordEgress({ host: 'openrouter.ai', resolvedIp: '1.1.1.1', blocked: false });
    guardedFetchOptions[0]?.recordEgress({ host: 'openrouter.ai', resolvedIp: '1.1.1.1', blocked: false });

    expect(recordLlmEgressEventMock).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });

  it('throws LlmUnavailableError for a delisted endpoint instead of falling back to direct Anthropic', async () => {
    dbState.selectResults.push([row({ catalogEntryId: CATALOG_ENTRY_ID })]);
    getListedProviderByEntryIdMock.mockResolvedValue(null);

    await expect(getAnthropicClientForPartner(PARTNER_ID, ONE_SHOT_SURFACE))
      .rejects.toBeInstanceOf(LlmUnavailableError);
    expect(anthropicOptions).toHaveLength(0);
    expect(buildGuardedLlmFetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The wire-model translation every outbound surface must go through
 * (#3922 W3 review). Two properties are load-bearing: a catalog endpoint never
 * receives a platform-logical model id, and a model the pinned revision has
 * not mapped AND verified fails CLOSED rather than being silently re-pointed
 * at the partner's default — which would run a model nobody asked for while
 * the usage ledger recorded one that never ran.
 */
describe('resolveWireModel', () => {
  const DIRECT_PARTNER: UsableLlmConfig = {
    source: 'partner',
    partnerId: PARTNER_ID,
    apiKey: 'partner-plaintext-key',
    model: 'claude-sonnet-4-6',
    configId: CONFIG_ID,
    configVersion: 4,
    endpoint: { kind: 'anthropic' },
  };

  async function catalogConfig(): Promise<UsableLlmConfig> {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    dbState.selectResults.push([row({ catalogEntryId: CATALOG_ENTRY_ID })]);
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider({
      modelMap: {
        'claude-sonnet-4-6': {
          providerModel: 'anthropic/claude-sonnet-4-6',
          inputCentsPerM: 300,
          outputCentsPerM: 1500,
          cacheReadCentsPerM: 30,
          cacheWriteCentsPerM: 375,
        },
        'claude-haiku-4-5': {
          providerModel: 'anthropic/claude-haiku-4-5',
          inputCentsPerM: 100,
          outputCentsPerM: 500,
          cacheReadCentsPerM: 10,
          cacheWriteCentsPerM: 125,
        },
      },
      verifiedModels: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    }));
    const resolved = await resolveLlmConfig(PARTNER_ID);
    if (resolved.source === 'unavailable') throw new Error('fixture did not resolve');
    return resolved;
  }

  it('passes the logical id straight through for the platform path', () => {
    expect(resolveWireModel(
      { source: 'platform', apiKey: 'platform-key', model: 'claude-sonnet-4-6' },
      'claude-sonnet-4-6',
    )).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('passes the logical id straight through for a direct-Anthropic partner, with no pricing', () => {
    expect(resolveWireModel(DIRECT_PARTNER, 'claude-opus-4-8')).toEqual({ model: 'claude-opus-4-8' });
  });

  it('translates the partner default model to the revision wire id and its pricing', async () => {
    const resolved = await catalogConfig();

    expect(resolveWireModel(resolved, 'claude-sonnet-4-6')).toEqual({
      model: 'anthropic/claude-sonnet-4-6',
      catalogPricing: {
        catalogEntryId: CATALOG_ENTRY_ID,
        revisionId: CATALOG_REVISION_ID,
        inputCentsPerM: 300,
        outputCentsPerM: 1500,
        cacheReadCentsPerM: 30,
        cacheWriteCentsPerM: 375,
      },
    });
  });

  it('translates a NON-default verified model to its own wire id and its own pricing', async () => {
    const resolved = await catalogConfig();

    // The resolver's model_unverified gate only ever looked at the partner
    // default; a session or one-shot surface running haiku must still get
    // haiku's wire id AND haiku's rates, not sonnet's.
    expect(resolveWireModel(resolved, 'claude-haiku-4-5')).toEqual({
      model: 'anthropic/claude-haiku-4-5',
      catalogPricing: {
        catalogEntryId: CATALOG_ENTRY_ID,
        revisionId: CATALOG_REVISION_ID,
        inputCentsPerM: 100,
        outputCentsPerM: 500,
        cacheReadCentsPerM: 10,
        cacheWriteCentsPerM: 125,
      },
    });
  });

  it('fails closed for a model the pinned revision has not mapped and verified', async () => {
    const resolved = await catalogConfig();

    expect(() => resolveWireModel(resolved, 'claude-opus-4-8')).toThrow(LlmUnavailableError);
    // Never silently substituted with the partner default.
    expect(() => resolveWireModel(resolved, 'claude-opus-4-8')).toThrow(/claude-opus-4-8/);
  });

  /**
   * Prototype-named logical models (#3922 W3 review round 2). `ai_sessions.model`
   * is free-form client input (`createAiSessionSchema`: `z.string().max(100)`),
   * so `constructor`, `__proto__`, `toString` and friends all reach here. Looked
   * up on a plain object literal every one of them is TRUTHY by inheritance,
   * which skipped the fail-closed throw and returned `{ model: undefined }`. On
   * the SDK path `query({ options: { model: undefined } })` lets the SDK CLI
   * substitute its OWN default id on the wire to the third-party endpoint, and
   * the session then meters at Anthropic list rates instead of the revision's —
   * a fail-OPEN that the pre-map `Array#includes` gate did not have.
   */
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'fails closed for the prototype-named model %s instead of returning an inherited binding',
    async (logicalModel) => {
      const resolved = await catalogConfig();

      expect(() => resolveWireModel(resolved, logicalModel)).toThrow(LlmUnavailableError);
    },
  );

  it('never yields an undefined wire model for any prototype-named model', async () => {
    const resolved = await catalogConfig();

    for (const logicalModel of ['constructor', '__proto__', 'toString', 'valueOf']) {
      let wire: { model: string } | undefined;
      try {
        wire = resolveWireModel(resolved, logicalModel);
      } catch {
        continue;
      }
      // Reaching here at all is the bug; assert the shape that made it dangerous.
      expect(wire?.model).toBeTypeOf('string');
    }
  });
});

/**
 * The snapshot builder is shared by the resolver, partner-facing endpoint
 * selection and the rotation probe, so a fail-open here is a fail-open in all
 * three (#3922 W3 review round 2).
 */
describe('buildCatalogEndpointSnapshot', () => {
  it.each(['constructor', '__proto__', 'toString', 'valueOf'])(
    'returns null for the prototype-named default model %s',
    (model) => {
      expect(buildCatalogEndpointSnapshot(listedProvider() as never, model)).toBeNull();
    },
  );

  it('never synthesizes a binding from a prototype-named verified model', () => {
    const snapshot = buildCatalogEndpointSnapshot(
      listedProvider({
        verifiedModels: ['claude-sonnet-4-6', 'constructor', '__proto__', 'toString'],
      }) as never,
      'claude-sonnet-4-6',
    );

    expect(snapshot).not.toBeNull();
    // `provider.modelMap` is a jsonb round-trip — a plain object literal — so an
    // unguarded `modelMap[modelId]` returns Object.prototype members and would
    // register a binding whose providerModel and every price are `undefined`.
    expect(Object.keys(snapshot!.models)).toEqual(['claude-sonnet-4-6']);
  });

  it('builds the model map with a null prototype so no logical id can inherit a binding', () => {
    const snapshot = buildCatalogEndpointSnapshot(listedProvider() as never, 'claude-sonnet-4-6');

    expect(snapshot).not.toBeNull();
    expect(Object.getPrototypeOf(snapshot!.models)).toBeNull();
  });
});
