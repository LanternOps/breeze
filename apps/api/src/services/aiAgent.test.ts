import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn()
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn()
    };
  }
}));

vi.mock('../db', () => ({
  db: {
    select: selectMock,
    insert: vi.fn(),
    update: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  aiSessions: {
    id: 'aiSessions.id',
    orgId: 'aiSessions.orgId'
  },
  aiMessages: {},
  aiToolExecutions: {}
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  desc: vi.fn((...args: unknown[]) => ({ type: 'desc', args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    type: 'sql',
    text: strings.join('?'),
    values
  }))
}));

vi.mock('./aiTools', () => ({
  getToolDefinitions: vi.fn(() => []),
  executeTool: vi.fn()
}));

vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn()
}));

vi.mock('./aiGuardrails', () => ({
  checkGuardrails: vi.fn(),
  checkToolPermission: vi.fn(),
  checkToolRateLimit: vi.fn()
}));

vi.mock('./aiCostTracker', () => ({
  checkBudget: vi.fn(),
  checkAiRateLimit: vi.fn(),
  recordUsage: vi.fn(),
  calculateCostCents: vi.fn()
}));

vi.mock('./aiInputSanitizer', () => ({
  sanitizeUserMessage: vi.fn((input: string) => ({ sanitized: input, flags: [] })),
  sanitizePageContext: vi.fn((ctx: unknown) => ctx)
}));

vi.mock('../utils/sql', () => ({
  escapeLike: vi.fn((v: string) => v)
}));

import { sendMessage } from './aiAgent';
import { checkAiRateLimit, checkBudget } from './aiCostTracker';

function createSelectLimit(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  };
}

describe('aiAgent.sendMessage org context checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the session org for rate-limit checks', async () => {
    selectMock.mockReturnValueOnce(createSelectLimit([{
      id: 'session-1',
      orgId: 'org-session',
      status: 'active',
      turnCount: 0,
      maxTurns: 10,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      systemPrompt: null
    }]) as any);
    vi.mocked(checkAiRateLimit).mockResolvedValue('Rate limit hit');

    const auth = {
      user: { id: 'user-1', email: 'u@example.com', name: 'User' },
      token: { sub: 'user-1' } as any,
      orgId: 'org-auth',
      partnerId: 'partner-1',
      scope: 'organization',
      accessibleOrgIds: ['org-auth'],
      orgCondition: vi.fn(() => undefined),
      canAccessOrg: vi.fn(() => true)
    } as any;

    const generator = sendMessage('session-1', 'hello', auth);
    const first = await generator.next();

    expect(first.value).toEqual({ type: 'error', message: 'Rate limit hit' });
    expect(vi.mocked(checkAiRateLimit)).toHaveBeenCalledWith('user-1', 'org-session');
    expect(vi.mocked(checkBudget)).not.toHaveBeenCalled();
  });

  it('uses the session org for budget checks', async () => {
    selectMock.mockReturnValueOnce(createSelectLimit([{
      id: 'session-2',
      orgId: 'org-session-2',
      status: 'active',
      turnCount: 0,
      maxTurns: 10,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      systemPrompt: null
    }]) as any);
    vi.mocked(checkAiRateLimit).mockResolvedValue(null);
    vi.mocked(checkBudget).mockResolvedValue('Budget exceeded');

    const auth = {
      user: { id: 'user-1', email: 'u@example.com', name: 'User' },
      token: { sub: 'user-1' } as any,
      orgId: 'org-auth',
      partnerId: 'partner-1',
      scope: 'organization',
      accessibleOrgIds: ['org-auth'],
      orgCondition: vi.fn(() => undefined),
      canAccessOrg: vi.fn(() => true)
    } as any;

    const generator = sendMessage('session-2', 'hello', auth);
    const first = await generator.next();

    expect(first.value).toEqual({ type: 'error', message: 'Budget exceeded' });
    expect(vi.mocked(checkBudget)).toHaveBeenCalledWith('org-session-2');
  });
});
