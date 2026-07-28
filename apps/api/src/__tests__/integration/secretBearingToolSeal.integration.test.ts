/**
 * Real-Postgres proof of seal parity for secret-bearing AI tools
 * (m365_reset_password, google_reset_password) across BOTH release paths
 * (the durable jobs/intentReleaseWorker.ts and the inline chat path in
 * services/aiAgentSdk.ts).
 *
 * WHY THIS FILE EXISTS: Tasks 1-8 of this plan are unit-tested against mocks
 * of the very things under test (secretCrypto, resultSecrets, the db layer).
 * Multiple tests in this plan initially PASSED while the feature was broken.
 * This suite is the independent check: real Postgres (breeze_app, RLS-bound),
 * real `sealToolSecrets`/`sealActionResultSecrets`, real `encryptSecret`, a
 * real reveal-secret HTTP route, and a real CAS burn.
 *
 * MOCKING BOUNDARY (deliberately minimal — this is the whole point):
 *  - Google: only `getDirectoryClient` (googleClient.ts) is mocked. Every
 *    other step — the DB-backed connection load, decrypt, `sealToolSecrets`,
 *    the CAS transitions, the reveal route — is real.
 *  - M365 durable: only `createGraphActionsExecutorClient` (the actual HTTP
 *    client to the customer-graph-actions executor) and the env-var-driven
 *    `writeActionRuntimeConfig` loader (pure config plumbing, no business
 *    logic) are mocked. `executeM365WriteActionByOrg`'s full ladder (feature
 *    flag, connection load, Redis write budget, `sealActionResultSecrets`)
 *    is real.
 *  - M365 inline: only `invokeDelegantTool` (the Delegant broker HTTP call)
 *    is mocked. Everything else — session/connection loads, `sealToolSecrets`
 *    via the real session-aware handler wrapper, the CAS completion — real.
 *
 * If you find yourself wanting to mock secretCrypto, sealToolSecrets,
 * resultSecrets, or the db layer to make this file pass, stop — that defeats
 * the purpose of this task.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  approvalRequests,
  aiMessages,
  aiSessions,
  aiToolExecutions,
  auditLogs,
  delegantM365Connections,
  googleWorkspaceConnections,
  m365Connections,
  organizationUsers,
  partnerUsers,
  rolePermissions,
  roles,
  users,
} from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { unsealTemporaryPassword } from '../../services/actionIntents/resultSecrets';
import { encryptSecret } from '../../services/secretCrypto';
import { PERMISSIONS } from '../../services/permissions';
import { approvalRoutes } from '../../routes/approvals';
import { actionIntentsRoutes } from '../../routes/actionIntents';
import { createSessionPreToolUse, createSessionPostToolUse } from '../../services/aiAgentSdk';
import { __test__ as sdkToolsTest } from '../../services/aiAgentSdkTools';
import { googleResetPasswordHandler } from '../../services/aiToolsGoogle';
import { m365ResetPasswordHandler } from '../../services/aiToolsM365';
import type { ActiveSession } from '../../services/streamingSessionManager';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

// ── Mocks: the outermost provider clients only (see file header) ──────────

const googleMocks = vi.hoisted(() => ({
  usersUpdate: vi.fn(async (_req: { requestBody: { password: string } }) => ({})),
}));
vi.mock('../../services/googleClient', () => ({
  getDirectoryClient: vi.fn(() => ({ users: { update: googleMocks.usersUpdate } })),
}));

const delegantMocks = vi.hoisted(() => ({ invokeDelegantTool: vi.fn() }));
vi.mock('../../services/delegantClient', () => ({
  invokeDelegantTool: delegantMocks.invokeDelegantTool,
}));

const m365ExecutorMocks = vi.hoisted(() => ({ executeWriteAction: vi.fn() }));
vi.mock('../../services/m365ControlPlane/graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: vi.fn(() => ({ executeWriteAction: m365ExecutorMocks.executeWriteAction })),
  GraphActionsExecutorClientError: class GraphActionsExecutorClientError extends Error {},
}));

// Pure config plumbing (env-var parsing), not business logic — mocked so the
// test doesn't need a real Ed25519 signing key file on disk. The actual HTTP
// client this config feeds is separately mocked above.
vi.mock('../../services/m365ControlPlane/writeActionRuntimeConfig', () => ({
  loadM365CustomerGraphActionsRuntimeConfig: vi.fn(() => ({
    clientId: 'test-client-id',
    vaultRef: 'akv://test-vault.example/m365-customer-graph-actions/00000000000000000000000000000000',
    credentialVersion: '00000000000000000000000000000000',
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-actions-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'test-kid',
  })),
  isM365GraphActionsEnabledForOrg: vi.fn(() => true),
}));

// ── Fixture scaffolding (mirrors intentFanout.integration.test.ts) ────────

interface Scenario {
  partnerId: string;
  orgId: string;
  requester: { id: string; email: string };
  requesterRoleId: string;
  approver: { id: string; email: string };
  userIds: string[];
  roleIds: string[];
}

async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });

  // Requester holds the tool's own RBAC permission only — deliberately NOT
  // approvals:decide, so createActionIntent's fan-out can never treat them as
  // an eligible approver (avoids the sole-operator self-approve L3 step-up
  // path entirely; a plain second-approver decide is all this suite needs).
  const requesterRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(requesterRole.id, [
    { resource: 'm365', action: 'execute' },
    { resource: 'google', action: 'execute' },
  ]);

  const approverRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(approverRole.id, [PERMISSIONS.APPROVALS_DECIDE]);

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@sealparity.test`,
  });
  await assignUserToOrganization(requester.id, org.id, requesterRole.id);

  const approver = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `approver-${randomUUID()}@sealparity.test`,
  });
  await assignUserToOrganization(approver.id, org.id, approverRole.id);

  return {
    partnerId: partner.id,
    orgId: org.id,
    requester: { id: requester.id, email: requester.email },
    requesterRoleId: requesterRole.id,
    approver: { id: approver.id, email: approver.email },
    userIds: [requester.id, approver.id],
    roleIds: [requesterRole.id, approverRole.id],
  };
}

async function cleanupScenario(s: Scenario) {
  await withSystemDbAccessContext(async () => {
    await db.delete(actionIntents).where(eq(actionIntents.orgId, s.orgId));
    // ai_messages / ai_tool_executions FK-reference ai_sessions.id — must be
    // cleared first (or the ai_sessions delete below 23503s).
    const sessionRows = await db
      .select({ id: aiSessions.id })
      .from(aiSessions)
      .where(eq(aiSessions.orgId, s.orgId));
    for (const { id } of sessionRows) {
      await db.delete(aiToolExecutions).where(eq(aiToolExecutions.sessionId, id));
      await db.delete(aiMessages).where(eq(aiMessages.sessionId, id));
    }
    await db.delete(aiSessions).where(eq(aiSessions.orgId, s.orgId));
    await db.delete(googleWorkspaceConnections).where(eq(googleWorkspaceConnections.orgId, s.orgId));
    await db.delete(m365Connections).where(eq(m365Connections.orgId, s.orgId));
    await db.delete(delegantM365Connections).where(eq(delegantM365Connections.orgId, s.orgId));
    await db.delete(organizationUsers).where(eq(organizationUsers.orgId, s.orgId));
    await db.delete(partnerUsers).where(eq(partnerUsers.partnerId, s.partnerId));
    for (const roleId of s.roleIds) {
      await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    }
    await db.delete(roles).where(eq(roles.orgId, s.orgId));
    await db.delete(users).where(eq(users.partnerId, s.partnerId));
  });
}

function requesterAuth(s: Scenario): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([s.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: s.requester.id, email: s.requester.email, name: 'Requester', isPlatformAdmin: false },
    token: {
      sub: s.requester.id,
      email: s.requester.email,
      roleId: s.requesterRoleId,
      orgId: s.orgId,
      partnerId: s.partnerId,
      scope: 'organization',
      type: 'access',
      mfa: true,
    },
    partnerId: s.partnerId,
    orgId: s.orgId,
    scope: 'organization',
    accessibleOrgIds: [s.orgId],
    orgCondition,
    canAccessOrg,
  };
}

async function approverAccessToken(s: Scenario, roleId: string): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.approver.id,
    email: s.approver.email,
    roleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

async function requesterAccessToken(s: Scenario): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.requester.id,
    email: s.requester.email,
    roleId: s.requesterRoleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

/** Fetch the approver's own fanned-out approval_requests row id for `intentId`. */
async function approvalRowIdFor(intentId: string, approverId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, approverId))),
  );
  if (!row) throw new Error(`no approval_requests row for intent ${intentId} / approver ${approverId}`);
  return row.id;
}

