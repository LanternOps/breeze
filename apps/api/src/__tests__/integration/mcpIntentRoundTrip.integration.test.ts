/**
 * B-W04 (#6158, Task 12 Step 1): the Tier-3-over-MCP round trip against real
 * Postgres (FORCE RLS as `breeze_app`) and real Redis.
 *
 *   tools/call (X-API-Key, real Hono route + apiKeyAuthMiddleware)
 *     -> action_intents row (source mcp_api, origin = the api_keys row)
 *        + approval_requests fan-out + intent_created outbox row
 *     -> normal CallToolResult with structuredContent.status 'pending_approval'
 *   approve / deny through the real /approvals route as the four-eyes approver
 *   processIntentReleaseJob (the worker's own job processor, called directly)
 *     -> rebuild from the LIVE key, Tier-3 ledger row with intent_id,
 *        dispatch, one `mcp.tool.<name>` audit row
 *   get_action_status over the same route -> completed + result
 *
 * The ONLY fake is the tool handler itself: the registry entry for
 * `restore_snapshot` is swapped for a spy (the pattern
 * mcpSelfManagedDbContextPredispatch uses), so `executeTool` — validation,
 * the device-tenant gate, context handling — runs for real and no backup
 * agent is needed. Everything else (auth, RLS, intent service, approvals,
 * release revalidation, ledger, audit) is production code.
 *
 * `restore_snapshot` is a flat Tier-3 tool classified `four_eyes`, so the
 * approval fans out to a separate approver (never the MCP requester), which is
 * the shape an MCP caller with no approval surface of its own actually gets.
 */
import './setup';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  aiToolExecutions,
  apiKeys,
  approvalRequests,
  auditLogs,
  intentOutbox,
} from '../../db/schema';
import { processIntentReleaseJob } from '../../jobs/intentReleaseWorker';
import { cancelActionIntent } from '../../services/actionIntents/intentService';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
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

const TOOL = 'restore_snapshot';
const AUDIT_ACTION = `mcp.tool.${TOOL}`;
const RESULT_MARKER = `roundtrip-${randomUUID()}`;

let app: Hono;
let approvalsApp: Hono;

beforeAll(async () => {
  const { Hono: HonoCtor } = await import('hono');
  const { mcpServerRoutes } = await import('../../routes/mcpServer');
  const { approvalRoutes } = await import('../../routes/approvals');
  app = new HonoCtor();
  app.route('/api/v1/mcp', mcpServerRoutes);
  approvalsApp = new HonoCtor();
  approvalsApp.route('/approvals', approvalRoutes);
});

// ---------------------------------------------------------------------------
// Tool handler spy (the one fake)
// ---------------------------------------------------------------------------

const handlerSpy = vi.fn(async (_input: Record<string, unknown>) =>
  JSON.stringify({ success: true, restoreJobId: 'job-roundtrip', marker: RESULT_MARKER }),
);
let restoreHandler: (() => void) | null = null;

async function installHandlerSpy(): Promise<void> {
  const { aiTools } = await import('../../services/aiTools');
  const original = aiTools.get(TOOL);
  if (!original) throw new Error(`${TOOL} is not registered`);
  aiTools.set(TOOL, { ...original, handler: handlerSpy as typeof original.handler });
  restoreHandler = () => aiTools.set(TOOL, original);
}

beforeEach(async () => {
  process.env.MCP_TIER3_INTENTS_ENABLED = 'true';
  handlerSpy.mockClear();
  await installHandlerSpy();
});

