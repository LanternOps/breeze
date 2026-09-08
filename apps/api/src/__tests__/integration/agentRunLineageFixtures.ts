/**
 * Reusable agent-run lineage fixtures, extracted from
 * `agentRunMoveSemantics.integration.test.ts` (owner decision 2026-08-23: an
 * agent run's device/alert/session/ticket links sever on device or ticket
 * move; `org_id` itself never re-stamps).
 *
 * Extracted for AI Operator P3-0/P3-1 (#5205). W02 (#5207) extends
 * `insertLineage` and `seedTicketRunLineage` only as far as baseline §9.4
 * ("Fixtures for W02") describes for rows that exist TODAY on this branch:
 * agent, run, intent, device command, alert. **Nothing here references
 * `ai_operator_*` tables** — those land in W03's schema PR, which extends
 * these same builders with a task/target/operation once that schema exists.
 * Docs: docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-p3-0-baseline-
 * contracts.md §9.4 and its Appendix ("what W02 and P3-1 inherit").
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  aiSessions,
  alerts,
  deviceCommands,
  devices,
  ticketComments,
  tickets,
} from '../../db/schema';
import type { NewActionIntent } from '../../db/schema/actionIntents';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

export function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

/**
 * SQLSTATE lands on `.cause.code` (DrizzleQueryError wraps the pg error and
 * its own `.code`/`.message` carry the query, not the violation), so a plain
 * `.rejects.toThrow(/immutable column changed/)` would miss even when the
 * guard fires — mirror aiAgentRuns.integration.test.ts's unwrapping and pin
 * BOTH the SQLSTATE and the guard's message on the cause.
 */
export async function expectImmutableViolation(fn: () => Promise<unknown>): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, 'expected the immutability guard to fire, but the statement succeeded').toBeDefined();
  const cause = (raised as { cause?: { code?: string; message?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe('23000');
  expect(cause?.message ?? (raised as Error)?.message).toMatch(/immutable column changed/);
}

export function runValues(agentId: string, orgId: string, dedupeKey: string) {
  return {
    agentId,
    orgId,
    triggerKind: 'alert' as const,
    dedupeKey,
    modeAtStart: 'shadow' as const,
    policySnapshot: { schemaVersion: 1 } as never,
  };
}

/** An org with its own live triage agent (mirrors aiAgentRuns.integration.test.ts). */
export async function orgWithAgent() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });
  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
      .returning(),
  );
  return { partner, org, user, agent: agent! };
}