/** Drives the REAL approve route (real JWT + authMiddleware + breeze_app RLS). */
async function approveViaRoute(approvalRowId: string, token: string): Promise<Response> {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalRowId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function revealSecret(intentId: string, token: string): Promise<Response> {
  const app = new Hono();
  app.route('/action-intents', actionIntentsRoutes);
  return app.request(`/action-intents/${intentId}/reveal-secret`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Polls until an intent matching (orgId, toolName) reaches pending_approval,
 *  then approves it via the real route as the approver. Used for BOTH paths:
 *  durable creates the intent synchronously (no race), inline creates it
 *  inside a blocking preToolUse call (genuine race with waitForIntentDecision's
 *  poll loop) — this helper is safe for both since it simply waits. */
async function findAndApprove(s: Scenario, toolName: string, approverToken: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = await withSystemDbAccessContext(() =>
      db
        .select({ id: actionIntents.id })
        .from(actionIntents)
        .where(and(
          eq(actionIntents.orgId, s.orgId),
          eq(actionIntents.actionName, toolName),
          eq(actionIntents.status, 'pending_approval'),
        )),
    );
    if (row) {
      const approvalRowId = await approvalRowIdFor(row.id, s.approver.id);
      const res = await approveViaRoute(approvalRowId, approverToken);
      if (res.status !== 200) {
        throw new Error(`approve route failed: ${res.status} ${JSON.stringify(await res.json())}`);
      }
      return row.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`no pending_approval intent for ${toolName} appeared within the deadline`);
}

async function seedGoogleConnection(orgId: string): Promise<void> {
  const keyJson = JSON.stringify({ type: 'service_account', private_key: 'fake', client_email: 'svc@example.test' });
  const sealed = encryptSecret(keyJson, { aad: 'google_workspace_connections.service_account_key' });
  if (!sealed) throw new Error('test setup: encryptSecret returned null for the Google connection key');
  await withSystemDbAccessContext(() =>
    db.insert(googleWorkspaceConnections).values({
      orgId,
      customerDomain: 'example.test',
      adminEmail: 'admin@example.test',
      serviceAccountEmail: 'svc@example.test',
      serviceAccountKey: sealed,
      status: 'active',
    }),
  );
}

async function seedM365ActionsConnection(orgId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(m365Connections)
      .values({
        orgId,
        tenantId: randomUUID(),
        clientId: 'test-client-id',
        profile: 'customer-graph-actions',
        authMode: 'application-certificate',
        credentialDomain: 'customer-graph-actions',
        vaultRef: 'akv://test-vault.example/m365-customer-graph-actions/00000000000000000000000000000000',
        credentialVersion: '00000000000000000000000000000000',
        permissionManifestVersion: 1,
        status: 'active',
      })
      .returning({ id: m365Connections.id }),
  );
  return row!.id;
}

async function seedAiSessionForInline(orgId: string, userId: string, delegantConnId?: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(aiSessions)
      .values({
        orgId,
        userId,
        model: 'claude-sonnet-4-5-20250929',
        ...(delegantConnId ? { delegantM365ConnectionId: delegantConnId } : {}),
      })
      .returning({ id: aiSessions.id }),
  );
  return row!.id;
}

async function seedDelegantM365Connection(orgId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(delegantM365Connections)
      .values({
        orgId,
        customerLabel: `cust-${randomUUID()}`,
        customerDisplayName: 'Test Customer',
        delegantOrgId: 'delegant-org-1',
        delegantConnectionId: 'delegant-conn-1',
        m365TenantId: randomUUID(),
        status: 'active',
      })
      .returning({ id: delegantM365Connections.id }),
  );
  return row!.id;
}

