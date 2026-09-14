/**
 * Real-Postgres proof of AI origin attribution (#5022 W01).
 *
 * Five properties that only a live database can establish:
 *
 *  1. The Kit case — an AI-dispatched LIBRARY (non-proposal) script is
 *     attributed end to end: the `script_executions` row, its `device_commands`
 *     row, and exactly one `ai.%` audit row for the mutation.
 *  2. Device move detaches the cross-tenant pointers and RETAINS the marker.
 *     Driven through a direct `devices.org_id` UPDATE, which is the case the
 *     TRIGGER half exists for — the route-local mirror in `moveOrg.ts` is
 *     pinned separately by `moveOrg.coverage.test.ts`'s source scan.
 *  3. Org merge repoints `org_id` and severs `ai_agent_run_id` in one statement.
 *  4. Erasing the `ai_sessions` row nulls `ai_session_id` via ON DELETE SET
 *     NULL while `ai_initiator_kind` survives — "the fact survives, the
 *     evidence is erased".
 *  5. The origin survives the durable approval boundary: an intent created
 *     from a chat context reconstructs its `aiOrigin` in the AuthContext the
 *     release worker rebuilds from scratch.
 *
 * Run:
 *   pnpm test-stack up            # from repo root
 *   cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/aiOriginAttribution.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, like, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  aiSessions,
  auditLogs,
  deviceCommands,
  devices,
  scriptExecutions,
  scripts,
} from '../../db/schema';
import { aiDispatchScriptToDevice } from '../../services/aiDispatch';
import { buildAuthContextForIntent } from '../../services/actionIntents/actorContext';
import { CUSTOM_EXECUTORS } from '../../services/orgMergeCustomExecutors';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

interface Fixture {
  partnerId: string;
  orgId: string;
  otherOrgId: string;
  siteId: string;
  otherSiteId: string;
  userId: string;
  deviceId: string;
  scriptId: string;
  sessionId: string;
  agentId: string;
  agentRunId: string;
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const otherSite = await createSite({ orgId: otherOrg.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `ai-origin-${randomUUID()}@example.test`,
  });
  // `buildUserOwnedAuthContext` resolves live permissions and returns null
  // (=> actor_invalid) for a user with no org membership, so the intent case
  // below needs a real role assignment, not just a users row.
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role!.id, [{ resource: 'devices', action: 'read' }]);
  await assignUserToOrganization(user.id, org.id, role!.id);

  const unique = randomUUID().slice(0, 8);

  return withSystemDbAccessContext(async () => {
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `ai-origin-agent-${unique}`,
        hostname: `ai-origin-host-${unique}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning();

    const [script] = await db
      .insert(scripts)
      .values({
        orgId: org.id,
        name: `AI Origin Script ${unique}`,
        language: 'bash',
        content: 'echo hello',
        osTypes: ['linux'],
        runAs: 'system',
        timeoutSeconds: 60,
        createdBy: user.id,
      })
      .returning();

    const [session] = await db
      .insert(aiSessions)
      .values({ orgId: org.id, userId: user.id, deviceId: device!.id, type: 'general' })
      .returning();

    const [agent] = await db
      .insert(aiAgents)
      .values({
        orgId: org.id,
        partnerId: null,
        kind: 'triage',
        name: `AI Origin Agent ${unique}`,
        createdBy: user.id,
      })
      .returning();

    const [run] = await db
      .insert(aiAgentRuns)
      .values({
        agentId: agent!.id,
        orgId: org.id,
        deviceId: device!.id,
        triggerKind: 'manual',
        dedupeKey: `ai-origin-run-${unique}`,
        modeAtStart: 'shadow',
        policySnapshot: { schemaVersion: 1 } as never,
      })
      .returning();

    if (!device || !script || !session || !agent || !run) {
      throw new Error('fixture seeding failed');
    }

    return {
      partnerId: partner.id,
      orgId: org.id,
      otherOrgId: otherOrg.id,
      siteId: site.id,
      otherSiteId: otherSite.id,
      userId: user.id,
      deviceId: device.id,
      scriptId: script.id,
      sessionId: session.id,
      agentId: agent.id,
      agentRunId: run.id,
    };
  });
}

/** Dispatch a saved (library) script through the mandatory-origin adapter. */
async function dispatchLibraryScriptAsAssistant(fx: Fixture) {
  const [device] = await withSystemDbAccessContext(() =>
    db.select().from(devices).where(eq(devices.id, fx.deviceId)).limit(1),
  );
  const [script] = await withSystemDbAccessContext(() =>
    db.select().from(scripts).where(eq(scripts.id, fx.scriptId)).limit(1),
  );

  return withSystemDbAccessContext(() =>
    aiDispatchScriptToDevice(
      {
        aiOrigin: { kind: 'ai_assistant', sessionId: fx.sessionId },
        user: { id: fx.userId, email: '', name: '', isPlatformAdmin: false },
      } as never,
      'run_script',
      {
        device: device as never,
        source: { kind: 'saved', script: script as never },
        triggerType: 'manual',
        triggeredBy: fx.userId,
        createdBy: fx.userId,
      } as never,
    ),
  );
}

