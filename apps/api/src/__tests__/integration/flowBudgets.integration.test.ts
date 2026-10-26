/**
 * Tool Catalog W05 (#5220), plan Task A8 — the exact monthly run counters
 * against REAL Postgres: `createFlowRun` takes the owner's admission lock,
 * pre-checks, inserts the run and charges (`chargeFlowRun`) in ONE system
 * transaction, so two replicas racing at cap-1 admit exactly one and a
 * duplicate delivery never charges. Also the counters' RLS reach (the
 * conditional connection_health_incidents policy) and the org-merge placement
 * (counters and deliveries stay with the loser).
 * migrations/2027-01-07-140000-flow-webhooks-tools-budgets.sql
 *
 * Branch logic (limits resolver, refusal marker, notices) is unit-tested:
 * flowLimits.test.ts, budgets.test.ts, runService.test.ts.
 */
import './setup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';

vi.mock('../../jobs/flowRunQueue', () => ({ enqueueFlowRunSlice: vi.fn(async () => 'job') }));

import { flowUsagePeriodKey } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { flowRuns, flowUsageCounters, flowVersions, flowWebhookDeliveries, flows, partners } from '../../db/schema';
import { encryptFlowWebhookSecret } from '../../services/flows/webhook/secret';
import { hmacFingerprint } from '../../services/secretCrypto';
import { createFlowRun } from '../../services/flows/runService';
import { CUSTOM_EXECUTORS, CUSTOM_RESOLVE_EXECUTORS } from '../../services/orgMergeCustomExecutors';
import { buildRepoint } from '../../services/orgMergeExecutors';
import { sql } from 'drizzle-orm';
import { createOrganization, createPartner, createUser } from './db-utils';
import { seedEnabledFlow } from './helpers/flowSeed';
import { orgContext, partnerContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PIN = { stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;
const STEP = { id: 'look', tool: 'list_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 };

function eventDoc(limits?: { monthlyRuns: number }) {
  return {
    version: 1, name: 'On event', trigger: { type: 'event', event: 'alert.triggered', filter: {} }, inputs: [], steps: [STEP],
    ...(limits ? { limits } : {}),
  };
}

let prevFlag: string | undefined;
beforeAll(() => {
  prevFlag = process.env.FLOWS_ENABLED;
  process.env.FLOWS_ENABLED = 'true';
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.FLOWS_ENABLED;
  else process.env.FLOWS_ENABLED = prevFlag;
});

async function tenant() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const delegator = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `delegator-${randomUUID()}@flowbudgets.test` });
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, delegatorId: delegator.id };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

const eventRun = (flowId: string, orgId: string, dedupeKey: string) => ({
  triggerKind: 'event' as const, flowId, orgId, scope: { firedAt: new Date().toISOString() },
  inputs: {}, dedupeKey, chainDepth: 0, causedByRunId: null,
});

const period = () => flowUsagePeriodKey(new Date());

const countersOf = (partnerId: string) =>
  withSystemDbAccessContext(() => db.select().from(flowUsageCounters).where(eq(flowUsageCounters.partnerId, partnerId)));

const runsOf = (flowId: string) => withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)));

function seedCounter(c: { partnerId: string; orgId: string | null; flowId: string | null; runs: number }) {
  return withSystemDbAccessContext(() => db.insert(flowUsageCounters).values({ ...c, periodKey: period() }));
}

