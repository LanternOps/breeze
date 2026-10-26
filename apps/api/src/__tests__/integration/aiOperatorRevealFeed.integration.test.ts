/**
 * #10129: an AI Operator child effect is released through the durable worker
 * as a `user_session` principal (the plan approver), so it is not MCP-origin
 * and used to get NO `ai_tool_executions` row. The only credential reveal UI —
 * `TempPasswordSection` on /ai-risk — is fed by `GET /ai/admin/tool-executions`
 * (`ai_tool_executions ⋈ ai_sessions`), so `identity_onboarding`'s created
 * account password was unreachable from the UI.
 *
 * The fix writes, at release, one synthetic `ai_sessions` row of type
 * `ai_operator` plus the ledger row carrying `intent_id` — the same shape the
 * MCP release ledger writes. This suite pins, against real Postgres as
 * `breeze_app`, through the REAL routes:
 *  - the feed lists exactly one row for the create child, revealable;
 *  - D-R2-6 is unchanged: the approver reveals once, the starter is refused;
 *  - another org sees nothing, and cannot ask for this org;
 *  - every operator effect gets a row (not only secret-bearing ones);
 *  - the synthetic session stays out of chat / client-AI lists and is no
 *    agent run's session (so per-run governance views never read it);
 *  - no plaintext credential reaches the ledger.
 *
 * Fakes are the onboarding harness's (see identityOnboardingHarness.ts).
 */
import './setup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const fake = vi.hoisted(() => ({
  world: null as unknown as import('./identityOnboardingHarness').FakeWorld,
  googleConnId: null as string | null,
  probe: {} as import('./identityOnboardingHarness').FakeProviders['probe'],
  h: {} as Record<string, (...args: any[]) => any>,
}));

// The SDK transport must never run here: a real model call is a test bug.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => { throw new Error('SDK transport must not run in this suite'); },
  tool: () => ({}),
  createSdkMcpServer: () => ({}),
}));
vi.mock('../../services/m365ControlPlane/readActionService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  executeM365ReadActionByOrg: (...a: unknown[]) => fake.h.m365Read!(...a),
}));
vi.mock('../../services/aiToolsGoogle', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveContextByOrg: (...a: unknown[]) => fake.h.googleContext!(...a),
}));
vi.mock('../../services/googleClient', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getDirectoryClient: (...a: unknown[]) => fake.h.directory!(...a),
  getLicensingClient: (...a: unknown[]) => fake.h.licensing!(...a),
}));
vi.mock('../../services/m365ControlPlane/graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction: (...a: unknown[]) => fake.h.executeWriteAction!(...a) }),
  GraphActionsExecutorClientError: class GraphActionsExecutorClientError extends Error {},
}));
vi.mock('../../services/m365ControlPlane/writeActionRuntimeConfig', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadM365CustomerGraphActionsRuntimeConfig: () => ({
    clientId: 'test-client-id',
    vaultRef: 'akv://test-vault.example/m365-customer-graph-actions/00000000000000000000000000000000',
    credentialVersion: '00000000000000000000000000000000',
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-actions-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'test-kid',
  }),
  isM365GraphActionsEnabledForOrg: () => true,
  m365GraphActionsAvailability: () => 'enabled',
}));

import { Hono } from 'hono';
import { db } from '../../db';
import { aiAgentRuns, aiSessions, aiToolExecutions } from '../../db/schema';
import { aiRoutes } from '../../routes/ai';
import { clearPermissionCache } from '../../services/permissions';
import { CHAT_SESSION_TYPES } from '../../services/aiChatSessionTypes';
import { CLIENT_SESSION_TYPES } from '../../services/clientAiHosts';
import { grantRolePermissions } from './db-utils';
import {
  CREATE_STEP, FAKE_PASSWORD, PROVISION_STEP,
  accessTokenFor, approve, bindFakeProviders, childIntents, driveToProvisionProposed, plaintextLeaks,
  resetFakes, revealSecret, seedTenant, system, walk, type Tenant,
} from './identityOnboardingHarness';

bindFakeProviders(fake as never);

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED', 'true');
  resetFakes();
});
afterEach(() => { vi.unstubAllEnvs(); });

const FEED_PERMS = [
  { resource: 'ai_sessions', action: 'use' },
  { resource: 'ai_sessions', action: 'read_all' },
];

async function canReadFeed(t: Tenant): Promise<void> {
  await grantRolePermissions(t.requesterRoleId, FEED_PERMS);
  await grantRolePermissions(t.approverRoleId, FEED_PERMS);
  await clearPermissionCache(t.requesterId);
  await clearPermissionCache(t.approverId);
}

interface FeedRow { id: string; sessionId: string; toolName: string; status: string; intentId: string | null; tempPasswordState: string | null; toolInput: unknown }

