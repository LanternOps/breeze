import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import { userRiskScores } from '../../db/schema';
import { compactUserRiskSnapshots } from '../../jobs/userRiskRetention';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;

async function insertSnapshot(options: {
  orgId: string;
  userId: string;
  score: number;
  calculatedAt: Date;
}): Promise<string> {
  const [row] = await getTestDb()
    .insert(userRiskScores)
    .values({
      orgId: options.orgId,
      userId: options.userId,
      score: options.score,
      factors: {},
      trendDirection: 'stable',
      calculatedAt: options.calculatedAt,
    })
    .returning({ id: userRiskScores.id });
  if (!row) throw new Error('insertSnapshot returned no row');
  return row.id;
}

async function selectSnapshots(orgId: string, userId: string) {
  return getTestDb()
    .select({ id: userRiskScores.id, calculatedAt: userRiskScores.calculatedAt, score: userRiskScores.score })
    .from(userRiskScores)
    .where(and(eq(userRiskScores.orgId, orgId), eq(userRiskScores.userId, userId)))
    .orderBy(userRiskScores.calculatedAt);
}

async function runCompaction(options: { retentionDays: number; batchSize?: number; maxBatches?: number }) {
  return withSystemDbAccessContext(() => compactUserRiskSnapshots(options));
}

describe('user risk retention compaction integration', () => {
  let orgId: string;
  let userId: string;
  let otherUserId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, name: 'User Risk Retention Org' });
    orgId = org.id;
    userId = (await createUser({ partnerId: partner.id, orgId, email: `urr-${Date.now()}-a@example.com` })).id;
    otherUserId = (await createUser({ partnerId: partner.id, orgId, email: `urr-${Date.now()}-b@example.com` })).id;
  });

  it('keeps the most recent snapshot per (org,user,day) for rows older than the cutoff', async () => {
    // Three snapshots on the SAME old day — only the latest (12:00) should survive.
    const oldDay = new Date(Date.now() - 60 * DAY_MS);
    const morning = new Date(oldDay); morning.setUTCHours(8, 0, 0, 0);
    const noon = new Date(oldDay); noon.setUTCHours(12, 0, 0, 0);
    const earlyMorning = new Date(oldDay); earlyMorning.setUTCHours(2, 0, 0, 0);

    await insertSnapshot({ orgId, userId, score: 10, calculatedAt: earlyMorning });
    await insertSnapshot({ orgId, userId, score: 20, calculatedAt: morning });
    const survivor = await insertSnapshot({ orgId, userId, score: 30, calculatedAt: noon });

    const result = await runCompaction({ retentionDays: 30 });

    expect(result.deleted).toBe(2);
    const remaining = await selectSnapshots(orgId, userId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(survivor);
    expect(remaining[0]!.score).toBe(30);
  });

  it('keeps one-per-day across multiple old days and never touches rows newer than the cutoff', async () => {
    const dayA = new Date(Date.now() - 70 * DAY_MS);
    const dayB = new Date(Date.now() - 65 * DAY_MS);

    const dayA1 = new Date(dayA); dayA1.setUTCHours(3, 0, 0, 0);
    const dayA2 = new Date(dayA); dayA2.setUTCHours(21, 0, 0, 0);
    const dayB1 = new Date(dayB); dayB1.setUTCHours(1, 0, 0, 0);
    const dayB2 = new Date(dayB); dayB2.setUTCHours(9, 0, 0, 0);
    const dayB3 = new Date(dayB); dayB3.setUTCHours(23, 0, 0, 0);

    await insertSnapshot({ orgId, userId, score: 1, calculatedAt: dayA1 });
    const survivorA = await insertSnapshot({ orgId, userId, score: 2, calculatedAt: dayA2 });
    await insertSnapshot({ orgId, userId, score: 3, calculatedAt: dayB1 });
    await insertSnapshot({ orgId, userId, score: 4, calculatedAt: dayB2 });
    const survivorB = await insertSnapshot({ orgId, userId, score: 5, calculatedAt: dayB3 });

    // Two recent snapshots inside the retention window — must be left untouched
    // even though they are the same day.
    const recent = new Date(Date.now() - 1 * DAY_MS);
    const recent1 = new Date(recent); recent1.setUTCHours(6, 0, 0, 0);
    const recent2 = new Date(recent); recent2.setUTCHours(18, 0, 0, 0);
    const recentId1 = await insertSnapshot({ orgId, userId, score: 6, calculatedAt: recent1 });
    const recentId2 = await insertSnapshot({ orgId, userId, score: 7, calculatedAt: recent2 });

    const result = await runCompaction({ retentionDays: 30 });

    // dayA dropped 1, dayB dropped 2 => 3 deleted total.
    expect(result.deleted).toBe(3);
    const remaining = await selectSnapshots(orgId, userId);
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).toContain(survivorA);
    expect(remainingIds).toContain(survivorB);
    expect(remainingIds).toContain(recentId1);
    expect(remainingIds).toContain(recentId2);
    expect(remaining).toHaveLength(4);
  });

  it('partitions per-user so one user\'s duplicates do not affect another', async () => {
    const oldDay = new Date(Date.now() - 50 * DAY_MS);
    const t1 = new Date(oldDay); t1.setUTCHours(4, 0, 0, 0);
    const t2 = new Date(oldDay); t2.setUTCHours(16, 0, 0, 0);

    await insertSnapshot({ orgId, userId, score: 11, calculatedAt: t1 });
    const userSurvivor = await insertSnapshot({ orgId, userId, score: 12, calculatedAt: t2 });
    // Other user has a single snapshot the same old day — must survive intact.
    const otherSurvivor = await insertSnapshot({ orgId, userId: otherUserId, score: 99, calculatedAt: t1 });

    const result = await runCompaction({ retentionDays: 30 });

    expect(result.deleted).toBe(1);
    const userRows = await selectSnapshots(orgId, userId);
    expect(userRows.map((r) => r.id)).toEqual([userSurvivor]);
    const otherRows = await selectSnapshots(orgId, otherUserId);
    expect(otherRows.map((r) => r.id)).toEqual([otherSurvivor]);
  });

  it('is a no-op when every old day already has a single snapshot', async () => {
    const dayA = new Date(Date.now() - 80 * DAY_MS);
    const dayB = new Date(Date.now() - 75 * DAY_MS);
    const a = new Date(dayA); a.setUTCHours(10, 0, 0, 0);
    const b = new Date(dayB); b.setUTCHours(10, 0, 0, 0);
    await insertSnapshot({ orgId, userId, score: 1, calculatedAt: a });
    await insertSnapshot({ orgId, userId, score: 2, calculatedAt: b });

    const result = await runCompaction({ retentionDays: 30 });

    expect(result.deleted).toBe(0);
    const remaining = await selectSnapshots(orgId, userId);
    expect(remaining).toHaveLength(2);
  });
});