describe('flow monthly caps (real Postgres)', () => {
  runDb('concurrent creations at cap-1 admit exactly one', async () => {
    const t = await tenant();
    const CAP = 5;
    const { flowId } = await seedEnabledFlow({
      orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc({ monthlyRuns: CAP }), pins: [PIN],
    });
    await seedCounter({ partnerId: t.partnerId, orgId: t.orgA, flowId, runs: CAP - 1 });

    // createFlowRun opens its own system transaction on its own pooled connection each.
    const results = await Promise.all([
      createFlowRun(eventRun(flowId, t.orgA, 'event:race-1')),
      createFlowRun(eventRun(flowId, t.orgA, 'event:race-2')),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toEqual([{ created: false, reason: 'flow_monthly_cap_reached' }]);

    const counters = await countersOf(t.partnerId);
    expect(counters.find((c) => c.flowId === flowId)).toMatchObject({ runs: CAP, orgId: t.orgA, periodKey: period() });
    // Exactly one new run row; the refused creation rolled back with its charge.
    expect(await runsOf(flowId)).toHaveLength(1);
    // The refusal marked the flow for the banner and did NOT pause it.
    const [flow] = await withSystemDbAccessContext(() => db.select().from(flows).where(eq(flows.id, flowId)));
    expect(flow).toMatchObject({ status: 'enabled', lastAdmissionRefusalCode: 'flow_monthly_cap_reached' });
  });

  runDb('a creation at the cap is refused and leaves the counter and run table untouched', async () => {
    const t = await tenant();
    const { flowId } = await seedEnabledFlow({
      orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc({ monthlyRuns: 2 }), pins: [PIN],
    });
    expect(await createFlowRun(eventRun(flowId, t.orgA, 'event:1'))).toMatchObject({ created: true });
    expect(await createFlowRun(eventRun(flowId, t.orgA, 'event:2'))).toMatchObject({ created: true });
    expect(await createFlowRun(eventRun(flowId, t.orgA, 'event:3'))).toEqual({ created: false, reason: 'flow_monthly_cap_reached' });
    expect((await countersOf(t.partnerId)).find((c) => c.flowId === flowId)?.runs).toBe(2);
    expect(await runsOf(flowId)).toHaveLength(2);
  });

  runDb('duplicate event never charges', async () => {
    const t = await tenant();
    const { flowId } = await seedEnabledFlow({
      orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc({ monthlyRuns: 10 }), pins: [PIN],
    });
    const first = await createFlowRun(eventRun(flowId, t.orgA, 'event:same'));
    expect(first).toMatchObject({ created: true });
    const second = await createFlowRun(eventRun(flowId, t.orgA, 'event:same'));
    expect(second).toMatchObject({ created: false, reason: 'duplicate', runId: (first as { runId: string }).runId });

    const counters = await countersOf(t.partnerId);
    expect(counters.find((c) => c.flowId === flowId)?.runs).toBe(1);
    expect(counters.find((c) => c.flowId === null)?.runs).toBe(1);
    expect(await runsOf(flowId)).toHaveLength(1);
  });

  runDb('partner-wide flow charges the partner owner row (org_id NULL), whichever org the run is in', async () => {
    const t = await tenant();
    const { flowId } = await seedEnabledFlow({
      owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc(), pins: [PIN],
    });
    expect(await createFlowRun(eventRun(flowId, t.orgA, 'event:a'))).toMatchObject({ created: true });
    expect(await createFlowRun(eventRun(flowId, t.orgB, 'event:b'))).toMatchObject({ created: true });

    const counters = await countersOf(t.partnerId);
    expect(counters).toHaveLength(2);
    expect(counters.every((c) => c.orgId === null)).toBe(true);
    expect(counters.find((c) => c.flowId === flowId)).toMatchObject({ runs: 2, periodKey: period() });
    expect(counters.find((c) => c.flowId === null)).toMatchObject({ runs: 2, periodKey: period() });
  });
});

const setPartnerFlowLimits = (partnerId: string, flowsBlob: Record<string, number>) =>
  withSystemDbAccessContext(() => db.update(partners).set({ settings: { flows: flowsBlob } }).where(eq(partners.id, partnerId)));

describe('owner-total monthly cap exactness (real Postgres)', () => {
  const seedTwo = async (t: Tenant) => {
    const mk = () => seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc(), pins: [PIN] });
    return [await mk(), await mk()] as const;
  };
  const ownerRuns = async (t: Tenant) => (await countersOf(t.partnerId)).find((c) => c.flowId === null)?.runs;

  runDb('an owner cap of 3 across two flows: 2 + 1 admitted, the next on either flow is owner_monthly_cap_reached with the owner row left at 3 and no extra run', async () => {
    const t = await tenant();
    await setPartnerFlowLimits(t.partnerId, { monthlyRunsPerOwner: 3 });
    const [a, b] = await seedTwo(t);

    expect(await createFlowRun(eventRun(a.flowId, t.orgA, 'event:a1'))).toMatchObject({ created: true });
    expect(await createFlowRun(eventRun(a.flowId, t.orgA, 'event:a2'))).toMatchObject({ created: true });
    expect(await createFlowRun(eventRun(b.flowId, t.orgA, 'event:b1'))).toMatchObject({ created: true });
    expect(await ownerRuns(t)).toBe(3);

    expect(await createFlowRun(eventRun(a.flowId, t.orgA, 'event:a3'))).toEqual({ created: false, reason: 'owner_monthly_cap_reached' });
    expect(await createFlowRun(eventRun(b.flowId, t.orgA, 'event:b2'))).toEqual({ created: false, reason: 'owner_monthly_cap_reached' });

    const counters = await countersOf(t.partnerId);
    expect(await ownerRuns(t)).toBe(3);
    expect(counters.find((c) => c.flowId === a.flowId)?.runs).toBe(2);
    expect(counters.find((c) => c.flowId === b.flowId)?.runs).toBe(1);
    expect(await runsOf(a.flowId)).toHaveLength(2);
    expect(await runsOf(b.flowId)).toHaveLength(1);
  });

  runDb('two creations racing on different flows at owner cap-1 admit exactly one', async () => {
    const t = await tenant();
    await setPartnerFlowLimits(t.partnerId, { monthlyRunsPerOwner: 3 });
    const [a, b] = await seedTwo(t);
    expect(await createFlowRun(eventRun(a.flowId, t.orgA, 'event:a1'))).toMatchObject({ created: true });
    expect(await createFlowRun(eventRun(b.flowId, t.orgA, 'event:b1'))).toMatchObject({ created: true });

    const results = await Promise.all([
      createFlowRun(eventRun(a.flowId, t.orgA, 'event:a2')),
      createFlowRun(eventRun(b.flowId, t.orgA, 'event:b2')),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toEqual([{ created: false, reason: 'owner_monthly_cap_reached' }]);
    expect(await ownerRuns(t)).toBe(3);
    expect((await runsOf(a.flowId)).length + (await runsOf(b.flowId)).length).toBe(3);
  });
});

describe('webhook run bound to the verified secret generation and publication (real Postgres)', () => {
  const saved = { id: process.env.APP_ENCRYPTION_KEY_ID, ring: process.env.APP_ENCRYPTION_KEYRING };
  beforeAll(() => {
    process.env.APP_ENCRYPTION_KEY_ID = 'flowbudgets-key';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ 'flowbudgets-key': 'flowbudgets-key-material-0123456789' });
  });
  afterAll(() => {
    if (saved.id === undefined) delete process.env.APP_ENCRYPTION_KEY_ID; else process.env.APP_ENCRYPTION_KEY_ID = saved.id;
    if (saved.ring === undefined) delete process.env.APP_ENCRYPTION_KEYRING; else process.env.APP_ENCRYPTION_KEYRING = saved.ring;
  });

  const webhookDoc = { ...eventDoc(), trigger: { type: 'webhook', auth: 'hmac' } };

  /** What createOrRotateWebhookSecret writes: the three secret columns together (flows_webhook_secret_pair_chk). */
  async function writeSecret(flowId: string, rotatedAt: Date): Promise<void> {
    const secret = `bwh_${randomUUID()}`;
    await withSystemDbAccessContext(() => db.update(flows).set({
      webhookSecretEncrypted: encryptFlowWebhookSecret(flowId, secret),
      webhookSecretFingerprint: hmacFingerprint(secret),
      webhookSecretRotatedAt: rotatedAt,
    }).where(eq(flows.id, flowId)));
  }
  const rotatedAtOf = async (flowId: string): Promise<Date> =>
    (await withSystemDbAccessContext(() => db.select({ r: flows.webhookSecretRotatedAt }).from(flows).where(eq(flows.id, flowId))))[0]!.r!;
  const deliveriesOf = (flowId: string) => withSystemDbAccessContext(() => db.select().from(flowWebhookDeliveries).where(eq(flowWebhookDeliveries.flowId, flowId)));

  const webhookRun = (flowId: string, orgId: string, seq: number, rotatedAt: Date, onCreated: (runId: string) => Promise<void>) => ({
    triggerKind: 'webhook' as const, flowId, orgId, scope: { firedAt: new Date().toISOString() }, inputs: {}, dedupeKey: `webhook:${randomUUID()}`,
    expectedPublicationSeq: seq, expectedSecretRotatedAt: rotatedAt, onCreated,
  });

  runDb('a rotation after verification refuses the delivery (not_enabled, no run, no charge, no delivery); the NEW generation read back from the DB is admitted', async () => {
    const t = await tenant();
    const { flowId } = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: webhookDoc, pins: [PIN] });
    await writeSecret(flowId, new Date());
    const verifiedWith = await rotatedAtOf(flowId); // what the ingress read before verifying

    await new Promise((r) => setTimeout(r, 15));
    await writeSecret(flowId, new Date()); // a rotation lands between verification and insert
    const rotated = await rotatedAtOf(flowId);
    expect(rotated.getTime()).toBeGreaterThan(verifiedWith.getTime());

    const onCreated = vi.fn(async () => {});
    expect(await createFlowRun(webhookRun(flowId, t.orgA, 1, verifiedWith, onCreated))).toEqual({ created: false, reason: 'not_enabled' });
    expect(onCreated).not.toHaveBeenCalled();
    expect(await runsOf(flowId)).toHaveLength(0);
    expect(await countersOf(t.partnerId)).toHaveLength(0);
    expect(await deliveriesOf(flowId)).toHaveLength(0);

    // JS Date ms equality with the stored timestamptz: the value read back is the generation the lock compares.
    expect(await createFlowRun(webhookRun(flowId, t.orgA, 1, rotated, onCreated))).toMatchObject({ created: true });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(await runsOf(flowId)).toHaveLength(1);
    expect((await countersOf(t.partnerId)).find((c) => c.flowId === flowId)?.runs).toBe(1);
  });

  runDb('a re-publish after verification refuses the delivery against the old seq (not_enabled, no run, no charge); the new seq is admitted', async () => {
    const t = await tenant();
    const { flowId } = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: webhookDoc, pins: [PIN] });
    await writeSecret(flowId, new Date());
    const generation = await rotatedAtOf(flowId);

    // Re-publish: a second immutable publication, made the live one.
    await withSystemDbAccessContext(async () => {
      await db.insert(flowVersions).values({
        flowId, orgId: t.orgA, partnerId: null, publicationSeq: 2, definitionVersion: 1, definition: webhookDoc, effectiveTier: 1,
        stepPins: [PIN as unknown as Record<string, unknown>], preApprovals: [], enabledByUserId: t.delegatorId,
      });
      await db.update(flows).set({ enabledPublicationSeq: 2 }).where(eq(flows.id, flowId));
    });

    const onCreated = vi.fn(async () => {});
    expect(await createFlowRun(webhookRun(flowId, t.orgA, 1, generation, onCreated))).toEqual({ created: false, reason: 'not_enabled' });
    expect(onCreated).not.toHaveBeenCalled();
    expect(await runsOf(flowId)).toHaveLength(0);
    expect(await countersOf(t.partnerId)).toHaveLength(0);
    expect(await deliveriesOf(flowId)).toHaveLength(0);

    const ok = await createFlowRun(webhookRun(flowId, t.orgA, 2, generation, onCreated));
    expect(ok).toMatchObject({ created: true });
    const [run] = await runsOf(flowId);
    const [pub2] = await withSystemDbAccessContext(() => db.select().from(flowVersions).where(and(eq(flowVersions.flowId, flowId), eq(flowVersions.publicationSeq, 2))));
    expect(run!.flowVersionId).toBe(pub2!.id);
  });
});

