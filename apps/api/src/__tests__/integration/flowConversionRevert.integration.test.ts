/**
 * Tool Catalog W06 (#5221) Task B4 — revert, the admission/execution split and
 * the shadow counters on REAL Postgres as `breeze_app` under FORCE RLS,
 * through the real services: createConversion → switchConversion →
 * revertConversion, the legacy worker's admission, createFlowRun /
 * startManualRun, the flow runner, the real approval route and the release
 * worker, and the reconciler's drain clause. What only a database can show:
 *
 *  - revert is ONE transaction that leaves exactly the row shapes B2's legacy
 *    loader and createFlowRun read: legacy admits the Job again at once, and
 *    the flow admits nothing new (occurrence-carrying runs, schedule runs and
 *    manual runs alike) while it stays enabled;
 *  - the admission/execution split (Decision 7): a run parked before the revert,
 *    approved after it, is released and finishes;
 *  - the reconciler disables a reverted generation's flow only when it is
 *    drained AND older than LEGACY_DRAIN_MIN_MS, and cancels nothing;
 *  - the shadow counters: concurrent conditional increments land exactly, and
 *    a legacy run of a shadow row is observed without creating a flow run.
 *
 * Mocked: BullMQ producers (the queue records adds), the automation.started
 * publish and the flow-run slice enqueue (each slice is driven directly).
 * All tenants are synthetic.
 */
