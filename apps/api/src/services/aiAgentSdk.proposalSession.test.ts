import { beforeEach, describe, expect, it, vi } from 'vitest';

const { attachMock } = vi.hoisted(() => ({ attachMock: vi.fn(async () => true) }));
vi.mock('./scriptProposals', () => ({
  attachProposalToSession: attachMock,
  loadProposalGuardrailContext: async () => undefined,
}));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  withDbAccessContext: async <T,>(_ctx: unknown, fn: () => Promise<T>) => fn(),
}));

import { attachChatProposalToSession } from './aiAgentSdk';

const session = { orgId: 'org-1', breezeSessionId: 'sess-1' };

beforeEach(() => { attachMock.mockClear(); });

describe('attachChatProposalToSession (propose_script post-tool hook)', () => {
  it('back-fills session_id, org-scoped, from the tool output proposalId', async () => {
    await attachChatProposalToSession(session, { proposalId: 'p1', status: 'proposed' });
    expect(attachMock).toHaveBeenCalledWith('p1', 'org-1', 'sess-1');
  });

  it('does nothing when the output carries no proposal id', async () => {
    await attachChatProposalToSession(session, { error: 'invalid_input' });
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('is best-effort: a DB failure does not propagate into the tool_result path', async () => {
    attachMock.mockRejectedValueOnce(new Error('boom'));
    await expect(attachChatProposalToSession(session, { proposalId: 'p1' })).resolves.toBeUndefined();
  });
});