function makeActiveSession(s: Scenario, breezeSessionId: string): ActiveSession {
  return {
    breezeSessionId,
    orgId: s.orgId,
    auth: requesterAuth(s),
    approvalMode: 'per_step',
    isPaused: false,
    eventBus: { publish: () => undefined },
    abortController: new AbortController(),
    activePlanId: null,
    approvedPlanSteps: new Map(),
    currentPlanStepIndex: 0,
    toolUseIdQueue: ['tool-use-1'],
    auditSnapshot: null,
    allowedTools: undefined,
  } as unknown as ActiveSession;
}

interface ExecuteResult {
  intentId: string;
  plaintext: string;
  /**
   * The real seeded ai_sessions.id for the inline path — the chat session
   * whose ai_messages/ai_tool_executions rows must be checked for a leak.
   * null for the durable path, which never creates a chat session at all
   * (releaseApprovedIntent has no session/chat concept); callers must NOT
   * substitute a fabricated id here — a query keyed to a nonexistent id
   * trivially "passes" without checking anything real.
   */
  sessionId: string | null;
}

/**
 * Drives ONE (toolName, path) combination end to end against real Postgres,
 * mocking only the outermost provider client (see file header), and returns
 * the intent id + the exact plaintext credential minted so callers can assert
 * on both without ever seeing it stored anywhere but the sealed ciphertext.
 */
