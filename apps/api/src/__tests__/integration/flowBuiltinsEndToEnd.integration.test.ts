/**
 * Tool Catalog W05 (#5220), plan Task B6 — the W5 built-ins end to end on REAL
 * Postgres: enableFlow (rule 7 over built-ins) → startManualRun →
 * processFlowRunJob slices → stepExecutor → executeFlowBuiltin, the Tier-3
 * `http_request` park → real approval route → releaseApprovedIntent →
 * executeReleasedFlowBuiltin, and the `ai` step's real budget reservation,
 * ledger settle (`ai_invocations.flow_run_id`) and run token counter.
 *
 * Mocked, and only at the network edge: `safeFetch` (the egress guard itself
 * is proven against the real implementation in httpRequest.test.ts), the email
 * transport, `resolveModel` (no AI model registry is seeded here) and the
 * Anthropic client. The flow-runs BullMQ producer is mocked as in
 * flowRunnerEndToEnd (each slice is driven by calling processFlowRunJob).
 * Every row is real; the file runs with DB_CONTEXTLESS_WRITE_STRICT=true.
 */
import './setup';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Job } from 'bullmq';

const h = vi.hoisted(() => ({
  enqueueFlowRunSlice: vi.fn(async (_runId: string, _opts?: { delayMs?: number }) => 'job'),
  safeFetch: vi.fn(),
  sendEmailNotification: vi.fn(async (_payload: Record<string, unknown>) => ({ success: true })),
  resolveModel: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../jobs/flowRunQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/flowRunQueue')>()),
  enqueueFlowRunSlice: h.enqueueFlowRunSlice,
}));
vi.mock('../../services/urlSafety', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/urlSafety')>()),
  safeFetch: h.safeFetch,
}));
vi.mock('../../services/notificationSenders/emailSender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/notificationSenders/emailSender')>()),
  sendEmailNotification: h.sendEmailNotification,
}));
vi.mock('../../services/aiModels/resolveModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/aiModels/resolveModel')>()),
  resolveModel: h.resolveModel,
}));
vi.mock('../../services/aiModels/connectionFactory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/aiModels/connectionFactory')>()),
  anthropicClientFor: () => ({ messages: { create: h.create }, beta: { messages: { create: h.create } } }),
}));

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { actionIntents, aiInvocations, approvalRequests, flowRuns, flowRunSteps, flows } from '../../db/schema';
import type { FlowRunRow } from '../../db/schema/flowRuns';
import { processFlowRunJob } from '../../jobs/flowRunner';
import type { FlowRunJobData } from '../../jobs/queueSchemas';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { approvalRoutes } from '../../routes/approvals';
import { makeResolvedModel } from '../../services/aiModels/__fixtures__/resolvedModel';
import { countRunBuiltinCalls } from '../../services/flows/builtins/runCounters';
import { findOwnedNotificationChannel } from '../../services/flows/ownedReferences';
import { acquireRunLease, reserveRunAiTokens, settleRunAiTokens } from '../../services/flows/runLease';
import { startManualRun } from '../../services/flows/runService';
import { enableFlow } from '../../services/flows/versions';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { interactiveOrgAuth, orgContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ENV_KEYS = ['FLOWS_ENABLED', 'DB_CONTEXTLESS_WRITE_STRICT', 'PUBLIC_API_URL'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FLOWS_ENABLED = 'true';
  process.env.DB_CONTEXTLESS_WRITE_STRICT = 'true';
  process.env.PUBLIC_API_URL = 'https://breeze.example.test';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  for (const f of Object.values(h)) f.mockClear();
  h.enqueueFlowRunSlice.mockResolvedValue('job');
  h.sendEmailNotification.mockResolvedValue({ success: true });
});

// ── fixture ─────────────────────────────────────────────────────────────────

interface Fixture {
  partnerId: string;
  orgId: string;
  admin: { id: string; email: string };
  roleId: string;
}