describe('flow_usage_counters RLS (real Postgres)', () => {
  runDb('counters of an org-owned flow are invisible to a sibling org token; a partner-level counter is invisible to any org token', async () => {
    const t = await tenant();
    const orgFlow = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc(), pins: [PIN] });
    const pwFlow = await seedEnabledFlow({ owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc(), pins: [PIN] });
    await createFlowRun(eventRun(orgFlow.flowId, t.orgA, 'event:org'));
    await createFlowRun(eventRun(pwFlow.flowId, t.orgA, 'event:pw'));

    const read = (ctx: Parameters<typeof withDbAccessContext>[0]) =>
      withDbAccessContext(ctx, () => db.select().from(flowUsageCounters).where(eq(flowUsageCounters.partnerId, t.partnerId)));

    // Org A: its own flow row + owner-total row (positive control), but not the partner-level rows.
    const asA = await read(orgContext(t.orgA, t.partnerId));
    expect(asA).toHaveLength(2);
    expect(asA.every((c) => c.orgId === t.orgA)).toBe(true);
    // The sibling org sees nothing.
    expect(await read(orgContext(t.orgB, t.partnerId))).toEqual([]);
    // A partner token reaching org A (selected) sees org A's rows AND the partner-level ones.
    const asPartner = await read(partnerContext(t.partnerId, [t.orgA]));
    expect(asPartner).toHaveLength(4);
    // A partner token with no org access sees only the partner-level rows.
    const noOrgs = await read(partnerContext(t.partnerId, []));
    expect(noOrgs).toHaveLength(2);
    expect(noOrgs.every((c) => c.orgId === null)).toBe(true);
    // Another partner sees none.
    const other = await tenant();
    expect(await read(partnerContext(other.partnerId, [other.orgA]))).toEqual([]);
    expect(await withSystemDbAccessContext(() => db.select().from(flowUsageCounters)
      .where(and(eq(flowUsageCounters.partnerId, t.partnerId), isNull(flowUsageCounters.orgId))))).toHaveLength(2);
  });
});

