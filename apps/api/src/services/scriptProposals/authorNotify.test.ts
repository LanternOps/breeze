import { describe, expect, it, vi, beforeEach } from 'vitest';

const insertValues = vi.fn();
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: { insert: () => ({ values: (v: unknown) => insertValues(v) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
const publish = vi.fn();
const getSession = vi.fn();
vi.mock('../streamingSessionManager', () => ({
  streamingSessionManager: { get: (...a: unknown[]) => getSession(...a) },
}));
const createNotification = vi.fn();
vi.mock('../userNotifications', () => ({ createNotification: (...a: unknown[]) => createNotification(...a) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { postProposalOutcomeToAuthor, renderAuthorMessage } from './authorNotify';

const proposal = {
  id: '44444444-4444-4444-8444-444444444444',
  orgId: '11111111-1111-4111-8111-111111111111',
  authorKind: 'chat_session' as const,
  sessionId: '55555555-5555-4555-8555-555555555555',
  agentRunId: null,
  requestedByUserId: '22222222-2222-4222-8222-222222222222',
};

beforeEach(() => { vi.clearAllMocks(); getSession.mockReturnValue({ eventBus: { publish } }); });

describe('renderAuthorMessage', () => {
  it('names the note and every finding for changes_requested', () => {
    const text = renderAuthorMessage(proposal.id, {
      kind: 'changes_requested',
      note: 'Target only the print spooler.',
      findings: [{ severity: 'warning', text: 'Stops every service matching *spool*' }],
    });
    expect(text).toContain('Target only the print spooler.');
    expect(text).toContain('Stops every service matching *spool*');
    expect(text).toContain(proposal.id);
    expect(text).toContain('supersedesProposalId');
  });
});

describe('postProposalOutcomeToAuthor', () => {
  it('writes a durable ai_messages row for a chat author', async () => {
    await postProposalOutcomeToAuthor(proposal, { kind: 'verified', detail: 'Service spooler is running.' });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: proposal.sessionId, role: 'system' }),
    );
  });

  it('publishes to the live session bus when the session is in this process', async () => {
    await postProposalOutcomeToAuthor(proposal, { kind: 'verified', detail: 'ok' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'script_proposal_update', outcome: 'verified' }));
  });

  it('does not throw when the session is owned by another process', async () => {
    getSession.mockReturnValue(undefined);
    await expect(postProposalOutcomeToAuthor(proposal, { kind: 'verified', detail: 'ok' })).resolves.toBeUndefined();
    expect(insertValues).toHaveBeenCalled();
  });

  it('survives a throwing event bus (the DB row is the contract)', async () => {
    publish.mockImplementation(() => { throw new Error('bus closed'); });
    await expect(postProposalOutcomeToAuthor(proposal, { kind: 'verified', detail: 'ok' })).resolves.toBeUndefined();
    expect(insertValues).toHaveBeenCalled();
  });

  it('skips the message insert for an agent author and notifies the requester instead', async () => {
    await postProposalOutcomeToAuthor(
      { ...proposal, authorKind: 'agent_run', sessionId: null, agentRunId: '66666666-6666-4666-8666-666666666666' },
      { kind: 'verification_failed', detail: 'Service spooler is stopped.' },
    );
    expect(insertValues).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'approval', orgId: proposal.orgId, userId: proposal.requestedByUserId, priority: 'high' }),
    );
  });

  it('notifies nobody when there is no human requester', async () => {
    await postProposalOutcomeToAuthor(
      { ...proposal, authorKind: 'agent_run', sessionId: null, agentRunId: 'run', requestedByUserId: null },
      { kind: 'verified', detail: 'ok' },
    );
    expect(createNotification).not.toHaveBeenCalled();
  });
});
