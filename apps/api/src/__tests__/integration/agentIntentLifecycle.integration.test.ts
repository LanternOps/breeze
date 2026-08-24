/**
 * End-to-end integration proof for wave 3b (#3824): an agent-originated
 * action intent lives its whole life against real Postgres — an `ai_agent`
 * principal proposes, an action-and-target-eligible human sees and decides
 * it, and the durable release worker re-derives authority from the run's
 * policy snapshot AND the agent's current effective policy before executing
 * under the reconstructed agent context. This is the regression barrier PR
 * 3c builds its runner on.
 *
 * Why integration and not unit: every unit suite on this path mocks `../db`
 * wholesale, so none of them can prove the cross-context choreography —
 * system-scoped fan-out under Shape-6 RLS, the decide route's live
 * `isAgentIntentDecideAuthorized` re-check, the release worker's
 * snapshot ∧ current double-gate, and the REAL DB effect (a
 * `device_commands` row) of the released tool. The fixture tool is
 * `manage_services` `restart` — genuinely Tier 3 (TIER3_ACTIONS) and
 * `supervised`-scoped (TIER3_SUPERVISED_ACTIONS), dispatching an observable
 * `restart_service` device command.
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up (anywhere else runs in ZERO CI jobs — see
 * intentFanout.integration.test.ts's header for the full rationale).
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createAiAgentSchema } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  approvalRequests,
  deviceCommands,
  devices,
  organizationUsers,
} from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { createAgent } from '../../services/aiAgents/agentService';
import { InvalidAgentRecipientsError, validateAgentRecipients } from '../../services/aiAgents/recipients';
import { createActionIntent, ActionIntentError } from '../../services/actionIntents/intentService';
import { isAgentIntentDecideAuthorized } from '../../services/actionIntents/intentApprovers';
import { checkToolPermission } from '../../services/aiGuardrails';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { approvalRoutes } from '../../routes/approvals';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

const TOOL_NAME = 'manage_services';
const SERVICE_NAME = 'spooler';
const DEVICES_EXECUTE = { resource: 'devices', action: 'execute' } as const;

/** The effective policy the fixture agent runs under: shadow mode (proposes,
 * never executes unilaterally) with manage_services allowlisted. */
function effectivePolicyFields() {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: [TOOL_NAME],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {},
    triggers: {},
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 900,
  };
}

interface Scenario {
  partner: { id: string };
  org: { id: string };
  site: { id: string };
  otherSite: { id: string };
  device: typeof devices.$inferSelect;
  agent: { id: string; name: string };
  run: { id: string };
  creator: { id: string; email: string };
  /** Org member holding devices:execute with NO site restriction — the one eligible decider. */
  eligible: { id: string; email: string };
  /** Same RBAC, but site-restricted to otherSite — action authority without target reach. */
  wrongSite: { id: string; email: string };
  /** Org member with approvals:decide but NOT devices:execute — four_eyes-shaped
   * authority that must NOT qualify for a supervised agent intent. */
  noRbac: { id: string; email: string };
  eligibleRoleId: string;
  decideOnlyRoleId: string;
}

/** Seeds the whole tenancy: partner-owned baseline agent (the shape
 * resolveEffectiveAgent requires — an org-owned agent has no partner baseline
 * and resolves to null), a device-bound run in the org, and the three-user
 * eligibility population. */
