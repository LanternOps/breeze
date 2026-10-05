/**
 * #6473 — Max Turns Per Session (org/partner configured via
 * `getEffectiveAiBudget`) was never wired into the `ai_sessions` row at
 * creation time, so every new session silently fell back to the Drizzle
 * schema column default of 50 regardless of what was configured.
 *
 * Mirrors the mock harness of aiAgent.pageContextOrg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const getEffectiveAiBudgetMock = vi.fn();
const withSystemDbAccessContextMock = vi.fn((fn: () => unknown) => fn());

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
  withSystemDbAccessContext: (fn: () => unknown) => withSystemDbAccessContextMock(fn),
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id', orgId: 'aiSessions.orgId' },
  aiMessages: { sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: {
    id: 'aiToolExecutions.id',
    sessionId: 'aiToolExecutions.sessionId',
    status: 'aiToolExecutions.status',
  },
  delegantM365Connections: {
    id: 'delegantM365Connections.id',
    orgId: 'delegantM365Connections.orgId',
    status: 'delegantM365Connections.status',
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
}));

vi.mock('./aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }));
vi.mock('./aiToolIndex', () => ({ composeStaticSystemPrompt: () => 'base\nindex\ntail' }));
vi.mock('./aiAgentSdkTools', () => ({ listChatSurfaceToolNames: () => [] }));
vi.mock('./brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn().mockResolvedValue([]) }));
vi.mock('./llm/llmConfigResolver', () => ({
  LlmUnavailableError: class LlmUnavailableError extends Error {},
}));
vi.mock('./effectiveSettings', () => ({
  getEffectiveAiBudget: (...args: unknown[]) => getEffectiveAiBudgetMock(...args),
}));

// W03 Task 9 (#7601): createSession picks its model through the registry.
vi.mock('./aiModels/candidateLoader', () => ({ readOrgPartnerId: vi.fn(async () => 'partner-1') }));
vi.mock('./aiModels/sessionModel', () => ({
  chooseSessionModel: vi.fn(async () => ({
    offeringId: 'off-1', offeringPartnerId: 'partner-1', options: null,
    model: 'claude-sonnet-4-6', billingSource: 'platform',
  })),
}));

import { createSession } from './aiAgent';

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';

function orgAuth(overrides: Record<string, unknown> = {}): any {
  return {
    scope: 'organization',
    user: { id: 'user-2' },
    orgId: ORG_A,
    accessibleOrgIds: [ORG_A],
    canAccessOrg: (id: string) => id === ORG_A,
    orgCondition: () => undefined,
    ...overrides,
  };
}

function expectInsert() {
  const valuesSpy = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) });
  insertMock.mockReturnValueOnce({ values: valuesSpy });
  return valuesSpy;
}

describe('createSession wires the effective maxTurnsPerSession budget (#6473)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withSystemDbAccessContextMock.mockImplementation((fn: () => unknown) => fn());
  });

  it('sets maxTurns from getEffectiveAiBudget instead of leaving it to the schema default', async () => {
    getEffectiveAiBudgetMock.mockResolvedValue({ maxTurnsPerSession: 100 });
    const valuesSpy = expectInsert();

    await createSession(orgAuth(), {});

    expect(getEffectiveAiBudgetMock).toHaveBeenCalledWith(ORG_A);
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 100 }));
  });

  it('still passes through the configured value even when it equals the schema default', async () => {
    getEffectiveAiBudgetMock.mockResolvedValue({ maxTurnsPerSession: 50 });
    const valuesSpy = expectInsert();

    await createSession(orgAuth(), {});

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 50 }));
  });
});