import './setup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Job } from 'bullmq';
import { LEGACY_DRAIN_MIN_MS, type ConversionSwitchRequest } from '@breeze/shared';

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    getJob = async () => undefined;
    add = async (_name: string, _data: Record<string, unknown>, opts?: { jobId?: string }) => ({ id: opts?.jobId ?? randomUUID() });
    close = async () => undefined;
  },
}));
vi.mock('../../services/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/redis')>()),
  isRedisAvailable: () => true,
  getBullMQConnection: () => ({}),
}));
vi.mock('../../services/eventBus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/eventBus')>()),
  publishEvent: vi.fn(async () => randomUUID()),
}));
vi.mock('../../jobs/flowRunQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/flowRunQueue')>()),
  enqueueFlowRunSlice: vi.fn(async () => 'job'),
}));

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  approvalRequests,
  auditLogs,
  automationOccurrenceClaims,
  automations,
  flowAutomationConversions,
  flowRuns,
  flowRunSteps,
  flows,
  organizationUsers,
} from '../../db/schema';
import { __testOnly as automationWorker } from '../../jobs/automationWorker';
import { disableDrainedRevertedFlows } from '../../jobs/flowRunReconciler';
import { processFlowRunJob } from '../../jobs/flowRunner';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import type { FlowRunJobData } from '../../jobs/queueSchemas';
import { approvalRoutes } from '../../routes/approvals';
import { currentConversionForAutomation, legacyPrefers, loadSwitchedConvertedAutomations } from '../../services/flows/conversion/claims';
import { automationSourceDigest } from '../../services/flows/conversion/convertAutomation';
import { revertConversion } from '../../services/flows/conversion/revert';
import { createConversion } from '../../services/flows/conversion/service';
import { recordShadow } from '../../services/flows/conversion/shadow';
import { switchConversion } from '../../services/flows/conversion/switch';
import { createFlowRun, startManualRun } from '../../services/flows/runService';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createDevice,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { interactiveOrgAuth, interactivePartnerAuth, orgContext, partnerContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ENV_KEYS = ['FLOWS_ENABLED'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FLOWS_ENABLED = 'true';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const PERMS = [
  { resource: 'automations', action: 'read' },
  { resource: 'automations', action: 'write' },
  { resource: 'scripts', action: 'read' },
  { resource: 'scripts', action: 'write' },
  { resource: 'scripts', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'approvals', action: 'decide' },
];

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const sibling = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const orgRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, PERMS);
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, PERMS);

  const member = async (label: string, siteIds?: string[]) => {
    const u = await createUser({ partnerId: partner.id, orgId: org.id, email: `rv-${label}-${randomUUID()}@revert.test` });
    await assignUserToOrganization(u.id, org.id, orgRole.id);
    if (siteIds) await system(() => db.update(organizationUsers).set({ siteIds }).where(eq(organizationUsers.userId, u.id)));
    return { id: u.id, email: u.email };
  };
  const partnerMember = async (label: string, access: 'all' | 'selected' = 'all') => {
    const u = await createUser({ partnerId: partner.id, email: `rv-${label}-${randomUUID()}@revert.test` });
    await assignUserToPartner(u.id, partner.id, partnerRole.id, access);
    return { id: u.id, email: u.email };
  };

  const switcher = await member('switcher');
  const creator = await member('creator');
  const partnerSwitcher = await partnerMember('pswitcher');
  const device = await createDevice({ orgId: org.id, siteId: site!.id });

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site!.id,
    orgRoleId: orgRole.id,
    deviceId: device.id,
    switcher,
    creator,
    partnerSwitcher,
    member,
    partnerMember,
    orgAuth: (u: { id: string; email: string } = switcher) => interactiveOrgAuth(org.id, partner.id, u, orgRole.id),
    partnerAuth: (u: { id: string; email: string } = partnerSwitcher, access: 'all' | 'selected' = 'all') =>
      interactivePartnerAuth(partner.id, [org.id, sibling.id], u, access, partnerRole.id),
    asOrg: <T>(fn: () => Promise<T>, u: { id: string } = switcher) => withDbAccessContext(orgContext(org.id, partner.id, u.id), fn),
    asPartner: <T>(fn: () => Promise<T>, u: { id: string } = partnerSwitcher) =>
      withDbAccessContext(partnerContext(partner.id, [org.id, sibling.id], u.id), fn),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function job(t: Tenant, values: Partial<typeof automations.$inferInsert>) {
  const [row] = await system(() => db.insert(automations).values({
    orgId: t.orgId,
    name: `Revert ${randomUUID().slice(0, 6)}`,
    trigger: { type: 'schedule', cronExpression: '0 3 * * *', timezone: 'UTC' },
    conditions: { type: 'devices', deviceIds: [t.deviceId] },
    actions: [{ type: 'execute_command', command: 'Write-Output revert', shell: 'powershell', whenOffline: 'queue' }],
    onFailure: 'stop',
    createdBy: t.creator.id,
    ...values,
  } as typeof automations.$inferInsert).returning());
  return row!;
}
type AutomationRow = Awaited<ReturnType<typeof job>>;

/** A shadow conversion through the real createConversion, aged and counted past the switch gate. */
async function converted(t: Tenant, row: AutomationRow, o: { gate?: boolean } = {}) {
  const create = { expectedSourceDigest: automationSourceDigest(row) };
  const r = row.orgId
    ? await t.asOrg(() => createConversion(t.orgAuth(), row.id, create))
    : await t.asPartner(() => createConversion(t.partnerAuth(), row.id, create));
  if (!r.ok) throw new Error(`createConversion refused: ${JSON.stringify(r)}`);
  if (o.gate !== false) {
    await system(() => db.update(flowAutomationConversions).set({
      shadowRuns: 5, shadowDivergences: 0, shadowStartedAt: new Date(Date.now() - 8 * 86_400_000),
    }).where(eq(flowAutomationConversions.id, r.conversion.id)));
  }
  return { conversionId: r.conversion.id, flowId: r.conversion.flowId };
}

const SWITCH: ConversionSwitchRequest = {
  expectedFlowVersion: 1, preApprovals: [], acceptScopeWidening: false, acceptDelegatorLifecycle: true, acknowledgeDivergence: false,
};

