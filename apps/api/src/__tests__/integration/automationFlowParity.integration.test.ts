/**
 * Tool Catalog W06 (#5221) Task B7 — legacy ↔ converted-flow effect parity
 * (spec §7), on REAL Postgres (as `breeze_app`, FORCE RLS) through the real
 * engines.
 *
 * Each fixture is one synthetic Job. Its legacy run executes BEFORE the switch
 * (the real trigger path, then `executeAutomationRun`); then the real
 * `switchConversion` publishes the converted flow and the SAME trigger kind
 * runs it (`startManualRun`, the schedule tick, the event subscriber, or the
 * legacy webhook URL, which now forwards). Pre-approvals are ticked at the
 * switch where the fleet lane allows them; any approval the flow still parks
 * on is decided through the approvals route and released by the release
 * worker. The two effect traces must match:
 *
 *  - device dispatches: (deviceId, script sha256, parameters, effective runAs,
 *    offline policy, dispatch result) at `dispatchScriptToDevice`, the core both
 *    engines call;
 *  - notices: (recipients, title, message, severity) at the email sender both
 *    engines reach;
 *  - alerts: (deviceId, severity, title, message) at `createAutomationStyleAlert`,
 *    the writer both engines share;
 *  - per-device action order.
 *
 * Two differences are known and compared through a stated normalization; the
 * failure-notice case pins both raw forms so neither can drift unnoticed:
 *  - severity, the documented lossy map (plan "Conversion map"): legacy
 *    critical → critical, high and medium → warning, low and info → info; a
 *    flow `warning` reaches the senders as `medium`;
 *  - the on-failure notice TEXT: legacy sends the action's failure reason and
 *    names the device only by id (deviceName = the device UUID); the converted
 *    step (PR A) sends "Automation <name> action <n> failed on <hostname>".
 *    Same recipients, title, device and count — the message body differs.
 *
 * Mocked: the BullMQ producers (adds are recorded and `execute-run` jobs are
 * drained by calling the runtime), the automation.started publish, the
 * flow-run slice enqueue, and the email transport (recorded, never sent).
 * The dispatch core and the alert writer are the real ones, wrapped to record;
 * one fixture injects a per-device dispatch failure there. Devices are offline
 * with no agent, so dispatch queues (or skips, under `skip`). All tenants are
 * synthetic.
 */
import './setup';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Job } from 'bullmq';
import type { ConversionSwitchRequest } from '@breeze/shared';

interface DispatchRecord {
  seq: number; deviceId: string; sha256: string; parameters: unknown; runAs: string | null; offline: string | null; result: string;
}
interface NoticeRecord { seq: number; to: string; title: string; message: string; severity: string; deviceName: string | null }
interface AlertRecord { seq: number; deviceId: string; severity: string; title: string; message: string }