describe('AI origin attribution (#5022 W01)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await seed();
  });

  it('reproduces the Kit case: an AI-dispatched LIBRARY script is attributed end to end', async () => {
    const dispatch = await dispatchLibraryScriptAsAssistant(fx);
    expect(dispatch.ok, JSON.stringify(dispatch)).toBe(true);
    if (!dispatch.ok) return;

    const [execution] = await withSystemDbAccessContext(() =>
      db
        .select({
          kind: scriptExecutions.aiInitiatorKind,
          sessionId: scriptExecutions.aiSessionId,
          runId: scriptExecutions.aiAgentRunId,
          sourceKind: scriptExecutions.sourceKind,
        })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.id, dispatch.executionId!))
        .limit(1),
    );

    // The execution row itself — a LIBRARY run, not a proposal. This is the
    // exact shape that used to be indistinguishable from a human hand-run.
    expect(execution).toMatchObject({
      kind: 'ai_assistant',
      sessionId: fx.sessionId,
      runId: null,
      sourceKind: 'library',
    });

    // The command row carries the same triple, so a reader of device_commands
    // alone can still answer "who decided this".
    const [command] = await withSystemDbAccessContext(() =>
      db
        .select({
          kind: deviceCommands.aiInitiatorKind,
          sessionId: deviceCommands.aiSessionId,
          runId: deviceCommands.aiAgentRunId,
        })
        .from(deviceCommands)
        .where(eq(deviceCommands.id, dispatch.commandId))
        .limit(1),
    );
    expect(command).toMatchObject({
      kind: 'ai_assistant',
      sessionId: fx.sessionId,
      runId: null,
    });

    // Exactly ONE `ai.` audit row per dispatched mutation. scriptDispatch
    // writes `ai.script.executed` and suppresses queueCommand's
    // `ai.command.executed`, which is the property W02's Overview count rests
    // on. The audit write is fire-and-forget, so poll briefly rather than
    // asserting on a race.
    let aiRows: Array<{ action: string; actorType: string | null; details: unknown }> = [];
    for (let attempt = 0; attempt < 20 && aiRows.length === 0; attempt++) {
      aiRows = await withSystemDbAccessContext(() =>
        db
          .select({
            action: auditLogs.action,
            actorType: auditLogs.actorType,
            details: auditLogs.details,
          })
          .from(auditLogs)
          .where(and(eq(auditLogs.resourceId, fx.deviceId), like(auditLogs.action, 'ai.%'))),
      );
      if (aiRows.length === 0) await new Promise((r) => setTimeout(r, 100));
    }

    expect(aiRows.map((r) => r.action)).toEqual(['ai.script.executed']);
    expect(aiRows[0]!.actorType).toBe('user'); // the PRINCIPAL, not authorship
    expect(aiRows[0]!.details).toMatchObject({
      deviceId: fx.deviceId,
      sourceKind: 'library',
      aiInitiatorKind: 'ai_assistant',
      aiSessionId: fx.sessionId,
    });
  });

  it('detaches AI origin pointers on device move but keeps ai_initiator_kind', async () => {
    const [execution] = await withSystemDbAccessContext(() =>
      db
        .insert(scriptExecutions)
        .values({
          scriptId: fx.scriptId,
          deviceId: fx.deviceId,
          orgId: fx.orgId,
          triggeredBy: fx.userId,
          status: 'pending',
          aiInitiatorKind: 'ai_agent',
          aiSessionId: fx.sessionId,
          aiAgentRunId: fx.agentRunId,
        })
        .returning({ id: scriptExecutions.id }),
    );

    // A DIRECT devices.org_id UPDATE — the case the trigger half of
    // 2026-10-16-182100-ai-origin-attribution.sql exists to cover, i.e. a
    // fix-up script or future service path that bypasses the moveOrg route.
    // `site_id` moves in the same statement because `devices_site_org_fk` is
    // composite and `site_id` is NOT NULL: the device must land on a site that
    // belongs to the TARGET org, exactly as the route does.
    await withSystemDbAccessContext(() =>
      db.execute(
        sql`UPDATE devices
               SET org_id = ${fx.otherOrgId}::uuid, site_id = ${fx.otherSiteId}::uuid
             WHERE id = ${fx.deviceId}::uuid`,
      ),
    );

    const [after] = await withSystemDbAccessContext(() =>
      db
        .select({
          kind: scriptExecutions.aiInitiatorKind,
          sessionId: scriptExecutions.aiSessionId,
          runId: scriptExecutions.aiAgentRunId,
          orgId: scriptExecutions.orgId,
        })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.id, execution!.id))
        .limit(1),
    );

    expect(after).toMatchObject({
      // The fact survives the move…
      kind: 'ai_agent',
      // …the cross-tenant pointers do not.
      sessionId: null,
      runId: null,
      // …and the row itself followed the device (denormalized org_id).
      orgId: fx.otherOrgId,
    });
  });

  it('detaches ai_agent_run_id on org merge and repoints org_id', async () => {
    const [execution] = await withSystemDbAccessContext(() =>
      db
        .insert(scriptExecutions)
        .values({
          scriptId: fx.scriptId,
          deviceId: fx.deviceId,
          orgId: fx.orgId,
          triggeredBy: fx.userId,
          status: 'pending',
          aiInitiatorKind: 'ai_agent',
          aiSessionId: fx.sessionId,
          aiAgentRunId: fx.agentRunId,
        })
        .returning({ id: scriptExecutions.id }),
    );

    const outcome = await withSystemDbAccessContext(() =>
      CUSTOM_EXECUTORS.script_executions!(fx.orgId, fx.otherOrgId),
    );
    expect(outcome.moved).toBeGreaterThanOrEqual(1);

    const [after] = await withSystemDbAccessContext(() =>
      db
        .select({
          kind: scriptExecutions.aiInitiatorKind,
          sessionId: scriptExecutions.aiSessionId,
          runId: scriptExecutions.aiAgentRunId,
          orgId: scriptExecutions.orgId,
        })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.id, execution!.id))
        .limit(1),
    );

    expect(after).toMatchObject({
      kind: 'ai_agent',
      sessionId: null,
      runId: null,
      orgId: fx.otherOrgId,
    });
  });

  it('nulls ai_session_id when the session is erased, and the marker survives', async () => {
    const [execution] = await withSystemDbAccessContext(() =>
      db
        .insert(scriptExecutions)
        .values({
          scriptId: fx.scriptId,
          deviceId: fx.deviceId,
          orgId: fx.orgId,
          triggeredBy: fx.userId,
          status: 'pending',
          aiInitiatorKind: 'ai_assistant',
          aiSessionId: fx.sessionId,
        })
        .returning({ id: scriptExecutions.id }),
    );

    // ON DELETE SET NULL — the erasure must not be blocked by the pointer.
    await withSystemDbAccessContext(() => db.delete(aiSessions).where(eq(aiSessions.id, fx.sessionId)));

    const [after] = await withSystemDbAccessContext(() =>
      db
        .select({
          kind: scriptExecutions.aiInitiatorKind,
          sessionId: scriptExecutions.aiSessionId,
        })
        .from(scriptExecutions)
        .where(eq(scriptExecutions.id, execution!.id))
        .limit(1),
    );

    expect(after).toMatchObject({ kind: 'ai_assistant', sessionId: null });
  });

  it('reconstructs the origin across an approved action intent', async () => {
    const [intent] = await withSystemDbAccessContext(() =>
      db
        .insert(actionIntents)
        .values({
          orgId: fx.orgId,
          partnerId: fx.partnerId,
          requestedByUserId: fx.userId,
          originPrincipalKind: 'user_session',
          source: 'chat',
          actionName: 'manage_services',
          arguments: {},
          argumentDigest: randomUUID(),
          targetSummary: 'restart a service',
          impactSummary: 'restarts a service',
          riskTier: 3,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          status: 'approved',
          expiresAt: new Date(Date.now() + 3_600_000),
          // The whole point: written at INSERT and never updated.
          aiOriginKind: 'ai_assistant',
          aiOriginSessionId: fx.sessionId,
          aiOriginAgentRunId: null,
        })
        .returning(),
    );

    // The release worker rebuilds this AuthContext FROM SCRATCH — nothing of
    // the original chat context is in scope by the time it runs.
    const auth = await buildAuthContextForIntent(intent!);

    expect(auth, 'intent actor context could not be rebuilt').not.toBeNull();
    expect(auth!.aiOrigin).toEqual({ kind: 'ai_assistant', sessionId: fx.sessionId });
  });
});
