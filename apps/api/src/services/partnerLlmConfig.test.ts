import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONFIG_ID = '33333333-3333-4333-8333-333333333333';
const CATALOG_ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const CATALOG_REVISION_ID = '55555555-5555-4555-8555-555555555555';
const API_KEY = 'sk-ant-api03-unit-test-key-1234567890';

const { anthropicState, captureExceptionMock, catalogState, reg, order } = vi.hoisted(() => {
  class MockAnthropicApiError extends Error {
    constructor(message: string, readonly status?: number) {
      super(message);
      this.name = 'APIError';
    }
  }
  const order: string[] = [];
  return {
    anthropicState: {
      constructorOptions: [] as Array<Record<string, unknown>>,
      create: vi.fn(),
      apiErrorClass: MockAnthropicApiError,
    },
    captureExceptionMock: vi.fn(),
    catalogState: { catalogEnabled: true, getListedProviderByEntryId: vi.fn() },
    order,
    /** The registry as the facade sees it: one compat connection or none. */
    reg: {
      compat: null as null | { id: string; kind: 'anthropic_byok' | 'catalog'; catalogEntryId: string | null; legacyDefaultModel: string | null },
      cutOver: true,
      statusRow: null as null | Record<string, unknown>,
      statusFrom: [] as unknown[],
    },
  };
});

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    static APIError = anthropicState.apiErrorClass;
    messages = { create: (...args: unknown[]) => { order.push('probe'); return anthropicState.create(...args); } };
    constructor(options: Record<string, unknown>) {
      anthropicState.constructorOptions.push(options);
    }
  }
  return { default: MockAnthropic };
});

vi.mock('./aiModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiModel')>()),
  resolveDefaultModel: () => 'claude-sonnet-4-6',
}));


const legacy = vi.hoisted(() => ({
  lock: vi.fn(async (_partnerId: string) => { order.push('lock'); }),
  reconcile: vi.fn(),
}));
vi.mock('./aiModels/legacyReconcile', () => ({
  lockPartnerRegistryReconcile: legacy.lock,
  reconcilePartnerFromLegacyInTx: legacy.reconcile,
}));

const cutover = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock('./aiModels/registryCutover', () => ({ ensurePartnerCutover: cutover.ensure }));

const conns = vi.hoisted(() => ({
  getCompatConnection: vi.fn(),
  getConnectionKeyMaterial: vi.fn(),
  decryptConnectionKey: vi.fn(),
}));
vi.mock('./aiModels/connections', () => {
  class ConnectionKeyError extends Error {
    constructor(message: string, readonly code: string) { super(message); this.name = 'ConnectionKeyError'; }
  }
  return { ...conns, ConnectionKeyError };
});

const remap = vi.hoisted(() => ({
  lockCompatConnection: vi.fn(),
  connectCompat: vi.fn(),
  disconnectCompat: vi.fn(),
  rotateCompatKey: vi.fn(),
  setCompatCatalogEntry: vi.fn(),
  bumpCompatConfigVersion: vi.fn(),
  switchCompatKind: vi.fn(),
}));
vi.mock('./aiModels/compatRemap', () => {
  class RegistryNotCutOverError extends Error { constructor() { super('not cut over'); this.name = 'RegistryNotCutOverError'; } }
  class CompatConnectionMissingError extends Error { constructor() { super('missing'); this.name = 'CompatConnectionMissingError'; } }
  return { ...remap, RegistryNotCutOverError, CompatConnectionMissingError };
});

const discovery = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('../jobs/aiModelDiscoveryWorker', () => ({ enqueueConnectionSync: discovery.enqueue }));

vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('./llmProviderCatalog', () => ({ getListedProviderByEntryId: catalogState.getListedProviderByEntryId }));

// Only the feature flag is stubbed. `buildCatalogEndpointSnapshot` stays REAL:
// it is the single shared definition of "usable endpoint + wire model".
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
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        reg.statusFrom.push(table);
        return { where: vi.fn(() => ({ limit: vi.fn(async () => (reg.statusRow ? [reg.statusRow] : [])) })) };
      }),
    })),
  },
}));

