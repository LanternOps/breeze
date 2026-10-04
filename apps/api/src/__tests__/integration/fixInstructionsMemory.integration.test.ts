// apps/api/src/__tests__/integration/fixInstructionsMemory.integration.test.ts
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { alerts, deviceMetrics, devices, fixMemory, fixOutcomes, remediationSuggestions } from '../../db/schema';
import { saveReviewedInstructions } from '../../services/fixMemory/instructions';
import { createManualStepsOutcome } from '../../services/fixMemory/outcomeRecorder';
import { advanceOutcome } from '../../services/fixMemory/outcomeWatcher';
import { createOrganization, createPartner, createSite } from './db-utils';

const H = 3_600_000;
const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function doneAndVerify(orgId: string, partnerId: string, instructionsId: string | null, t0: Date) {
  const site = await createSite({ orgId });
  const [d] = await sys(() => db.insert(devices).values({
    orgId, siteId: site.id, agentId: randomUUID(), hostname: `h-${randomUUID().slice(0, 6)}`, osType: 'windows', osVersion: '11',
    architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id }));
  const watched = createHash('sha256').update(partnerId).digest('hex').slice(0, 8); // same monitored script → same signature
  const [a] = await sys(() => db.insert(alerts).values({
    orgId, deviceId: d!.id, severity: 'high', title: 'exit 3', triggeredAt: new Date(t0.getTime() - H),
    context: { source: 'script_exit_code', scriptId: `00000000-0000-4000-8000-0000${watched}`, exitCode: 3 },
  }).returning({ id: alerts.id }));
  const [s] = await sys(() => db.insert(remediationSuggestions).values({
    orgId, sourceType: 'alert', sourceId: a!.id, alertId: a!.id, deviceId: d!.id, targetDeviceIds: [d!.id], targetType: 'manual_steps',
    title: 'steps', rationale: 'r', expectedAction: 'e', riskTier: 'low', status: 'accepted', parameters: { steps: ['a'] }, origin: 'ai_research',
  }).returning());
  const outcome = await sys(() => createManualStepsOutcome({ suggestion: s!, deviceId: d!.id, instructionsId }));
  expect(outcome?.state).toBe('awaiting_recovery');
  const [o] = await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.suggestionId, s!.id)));
  await sys(() => db.update(fixOutcomes).set({ createdAt: t0 }).where(eq(fixOutcomes.id, o!.id)));
  await sys(() => db.update(alerts).set({ status: 'resolved', resolvedAt: new Date(t0.getTime() + H), resolutionReason: 'condition_cleared' }).where(eq(alerts.id, a!.id)));
  expect(await advanceOutcome(o!.id, { now: new Date(t0.getTime() + 2 * H) })).toBe('holding');
  const rows: (typeof deviceMetrics.$inferInsert)[] = [];
  for (let t = t0.getTime() + H; t < t0.getTime() + 25 * H; t += 30 * 60_000) {
    rows.push({ deviceId: d!.id, orgId, timestamp: new Date(t), cpuPercent: 5, ramPercent: 40, ramUsedMb: 2048, diskPercent: 50, diskUsedGb: 100 });
  }
  await sys(() => db.insert(deviceMetrics).values(rows).onConflictDoNothing());
  await sys(() => db.update(devices).set({ lastSeenAt: new Date(t0.getTime() + 25 * H - 5 * 60_000) }).where(eq(devices.id, d!.id)));
  expect(await advanceOutcome(o!.id, { now: new Date(t0.getTime() + 25 * H + 60_000) })).toBe('verified');
}

describe('reviewed steps and fix memory (real Postgres)', () => {
  it('Done on reviewed steps aggregates partner-wide', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const reviewed = await sys(() => saveReviewedInstructions({ partnerId: partner.id, reviewedBy: null as never, title: 'Clear print queue', steps: ['Stop', 'Clear', 'Start'], osType: 'windows' }));
    await doneAndVerify(org.id, partner.id, reviewed.id, new Date(Date.UTC(2026, 10, 3)));
    const memory = await sys(() => db.select().from(fixMemory).where(eq(fixMemory.partnerId, partner.id)));
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({ orgId: null, fixKind: 'manual_steps', instructionsRef: reviewed.id, verifiedCount: 1 });
  });

  it('unreviewed AI manual steps never aggregate', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await doneAndVerify(org.id, partner.id, null, new Date(Date.UTC(2026, 10, 3)));
    expect(await sys(() => db.select().from(fixMemory).where(eq(fixMemory.partnerId, partner.id)))).toEqual([]);
  });
});
