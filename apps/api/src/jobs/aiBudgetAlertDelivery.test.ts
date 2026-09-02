import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createNotification: vi.fn(),
  resolveUsers: vi.fn(),
  sendEmail: vi.fn(),
  getEmailService: vi.fn(),
  publishEvent: vi.fn(),
  evaluateAiBudgetThresholds: vi.fn(),
  withSystemContext: vi.fn(),
  runOutside: vi.fn(),
}));

vi.mock('bullmq', () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
// Real `vi.fn`s (not inline arrows) so the #4276 diagnostic `label` argument
// every BullMQ handler must pass to `withSystemDbAccessContext` is assertable,
// and so the failure-bookkeeping write can be proven to open its OWN context
// rather than reusing the one its rethrow aborts.
vi.mock('../db', () => ({
  db: { execute: mocks.execute },
  withSystemDbAccessContext: mocks.withSystemContext,
  runOutsideDbContext: mocks.runOutside,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/userNotifications', () => ({ createNotification: mocks.createNotification }));
vi.mock('../services/usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: mocks.resolveUsers }));
vi.mock('../services/email', () => ({ getEmailService: mocks.getEmailService }));
vi.mock('../services/eventBus', () => ({ publishEvent: mocks.publishEvent, EVENT_TYPES: { AI_BUDGET_THRESHOLD_CROSSED: 'ai.budget.threshold_crossed' } }));
vi.mock('../services/aiBudgetAlerts', () => ({ evaluateAiBudgetThresholds: mocks.evaluateAiBudgetThresholds }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/c2cM365', () => ({ getFrontendBaseUrl: () => 'https://app.example.com' }));

import {
  AiBudgetAlertEventNotVisibleError,
  deliverAiBudgetAlert,
  evaluatePartnerOrgs,
  getAiBudgetAlertQueue,
  processJob,
  reconcileUndeliveredAiBudgetAlerts,
} from './aiBudgetAlertDelivery';

const dialect = new PgDialect();

/** `vi.resetAllMocks()` wipes implementations, so the context wrappers have to be re-armed per test. */
function armContextMocks() {
  mocks.withSystemContext.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mocks.runOutside.mockImplementation(async (fn: () => Promise<unknown>) => fn());
}

/** The rendered SQL text + bound params of an `sql` template, for order-independent assertions. */
function renderQuery(q: unknown): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(q as SQL);
  return { sql, params: params as unknown[] };
}

function fakeJob(data: unknown, opts: { attemptsMade?: number; attempts?: number } = {}) {
  return {
    id: 'job-1',
    data,
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 5 },
  } as unknown as Parameters<typeof processJob>[0];
}

const EVENT_UUID = '11111111-1111-4111-8111-111111111111';
const PARTNER_UUID = '22222222-2222-4222-8222-222222222222';

const baseEvent = {
  id: 'evt-1', org_id: 'org1', org_name: 'Acme', period: 'monthly', period_key: '2026-09',
  threshold_pct: 80, cap_cents: 10000, used_cents: 8100, billing_source: 'platform', delivered_at: null,
};

function renderSql(q: unknown): string {
  return dialect.sqlToQuery(q as SQL).sql;
}

/**
 * Dispatches `db.execute` by the rendered SQL text rather than by call order.
 * The brief's original mock queued `mockResolvedValueOnce` twice (once in
 * `beforeEach`, once per test), which makes the SECOND `execute` call resolve
 * to the event row — but the second call in the real implementation is the
 * users/email lookup, not a second event load. Rendering the query text and
 * matching on table name is order-independent and survives that mismatch.
 */
function mockExecute(event: Record<string, unknown> | null, userRows: Array<{ email: string }> = [{ email: 'a@x.io' }, { email: 'b@x.io' }]) {
  mocks.execute.mockImplementation(async (q: unknown) => {
    const text = renderSql(q);
    if (text.includes('FROM ai_budget_alert_events')) return event ? [event] : [];
    if (text.includes('FROM users')) return userRows;
    return [];
  });
}

describe('deliverAiBudgetAlert', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    armContextMocks();
    mocks.resolveUsers.mockResolvedValue(['u1', 'u2']);
    mocks.getEmailService.mockReturnValue({ sendEmail: mocks.sendEmail });
    mocks.createNotification.mockResolvedValue('n1');
    mockExecute(baseEvent);
  });

  it('notifies every recipient with the event id as dedupe key, sends one email, publishes, marks delivered', async () => {
    const result = await deliverAiBudgetAlert('evt-1');
    expect(result).toEqual({ recipients: 2, emailed: true });
    expect(mocks.createNotification).toHaveBeenCalledTimes(2);
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', orgId: 'org1', type: 'ai', dedupeKey: 'ai-budget-alert:evt-1', link: '/settings/ai-usage', priority: 'normal',
    }));
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0]?.[0].to).toEqual(['a@x.io', 'b@x.io']);
    expect(mocks.publishEvent).toHaveBeenCalledWith('ai.budget.threshold_crossed', 'org1', expect.objectContaining({ thresholdPct: 80 }), 'ai-budget-alerts');
    expect(JSON.stringify(mocks.execute.mock.calls.at(-1))).toContain('delivered_at');
    // #4276: every BullMQ handler must name the context it opens.
    expect(mocks.withSystemContext).toHaveBeenCalledWith(expect.any(Function), 'aiBudgetAlertDelivery.deliver');
  });

  it('loads the event row FOR UPDATE so a duplicate job serialises behind the first (W02 critical #1 iv)', async () => {
    await deliverAiBudgetAlert('evt-1');
    const loadSql = mocks.execute.mock.calls
      .map((call: unknown[]) => renderQuery(call[0]).sql)
      .find((text: string) => text.includes('FROM ai_budget_alert_events'));
    expect(loadSql).toContain('FOR UPDATE OF e');
  });

  it('throws a retryable not-visible error when the row is missing (W02 critical #1 ii)', async () => {
    // A missing row is overwhelmingly "inserted but not committed yet", not
    // "gone". Returning success there completes the job, and BullMQ's retained
    // completed hash then makes reconcile's same-jobId re-add a silent no-op —
    // the alert is lost. Throw so the existing backoff retries.
    mockExecute(null);
    await expect(deliverAiBudgetAlert('evt-1')).rejects.toBeInstanceOf(AiBudgetAlertEventNotVisibleError);
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('skips email for daily pre-cap rungs and when no email service is configured', async () => {
    mockExecute({ ...baseEvent, period: 'daily', period_key: '2026-09-30' });
    await expect(deliverAiBudgetAlert('evt-1')).resolves.toEqual({ recipients: 2, emailed: false });
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    mocks.resolveUsers.mockResolvedValue(['u1']);
    mocks.getEmailService.mockReturnValue(null);
    mockExecute(baseEvent);
    await expect(deliverAiBudgetAlert('evt-1')).resolves.toEqual({ recipients: 1, emailed: false });
  });

  it('marks priority high at 95 and above', async () => {
    mockExecute({ ...baseEvent, threshold_pct: 95 });
    await deliverAiBudgetAlert('evt-1');
    expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({ priority: 'high' }));
  });

  it('is a no-op for an already delivered event', async () => {
    mockExecute({ ...baseEvent, delivered_at: new Date().toISOString() });
    await expect(deliverAiBudgetAlert('evt-1')).resolves.toEqual({ recipients: 0, emailed: false });
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('records the failure in its OWN context and rethrows so BullMQ retries', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('smtp down'));
    await expect(deliverAiBudgetAlert('evt-1')).rejects.toThrow('smtp down');

    // Minor 5: `toContain('delivery_attempts')` also matches the SUCCESS
    // marker UPDATE, so it passed even when no failure row was written at all.
    // Pin the failure write specifically: a non-null last_delivery_error and
    // NO delivered_at stamp.
    const last = renderQuery(mocks.execute.mock.calls.at(-1)?.[0]);
    expect(last.sql).toContain('last_delivery_error =');
    expect(last.sql).not.toContain('delivered_at = now()');
    expect(last.params).toContain('smtp down');

    // W02 important #2: the bookkeeping UPDATE must run in a FRESH context —
    // written inside the delivery context it would be rolled back by the very
    // rethrow that follows it (or fail 25P02 after a DB-level error).
    expect(mocks.runOutside).toHaveBeenCalledTimes(2);
    expect(mocks.withSystemContext).toHaveBeenCalledTimes(2);
  });

  it('marks delivered before the event-bus publish, so a publish failure does not fail delivery and a retry does not resend', async () => {
    // Finding 1: notifications + email are the customer-facing delivery: they
    // must be durably marked BEFORE the (best-effort) bus publish, so that a
    // publish failure never causes BullMQ to retry a job that already sent.
    mocks.publishEvent.mockRejectedValueOnce(new Error('redis unavailable'));

    const first = await deliverAiBudgetAlert('evt-1');
    expect(first).toEqual({ recipients: 2, emailed: true });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    // The delivered_at UPDATE already ran, even though publish rejected.
    expect(JSON.stringify(mocks.execute.mock.calls.at(-1))).toContain('delivered_at');

    // Simulate BullMQ retrying the same job id: the row this call loads back
    // out is now delivered (the mark-delivered write ran before the publish
    // that failed), so the retry must be a no-op, not a second send.
    mockExecute({ ...baseEvent, delivered_at: new Date().toISOString() });
    const second = await deliverAiBudgetAlert('evt-1');
    expect(second).toEqual({ recipients: 0, emailed: false });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.createNotification).toHaveBeenCalledTimes(2);
  });
});