/** One org and an admin holding every permission the built-ins need (rule 7) plus approvals:decide. */
async function fixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [
    { resource: 'alerts', action: 'write' },
    { resource: 'external_tools', action: 'use' },
    { resource: 'external_tools', action: 'write' },
    { resource: 'ai_sessions', action: 'use' },
    { resource: 'approvals', action: 'decide' },
    { resource: 'automations', action: 'read' },
    { resource: 'automations', action: 'write' },
  ]);
  const admin = await createUser({ partnerId: partner.id, orgId: org.id, email: `flow-b-${randomUUID()}@flowbuiltins.test` });
  await assignUserToOrganization(admin.id, org.id, role.id);
  return { partnerId: partner.id, orgId: org.id, admin: { id: admin.id, email: admin.email }, roleId: role.id };
}

const authFor = (f: Fixture) => interactiveOrgAuth(f.orgId, f.partnerId, f.admin, f.roleId);
const inCaller = <T>(f: Fixture, fn: () => Promise<T>) => withDbAccessContext(orgContext(f.orgId, f.partnerId, f.admin.id), fn);

async function emailChannel(owner: { orgId: string | null; partnerId: string }): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const rows = (await db.execute(sql`
      INSERT INTO notification_channels (org_id, partner_id, name, type, enabled)
      VALUES (${owner.orgId}::uuid, ${owner.orgId ? null : owner.partnerId}::uuid, ${`flow-b-${randomUUID().slice(0, 8)}`}, 'email', true)
      RETURNING id`)) as unknown as Array<{ id: string }>;
    const id = rows[0]!.id;
    await db.execute(sql`INSERT INTO notification_channel_configs (channel_id, config) VALUES (${id}::uuid, ${JSON.stringify({ recipients: ['ops@example.com'] })}::jsonb)`);
    return id;
  });
}

async function enabledFlow(f: Fixture, doc: Record<string, unknown>): Promise<string> {
  const [draft] = await withSystemDbAccessContext(() => db.insert(flows).values({
    orgId: f.orgId, slug: `b_${randomUUID().replace(/-/g, '').slice(0, 10)}`, name: String(doc.name), definition: doc, effectiveTier: 1,
  }).returning({ id: flows.id }));
  const enabled = await inCaller(f, () => enableFlow(authFor(f), draft!.id, { expectedVersion: 1, preApprovedStepIds: [] }));
  if (!enabled.ok) throw new Error(`enableFlow refused: ${JSON.stringify(enabled)}`);
  return draft!.id;
}

async function startRun(f: Fixture, flowId: string): Promise<string> {
  const started = await inCaller(f, () => startManualRun(authFor(f), flowId, { inputs: {} }, 'ui'));
  if (!started.ok) throw new Error(`startManualRun refused: ${JSON.stringify(started)}`);
  return started.runId;
}

function slice(runId: string): Promise<void> {
  return processFlowRunJob({ id: `it-${randomUUID()}`, name: 'flow-run-slice', data: { runId } } as unknown as Job<FlowRunJobData>);
}

async function readRun(runId: string): Promise<FlowRunRow> {
  const [run] = await withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.id, runId)));
  return run!;
}

async function readSteps(runId: string) {
  return withSystemDbAccessContext(() => db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, runId)).orderBy(flowRunSteps.startedAt));
}