async function executeApprovedReset(
  s: Scenario,
  toolName: 'google_reset_password' | 'm365_reset_password',
  path: 'durable' | 'inline',
): Promise<ExecuteResult> {
  const auth = requesterAuth(s);
  const approverToken = await approverAccessToken(s, await approverRoleId(s));

  if (toolName === 'google_reset_password') {
    await seedGoogleConnection(s.orgId);
    let capturedPassword = '';
    googleMocks.usersUpdate.mockImplementation(async (req: { requestBody: { password: string } }) => {
      capturedPassword = req.requestBody.password;
      return {};
    });

    if (path === 'durable') {
      const intent = await createActionIntent(auth, {
        toolName: 'google_reset_password',
        input: { userEmail: 'target@example.test', reason: 'integration test reset' },
        source: 'chat',
      });
      await findAndApprove(s, toolName, approverToken);
      await releaseApprovedIntent(intent.id);
      return { intentId: intent.id, plaintext: capturedPassword, sessionId: null };
    }

    // inline
    const sessionId = await seedAiSessionForInline(s.orgId, s.requester.id);
    const session = makeActiveSession(s, sessionId);
    const handler = sdkToolsTest.makeSessionAwareHandler(
      'google_reset_password',
      () => session.auth,
      () => session,
      googleResetPasswordHandler,
      createSessionPreToolUse(session),
      createSessionPostToolUse(session),
    );
    const [sdkResult] = await Promise.all([
      handler({ userEmail: 'target@example.test', reason: 'integration test reset' }),
      findAndApprove(s, toolName, approverToken),
    ]);
    const text = (sdkResult as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
    expect(text).not.toContain(capturedPassword);
    const [intentRow] = await withSystemDbAccessContext(() =>
      db
        .select({ id: actionIntents.id })
        .from(actionIntents)
        .where(and(eq(actionIntents.orgId, s.orgId), eq(actionIntents.actionName, toolName))),
    );
    return { intentId: intentRow!.id, plaintext: capturedPassword, sessionId };
  }

  // m365_reset_password
  const plaintext = `M365Temp!${randomUUID().slice(0, 8)}`;
  const targetUserId = randomUUID(); // bare object id (no '@') — skips the get_user resolution hop

  if (path === 'durable') {
    await seedM365ActionsConnection(s.orgId);
    m365ExecutorMocks.executeWriteAction.mockImplementation(async () => ({
      success: true,
      action: 'm365.user.reset_password',
      userId: targetUserId,
      temporaryPassword: plaintext,
      forceChangeNextSignIn: true,
    }));
    const intent = await createActionIntent(auth, {
      toolName: 'm365_reset_password',
      input: { userIdentifier: targetUserId, reason: 'integration test reset' },
      source: 'chat',
    });
    await findAndApprove(s, toolName, approverToken);
    await releaseApprovedIntent(intent.id);
    return { intentId: intent.id, plaintext, sessionId: null };
  }

  // inline — Delegant backend (no 'legacy-direct' m365Connections row seeded
  // for this org, so resolveContext falls through to the session's Delegant
  // connection).
  const delegantConnId = await seedDelegantM365Connection(s.orgId);
  const sessionId = await seedAiSessionForInline(s.orgId, s.requester.id, delegantConnId);
  delegantMocks.invokeDelegantTool.mockImplementation(async (args: { toolName: string }) => {
    if (args.toolName === 'reset_user_password') {
      return { kind: 'ok', data: { temporaryPassword: plaintext }, toolCallId: 'delegant-call-1' };
    }
    return { kind: 'error', code: 'bad_request', message: `unexpected Delegant tool in test: ${args.toolName}` };
  });
  const session = makeActiveSession(s, sessionId);
  const handler = sdkToolsTest.makeSessionAwareHandler(
    'm365_reset_password',
    () => session.auth,
    () => session,
    m365ResetPasswordHandler,
    createSessionPreToolUse(session),
    createSessionPostToolUse(session),
  );
  const [sdkResult] = await Promise.all([
    handler({ userIdentifier: targetUserId, reason: 'integration test reset' }),
    findAndApprove(s, toolName, approverToken),
  ]);
  const text = (sdkResult as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
  expect(text).not.toContain(plaintext);
  const [intentRow] = await withSystemDbAccessContext(() =>
    db
      .select({ id: actionIntents.id })
      .from(actionIntents)
      .where(and(eq(actionIntents.orgId, s.orgId), eq(actionIntents.actionName, toolName))),
  );
  return { intentId: intentRow!.id, plaintext, sessionId };
}

// The approver's roleId isn't tracked on Scenario directly (only the id is
// needed by tests) — re-derive it once per call from the DB rather than
// widening the Scenario shape for a single internal helper.
async function approverRoleId(s: Scenario): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ roleId: organizationUsers.roleId })
      .from(organizationUsers)
      .where(and(eq(organizationUsers.orgId, s.orgId), eq(organizationUsers.userId, s.approver.id))),
  );
  if (!row) throw new Error('approver has no organization_users row');
  return row.roleId;
}