const { trace } = vi.hoisted(() => ({
  trace: {
    seq: 0,
    dispatches: [] as DispatchRecord[],
    notices: [] as NoticeRecord[],
    alerts: [] as AlertRecord[],
    failDevices: new Set<string>(),
    queueAdds: [] as Array<{ name: string; data: Record<string, unknown>; taken: boolean }>,
  },
}));

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    getJob = async () => undefined;
    add = async (name: string, data: Record<string, unknown>, opts?: { jobId?: string }) => {
      trace.queueAdds.push({ name, data, taken: false });
      return { id: opts?.jobId ?? randomUUID() };
    };
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
vi.mock('../../services/notificationSenders/emailSender', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/notificationSenders/emailSender')>();
  return {
    ...real,
    sendEmailNotification: vi.fn(async (p: { to: string | string[]; alertName: string; summary?: string; severity: string; deviceName?: string }) => {
      trace.notices.push({
        seq: trace.seq++, to: [p.to].flat().join(','), title: p.alertName, message: p.summary ?? '',
        severity: String(p.severity), deviceName: p.deviceName ?? null,
      });
      return { success: true };
    }),
  };
});
vi.mock('../../services/scriptDispatch', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/scriptDispatch')>();
  return {
    ...real,
    dispatchScriptToDevice: vi.fn(async (input: Parameters<typeof real.dispatchScriptToDevice>[0]) => {
      const content = input.source.kind === 'saved' ? input.source.script.content
        : input.source.kind === 'raw' ? input.source.content : '';
      const runAs = input.runAs ?? (input.source.kind === 'saved' ? input.source.script.runAs : null);
      const record: DispatchRecord = {
        seq: trace.seq++,
        deviceId: input.device.id,
        sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        parameters: input.parameters ?? {},
        runAs: runAs ?? null,
        offline: input.offlinePolicy ? input.offlinePolicy.kind : null,
        result: '',
      };
      trace.dispatches.push(record);
      if (trace.failDevices.has(input.device.id)) {
        record.result = 'injected_failure';
        return { ok: false, code: 'insert_failed', message: 'Injected dispatch failure (parity fixture)' } as unknown as Awaited<ReturnType<typeof real.dispatchScriptToDevice>>;
      }
      const r = await real.dispatchScriptToDevice(input);
      record.result = r.ok ? 'ok' : r.code;
      return r;
    }),
  };
});
vi.mock('../../services/alertCreation', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/alertCreation')>();
  return {
    ...real,
    createAutomationStyleAlert: vi.fn(async (input: Parameters<typeof real.createAutomationStyleAlert>[0]) => {
      trace.alerts.push({ seq: trace.seq++, deviceId: input.deviceId, severity: input.severity, title: input.title, message: input.message });
      return real.createAutomationStyleAlert(input);
    }),
  };
});

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  approvalRequests,
  automations,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  flowAutomationConversions,
  flowRuns,
  flowRunSteps,
  notificationChannelConfigs,
  notificationChannels,
  scripts,
} from '../../db/schema';
import { __testOnly as automationWorker, handleAutomationEvent } from '../../jobs/automationWorker';
import { processFlowRunJob } from '../../jobs/flowRunner';
import { processFlowScheduleTick } from '../../jobs/flowScheduleTick';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import type { FlowRunJobData } from '../../jobs/queueSchemas';
import { approvalRoutes } from '../../routes/approvals';
import { automationWebhookRoutes } from '../../routes/automations';
import {
  type AutomationAction,
  createAutomationRunRecord,
  executeAutomationRun,
  formatScheduleTriggerKey,
  replaceAutomationResourceBindings,
  resolveAutomationReferencesForOwner,
} from '../../services/automationRuntime';
import type { BreezeEvent } from '../../services/eventBus';
import { automationSourceDigest } from '../../services/flows/conversion/convertAutomation';
import { createConversion } from '../../services/flows/conversion/service';
import { switchConversion } from '../../services/flows/conversion/switch';
import { handleFlowEventTrigger } from '../../services/flows/eventTrigger';
import { startManualRun } from '../../services/flows/runService';
import { createAccessToken } from '../../services/jwt';
import { encryptSecret } from '../../services/secretCrypto';
import {
  assignUserToOrganization,
  createDevice,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { interactiveOrgAuth, orgContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// An event Job converts only where the flow event subscriber is durable (W05).
const ENV_KEYS = ['FLOWS_ENABLED', 'EVENT_DISPATCH_MODE', 'EVENT_DISPATCH_QUEUE_SUBSCRIBERS'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FLOWS_ENABLED = 'true';
  process.env.EVENT_DISPATCH_MODE = 'enforce';
  process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS = 'flow-event-trigger';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  resetTrace();
  trace.queueAdds.length = 0;
  trace.failDevices.clear();
});

function resetTrace(): void {
  trace.dispatches.length = 0;
  trace.notices.length = 0;
  trace.alerts.length = 0;
}

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const PERMS = [
  { resource: 'automations', action: 'read' },
  { resource: 'automations', action: 'write' },
  { resource: 'scripts', action: 'read' },
  { resource: 'scripts', action: 'write' },
  { resource: 'scripts', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'alerts', action: 'read' },
  { resource: 'alerts', action: 'write' },
  { resource: 'notifications', action: 'read' },
  { resource: 'approvals', action: 'decide' },
];

const RECIPIENT = 'parity-ops@example.com';

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(role.id, PERMS);
  const u = await createUser({ partnerId: partner.id, orgId: org.id, email: `parity-${randomUUID()}@parity.test` });
  await assignUserToOrganization(u.id, org.id, role.id);
  const switcher = { id: u.id, email: u.email };

  const deviceIds: string[] = [];
  const hostnames: string[] = [];
  for (const h of ['par-a', 'par-b', 'par-c']) {
    const hostname = `${h}-${randomUUID().slice(0, 6)}`;
    const d = await createDevice({ orgId: org.id, siteId: site!.id, hostname });
    deviceIds.push(d.id);
    hostnames.push(hostname);
  }
  const [script] = await system(() => db.insert(scripts).values({
    orgId: org.id, partnerId: partner.id, name: `parity-${randomUUID().slice(0, 6)}`, language: 'powershell',
    content: 'Write-Output "parity library script"', osTypes: ['windows'], runAs: 'system', timeoutSeconds: 60,
  }).returning());
  const [channel] = await system(() => db.insert(notificationChannels).values({
    orgId: org.id, partnerId: null, name: 'Parity email', type: 'email',
  }).returning({ id: notificationChannels.id }));
  await system(() => db.insert(notificationChannelConfigs).values({ channelId: channel!.id, config: { recipients: [RECIPIENT] } }));

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site!.id,
    roleId: role.id,
    switcher,
    deviceIds,
    hostnames,
    script: script!,
    channelId: channel!.id,
    auth: () => interactiveOrgAuth(org.id, partner.id, switcher, role.id),
    asOrg: <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(org.id, partner.id, switcher.id), fn),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function groupOf(t: Tenant, deviceIds: string[]): Promise<string> {
  const [g] = await system(() => db.insert(deviceGroups).values({ orgId: t.orgId, name: `parity-${randomUUID().slice(0, 6)}`, type: 'static' })
    .returning({ id: deviceGroups.id }));
  await system(() => db.insert(deviceGroupMemberships).values(deviceIds.map((deviceId) => ({ deviceId, groupId: g!.id, orgId: t.orgId }))));
  return g!.id;
}

