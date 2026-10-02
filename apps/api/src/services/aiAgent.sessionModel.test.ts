/**
 * Session creation picks its model through the registry (W03 Task 9, #7601;
 * replaces W00's #7587 free-form `model` validation). createSession stores
 * exactly what `chooseSessionModel` resolved — offering, its partner, the
 * user's options, the logical model snapshot and the offering's funding — and
 * writes no row when the choice is refused.
 *
 * W06: an env OpenAI-compatible deployment creates through the registry too
 * (its env-managed offering); there is no legacy creation branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();
const getEffectiveAiBudgetMock = vi.fn();
const readOrgPartnerIdMock = vi.fn();
const getConfigMock = vi.fn();
const sm = vi.hoisted(() => ({ chooseSessionModel: vi.fn() }));

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

vi.mock('../config/validate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/validate')>()),
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}));
vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }));
vi.mock('./aiToolIndex', () => ({ composeStaticSystemPrompt: () => 'base\nindex\ntail' }));
vi.mock('./aiAgentSdkTools', () => ({ listChatSurfaceToolNames: () => [] }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn().mockResolvedValue([]) }));
vi.mock('./effectiveSettings', () => ({
  getEffectiveAiBudget: (...args: unknown[]) => getEffectiveAiBudgetMock(...args),
}));
vi.mock('./aiModels/candidateLoader', () => ({
  readOrgPartnerId: (...args: unknown[]) => readOrgPartnerIdMock(...args),
}));
vi.mock('./aiModels/sessionModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiModels/sessionModel')>()),
  chooseSessionModel: sm.chooseSessionModel,
}));

import { createSession, InvalidSessionModelError } from './aiAgent';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { LlmNotConfiguredError, PLATFORM_LLM_CREDENTIAL_ENV_KEYS } from './llm/llmAvailability';
import { LlmUnavailableError } from './llm/llmConfigResolver';

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const OFFERING = 'bbbbbbbb-1111-4222-8333-444455556666';

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

let insertedValues: Record<string, unknown> | undefined;

function armInsert() {
  insertMock.mockReturnValueOnce({
    values: vi.fn((v: Record<string, unknown>) => {
      insertedValues = v;
      return { returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) };
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues = undefined;
  getEffectiveAiBudgetMock.mockResolvedValue({ maxTurnsPerSession: 50 });
  readOrgPartnerIdMock.mockResolvedValue('partner-1');
  // Unvalidated config (the unit default).
  getConfigMock.mockImplementation(() => { throw new Error('config not validated'); });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createSession stores the registry choice (W03 Task 9)', () => {
  const choice = {
    resolved: makeResolvedModel('anthropic_byok'),
    offeringId: OFFERING,
    offeringPartnerId: 'partner-1',
    options: { effort: 'high' as const },
    model: 'claude-sonnet-5-5',
    billingSource: 'partner_key' as const,
  };

  it('inserts offering, offering partner, options, model and funding from chooseSessionModel', async () => {
    sm.chooseSessionModel.mockResolvedValue(choice);
    armInsert();
    await expect(createSession(orgAuth(), { offeringId: OFFERING, options: { effort: 'high' } }))
      .resolves.toMatchObject({ id: 'sess-1' });
    expect(sm.chooseSessionModel).toHaveBeenCalledWith({
      partnerId: 'partner-1', orgId: ORG_A, userId: 'user-2', surface: 'chat',
      offeringId: OFFERING, options: { effort: 'high' },
    });
    expect(insertedValues).toMatchObject({
      offeringId: OFFERING, offeringPartnerId: 'partner-1', options: { effort: 'high' },
      model: 'claude-sonnet-5-5', billingSource: 'partner_key',
    });
  });

  it('passes no legacyModel to chooseSessionModel (W05 removed the free-form model)', async () => {
    sm.chooseSessionModel.mockResolvedValue(choice);
    armInsert();
    await createSession(orgAuth(), {});
    expect(sm.chooseSessionModel).toHaveBeenCalledWith({
      partnerId: 'partner-1', orgId: ORG_A, userId: 'user-2', surface: 'chat',
    });
  });

  it('propagates InvalidSessionModelError and writes no row', async () => {
    sm.chooseSessionModel.mockRejectedValue(new InvalidSessionModelError('This AI model is not available here. Choose another model.', 'not_permitted'));
    await expect(createSession(orgAuth(), { offeringId: OFFERING })).rejects.toMatchObject({
      name: 'InvalidSessionModelError', status: 400, code: 'not_permitted',
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('an org with no partner has no registry to resolve: ai_unavailable, no row', async () => {
    readOrgPartnerIdMock.mockResolvedValue(null);
    await expect(createSession(orgAuth(), {})).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(sm.chooseSessionModel).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('propagates the 503 shapes (not configured / unavailable) with no row', async () => {
    sm.chooseSessionModel.mockRejectedValueOnce(new LlmNotConfiguredError());
    await expect(createSession(orgAuth(), {})).rejects.toBeInstanceOf(LlmNotConfiguredError);
    sm.chooseSessionModel.mockRejectedValueOnce(new LlmUnavailableError());
    await expect(createSession(orgAuth(), {})).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('env OpenAI-compatible deployment (W06: one runtime)', () => {
  beforeEach(() => {
    getConfigMock.mockReturnValue({ MCP_LLM_PROVIDER: 'openai-compatible' });
    for (const key of PLATFORM_LLM_CREDENTIAL_ENV_KEYS) vi.stubEnv(key, '');
  });

  it('creates through the registry like any deployment: the env-managed offering, its funding, no legacy branch', async () => {
    const envChoice = {
      resolved: makeResolvedModel('openai_compatible'),
      offeringId: OFFERING,
      offeringPartnerId: 'partner-1',
      options: null,
      model: 'qwen',
      billingSource: 'partner_key' as const,
    };
    sm.chooseSessionModel.mockResolvedValue(envChoice);
    armInsert();
    await expect(createSession(orgAuth(), {})).resolves.toMatchObject({ id: 'sess-1' });
    expect(sm.chooseSessionModel).toHaveBeenCalledWith({ partnerId: 'partner-1', orgId: ORG_A, userId: 'user-2', surface: 'chat' });
    expect(insertedValues).toMatchObject({
      offeringId: OFFERING, offeringPartnerId: 'partner-1', model: 'qwen', billingSource: 'partner_key',
    });
  });

  it('a model choice is a registry choice there too (no blanket invalid_model refusal)', async () => {
    sm.chooseSessionModel.mockResolvedValue({
      resolved: makeResolvedModel('openai_compatible'), offeringId: OFFERING, offeringPartnerId: 'partner-1',
      options: null, model: 'qwen', billingSource: 'partner_key' as const,
    });
    armInsert();
    await expect(createSession(orgAuth(), { offeringId: OFFERING })).resolves.toMatchObject({ id: 'sess-1' });
    expect(sm.chooseSessionModel).toHaveBeenCalledWith(expect.objectContaining({ offeringId: OFFERING }));
  });
});