async function seedScenario(): Promise<Scenario> {
  const adminDb = getTestDb() as any;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const otherSite = await createSite({ orgId: org.id });

  const creator = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `creator-${randomUUID()}@agentlifecycle.test`,
  });

  const eligibleRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(eligibleRole.id, [DEVICES_EXECUTE]);

  const decideOnlyRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(decideOnlyRole.id, [{ resource: 'approvals', action: 'decide' }]);

  const eligible = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `eligible-${randomUUID()}@agentlifecycle.test`,
  });
  await assignUserToOrganization(eligible.id, org.id, eligibleRole.id);

  const wrongSite = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `wrongsite-${randomUUID()}@agentlifecycle.test`,
  });
  // Same role as `eligible`, but the membership row pins them to otherSite —
  // getUserPermissions surfaces this as allowedSiteIds, which
  // userHasActionAndTargetAuthority checks against the intent's target site.
  await adminDb.insert(organizationUsers).values({
    userId: wrongSite.id,
    orgId: org.id,
    roleId: eligibleRole.id,
    siteIds: [otherSite.id],
  });

  const noRbac = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `norbac-${randomUUID()}@agentlifecycle.test`,
  });
  await assignUserToOrganization(noRbac.id, org.id, decideOnlyRole.id);

  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `lifecycle-agent-${unique}`,
      hostname: `lifecycle-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      // Online is load-bearing: executeCommand refuses offline devices before
      // it writes the device_commands row this suite observes.
      status: 'online',
    })
    .returning();

  // PARTNER-owned baseline (orgId NULL): resolveEffectiveAgent keys the
  // current-policy half of the release gate off this row, and
  // checkAgentReleaseAuthority requires resolved.agentId === run.agentId.
  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        partnerId: partner.id,
        orgId: null,
        kind: 'triage',
        name: 'Nightly Triage',
        ...effectivePolicyFields(),
        createdBy: creator.id,
      })
      .returning(),
  );

  const snapshot = {
    schemaVersion: 1,
    agentId: agent!.id,
    kind: 'triage',
    effective: effectivePolicyFields(),
    resolvedAt: new Date().toISOString(),
  };
  const [run] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgentRuns)
      .values({
        agentId: agent!.id,
        orgId: org.id,
        deviceId: device.id,
        triggerKind: 'alert',
        dedupeKey: `agent-lifecycle-${randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: snapshot as never,
      })
      .returning(),
  );

  return {
    partner,
    org,
    site,
    otherSite,
    device: device as typeof devices.$inferSelect,
    agent: { id: agent!.id, name: agent!.name },
    run: { id: run!.id },
    creator: { id: creator.id, email: creator.email },
    eligible: { id: eligible.id, email: eligible.email },
    wrongSite: { id: wrongSite.id, email: wrongSite.email },
    noRbac: { id: noRbac.id, email: noRbac.email },
    eligibleRoleId: eligibleRole.id,
    decideOnlyRoleId: decideOnlyRole.id,
  };
}

/** The exact AuthContext shape PR 3c's runner will hold — built through the
 * same factory the release path reconstructs with. */
function agentAuthFor(s: Scenario): AuthContext {
  return buildAgentAuthContext(
    { id: s.agent.id, orgId: null, partnerId: s.partner.id, name: s.agent.name, kind: 'triage' },
    { id: s.run.id, orgId: s.org.id, deviceId: s.device.id, deviceSiteId: s.site.id },
    { id: s.org.id, partnerId: s.partner.id },
  );
}

function restartInput(s: Scenario): Record<string, unknown> {
  return { deviceId: s.device.id, action: 'restart', serviceName: SERVICE_NAME };
}

async function createAgentIntent(s: Scenario) {
  return createActionIntent(agentAuthFor(s), {
    toolName: TOOL_NAME,
    input: restartInput(s),
    source: 'ai_agent',
  });
}

async function accessTokenFor(
  user: { id: string; email: string },
  orgId: string,
  partnerId: string,
  roleId: string,
): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId,
    orgId,
    partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

function approvalsApp(): Hono {
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app;
}