/** Inserted directly, so perform the reference admission + durable binding replacement the create route would. */
async function job(t: Tenant, values: Partial<typeof automations.$inferInsert>) {
  const [row] = await system(() => db.insert(automations).values({
    orgId: t.orgId,
    name: `Parity ${randomUUID().slice(0, 6)}`,
    trigger: { type: 'manual' },
    conditions: { type: 'devices', deviceIds: t.deviceIds },
    actions: [],
    onFailure: 'stop',
    createdBy: t.switcher.id,
    ...values,
  } as typeof automations.$inferInsert).returning());
  const axes = { orgId: t.orgId, partnerId: null };
  await system(() => db.transaction(async (tx) => {
    const resolved = await resolveAutomationReferencesForOwner(
      tx, axes, row!.actions as AutomationAction[], row!.notificationTargets ?? undefined,
    );
    await replaceAutomationResourceBindings(tx, row!.id, axes, resolved);
  }));
  return row!;
}
type AutomationRow = Awaited<ReturnType<typeof job>>;

/** A shadow conversion through the real createConversion, aged past the gate. */
async function converted(t: Tenant, row: AutomationRow) {
  const created = await t.asOrg(() => createConversion(t.auth(), row.id, { expectedSourceDigest: automationSourceDigest(row) }));
  if (!created.ok) throw new Error(`createConversion refused: ${JSON.stringify(created)}`);
  const conversionId = created.conversion.id;
  await system(() => db.update(flowAutomationConversions).set({
    shadowRuns: 5, shadowDivergences: 0, shadowStartedAt: new Date(Date.now() - 8 * 86_400_000),
  }).where(eq(flowAutomationConversions.id, conversionId)));
  return { conversionId, flowId: created.conversion.flowId };
}

/** The real switch; fleet steps named in `preApprove` are pre-approved for every device. */
async function doSwitch(t: Tenant, conversionId: string, preApprove: string[]): Promise<Date> {
  const req: ConversionSwitchRequest = {
    expectedFlowVersion: 1,
    preApprovals: preApprove.map((stepId) => ({ stepId, maxTargets: t.deviceIds.length })),
    acceptScopeWidening: false,
    acceptDelegatorLifecycle: true,
    acknowledgeDivergence: true,
  };
  const r = await t.asOrg(() => switchConversion(t.auth(), conversionId, req));
  if (!r.ok) throw new Error(`switchConversion refused: ${JSON.stringify(r)}`);
  const [ledger] = await system(() => db.select().from(flowAutomationConversions).where(eq(flowAutomationConversions.id, conversionId)));
  return ledger!.switchAt!;
}

// ── engines ────────────────────────────────────────────────────────────────

