import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const m = vi.hoisted(() => ({
  page: vi.fn(), executions: vi.fn(), where: vi.fn(), system: vi.fn(),
  getJob: vi.fn(), enqueue: vi.fn(), transition: vi.fn(), audit: vi.fn(), outcome: vi.fn(),
  add: vi.fn(), repeats: vi.fn(), removeRepeat: vi.fn(), capture: vi.fn(),
}));
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: (condition: unknown) => {
      m.where(condition);
      return { then: (resolve: (value: unknown) => unknown) => m.executions().then(resolve),
        orderBy: () => ({ limit: m.page }) };
    } }) }),
    transaction: (fn: (tx: unknown) => unknown) => fn('tx'),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: m.system,
}));
vi.mock('../services/scriptProposals/verify', () => ({
  SCRIPT_VERIFY_MAX_ATTEMPTS: 3,
  getScriptVerifyQueue: () => ({ getJob: m.getJob, add: m.add,
    getRepeatableJobs: m.repeats, removeRepeatableByKey: m.removeRepeat }),
  enqueueScriptVerify: m.enqueue,
  onUnattendedVerificationOutcome: m.outcome,
}));
vi.mock('../services/scriptProposals', () => ({ transitionProposal: m.transition }));
vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: () => ({}), writeAuditEventAsync: m.audit,
}));
vi.mock('../services/sentry', () => ({ captureException: m.capture }));
import { sweepScriptVerifyProposals, scheduleScriptVerifyReconciliation } from './scriptVerifyReconciliation';

