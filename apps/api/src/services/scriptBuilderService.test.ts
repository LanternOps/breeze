import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock, getEffectiveAiBudgetMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  getEffectiveAiBudgetMock: vi.fn().mockResolvedValue({ maxTurnsPerSession: 50 }),
}));

vi.mock('../db', () => ({
  db: { insert: insertMock },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../db/schema', () => ({ aiSessions: {}, aiMessages: {} }));
vi.mock('./scriptBuilderPrompt', () => ({ buildScriptBuilderSystemPrompt: vi.fn(() => 'prompt') }));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: getEffectiveAiBudgetMock }));

import { createScriptBuilderSession } from './scriptBuilderService';

describe('createScriptBuilderSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists the model resolved for the authenticated partner instead of a hardcoded default', async () => {
    getEffectiveAiBudgetMock.mockResolvedValue({ maxTurnsPerSession: 50 });
    const values = vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ id: 'session-1', orgId: 'org-1' }])),
    }));
    insertMock.mockReturnValue({ values });

    await createScriptBuilderSession(
      {
        orgId: 'org-1',
        accessibleOrgIds: ['org-1'],
        user: { id: 'user-1' },
      } as any,
      { title: 'Builder' },
      'claude-opus-4-6',
    );

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-4-6' }));
  });

  // #6473 — script builder sessions run through the same runPreFlightChecks
  // turn-limit enforcement as regular chat sessions, so they must also
  // inherit the configured maxTurnsPerSession rather than the schema default.
  it('sets maxTurns from the effective org/partner budget, not the schema default', async () => {
    getEffectiveAiBudgetMock.mockResolvedValue({ maxTurnsPerSession: 100 });
    const values = vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([{ id: 'session-1', orgId: 'org-1' }])),
    }));
    insertMock.mockReturnValue({ values });

    await createScriptBuilderSession(
      {
        orgId: 'org-1',
        accessibleOrgIds: ['org-1'],
        user: { id: 'user-1' },
      } as any,
      { title: 'Builder' },
      'claude-opus-4-6',
    );

    expect(getEffectiveAiBudgetMock).toHaveBeenCalledWith('org-1');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 100 }));
  });
});