/** Legacy executes what admission enqueued: every not-yet-taken `execute-run` job. */
async function drainLegacy(): Promise<number> {
  let ran = 0;
  for (;;) {
    const next = trace.queueAdds.find((a) => !a.taken && a.name === 'execute-run');
    if (!next) return ran;
    next.taken = true;
    const d = next.data as { runId: string; targetDeviceIds?: string[]; triggerContext?: Parameters<typeof executeAutomationRun>[2] };
    await system(() => executeAutomationRun(d.runId, d.targetDeviceIds, d.triggerContext));
    ran += 1;
  }
}

async function legacyManual(row: AutomationRow): Promise<void> {
  const fresh = await system(async () => (await db.select().from(automations).where(eq(automations.id, row.id)))[0]!);
  const { run, targetDeviceIds } = await system(() => createAutomationRunRecord({ automation: fresh as never, triggeredBy: 'manual:parity' }));
  await system(() => executeAutomationRun(run.id, targetDeviceIds));
}

function slice(runId: string): Promise<void> {
  return processFlowRunJob({ id: `it-${randomUUID()}`, name: 'flow-run-slice', data: { runId } } as unknown as Job<FlowRunJobData>);
}

async function approveViaRoute(t: Tenant, approvalId: string): Promise<Response> {
  const token = await createAccessToken({
    sub: t.switcher.id, email: t.switcher.email, roleId: t.roleId, orgId: t.orgId, partnerId: t.partnerId,
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

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired']);

/** Drives a flow run to a terminal state; parked approvals are decided (approve) and released. */
async function driveFlowRun(t: Tenant, runId: string): Promise<typeof flowRuns.$inferSelect> {
  for (let i = 0; i < 40; i += 1) {
    await slice(runId);
    const [run] = await system(() => db.select().from(flowRuns).where(eq(flowRuns.id, runId)));
    if (TERMINAL.has(run!.status)) return run!;
    if (run!.status === 'awaiting_approval') {
      const parked = (await system(() => db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, runId))))
        .filter((s) => s.status === 'awaiting_approval' && s.actionIntentId);
      for (const step of parked) {
        const [intent] = await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, step.actionIntentId!)));
        if (intent!.status === 'pending_approval') {
          const [approval] = await system(() => db.select({ id: approvalRequests.id }).from(approvalRequests)
            .where(and(eq(approvalRequests.intentId, intent!.id), eq(approvalRequests.userId, t.switcher.id))));
          if (!approval) throw new Error(`no approval request for intent ${intent!.id}`);
          const decided = await approveViaRoute(t, approval.id);
          if (decided.status !== 200) throw new Error(`approve ${decided.status}: ${await decided.text()}`);
        }
        await releaseApprovedIntent(intent!.id);
      }
    }
  }
  throw new Error(`flow run ${runId} did not finish`);
}

async function driveFlowRuns(t: Tenant, flowId: string, except: ReadonlySet<string> = new Set()): Promise<Array<typeof flowRuns.$inferSelect>> {
  const runs = (await system(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)))).filter((r) => !except.has(r.id));
  const done = [];
  for (const r of runs) done.push(await driveFlowRun(t, r.id));
  return done;
}

// ── traces ─────────────────────────────────────────────────────────────────

/** Plan "Conversion map": critical→critical, high/medium→warning, low/info→info; a flow warning reaches the senders as medium. */
const LEGACY_NOTICE_SEVERITY_AT_SENDER: Record<string, string> = { critical: 'critical', high: 'medium', medium: 'medium', low: 'info', info: 'info' };

interface Trace {
  dispatches: string[];
  notices: string[];
  alerts: string[];
  order: Record<string, string[]>;
  rawNoticeSeverities: string[];
  /** The on-failure notices' raw message bodies (hostnames scrubbed). */
  rawFailureNoticeMessages: string[];
}

/** The on-failure notice title both engines use (`<name> action failed`). */
const isFailureNotice = (title: string) => title.endsWith(' action failed');

