/**
 * Tool Catalog W06 (#5221), plan Task A6 — the fleet pre-approval lane and the
 * parked-approval device freeze on REAL Postgres: enableFlow (fleet_v1 binding
 * with maxTargets on the new publication) → startManualRun (UI, honours
 * pre-approvals) → processFlowRunJob → stepExecutor → fleetStep →
 * run_script_on_targets → scriptFleetDispatch (real script_executions /
 * device_commands rows, real per-device flow_run_steps claims); and the parked
 * path: frozen intent arguments → real approval route → releaseApprovedIntent
 * (mandatory effect digest, verified snapshot) → exactly the frozen devices.
 *
 * Mocked: only the flow-runs BullMQ producer (each slice is driven by calling
 * processFlowRunJob, as flowRunnerEndToEnd does). No agent is connected, so a
 * dispatch is queued (`no_agent`) — queued is success.
 */
import './setup';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Job } from 'bullmq';

const h = vi.hoisted(() => ({
  enqueueFlowRunSlice: vi.fn(async (_runId: string, _opts?: { delayMs?: number }) => 'job'),
}));
vi.mock('../../jobs/flowRunQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/flowRunQueue')>()),
  enqueueFlowRunSlice: h.enqueueFlowRunSlice,
}));

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { actionIntents, approvalRequests, flowRuns, flowRunSteps, flows, scriptExecutions, scripts } from '../../db/schema';
import type { FlowRunRow } from '../../db/schema/flowRuns';
import { processFlowRunJob } from '../../jobs/flowRunner';
import type { FlowRunJobData } from '../../jobs/queueSchemas';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { approvalRoutes } from '../../routes/approvals';
import { startManualRun } from '../../services/flows/runService';
import { enableFlow } from '../../services/flows/versions';
import { createAccessToken } from '../../services/jwt';
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
import { getTestDb } from './setup';
import { interactiveOrgAuth, orgContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ENV_KEYS = ['FLOWS_ENABLED', 'DB_CONTEXTLESS_WRITE_STRICT'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FLOWS_ENABLED = 'true';
  process.env.DB_CONTEXTLESS_WRITE_STRICT = 'true';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  h.enqueueFlowRunSlice.mockClear().mockResolvedValue('job');
});

interface Fixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  admin: { id: string; email: string };
  roleId: string;
  scriptId: string;
}

async function fixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [
    { resource: 'scripts', action: 'execute' },
    { resource: 'scripts', action: 'read' },
    { resource: 'devices', action: 'read' },
    { resource: 'approvals', action: 'decide' },
    { resource: 'automations', action: 'read' },
    { resource: 'automations', action: 'write' },
  ]);
  const admin = await createUser({ partnerId: partner.id, orgId: org.id, email: `fleet-${randomUUID()}@fleetlane.test` });
  await assignUserToOrganization(admin.id, org.id, role.id);
  const [script] = await withSystemDbAccessContext(() => db.insert(scripts).values({
    orgId: org.id, partnerId: partner.id, name: `Fleet fix ${randomUUID().slice(0, 8)}`, language: 'powershell', content: 'Write-Output fixed',
    osTypes: ['windows'], runAs: 'system', timeoutSeconds: 60, createdBy: admin.id,
  }).returning({ id: scripts.id }));
  return { partnerId: partner.id, orgId: org.id, siteId: site!.id, admin: { id: admin.id, email: admin.email }, roleId: role.id, scriptId: script!.id };
}

