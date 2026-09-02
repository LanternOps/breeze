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
}));

vi.mock('bullmq', () => ({ Queue: class { add = vi.fn(); }, Worker: class {}, Job: class {} }));
vi.mock('../db', () => ({
  db: { execute: mocks.execute },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/userNotifications', () => ({ createNotification: mocks.createNotification }));
vi.mock('../services/usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: mocks.resolveUsers }));
vi.mock('../services/email', () => ({ getEmailService: mocks.getEmailService }));
vi.mock('../services/eventBus', () => ({ publishEvent: mocks.publishEvent, EVENT_TYPES: { AI_BUDGET_THRESHOLD_CROSSED: 'ai.budget.threshold_crossed' } }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/c2cM365', () => ({ getFrontendBaseUrl: () => 'https://app.example.com' }));

import { deliverAiBudgetAlert } from './aiBudgetAlertDelivery';

const dialect = new PgDialect();

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

  it('records the failure and rethrows so BullMQ retries', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('smtp down'));
    await expect(deliverAiBudgetAlert('evt-1')).rejects.toThrow('smtp down');
    expect(JSON.stringify(mocks.execute.mock.calls.at(-1))).toContain('delivery_attempts');
  });
});