/** Inserts a device row directly via the admin connection. */
export async function insertDevice(orgId: string, siteId: string) {
  const adminDb = getTestDb() as any;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `run-move-agent-${unique}`,
      hostname: `run-move-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning();
  return device as typeof devices.$inferSelect;
}

/**
 * A `device_commands` row tied to `deviceId` — the execution reference an AI
 * Operator task's operation row will point at once P3-1 ships
 * `ai_operator_operations.execution_ref_id` (baseline §2.5, "accepted result
 * references"). `type` defaults to `restart_service`, the P3-1 thin-slice
 * recipe's execution adapter (`aiToolsScripts.ts:649`). `device_commands` is
 * intentionally system-scoped (no RLS, no `org_id` column — see CLAUDE.md
 * tenancy section), so this writes via the admin connection like the other
 * fixtures here; `submittedOrgId` carries provenance only (#5128), never
 * tenancy.
 */
export async function insertDeviceCommand(
  deviceId: string,
  orgId: string,
  overrides: Partial<typeof deviceCommands.$inferInsert> = {},
): Promise<typeof deviceCommands.$inferSelect> {
  const adminDb = getTestDb() as any;
  const [command] = await adminDb
    .insert(deviceCommands)
    .values({
      deviceId,
      type: 'restart_service',
      status: 'completed',
      completedAt: new Date(),
      result: { status: 'completed' },
      submittedOrgId: orgId,
      ...overrides,
    })
    .returning();
  return command as typeof deviceCommands.$inferSelect;
}

/**
 * Full device lineage: alert + ai_session + a device command on the device,
 * run linking all three (device command is fixture data, not FK-linked to
 * the run — no such column exists on `ai_agent_runs` today).
 */
export async function insertLineage(t: {
  org: { id: string };
  partner: { id: string };
  agent: { id: string };
  device: { id: string };
}) {
  const adminDb = getTestDb() as any;
  const [alert] = await adminDb
    .insert(alerts)
    .values({
      orgId: t.org.id,
      deviceId: t.device.id,
      severity: 'medium',
      title: 'agent-run move semantics fixture alert',
    })
    .returning();
  const [session] = await adminDb
    .insert(aiSessions)
    .values({ orgId: t.org.id, deviceId: t.device.id, type: 'general' })
    .returning();
  const [run] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgentRuns)
      .values({
        ...runValues(t.agent.id, t.org.id, `run-move-lineage-${randomUUID()}`),
        deviceId: t.device.id,
        alertId: alert.id,
        sessionId: session.id,
      })
      .returning(),
  );
  const deviceCommand = await insertDeviceCommand(t.device.id, t.org.id);
  return { alert, session, run: run!, deviceCommand };
}

/** An agent-originated intent attributed to the run (composite tenant FK live). */
export async function insertAgentIntent(
  orgId: string,
  partnerId: string,
  agentId: string,
  runId: string,
): Promise<string> {
  const sfx = randomUUID().slice(0, 8);
  const values: NewActionIntent = {
    orgId,
    partnerId,
    requestedByUserId: null,
    requestingApiKeyId: null,
    requestingAgentRunId: runId,
    source: 'ai_agent',
    originPrincipalKind: 'ai_agent',
    originPrincipalId: agentId,
    actionName: 'm365.mailbox.disable',
    actionVersion: 1,
    arguments: { mailbox: 'user@example.com' },
    argumentDigest: 'a'.repeat(64),
    targetSummary: 'Disable mailbox user@example.com',
    impactSummary: 'User loses mailbox access immediately',
    reason: 'Offboarding',
    riskTier: 3,
    idempotencyKey: `idem-run-move-${sfx}`,
    correlationId: randomUUID(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(actionIntents).values(values).returning({ id: actionIntents.id }),
  );
  return row!.id;
}

/**
 * #4215 fixture. `ticket_id` is the fifth device-lineage FK and the only one
 * unreachable from `WHERE device_id = <moved>`: a triage run on a ticket
 * carries ticket_id with a NULL device_id (trigger_kind 'ticket'), so the
 * device-keyed detach never sees it — while `tickets` IS in
 * getDeviceOrgDenormalizedTables(), so the ticket follows the device to the
 * target org and the retained source-org run is left naming a foreign ticket.
 *
 * Four run/ticket pairs, so the assertions below discriminate rather than
 * just confirm:
 *  - `movingTicketRun` — device-less run on the moved device's ticket. MUST
 *    detach. The case the bug missed entirely.
 *  - `deviceAndTicketRun` — run with BOTH device_id = moved AND that same
 *    ticket. MUST detach both. The device-keyed statement does not carry
 *    ticket_id, so only the new statement can sever this half. Also carries
 *    the fixture's device command (rows that exist today, baseline §9.4).
 *  - `orphanTicketRun` — device-LESS ticket that stays in the source org.
 *    MUST keep ticket_id. Rejects a blanket "null every ticket_id".
 *  - `otherDeviceTicketRun` — ticket bound to a DIFFERENT, non-moving device
 *    in the source org. MUST keep ticket_id. Rejects the subtler
 *    `WHERE device_id IS NOT NULL`, which the orphan case alone would pass.
 */
export async function seedTicketRunLineage(env: {
  partner: { id: string };
  orgA: { id: string };
  siteA: { id: string };
  user: { id: string };
  device: { id: string };
}) {
  const adminDb = getTestDb() as any;
  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        orgId: env.orgA.id,
        partnerId: null,
        kind: 'triage',
        name: 'Triage',
        createdBy: env.user.id,
      })
      .returning(),
  );
  const otherDevice = await insertDevice(env.orgA.id, env.siteA.id);

  const unique = randomUUID().slice(0, 8);
  const newTicket = async (label: string, deviceId: string | null) => {
    const [row] = await adminDb
      .insert(tickets)
      .values({
        orgId: env.orgA.id,
        partnerId: env.partner.id,
        deviceId,
        ticketNumber: `RUNMOVE-${label}-${unique}`,
        subject: `ticket fixture ${label}`,
        source: 'manual',
      })
      .returning();
    return row as typeof tickets.$inferSelect;
  };
  const ticketOnDevice = await newTicket('DEV', env.device.id);
  const ticketOrphan = await newTicket('ORPHAN', null);
  const ticketOtherDevice = await newTicket('OTHERDEV', otherDevice.id);

  const [movingTicketRun, deviceAndTicketRun, orphanTicketRun, otherDeviceTicketRun] =
    await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentRuns)
        .values([
          {
            ...runValues(agent!.id, env.orgA.id, `run-move-ticket-${randomUUID()}`),
            triggerKind: 'ticket',
            deviceId: null,
            ticketId: ticketOnDevice.id,
          },
          {
            ...runValues(agent!.id, env.orgA.id, `run-move-dev-ticket-${randomUUID()}`),
            triggerKind: 'ticket',
            deviceId: env.device.id,
            ticketId: ticketOnDevice.id,
          },
          {
            ...runValues(agent!.id, env.orgA.id, `run-stay-orphan-${randomUUID()}`),
            triggerKind: 'ticket',
            deviceId: null,
            ticketId: ticketOrphan.id,
          },
          {
            ...runValues(agent!.id, env.orgA.id, `run-stay-otherdev-${randomUUID()}`),
            triggerKind: 'ticket',
            deviceId: null,
            ticketId: ticketOtherDevice.id,
          },
        ])
        .returning(),
    );
  // Guard the fixture itself: a device-LESS ticket run is the whole point,
  // and the discriminators must not accidentally name the moving device.
  expect(movingTicketRun!.deviceId).toBeNull();
  expect(deviceAndTicketRun!.deviceId).toBe(env.device.id);
  expect(ticketOtherDevice.deviceId).not.toBe(env.device.id);

  // Rows that exist today (baseline §9.4): a device command on the one run
  // that actually carries a device, mirroring insertLineage's fixture.
  const deviceCommand = await insertDeviceCommand(env.device.id, env.orgA.id);

  // #4644 — reverse pointer: ticket_comments.agent_run_id. ticket_comments has
  // no org_id (child-via-parent tenancy through tickets), so a comment on
  // ticketOnDevice travels to the target org along with its ticket while the
  // run it names stays in the source org (same class as the
  // metric_anomaly_incidents reverse pointer above). One comment per run,
  // matching the run fixture's own discriminators: two on the ticket that
  // moves (must both null), two on tickets that stay (must both survive).
  const newComment = async (ticketId: string, runId: string) => {
    const [row] = await adminDb
      .insert(ticketComments)
      .values({
        ticketId,
        authorType: 'internal',
        commentType: 'comment',
        content: `AI note fixture for run ${runId}`,
        isPublic: false,
        originPrincipalKind: 'ai_agent',
        agentRunId: runId,
      })
      .returning();
    return row as typeof ticketComments.$inferSelect;
  };
  const movingComment = await newComment(ticketOnDevice.id, movingTicketRun!.id);
  const deviceAndTicketComment = await newComment(ticketOnDevice.id, deviceAndTicketRun!.id);
  const orphanComment = await newComment(ticketOrphan.id, orphanTicketRun!.id);
  const otherDeviceComment = await newComment(ticketOtherDevice.id, otherDeviceTicketRun!.id);

  return {
    ticketOnDevice,
    ticketOrphan,
    ticketOtherDevice,
    movingTicketRun: movingTicketRun!,
    deviceAndTicketRun: deviceAndTicketRun!,
    orphanTicketRun: orphanTicketRun!,
    otherDeviceTicketRun: otherDeviceTicketRun!,
    movingComment,
    deviceAndTicketComment,
    orphanComment,
    otherDeviceComment,
    deviceCommand,
  };
}

/** Post-move expectations shared by the route path and the direct-SQL path. */
export async function expectTicketLineageSevered(
  seeded: Awaited<ReturnType<typeof seedTicketRunLineage>>,
  orgA: { id: string },
  orgB: { id: string },
) {
  const adminDb = getTestDb() as any;
  const ticketOrg = async (id: string) => {
    const [row] = await adminDb.select().from(tickets).where(eq(tickets.id, id));
    return row.orgId as string;
  };
  const run = async (id: string) => {
    const [row] = await adminDb.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, id));
    return row as typeof aiAgentRuns.$inferSelect;
  };

  // Only the moved device's ticket changed org.
  expect(await ticketOrg(seeded.ticketOnDevice.id)).toBe(orgB.id);
  expect(await ticketOrg(seeded.ticketOrphan.id)).toBe(orgA.id);
  expect(await ticketOrg(seeded.ticketOtherDevice.id)).toBe(orgA.id);

  // Runs stay in the source org; pointers at the departed ticket are severed.
  const moved = await run(seeded.movingTicketRun.id);
  expect(moved.orgId).toBe(orgA.id);
  expect(moved.ticketId).toBeNull();

  const both = await run(seeded.deviceAndTicketRun.id);
  expect(both.orgId).toBe(orgA.id);
  expect(both.ticketId).toBeNull();
  expect(both.deviceId).toBeNull();

  // Runs whose ticket never left keep it.
  const orphan = await run(seeded.orphanTicketRun.id);
  expect(orphan.orgId).toBe(orgA.id);
  expect(orphan.ticketId).toBe(seeded.ticketOrphan.id);

  const otherDevice = await run(seeded.otherDeviceTicketRun.id);
  expect(otherDevice.orgId).toBe(orgA.id);
  expect(otherDevice.ticketId).toBe(seeded.ticketOtherDevice.id);

  // #4644 — reverse pointer: comments on the ticket that followed the device
  // must have their agent_run_id severed; comments on tickets that stayed
  // behind must keep theirs.
  const comment = async (id: string) => {
    const [row] = await adminDb.select().from(ticketComments).where(eq(ticketComments.id, id));
    return row as typeof ticketComments.$inferSelect;
  };
  expect((await comment(seeded.movingComment.id)).agentRunId).toBeNull();
  expect((await comment(seeded.deviceAndTicketComment.id)).agentRunId).toBeNull();
  expect((await comment(seeded.orphanComment.id)).agentRunId).toBe(seeded.orphanTicketRun.id);
  expect((await comment(seeded.otherDeviceComment.id)).agentRunId).toBe(
    seeded.otherDeviceTicketRun.id,
  );
}