/** Converted AND switched (no pre-approval ticked, so a Tier-3 step parks). */
async function switched(t: Tenant, row: AutomationRow) {
  const c = await converted(t, row);
  const r = row.orgId
    ? await t.asOrg(() => switchConversion(t.orgAuth(), c.conversionId, SWITCH))
    : await t.asPartner(() => switchConversion(t.partnerAuth(), c.conversionId, SWITCH));
  if (!r.ok) throw new Error(`switchConversion refused: ${JSON.stringify(r)}`);
  return c;
}

const ledgerRow = (id: string) => system(async () => (await db.select().from(flowAutomationConversions).where(eq(flowAutomationConversions.id, id)))[0]!);
const flowRow = (id: string) => system(async () => (await db.select().from(flows).where(eq(flows.id, id)))[0]!);
const automationRow = (id: string) => system(async () => (await db.select().from(automations).where(eq(automations.id, id)))[0]!);
const runRow = (id: string) => system(async () => (await db.select().from(flowRuns).where(eq(flowRuns.id, id)))[0]!);
const runsOf = (flowId: string) => system(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)));

function slice(runId: string): Promise<void> {
  return processFlowRunJob({ id: `it-${randomUUID()}`, name: 'flow-run-slice', data: { runId } } as unknown as Job<FlowRunJobData>);
}

/** A manual UI run of the switched flow, driven to its park on the generated-script step. */
async function parkedRun(t: Tenant, flowId: string) {
  const started = await t.asOrg(() => startManualRun(t.orgAuth(), flowId, { inputs: {} }, 'ui'));
  if (!started.ok) throw new Error(`startManualRun refused: ${JSON.stringify(started)}`);
  await slice(started.runId);
  const run = await runRow(started.runId);
  expect(run, JSON.stringify({ error: run.error, code: run.errorCode })).toMatchObject({ status: 'awaiting_approval' });
  const step = (await system(() => db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, started.runId))))
    .find((s) => s.status === 'awaiting_approval')!;
  return { runId: started.runId, intentId: step.actionIntentId! };
}

