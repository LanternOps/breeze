/**
 * A chat / "Explain this" session must not be created when no model can be
 * called: with no platform key and no partner BYO key the session used to be
 * created anyway, the model turn then ran with no credentials, and the surface
 * showed an empty or "partial" answer. Mirrors the harness of
 * aiAgent.maxTurns.test.ts.
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
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id', orgId: 'aiSessions.orgId' },
  aiMessages: { sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: { id: 'aiToolExecutions.id', sessionId: 'aiToolExecutions.sessionId', status: 'aiToolExecutions.status' },
  delegantM365Connections: { id: 'delegantM365Connections.id', orgId: 'delegantM365Connections.orgId', status: 'delegantM365Connections.status' },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
}));

vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }));
vi.mock('./aiToolIndex', () => ({ composeStaticSystemPrompt: () => 'base\nindex\ntail' }));
vi.mock('./aiAgentSdkTools', () => ({ listChatSurfaceToolNames: () => [] }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn().mockResolvedValue([]) }));
vi.mock('./llm/llmConfigResolver', () => ({
  LlmUnavailableError: class LlmUnavailableError extends Error {},
  resolveLlmConfigForOrg: (...args: unknown[]) => resolveLlmConfigForOrgMock(...args),
}));
vi.mock('./effectiveSettings', () => ({
  getEffectiveAiBudget: (...args: unknown[]) => getEffectiveAiBudgetMock(...args),
}));

import { createSession } from './aiAgent';
import { LlmNotConfiguredError } from './llm/llmAvailability';

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

describe('createSession refuses when no model provider is configured', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    getEffectiveAiBudgetMock.mockResolvedValue({ maxTurnsPerSession: 50 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws LlmNotConfiguredError and writes no session row for a platform config with no key', async () => {
    resolveLlmConfigForOrgMock.mockResolvedValue({ source: 'platform', apiKey: undefined, model: 'claude-sonnet-4-6' });

    await expect(createSession(orgAuth(), {})).rejects.toBeInstanceOf(LlmNotConfiguredError);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('creates the session when the platform key is present', async () => {
    resolveLlmConfigForOrgMock.mockResolvedValue({ source: 'platform', apiKey: 'platform-key', model: 'claude-sonnet-4-6' });
    insertMock.mockReturnValueOnce({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) }) });

    await expect(createSession(orgAuth(), {})).resolves.toMatchObject({ id: 'sess-1', orgId: ORG_A });
  });
});