function take(t: Tenant, engine: 'legacy' | 'flow'): Trace {
  const hostOf = (deviceId: string) => t.hostnames[t.deviceIds.indexOf(deviceId)]!;
  const label = (deviceId: string) => `dev${t.deviceIds.indexOf(deviceId)}`;
  const sev = (s: string) => (engine === 'legacy' ? LEGACY_NOTICE_SEVERITY_AT_SENDER[s] ?? `unmapped:${s}` : s);
  const scrub = (s: string) => t.hostnames.reduce((acc, h, i) => acc.split(h).join(`<dev${i}>`), s);
  const out: Trace = {
    dispatches: trace.dispatches.map((d) => JSON.stringify([label(d.deviceId), d.sha256, d.parameters, d.runAs, d.offline, d.result])).sort(),
    notices: trace.notices.map((n) => JSON.stringify([
      n.to, n.title, isFailureNotice(n.title) ? '<on-failure notice text>' : scrub(n.message), sev(n.severity),
    ])).sort(),
    alerts: trace.alerts.map((a) => JSON.stringify([label(a.deviceId), a.severity, scrub(a.title), scrub(a.message)])).sort(),
    order: {},
    rawNoticeSeverities: trace.notices.map((n) => n.severity).sort(),
    rawFailureNoticeMessages: trace.notices.filter((n) => isFailureNotice(n.title)).map((n) => scrub(n.message)).sort(),
  };
  const events = [
    ...trace.dispatches.map((d) => ({ seq: d.seq, deviceId: d.deviceId, what: `dispatch:${d.sha256.slice(0, 8)}` })),
    ...trace.alerts.map((a) => ({ seq: a.seq, deviceId: a.deviceId, what: `alert:${scrub(a.title)}` })),
    // A notice is about the device its message names (flow), or whose id legacy passes as deviceName.
    ...trace.notices.flatMap((n) => t.deviceIds.filter((id) => n.message.includes(hostOf(id)) || n.deviceName === id)
      .map((deviceId) => ({ seq: n.seq, deviceId, what: `notice:${n.title}` }))),
  ].sort((a, b) => a.seq - b.seq);
  for (const id of t.deviceIds) {
    const seen = events.filter((e) => e.deviceId === id).map((e) => e.what);
    if (seen.length > 0) out.order[label(id)] = seen;
  }
  resetTrace();
  return out;
}

function expectParity(legacy: Trace, flow: Trace): void {
  expect({ dispatches: flow.dispatches, notices: flow.notices, alerts: flow.alerts, order: flow.order })
    .toEqual({ dispatches: legacy.dispatches, notices: legacy.notices, alerts: legacy.alerts, order: legacy.order });
}

function breezeEvent(orgId: string, at: Date, payload: Record<string, unknown>): BreezeEvent {
  return {
    id: randomUUID(), type: 'alert.triggered', orgId, source: 'parity-it', priority: 'normal', payload,
    metadata: { timestamp: at.toISOString() },
  } as unknown as BreezeEvent;
}

// ── fixtures ───────────────────────────────────────────────────────────────

/** Schedule + run_script on a groups target, then a per-device notice. Runs legacy, switches, runs the flow. */
async function scheduleScriptFixture(onFailure: 'stop' | 'continue' | 'notify', failDevice: number | null) {
  const t = await tenant();
  const groupId = await groupOf(t, t.deviceIds);
  const row = await job(t, {
    trigger: { type: 'schedule', cronExpression: '0 * * * *', timezone: 'UTC' },
    conditions: { type: 'groups', groupIds: [groupId] },
    actions: [
      { type: 'run_script', scriptId: t.script.id, whenOffline: 'queue' },
      { type: 'send_notification', notificationChannelId: t.channelId, severity: 'critical' },
    ],
    onFailure,
    ...(onFailure === 'notify' ? { notificationTargets: { channelIds: [t.channelId] } } : {}),
  } as Partial<typeof automations.$inferInsert>);
  const c = await converted(t, row);
  if (failDevice !== null) trace.failDevices.add(t.deviceIds[failDevice]!);

  const HOUR = 3_600_000;
  const slot = new Date(Math.floor(Date.now() / HOUR) * HOUR);
  const admitted = await automationWorker.processTriggerSchedule({
    type: 'trigger-schedule', automationId: row.id, slotKey: formatScheduleTriggerKey(slot),
    scanAt: new Date(slot.getTime() + 4_000).toISOString(), enqueuedWhileUnswitched: false,
  });
  expect(admitted, JSON.stringify(admitted)).toMatchObject({ runId: expect.any(String) });
  expect(await drainLegacy()).toBe(1);
  const legacy = take(t, 'legacy');

  const S = await doSwitch(t, c.conversionId, ['a0_run_script']);
  const at = new Date(Math.ceil(S.getTime() / HOUR) * HOUR);
  await processFlowScheduleTick(new Date(at.getTime() + 10_000));
  const runs = await driveFlowRuns(t, c.flowId);
  expect(runs).toHaveLength(1);
  const flow = take(t, 'flow');
  return { t, row, legacy, flow, run: runs[0]! };
}