let scenario: Scenario | null = null;

beforeEach(async () => {
  scenario = await seedScenario();
  googleMocks.usersUpdate.mockReset();
  delegantMocks.invokeDelegantTool.mockReset();
  m365ExecutorMocks.executeWriteAction.mockReset();
});

afterEach(async () => {
  const s = scenario;
  scenario = null;
  if (s) await cleanupScenario(s);
});

describe('secret-bearing tool seal parity (real PG)', () => {
  it.each([
    ['google_reset_password', 'durable'],
    ['m365_reset_password', 'durable'],
    ['google_reset_password', 'inline'],
    ['m365_reset_password', 'inline'],
  ] as const)('%s on the %s path seals the credential', async (toolName, path) => {
    const s = scenario!;
    const { intentId, plaintext, sessionId } = await executeApprovedReset(s, toolName, path);

    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(actionIntents).where(eq(actionIntents.id, intentId)),
    );
    expect(row).toBeDefined();
    expect(row!.status).toBe('completed');
    expect(row!.result).toHaveProperty('temporaryPasswordEnc');
    expect(String((row!.result as Record<string, unknown>).temporaryPasswordEnc)).toMatch(/^enc:v3:/);
    expect(JSON.stringify(row!.result)).not.toContain(plaintext);

    // The AAD genuinely round-trips: the real reveal-path decrypt function,
    // called directly (no DB, pure), must recover the exact plaintext under
    // ACTION_INTENT_RESULT_AAD — closing the loop two earlier tasks in this
    // plan left unproven.
    const decrypted = unsealTemporaryPassword(row!.result as Record<string, unknown>);
    expect(decrypted).toBe(plaintext);

    // The tool's own recorded arguments (the INPUT, not the result) must
    // never carry the credential either — cheap, free assertion.
    expect(JSON.stringify(row!.arguments)).not.toContain(plaintext);

    // Scoped by org (never by a fabricated id): for the inline path `sessionId`
    // is the real seeded ai_sessions.id, so this returns genuine rows. For the
    // durable path there is no chat session at all — releaseApprovedIntent has
    // no session/chat concept — so the join is legitimately empty; that empty
    // result is asserted explicitly below rather than silently relied on.
    const messages = sessionId
      ? await withSystemDbAccessContext(() =>
          db.select().from(aiMessages).where(eq(aiMessages.sessionId, sessionId)),
        )
      : await withSystemDbAccessContext(() =>
          db
            .select({ id: aiMessages.id, toolOutput: aiMessages.toolOutput, content: aiMessages.content })
            .from(aiMessages)
            .innerJoin(aiSessions, eq(aiMessages.sessionId, aiSessions.id))
            .where(eq(aiSessions.orgId, s.orgId)),
        );
    const executions = sessionId
      ? await withSystemDbAccessContext(() =>
          db.select().from(aiToolExecutions).where(eq(aiToolExecutions.sessionId, sessionId)),
        )
      : await withSystemDbAccessContext(() =>
          db
            .select({ id: aiToolExecutions.id, toolOutput: aiToolExecutions.toolOutput })
            .from(aiToolExecutions)
            .innerJoin(aiSessions, eq(aiToolExecutions.sessionId, aiSessions.id))
            .where(eq(aiSessions.orgId, s.orgId)),
        );

    if (sessionId) {
      // Inline path: createSessionPostToolUse's DB writes are best-effort
      // (wrapped in a try/catch that only console.errors on failure —
      // aiAgentSdk.ts's tool_result-message insert and the aiToolExecutions
      // update). If either silently failed, the "no plaintext" assertions
      // below would become vacuously true over an empty result. Asserting
      // real rows exist first converts the claim from "nothing found" to
      // "rows exist and contain no plaintext".
      expect(messages.length).toBeGreaterThan(0);
      expect(executions.length).toBeGreaterThan(0);

      if (toolName === 'm365_reset_password') {
        // ai_tool_executions.delegantToolCallId correlates this row to
        // Delegant's own audit ledger (spec §4.2, must-preserve). The M365
        // handler no longer returns JSON containing delegantToolCallId —
        // it returns prose llmText and carries the id in the sealed
        // carrier's meta instead — so createSessionPostToolUse must fall
        // back to the sealed blob rather than leaving the column NULL.
        const execRow = executions[0] as { delegantToolCallId?: string | null };
        expect(execRow.delegantToolCallId).toBe('delegant-call-1');
      }
    } else {
      // Durable path: releaseApprovedIntent never touches ai_messages/
      // ai_tool_executions — there is no chat session to write to. Asserted
      // explicitly so this is a documented, verified fact rather than an
      // assumption baked silently into an unconditionally-empty query.
      expect(messages).toHaveLength(0);
      expect(executions).toHaveLength(0);
    }

    expect(JSON.stringify(messages)).not.toContain(plaintext);
    expect(JSON.stringify(executions)).not.toContain(plaintext);
    expect(JSON.stringify(messages)).not.toContain('Temporary password:');
    expect(JSON.stringify(executions)).not.toContain('Temporary password:');

    // Audit trail (action_intent.created / .executed / decide events) must
    // never carry the credential either — cheap, free assertion the plan's
    // global constraints name explicitly ("never in logs, audit details").
    const auditRows = await withSystemDbAccessContext(() =>
      db.select().from(auditLogs).where(eq(auditLogs.orgId, s.orgId)),
    );
    expect(JSON.stringify(auditRows)).not.toContain(plaintext);
  });

  it('reveals the credential exactly once', async () => {
    const s = scenario!;
    const { intentId, plaintext } = await executeApprovedReset(s, 'google_reset_password', 'durable');
    const requesterToken = await requesterAccessToken(s);

    const first = await revealSecret(intentId, requesterToken);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { temporaryPassword: string } };
    expect(firstBody.data.temporaryPassword).toBe(plaintext);

    // The route deliberately gives no oracle distinguishing "already revealed"
    // from "no such intent" / "nothing to reveal" (routes/actionIntents.ts's
    // own doc comment: "Uniform 404") — once burnTemporaryPassword removes
    // temporaryPasswordEnc, hasSealedTemporaryPassword is false and the route
    // returns the same 404 it would for a nonexistent intent. The load-bearing
    // assertion is simply that the SAME credential can never be returned twice.
    const second = await revealSecret(intentId, requesterToken);
    expect(second.status).toBe(404);
    expect(((await second.json()) as { error: string }).error).toBe('not_found');

    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(actionIntents).where(eq(actionIntents.id, intentId)),
    );
    expect(row!.result).not.toHaveProperty('temporaryPasswordEnc');
    expect(row!.result).toHaveProperty('temporaryPasswordRevealed');
  });

  it('REGRESSION: google durable release stores no plaintext (fails on pre-fix main)', async () => {
    const s = scenario!;
    const { intentId, plaintext } = await executeApprovedReset(s, 'google_reset_password', 'durable');
    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(actionIntents).where(eq(actionIntents.id, intentId)),
    );
    expect(JSON.stringify(row!.result)).not.toContain(plaintext);
    expect(row!.result).not.toHaveProperty('raw');
  });
});