import {
  deletePartnerLlmConfig,
  PartnerLlmError,
  savePartnerLlmKey,
  updatePartnerLlmEndpoint,
} from './partnerLlmConfig';
import { buildGuardedLlmFetch, LlmEgressViolationError } from './llm/guardedLlmFetch';
import { CompatConnectionMissingError, RegistryNotCutOverError } from './aiModels/compatRemap';
import { RegistryWriteError } from './aiModels/registryWriteErrors';

const byok = (over: Partial<NonNullable<typeof reg.compat>> = {}) =>
  ({ id: CONFIG_ID, kind: 'anthropic_byok' as const, catalogEntryId: null, legacyDefaultModel: null, ...over });
const catalogConn = (over: Partial<NonNullable<typeof reg.compat>> = {}) =>
  byok({ kind: 'catalog', catalogEntryId: CATALOG_ENTRY_ID, legacyDefaultModel: 'claude-sonnet-4-6', ...over });

/** Every registry-native write the facade can issue. */
const WRITES = ['connectCompat', 'disconnectCompat', 'rotateCompatKey', 'setCompatCatalogEntry', 'bumpCompatConfigVersion', 'switchCompatKind'] as const;
const writesIssued = () => WRITES.filter((name) => remap[name].mock.calls.length > 0);

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

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  anthropicState.constructorOptions.length = 0;
  anthropicState.create.mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  catalogState.catalogEnabled = true;
  catalogState.getListedProviderByEntryId.mockReset();
  vi.mocked(buildGuardedLlmFetch).mockReturnValue('guarded-fetch-sentinel' as never);
  reg.compat = null;
  reg.cutOver = true;
  reg.statusRow = null;
  reg.statusFrom = [];
  cutover.ensure.mockImplementation(async () => { order.push('gate'); return reg.cutOver; });
  conns.getCompatConnection.mockImplementation(async () => reg.compat);
  conns.getConnectionKeyMaterial.mockImplementation(async (id: string) => ({ id, partnerId: PARTNER_ID, apiKeyEncrypted: 'enc:sealed' }));
  conns.decryptConnectionKey.mockReturnValue(API_KEY);
  remap.lockCompatConnection.mockImplementation(async () => (reg.compat
    ? { ...reg.compat, configVersion: 4, connectedBy: USER_ID, verifiedAt: null }
    : null));
  for (const name of WRITES) remap[name].mockImplementation(async () => { order.push(name); return { configVersion: 5 }; });
  remap.connectCompat.mockImplementation(async () => { order.push('connectCompat'); return 'new-conn'; });
  discovery.enqueue.mockResolvedValue(undefined);
  remap.disconnectCompat.mockImplementation(async () => { order.push('disconnectCompat'); return true; });
  remap.rotateCompatKey.mockImplementation(async () => { order.push('rotateCompatKey'); return { configVersion: 8, defaultModel: 'claude-haiku-4-5' }; });
});

