import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const CONFIG_ID = '22222222-2222-4222-8222-222222222222';

const CATALOG_ENTRY_ID = '33333333-3333-4333-8333-333333333333';
const CATALOG_REVISION_ID = '44444444-4444-4444-8444-444444444444';

const {
  captureExceptionMock,
  captureMessageMock,
  dbState,
  decryptMock,
  contextState,
  getListedProviderByEntryIdMock,
} = vi.hoisted(() => ({
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
  contextState: { outsideCalls: 0, systemCalls: 0, ambientScope: undefined as string | undefined },
  getListedProviderByEntryIdMock: vi.fn(),
}));

vi.mock('../llmProviderCatalog', () => ({
  getListedProviderByEntryId: getListedProviderByEntryIdMock,
}));

vi.mock('../aiModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiModel')>()),
  resolveDefaultModel: () => 'claude-sonnet-4-6',
}));

vi.mock('../aiModels/connectionKeys', () => ({
  decryptConnectionKey: decryptMock,
}));

vi.mock('../sentry', () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
}));

vi.mock('../../db', () => ({
  getCurrentDbAccessContext: () => (contextState.ambientScope ? { scope: contextState.ambientScope } : undefined),
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
  markPartnerLlmError,
  resolveCatalogEndpoint,
} from './llmConfigResolver';

const originalPlatformKey = process.env.ANTHROPIC_API_KEY;
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalCatalogFlag = process.env.LLM_PROVIDER_CATALOG_ENABLED;

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
  contextState.ambientScope = undefined;
  decryptMock.mockReturnValue('partner-plaintext-key');
  getListedProviderByEntryIdMock.mockResolvedValue(null);
  process.env.ANTHROPIC_API_KEY = 'platform-key';
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.LLM_PROVIDER_CATALOG_ENABLED;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (originalCatalogFlag === undefined) delete process.env.LLM_PROVIDER_CATALOG_ENABLED;
  else process.env.LLM_PROVIDER_CATALOG_ENABLED = originalCatalogFlag;
  if (originalPlatformKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalPlatformKey;
  if (originalAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
  if (originalAnthropicAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
});

describe('per-org funding inference', () => {
  it('no longer exists (quorum #4): funding comes from the resolved offering', async () => {
    const mod = await import('./llmConfigResolver');
    expect('getLlmBillingSourceForOrg' in mod).toBe(false);
  });
});

describe('resolveCatalogEndpoint (#3922 W3; exported for registry readiness in W08)', () => {
  it('fails closed with catalog_disabled when the feature flag is off, without reading the catalog', async () => {
    await expect(resolveCatalogEndpoint(CATALOG_ENTRY_ID, 'claude-sonnet-4-6')).resolves.toEqual({ ok: false, reason: 'catalog_disabled' });
    // Never a silent fallback to direct Anthropic, and never a catalog read.
    expect(getListedProviderByEntryIdMock).not.toHaveBeenCalled();
  });

  it.each([['false'], ['TRUE '], ['']])(
    'treats LLM_PROVIDER_CATALOG_ENABLED=%j as off',
    async (flag) => {
      process.env.LLM_PROVIDER_CATALOG_ENABLED = flag;
      await expect(resolveCatalogEndpoint(CATALOG_ENTRY_ID, 'claude-sonnet-4-6')).resolves.toEqual({ ok: false, reason: 'catalog_disabled' });
    },
  );

  it('fails closed with provider_delisted when the entry is not listed with an active revision', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    // getListedProviderByEntryId only ever returns entries that are BOTH
    // status='listed' AND joined to an active revision, so a missing entry, a
    // delisted one and one with no active revision all arrive here as null.
    getListedProviderByEntryIdMock.mockResolvedValue(null);

    await expect(resolveCatalogEndpoint(CATALOG_ENTRY_ID, 'claude-sonnet-4-6')).resolves.toEqual({ ok: false, reason: 'provider_delisted' });
    expect(getListedProviderByEntryIdMock).toHaveBeenCalledWith(CATALOG_ENTRY_ID);
  });

  it('fails closed with model_unverified when the model is unmapped', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider());

    await expect(resolveCatalogEndpoint(CATALOG_ENTRY_ID, 'claude-opus-4-8')).resolves.toEqual({ ok: false, reason: 'model_unverified' });
  });

  it('fails closed with model_unverified when the mapped model has no passing verification', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider({ verifiedModels: [] }));

    await expect(resolveCatalogEndpoint(CATALOG_ENTRY_ID, 'claude-sonnet-4-6')).resolves.toEqual({ ok: false, reason: 'model_unverified' });
  });

  it('resolves a catalog endpoint with the provider model, a pricing snapshot and the verified model map', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    getListedProviderByEntryIdMock.mockResolvedValue(listedProvider());

    const pricing = {
      catalogEntryId: CATALOG_ENTRY_ID,
      revisionId: CATALOG_REVISION_ID,
      inputCentsPerM: 300,
      outputCentsPerM: 1500,
      cacheReadCentsPerM: 30,
      cacheWriteCentsPerM: 375,
    };
    await expect(resolveCatalogEndpoint(CATALOG_ENTRY_ID, 'claude-sonnet-4-6')).resolves.toEqual({
      ok: true,
      endpoint: {
        kind: 'catalog',
        catalogEntryId: CATALOG_ENTRY_ID,
        revisionId: CATALOG_REVISION_ID,
        baseUrl: 'https://openrouter.ai/api/v1',
        authMode: 'x-api-key',
        providerModel: 'anthropic/claude-sonnet-4-6',
        pricing,
        // The whole verified ∩ mapped set travels with the snapshot.
        models: { 'claude-sonnet-4-6': { providerModel: 'anthropic/claude-sonnet-4-6', pricing } },
      },
    });
  });

  it('keys the lookup on the model it is given (the chat default offering\'s model), not the platform default', async () => {
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
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

    await expect(resolveCatalogEndpoint(CATALOG_ENTRY_ID, 'claude-haiku-4-5')).resolves.toMatchObject({
      ok: true,
      endpoint: { providerModel: 'anthropic/claude-haiku-4-5' },
    });
    await expect(resolveCatalogEndpoint(CATALOG_ENTRY_ID, 'claude-sonnet-4-6')).resolves.toEqual({ ok: false, reason: 'model_unverified' });
  });
});

describe('the legacy resolver half is gone (W08)', () => {
  it('exports only the connection half', async () => {
    const mod = await import('./llmConfigResolver');
    // Exactly these runtime exports: the per-partner legacy resolver, its
    // per-org variant and its in-context readiness view are deleted.
    expect(Object.keys(mod).sort()).toEqual([
      'LlmUnavailableError',
      'buildCatalogEndpointSnapshot',
      'isLlmProviderCatalogEnabled',
      'markPartnerLlmError',
      'platformLlmConfig',
      'resolveCatalogEndpoint',
    ]);
    expect(typeof mod.platformLlmConfig).toBe('function');
    expect(typeof mod.resolveCatalogEndpoint).toBe('function');
  });

  it('platformLlmConfig is the deployment key with the deployment default model, read without the database', async () => {
    const { platformLlmConfig } = await import('./llmConfigResolver');
    expect(platformLlmConfig()).toEqual({ source: 'platform', apiKey: 'platform-key', model: 'claude-sonnet-4-6' });
    expect(dbState.selectFields).toEqual([]);
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
    expect(compiled.sql).toBe('("partner_ai_connections"."id" = $1 and "partner_ai_connections"."config_version" = $2)');
    expect(compiled.params).toEqual([CONFIG_ID, 3]);
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