async function approveViaRoute(
  s: Scenario,
  decider: { id: string; email: string },
  roleId: string,
  approvalRowId: string,
): Promise<Response> {
  const token = await accessTokenFor(decider, s.org.id, s.partner.id, roleId);
  return approvalsApp().request(`/approvals/${approvalRowId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function readIntent(intentId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1),
  );
  return row!;
}

async function fanOutRowsFor(intentId: string) {
  return withSystemDbAccessContext(() =>
    db
      .select({ id: approvalRequests.id, userId: approvalRequests.userId })
      .from(approvalRequests)
      .where(eq(approvalRequests.intentId, intentId)),
  );
}

async function restartCommandsFor(deviceId: string) {
  const adminDb = getTestDb() as any;
  return adminDb
    .select()
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'restart_service')));
}

/** Plays the device's part: polls for the dispatched restart_service command
 * and completes it, so executeCommand's waitForCommandResult loop returns a
 * real result instead of burning its 30s timeout. Runs concurrently with
 * releaseApprovedIntent. */
async function completeRestartCommand(deviceId: string): Promise<string | null> {
  const adminDb = getTestDb() as any;
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await restartCommandsFor(deviceId);
    const cmd = rows[0];
    if (cmd) {
      await adminDb
        .update(deviceCommands)
        .set({
          status: 'completed',
          result: { status: 'completed', output: `${SERVICE_NAME} restarted` },
          completedAt: new Date(),
        })
        .where(eq(deviceCommands.id, cmd.id));
      return cmd.id as string;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

/** Creates a pending agent intent and approves it through the real route as
 * the eligible decider — the shared preamble of the release-path tests. */
async function createAndApprove(s: Scenario): Promise<string> {
  const snapshot = await createAgentIntent(s);
  expect(snapshot.status).toBe('pending_approval');
  const rows = await fanOutRowsFor(snapshot.id);
  expect(rows).toHaveLength(1);
  const res = await approveViaRoute(s, s.eligible, s.eligibleRoleId, rows[0]!.id);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  const approved = await readIntent(snapshot.id);
  expect(approved.status).toBe('approved');
  return snapshot.id;
}

beforeEach(() => {
  // The kill switch defaults OFF; every guardrail evaluation on this path
  // (creation re-verify, release snapshot ∧ current) reads it at call time.
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('agent-originated intent lifecycle (real Postgres, breeze_app)', () => {
  it('full lifecycle: agent creates -> eligible human sees -> approves -> release executes under agent auth', async () => {
    const s = await seedScenario();

    // 1. The agent proposes. Requester-less, attributed to the run, and the
    // supervised fan-out lands on EXACTLY the action-and-target-eligible
    // human: not the wrong-site holder of the same role, not the
    // approvals:decide holder without devices:execute.
    const snapshot = await createAgentIntent(s);
    expect(snapshot.status).toBe('pending_approval');
    const intentRow = await readIntent(snapshot.id);
    expect(intentRow.source).toBe('ai_agent');
    expect(intentRow.originPrincipalKind).toBe('ai_agent');
    expect(intentRow.originPrincipalId).toBe(s.agent.id);
    expect(intentRow.requestedByUserId).toBeNull();
    expect(intentRow.requestingAgentRunId).toBe(s.run.id);
    expect(intentRow.approvalScope).toBe('supervised');

    const fanOut = await fanOutRowsFor(snapshot.id);
    expect(fanOut.map((r) => r.userId)).toEqual([s.eligible.id]);

    // 2. The eligible human SEES it: the live-authorized /pending feed
    // includes the row and labels its agent origin (gap 5 + Task 9 serialize).
    const token = await accessTokenFor(s.eligible, s.org.id, s.partner.id, s.eligibleRoleId);
    const pendingRes = await approvalsApp().request('/approvals/pending', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pendingRes.status).toBe(200);
    const pending = (await pendingRes.json()) as {
      approvals: Array<{ id: string; origin: string; agentName: string | null }>;
    };
    const mine = pending.approvals.find((a) => a.id === fanOut[0]!.id);
    expect(mine).toBeDefined();
    expect(mine!.origin).toBe('ai_agent');
    expect(mine!.agentName).toBe('Nightly Triage');

    // 3. They approve through the REAL route (live isAgentIntentDecideAuthorized
    // re-check + the full assurance ladder — agent intents never take the
    // supervised self-decide skip).
    const approveRes = await approveViaRoute(s, s.eligible, s.eligibleRoleId, fanOut[0]!.id);
    expect(approveRes.status, JSON.stringify(await approveRes.clone().json())).toBe(200);
    expect((await readIntent(snapshot.id)).status).toBe('approved');

    // 4. The durable worker releases: revalidation reconstructs the ai_agent
    // context from the run (buildAgentOwnedAuthContext), checkAgentReleaseAuthority
    // passes on snapshot AND current policy, and the tool executes — the real,
    // observable DB effect is the restart_service device command.
    const completer = completeRestartCommand(s.device.id);
    await releaseApprovedIntent(snapshot.id);
    const commandId = await completer;
    expect(commandId, 'expected the released tool to dispatch a restart_service device command').not.toBeNull();

    const released = await readIntent(snapshot.id);
    expect(released.status).toBe('completed');
    expect(released.executedAt).not.toBeNull();

    const commands = await restartCommandsFor(s.device.id);
    expect(commands).toHaveLength(1);
    expect(commands[0].payload).toMatchObject({ name: SERVICE_NAME });
    // The synthetic agent id is NOT a users row: created_by must be NULL
    // (attribution lives on the intent/run), never a dangling or forged user id.
    expect(commands[0].createdBy).toBeNull();
  }, 60_000);

  it('release vetoes after the operator narrows the allowlist post-approval', async () => {
    const s = await seedScenario();
    const intentId = await createAndApprove(s);

    // Operator narrows the CURRENT policy after approval; the run's snapshot
    // still allowlists the tool, so only the current-policy half of
    // checkAgentReleaseAuthority can produce this veto.
    await withSystemDbAccessContext(() =>
      db.update(aiAgents).set({ toolAllowlist: [] }).where(eq(aiAgents.id, s.agent.id)),
    );

    await releaseApprovedIntent(intentId);
    const released = await readIntent(intentId);
    expect(released.status).toBe('failed');
    expect(released.errorCode).toBe('agent_policy_denied');
    expect(released.executedAt).toBeNull();
    expect(await restartCommandsFor(s.device.id)).toHaveLength(0);
  }, 60_000);

  it('release vetoes after the agent is disabled post-approval', async () => {
    const s = await seedScenario();
    const intentId = await createAndApprove(s);

    await withSystemDbAccessContext(() =>
      db.update(aiAgents).set({ enabled: false }).where(eq(aiAgents.id, s.agent.id)),
    );

    await releaseApprovedIntent(intentId);
    const released = await readIntent(intentId);
    expect(released.status).toBe('failed');
    expect(released.errorCode).toBe('agent_policy_denied');
    expect(await restartCommandsFor(s.device.id)).toHaveLength(0);
  }, 60_000);

  it('an ineligible user (wrong site) never gets a fan-out row and cannot decide', async () => {
    const s = await seedScenario();
    const snapshot = await createAgentIntent(s);
    const fanOut = await fanOutRowsFor(snapshot.id);

    // No row for the wrong-site holder of the SAME role, nor for the
    // approvals:decide holder lacking the tool's RBAC.
    expect(fanOut.map((r) => r.userId)).toEqual([s.eligible.id]);

    // The decide-time predicate itself refuses both.
    const intentRow = await readIntent(snapshot.id);
    await expect(isAgentIntentDecideAuthorized(s.wrongSite.id, intentRow)).resolves.toBe(false);
    await expect(isAgentIntentDecideAuthorized(s.noRbac.id, intentRow)).resolves.toBe(false);
    await expect(isAgentIntentDecideAuthorized(s.eligible.id, intentRow)).resolves.toBe(true);

    // And the route: the eligible user's row is not theirs to decide (the
    // ownership filter 404s before anything else).
    const res = await approveViaRoute(s, s.wrongSite, s.eligibleRoleId, fanOut[0]!.id);
    expect(res.status).toBe(404);
    expect((await readIntent(snapshot.id)).status).toBe('pending_approval');
  }, 60_000);

  it('RBAC deny is intact: checkToolPermission still refuses the reconstructed agent context', async () => {
    const s = await seedScenario();
    // Direct call with the built agent auth — pins that 3b bypassed AROUND
    // the RBAC guard (into checkAgentReleaseAuthority), never through it.
    const denial = await checkToolPermission(TOOL_NAME, restartInput(s), agentAuthFor(s));
    expect(denial).toMatch(/never granted user permissions/);
  });

  it('secret invariant: a secret-bearing tool cannot become an agent intent', async () => {
    const s = await seedScenario();
    // m365_reset_password is Tier 3 (passes the tier gates) and secret-bearing
    // — the agent guardrail denies it categorically, which is what keeps
    // routes/actionIntents.ts's requester-less temp-password reveal fallback
    // unreachable for agent intents.
    let caught: unknown;
    try {
      await createActionIntent(agentAuthFor(s), {
        toolName: 'm365_reset_password',
        input: { userPrincipalName: 'target@customer.example' },
        source: 'ai_agent',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActionIntentError);
    expect((caught as ActionIntentError).code).toBe('agent_policy_denied');
    expect((caught as ActionIntentError).message).toMatch(/secret-bearing/);

    // Nothing was written.
    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ id: actionIntents.id })
        .from(actionIntents)
        .where(and(eq(actionIntents.orgId, s.org.id), eq(actionIntents.actionName, 'm365_reset_password'))),
    );
    expect(rows).toHaveLength(0);
  });

  it('cross-tenant recipients cannot be stored (invalid_recipients at service level)', async () => {
    const s = await seedScenario();
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });
    const foreignRole = await createRole({ scope: 'organization', orgId: foreignOrg.id });
    const foreignUser = await createUser({
      partnerId: foreignPartner.id,
      orgId: foreignOrg.id,
      email: `foreign-${randomUUID()}@agentlifecycle.test`,
    });
    await assignUserToOrganization(foreignUser.id, foreignOrg.id, foreignRole.id);

    // The validator itself: an active member of ANOTHER partner's org is
    // invalid for an org-owned agent under s.org.
    let validationError: unknown;
    try {
      await validateAgentRecipients(
        { orgId: s.org.id, partnerId: null },
        { userIds: [foreignUser.id], roleIds: [] },
      );
    } catch (err) {
      validationError = err;
    }
    expect(validationError).toBeInstanceOf(InvalidAgentRecipientsError);
    expect((validationError as InvalidAgentRecipientsError).invalidUserIds).toContain(foreignUser.id);

    // And through createAgent: the write is refused BEFORE anything persists.
    const { orgCondition, canAccessOrg } = buildOrgAccessClosures([s.org.id]);
    const creatorAuth: AuthContext = {
      principal: { kind: 'user_session' },
      user: { id: s.creator.id, email: s.creator.email, name: 'Creator', isPlatformAdmin: false },
      token: {
        sub: s.creator.id,
        email: s.creator.email,
        roleId: s.eligibleRoleId,
        orgId: s.org.id,
        partnerId: s.partner.id,
        scope: 'organization',
        type: 'access',
        mfa: true,
      },
      partnerId: s.partner.id,
      orgId: s.org.id,
      scope: 'organization',
      accessibleOrgIds: [s.org.id],
      orgCondition,
      canAccessOrg,
    };
    const orgCtx: DbAccessContext = {
      scope: 'organization',
      orgId: s.org.id,
      accessibleOrgIds: [s.org.id],
      accessiblePartnerIds: [],
      userId: s.creator.id,
      currentPartnerId: s.partner.id,
    };
    const input = createAiAgentSchema.parse({
      kind: 'helpdesk',
      name: 'Recipients Probe',
      recipients: { userIds: [foreignUser.id] },
    });
    await expect(
      withDbAccessContext(orgCtx, () =>
        createAgent(creatorAuth, { orgId: s.org.id, partnerId: null }, input),
      ),
    ).rejects.toBeInstanceOf(InvalidAgentRecipientsError);

    const stored = await withSystemDbAccessContext(() =>
      db
        .select({ id: aiAgents.id })
        .from(aiAgents)
        .where(eq(aiAgents.orgId, s.org.id)),
    );
    expect(stored).toHaveLength(0);
  });
});
