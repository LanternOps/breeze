import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { withSystemDbAccessContext } from '../../db';
import { devices, metricAnomalies, remediationSuggestions } from '../../db/schema';
import { pruneMlOutputs } from '../../jobs/mlOutputRetention';
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
      agentId: `ml-retention-${Date.now()}-${agentCounter}`,
      hostname: `ml-retention-host-${agentCounter}`,
      displayName: `ml-retention-host-${agentCounter}`,
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

async function insertRemediation(orgId: string, deviceId: string, createdAt: Date): Promise<string> {
  const [row] = await getTestDb()
    .insert(remediationSuggestions)
    .values({
      orgId,
      sourceType: 'alert',
      sourceId: `src-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      deviceId,
      // 'diagnostic' target needs no script/template/playbook FK
      // (remediation_suggestions_target_check).
      targetType: 'diagnostic',
      title: 'Test remediation',
      rationale: 'because',
      expectedAction: 'do the thing',
      createdAt,
      updatedAt: createdAt,
    })
    .returning({ id: remediationSuggestions.id });
  if (!row) throw new Error('insertRemediation returned no row');
  return row.id;
}

async function insertAnomaly(orgId: string, deviceId: string, detectedAt: Date): Promise<string> {
  const [row] = await getTestDb()
    .insert(metricAnomalies)
    .values({
      orgId,
      deviceId,
      metricType: 'cpu',
      metricName: 'cpu_percent',
      anomalyType: 'spike',
      windowStart: new Date(detectedAt.getTime() - 300_000),
      windowEnd: detectedAt,
      observedValue: 99,
      score: 4.2,
      confidence: 0.9,
      detectedAt,
      updatedAt: detectedAt,
    })
    .returning({ id: metricAnomalies.id });
  if (!row) throw new Error('insertAnomaly returned no row');
  return row.id;
}

async function selectRemediationIds(orgId: string) {
  return (
    await getTestDb()
      .select({ id: remediationSuggestions.id })
      .from(remediationSuggestions)
      .where(eq(remediationSuggestions.orgId, orgId))
  ).map((r) => r.id);
}

async function selectAnomalyIds(orgId: string) {
  return (
    await getTestDb()
      .select({ id: metricAnomalies.id })
      .from(metricAnomalies)
      .where(eq(metricAnomalies.orgId, orgId))
  ).map((r) => r.id);
}

async function runPrune(retentionDays: number) {
  return withSystemDbAccessContext(() => pruneMlOutputs({ retentionDays }));
}

describe('ML output retention pruning integration', () => {
  let orgId: string;
  let deviceId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, name: 'ML Output Retention Org' });
    orgId = org.id;
    const site = await createSite({ orgId, name: 'ML Output Site' });
    deviceId = await insertDevice(orgId, site.id);
  });

  it('deletes only rows older than the cutoff by created_at / detected_at', async () => {
    // retentionDays clamps to a 30-day minimum, so use ages on either side of 30 days.
    const old = new Date(Date.now() - 45 * DAY_MS);
    const recent = new Date(Date.now() - 5 * DAY_MS);

    const oldRemediation = await insertRemediation(orgId, deviceId, old);
    const recentRemediation = await insertRemediation(orgId, deviceId, recent);
    const oldAnomaly = await insertAnomaly(orgId, deviceId, old);
    const recentAnomaly = await insertAnomaly(orgId, deviceId, recent);

    const result = await runPrune(30);

    expect(result.deleted).toBe(2);
    const remediationTable = result.tables.find((t) => t.table === 'remediation_suggestions');
    const anomalyTable = result.tables.find((t) => t.table === 'metric_anomalies');
    expect(remediationTable?.deleted).toBe(1);
    expect(anomalyTable?.deleted).toBe(1);

    const remediationIds = await selectRemediationIds(orgId);
    expect(remediationIds).toEqual([recentRemediation]);
    expect(remediationIds).not.toContain(oldRemediation);

    const anomalyIds = await selectAnomalyIds(orgId);
    expect(anomalyIds).toEqual([recentAnomaly]);
    expect(anomalyIds).not.toContain(oldAnomaly);
  });

  it('keeps rows exactly at/after the boundary (just-newer than cutoff survives)', async () => {
    // Cutoff is now - retentionDays. A row a few minutes newer than the cutoff
    // must survive; one a few minutes older must be deleted.
    const retentionDays = 40;
    const cutoffMs = Date.now() - retentionDays * DAY_MS;
    const justNewer = new Date(cutoffMs + 5 * 60 * 1000);
    const justOlder = new Date(cutoffMs - 5 * 60 * 1000);

    const survivor = await insertRemediation(orgId, deviceId, justNewer);
    const victim = await insertRemediation(orgId, deviceId, justOlder);

    const result = await runPrune(retentionDays);

    const remediationTable = result.tables.find((t) => t.table === 'remediation_suggestions');
    expect(remediationTable?.deleted).toBe(1);
    const remaining = await selectRemediationIds(orgId);
    expect(remaining).toEqual([survivor]);
    expect(remaining).not.toContain(victim);
  });

  it('is a no-op when nothing is older than the cutoff', async () => {
    const recent = new Date(Date.now() - 2 * DAY_MS);
    await insertRemediation(orgId, deviceId, recent);
    await insertAnomaly(orgId, deviceId, recent);

    const result = await runPrune(30);

    expect(result.deleted).toBe(0);
    expect(await selectRemediationIds(orgId)).toHaveLength(1);
    expect(await selectAnomalyIds(orgId)).toHaveLength(1);
  });
});