async function approveViaRoute(f: Fixture, approvalId: string): Promise<Response> {
  const token = await createAccessToken({
    sub: f.admin.id, email: f.admin.email, roleId: f.roleId, orgId: f.orgId, partnerId: f.partnerId,
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

const STEP = { approval: 'default', onFailure: 'stop', timeoutSec: 120 } as const;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── http_request GET → set → notify ─────────────────────────────────────────

describe('W5 built-ins end to end (real Postgres)', () => {
  runDb('http_request GET → set → notify completes with stored outputs; the email goes once', async () => {
    const f = await fixture();
    const channelId = await emailChannel({ orgId: f.orgId, partnerId: f.partnerId });
    h.safeFetch.mockResolvedValueOnce(json({ healthy: true, queue: 3 }));
    const flowId = await enabledFlow(f, {
      version: 1, name: 'Status probe', trigger: { type: 'manual' }, inputs: [],
      steps: [
        { id: 'fetch', tool: 'http_request', input: { method: 'GET', url: 'https://api.example.com/v1/status' }, ...STEP },
        { id: 'pick', tool: 'set', input: { values: { queue: '{{steps.fetch.output.body.queue}}' } }, ...STEP },
        { id: 'tell', tool: 'notify', input: { channelId, title: 'Queue {{steps.pick.output.queue}}', message: 'Status probe ran.' }, ...STEP },
      ],
    });
    const runId = await startRun(f, flowId);
    await slice(runId);

    const run = await readRun(runId);
    expect(run, JSON.stringify({ error: run.error })).toMatchObject({ status: 'completed', errorCode: null });
    const steps = await readSteps(runId);
    expect(steps.map((s) => [s.stepId, s.toolSource, s.tier, s.status])).toEqual([
      ['fetch', 'builtin', 2, 'completed'], ['pick', 'builtin', 1, 'completed'], ['tell', 'builtin', 2, 'completed'],
    ]);
    expect(steps[0]!.output).toEqual({ status: 200, headers: { 'content-type': 'application/json' }, body: { healthy: true, queue: 3 } });
    expect(steps[2]!.output).toEqual({ channelId, sent: true });
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    expect(h.safeFetch.mock.calls[0]![0]).toBe('https://api.example.com/v1/status');
    expect(h.sendEmailNotification).toHaveBeenCalledTimes(1);
    expect(h.sendEmailNotification.mock.calls[0]![0]).toMatchObject({ to: ['ops@example.com'], alertName: 'Queue 3', summary: 'Status probe ran.' });
  });

  runDb('enable refuses an http_request flow for an enabler without external_tools.write (rule 7 over built-ins)', async () => {
    const f = await fixture();
    const role = await createRole({ scope: 'organization', orgId: f.orgId });
    await grantRolePermissions(role.id, [{ resource: 'automations', action: 'write' }, { resource: 'external_tools', action: 'use' }]);
    const weak = await createUser({ partnerId: f.partnerId, orgId: f.orgId, email: `flow-b-weak-${randomUUID()}@flowbuiltins.test` });
    await assignUserToOrganization(weak.id, f.orgId, role.id);
    const [draft] = await withSystemDbAccessContext(() => db.insert(flows).values({
      orgId: f.orgId, slug: `b_${randomUUID().replace(/-/g, '').slice(0, 10)}`, name: 'Weak',
      definition: { version: 1, name: 'Weak', trigger: { type: 'manual' }, inputs: [], steps: [{ id: 'call', tool: 'http_request', input: { method: 'GET', url: 'https://api.example.com/x' }, ...STEP }] },
      effectiveTier: 2,
    }).returning({ id: flows.id }));
    const res = await withDbAccessContext(orgContext(f.orgId, f.partnerId, weak.id), () =>
      enableFlow(interactiveOrgAuth(f.orgId, f.partnerId, { id: weak.id, email: weak.email }, role.id), draft!.id, { expectedVersion: 1, preApprovedStepIds: [] }));
    expect(res).toEqual({ ok: false, error: 'permission_missing', missing: [{ stepId: 'call', permission: 'external_tools.write' }] });
  });

  // ── http_request POST: Tier 3 → approval → release worker ────────────────

  runDb('http_request POST parks, is approved through the real decide route and executes through the release worker', async () => {
    const f = await fixture();
    const flowId = await enabledFlow(f, {
      version: 1, name: 'Open ticket', trigger: { type: 'manual' }, inputs: [],
      steps: [{ id: 'post', tool: 'http_request', input: { method: 'POST', url: 'https://api.example.com/v1/tickets', body: { title: 'Disk full' } }, ...STEP }],
    });
    const runId = await startRun(f, flowId);
    await slice(runId);

    const parked = await readRun(runId);
    expect(parked, JSON.stringify({ error: parked.error })).toMatchObject({ status: 'awaiting_approval', currentStepId: 'post', leaseToken: null });
    const step = (await readSteps(runId))[0]!;
    expect(step).toMatchObject({ toolSource: 'builtin', tier: 3, status: 'awaiting_approval', approvalMode: 'intent' });
    const intentId = step.actionIntentId!;
    const [intent] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(intent).toMatchObject({
      actionName: 'http_request', source: 'flow', requestingFlowRunId: runId, status: 'pending_approval',
      approvalScope: 'supervised', riskTier: 3, policyDecisionState: 'human_required',
      arguments: { method: 'POST', url: 'https://api.example.com/v1/tickets', body: { title: 'Disk full' } },
    });
    expect(h.safeFetch).not.toHaveBeenCalled();

    const [approval] = await withSystemDbAccessContext(() => db.select({ id: approvalRequests.id }).from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, f.admin.id))));
    expect(approval, 'the delegator is in the supervised flow intent\'s approver pool').toBeDefined();
    const decided = await approveViaRoute(f, approval!.id);
    expect(decided.status, await decided.clone().text()).toBe(200);

    h.safeFetch.mockResolvedValueOnce(json({ id: 42 }, 201));
    await releaseApprovedIntent(intentId);
    const [released] = await withSystemDbAccessContext(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(released!.status, JSON.stringify({ errorCode: released!.errorCode, result: released!.result })).toBe('completed');
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    expect(h.safeFetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: '{"title":"Disk full"}', redirect: 'manual' });

    await slice(runId);
    const done = await readRun(runId);
    expect(done, JSON.stringify({ error: done.error })).toMatchObject({ status: 'completed', errorCode: null });
    const finished = (await readSteps(runId))[0]!;
    expect(finished).toMatchObject({ status: 'completed', approvedByUserId: f.admin.id });
    expect(finished.output).toMatchObject({ status: 201, body: { id: 42 } });
  });

  // ── ai: budget, ledger, run counter ──────────────────────────────────────

  runDb('an ai step writes ai_invocations.flow_run_id, flow_run_steps.ai_* and charges the run org\'s ai_cost_usage', async () => {
    const f = await fixture();
    h.resolveModel.mockResolvedValue(makeResolvedModel('platform', {
      surface: 'ai_agents', orgId: f.orgId, partnerId: f.partnerId, thinking: 'none', offering: { id: null, displayName: 'Test model' },
      wireParams: { betas: [], applied: {} } as never, options: {},
    }));
    h.create.mockResolvedValueOnce({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_sequence: null, stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_result', input: { verdict: 'ok' } }],
      usage: { input_tokens: 1_000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    const monthKey = new Date().toISOString().slice(0, 7);
    const costBefore = await monthlyCostCents(f.orgId, monthKey);

    const flowId = await enabledFlow(f, {
      version: 1, name: 'Judge', trigger: { type: 'manual' }, inputs: [],
      steps: [{ id: 'think', tool: 'ai', input: { prompt: 'Is it fine?', tools: [], output: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } }, ...STEP }],
    });
    const runId = await startRun(f, flowId);
    await slice(runId);

    const run = await readRun(runId);
    expect(run, JSON.stringify({ error: run.error })).toMatchObject({ status: 'completed', aiTokensUsed: 1_200 });
    const step = (await readSteps(runId))[0]!;
    expect(step).toMatchObject({ status: 'completed', aiInputTokens: 1_000, aiOutputTokens: 200 });
    expect(step.aiCostCents).toBeGreaterThanOrEqual(0);
    expect(step.output).toMatchObject({ result: { verdict: 'ok' }, turns: 1 });

    const invocations = await withSystemDbAccessContext(() => db.select().from(aiInvocations).where(eq(aiInvocations.flowRunId, runId)));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ orgId: f.orgId, surface: 'ai_agents', flowRunId: runId });
    expect(await monthlyCostCents(f.orgId, monthKey)).toBeGreaterThan(costBefore);
  });
});