describe('reconcileUndeliveredAiBudgetAlerts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    armContextMocks();
  });

  it('re-enqueues each undelivered row and returns the row count', async () => {
    mocks.execute.mockImplementation(async (q: unknown) => {
      const text = renderSql(q);
      if (text.includes('FROM ai_budget_alert_events')) return [{ id: 'evt-a' }, { id: 'evt-b' }];
      return [];
    });
    const queue = getAiBudgetAlertQueue();

    const count = await reconcileUndeliveredAiBudgetAlerts();

    expect(count).toBe(2);
    const addMock = queue.add as unknown as ReturnType<typeof vi.fn>;
    const jobIds = addMock.mock.calls.map((call: unknown[]) => (call[2] as { jobId: string }).jobId);
    // W02 critical #1 (iii): a per-sweep suffix. BullMQ's addStandardJob Lua
    // short-circuits on `EXISTS <prefix><jobId>` and returns the EXISTING id,
    // and `removeOnComplete: {count: 200}` keeps the completed hash around —
    // so a bare `deliver-<id>` re-add after a completed no-op run enqueues
    // NOTHING and the alert stays undelivered forever.
    expect(jobIds[0]).toMatch(/^deliver-evt-a-r\d+$/);
    expect(jobIds[1]).toMatch(/^deliver-evt-b-r\d+$/);
    const selectText = mocks.execute.mock.calls.map((call: unknown[]) => renderSql(call[0])).find((t: string) => t.includes('FROM ai_budget_alert_events'));
    expect(selectText).toContain('delivered_at IS NULL');
    expect(selectText).toContain('delivery_attempts <');
    expect(mocks.withSystemContext).toHaveBeenCalledWith(expect.any(Function), 'aiBudgetAlertDelivery.reconcile');
  });

  it('enqueues nothing and returns 0 when there are no undelivered rows', async () => {
    mocks.execute.mockResolvedValue([]);
    const queue = getAiBudgetAlertQueue();

    const count = await reconcileUndeliveredAiBudgetAlerts();

    expect(count).toBe(0);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('evaluatePartnerOrgs (partner-wide evaluation fan-out)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    armContextMocks();
    mocks.evaluateAiBudgetThresholds.mockResolvedValue([]);
  });

  it('evaluates every active org of the partner, in order, and returns the count', async () => {
    mocks.execute.mockImplementation(async (q: unknown) => {
      const text = renderSql(q);
      if (text.includes('FROM organizations')) return [{ id: 'org-a' }, { id: 'org-b' }];
      return [];
    });

    const count = await evaluatePartnerOrgs('partner-1');

    expect(count).toBe(2);
    expect(mocks.evaluateAiBudgetThresholds.mock.calls.map((call: unknown[]) => call[0])).toEqual(['org-a', 'org-b']);
    const selectText = mocks.execute.mock.calls.map((call: unknown[]) => renderSql(call[0])).find((t: string) => t.includes('FROM organizations'));
    expect(selectText).toContain('partner_id');
    expect(selectText).toContain('deleted_at IS NULL');
    // Minor 6: a dead-lifecycle org has no live AI spend and must not be
    // re-evaluated (purging in particular is mid-erasure).
    expect(selectText).toContain('status NOT IN');
    for (const dead of ['purging', 'archived', 'churned', 'merging', 'offboarding']) {
      expect(selectText).toContain(`'${dead}'`);
    }
    expect(mocks.withSystemContext).toHaveBeenCalledWith(expect.any(Function), 'aiBudgetAlertDelivery.evaluatePartner');
  });

  it('evaluates nothing when the partner has no active orgs', async () => {
    mocks.execute.mockResolvedValue([]);

    const count = await evaluatePartnerOrgs('partner-1');

    expect(count).toBe(0);
    expect(mocks.evaluateAiBudgetThresholds).not.toHaveBeenCalled();
  });
});

