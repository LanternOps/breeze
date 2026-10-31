import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({
  select: vi.fn(), update: vi.fn(), page: vi.fn(), evaluate: vi.fn(), orgEvaluate: vi.fn(),
  add: vi.fn(), getJob: vi.fn(), close: vi.fn(), afterCommit: vi.fn(),
  repeatables: vi.fn(), removeRepeatable: vi.fn(), worker: vi.fn(), delayedScore: vi.fn(),
  context: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  outside: vi.fn((fn: () => unknown) => fn()), ambient: vi.fn(() => false),
}));
vi.mock('../db', () => ({
  db: { select: mocks.select, update: mocks.update },
  withSystemDbAccessContext: mocks.context, runOutsideDbContext: mocks.outside,
  hasDbAccessContext: mocks.ambient, runAfterDbContextCommit: mocks.afterCommit,
}));
vi.mock('../services/partnerGroupEvaluation', () => ({
  PARTNER_GROUP_ORG_PAGE_SIZE: 50,
  listPartnerGroupEvaluationOrgIds: mocks.page,
  evaluatePartnerGroupForOrg: mocks.evaluate,
}));
vi.mock('../services/groupMembership', () => ({ evaluateGroupMembership: mocks.orgEvaluate }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('bullmq', () => ({
  Queue: class { client = Promise.resolve({ zscore: mocks.delayedScore }); toKey = (name: string) => `bull:partner-group-evaluation:${name}`; add = mocks.add; getJob = mocks.getJob; close = mocks.close; getRepeatableJobs = mocks.repeatables; removeRepeatableByKey = mocks.removeRepeatable; },
  Worker: class { constructor(...args: unknown[]) { mocks.worker(...args); } on = vi.fn(); close = mocks.close; },
}));

import {
  processPartnerGroupEvaluation, schedulePartnerGroupEvaluation, runPartnerGroupSweep,
  requestPartnerGroupEvaluationAfterCommit, shutdownPartnerGroupEvaluationJobs,
  schedulePartnerGroupEvaluationSweep, initializePartnerGroupEvaluationJobs,
  type PartnerGroupEvaluationJobData,
} from './partnerGroupEvaluationJobs';

const group = { id: 'group', orgId: null, partnerId: 'partner', type: 'dynamic', filterRevision: 3 };
const clock = () => new Date('2026-10-29T12:00:00Z');
function data(overrides: Partial<PartnerGroupEvaluationJobData> = {}): PartnerGroupEvaluationJobData {
  return { type: 'partner-group-evaluation', groupId: group.id, revision: null,
    afterOrgId: null, failedOrgs: 0, evaluatedOrgs: 0, reason: 'test', queuedAt: clock().toISOString(), ...overrides };
}
function selectRows(rows: unknown[]) {
  const where = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows), then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) });
  mocks.select.mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where }) });
  return where;
}
function finalizeRows(rows: unknown[]) {
  const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) });
  const set = vi.fn().mockReturnValue({ where });
  mocks.update.mockReturnValueOnce({ set });
  return set;
}

beforeEach(async () => {
  await shutdownPartnerGroupEvaluationJobs();
  vi.clearAllMocks();
  mocks.ambient.mockReturnValue(false);
  mocks.getJob.mockResolvedValue(undefined);
  mocks.delayedScore.mockResolvedValue(null);
  mocks.add.mockResolvedValue({ id: 'queued' });
  mocks.repeatables.mockResolvedValue([]);
  mocks.evaluate.mockImplementation(async (_groupId: string, orgId: string) => ({ orgId, ok: true, status: 'evaluated', added: 1, removed: 0, matched: 1, filterMs: 1 }));
});