async function approveViaRoute(t: Tenant, approvalId: string): Promise<Response> {
  const token = await createAccessToken({
    sub: t.switcher.id, email: t.switcher.email, roleId: t.orgRoleId, orgId: t.orgId, partnerId: t.partnerId,
    scope: 'organization', mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** A system-scope revert whose revert_at is `ageMs` in the past (revert_at is write-once, so it is set at the transition). */
async function revertedAt(conversionId: string, ageMs: number) {
  await system(() => db.execute(sql`UPDATE flow_automation_conversions
    SET state = 'reverted', revert_at = now() - (${ageMs}::bigint * interval '1 millisecond'), updated_at = now()
    WHERE id = ${conversionId}`));
}

async function waitForAudit(resourceId: string, action: string) {
  for (let i = 0; i < 40; i += 1) {
    const rows = await system(() => db.select().from(auditLogs).where(and(eq(auditLogs.resourceId, resourceId), eq(auditLogs.action, action))));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

describe('flow conversion revert (real Postgres, #5221 B4)', () => {
  runDb('revert re-enables legacy and closes flow admission at once', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await switched(t, row);
    const before = await ledgerRow(s.conversionId);

    const r = await t.asOrg(() => revertConversion(t.orgAuth(), s.conversionId));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, conversion: { id: s.conversionId, state: 'reverted' } });

    const ledger = await ledgerRow(s.conversionId);
    expect(ledger).toMatchObject({ state: 'reverted', revertedBy: t.switcher.id });
    expect(ledger.revertAt).toBeInstanceOf(Date);
    // switch_at and switched_at stay what the switch wrote (write-once).
    expect(ledger.switchAt).toEqual(before.switchAt);
    expect(ledger.switchedAt).toEqual(before.switchedAt);
    // The Job is exactly as it was before the switch.
    expect(await automationRow(row.id)).toMatchObject({ enabled: true, retiredAt: null, retiredReason: null, convertedToFlowId: null });
    // The flow is NOT disabled: its admitted work keeps its execution authority.
    expect(await flowRow(s.flowId)).toMatchObject({ status: 'enabled' });
    expect(await waitForAudit(s.conversionId, 'flow.conversion.reverted')).toHaveLength(1);

    // B2's legacy loader: the row is an ordinary enabled row again.
    expect(await system(() => loadSwitchedConvertedAutomations(db, eq(automations.id, row.id)))).toEqual([]);
    const current = await system(() => currentConversionForAutomation(db, row.id));
    expect(current).toMatchObject({ id: s.conversionId, state: 'reverted' });
    expect(legacyPrefers(current, new Date(Date.now() + 3_600_000), false)).toBe(true);

    // Legacy admits a schedule occurrence at once, and claims it (the row has a generation).
    const slotKey = '202701090300';
    const legacy = await automationWorker.processTriggerSchedule({
      type: 'trigger-schedule', automationId: row.id, slotKey, scanAt: '2027-01-09T03:00:04.000Z', enqueuedWhileUnswitched: false,
    });
    expect(legacy, JSON.stringify(legacy)).toMatchObject({ runId: expect.any(String) });
    const [claim] = await system(() => db.select().from(automationOccurrenceClaims).where(eq(automationOccurrenceClaims.automationId, row.id)));
    expect(claim).toMatchObject({ engine: 'legacy', occurrenceKey: 'schedule:2027-01-09T03:00Z', conversionId: s.conversionId });

    // The flow attempts nothing new: an occurrence-carrying run, a schedule run without one.
    const base = { flowId: s.flowId, orgId: t.orgId, scope: { firedAt: new Date().toISOString() }, inputs: {} };
    expect(await createFlowRun({
      ...base, triggerKind: 'event', chainDepth: 0, causedByRunId: null, dedupeKey: `event:${randomUUID()}`,
      occurrence: { keys: [`event:${randomUUID()}`], at: new Date() },
    })).toEqual({ created: false, reason: 'not_enabled' });
    expect(await createFlowRun({ ...base, triggerKind: 'schedule', dedupeKey: 'schedule:2027-01-10T03:00' }))
      .toEqual({ created: false, reason: 'flow_conversion_reverted' });
    expect(await runsOf(s.flowId)).toEqual([]);

    // A reverted generation is terminal.
    expect(await t.asOrg(() => revertConversion(t.orgAuth(), s.conversionId))).toEqual({ ok: false, error: 'not_switched' });
  });

  runDb('revert of a shadow conversion is not_switched', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const c = await converted(t, row);
    const before = await ledgerRow(c.conversionId);
    expect(await t.asOrg(() => revertConversion(t.orgAuth(), c.conversionId))).toEqual({ ok: false, error: 'not_switched' });
    expect(await ledgerRow(c.conversionId)).toEqual(before);
    expect(await automationRow(row.id)).toMatchObject({ enabled: true, retiredAt: null, convertedToFlowId: null });
  });

  runDb('revert is refused like a switch: site-limited users, selected-access partner users, foreign org tokens', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await switched(t, row);

    const limited = await t.member('limited', [t.siteId]);
    expect(await t.asOrg(() => revertConversion(t.orgAuth(limited), s.conversionId), limited))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });
    const tokenLimited = { ...t.orgAuth(), allowedSiteIds: [t.siteId] } as ReturnType<Tenant['orgAuth']>;
    expect(await t.asOrg(() => revertConversion(tokenLimited, s.conversionId)))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });
    expect((await ledgerRow(s.conversionId)).state).toBe('switched');

    // Partner-wide: canManagePartnerWidePolicies, and org tokens never see it.
    const pw = await job(t, { orgId: null, partnerId: t.partnerId, conditions: [], createdBy: null });
    const sp = await switched(t, pw);
    const selected = await t.partnerMember('selected', 'selected');
    expect(await t.asPartner(() => revertConversion(t.partnerAuth(selected, 'selected'), sp.conversionId), selected))
      .toEqual({ ok: false, error: 'partner_wide_forbidden' });
    expect(await t.asOrg(() => revertConversion(t.orgAuth(), sp.conversionId))).toEqual({ ok: false, error: 'conversion_not_found' });
    const ok = await t.asPartner(() => revertConversion(t.partnerAuth(), sp.conversionId));
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(await automationRow(pw.id)).toMatchObject({ orgId: null, partnerId: t.partnerId, enabled: true, convertedToFlowId: null });
  });

  runDb('parked flow run approved after revert still executes', async () => {
    const t = await tenant();
    const row = await job(t, { trigger: { type: 'manual' } });
    const s = await switched(t, row);
    const { runId, intentId } = await parkedRun(t, s.flowId);

    const r = await t.asOrg(() => revertConversion(t.orgAuth(), s.conversionId));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    // Admission is closed: a new manual run is refused with a clear code.
    expect(await t.asOrg(() => startManualRun(t.orgAuth(), s.flowId, { inputs: {} }, 'ui')))
      .toEqual({ ok: false, error: 'flow_conversion_reverted' });
    // Execution is not: the parked run and its intent are untouched…
    expect(await runRow(runId)).toMatchObject({ status: 'awaiting_approval', cancelRequestedAt: null });
    const [intent] = await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(intent).toMatchObject({ status: 'pending_approval' });

    // …and approving it after the revert releases it and the run finishes.
    const [approval] = await system(() => db.select({ id: approvalRequests.id }).from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, t.switcher.id))));
    expect(approval).toBeDefined();
    const decided = await approveViaRoute(t, approval!.id);
    expect(decided.status, await decided.clone().text()).toBe(200);
    await releaseApprovedIntent(intentId);
    const [released] = await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(released!.status, JSON.stringify({ errorCode: released!.errorCode, result: released!.result })).toBe('completed');
    await slice(runId);
    const done = await runRow(runId);
    expect(done, JSON.stringify({ error: done.error, code: done.errorCode })).toMatchObject({ status: 'completed', errorCode: null });
    expect((await runsOf(s.flowId)).map((x) => x.id)).toEqual([runId]);
  });

  runDb('reconciler disables only drained, aged reverted flows and cancels nothing', async () => {
    const t = await tenant();
    const aged = LEGACY_DRAIN_MIN_MS + 86_400_000;
    const manual = () => job(t, { trigger: { type: 'manual' } });

    // A: reverted long ago, nothing in flight → disabled.
    const a = await switched(t, await manual());
    await revertedAt(a.conversionId, aged);
    // B: reverted long ago, a run still parked on its open intent → kept.
    const b = await switched(t, await manual());
    const bRun = await parkedRun(t, b.flowId);
    await revertedAt(b.conversionId, aged);
    // C: reverted long ago, its run ended but the intent is still open → kept.
    const c = await switched(t, await manual());
    const cRun = await parkedRun(t, c.flowId);
    await system(() => db.update(flowRuns).set({ status: 'failed', finishedAt: new Date(), errorCode: null })
      .where(eq(flowRuns.id, cRun.runId)));
    await revertedAt(c.conversionId, aged);
    // F: reverted long ago, a run still queued (no intent at all) → kept.
    const f = await switched(t, await manual());
    const fStarted = await t.asOrg(() => startManualRun(t.orgAuth(), f.flowId, { inputs: {} }, 'ui'));
    if (!fStarted.ok) throw new Error(JSON.stringify(fStarted));
    await revertedAt(f.conversionId, aged);
    // D: reverted just now (the real revert), nothing in flight → kept until it ages.
    const d = await switched(t, await manual());
    expect((await t.asOrg(() => revertConversion(t.orgAuth(), d.conversionId))).ok).toBe(true);
    // E: still switched → never touched.
    const e = await switched(t, await manual());

    const before = {
      bRun: await runRow(bRun.runId),
      fRun: await runRow(fStarted.runId),
      cRun: await runRow(cRun.runId),
      bIntent: (await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, bRun.intentId))))[0]!,
      cIntent: (await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, cRun.intentId))))[0]!,
    };

    const disabled = await disableDrainedRevertedFlows();
    expect(disabled.map((x) => x.id)).toContain(a.flowId);
    for (const kept of [b, c, d, e, f]) expect(disabled.map((x) => x.id)).not.toContain(kept.flowId);

    expect(await flowRow(a.flowId)).toMatchObject({ status: 'disabled', enabledPublicationSeq: null, pausedReason: null });
    for (const kept of [b, c, d, e, f]) expect((await flowRow(kept.flowId)).status).toBe('enabled');
    // Cancels nothing.
    expect(await runRow(bRun.runId)).toEqual(before.bRun);
    expect(await runRow(cRun.runId)).toEqual(before.cRun);
    expect(await runRow(fStarted.runId)).toEqual(before.fRun);
    expect((await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, bRun.intentId))))[0]).toEqual(before.bIntent);
    expect((await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, cRun.intentId))))[0]).toEqual(before.cIntent);

    // A second pass finds nothing more of ours.
    const again = await disableDrainedRevertedFlows();
    for (const x of [a, b, c, d, e, f]) expect(again.map((y) => y.id)).not.toContain(x.flowId);
  });

  runDb('counters increment atomically under concurrency, only while shadow and only for the judged draft', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const c = await converted(t, row, { gate: false });
    const { documentDigest } = await ledgerRow(c.conversionId);

    const N = 40;
    const results = await Promise.all(Array.from({ length: N }, (_, i) => recordShadow(c.conversionId, i % 2 === 0
      ? { divergent: true, kind: 'would_park', detail: `steps a0_command would wait (${i})`, documentDigest }
      : { divergent: false, kind: null, detail: '', documentDigest })));
    expect(results.every(Boolean)).toBe(true);
    const ledger = await ledgerRow(c.conversionId);
    expect(ledger).toMatchObject({ shadowRuns: N, shadowDivergences: N / 2, state: 'shadow' });
    expect(ledger.shadowLastAt).toBeInstanceOf(Date);
    expect(ledger.shadowLastDivergence).toMatchObject({ kind: 'would_park', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });

    // An observation of an older draft, or of a generation no longer in shadow, is dropped.
    expect(await recordShadow(c.conversionId, { divergent: true, kind: 'over_cap', detail: 'x', documentDigest: 'f'.repeat(64) })).toBe(false);
    const s = await switched(t, await job(t, {}));
    const sBefore = await ledgerRow(s.conversionId);
    expect(await recordShadow(s.conversionId, { divergent: true, kind: 'over_cap', detail: 'x' })).toBe(false);
    expect(await ledgerRow(s.conversionId)).toEqual(sBefore);
    expect((await ledgerRow(c.conversionId)).shadowRuns).toBe(N);
  });

  runDb('a legacy run of a shadow row is observed after creation and creates no flow run', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const c = await converted(t, row, { gate: false });

    const legacy = await automationWorker.processTriggerSchedule({
      type: 'trigger-schedule', automationId: row.id, slotKey: '202701090300', scanAt: '2027-01-09T03:00:04.000Z',
    });
    expect(legacy, JSON.stringify(legacy)).toMatchObject({ runId: expect.any(String) });

    const ledger = await ledgerRow(c.conversionId);
    // Same device set; the generated-script step would park under the switch defaults.
    expect(ledger).toMatchObject({ shadowRuns: 1, shadowDivergences: 1, shadowLastDivergence: { kind: 'would_park' } });
    expect(await runsOf(c.flowId)).toEqual([]);
  });
});
