import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';

import { sweepIdleChatSessions } from '../../jobs/aiChatSessionExpirySweep';
import { aiSessions } from '../../db/schema';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * #11430 against real Postgres: the 15-minute sweep retires exactly the chat
 * sessions the send would refuse — idle past the eviction window or past the
 * 24 h cap — and nothing else: not a fresh chat, not a Helper session (no user,
 * its own lifecycle), not an MCP ledger row, not a session already closed. A
 * second run finds nothing (idempotent).
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
    };

    const first = await sweepIdleChatSessions();

    expect(await statuses(ids)).toEqual({
      idleThreeDays: 'expired',
      idleThreeHours: 'expired',
      overAgeButBusy: 'expired',
      fresh: 'active',
      helper: 'active',
      mcp: 'active',
      closed: 'closed',
    });
    expect(first).toMatchObject({ expired: 3, capped: false });

    await expect(sweepIdleChatSessions()).resolves.toEqual({ scanned: 0, expired: 0, capped: false });
  });
});
