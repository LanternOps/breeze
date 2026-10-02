import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG_ID = '22222222-2222-4222-8222-222222222222';

const CATALOG_ENTRY_ID = '33333333-3333-4333-8333-333333333333';
const CATALOG_REVISION_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '99999999-9999-4999-8999-999999999999';

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
  resolveLlmConfig,
  llmUnusableCodeForOrgInSystemContext,
} from './llmConfigResolver';
import { SecretKeyMaterialError } from '../secretCrypto';
import { captureException } from '../sentry';

const originalPlatformKey = process.env.ANTHROPIC_API_KEY;
const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
const originalCatalogFlag = process.env.LLM_PROVIDER_CATALOG_ENABLED;

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

describe('llmUnusableCodeForOrgInSystemContext (topology readiness, review R1)', () => {
  beforeEach(() => { contextState.ambientScope = 'system'; });

  it('reads on the CALLER\'s system connection — no escape, no second context, no error marking', async () => {
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [row()]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBeNull();
    expect(contextState.outsideCalls).toBe(0);
    expect(contextState.systemCalls).toBe(0);
  });

  it('mirrors the resolver decisions: platform without a partner config; unusable on error status, undecryptable key or a delisted catalog pin', async () => {
    dbState.selectResults.push([{ partnerId: null }]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBeNull();
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], []);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBeNull();
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [row({ status: 'error' })]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBe('ai_unavailable');
    decryptMock.mockImplementationOnce(() => { throw new Error('bad ciphertext'); });
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [row()]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBe('ai_unavailable');
    process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [row({ catalogEntryId: CATALOG_ENTRY_ID })]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBe('ai_unavailable');
    dbState.selectResults.push([]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBe('ai_unavailable');
    expect(dbState.updateSets).toEqual([]);
  });

  it('is NOT ready on the platform path when the server has no model key at all (with or without a partner row)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    dbState.selectResults.push([{ partnerId: null }]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBe('ai_not_configured');
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], []);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBe('ai_not_configured');
    // A partner BYO key is a usable provider on its own.
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [row()]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBeNull();
    // The documented self-host credential (#1412) counts as a platform key.
    process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token';
    dbState.selectResults.push([{ partnerId: null }]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBeNull();
  });

  it('W06: with no platform key, an active OpenAI-compatible connection is a usable provider (env / BYO gateway deployments)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    // No compat row, one live gateway connection → ready.
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [], [{ id: 'conn-oai' }]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBeNull();
    // No live gateway connection (disconnected / errored rows are filtered in SQL) → not configured.
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [], []);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBe('ai_not_configured');
    // An unusable compat config still wins: no gateway read, unavailable.
    dbState.selectResults.push([{ partnerId: PARTNER_ID }], [row({ status: 'error' })], [{ id: 'conn-oai' }]);
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).resolves.toBe('ai_unavailable');
    dbState.selectResults.length = 0;
    expect(contextState.outsideCalls).toBe(0);
    expect(dbState.updateSets).toEqual([]);
  });

  it('refuses to run outside a system context (it would read under the wrong RLS scope)', async () => {
    contextState.ambientScope = 'organization';
    await expect(llmUnusableCodeForOrgInSystemContext(ORG_ID)).rejects.toThrow(/system/);
    expect(dbState.selectFields).toEqual([]);
  });
});

describe('per-org funding inference', () => {
  it('no longer exists (quorum #4): funding comes from the resolved offering', async () => {
    const mod = await import('./llmConfigResolver');
    expect('getLlmBillingSourceForOrg' in mod).toBe(false);
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

  it('reads catalog_entry_id from the partner\'s compat connection, not partner_llm_configs (Task 6B)', async () => {
    dbState.selectResults.push([row()]);

    await resolveLlmConfig(PARTNER_ID);

    expect(Object.keys(dbState.selectFields[0] as Record<string, unknown>)).toContain(
      'catalogEntryId',
    );
    const compiled = compileWhere(dbState.selectWheres[0]);
    // A soft-disconnected connection (#7700 finding 1) is never the partner's config.
    expect(compiled.sql).toBe('("partner_ai_connections"."partner_id" = $1 and "partner_ai_connections"."kind" in ($2, $3) and "partner_ai_connections"."status" <> $4)');
    expect(compiled.params).toEqual([PARTNER_ID, 'anthropic_byok', 'catalog', 'disconnected']);
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
    expect(compiled.sql).toBe('("partner_ai_connections"."id" = $1 and "partner_ai_connections"."config_version" = $2)');
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
