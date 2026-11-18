import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';

import { sweepIdleChatSessions } from '../../jobs/aiChatSessionExpirySweep';
import { aiBudgetReservations, aiSessions } from '../../db/schema';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * #11430 against real Postgres: the 15-minute sweep retires exactly the chat
 * sessions the send would refuse — idle past the eviction window or past the
 * 24 h cap — and nothing else: not a fresh chat, not a Helper session (no user,
 * its own lifecycle), not an MCP ledger row, not a session already closed, and
 * not a session whose turn may still be running (an unsettled budget
 * reservation admitted within the longest turn, even one whose TTL lapsed
 * during a long approval wait). A settled turn, or a reservation stranded past
 * the longest turn, protects nothing. A second run finds nothing (idempotent).
 */
const HOUR = 60 * 60 * 1000;

async function insertSession(values: {
  orgId: string;
  userId: string | null;
  type?: string;
  status?: 'active' | 'closed' | 'expired';
  createdHoursAgo: number;
  idleHoursAgo: number;
}): Promise<string> {
  const now = Date.now();
  const [row] = await getTestDb().insert(aiSessions).values({
    orgId: values.orgId,
    userId: values.userId,
    type: values.type ?? 'general',
    status: values.status ?? 'active',
    model: 'claude-sonnet-5-5',
    createdAt: new Date(now - values.createdHoursAgo * HOUR),
    lastActivityAt: new Date(now - values.idleHoursAgo * HOUR),
  }).returning({ id: aiSessions.id });
  return row!.id;
}

/**
 * A turn's budget hold, admitted `admittedMinutesAgo`: `active` until it
 * settles; the reservation sweep relabels one whose 30-minute TTL lapsed
 * mid-turn `expired` / `active_ttl`.
 */
async function holdTurn(
  orgId: string,
  sessionId: string,
  admittedMinutesAgo: number,
  state: 'active' | 'ttl_lapsed' | 'settled' = 'active',
): Promise<void> {
  const admittedAt = new Date(Date.now() - admittedMinutesAgo * 60_000);
  await getTestDb().insert(aiBudgetReservations).values({
    orgId,
    sessionId,
    idempotencyKey: `chat:turn-${sessionId}`,
    billingSource: 'platform',
    dailyPeriodKey: '2026-11-08',
    monthlyPeriodKey: '2026-11',
    reservedCostCents: '0',
    uncapped: true,
    createdAt: admittedAt,
    expiresAt: new Date(admittedAt.getTime() + 30 * 60_000),
    ...(state === 'ttl_lapsed' ? { status: 'expired' as const, expiryReason: 'active_ttl', expiredAt: new Date() } : {}),
    ...(state === 'settled' ? { status: 'settled' as const, actualCostCents: '0', settledAt: new Date() } : {}),
  });
}

async function statuses(ids: Record<string, string>): Promise<Record<string, string>> {
  const rows = await getTestDb()
    .select({ id: aiSessions.id, status: aiSessions.status })
    .from(aiSessions)
    .where(inArray(aiSessions.id, Object.values(ids)));
  const byId = new Map(rows.map((r) => [r.id, r.status]));
  return Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, byId.get(id) ?? 'missing']));
}

describe('aiChatSessionExpirySweep (#11430, real DB)', () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment({ scope: 'organization' });
  });

  it('expires idle and over-age chat sessions only, and a second run finds nothing', async () => {
    const org = env.organization.id;
    const user = env.user.id;
    const ids = {
      idleThreeDays: await insertSession({ orgId: org, userId: user, createdHoursAgo: 72, idleHoursAgo: 72 }),
      idleThreeHours: await insertSession({ orgId: org, userId: user, createdHoursAgo: 4, idleHoursAgo: 3 }),
      overAgeButBusy: await insertSession({ orgId: org, userId: user, createdHoursAgo: 25, idleHoursAgo: 0.1 }),
      fresh: await insertSession({ orgId: org, userId: user, createdHoursAgo: 1, idleHoursAgo: 0.25 }),
      helper: await insertSession({ orgId: org, userId: null, createdHoursAgo: 72, idleHoursAgo: 72 }),
      mcp: await insertSession({ orgId: org, userId: user, type: 'mcp', createdHoursAgo: 72, idleHoursAgo: 72 }),
      closed: await insertSession({ orgId: org, userId: user, status: 'closed', createdHoursAgo: 72, idleHoursAgo: 72 }),
      // last_activity_at only moves when a turn settles: a turn admitted just
      // inside the window is still running past it.
      turnRunning: await insertSession({ orgId: org, userId: user, createdHoursAgo: 3, idleHoursAgo: 2.05 }),
      turnInLongApprovalWait: await insertSession({ orgId: org, userId: user, createdHoursAgo: 3, idleHoursAgo: 2.7 }),
      turnSettled: await insertSession({ orgId: org, userId: user, createdHoursAgo: 3, idleHoursAgo: 2.05 }),
      turnStranded: await insertSession({ orgId: org, userId: user, createdHoursAgo: 4, idleHoursAgo: 3.5 }),
    };
    await holdTurn(org, ids.turnRunning, 5);
    await holdTurn(org, ids.turnInLongApprovalWait, 40, 'ttl_lapsed');
    await holdTurn(org, ids.turnSettled, 10, 'settled');
    await holdTurn(org, ids.turnStranded, 70);

    const first = await sweepIdleChatSessions();

    expect(await statuses(ids)).toEqual({
      idleThreeDays: 'expired',
      idleThreeHours: 'expired',
      overAgeButBusy: 'expired',
      fresh: 'active',
      helper: 'active',
      mcp: 'active',
      closed: 'closed',
      turnRunning: 'active',
      turnInLongApprovalWait: 'active',
      turnSettled: 'expired',
      turnStranded: 'expired',
    });
    expect(first).toMatchObject({ expired: 5, capped: false });

    await expect(sweepIdleChatSessions()).resolves.toEqual({ scanned: 0, expired: 0, capped: false });
  });
});