describe('savePartnerLlmKey', () => {
  it.each([
    [401, 400],
    [403, 409],
    [429, 503],
  ])('maps an Anthropic %i probe rejection to %i and writes nothing', async (upstream, status) => {
    anthropicState.create.mockRejectedValue(new anthropicState.apiErrorClass('rejected', upstream));
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }))
      .rejects.toMatchObject({ name: 'PartnerLlmError', status });
    expect(writesIssued()).toEqual([]);
  });

  it('rethrows a non-APIError from the probe without wrapping or writing', async () => {
    const error = new Error('unexpected programming failure');
    anthropicState.create.mockRejectedValue(error);
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID })).rejects.toBe(error);
    expect(writesIssued()).toEqual([]);
  });

  it('maps another Anthropic 4xx rejection to 400 without exposing the response body', async () => {
    const error = new anthropicState.apiErrorClass('sensitive upstream response', 404);
    anthropicState.create.mockRejectedValue(error);
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID })).rejects.toMatchObject({
      name: 'PartnerLlmError',
      status: 400,
      message: 'Anthropic rejected the verification request (HTTP 404). The probe model may be unavailable — contact support if this persists.',
    });
    expect(captureExceptionMock).toHaveBeenCalledWith(error, undefined, { service: 'partnerLlmConfig' });
    expect(writesIssued()).toEqual([]);
  });

  it('rejects an encrypted-envelope paste before the gate, the probe or any write', async () => {
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: 'enc:v3:key:pretend.payload.here', userId: USER_ID }))
      .rejects.toBeInstanceOf(PartnerLlmError);
    expect(cutover.ensure).not.toHaveBeenCalled();
    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(writesIssued()).toEqual([]);
  });

  it('a first key probes the public API, then connects a BYOK connection (version 1, tracking the deployment default)', async () => {
    const result = await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: `  ${API_KEY}  `, userId: USER_ID });
    // Pinned to the public API through the connection factory: a partner key
    // never follows an ambient ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN.
    expect(anthropicState.constructorOptions).toEqual([{ apiKey: API_KEY, authToken: null, baseURL: 'https://api.anthropic.com' }]);
    expect(anthropicState.create).toHaveBeenCalledWith({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    expect(remap.connectCompat).toHaveBeenCalledWith(PARTNER_ID, {
      kind: 'anthropic_byok', apiKey: API_KEY, catalogEntryId: null, connectedBy: USER_ID, defaultModel: null, verifiedAt: expect.any(Date),
    });
    expect(writesIssued()).toEqual(['connectCompat']);
    expect(result).toMatchObject({ last4: '7890', model: 'claude-sonnet-4-6', configVersion: 1, verifiedAt: expect.any(Date) });
  });

  it('a replacement key rotates the connection in place (no remap) and reports its pinned model', async () => {
    reg.compat = byok({ legacyDefaultModel: 'claude-haiku-4-5' });
    const result = await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID });
    expect(remap.rotateCompatKey).toHaveBeenCalledWith(PARTNER_ID, { apiKey: API_KEY, connectedBy: USER_ID, verifiedAt: expect.any(Date) });
    expect(writesIssued()).toEqual(['rotateCompatKey']);
    expect(result).toMatchObject({ model: 'claude-haiku-4-5', configVersion: 8 });
  });

  it('probes the currently-selected catalog endpoint instead of direct Anthropic when rotating the key', async () => {
    reg.compat = catalogConn();
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID });
    expect(catalogState.getListedProviderByEntryId).toHaveBeenCalledWith(CATALOG_ENTRY_ID);
    expect(buildGuardedLlmFetch).toHaveBeenCalledWith(expect.objectContaining({ allowedOrigin: 'https://openrouter.ai' }));
    expect(anthropicState.constructorOptions).toEqual([{
      baseURL: 'https://openrouter.ai/api/v1', apiKey: API_KEY, authToken: null, fetch: 'guarded-fetch-sentinel',
    }]);
    expect(anthropicState.create).toHaveBeenCalledWith({ model: 'anthropic/claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    expect(writesIssued()).toEqual(['rotateCompatKey']);
  });

  it.each([
    ['delisted', () => catalogState.getListedProviderByEntryId.mockResolvedValue(null)],
    ['catalog selection disabled', () => { catalogState.catalogEnabled = false; }],
  ])('rejects a key rotation when the selected catalog endpoint is %s, without probing or writing', async (_why, arrange) => {
    reg.compat = catalogConn();
    arrange();
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID })).rejects.toMatchObject({ status: 409 });
    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(writesIssued()).toEqual([]);
  });

  it('refuses (409) when the endpoint changed between the probe and the write', async () => {
    reg.compat = byok();
    remap.lockCompatConnection.mockResolvedValueOnce({ ...catalogConn(), configVersion: 9, connectedBy: null, verifiedAt: null });
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID })).rejects.toMatchObject({ status: 409 });
    expect(writesIssued()).toEqual([]);
  });
});

describe('deletePartnerLlmConfig', () => {
  it.each([true, false])('disconnects natively and returns whether a connection existed (%s)', async (existed) => {
    remap.disconnectCompat.mockResolvedValueOnce(existed);
    await expect(deletePartnerLlmConfig(PARTNER_ID)).resolves.toBe(existed);
    expect(remap.disconnectCompat).toHaveBeenCalledWith(PARTNER_ID);
  });
});