afterEach(() => {
  delete process.env.MCP_TIER3_INTENTS_ENABLED;
  restoreHandler?.();
  restoreHandler = null;
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface Fixture {
  partnerId: string;
  orgId: string;
  deviceId: string;
  requester: { id: string; email: string };
  approver: { id: string; email: string };
  approverRoleId: string;
  keyId: string;
  keyName: string;
  rawKey: string;
}

/**
 * One org with a device, an MCP requester whose org role backs the key's
 * `ai:read` + `ai:execute` scopes (API_KEY_SCOPE_POLICIES) and the tool's RBAC
 * (`devices:execute` + `backup:read`), a separate approver holding
 * `approvals:decide`, and a real human `api_keys` row minted by the requester.
 */
async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });

  const requesterRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(requesterRole.id, [
    PERMISSIONS.DEVICES_READ,
    PERMISSIONS.ALERTS_READ,
    PERMISSIONS.SCRIPTS_READ,
    PERMISSIONS.AUTOMATIONS_READ,
    PERMISSIONS.DEVICES_EXECUTE,
    PERMISSIONS.SCRIPTS_EXECUTE,
    PERMISSIONS.BACKUP_READ,
  ]);
  const requester = await createUser({ partnerId: partner.id, orgId: org.id, email: `mcp-req-${randomUUID()}@roundtrip.test` });
  await assignUserToOrganization(requester.id, org.id, requesterRole.id);

  const approverRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(approverRole.id, [PERMISSIONS.APPROVALS_DECIDE]);
  const approver = await createUser({ partnerId: partner.id, orgId: org.id, email: `mcp-apr-${randomUUID()}@roundtrip.test` });
  await assignUserToOrganization(approver.id, org.id, approverRole.id);

  const rawKey = `brz_${randomBytes(24).toString('hex')}`;
  const keyName = `roundtrip-${randomUUID().slice(0, 8)}`;
  const [key] = await withSystemDbAccessContext(() => db.insert(apiKeys).values({
    orgId: org.id,
    createdBy: requester.id,
    name: keyName,
    keyHash: createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12),
    scopes: ['ai:read', 'ai:execute'],
    status: 'active',
    // null = every MCP domain (restore_snapshot is domain `backup`).
    mcpDomains: null,
  }).returning({ id: apiKeys.id }));

  return {
    partnerId: partner.id,
    orgId: org.id,
    deviceId: device.id,
    requester: { id: requester.id, email: requester.email },
    approver: { id: approver.id, email: approver.email },
    approverRoleId: approverRole.id,
    keyId: key!.id,
    keyName,
    rawKey,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let rpcId = 0;
async function mcpCall(rawKey: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await app.request('/api/v1/mcp/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': rawKey },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function approverToken(f: Fixture): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: f.approver.id,
    email: f.approver.email,
    roleId: f.approverRoleId,
    orgId: f.orgId,
    partnerId: f.partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

async function decideAsApprover(f: Fixture, approvalRowId: string, action: 'approve' | 'deny'): Promise<Response> {
  return approvalsApp.request(`/approvals/${approvalRowId}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await approverToken(f)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

const sys = withSystemDbAccessContext;

async function readIntent(intentId: string) {
  const [row] = await sys(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1));
  return row!;
}

async function approvalRowsFor(intentId: string) {
  return sys(() => db
    .select({
      id: approvalRequests.id,
      userId: approvalRequests.userId,
      status: approvalRequests.status,
      requestingClientLabel: approvalRequests.requestingClientLabel,
      actionToolName: approvalRequests.actionToolName,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.intentId, intentId)));
}

async function ledgerRowsFor(intentId: string) {
  return sys(() => db
    .select({ id: aiToolExecutions.id, status: aiToolExecutions.status, toolName: aiToolExecutions.toolName })
    .from(aiToolExecutions)
    .where(eq(aiToolExecutions.intentId, intentId)));
}

/** Every `mcp.tool.<TOOL>` audit row that names this intent, either shape. */
async function toolAuditRowsFor(orgId: string, intentId: string) {
  return sys(() => db
    .select({
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      result: auditLogs.result,
      actorType: auditLogs.actorType,
      actorId: auditLogs.actorId,
      details: auditLogs.details,
    })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.orgId, orgId),
      eq(auditLogs.action, AUDIT_ACTION),
      sql`(${auditLogs.resourceId} = ${intentId} OR ${auditLogs.details}->'correlation'->>'intentId' = ${intentId})`,
    )));
}

/** Audit writes are fire-and-forget (createAuditLogAsync): poll briefly. */
async function pollFor<T>(read: () => Promise<T[]>, atLeast: number, timeoutMs = 2_000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = await read();
  while (rows.length < atLeast && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    rows = await read();
  }
  return rows;
}

/** A settle window so a stray second async write would have landed before we count. */
const settle = () => new Promise((r) => setTimeout(r, 300));

/** tools/call -> pending_approval; returns the intent id + the approver's row. */
async function fileIntent(f: Fixture, args: Record<string, unknown>) {
  const body = await mcpCall(f.rawKey, TOOL, args);
  expect(body.error).toBeUndefined();
  expect(body.result.isError).toBeUndefined();
  expect(body.result.structuredContent).toMatchObject({
    status: 'pending_approval',
    toolName: TOOL,
    approvalScope: 'four_eyes',
  });
  const actionId = body.result.structuredContent.actionId as string;
  expect(actionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(handlerSpy).not.toHaveBeenCalled();

  const rows = await approvalRowsFor(actionId);
  const approverRow = rows.find((r) => r.userId === f.approver.id);
  expect(approverRow).toBeTruthy();
  return { actionId, approverRowId: approverRow!.id, body };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('Tier-3 over MCP via action intents: round trip (B-W04, real Postgres)', () => {
  it('tools/call files an intent; approve + release runs it under the live key; get_action_status reports completed; a replay files a NEW intent', async () => {
    const f = await seed();
    const args = { snapshotId: randomUUID(), deviceId: f.deviceId };

    // --- 1. tools/call -> pending_approval ---------------------------------
    const { actionId, approverRowId } = await fileIntent(f, args);

    const intent = await readIntent(actionId);
    expect(intent).toMatchObject({
      status: 'pending_approval',
      source: 'mcp_api',
      originPrincipalKind: 'api_key',
      originPrincipalId: f.keyId,
      requestedByUserId: f.requester.id,
      requestingApiKeyId: null,
      orgId: f.orgId,
      actionName: TOOL,
      approvalScope: 'four_eyes',
      requestingClientLabel: `MCP · ${f.keyName}`,
    });
    expect(intent.idempotencyKey).toMatch(/^mcp:v1:/);

    // correlation_id is the server-minted request id: the same value the
    // request's own `mcp.tools.call` audit row carries as its resource id.
    const requestAudit = await pollFor(() => sys(() => db
      .select({ resourceId: auditLogs.resourceId })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, f.orgId), eq(auditLogs.action, 'mcp.tools.call'), eq(auditLogs.actorId, f.keyId)))), 1);
    expect(requestAudit).toHaveLength(1);
    expect(intent.correlationId).toBe(requestAudit[0]!.resourceId);

    // Four-eyes fan-out: the approver has the only row; the MCP requester none.
    const approvals = await approvalRowsFor(actionId);
    expect(approvals.map((r) => r.userId)).toEqual([f.approver.id]);
    expect(approvals[0]).toMatchObject({ status: 'pending', actionToolName: TOOL, requestingClientLabel: `MCP · ${f.keyName}` });

    const outbox = await sys(() => db
      .select({ eventType: intentOutbox.eventType })
      .from(intentOutbox)
      .where(eq(intentOutbox.intentId, actionId)));
    expect(outbox.map((r) => r.eventType)).toContain('intent_created');

    // Nothing ran and nothing was audited as a tool execution yet.
    expect(await ledgerRowsFor(actionId)).toHaveLength(0);
    expect(await toolAuditRowsFor(f.orgId, actionId)).toHaveLength(0);

    // A live replay of the identical call returns the SAME intent.
    const liveReplay = await mcpCall(f.rawKey, TOOL, args);
    expect(liveReplay.result.structuredContent).toMatchObject({ status: 'pending_approval', actionId });

    // --- 2. approve as the four-eyes approver -------------------------------
    const approveRes = await decideAsApprover(f, approverRowId, 'approve');
    expect(approveRes.status).toBe(200);
    expect((await readIntent(actionId)).status).toBe('approved');
    expect(handlerSpy).not.toHaveBeenCalled();

    // --- 3. release ---------------------------------------------------------
    await processIntentReleaseJob({ intentId: actionId, eventType: 'intent_approved' });

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(handlerSpy.mock.calls[0]![0]).toMatchObject(args);

    const released = await readIntent(actionId);
    expect(released.status).toBe('completed');
    expect(released.errorCode).toBeNull();
    expect(released.result).toMatchObject({ marker: RESULT_MARKER });

    const ledger = await ledgerRowsFor(actionId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ status: 'completed', toolName: TOOL });

    const audits = await pollFor(() => toolAuditRowsFor(f.orgId, actionId), 1);
    await settle();
    const settledAudits = await toolAuditRowsFor(f.orgId, actionId);
    expect(audits).toHaveLength(1);
    expect(settledAudits).toHaveLength(1);
    expect(settledAudits[0]).toMatchObject({
      resourceType: 'mcp_tool_execution',
      result: 'success',
      actorType: 'api_key',
      actorId: f.keyId,
    });
    const auditCorrelation = (settledAudits[0]!.details as { correlation?: Record<string, unknown> }).correlation;
    expect(auditCorrelation).toMatchObject({
      kind: 'intent_release',
      intentId: actionId,
      creationRequestId: intent.correlationId,
    });
    // `principalKey` is not asserted: the audit sanitizer redacts any detail
    // key containing "key", so it is stored as '[REDACTED]' (B-W03 shape).

    // --- 4. get_action_status ----------------------------------------------
    const status = await mcpCall(f.rawKey, 'get_action_status', { actionId });
    expect(status.error).toBeUndefined();
    expect(status.result.structuredContent).toMatchObject({ actionId, status: 'completed', toolName: TOOL });
    expect(status.result.structuredContent.result).toContain(RESULT_MARKER);

    // --- 5. replay after completion = a new request -------------------------
    const replay = await mcpCall(f.rawKey, TOOL, args);
    expect(replay.result.structuredContent.status).toBe('pending_approval');
    const replayId = replay.result.structuredContent.actionId as string;
    expect(replayId).not.toBe(actionId);
    expect((await readIntent(replayId)).status).toBe('pending_approval');
    // The completed one is untouched, and the replay did not dispatch.
    expect((await readIntent(actionId)).status).toBe('completed');
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('a key revoked between approve and release fails the intent mcp_origin_revoked and never dispatches', async () => {
    const f = await seed();
    const { actionId, approverRowId } = await fileIntent(f, { snapshotId: randomUUID(), deviceId: f.deviceId });

    const approveRes = await decideAsApprover(f, approverRowId, 'approve');
    expect(approveRes.status).toBe(200);
    expect((await readIntent(actionId)).status).toBe('approved');

    await sys(() => db.update(apiKeys).set({ status: 'revoked', updatedAt: new Date() }).where(eq(apiKeys.id, f.keyId)));

    await processIntentReleaseJob({ intentId: actionId, eventType: 'intent_approved' });

    const failed = await readIntent(actionId);
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('mcp_origin_revoked');
    expect(failed.executedAt).toBeNull();
    expect(handlerSpy).not.toHaveBeenCalled();
    // Refused before the ledger opens: no execution row for this intent.
    expect(await ledgerRowsFor(actionId)).toHaveLength(0);

    // The refusal is audited once as a failure (no success row).
    const audits = await pollFor(() => toolAuditRowsFor(f.orgId, actionId), 1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ resourceType: 'action_intent', resourceId: actionId, result: 'failure' });
    expect(audits[0]!.details).toMatchObject({ intentOutcome: 'release_refused', errorCode: 'mcp_origin_revoked' });
  }, 60_000);

  it('a denied intent ends rejected, and the redelivered intent_rejected job writes exactly ONE failure audit', async () => {
    const f = await seed();
    const { actionId, approverRowId } = await fileIntent(f, { snapshotId: randomUUID(), deviceId: f.deviceId });

    const denyRes = await decideAsApprover(f, approverRowId, 'deny');
    expect(denyRes.status).toBe(200);
    expect((await readIntent(actionId)).status).toBe('rejected');

    // The decide path itself writes no tool audit: the worker owns it.
    await settle();
    expect(await toolAuditRowsFor(f.orgId, actionId)).toHaveLength(0);

    // At-least-once delivery: the same event processed twice. The second
    // delivery runs after the first one's audit row has landed (the realistic
    // redelivery spacing; the writer's dedupe is check-then-insert).
    await processIntentReleaseJob({ intentId: actionId, eventType: 'intent_rejected' });
    const first = await pollFor(() => toolAuditRowsFor(f.orgId, actionId), 1);
    expect(first).toHaveLength(1);
    await processIntentReleaseJob({ intentId: actionId, eventType: 'intent_rejected' });
    await settle();

    const audits = await toolAuditRowsFor(f.orgId, actionId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      resourceType: 'action_intent',
      resourceId: actionId,
      result: 'failure',
      actorType: 'api_key',
      actorId: f.keyId,
    });
    expect(audits[0]!.details).toMatchObject({ intentOutcome: 'rejected', intentId: actionId, toolName: TOOL });

    expect((await readIntent(actionId)).status).toBe('rejected');
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(await ledgerRowsFor(actionId)).toHaveLength(0);
  }, 60_000);

  it('same human, two credentials: separate intents and no cross-read', async () => {
    const f = await seed();

    // Second api_keys row: same creator, same org, same scopes, different secret.
    const rawKeyB = `brz_${randomBytes(24).toString('hex')}`;
    const [keyB] = await sys(() => db.insert(apiKeys).values({
      orgId: f.orgId,
      createdBy: f.requester.id,
      name: `roundtrip-b-${randomUUID().slice(0, 8)}`,
      keyHash: createHash('sha256').update(rawKeyB).digest('hex'),
      keyPrefix: rawKeyB.slice(0, 12),
      scopes: ['ai:read', 'ai:execute'],
      status: 'active',
      mcpDomains: null,
    }).returning({ id: apiKeys.id }));
    expect(keyB!.id).not.toBe(f.keyId);

    const args = { snapshotId: randomUUID(), deviceId: f.deviceId };
    const a = await mcpCall(f.rawKey, TOOL, args);
    const b = await mcpCall(rawKeyB, TOOL, args);
    expect(a.result.structuredContent.status).toBe('pending_approval');
    expect(b.result.structuredContent.status).toBe('pending_approval');
    const actionA = a.result.structuredContent.actionId as string;
    const actionB = b.result.structuredContent.actionId as string;
    expect(actionA).toMatch(/^[0-9a-f-]{36}$/);
    expect(actionB).toMatch(/^[0-9a-f-]{36}$/);
    expect(actionB).not.toBe(actionA);

    expect(await readIntent(actionA)).toMatchObject({ originPrincipalId: f.keyId, status: 'pending_approval' });
    expect(await readIntent(actionB)).toMatchObject({ originPrincipalId: keyB!.id, status: 'pending_approval' });

    // Key B probes key A's intent, and a random unknown id for the baseline.
    const unknownId = randomUUID();
    const unknownStatus = await mcpCall(rawKeyB, 'get_action_status', { actionId: unknownId });
    const unknownCancel = await mcpCall(rawKeyB, 'cancel_action', { actionId: unknownId });
    expect(unknownStatus.error).toMatchObject({ code: -32602, data: { reason: 'not_found' } });
    expect(unknownCancel.error).toMatchObject({ code: -32602, data: { reason: 'not_found' } });

    const crossStatus = await mcpCall(rawKeyB, 'get_action_status', { actionId: actionA });
    const crossCancel = await mcpCall(rawKeyB, 'cancel_action', { actionId: actionA });
    for (const res of [crossStatus, crossCancel]) {
      expect(res.result).toBeUndefined();
      expect(res.error.code).toBe(-32602);
      expect(res.error.data).toEqual({ reason: 'not_found' });
    }
    // Indistinguishable from "no such action": same body modulo the JSON-RPC id.
    expect(crossStatus.error).toEqual(unknownStatus.error);
    expect(crossCancel.error).toEqual(unknownCancel.error);

    // Key A's intent is untouched and still readable by its own credential.
    expect((await readIntent(actionA)).status).toBe('pending_approval');
    const ownRead = await mcpCall(f.rawKey, 'get_action_status', { actionId: actionA });
    expect(ownRead.error).toBeUndefined();
    expect(ownRead.result.structuredContent).toMatchObject({
      actionId: actionA,
      status: 'pending_approval',
      toolName: TOOL,
    });
    expect(handlerSpy).not.toHaveBeenCalled();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// B-W06 (#6160): the same round trip as a Tasks-declaring 2026-07-28 client
// ---------------------------------------------------------------------------

const TASKS_EXT = 'io.modelcontextprotocol/tasks';

async function modernRpc(
  rawKey: string,
  method: string,
  params: Record<string, unknown>,
  opts: { declareTasks?: boolean; name?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'X-API-Key': rawKey,
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
  };
  const name = opts.name ?? (method === 'tools/call' ? String(params.name) : method.startsWith('tasks/') ? String(params.taskId) : undefined);
  if (name !== undefined) headers['Mcp-Name'] = name;
  const res = await app.request('/api/v1/mcp/sse', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: ++rpcId, method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': opts.declareTasks === false ? {} : { extensions: { [TASKS_EXT]: {} } },
        },
      },
    }),
  });
  return { status: res.status, body: await res.json() };
}

function requesterAuth(f: Fixture) {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([f.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: f.requester.id, email: f.requester.email, name: 'Requester', isPlatformAdmin: false },
    token: {
      sub: f.requester.id, email: f.requester.email, roleId: null, orgId: f.orgId, partnerId: f.partnerId,
      scope: 'organization', type: 'access', mfa: true,
    },
    partnerId: f.partnerId,
    orgId: f.orgId,
    scope: 'organization',
    accessibleOrgIds: [f.orgId],
    orgCondition,
    canAccessOrg,
  } as unknown as AuthContext;
}

async function fileTask(f: Fixture, args: Record<string, unknown>) {
  const { status, body } = await modernRpc(f.rawKey, 'tools/call', { name: TOOL, arguments: args });
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  expect(body.result).toMatchObject({ resultType: 'task', status: 'working' });
  const taskId = body.result.taskId as string;
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
  return { taskId, created: body.result };
}

describe('Tier-3 over MCP as a Task (B-W06, real Postgres)', () => {
  beforeEach(() => {
    process.env.MCP_STATELESS_ENABLED = 'true';
    process.env.MCP_TASKS_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.MCP_STATELESS_ENABLED;
    delete process.env.MCP_TASKS_ENABLED;
  });

  it('approve and release: task working → completed; result equals get_action_status; lastUpdatedAt = status_changed_at', async () => {
    const f = await seed();
    const { taskId, created } = await fileTask(f, { snapshotId: randomUUID(), deviceId: f.deviceId });
    const filed = await readIntent(taskId);
    expect(filed).toMatchObject({ status: 'pending_approval', source: 'mcp_api', originPrincipalId: f.keyId });
    expect(created.createdAt).toBe(filed.createdAt.toISOString());
    expect(created.statusMessage).toContain(`/approvals#intent-${taskId}`);

    const pending = await modernRpc(f.rawKey, 'tasks/get', { taskId });
    expect(pending.body.result).toMatchObject({ resultType: 'complete', taskId, status: 'working' });

    const approverRow = (await approvalRowsFor(taskId)).find((r) => r.userId === f.approver.id)!;
    expect((await decideAsApprover(f, approverRow.id, 'approve')).status).toBe(200);
    await processIntentReleaseJob({ intentId: taskId, eventType: 'intent_approved' });
    expect(handlerSpy).toHaveBeenCalledTimes(1);

    const done = await modernRpc(f.rawKey, 'tasks/get', { taskId });
    expect(done.body.result.status).toBe('completed');
    const status = await modernRpc(f.rawKey, 'tools/call', { name: 'get_action_status', arguments: { actionId: taskId } });
    expect(status.body.result.structuredContent).toMatchObject({ actionId: taskId, status: 'completed' });
    expect(done.body.result.result.structuredContent).toEqual(status.body.result.structuredContent);
    expect(done.body.result.result.content[0].text).toContain(RESULT_MARKER);

    const row = await readIntent(taskId);
    expect(row.statusChangedAt).toBeInstanceOf(Date);
    expect(done.body.result.lastUpdatedAt).toBe(row.statusChangedAt!.toISOString());
  }, 60_000);

  it('cancel while pending: tasks/cancel → {} → tasks/get → cancelled', async () => {
    const f = await seed();
    const { taskId } = await fileTask(f, { snapshotId: randomUUID(), deviceId: f.deviceId });
    const ack = await modernRpc(f.rawKey, 'tasks/cancel', { taskId });
    expect(ack.body.error).toBeUndefined();
    const { _meta, ...rest } = ack.body.result;
    expect(rest).toEqual({ resultType: 'complete' });
    expect((await readIntent(taskId)).status).toBe('cancelled');
    const got = await modernRpc(f.rawKey, 'tasks/get', { taskId });
    expect(got.body.result.status).toBe('cancelled');
    expect(handlerSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('cancel in the web app: tasks/get → cancelled with lastUpdatedAt advanced to the transition', async () => {
    const f = await seed();
    const { taskId, created } = await fileTask(f, { snapshotId: randomUUID(), deviceId: f.deviceId });
    const before = await modernRpc(f.rawKey, 'tasks/get', { taskId });
    expect(before.body.result.status).toBe('working');

    const result = await cancelActionIntent(requesterAuth(f), taskId);
    expect(result.ok).toBe(true);

    const after = await modernRpc(f.rawKey, 'tasks/get', { taskId });
    expect(after.body.result.status).toBe('cancelled');
    const row = await readIntent(taskId);
    expect(after.body.result.lastUpdatedAt).toBe(row.statusChangedAt!.toISOString());
    expect(Date.parse(after.body.result.lastUpdatedAt)).toBeGreaterThan(Date.parse(before.body.result.lastUpdatedAt));
    expect(Date.parse(after.body.result.lastUpdatedAt)).toBeGreaterThan(Date.parse(created.createdAt));
  }, 60_000);

  it('second credential of the same human: tasks/get and tasks/cancel → not found, identical to an unknown id', async () => {
    const f = await seed();
    const { taskId } = await fileTask(f, { snapshotId: randomUUID(), deviceId: f.deviceId });

    const rawKeyB = `brz_${randomBytes(24).toString('hex')}`;
    await sys(() => db.insert(apiKeys).values({
      orgId: f.orgId,
      createdBy: f.requester.id,
      name: `roundtrip-task-b-${randomUUID().slice(0, 8)}`,
      keyHash: createHash('sha256').update(rawKeyB).digest('hex'),
      keyPrefix: rawKeyB.slice(0, 12),
      scopes: ['ai:read', 'ai:execute'],
      status: 'active',
      mcpDomains: null,
    }));

    const unknownId = randomUUID();
    const unknown = await modernRpc(rawKeyB, 'tasks/get', { taskId: unknownId });
    const cross = await modernRpc(rawKeyB, 'tasks/get', { taskId });
    const crossCancel = await modernRpc(rawKeyB, 'tasks/cancel', { taskId });
    expect(unknown.body.error).toEqual({ code: -32602, message: 'Task not found', data: { reason: 'not_found' } });
    expect(cross.body.result).toBeUndefined();
    expect(cross.body.error).toEqual(unknown.body.error);
    expect(crossCancel.body.error).toEqual(unknown.body.error);
    expect((await readIntent(taskId)).status).toBe('pending_approval');

    // The owner still reads it.
    expect((await modernRpc(f.rawKey, 'tasks/get', { taskId })).body.result.status).toBe('working');
  }, 60_000);
});
