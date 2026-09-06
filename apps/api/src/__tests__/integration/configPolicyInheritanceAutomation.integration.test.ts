/**
 * Config-policy automation execution identity under inheritance (#5080 W02),
 * against real Postgres.
 *
 * Through `config_policy_effective_feature_links` one automation feature-link
 * id belongs to the authoring parent AND every child inheriting it. The unit
 * suite (jobs/automationWorker.executionIdentity.test.ts) proves the query
 * shapes and the job-id format against mocks. This proves the composition
 * against a real database, where the view actually fans one parent link out
 * across children:
 *
 *  - one scheduled tick produces one dispatch PER assigned child, with distinct
 *    BullMQ job ids — the same-id collapse would silently drop every child but
 *    one, and no unit mock can produce the fan-out that makes the collision
 *    possible in the first place;
 *  - each dispatch resolves only its OWN org's devices, so the #2286 ownership
 *    clamp reads the child's org rather than the parent's;
 *  - a device covered by BOTH a parent's and a child's assignment of the same
 *    inherited automation runs it exactly ONCE.
 *
 * `bullmq` is stubbed to a recording queue: the assertions are about which jobs
 * would be enqueued with which ids, and a real queue would need Redis state
 * this test has no business owning. Everything below the queue — the view, RLS,
 * the hierarchy resolution, device resolution — is real.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, inArray } from 'drizzle-orm';

interface RecordedJob {
  name: string;
  data: Record<string, unknown>;
  opts: { jobId?: string };
}
const recordedJobs: RecordedJob[] = [];

vi.mock('bullmq', () => ({
  Queue: class {
    async add(name: string, data: Record<string, unknown>, opts: { jobId?: string } = {}) {
      recordedJobs.push({ name, data, opts });
      return { id: opts.jobId ?? randomUUID() };
    }
    async getJob() {
      return null;
    }
  },
  Worker: class {},
  Job: class {},
}));

// The stubbed Queue never uses its connection options, but building them would
// open a real ioredis client this suite has no use for. Only that one factory
// is replaced; the rest of the module stays real.
vi.mock('../../services/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/redis')>()),
  getBullMQConnection: () => ({}),
}));

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAutomations,
  devices,
} from '../../db/schema';
import { __testOnly, collectDueConfigPolicyScheduleDispatches } from '../../jobs/automationWorker';
import { scanScheduledAutomations } from '../../services/featureConfigResolver';
import { createPartner, createOrganization, createSite } from './db-utils';

const { processTriggerConfigPolicySchedule } = __testOnly;

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

// Every minute is due, so the scan is deterministic regardless of wall clock.
const CRON_EVERY_MINUTE = '* * * * *';
const SCAN_DATE = new Date('2026-01-01T10:00:00Z');
const SLOT_KEY = '202601011000';

const createdPolicies: string[] = [];
const createdDevices: string[] = [];

beforeEach(() => {
  recordedJobs.length = 0;
});

afterEach(async () => {
  const deviceIds = [...createdDevices];
  const policyIds = [...createdPolicies];
  createdDevices.length = 0;
  createdPolicies.length = 0;

  if (deviceIds.length > 0) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(devices).where(inArray(devices.id, deviceIds)));
  }
  if (policyIds.length === 0) return;

  // Children before parents: the self-FK is NO ACTION.
  const surviving = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: configurationPolicies.id, parentPolicyId: configurationPolicies.parentPolicyId })
      .from(configurationPolicies)
      .where(inArray(configurationPolicies.id, policyIds)));
  const ordered = [
    ...surviving.filter((r) => r.parentPolicyId !== null),
    ...surviving.filter((r) => r.parentPolicyId === null),
  ];
  for (const row of ordered) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(configurationPolicies).where(eq(configurationPolicies.id, row.id)));
  }
});

async function seedPolicy(values: {
  orgId?: string | null;
  partnerId?: string | null;
  name: string;
  parentPolicyId?: string | null;
}): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = await db
      .insert(configurationPolicies)
      .values({
        orgId: values.orgId ?? null,
        partnerId: values.partnerId ?? null,
        name: values.name,
        parentPolicyId: values.parentPolicyId ?? null,
      })
      .returning({ id: configurationPolicies.id });
    createdPolicies.push(row!.id);
    return row!.id;
  });
}

/** An automation feature link plus one scheduled automation hanging off it. */
async function seedScheduledAutomation(configPolicyId: string, name: string): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId, featureType: 'automation' })
      .returning({ id: configPolicyFeatureLinks.id });
    const [automation] = await db
      .insert(configPolicyAutomations)
      .values({
        featureLinkId: link!.id,
        name,
        enabled: true,
        triggerType: 'schedule',
        cronExpression: CRON_EVERY_MINUTE,
        timezone: 'UTC',
        actions: [],
        sortOrder: 0,
      })
      .returning({ id: configPolicyAutomations.id });
    return automation!.id;
  });
}

