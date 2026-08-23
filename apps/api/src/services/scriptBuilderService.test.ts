import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock } = vi.hoisted(() => ({ insertMock: vi.fn() }));

vi.mock('../db', () => ({ db: { insert: insertMock } }));
vi.mock('../db/schema', () => ({ aiSessions: {}, aiMessages: {} }));
vi.mock('./scriptBuilderPrompt', () => ({ buildScriptBuilderSystemPrompt: vi.fn(() => 'prompt') }));

import { createScriptBuilderSession } from './scriptBuilderService';

describe('createScriptBuilderSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists the model resolved for the authenticated partner instead of a hardcoded default', async () => {
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
});
