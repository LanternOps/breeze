import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import { deviceReliabilityHistory, devices } from '../../db/schema';
import { pruneReliabilityHistory } from '../../jobs/reliabilityRetention';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;

let agentCounter = 0;
async function insertDevice(orgId: string, siteId: string): Promise<string> {
  agentCounter++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `reliability-retention-${Date.now()}-${agentCounter}`,
      hostname: `reliability-retention-host-${agentCounter}`,
      displayName: `reliability-retention-host-${agentCounter}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice returned no row');
  return row.id;
}

async function insertHistory(orgId: string, deviceId: string, collectedAt: Date): Promise<string> {
  const [row] = await getTestDb()
    .insert(deviceReliabilityHistory)
    .values({
      orgId,
      deviceId,
      collectedAt,
      uptimeSeconds: 3600,
      bootTime: new Date(collectedAt.getTime() - 3600 * 1000),
    })
    .returning({ id: deviceReliabilityHistory.id });
  if (!row) throw new Error('insertHistory returned no row');
  return row.id;
}

async function selectHistoryIds(orgId: string) {
  return (
    await getTestDb()
      .select({ id: deviceReliabilityHistory.id })
      .from(deviceReliabilityHistory)
      .where(eq(deviceReliabilityHistory.orgId, orgId))
  ).map((r) => r.id);
}

async function runPrune(retentionDays: number) {
  return withSystemDbAccessContext(() => pruneReliabilityHistory({ retentionDays }));
}

describe('reliability history retention pruning integration', () => {
  let orgId: string;
  let deviceId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, name: 'Reliability Retention Org' });
    orgId = org.id;
    const site = await createSite({ orgId, name: 'Reliability Site' });
    deviceId = await insertDevice(orgId, site.id);
  });

  it('deletes only history rows older than the cutoff by collected_at', async () => {
    // retentionDays clamps to a 30-day minimum.
    const old = new Date(Date.now() - 50 * DAY_MS);
    const recent = new Date(Date.now() - 3 * DAY_MS);

    const oldId = await insertHistory(orgId, deviceId, old);
    const recentId = await insertHistory(orgId, deviceId, recent);

    const result = await runPrune(30);

    expect(result.deleted).toBe(1);
    const remaining = await selectHistoryIds(orgId);
    expect(remaining).toEqual([recentId]);
    expect(remaining).not.toContain(oldId);
  });

  it('keeps a row just-newer than the cutoff and deletes one just-older', async () => {
    const retentionDays = 45;
    const cutoffMs = Date.now() - retentionDays * DAY_MS;
    const justNewer = new Date(cutoffMs + 5 * 60 * 1000);
    const justOlder = new Date(cutoffMs - 5 * 60 * 1000);

    const survivor = await insertHistory(orgId, deviceId, justNewer);
    const victim = await insertHistory(orgId, deviceId, justOlder);

    const result = await runPrune(retentionDays);

    expect(result.deleted).toBe(1);
    const remaining = await selectHistoryIds(orgId);
    expect(remaining).toEqual([survivor]);
    expect(remaining).not.toContain(victim);
  });

  it('is a no-op when nothing is older than the cutoff', async () => {
    await insertHistory(orgId, deviceId, new Date(Date.now() - 2 * DAY_MS));

    const result = await runPrune(30);

    expect(result.deleted).toBe(0);
    expect(await selectHistoryIds(orgId)).toHaveLength(1);
  });
});