const proposal = { id: '44444444-4444-4444-8444-444444444444', orgId: '11111111-1111-4111-8111-111111111111' };
const execution = { id: '55555555-5555-4555-8555-555555555555', status: 'completed', completedAt: new Date('2026-09-16T10:00:00Z') };
const jobId = (attempt: number, executionId = execution.id) => `script-verify-${proposal.id}-${executionId}-${attempt}`;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-16T11:00:00Z'));
  m.system.mockImplementation((fn: () => unknown) => fn());
  m.page.mockResolvedValue([proposal]);
  m.executions.mockResolvedValue([execution]);
  m.transition.mockResolvedValue(true);
  m.repeats.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('script verify reconciliation', () => {
  it('re-enqueues an orphan once and audits its tenant without holding a DB context over Redis', async () => {
    let inDb = false;
    m.system.mockImplementation(async (fn: () => unknown) => {
      inDb = true;
      try { return await fn(); } finally { inDb = false; }
    });
    m.enqueue.mockImplementation(async () => { expect(inDb).toBe(false); });
    await sweepScriptVerifyProposals();
    expect(m.getJob.mock.calls.map(([id]) => id)).toEqual([jobId(1), jobId(2), jobId(3)]);
    expect(m.enqueue).toHaveBeenCalledExactlyOnceWith({ proposalId: proposal.id, executionId: execution.id, attempt: 1 });
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith({}, expect.objectContaining({
      action: 'script.proposal.verification_reenqueued', orgId: proposal.orgId, resourceId: proposal.id,
    }));
    const query = new PgDialect().sqlToQuery(m.where.mock.calls[0]![0] as SQL);
    expect(query.params).toContain('executed');
    expect(query.params).toContain('2026-09-16T10:30:00.000Z');
  });

  it('records a terminal unknown with verify_enqueue_lost and audits when enqueue throws', async () => {
    m.enqueue.mockRejectedValue(new Error('Redis unavailable'));
    await sweepScriptVerifyProposals();
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.transition).toHaveBeenCalledWith('tx', proposal.id, ['executed'], 'verification_failed', {
      verifiedAt: expect.any(Date),
      verificationResult: expect.objectContaining({ outcome: 'unknown', evidence: { reason: 'verify_enqueue_lost' } }),
    });
    expect(m.audit).toHaveBeenCalledWith({}, expect.objectContaining({
      action: 'script.proposal.verification_failed', orgId: proposal.orgId,
      details: expect.objectContaining({ reason: 'verify_enqueue_lost' }),
    }));
    expect(m.outcome).toHaveBeenCalledWith(proposal, 'unknown');
  });

  it.each(['active', 'waiting', 'delayed', 'waiting-children', 'prioritized', 'paused'])('preserves a %s job on any execution or retry attempt', async (state) => {
    m.executions.mockResolvedValue([execution, { ...execution, id: 'other' }]);
    m.getJob.mockImplementation(async (id: string) => id === jobId(3, 'other') ? { getState: async () => state } : undefined);
    await sweepScriptVerifyProposals();
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'])('removes a retained %s job before reusing its deterministic id and preserves the retry budget', async (state) => {
    const remove = vi.fn();
    m.getJob.mockImplementation(async (id: string) => id === jobId(2) ? { getState: async () => state, remove } : undefined);
    await sweepScriptVerifyProposals();
    expect(remove).toHaveBeenCalledOnce();
    expect(m.enqueue).toHaveBeenCalledWith({ proposalId: proposal.id, executionId: execution.id, attempt: 2 });
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(m.enqueue.mock.invocationCallOrder[0]!);
  });

  it.each([
    { executions: [] },
    { executions: [{ ...execution, status: 'running', completedAt: null }] },
    { executions: [execution, { ...execution, id: 'other', completedAt: new Date('2026-09-16T10:45:00Z') }] },
    { executions: [{ ...execution, completedAt: null }] },
  ])('leaves proposals without exclusively stale terminal executions alone (%j)', async ({ executions }) => {
    m.executions.mockResolvedValue(executions);
    await sweepScriptVerifyProposals();
    expect(m.getJob).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('honors the configured minimum age', async () => {
    vi.stubEnv('SCRIPT_VERIFY_RECONCILE_MIN_AGE_MINUTES', '90');
    await sweepScriptVerifyProposals();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', 'invalid'])('falls back to thirty minutes for invalid age %s', async (value) => {
    vi.stubEnv('SCRIPT_VERIFY_RECONCILE_MIN_AGE_MINUTES', value);
    await sweepScriptVerifyProposals();
    expect(m.enqueue).toHaveBeenCalledOnce();
  });

  it('continues across organizations when one proposal cannot inspect its queue', async () => {
    const other = { id: '66666666-6666-4666-8666-666666666666', orgId: '22222222-2222-4222-8222-222222222222' };
    m.page.mockResolvedValue([proposal, other]);
    m.getJob.mockRejectedValueOnce(new Error('lookup failed'));
    await sweepScriptVerifyProposals();
    expect(m.enqueue).toHaveBeenCalledExactlyOnceWith({ proposalId: other.id, executionId: execution.id, attempt: 1 });
    expect(m.audit).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({ orgId: other.orgId, resourceId: other.id }));
  });

  it('does not mistake a queue lookup failure for proof that no job exists', async () => {
    m.getJob.mockRejectedValue(new Error('Redis unavailable'));
    await sweepScriptVerifyProposals();
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.transition).not.toHaveBeenCalled();
    expect(m.capture).toHaveBeenCalled();
  });

  it('does not audit or notify a terminal failure if the worker already transitioned the proposal', async () => {
    m.enqueue.mockRejectedValue(new Error('Redis unavailable'));
    m.transition.mockResolvedValue(false);
    await sweepScriptVerifyProposals();
    expect(m.audit).not.toHaveBeenCalled();
    expect(m.outcome).not.toHaveBeenCalled();
  });

  it('schedules reconciliation on the existing queue through the schedule registry', async () => {
    await scheduleScriptVerifyReconciliation();
    expect(m.add).toHaveBeenCalledWith('reconcile', expect.anything(), expect.objectContaining({
      repeat: { pattern: '12 0,6,12,18 * * *' },
    }));
  });
});