async function staticGroup(f: Fixture, deviceIds: string[]): Promise<string> {
  const [group] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO device_groups (org_id, site_id, name, type)
    VALUES (${f.orgId}, ${f.siteId}, ${`fleet-${randomUUID().slice(0, 8)}`}, 'static')
    RETURNING id`);
  for (const d of deviceIds) await addMember(f, group!.id, d);
  return group!.id;
}
async function addMember(f: Fixture, groupId: string, deviceId: string): Promise<void> {
  await getTestDb().execute(sql`INSERT INTO device_group_memberships (device_id, group_id, org_id) VALUES (${deviceId}, ${groupId}, ${f.orgId})`);
}
async function devices(f: Fixture, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await createDevice({ orgId: f.orgId, siteId: f.siteId })).id);
  return out;
}

const authFor = (f: Fixture) => interactiveOrgAuth(f.orgId, f.partnerId, f.admin, f.roleId);
const inCaller = <T>(f: Fixture, fn: () => Promise<T>) => withDbAccessContext(orgContext(f.orgId, f.partnerId, f.admin.id), fn);

const STEP = { approval: 'default', onFailure: 'continue', timeoutSec: 300 } as const;
function fleetDoc(f: Fixture, groupId: string) {
  return {
    version: 1, name: 'Fleet fix', trigger: { type: 'manual' }, inputs: [],
    steps: [{
      id: 'fix', tool: 'run_script_on_targets',
      input: { scriptId: f.scriptId, whenOffline: 'queue', target: { type: 'groups', groupIds: [groupId] } },
      ...STEP,
    }],
  };
}

async function enabledFlow(f: Fixture, doc: Record<string, unknown>, fleetMaxTargets?: Record<string, number>): Promise<string> {
  const [draft] = await withSystemDbAccessContext(() => db.insert(flows).values({
    orgId: f.orgId, slug: `fl_${randomUUID().replace(/-/g, '').slice(0, 10)}`, name: String(doc.name), definition: doc, effectiveTier: 3,
  }).returning({ id: flows.id }));
  const enabled = await inCaller(f, () => enableFlow(authFor(f), draft!.id, {
    expectedVersion: 1,
    preApprovedStepIds: fleetMaxTargets ? Object.keys(fleetMaxTargets) : [],
    ...(fleetMaxTargets ? { fleetMaxTargets } : {}),
  }));
  if (!enabled.ok) throw new Error(`enableFlow refused: ${JSON.stringify(enabled)}`);
  return draft!.id;
}

async function startRun(f: Fixture, flowId: string): Promise<string> {
  const started = await inCaller(f, () => startManualRun(authFor(f), flowId, { inputs: {} }, 'ui'));
  if (!started.ok) throw new Error(`startManualRun refused: ${JSON.stringify(started)}`);
  return started.runId;
}

const slice = (runId: string) =>
  processFlowRunJob({ id: `it-${randomUUID()}`, name: 'flow-run-slice', data: { runId } } as unknown as Job<FlowRunJobData>);

async function readRun(runId: string): Promise<FlowRunRow> {
  const [run] = await withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.id, runId)));
  return run!;
}
const stepRows = (runId: string) =>
  withSystemDbAccessContext(() => db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, runId)).orderBy(flowRunSteps.itemIndex));
const executionsFor = (deviceIds: string[], scriptId: string) =>
  withSystemDbAccessContext(() => db.select({ deviceId: scriptExecutions.deviceId, aiInitiatorKind: scriptExecutions.aiInitiatorKind })
    .from(scriptExecutions).where(and(inArray(scriptExecutions.deviceId, deviceIds), eq(scriptExecutions.scriptId, scriptId))));

async function approveViaRoute(f: Fixture, approvalId: string): Promise<Response> {
  const token = await createAccessToken({
    sub: f.admin.id, email: f.admin.email, roleId: f.roleId, orgId: f.orgId, partnerId: f.partnerId,
    scope: 'organization', mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalId}/approve`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
}