describe('processJob (payload validation + terminal not-visible handling)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    armContextMocks();
    mocks.evaluateAiBudgetThresholds.mockResolvedValue([]);
  });

  it('drops a deliver job whose eventId is not a uuid instead of retrying it (minor 10)', async () => {
    await expect(processJob(fakeJob({ type: 'deliver', eventId: 'not-a-uuid' }))).resolves.toMatchObject({ skipped: expect.any(String) });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('drops an evaluate-partner job whose partnerId is not a uuid (minor 10)', async () => {
    await expect(processJob(fakeJob({ type: 'evaluate-partner', partnerId: 42 }))).resolves.toMatchObject({ skipped: expect.any(String) });
    expect(mocks.evaluateAiBudgetThresholds).not.toHaveBeenCalled();
  });

  it('drops a job with an unknown type', async () => {
    await expect(processJob(fakeJob({ type: 'nonsense' }))).resolves.toMatchObject({ skipped: expect.any(String) });
  });

  it('runs a well-formed evaluate-partner job', async () => {
    mocks.execute.mockImplementation(async (q: unknown) => (renderSql(q).includes('FROM organizations') ? [{ id: 'org-a' }] : []));
    await expect(processJob(fakeJob({ type: 'evaluate-partner', partnerId: PARTNER_UUID }))).resolves.toBe(1);
  });

  it('retries a not-visible event on a non-final attempt, and gives up quietly on the final one (W02 critical #1 ii)', async () => {
    mockExecute(null);

    // attempt 1 of 5 -> the error propagates so BullMQ backs off and retries.
    await expect(processJob(fakeJob({ type: 'deliver', eventId: EVENT_UUID }, { attemptsMade: 0, attempts: 5 })))
      .rejects.toBeInstanceOf(AiBudgetAlertEventNotVisibleError);

    // attempt 5 of 5 -> a genuinely deleted org must not land in Sentry as a
    // failed job; log and complete instead.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(processJob(fakeJob({ type: 'deliver', eventId: EVENT_UUID }, { attemptsMade: 4, attempts: 5 })))
      .resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(EVENT_UUID));
    warn.mockRestore();
  });
});