async function seedAssignment(
  configPolicyId: string,
  level: 'partner' | 'organization' | 'site',
  targetId: string,
): Promise<void> {
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(configPolicyAssignments).values({ configPolicyId, level, targetId, priority: 0 }));
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const suffix = randomUUID().slice(0, 8);
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-cpa-${suffix}`,
        hostname: `host-cpa-${suffix}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole: 'workstation',
      })
      .returning({ id: devices.id });
    createdDevices.push(row!.id);
    return row!.id;
  });
}

/** The dispatches this tick would produce for one automation, scan → group. */
async function dispatchesFor(automationId: string) {
  const candidates = await withDbAccessContext(SYSTEM_CTX, () => scanScheduledAutomations());
  return collectDueConfigPolicyScheduleDispatches(
    candidates.filter((c) => c.automation.id === automationId),
    SCAN_DATE,
  );
}

function triggerJobData(dispatch: { configPolicyAutomationId: string; configPolicyAutomationName: string; assignmentTargets: unknown[]; policyId: string; policyName: string }) {
  return {
    type: 'trigger-config-policy-schedule' as const,
    configPolicyAutomationId: dispatch.configPolicyAutomationId,
    configPolicyAutomationName: dispatch.configPolicyAutomationName,
    assignmentTargets: dispatch.assignmentTargets,
    policyId: dispatch.policyId,
    policyName: dispatch.policyName,
    configPolicyId: dispatch.policyId,
    slotKey: SLOT_KEY,
    scanAt: SCAN_DATE.toISOString(),
  } as never;
}