describe('updatePartnerLlmEndpoint', () => {
  const select = (catalogEntryId: string | null, acknowledgeDataNote = true) =>
    updatePartnerLlmEndpoint({ partnerId: PARTNER_ID, catalogEntryId, acknowledgeDataNote, userId: USER_ID });

  it('rejects when no Anthropic key is connected yet', async () => {
    await expect(select(CATALOG_ENTRY_ID)).rejects.toMatchObject({ name: 'PartnerLlmError', status: 409 });
    expect(writesIssued()).toEqual([]);
  });

  it('reverting an already-direct partner to direct only advances config_version (no probe)', async () => {
    reg.compat = byok();
    await expect(select(null, false)).resolves.toEqual({ catalogEntryId: null, configVersion: 5, slug: null, revision: null });
    expect(writesIssued()).toEqual(['bumpCompatConfigVersion']);
    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(catalogState.getListedProviderByEntryId).not.toHaveBeenCalled();
  });

  it('catalog → direct switches kind with the same key and keeps the model (no probe)', async () => {
    reg.compat = catalogConn({ legacyDefaultModel: 'claude-haiku-4-5' });
    await select(null, false);
    expect(remap.switchCompatKind).toHaveBeenCalledWith(PARTNER_ID, {
      kind: 'anthropic_byok', apiKey: API_KEY, catalogEntryId: null, defaultModel: 'claude-haiku-4-5',
    });
    expect(conns.getConnectionKeyMaterial).toHaveBeenCalledWith(CONFIG_ID);
    expect(anthropicState.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a delisted entry', () => catalogState.getListedProviderByEntryId.mockResolvedValue(null), true, 409],
    ['a missing data-note consent', () => catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider({ dataNote: 'Prompts transit OpenRouter.' })), false, 400],
    ['an unverified model', () => { reg.compat = byok({ legacyDefaultModel: 'claude-haiku-4-5' }); catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider()); }, true, 409],
    ['catalog selection disabled', () => { catalogState.catalogEnabled = false; }, true, 409],
  ] as const)('rejects %s without probing or writing', async (_why, arrange, ack, status) => {
    reg.compat = byok();
    arrange();
    await expect(select(CATALOG_ENTRY_ID, ack)).rejects.toMatchObject({ name: 'PartnerLlmError', status });
    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(writesIssued()).toEqual([]);
  });

  it('does not require consent when the active revision carries no data note', async () => {
    reg.compat = byok();
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider({ dataNote: null }));
    await expect(select(CATALOG_ENTRY_ID, false)).resolves.toMatchObject({ catalogEntryId: CATALOG_ENTRY_ID, configVersion: 5 });
  });

  it.each([
    [new anthropicState.apiErrorClass('rejected', 401), 400],
    [new LlmEgressViolationError('blocked'), 503],
  ])('probes the selected endpoint through the guarded client and writes nothing on probe failure', async (error, status) => {
    reg.compat = byok();
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    anthropicState.create.mockRejectedValue(error);
    await expect(select(CATALOG_ENTRY_ID)).rejects.toMatchObject({ name: 'PartnerLlmError', status });
    expect(buildGuardedLlmFetch).toHaveBeenCalledWith(expect.objectContaining({ allowedOrigin: 'https://openrouter.ai' }));
    expect(writesIssued()).toEqual([]);
  });

  // #7587: a catalog revision only serves the models it mapped AND verified,
  // so the selection pins the model just validated.
  it('direct → catalog switches kind with the same key, pinning the validated model; returns slug + revision', async () => {
    reg.compat = byok({ legacyDefaultModel: null });
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    await expect(select(CATALOG_ENTRY_ID)).resolves.toEqual({ catalogEntryId: CATALOG_ENTRY_ID, configVersion: 5, slug: 'openrouter', revision: 3 });
    expect(remap.switchCompatKind).toHaveBeenCalledWith(PARTNER_ID, {
      kind: 'catalog', apiKey: API_KEY, catalogEntryId: CATALOG_ENTRY_ID, defaultModel: 'claude-sonnet-4-6',
    });
    expect(anthropicState.create).toHaveBeenCalledWith({ model: 'anthropic/claude-sonnet-4-6', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
  });

  it('catalog → another catalog entry edits the connection in place', async () => {
    reg.compat = catalogConn();
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    await select(CATALOG_ENTRY_ID);
    expect(remap.setCompatCatalogEntry).toHaveBeenCalledWith(PARTNER_ID, { catalogEntryId: CATALOG_ENTRY_ID, pinnedModel: 'claude-sonnet-4-6' });
    expect(writesIssued()).toEqual(['setCompatCatalogEntry']);
  });

  it('refuses (409) when the connection was replaced between validation and the write', async () => {
    reg.compat = byok();
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    remap.lockCompatConnection.mockResolvedValueOnce({ ...byok({ id: 'replaced' }), configVersion: 1, connectedBy: null, verifiedAt: null });
    await expect(select(CATALOG_ENTRY_ID)).rejects.toMatchObject({ status: 409 });
    expect(writesIssued()).toEqual([]);
  });
});

