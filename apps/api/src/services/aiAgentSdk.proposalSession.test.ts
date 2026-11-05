import { beforeEach, describe, expect, it, vi } from 'vitest';

const { attachMock, resolveOrgMock, contextMock } = vi.hoisted(() => ({
  attachMock: vi.fn(async () => true),
  resolveOrgMock: vi.fn(async (_id: string, canAccessOrg: (orgId: string) => boolean): Promise<string | null> =>
    (canAccessOrg('org-1') ? 'org-1' : null)),
  contextMock: vi.fn(),
}));
vi.mock('./scriptProposals', () => ({
  attachProposalToSession: attachMock,
  resolveProposalOrgInReach: resolveOrgMock,
  loadProposalGuardrailContext: async () => undefined,
  loadProposalGuardrailContextInReach: async () => ({ context: undefined, proposalOrgId: null }),
}));
vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  withDbAccessContext: async <T,>(ctx: unknown, fn: () => Promise<T>) => { contextMock(ctx); return fn(); },
}));

import { attachChatProposalToSession } from './aiAgentSdk';

const reach = (...orgIds: string[]) => ({ canAccessOrg: (orgId: string) => orgIds.includes(orgId) });
const session = { orgId: 'org-1', breezeSessionId: 'sess-1', toolAuth: reach('org-1') } as never;

beforeEach(() => {
  attachMock.mockClear();
  resolveOrgMock.mockClear();
  contextMock.mockClear();
});

describe('attachChatProposalToSession (propose_script post-tool hook)', () => {
  it('back-fills session_id, org-scoped, from the tool output proposalId', async () => {
    await attachChatProposalToSession(session, { proposalId: 'p1', status: 'proposed' });
    expect(attachMock).toHaveBeenCalledWith('p1', 'org-1', 'sess-1');
  });

  // #10384: propose_script files the proposal under the TARGET DEVICE's org. A
  // partner-scope session bound to org-1 that proposed against a device in
  // org-2 must still be attributed — under org-2, in org-2's DB context.
  it('attributes a proposal filed in another org the session can reach, under THAT org', async () => {
    resolveOrgMock.mockResolvedValueOnce('org-2');
    const partnerSession = { orgId: 'org-1', breezeSessionId: 'sess-1', toolAuth: reach('org-1', 'org-2') } as never;

    await attachChatProposalToSession(partnerSession, { proposalId: 'p2', status: 'reviewed' });

    expect(resolveOrgMock).toHaveBeenCalledWith('p2', expect.any(Function));
    const canAccessOrg = resolveOrgMock.mock.calls[0]![1];
    expect(canAccessOrg('org-2')).toBe(true);
    expect(canAccessOrg('org-9')).toBe(false);
    expect(attachMock).toHaveBeenCalledWith('p2', 'org-2', 'sess-1');
    expect(contextMock).toHaveBeenCalledWith({ scope: 'organization', orgId: 'org-2', accessibleOrgIds: ['org-2'] });
  });

  it('does not attribute a proposal outside the session reach', async () => {
    resolveOrgMock.mockResolvedValueOnce(null);
    await attachChatProposalToSession(session, { proposalId: 'p3' });
    expect(attachMock).not.toHaveBeenCalled();
  });

  it('does nothing when the output carries no proposal id', async () => {
    await attachChatProposalToSession(session, { error: 'invalid_input' });
    expect(attachMock).not.toHaveBeenCalled();
    expect(resolveOrgMock).not.toHaveBeenCalled();
  });

  it('is best-effort: a DB failure does not propagate into the tool_result path', async () => {
    attachMock.mockRejectedValueOnce(new Error('boom'));
    await expect(attachChatProposalToSession(session, { proposalId: 'p1' })).resolves.toBeUndefined();
  });
});