describe('org merge and the webhook/budget tables (real Postgres, committed)', () => {
  runDb("org merge leaves the loser's counters and deliveries with the loser", async () => {
    const t = await tenant();
    const L = t.orgA;
    const S = t.orgB;
    const { flowId, publicationId } = await seedEnabledFlow({
      orgId: L, partnerId: t.partnerId, delegatorUserId: t.delegatorId,
      definition: { ...eventDoc(), trigger: { type: 'webhook', auth: 'hmac' } }, pins: [PIN],
    });
    // One charged run (counters) and one accepted delivery of it, all in the loser.
    const [run] = await withSystemDbAccessContext(() => db.insert(flowRuns).values({
      orgId: L, flowId, flowVersionId: publicationId, definitionVersion: 1, triggerKind: 'webhook', triggeredVia: 'webhook',
      triggerPayload: {}, inputs: {}, status: 'queued', preApprovalsHonored: false, dedupeKey: `webhook:${randomUUID()}`,
    }).returning({ id: flowRuns.id }));
    await seedCounter({ partnerId: t.partnerId, orgId: L, flowId, runs: 3 });
    await seedCounter({ partnerId: t.partnerId, orgId: L, flowId: null, runs: 3 });
    const sig = 'a'.repeat(64);
    await withSystemDbAccessContext(() => db.insert(flowWebhookDeliveries).values({
      partnerId: t.partnerId, orgId: L, flowId, authMode: 'hmac', signatureDigest: sig, bodySha256: 'b'.repeat(64), bodyBytes: 2,
      status: 'accepted', runId: run!.id,
    }));

    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await CUSTOM_RESOLVE_EXECUTORS.flows!(L, S);
      await CUSTOM_EXECUTORS.flows!(L, S);
      await db.execute(buildRepoint('flow_versions', L, S));
    });

    // The flow moved to the survivor...
    const [flow] = await withSystemDbAccessContext(() => db.select().from(flows).where(eq(flows.id, flowId)));
    expect(flow!.orgId).toBe(S);
    // ...but the loser keeps its counters and delivery history (leave-for-erasure).
    const counters = await countersOf(t.partnerId);
    expect(counters).toHaveLength(2);
    expect(counters.every((c) => c.orgId === L && c.runs === 3)).toBe(true);
    const deliveries = await withSystemDbAccessContext(() => db.select().from(flowWebhookDeliveries).where(eq(flowWebhookDeliveries.flowId, flowId)));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ orgId: L, runId: run!.id, status: 'accepted' });
  });
});