describe('authority flip (#7601 Task 6B): registry-native writes, never a re-projection', () => {
  const everyWrite = async () => {
    reg.compat = byok();
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID });
    await updatePartnerLlmEndpoint({ partnerId: PARTNER_ID, catalogEntryId: CATALOG_ENTRY_ID, acknowledgeDataNote: true, userId: USER_ID });
    await updatePartnerLlmEndpoint({ partnerId: PARTNER_ID, catalogEntryId: null, acknowledgeDataNote: false, userId: USER_ID });
    await deletePartnerLlmConfig(PARTNER_ID);
  };

  it('no write path ever calls the legacy projection', async () => {
    await everyWrite();
    expect(writesIssued().length).toBeGreaterThan(0);
    expect(legacy.reconcile).not.toHaveBeenCalled();
  });

  it('every write is gated on the cutover, then probes outside the transaction, then locks, then writes', async () => {
    reg.compat = byok();
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    await updatePartnerLlmEndpoint({ partnerId: PARTNER_ID, catalogEntryId: CATALOG_ENTRY_ID, acknowledgeDataNote: true, userId: USER_ID });
    expect(order).toEqual(['gate', 'probe', 'lock', 'switchCompatKind']);
    order.length = 0;
    await deletePartnerLlmConfig(PARTNER_ID);
    expect(order).toEqual(['gate', 'lock', 'disconnectCompat']);
  });

  it('a partner that cannot be cut over now gets a retryable 503 on every write, and nothing is probed or written', async () => {
    reg.cutOver = false;
    reg.compat = byok();
    const writes = [
      () => savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }),
      () => updatePartnerLlmEndpoint({ partnerId: PARTNER_ID, catalogEntryId: null, acknowledgeDataNote: false, userId: USER_ID }),
      () => deletePartnerLlmConfig(PARTNER_ID),
    ];
    for (const write of writes) await expect(write()).rejects.toMatchObject({ name: 'PartnerLlmError', status: 503 });
    expect(anthropicState.create).not.toHaveBeenCalled();
    expect(legacy.lock).not.toHaveBeenCalled();
    expect(writesIssued()).toEqual([]);
  });

  it('the in-transaction cutover re-check (RegistryNotCutOverError) also maps to 503; a vanished connection to 409', async () => {
    remap.disconnectCompat.mockRejectedValueOnce(new RegistryNotCutOverError(PARTNER_ID));
    await expect(deletePartnerLlmConfig(PARTNER_ID)).rejects.toMatchObject({ status: 503 });
    reg.compat = byok();
    remap.rotateCompatKey.mockRejectedValueOnce(new CompatConnectionMissingError());
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID })).rejects.toMatchObject({ status: 409 });
  });

  // createConnection's insert can fail with a DrizzleQueryError whose message
  // and params carry the key ciphertext and fingerprint: never surfaced.
  it('maps a raw unique violation inside the write (e.g. the connection insert) to a safe 409 that keeps only the SQLSTATE', async () => {
    const pgCause = Object.assign(new Error('duplicate key value violates unique constraint "partner_ai_connections_compat_uq"'), {
      code: '23505',
      detail: 'Key (api_key_encrypted)=(enc:v3:SECRET-CIPHERTEXT) already exists.',
    });
    class DrizzleQueryError extends Error {}
    const drizzleError = Object.assign(
      new DrizzleQueryError('Failed query: insert into "partner_ai_connections" params: enc:v3:SECRET-CIPHERTEXT,fp1:SECRET-FINGERPRINT'),
      { cause: pgCause, params: ['enc:v3:SECRET-CIPHERTEXT', 'fp1:SECRET-FINGERPRINT'] },
    );
    remap.connectCompat.mockRejectedValueOnce(drizzleError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const error = await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }).catch((e: unknown) => e) as PartnerLlmError;
      expect(error).toBeInstanceOf(PartnerLlmError);
      expect(error).toMatchObject({ status: 409, message: 'The AI provider configuration changed. Reload and try again.' });
      expect((error.cause as { code?: unknown }).code).toBe('23505');
      const surfaces = [
        inspect(error, { showHidden: true, depth: 10 }),
        ...consoleError.mock.calls.map((args) => args.map((a) => inspect(a, { showHidden: true, depth: 10 })).join(' ')),
      ].join('\n');
      expect(surfaces).not.toContain('SECRET');
      expect(surfaces).not.toContain(API_KEY);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps the primary Postgres message (no values) on the sanitized cause', async () => {
    class PostgresError extends Error {}
    const pgError = Object.assign(new PostgresError('deadlock detected'), {
      code: '40P01',
      parameters: ['enc:v3:SECRET-CIPHERTEXT'],
      query: 'update partner_ai_connections ... SECRET',
    });
    reg.compat = byok();
    remap.rotateCompatKey.mockRejectedValueOnce(pgError);
    const error = await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }).catch((e: unknown) => e) as PartnerLlmError;
    expect(error).toBeInstanceOf(PartnerLlmError);
    const cause = error.cause as Error & { code?: unknown };
    expect(cause.code).toBe('40P01');
    expect(cause.message).toContain('deadlock detected');
    expect(inspect(error, { showHidden: true, depth: 10 })).not.toContain('SECRET');
  });

  // BD-5 (#7602): createConnection throws an already-scrubbed RegistryWriteError
  // (no query values). The facade still answers with a PartnerLlmError so the
  // /ai/provider routes keep returning a mapped status, never the global 500.
  it.each([
    ['conflict', 409, 409],
    ['stale_write', 409, 409],
    ['invalid', 422, 500],
    ['not_found', 404, 500],
    ['write_failed', 500, 500],
  ] as const)('maps a RegistryWriteError %s (%i) to a PartnerLlmError %i with a safe message', async (code, status, expected) => {
    const scrubbedCause = Object.assign(new Error('AI model registry write failed: Error (SQLSTATE 23505)'), { code: '23505' });
    const registryError = new RegistryWriteError('enc:v3:SECRET-CIPHERTEXT', code, status);
    registryError.cause = scrubbedCause;
    remap.connectCompat.mockRejectedValueOnce(registryError);
    const error = await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }).catch((e: unknown) => e) as PartnerLlmError;
    expect(error).toBeInstanceOf(PartnerLlmError);
    expect(error.status).toBe(expected);
    expect(error.message).toBe(expected === 409
      ? 'The AI provider configuration changed. Reload and try again.'
      : 'Could not save the AI provider configuration.');
    expect(error.cause).toBe(scrubbedCause);
    expect(inspect(error, { showHidden: true, depth: 10 })).not.toContain('SECRET');
  });

  it('a key that cannot be sealed maps to a 500 without the key', async () => {
    const { ConnectionKeyError } = await import('./aiModels/connections');
    remap.connectCompat.mockRejectedValueOnce(new ConnectionKeyError('Could not encrypt the connection key.', 'key_rejected'));
    const error = await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'PartnerLlmError', status: 500 });
    expect(inspect(error, { showHidden: true, depth: 10 })).not.toContain(API_KEY);
  });

  it('surfaces a non-query error from a remap with its message and stack intact', async () => {
    reg.compat = byok();
    const bug = new Error('remap: x');
    remap.rotateCompatKey.mockRejectedValueOnce(bug);
    const error = await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID }).catch((e: unknown) => e);
    expect(error).toBe(bug);
    expect((error as Error).stack).toContain('remap: x');
  });
});