describe('config policy inheritance — automation execution identity (live DB)', () => {
  it('one inherited automation, two children: two dispatches with distinct job ids, each scoped to its own org', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const deviceA = await seedDevice(orgA.id, siteA.id);
    const deviceB = await seedDevice(orgB.id, siteB.id);

    // ONE partner-wide baseline authors the automation. Two org children
    // inherit it; neither has an automation link of its own.
    const baseline = await seedPolicy({ partnerId: partner.id, name: 'MSP baseline' });
    const automationId = await seedScheduledAutomation(baseline, 'Nightly reboot');
    const childA = await seedPolicy({ orgId: orgA.id, name: 'A child', parentPolicyId: baseline });
    const childB = await seedPolicy({ orgId: orgB.id, name: 'B child', parentPolicyId: baseline });
    await seedAssignment(childA, 'organization', orgA.id);
    await seedAssignment(childB, 'organization', orgB.id);

    const dispatches = await dispatchesFor(automationId);

    // The fan-out itself: the view surfaced the parent's single link once per
    // child, so the scan produced two candidates and the grouping kept them apart.
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((d) => d.policyId).sort()).toEqual([childA, childB].sort());

    for (const dispatch of dispatches) {
      await withDbAccessContext(SYSTEM_CTX, () =>
        processTriggerConfigPolicySchedule(triggerJobData(dispatch)));
    }

    const runJobs = recordedJobs.filter((j) => j.name === 'execute-config-policy-run');
    expect(runJobs).toHaveLength(2);

    // Distinct job ids — with the pre-#5080 `<automation>:<slot>` key these two
    // would collide and BullMQ would drop the second child's run entirely.
    const jobIds = runJobs.map((j) => j.opts.jobId);
    expect(new Set(jobIds).size).toBe(2);
    expect(jobIds.sort()).toEqual([
      `cp-automation-run:${automationId}:${childA}:${SLOT_KEY}`,
      `cp-automation-run:${automationId}:${childB}:${SLOT_KEY}`,
    ].sort());

    // Each run carries its own assigned policy and only its own org's device.
    const byPolicy = new Map(runJobs.map((j) => [j.data.configPolicyId as string, j.data]));
    expect(byPolicy.get(childA)!.targetDeviceIds).toEqual([deviceA]);
    expect(byPolicy.get(childB)!.targetDeviceIds).toEqual([deviceB]);
  });

  it('a device covered by BOTH the parent and the child runs the automation once', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id);

    // Parent assigned at ORG level; child (which inherits the automation)
    // assigned at SITE level. Both dispatches reach this device.
    const baseline = await seedPolicy({ partnerId: partner.id, name: 'MSP baseline' });
    const automationId = await seedScheduledAutomation(baseline, 'Nightly reboot');
    const child = await seedPolicy({ orgId: org.id, name: 'Site child', parentPolicyId: baseline });
    await seedAssignment(baseline, 'organization', org.id);
    await seedAssignment(child, 'site', site.id);

    const dispatches = await dispatchesFor(automationId);
    expect(dispatches).toHaveLength(2);

    for (const dispatch of dispatches) {
      await withDbAccessContext(SYSTEM_CTX, () =>
        processTriggerConfigPolicySchedule(triggerJobData(dispatch)));
    }

    const runJobs = recordedJobs.filter((j) => j.name === 'execute-config-policy-run');

    // Exactly one run, and it is the CHILD's — site beats organization in the
    // hierarchy, so the child's assignment is the winning one.
    expect(runJobs).toHaveLength(1);
    expect(runJobs[0]!.data.configPolicyId).toBe(child);
    expect(runJobs[0]!.data.targetDeviceIds).toEqual([device]);
  });

  it('a child that authors its OWN automation link no longer runs the parent\'s', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    await seedDevice(org.id, site.id);

    const baseline = await seedPolicy({ partnerId: partner.id, name: 'MSP baseline' });
    const parentAutomationId = await seedScheduledAutomation(baseline, 'Parent reboot');
    const child = await seedPolicy({ orgId: org.id, name: 'Overriding child', parentPolicyId: baseline });
    await seedScheduledAutomation(child, 'Child reboot');
    await seedAssignment(child, 'organization', org.id);

    // The child overrides the whole `automation` feature type, so the parent's
    // automation is not effective for it and produces no dispatch at all.
    expect(await dispatchesFor(parentAutomationId)).toEqual([]);
  });

  it('a stale dispatch for a policy that has since overridden the feature is skipped, not run', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    await seedDevice(org.id, site.id);

    const baseline = await seedPolicy({ partnerId: partner.id, name: 'MSP baseline' });
    const automationId = await seedScheduledAutomation(baseline, 'Nightly reboot');
    const child = await seedPolicy({ orgId: org.id, name: 'Child', parentPolicyId: baseline });
    await seedAssignment(child, 'organization', org.id);

    const [dispatch] = await dispatchesFor(automationId);
    expect(dispatch).toBeDefined();

    // Between enqueue and run the child authors its own automation link, so the
    // parent's automation stops being effective for it.
    await seedScheduledAutomation(child, 'Child reboot');

    const result = await withDbAccessContext(SYSTEM_CTX, () =>
      processTriggerConfigPolicySchedule(triggerJobData(dispatch!)));

    expect(result).toEqual({ skipped: 'automation_not_effective_for_policy' });
    expect(recordedJobs.filter((j) => j.name === 'execute-config-policy-run')).toHaveLength(0);
  });

  it('a dispatch for an archived policy is skipped', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    await seedDevice(org.id, site.id);

    const baseline = await seedPolicy({ partnerId: partner.id, name: 'MSP baseline' });
    const automationId = await seedScheduledAutomation(baseline, 'Nightly reboot');
    const child = await seedPolicy({ orgId: org.id, name: 'Child', parentPolicyId: baseline });
    await seedAssignment(child, 'organization', org.id);

    const [dispatch] = await dispatchesFor(automationId);
    expect(dispatch).toBeDefined();

    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(configurationPolicies)
        .set({ status: 'archived' })
        .where(eq(configurationPolicies.id, child)));

    const result = await withDbAccessContext(SYSTEM_CTX, () =>
      processTriggerConfigPolicySchedule(triggerJobData(dispatch!)));

    expect(result).toEqual({ skipped: 'config_policy_not_found' });
    expect(recordedJobs.filter((j) => j.name === 'execute-config-policy-run')).toHaveLength(0);
  });
});