describe('legacy ↔ converted flow effect parity (real Postgres, #5221 B7)', () => {
  runDb('schedule + run_script on a groups target', async () => {
    const { legacy, flow, run } = await scheduleScriptFixture('stop', null);
    expect(run.status).toBe('completed');
    expect(legacy.dispatches).toHaveLength(3);
    expect(legacy.notices).toHaveLength(3);
    expectParity(legacy, flow);
    // Each device: its script before its notice, in both engines.
    for (const order of Object.values(legacy.order)) expect(order.map((o) => o.split(':')[0])).toEqual(['dispatch', 'notice']);
  }, 120_000);

  runDb('an injected dispatch failure under stop: the failed device gets no later action', async () => {
    const { legacy, flow } = await scheduleScriptFixture('stop', 1);
    expect(legacy.dispatches).toHaveLength(3);
    expect(legacy.notices).toHaveLength(2);
    expect(legacy.order.dev1!.map((o) => o.split(':')[0])).toEqual(['dispatch']);
    expectParity(legacy, flow);
  }, 120_000);

  runDb('an injected dispatch failure under continue: every device gets every action', async () => {
    const { legacy, flow } = await scheduleScriptFixture('continue', 1);
    expect(legacy.notices).toHaveLength(3);
    expectParity(legacy, flow);
  }, 120_000);

  runDb('an injected dispatch failure under notify: one failure notice, and the failed device is dropped', async () => {
    const { row, legacy, flow } = await scheduleScriptFixture('notify', 1);
    // Two action notices (dev0, dev2) and one failure notice (dev1).
    expect(legacy.notices).toHaveLength(3);
    expect(legacy.order.dev1!.map((o) => o.split(':')[0])).toEqual(['dispatch', 'notice']);
    expectParity(legacy, flow);
    // The documented differences, pinned. Severity: legacy sends its failure notice as high,
    // the flow's warning reaches the sender as medium (critical is unchanged).
    expect(legacy.rawNoticeSeverities).toEqual(['critical', 'critical', 'high']);
    expect(flow.rawNoticeSeverities).toEqual(['critical', 'critical', 'medium']);
    // Text: legacy carries the action's failure reason; the flow names the action and the device.
    expect(legacy.rawFailureNoticeMessages).toEqual(['Failed to queue run_script action command']);
    expect(flow.rawFailureNoticeMessages).toEqual([`Automation ${row.name} action 1 failed on <dev1>`]);
  }, 120_000);

  runDb('event + send_notification with a filter: a matching event notifies, a non-matching one does nothing', async () => {
    const t = await tenant();
    const row = await job(t, {
      trigger: { type: 'event', eventType: 'alert.triggered', filter: { severity: 'critical' } },
      actions: [{ type: 'send_notification', notificationChannelId: t.channelId, title: 'Critical alert seen', severity: 'medium' }],
    } as Partial<typeof automations.$inferInsert>);
    const c = await converted(t, row);
    const legacyDeliver = async (event: BreezeEvent) => {
      await handleAutomationEvent(event);
      const jobs = trace.queueAdds.filter((a) => !a.taken && a.name === 'trigger-event' && a.data.eventId === event.id);
      for (const j of jobs) {
        j.taken = true;
        await automationWorker.processTriggerEvent(j.data as unknown as Parameters<typeof automationWorker.processTriggerEvent>[0]);
      }
      await drainLegacy();
    };
    const target = t.deviceIds[0]!;

    await legacyDeliver(breezeEvent(t.orgId, new Date(), { severity: 'low', deviceId: target }));
    const legacyNegative = take(t, 'legacy');
    await legacyDeliver(breezeEvent(t.orgId, new Date(), { severity: 'critical', deviceId: target }));
    const legacyPositive = take(t, 'legacy');

    const S = await doSwitch(t, c.conversionId, []);
    await handleFlowEventTrigger(breezeEvent(t.orgId, new Date(S.getTime() + 5_000), { severity: 'low', deviceId: target }));
    expect(await driveFlowRuns(t, c.flowId)).toHaveLength(0);
    const flowNegative = take(t, 'flow');
    await handleFlowEventTrigger(breezeEvent(t.orgId, new Date(S.getTime() + 6_000), { severity: 'critical', deviceId: target }));
    const runs = await driveFlowRuns(t, c.flowId);
    expect(runs.map((r) => r.status)).toEqual(['completed']);
    const flowPositive = take(t, 'flow');

    expect(legacyNegative).toMatchObject({ dispatches: [], notices: [], alerts: [] });
    expectParity(legacyNegative, flowNegative);
    expect(legacyPositive.notices).toHaveLength(1);
    expectParity(legacyPositive, flowPositive);
  }, 120_000);

  runDb('webhook + create_alert: the forwarded delivery raises the same alerts', async () => {
    const t = await tenant();
    const secret = `legacy-${randomUUID()}`;
    const row = await job(t, {
      trigger: { type: 'webhook', secret: encryptSecret(secret) },
      conditions: { type: 'devices', deviceIds: t.deviceIds.slice(0, 2) },
      actions: [{ type: 'create_alert', alertSeverity: 'high', alertTitle: 'Webhook fired on {{hostname}}', alertMessage: 'Raised for {{device}}' }],
    } as Partial<typeof automations.$inferInsert>);
    const c = await converted(t, row);
    const post = (body: string) => {
      const ts = Math.floor(Date.now() / 1000);
      return new Hono().route('/api/v1/automations/webhooks', automationWebhookRoutes)
        .request(`/api/v1/automations/webhooks/${row.id}`, {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/json', 'x-breeze-timestamp': String(ts),
            'x-breeze-signature': `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`,
          },
        });
    };

    expect((await post(JSON.stringify({ n: 'legacy' }))).status).toBe(202);
    expect(await drainLegacy()).toBe(1);
    const legacy = take(t, 'legacy');

    await doSwitch(t, c.conversionId, []);
    expect((await post(JSON.stringify({ n: 'flow' }))).status).toBe(202);
    const runs = await driveFlowRuns(t, c.flowId);
    expect(runs.map((r) => r.status)).toEqual(['completed']);
    const flow = take(t, 'flow');

    expect(legacy.alerts).toHaveLength(2);
    expectParity(legacy, flow);
  }, 120_000);

  runDb('manual + execute_command: the generated script carries the same bytes', async () => {
    const t = await tenant();
    const COMMAND = 'Get-Service | Where-Object Status -eq "Stopped" | Select-Object -First 3';
    const row = await job(t, {
      conditions: { type: 'devices', deviceIds: t.deviceIds.slice(0, 2) },
      actions: [{ type: 'execute_command', command: COMMAND, shell: 'powershell', whenOffline: 'queue' }],
    } as Partial<typeof automations.$inferInsert>);
    const c = await converted(t, row);

    await legacyManual(row);
    const legacy = take(t, 'legacy');

    await doSwitch(t, c.conversionId, ['a0_command']);
    const started = await t.asOrg(() => startManualRun(t.auth(), c.flowId, { inputs: {} }, 'ui'));
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect((await driveFlowRun(t, started.runId)).status).toBe('completed');
    const flow = take(t, 'flow');

    const sha = createHash('sha256').update(COMMAND, 'utf8').digest('hex');
    expect(legacy.dispatches.every((d) => d.includes(sha))).toBe(true);
    expect(legacy.dispatches).toHaveLength(2);
    expectParity(legacy, flow);
  }, 120_000);

  for (const whenOffline of ['queue', 'skip'] as const) {
    runDb(`an offline device under ${whenOffline}`, async () => {
      const t = await tenant();
      await system(() => db.update(devices).set({ status: 'offline' }).where(inArray(devices.id, t.deviceIds)));
      const row = await job(t, {
        conditions: { type: 'devices', deviceIds: [t.deviceIds[0]!] },
        actions: [
          { type: 'run_script', scriptId: t.script.id, whenOffline },
          { type: 'send_notification', notificationChannelId: t.channelId, severity: 'info' },
        ],
      } as Partial<typeof automations.$inferInsert>);
      const c = await converted(t, row);

      await legacyManual(row);
      const legacy = take(t, 'legacy');

      await doSwitch(t, c.conversionId, ['a0_run_script']);
      const started = await t.asOrg(() => startManualRun(t.auth(), c.flowId, { inputs: {} }, 'ui'));
      if (!started.ok) throw new Error(JSON.stringify(started));
      await driveFlowRun(t, started.runId);
      const flow = take(t, 'flow');

      expect(legacy.dispatches).toHaveLength(1);
      expect(legacy.dispatches[0]).toContain(whenOffline === 'skip' ? '"reject"' : '"queue"');
      expectParity(legacy, flow);
    }, 120_000);
  }
});