async function monthlyCostCents(orgId: string, periodKey: string): Promise<number> {
  const rows = (await withSystemDbAccessContext(() => db.execute(sql`
    SELECT COALESCE(SUM(total_cost_cents), 0)::float AS c FROM ai_cost_usage
    WHERE org_id = ${orgId}::uuid AND period = 'monthly' AND period_key = ${periodKey}`))) as unknown as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}

// ── the SQL the unit tests mock ─────────────────────────────────────────────

describe('W5 built-in SQL on a real database', () => {
  runDb('reserveRunAiTokens refuses over the cap and on a superseded lease; settle moves the counter', async () => {
    const f = await fixture();
    const flowId = await enabledFlow(f, {
      version: 1, name: 'Counter', trigger: { type: 'manual' }, inputs: [], steps: [{ id: 'a', tool: 'set', input: { values: { x: 1 } }, ...STEP }],
    });
    const runId = await startRun(f, flowId);
    const lease = await acquireRunLease(runId, ['queued']);
    expect(lease).not.toBeNull();
    expect(await reserveRunAiTokens(runId, lease!.token, 600, 1_000)).toBe(true);
    expect(await reserveRunAiTokens(runId, lease!.token, 600, 1_000)).toBe(false); // 1,200 > 1,000
    expect(await reserveRunAiTokens(runId, randomUUID(), 100, 1_000)).toBe(false); // not the lease holder
    expect((await readRun(runId)).aiTokensUsed).toBe(600);
    await settleRunAiTokens(runId, lease!.token, 600, 150);
    expect((await readRun(runId)).aiTokensUsed).toBe(150);
    // Two concurrent reservations at the edge: exactly one fits.
    const both = await Promise.all([reserveRunAiTokens(runId, lease!.token, 500, 1_000), reserveRunAiTokens(runId, lease!.token, 500, 1_000)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect((await readRun(runId)).aiTokensUsed).toBe(650);
  });

  runDb('countRunBuiltinCalls counts this run\'s notify/http_request attempts (the in-flight row included), never skipped rows or other runs', async () => {
    const f = await fixture();
    const flowId = await enabledFlow(f, {
      version: 1, name: 'Counts', trigger: { type: 'manual' }, inputs: [], steps: [{ id: 'a', tool: 'set', input: { values: { x: 1 } }, ...STEP }],
    });
    const runId = await startRun(f, flowId);
    const otherRunId = await startRun(f, flowId);
    const row = (run: string, stepId: string, tool: string, status: string, attempt = 1) => ({
      id: randomUUID(), runId: run, orgId: f.orgId, stepId, itemIndex: null, attempt, tool,
      toolSource: tool === 'run_script' ? 'core' : 'builtin', tier: tool === 'notify' ? 2 : 3, status, startedAt: new Date(),
      ...(status === 'running' || status === 'awaiting_approval' ? {} : { finishedAt: new Date() }),
      ...(status === 'failed' ? { errorCode: 'http_status', error: 'The server answered 500.' } : {}),
    }) as typeof flowRunSteps.$inferInsert;
    await withSystemDbAccessContext(() => db.insert(flowRunSteps).values([
      row(runId, 'n1', 'notify', 'completed'),
      row(runId, 'n2', 'notify', 'running'),            // the call being made
      row(runId, 'n3', 'notify', 'skipped'),            // `when` false: nothing sent
      row(runId, 'h1', 'http_request', 'completed'),
      row(runId, 'h1', 'http_request', 'failed', 2),
      row(otherRunId, 'n1', 'notify', 'completed'),     // another run
    ]));
    expect(await countRunBuiltinCalls(runId)).toEqual({ notify: 2, http: 2 });
    expect(await countRunBuiltinCalls(otherRunId)).toEqual({ notify: 1, http: 0 });
  });

  runDb('findOwnedNotificationChannel: an org flow sees its org\'s and its partner\'s partner-wide channels; a partner-wide flow only partner-wide ones', async () => {
    const f = await fixture();
    const other = await createOrganization({ partnerId: f.partnerId });
    const orgChannel = await emailChannel({ orgId: f.orgId, partnerId: f.partnerId });
    const partnerChannel = await emailChannel({ orgId: null, partnerId: f.partnerId });
    const otherOrgChannel = await emailChannel({ orgId: other.id, partnerId: f.partnerId });
    const foreignPartner = await createPartner();
    const foreignChannel = await emailChannel({ orgId: null, partnerId: foreignPartner.id });

    const orgOwner = { orgId: f.orgId, partnerId: f.partnerId };
    const partnerOwner = { orgId: null, partnerId: f.partnerId };
    expect(await findOwnedNotificationChannel(orgOwner, orgChannel)).toMatchObject({ id: orgChannel, type: 'email' });
    expect(await findOwnedNotificationChannel(orgOwner, partnerChannel)).toMatchObject({ id: partnerChannel });
    expect(await findOwnedNotificationChannel(orgOwner, otherOrgChannel)).toBeNull();
    expect(await findOwnedNotificationChannel(orgOwner, foreignChannel)).toBeNull();
    expect(await findOwnedNotificationChannel(partnerOwner, partnerChannel)).toMatchObject({ id: partnerChannel });
    expect(await findOwnedNotificationChannel(partnerOwner, orgChannel)).toBeNull();
    expect(await findOwnedNotificationChannel(partnerOwner, foreignChannel)).toBeNull();
  });
});
