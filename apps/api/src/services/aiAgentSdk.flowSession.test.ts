import { beforeEach, describe, expect, it, vi } from 'vitest';

const { attachMock } = vi.hoisted(() => ({ attachMock: vi.fn(async () => undefined) }));
vi.mock('./flows/service', () => ({ attachFlowToChatSession: attachMock }));

import { attachChatFlowToSession } from './aiAgentSdk';

const session = { orgId: 'org-1', breezeSessionId: 'sess-1' };
const FLOW = '33333333-3333-4333-8333-333333333333';

beforeEach(() => { attachMock.mockClear(); });

// Tool Catalog W03 (#5218): draft_flow's handler never sees the session id, so
// the chat post-tool hook back-fills flows.ai_session_id from the
// authenticated session — never from tool input.
describe('attachChatFlowToSession (draft_flow post-tool hook)', () => {
  it('back-fills the session on a saved draft', async () => {
    await attachChatFlowToSession(session, { saved: true, flow: { id: FLOW } });
    expect(attachMock).toHaveBeenCalledWith(FLOW, 'sess-1', 'org-1');
  });

  it('does nothing for an unsaved draft or a malformed id', async () => {
    await attachChatFlowToSession(session, { saved: false, validation: {} });
    await attachChatFlowToSession(session, { saved: true, flow: { id: 'not-a-uuid' } });
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('is best-effort: a DB failure does not propagate', async () => {
    attachMock.mockRejectedValueOnce(new Error('boom'));
    await expect(attachChatFlowToSession(session, { saved: true, flow: { id: FLOW } })).resolves.toBeUndefined();
  });
});
