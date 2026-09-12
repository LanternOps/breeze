import { describe, expect, it, vi, beforeEach } from 'vitest';

const addJob = vi.fn();
vi.mock('bullmq', () => ({
  // Function expressions so `new Queue()` / `new Worker()` are constructible.
  Queue: function Queue() { return { add: addJob, close: vi.fn() }; },
  Worker: function Worker() { return { on: vi.fn(), close: vi.fn() }; },
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

const evaluateVerificationClaim = vi.fn();
const onUnattendedVerificationOutcome = vi.fn();
vi.mock('../services/scriptProposals/verify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/scriptProposals/verify')>()),
  evaluateVerificationClaim: (...a: unknown[]) => evaluateVerificationClaim(...a),
  onUnattendedVerificationOutcome: (...a: unknown[]) => onUnattendedVerificationOutcome(...a),
}));
const transitionProposal = vi.fn();
vi.mock('../services/scriptProposals', () => ({
  transitionProposal: (...a: unknown[]) => transitionProposal(...a),
}));
const postProposalOutcomeToAuthor = vi.fn();
vi.mock('../services/scriptProposals/authorNotify', () => ({
  postProposalOutcomeToAuthor: (...a: unknown[]) => postProposalOutcomeToAuthor(...a),
}));
const loadProposalRow = vi.fn();
const loadProposalRequesterUserId = vi.fn();
vi.mock('../services/scriptProposals/queries', () => ({
  loadProposalRow: (...a: unknown[]) => loadProposalRow(...a),
  loadProposalRequesterUserId: (...a: unknown[]) => loadProposalRequesterUserId(...a),
}));
const writeAuditEventAsync = vi.fn();
vi.mock('../services/auditEvents', () => ({
  writeAuditEventAsync: (...a: unknown[]) => writeAuditEventAsync(...a),
  requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }),
}));
const selectLimit = vi.fn();
const TX = { tx: true };
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
    transaction: (fn: (tx: unknown) => unknown) => fn(TX),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { runScriptVerifyJob } from './scriptVerifyWorker';

const PROPOSAL = '44444444-4444-4444-8444-444444444444';
const EXEC = '55555555-5555-4555-8555-555555555555';
const JOB = { proposalId: PROPOSAL, executionId: EXEC, attempt: 1 };
const proposal = {
  id: PROPOSAL, orgId: 'o1', status: 'executed', authorKind: 'chat_session', sessionId: 's1', agentRunId: null,
  intentId: null, verification: { kind: 'exit_code', equals: 0 },
};
const execution = { id: EXEC, deviceId: 'd1', status: 'completed', exitCode: 0, stdout: 'ok', stderr: null };

beforeEach(() => {
  vi.clearAllMocks();
  transitionProposal.mockResolvedValue(true);
  loadProposalRow.mockResolvedValue(proposal);
  loadProposalRequesterUserId.mockResolvedValue('u1');
  selectLimit.mockResolvedValue([execution]);
});

describe('runScriptVerifyJob', () => {
  it('evaluates the claim against the execution and the device, as the requester', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'verified', evidence: { exitCode: 0 } });
    await runScriptVerifyJob(JOB);
    expect(evaluateVerificationClaim).toHaveBeenCalledWith(
      proposal.verification,
      { status: 'completed', exitCode: 0, stdout: 'ok', stderr: null },
      { deviceId: 'd1', orgId: 'o1' },
      'u1',
    );
  });

  it('transitions executed → verified and tells the author', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'verified', evidence: { exitCode: 0 } });
    expect(await runScriptVerifyJob(JOB)).toBe('verified');
    expect(transitionProposal).toHaveBeenCalledWith(
      TX, PROPOSAL, ['executed'], 'verified',
      expect.objectContaining({ verifiedAt: expect.any(Date), verificationResult: expect.objectContaining({ outcome: 'verified', attempts: 1 }) }),
    );
    expect(postProposalOutcomeToAuthor).toHaveBeenCalledWith(
      expect.objectContaining({ id: PROPOSAL, sessionId: 's1', requestedByUserId: 'u1' }),
      expect.objectContaining({ kind: 'verified' }),
    );
    expect(writeAuditEventAsync).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ action: 'script.proposal.verified', orgId: 'o1', resourceId: PROPOSAL }),
    );
  });

  it('transitions executed → verification_failed on a genuine failure', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'verification_failed', evidence: { exitCode: 3, expected: 0 } });
    expect(await runScriptVerifyJob(JOB)).toBe('verification_failed');
    expect(transitionProposal).toHaveBeenCalledWith(TX, PROPOSAL, ['executed'], 'verification_failed', expect.anything());
    expect(postProposalOutcomeToAuthor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'verification_failed' }));
    expect(writeAuditEventAsync).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ action: 'script.proposal.verification_failed' }),
    );
  });

  it('re-enqueues with a 10-minute delay on unknown while attempts remain', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'unknown', evidence: { reason: 'read_timeout' } });
    expect(await runScriptVerifyJob({ ...JOB, attempt: 1 })).toBe('retry');
    expect(addJob).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ attempt: 2 }), expect.objectContaining({ delay: 600000 }),
    );
    expect(transitionProposal).not.toHaveBeenCalled();
    expect(postProposalOutcomeToAuthor).not.toHaveBeenCalled();
  });

  it('finalises as unknown on the third attempt and does NOT leave the proposal in executed limbo', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'unknown', evidence: { reason: 'read_timeout' } });
    expect(await runScriptVerifyJob({ ...JOB, attempt: 3 })).toBe('unknown');
    expect(addJob).not.toHaveBeenCalled();
    expect(transitionProposal).toHaveBeenCalledWith(
      TX, PROPOSAL, ['executed'], 'verification_failed',
      expect.objectContaining({ verificationResult: expect.objectContaining({ outcome: 'unknown', attempts: 3 }) }),
    );
    expect(postProposalOutcomeToAuthor).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ kind: 'verification_unknown' }),
    );
  });

  it('calls the unattended hook for every terminal outcome', async () => {
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'verified', evidence: {} });
    await runScriptVerifyJob(JOB);
    expect(onUnattendedVerificationOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: PROPOSAL, orgId: 'o1' }), 'verified');
  });

  it('is idempotent: a proposal already past executed is a no-op success', async () => {
    transitionProposal.mockResolvedValue(false);
    evaluateVerificationClaim.mockResolvedValue({ outcome: 'verified', evidence: {} });
    await expect(runScriptVerifyJob(JOB)).resolves.toBe('verified');
    expect(postProposalOutcomeToAuthor).not.toHaveBeenCalled();
    expect(writeAuditEventAsync).not.toHaveBeenCalled();
  });

  it('does not read the device when the proposal is no longer executed', async () => {
    loadProposalRow.mockResolvedValue({ ...proposal, status: 'promoted' });
    expect(await runScriptVerifyJob(JOB)).toBe('unknown');
    expect(evaluateVerificationClaim).not.toHaveBeenCalled();
  });

  it('refuses an execution that does not belong to the proposal', async () => {
    selectLimit.mockResolvedValue([]);
    expect(await runScriptVerifyJob(JOB)).toBe('unknown');
    expect(evaluateVerificationClaim).not.toHaveBeenCalled();
  });
});