async function feed(orgId: string, token: string): Promise<{ status: number; executions: FeedRow[] }> {
  const app = new Hono().route('/ai', aiRoutes);
  const res = await app.request(`/ai/admin/tool-executions?orgId=${orgId}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json() as { executions?: FeedRow[] };
  return { status: res.status, executions: body.executions ?? [] };
}

describe('operator-minted intents in the /ai-risk reveal feed (#10129)', () => {
  runDb('the created-account credential is listed once, revealable by the approver only; every operator effect is on the ledger', async () => {
    const t = await seedTenant({ google: false });
    await canReadFeed(t);
    const a = await driveToProvisionProposed(t);
    await approve(a, PROVISION_STEP);
    await walk(a, PROVISION_STEP);

    const children = (await childIntents(a)).filter((i) => i.actionName.startsWith('m365_'));
    const createChild = children.find((i) => i.actionName === 'm365_create_user')!;
    expect(createChild, 'the create child exists').toBeTruthy();
    expect(createChild).toMatchObject({
      status: 'completed', source: 'mcp_api', originPrincipalKind: 'user_session',
      requestedByUserId: t.approverId, taskStepKey: CREATE_STEP,
    });
    const provisionChildren = children.filter((i) => i.taskStepKey === PROVISION_STEP);
    expect(provisionChildren.length, 'provisioning released at least one M365 effect').toBeGreaterThan(0);

    // ── the ledger: one row per released operator effect, each on its OWN
    //    synthetic `ai_operator` session in the task's org ─────────────────
    const ledger = await system(() => db.select({
      execution: aiToolExecutions, session: aiSessions,
    }).from(aiToolExecutions)
      .innerJoin(aiSessions, eq(aiSessions.id, aiToolExecutions.sessionId))
      .where(inArray(aiToolExecutions.intentId, children.map((c) => c.id))));
    expect(ledger.map((r) => r.execution.intentId).sort(), 'exactly one ledger row per operator child').toEqual(children.map((c) => c.id).sort());
    expect(new Set(ledger.map((r) => r.session.id)).size, 'one synthetic session per release').toBe(children.length);
    for (const { execution, session } of ledger) {
      const child = children.find((c) => c.id === execution.intentId)!;
      expect(execution).toMatchObject({ toolName: child.actionName, status: 'completed' });
      expect(session).toMatchObject({
        orgId: t.orgId, userId: t.approverId, type: 'ai_operator', model: 'ai-operator',
        contextSnapshot: { source: 'ai_operator', taskId: a.taskId, stepKey: child.taskStepKey, intentId: child.id },
      });
    }
    const createRow = ledger.find((r) => r.execution.intentId === createChild.id)!;
    const createSessionId = createRow.session.id;

    // ── no plaintext credential reached the ledger (rows nor sessions) ────
    expect(JSON.stringify(ledger)).not.toContain(FAKE_PASSWORD);
    expect(await plaintextLeaks(a, FAKE_PASSWORD)).toEqual([]);
    // A secret-bearing release records no result body at all.
    expect((createRow.execution.toolOutput as Record<string, unknown> | null)?.result).toBeUndefined();

    // ── the synthetic session is no chat / client-AI conversation and no run's session
    expect((CHAT_SESSION_TYPES as readonly string[]).includes('ai_operator')).toBe(false);
    expect(CLIENT_SESSION_TYPES.includes('ai_operator')).toBe(false);
    const runsOnIt = await system(() => db.select({ id: aiAgentRuns.id }).from(aiAgentRuns)
      .where(inArray(aiAgentRuns.sessionId, ledger.map((r) => r.session.id))));
    expect(runsOnIt, 'no agent run owns a synthetic operator session').toEqual([]);

    // ── the REAL feed route: exactly one revealable row for the create ────
    const approverToken = await accessTokenFor(t, t.approverId);
    const requesterToken = await accessTokenFor(t, t.requesterId);
    const approverFeed = await feed(t.orgId, approverToken);
    expect(approverFeed.status).toBe(200);
    const createRows = approverFeed.executions.filter((e) => e.intentId === createChild.id);
    expect(createRows).toEqual([expect.objectContaining({
      sessionId: createSessionId, toolName: 'm365_create_user', status: 'completed', tempPasswordState: 'available',
    })]);
    expect(JSON.stringify(approverFeed.executions)).not.toContain(FAKE_PASSWORD);
    // The starter sees the same org-wide row (the feed is a read_all view)…
    const requesterFeed = await feed(t.orgId, requesterToken);
    expect(requesterFeed.executions.filter((e) => e.intentId === createChild.id)).toHaveLength(1);

    // ── …but D-R2-6 is unchanged: only the approver (the requester of the
    //    create child) can reveal, exactly once ───────────────────────────
    const starter = await revealSecret(createChild.id, requesterToken);
    expect(starter.status).toBe(403);
    expect(JSON.stringify(starter.body)).not.toContain(FAKE_PASSWORD);
    const first = await revealSecret(createChild.id, approverToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toMatchObject({ temporaryPassword: FAKE_PASSWORD });
    const afterReveal = await feed(t.orgId, approverToken);
    expect(afterReveal.executions.filter((e) => e.intentId === createChild.id))
      .toEqual([expect.objectContaining({ tempPasswordState: 'revealed' })]);

    // ── another org sees nothing and cannot ask for this org ──────────────
    const other = await seedTenant({ google: false });
    await canReadFeed(other);
    const otherToken = await accessTokenFor(other, other.approverId);
    const otherFeed = await feed(other.orgId, otherToken);
    expect(otherFeed.status).toBe(200);
    expect(otherFeed.executions.filter((e) => children.some((c) => c.id === e.intentId))).toEqual([]);
    expect((await feed(t.orgId, otherToken)).status).toBe(403);
  }, 240_000);
});