describe('connection discovery triggers (#7601 Task 16, spec §6: on connect and on key/endpoint rotation)', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const enqueuedAfterWrite = (write: (typeof WRITES)[number]) => {
    expect(discovery.enqueue.mock.invocationCallOrder[0]!).toBeGreaterThan(remap[write].mock.invocationCallOrder[0]!);
  };

  it('a first key enqueues discovery for the NEW connection, after the write', async () => {
    await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID });
    await vi.waitFor(() => expect(discovery.enqueue).toHaveBeenCalledWith('new-conn'));
    enqueuedAfterWrite('connectCompat');
  });

  it('a key rotation enqueues discovery for the rotated connection', async () => {
    reg.compat = byok();
    await savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID });
    await vi.waitFor(() => expect(discovery.enqueue).toHaveBeenCalledWith(CONFIG_ID));
    enqueuedAfterWrite('rotateCompatKey');
  });

  it('a kind switch (direct → catalog, catalog → direct) enqueues discovery for the replacement connection', async () => {
    remap.switchCompatKind.mockResolvedValue({ connectionId: 'switched-conn', configVersion: 5 });
    reg.compat = byok();
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    await updatePartnerLlmEndpoint({ partnerId: PARTNER_ID, catalogEntryId: CATALOG_ENTRY_ID, acknowledgeDataNote: true, userId: USER_ID });
    await vi.waitFor(() => expect(discovery.enqueue).toHaveBeenCalledWith('switched-conn'));
    discovery.enqueue.mockClear();
    reg.compat = catalogConn();
    await updatePartnerLlmEndpoint({ partnerId: PARTNER_ID, catalogEntryId: null, acknowledgeDataNote: false, userId: USER_ID });
    await vi.waitFor(() => expect(discovery.enqueue).toHaveBeenCalledWith('switched-conn'));
  });

  it('a different catalog entry on the same connection enqueues discovery for it', async () => {
    reg.compat = catalogConn();
    catalogState.getListedProviderByEntryId.mockResolvedValue(listedProvider());
    await updatePartnerLlmEndpoint({ partnerId: PARTNER_ID, catalogEntryId: CATALOG_ENTRY_ID, acknowledgeDataNote: true, userId: USER_ID });
    await vi.waitFor(() => expect(discovery.enqueue).toHaveBeenCalledWith(CONFIG_ID));
    enqueuedAfterWrite('setCompatCatalogEntry');
  });

  it('edits that change no key or endpoint, disconnects and refused writes enqueue nothing', async () => {
    reg.compat = byok();
    await updatePartnerLlmEndpoint({ partnerId: PARTNER_ID, catalogEntryId: null, acknowledgeDataNote: false, userId: USER_ID });
    await deletePartnerLlmConfig(PARTNER_ID);
    remap.lockCompatConnection.mockResolvedValueOnce({ ...catalogConn(), configVersion: 9, connectedBy: null, verifiedAt: null });
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID })).rejects.toMatchObject({ status: 409 });
    await flush();
    expect(discovery.enqueue).not.toHaveBeenCalled();
  });

  it('a failed enqueue (Redis down) never fails the committed save', async () => {
    discovery.enqueue.mockRejectedValue(new Error('redis down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(savePartnerLlmKey({ partnerId: PARTNER_ID, apiKey: API_KEY, userId: USER_ID })).resolves.toMatchObject({ configVersion: 1 });
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(inspect(errors.mock.calls)).not.toContain(API_KEY);
    errors.mockRestore();
  });
});
