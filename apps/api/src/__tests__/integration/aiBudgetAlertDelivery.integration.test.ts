/**
 * Real-Postgres integration proof for the AI budget alert DELIVERY worker
 * (#4388 W02). `jobs/aiBudgetAlertDelivery.test.ts` covers the branch logic
 * against a mocked `db.execute`; this suite covers the parts a mock is
 * structurally blind to, because they are properties of the TRANSACTION rather
 * than of the statements:
 *
 *  - Failure bookkeeping. The unit suite sees the `delivery_attempts + 1,
 *    last_delivery_error = …` UPDATE being *issued* and passes either way. Only
 *    a real transaction shows that issuing it inside the context the rethrow
 *    then aborts leaves ZERO durable trace — the row still reads
 *    `delivery_attempts = 0, last_delivery_error = NULL` after a hard failure,
 *    so the reconcile sweep's `delivery_attempts < MAX_ATTEMPTS` guard can
 *    never retire a permanently-failing row and operators see no error at all.
 *  - The success marker committing together with the delivery it marks.
 *  - The not-visible error class on a genuinely absent row.
 *  - Idempotency across two calls on the same (delivered) row.
 *
 * Only the OUTBOUND edges are mocked — email, the event bus, and the recipient
 * resolver (whose own query is unit-tested in
 * `services/usersWithPermission.test.ts`). The database and the DB-context
 * helpers are deliberately real: they are the thing under test.
 *
 * Fixtures are seeded per test, not in `beforeAll`: the integration setup's
 * global `beforeEach` truncates the tenant tables (organizations cascades into
 * `ai_budget_alert_events`), so a `beforeAll` fixture would already be gone.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  publishEvent: vi.fn(),
  publishUserEvent: vi.fn(),
  /** Rewritten by `seedOrgWithRecipient` once the seeded user id exists. */
  recipients: [] as string[],
}));

vi.mock('../../services/email', () => ({
  getEmailService: () => ({ sendEmail: mocks.sendEmail }),
}));
vi.mock('../../services/eventBus', () => ({
  publishEvent: mocks.publishEvent,
  // `createNotification` fires a best-effort live nudge through the bus.
  getEventBus: () => ({ publishUserEvent: mocks.publishUserEvent }),
  EVENT_TYPES: { AI_BUDGET_THRESHOLD_CROSSED: 'ai.budget.threshold_crossed' },
}));
vi.mock('../../services/usersWithPermission', () => ({
  resolveUsersWithPermissionForOrg: vi.fn(async () => mocks.recipients),
}));

import { db, withSystemDbAccessContext } from '../../db';
import { AiBudgetAlertEventNotVisibleError, deliverAiBudgetAlert } from '../../jobs/aiBudgetAlertDelivery';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type EventRow = {
  delivered_at: string | null;
  recipient_count: number | null;
  delivery_attempts: number;
  last_delivery_error: string | null;
};

async function seedOrgWithRecipient(): Promise<{ orgId: string; userId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  mocks.recipients = [user.id];
  return { orgId: org.id, userId: user.id };
}

/** Monthly + rung 95, so `shouldEmail` is true and the email edge is exercised. */
async function insertEvent(orgId: string): Promise<string> {
  const rows = await withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    INSERT INTO ai_budget_alert_events (org_id, period, period_key, threshold_pct, cap_cents, used_cents, billing_source)
    VALUES (${orgId}::uuid, 'monthly', '2026-09', 95, 10000, 9600, 'platform')
    RETURNING id
  `));
  return rows[0]!.id;
}

async function readEvent(eventId: string): Promise<EventRow> {
  const rows = await withSystemDbAccessContext(() => db.execute<EventRow>(sql`
    SELECT delivered_at, recipient_count, delivery_attempts, last_delivery_error
    FROM ai_budget_alert_events WHERE id = ${eventId}::uuid
  `));
  return rows[0]!;
}

async function notificationsFor(userId: string) {
  return withSystemDbAccessContext(() => db.execute<{ link: string | null; dedupe_key: string | null; priority: string }>(sql`
    SELECT link, dedupe_key, priority FROM user_notifications WHERE user_id = ${userId}::uuid
  `));
}

describe('deliverAiBudgetAlert against real Postgres (#4388 W02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.publishEvent.mockResolvedValue(undefined);
    mocks.publishUserEvent.mockResolvedValue(undefined);
  });

  runDb('commits the notification, the email and the delivered marker together', async () => {
    const { orgId, userId } = await seedOrgWithRecipient();
    const eventId = await insertEvent(orgId);

    await expect(deliverAiBudgetAlert(eventId)).resolves.toEqual({ recipients: 1, emailed: true });

    const row = await readEvent(eventId);
    expect(row.delivered_at).not.toBeNull();
    expect(Number(row.recipient_count)).toBe(1);
    expect(Number(row.delivery_attempts)).toBe(1);
    expect(row.last_delivery_error).toBeNull();

    const notifications = await notificationsFor(userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      link: '/settings/ai-usage',
      dedupe_key: `ai-budget-alert:${eventId}`,
      priority: 'high',
    });
  });

  runDb('DURABLY records a delivery failure (attempts + error) even though it rethrows', async () => {
    const { orgId, userId } = await seedOrgWithRecipient();
    const eventId = await insertEvent(orgId);
    mocks.sendEmail.mockRejectedValue(new Error('smtp exploded'));

    await expect(deliverAiBudgetAlert(eventId)).rejects.toThrow('smtp exploded');

    const row = await readEvent(eventId);
    expect(row.delivered_at).toBeNull();
    expect(Number(row.delivery_attempts)).toBe(1);
    expect(row.last_delivery_error).toContain('smtp exploded');

    // The in-app notifications written before the send DID roll back with the
    // failing transaction, which is what makes the retry safe: the whole
    // customer-facing delivery is re-attempted, not half of it.
    expect(await notificationsFor(userId)).toHaveLength(0);
  });

  runDb('throws the retryable not-visible error for a row that does not exist', async () => {
    await expect(deliverAiBudgetAlert(randomUUID())).rejects.toBeInstanceOf(AiBudgetAlertEventNotVisibleError);
  });

  runDb('is idempotent: a second call on a delivered row sends nothing', async () => {
    const { orgId, userId } = await seedOrgWithRecipient();
    const eventId = await insertEvent(orgId);

    await expect(deliverAiBudgetAlert(eventId)).resolves.toEqual({ recipients: 1, emailed: true });
    await expect(deliverAiBudgetAlert(eventId)).resolves.toEqual({ recipients: 0, emailed: false });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(await notificationsFor(userId)).toHaveLength(1);
    expect(Number((await readEvent(eventId)).delivery_attempts)).toBe(1);
  });
});