describe('fleet pre-approval lane (real Postgres, #5221)', () => {
  runDb('enable with maxTargets 2 on a 3-device group fails the run binding_drift with zero dispatches', async () => {
    const f = await fixture();
    const ids = await devices(f, 3);
    const groupId = await staticGroup(f, ids);
    const flowId = await enabledFlow(f, fleetDoc(f, groupId), { fix: 2 });

    const runId = await startRun(f, flowId);
    await slice(runId);

    const run = await readRun(runId);
    expect(run, JSON.stringify({ error: run.error })).toMatchObject({ status: 'failed', errorCode: 'binding_drift' });
    expect(await executionsFor(ids, f.scriptId)).toEqual([]);
    const rows = await stepRows(runId);
    expect(rows.map((r) => [r.itemIndex, r.status, r.errorCode])).toEqual([[null, 'failed', 'binding_drift']]);
  });

  runDb('within maxTargets the pre-approved step dispatches every device once, attributed to the flow, with per-device rows', async () => {
    const f = await fixture();
    const ids = await devices(f, 3);
    const groupId = await staticGroup(f, ids);
    const flowId = await enabledFlow(f, fleetDoc(f, groupId), { fix: 3 });

    const runId = await startRun(f, flowId);
    await slice(runId);

    const run = await readRun(runId);
    expect(run, JSON.stringify({ error: run.error })).toMatchObject({ status: 'completed', errorCode: null });
    const execs = await executionsFor(ids, f.scriptId);
    expect(execs.map((e) => e.deviceId).sort()).toEqual([...ids].sort());
    expect(new Set(execs.map((e) => e.aiInitiatorKind))).toEqual(new Set(['flow']));
    const rows = await stepRows(runId);
    const head = rows.find((r) => r.itemIndex === null)!;
    expect(head).toMatchObject({ status: 'completed', approvalMode: 'pre_approved' });
    expect(head.output).toMatchObject({ count: 3, failedDeviceIds: [], dispatchedDeviceIds: [...ids].sort() });
    expect(rows.filter((r) => r.itemIndex !== null).map((r) => [r.itemIndex, r.status])).toEqual([[0, 'completed'], [1, 'completed'], [2, 'completed']]);
  });

  runDb('a parked approval for 2 devices releases exactly 2 after a third joins', async () => {
    const f = await fixture();
    const [a, b, c] = await devices(f, 3);
    const groupId = await staticGroup(f, [a!, b!]);
    const flowId = await enabledFlow(f, fleetDoc(f, groupId)); // no pre-approval: every run asks

    const runId = await startRun(f, flowId);
    await slice(runId);
    const parked = await readRun(runId);
    expect(parked, JSON.stringify({ error: parked.error })).toMatchObject({ status: 'awaiting_approval', currentStepId: 'fix' });
    const head = (await stepRows(runId)).find((r) => r.itemIndex === null)!;
    const intentId = head.actionIntentId!;
    const [intent] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    // The approver sees exactly the frozen devices; the effect digest is pinned (mandatory).
    expect((intent!.arguments as { deviceIds: string[] }).deviceIds).toEqual([a!, b!].sort());
    expect(intent!.arguments).not.toHaveProperty('target');
    expect(intent!.effectDigest).toMatch(/^[0-9a-f]{64}$/);

    await addMember(f, groupId, c!); // the group grows while the approval waits

    const [approval] = await withSystemDbAccessContext(() => db.select({ id: approvalRequests.id }).from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, f.admin.id))));
    expect(approval).toBeDefined();
    const decided = await approveViaRoute(f, approval!.id);
    expect(decided.status, await decided.clone().text()).toBe(200);
    await releaseApprovedIntent(intentId);
    const [released] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(released!.status, JSON.stringify({ errorCode: released!.errorCode, result: released!.result })).toBe('completed');

    const execs = await executionsFor([a!, b!, c!], f.scriptId);
    expect(execs.map((e) => e.deviceId).sort()).toEqual([a!, b!].sort());

    await slice(runId);
    const done = await readRun(runId);
    expect(done, JSON.stringify({ error: done.error })).toMatchObject({ status: 'completed', errorCode: null });
  });

  runDb('a script edited while the approval waits fails the release content_changed and dispatches nothing', async () => {
    const f = await fixture();
    const ids = await devices(f, 2);
    const groupId = await staticGroup(f, ids);
    const flowId = await enabledFlow(f, fleetDoc(f, groupId));
    const runId = await startRun(f, flowId);
    await slice(runId);
    const head = (await stepRows(runId)).find((r) => r.itemIndex === null)!;
    const intentId = head.actionIntentId!;

    await withSystemDbAccessContext(() => db.update(scripts).set({ content: 'Remove-Item C:\\ -Recurse' }).where(eq(scripts.id, f.scriptId)));

    const [approval] = await withSystemDbAccessContext(() => db.select({ id: approvalRequests.id }).from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, f.admin.id))));
    expect((await approveViaRoute(f, approval!.id)).status).toBe(200);
    await releaseApprovedIntent(intentId);
    const [released] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(released).toMatchObject({ status: 'failed', errorCode: 'content_changed' });
    expect(await executionsFor(ids, f.scriptId)).toEqual([]);
  });
});
