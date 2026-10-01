/**
 * #7587 — `POST /ai/sessions` accepted a free-form `model` that was never
 * validated, so any chat user could start a session on any model id against
 * the platform key. createSession now validates it server-side:
 *   - platform key / partner direct-Anthropic key → OFFERABLE_AI_MODELS (or
 *     the configured default model itself);
 *   - partner catalog endpoint → the existing resolveWireModel gate.
 * Anything else is an InvalidSessionModelError (400) and writes no row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();
const resolveLlmConfigForOrgMock = vi.fn();
const getEffectiveAiBudgetMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: vi.fn(),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  getCurrentDbAccessContext: () => undefined,
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id', orgId: 'aiSessions.orgId' },
  aiMessages: { sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: { id: 'aiToolExecutions.id', sessionId: 'aiToolExecutions.sessionId', status: 'aiToolExecutions.status' },
  delegantM365Connections: { id: 'delegantM365Connections.id', orgId: 'delegantM365Connections.orgId', status: 'delegantM365Connections.status' },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  partnerLlmConfigs: { partnerId: 'partnerLlmConfigs.partnerId' },
}));

vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }));
vi.mock('./aiToolIndex', () => ({ composeStaticSystemPrompt: () => 'base\nindex\ntail' }));
vi.mock('./aiAgentSdkTools', () => ({ listChatSurfaceToolNames: () => [] }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn().mockResolvedValue([]) }));
// Keep the REAL resolveWireModel (the catalog gate under test); stub only the
// DB-backed config read.
vi.mock('./llm/llmConfigResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm/llmConfigResolver')>();
  return {
    ...actual,
    resolveLlmConfigForOrg: (...args: unknown[]) => resolveLlmConfigForOrgMock(...args),
  };
});
vi.mock('./effectiveSettings', () => ({
  getEffectiveAiBudget: (...args: unknown[]) => getEffectiveAiBudgetMock(...args),
}));

import { createSession, InvalidSessionModelError } from './aiAgent';

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';

function orgAuth(): any {
  return {
    scope: 'organization',
    user: { id: 'user-2' },
    orgId: ORG_A,
    accessibleOrgIds: [ORG_A],
    canAccessOrg: (id: string) => id === ORG_A,
    orgCondition: () => undefined,
  };
}

const PLATFORM = { source: 'platform', apiKey: 'platform-key', model: 'claude-sonnet-5-5' };

const pricing = {
  catalogEntryId: 'entry-1',
  revisionId: 'rev-1',
  inputCentsPerM: 100,
  outputCentsPerM: 200,
  cacheReadCentsPerM: 10,
  cacheWriteCentsPerM: 125,
};

function catalogPartner() {
  const models = Object.create(null);
  models['claude-sonnet-5-5'] = { providerModel: 'anthropic/claude-sonnet-5-5', pricing };
  return {
    source: 'partner',
    partnerId: 'partner-1',
    apiKey: 'partner-key',
    model: 'claude-sonnet-5-5',
    configId: 'cfg-1',
    configVersion: 1,
    endpoint: {
      kind: 'catalog',
      catalogEntryId: 'entry-1',
      revisionId: 'rev-1',
      baseUrl: 'https://gateway.example.com',
      authMode: 'bearer',
      providerModel: 'anthropic/claude-sonnet-5-5',
      pricing,
      models,
    },
  };
}

const PARTNER_DIRECT = {
  source: 'partner',
  partnerId: 'partner-1',
  apiKey: 'partner-key',
  model: 'claude-opus-5-5',
  configId: 'cfg-1',
  configVersion: 1,
  endpoint: { kind: 'anthropic' },
};

let insertedValues: Record<string, unknown> | undefined;

function armInsert() {
  insertMock.mockReturnValueOnce({
    values: vi.fn((v: Record<string, unknown>) => {
      insertedValues = v;
      return { returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) };
    }),
  });
}

describe('createSession validates the requested model (#7587)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues = undefined;
    getEffectiveAiBudgetMock.mockResolvedValue({ maxTurnsPerSession: 50 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'claude-fable-5-1', 'claude-sonnet-4-6'])(
    'platform key: accepts offerable model %s',
    async (model) => {
      resolveLlmConfigForOrgMock.mockResolvedValue(PLATFORM);
      armInsert();
      await expect(createSession(orgAuth(), { model })).resolves.toMatchObject({ id: 'sess-1' });
      expect(insertedValues?.model).toBe(model);
    },
  );

  it.each(['claude-3-opus-20240229', 'claude-sonnet-4-5-20250929', 'gpt-5', 'constructor', '__proto__'])(
    'platform key: rejects non-offerable model %j with no session row',
    async (model) => {
      resolveLlmConfigForOrgMock.mockResolvedValue(PLATFORM);
      await expect(createSession(orgAuth(), { model })).rejects.toBeInstanceOf(InvalidSessionModelError);
      expect(insertMock).not.toHaveBeenCalled();
    },
  );

  it('platform key: accepts the configured default even when it is a self-host ANTHROPIC_MODEL id', async () => {
    resolveLlmConfigForOrgMock.mockResolvedValue({ ...PLATFORM, model: 'my-vllm-model' });
    armInsert();
    await expect(createSession(orgAuth(), { model: 'my-vllm-model' })).resolves.toMatchObject({ id: 'sess-1' });
  });

  it('no model requested: stores the resolved default without validation', async () => {
    resolveLlmConfigForOrgMock.mockResolvedValue({ ...PLATFORM, model: 'my-vllm-model' });
    armInsert();
    await createSession(orgAuth(), {});
    expect(insertedValues?.model).toBe('my-vllm-model');
  });

  it('partner catalog: accepts a model the pinned revision maps and verified', async () => {
    resolveLlmConfigForOrgMock.mockResolvedValue(catalogPartner());
    armInsert();
    await expect(createSession(orgAuth(), { model: 'claude-sonnet-5-5' })).resolves.toMatchObject({ id: 'sess-1' });
    // The logical id is stored; the wire id is only resolved at dispatch.
    expect(insertedValues?.model).toBe('claude-sonnet-5-5');
  });

  it('partner catalog: rejects an offerable model the revision does not map', async () => {
    resolveLlmConfigForOrgMock.mockResolvedValue(catalogPartner());
    await expect(createSession(orgAuth(), { model: 'claude-opus-5-5' })).rejects.toBeInstanceOf(InvalidSessionModelError);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('partner direct Anthropic key: offerable accepted, arbitrary id rejected', async () => {
    resolveLlmConfigForOrgMock.mockResolvedValue(PARTNER_DIRECT);
    armInsert();
    await expect(createSession(orgAuth(), { model: 'claude-haiku-4-5' })).resolves.toMatchObject({ id: 'sess-1' });
    await expect(createSession(orgAuth(), { model: 'claude-made-up-9' })).rejects.toBeInstanceOf(InvalidSessionModelError);
  });

  it('InvalidSessionModelError carries a 400 status', () => {
    expect(new InvalidSessionModelError('x').status).toBe(400);
  });
});