describe('partner group evaluation jobs', () => {
  it('head job reads filter_revision, continues with afterOrgId cursor, finalizes evaluated_revision/evaluated_at/evaluation_failed_orgs', async () => {
    const enqueue = vi.fn();
    selectRows([group]);
    mocks.page.mockResolvedValueOnce(['org-a', 'org-b']);
    const first = await processPartnerGroupEvaluation(data(), { enqueue, pageSize: 2, now: clock });
    expect(first).toMatchObject({ status: 'continued', evaluatedOrgs: 2, failedOrgs: 0 });
    expect(first.next).toMatchObject({ revision: 3, afterOrgId: 'org-b', evaluatedOrgs: 2 });
    expect(mocks.evaluate).toHaveBeenCalledWith('group', 'org-a', { expectedRevision: 3 });
    expect(enqueue).toHaveBeenCalledWith(first.next, expect.objectContaining({ jobId: 'partner-group-eval-group-r3-after-org-b' }));
    selectRows([group]);
    mocks.page.mockResolvedValueOnce(['org-c']);
    mocks.evaluate.mockResolvedValueOnce({ orgId: 'org-c', ok: false, status: 'failed', added: 0, removed: 0, matched: 0, filterMs: 500 });
    const set = finalizeRows([{ id: group.id }]);
    if (!first.next) throw new Error('missing continuation');
    const last = await processPartnerGroupEvaluation(first.next, { enqueue, pageSize: 2, now: clock });
    expect(last).toMatchObject({ status: 'finalized', evaluatedOrgs: 3, failedOrgs: 1 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ evaluatedAt: clock(), evaluationFailedOrgs: 1 }));
    const update = set.mock.calls[0]?.[0];
    expect(new PgDialect().sqlToQuery(update.evaluatedRevision).sql).toMatch(/greatest/i);
    expect(mocks.page).toHaveBeenLastCalledWith('partner', 'org-b', 2);
  });

  it('finalize on a stale revision enqueues a fresh head job and never lowers evaluated_revision', async () => {
    selectRows([group]);
    mocks.page.mockResolvedValueOnce([]);
    const set = finalizeRows([]);
    const enqueue = vi.fn();
    const result = await processPartnerGroupEvaluation(data({ revision: 3 }), { enqueue, now: clock });
    expect(result.status).toBe('superseded');
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ revision: null, afterOrgId: null, failedOrgs: 0, evaluatedOrgs: 0 }), expect.any(Object));
    expect(new PgDialect().sqlToQuery(set.mock.calls[0]?.[0].evaluatedRevision).sql).toMatch(/greatest/i);
  });

  it('finalize UPDATE guards filter_revision with the evaluated revision parameter', async () => {
    selectRows([group]);
    mocks.page.mockResolvedValueOnce([]);
    const set = finalizeRows([{ id: group.id }]);
    await processPartnerGroupEvaluation(data({ revision: 3 }), { enqueue: vi.fn(), now: clock });
    const where = set.mock.results[0]?.value.where;
    const query = new PgDialect().sqlToQuery(where.mock.calls[0]?.[0]);
    expect(query.sql).toMatch(/"filter_revision" = \$2/);
    expect(query.params).toEqual(['group', 3]);
  });

  it('stops before page discovery when the revision is already superseded', async () => {
    selectRows([group]);
    const enqueue = vi.fn();
    const result = await processPartnerGroupEvaluation(data({ revision: 2 }), { enqueue });
    expect(result.status).toBe('superseded');
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('stops a page when an org observes a newer revision', async () => {
    selectRows([group]);
    mocks.page.mockResolvedValueOnce(['a', 'b']);
    mocks.evaluate.mockResolvedValueOnce({ orgId: 'a', ok: true, status: 'superseded', added: 0, removed: 0, matched: 0, filterMs: 0 });
    const enqueue = vi.fn();
    expect((await processPartnerGroupEvaluation(data(), { enqueue })).status).toBe('superseded');
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('refuses an ambient transaction before any work', async () => {
    mocks.ambient.mockReturnValue(true);
    await expect(processPartnerGroupEvaluation(data())).rejects.toThrow(/ambient/i);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('coalesces requests under jobId partner-group-eval-<groupId>', async () => {
    await schedulePartnerGroupEvaluation('group', 'test');
    expect(mocks.add).toHaveBeenCalledWith('partner-group-evaluation', data({ queuedAt: expect.any(String) }), expect.objectContaining({ jobId: 'partner-group-eval-group', delay: 5000, attempts: 5 }));
    mocks.getJob.mockResolvedValue({ id: 'existing', getState: async () => 'delayed' });
    expect(await schedulePartnerGroupEvaluation('group', 'again')).toBe('existing');
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it.each([0, 5000])('shortens a delayed head to a requested delay of %i ms', async (delayMs) => {
    vi.spyOn(Date, 'now').mockReturnValue(clock().getTime());
    const changeDelay = vi.fn().mockResolvedValue(undefined);
    mocks.getJob.mockResolvedValue({ id: 'existing', getState: async () => 'delayed', changeDelay });
    mocks.delayedScore.mockResolvedValue(String((clock().getTime() + 900000) * 4096));
    try {
      expect(await schedulePartnerGroupEvaluation('group', 'filter_edit', { delayMs })).toBe('existing');
      expect(mocks.delayedScore).toHaveBeenCalledWith('bull:partner-group-evaluation:delayed', 'existing');
      expect(changeDelay).toHaveBeenCalledWith(delayMs);
      expect(mocks.add).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([1000, 5000])('keeps a delayed head due in %i ms when the requested delay is no shorter', async (remainingMs) => {
    vi.spyOn(Date, 'now').mockReturnValue(clock().getTime());
    const changeDelay = vi.fn();
    mocks.getJob.mockResolvedValue({ id: 'existing', getState: async () => 'delayed', changeDelay });
    mocks.delayedScore.mockResolvedValue(String((clock().getTime() + remainingMs) * 4096));
    try {
      await schedulePartnerGroupEvaluation('group', 'sweep', { delayMs: 5000 });
      expect(changeDelay).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps a head whose delayed-set score disappeared while checking its state', async () => {
    const changeDelay = vi.fn();
    mocks.getJob.mockResolvedValue({ id: 'existing', getState: async () => 'delayed', changeDelay });
    mocks.delayedScore.mockResolvedValue(null);
    expect(await schedulePartnerGroupEvaluation('group', 'edit', { delayMs: 0 })).toBe('existing');
    expect(changeDelay).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('adds an active-job follow-up and replaces failed records', async () => {
    const remove = vi.fn();
    mocks.getJob.mockResolvedValueOnce({ id: 'existing', getState: async () => 'active' });
    await schedulePartnerGroupEvaluation('group', 'again');
    expect(mocks.add).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ jobId: expect.stringMatching(/^partner-group-eval-group-follow-up-/) }));
    mocks.getJob.mockResolvedValueOnce({ id: 'existing', getState: async () => 'failed', remove });
    await schedulePartnerGroupEvaluation('group', 'retry');
    expect(remove).toHaveBeenCalledOnce();
    expect(mocks.add).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), expect.objectContaining({ jobId: 'partner-group-eval-group' }));
  });

  it('defers enqueue until commit', async () => {
    requestPartnerGroupEvaluationAfterCommit('group', 'edit');
    expect(mocks.add).not.toHaveBeenCalled();
    const work = mocks.afterCommit.mock.calls[0]?.[1];
    await work();
    expect(mocks.add).toHaveBeenCalledOnce();
  });

  it('replaces only its sweep repeatable and schedules the six-hour sweep on its registry cron slot', async () => {
    mocks.repeatables.mockResolvedValue([{ name: 'partner-group-sweep', key: 'old' }, { name: 'unrelated', key: 'keep' }]);
    await schedulePartnerGroupEvaluationSweep();
    expect(mocks.removeRepeatable.mock.calls).toEqual([['old']]);
    // A cron slot, never `every`: BullMQ anchors `every` to the epoch (scheduleRegistry.ts).
    expect(mocks.add).toHaveBeenCalledWith('partner-group-sweep', expect.any(Object), expect.objectContaining({
      repeat: { pattern: '24 5,11,17,23 * * *' }, attempts: 3, backoff: { type: 'exponential', delay: 60000 },
    }));
  });

  it('initializes separate evaluation and sweep workers at concurrency one', async () => {
    await initializePartnerGroupEvaluationJobs();
    expect(mocks.worker.mock.calls.map(([name, , options]) => [name, options.concurrency])).toEqual([
      ['partner-group-evaluation', 1], ['partner-group-evaluation-sweep', 1],
    ]);
  });

  it('sweep enqueues every dynamic partner group with jitter ≤ 15 min and re-evaluates org groups whose filter_fields_used overlap software.*', async () => {
    const partnerWhere = selectRows([{ id: 'g1' }, { id: 'g2' }]);
    const orgWhere = selectRows([{ id: 'o1' }, { id: 'o2' }]);
    mocks.orgEvaluate.mockResolvedValue({});
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const enqueue = vi.fn();
    expect(await runPartnerGroupSweep({ enqueue, random: () => 0.5, now: clock })).toEqual({ partnerGroups: 2, orgGroups: 2 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({ groupId: 'g1', revision: null }), expect.objectContaining({ delayMs: 450000 }));
    expect(mocks.orgEvaluate.mock.calls).toEqual([['o1', { exportLockBeforeWrites: true }], ['o2', { exportLockBeforeWrites: true }]]);
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(partnerWhere.mock.calls[0]?.[0]).sql).toMatch(/partner_id.*is not null/i);
    const orgSQL = dialect.sqlToQuery(orgWhere.mock.calls[0]?.[0]);
    expect(orgSQL.sql).toMatch(/unnest.*filter_fields_used/i);
    expect(orgSQL.sql).toMatch(/software\.%/);
    expect(mocks.outside).toHaveBeenCalled();
    error.mockRestore();
  });
  it('collects enqueue and org-group failures, finishes the sweep, and rejects for retry', async () => {
    selectRows([{ id: 'g1' }, { id: 'g2' }]);
    selectRows([{ id: 'o1' }, { id: 'o2' }]);
    const enqueueError = new Error('redis unavailable');
    const orgError = new Error('org evaluation unavailable');
    const enqueue = vi.fn().mockRejectedValueOnce(enqueueError).mockResolvedValueOnce(undefined);
    mocks.orgEvaluate.mockRejectedValueOnce(orgError).mockResolvedValueOnce({});
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runPartnerGroupSweep({ enqueue, random: () => 0 })).rejects.toMatchObject({
        name: 'AggregateError', errors: [enqueueError, orgError],
      });
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(mocks.orgEvaluate).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

});
