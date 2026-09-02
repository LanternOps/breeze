/**
 * Live-Postgres proof of the wave-3b move semantics for ai_agent_runs
 * (owner decision 2026-08-23): when a device moves between orgs, its
 * agent-run history STAYS with the source org. moveOrg no longer re-stamps
 * ai_agent_runs.org_id (the table left CORE_DEVICE_ORG_DENORMALIZED_TABLES);
 * instead it severs the run's device-lineage links (device_id, alert_id,
 * session_id → NULL). With no legitimate org_id writer left, org_id joined
 * the immutability guard (2026-09-06-a-agent-runs-org-immutable.sql).
 *
 * Why each case exists:
 *  1. org_id immutability — inverts the pre-3b contract pinned by
 *     aiAgentRuns.integration.test.ts ("org_id stays re-stampable"). A
 *     dual-org context (what moveOrg actually runs under) passes RLS
 *     WITH CHECK for both orgs, so the trigger is the ONLY thing stopping
 *     a re-stamp now.
 *  2. The exact detach statement moveOrg runs must NOT trip the composite
 *     tenant FK (action_intents.requesting_agent_run_id, org_id) →
 *     ai_agent_runs(id, org_id): neither referenced column changes.
 *  3. The REAL route: a direct-SQL test alone cannot catch a forgotten
 *     route change — this drives POST /devices/:id/move-org end to end and
 *     asserts no cross-tenant reference survives on the retained run.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  aiSessions,
  alerts,
  devices,
  metricAnomalyIncidents,
  tickets,
} from '../../db/schema';
import type { NewActionIntent } from '../../db/schema/actionIntents';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import {
  createOrganization,
  createPartner,
  createSite,
  createUser,
  setupTestEnvironment,
} from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
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
async function expectImmutableViolation(fn: () => Promise<unknown>): Promise<void> {
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

function runValues(agentId: string, orgId: string, dedupeKey: string) {
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
async function orgWithAgent() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });
  const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(aiAgents)
      .values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
      .returning(),
  );
  return { partner, org, user, agent: agent! };
}

/** Inserts a device row directly via the admin connection. */
async function insertDevice(orgId: string, siteId: string) {
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

/** Full device lineage: alert + ai_session on the device, run linking all three. */
async function insertLineage(t: {
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
  return { alert, session, run: run! };
}

/** An agent-originated intent attributed to the run (composite tenant FK live). */
async function insertAgentIntent(
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

describe('agent-run move semantics (owner decision 2026-08-23)', () => {
  it('org_id on ai_agent_runs is immutable even for a dual-org context', async () => {
    // Inverts the pre-3b contract: moveOrg no longer re-stamps runs, so no
    // legitimate org_id writer remains and the guard now covers it.
    const t = await orgWithAgent();
    const target = await createOrganization({ partnerId: t.partner.id });
    const [row] = await withDbAccessContext(orgContext(t.org.id, t.partner.id), () =>
      db.insert(aiAgentRuns).values(runValues(t.agent.id, t.org.id, 'move-sem-1')).returning(),
    );
    const bothOrgs: DbAccessContext = {
      scope: 'organization',
      orgId: t.org.id,
      accessibleOrgIds: [t.org.id, target.id],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: t.partner.id,
    };
    await expectImmutableViolation(() =>
      withDbAccessContext(bothOrgs, () =>
        db
          .update(aiAgentRuns)
          .set({ orgId: target.id })
          .where(eq(aiAgentRuns.id, row!.id))
          .returning(),
      ),
    );
  });

  it('detaching the lineage links succeeds while an intent still attributes the run', async () => {
    // The exact statement moveOrg now runs. It must NOT trip the composite FK:
    // (requesting_agent_run_id, org_id) references (id, org_id) and neither
    // changes on detach.
    const t = await orgWithAgent();
    const site = await createSite({ orgId: t.org.id });
    const device = await insertDevice(t.org.id, site.id);
    const lineage = await insertLineage({ ...t, device });
    await insertAgentIntent(t.org.id, t.partner.id, t.agent.id, lineage.run.id);

    const [detached] = await withSystemDbAccessContext(() =>
      db
        .update(aiAgentRuns)
        .set({ deviceId: null, alertId: null, sessionId: null })
        .where(eq(aiAgentRuns.deviceId, device.id))
        .returning(),
    );
    expect(detached!.deviceId).toBeNull();
    expect(detached!.alertId).toBeNull();
    expect(detached!.sessionId).toBeNull();
    expect(detached!.orgId).toBe(t.org.id); // stayed home
  });

  it('the REAL move route leaves no cross-tenant reference on retained runs', async () => {
    // Drives POST /devices/:id/move-org through the route harness (mirrors
    // deviceMoveOrgCurrency.integration.test.ts) with a run that has
    // device_id, alert_id AND session_id populated and an agent intent
    // attached. After the move: the device, its alert and its ai_session are
    // in the target org; the run remains in the SOURCE org with all three
    // lineage links NULL; the intent is untouched. A direct-SQL test alone
    // cannot catch a forgotten route change — this exercises the transaction
    // the product actually runs.
    const adminDb = getTestDb() as any;
    const env = await setupTestEnvironment({ scope: 'partner' });
    const { partner, organization: orgA, site: siteA, user, role } = env;
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteB = await createSite({ orgId: orgB.id });

    const device = await insertDevice(orgA.id, siteA.id);
    const [agent] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgents)
        .values({ orgId: orgA.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
        .returning(),
    );
    const lineage = await insertLineage({ org: orgA, partner, agent: agent!, device });
    const intentId = await insertAgentIntent(orgA.id, partner.id, agent!.id, lineage.run.id);

    const token = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });

    const app = new Hono();
    app.route('/devices', moveOrgRoutes);
    const res = await app.request(`/devices/${device.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: orgB.id, siteId: siteB.id }),
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    // Device, alert and session followed the move.
    const [movedDevice] = await adminDb.select().from(devices).where(eq(devices.id, device.id));
    expect(movedDevice.orgId).toBe(orgB.id);
    const [movedAlert] = await adminDb.select().from(alerts).where(eq(alerts.id, lineage.alert.id));
    expect(movedAlert.orgId).toBe(orgB.id);
    const [movedSession] = await adminDb
      .select()
      .from(aiSessions)
      .where(eq(aiSessions.id, lineage.session.id));
    expect(movedSession.orgId).toBe(orgB.id);

    // The run stayed home, fully detached — no cross-tenant reference left.
    const [run] = await adminDb.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, lineage.run.id));
    expect(run.orgId).toBe(orgA.id);
    expect(run.deviceId).toBeNull();
    expect(run.alertId).toBeNull();
    expect(run.sessionId).toBeNull();

    // The attributed intent is untouched.
    const [intent] = await adminDb.select().from(actionIntents).where(eq(actionIntents.id, intentId));
    expect(intent.orgId).toBe(orgA.id);
    expect(intent.requestingAgentRunId).toBe(lineage.run.id);
  });

  it('#3828 branch-review blocker 2: the REAL move route detaches anomaly_incident_id and nulls the reverse pointer', async () => {
    // Same shape as the previous test, but exercises the anomaly-incident
    // lineage pair (ai_agent_runs.anomaly_incident_id <-> metric_anomaly_
    // incidents.agent_run_id) added by wave 6 PR 4 (#3828). Before this fix,
    // moveOrg.ts's detach statement and breeze_cascade_device_org_id() both
    // stopped at device_id/alert_id/session_id, so the source-org run kept
    // anomaly_incident_id pointing at an incident re-stamped to the target
    // org, and the incident's agent_run_id kept naming a source-org run.
    const adminDb = getTestDb() as any;
    const env = await setupTestEnvironment({ scope: 'partner' });
    const { partner, organization: orgA, site: siteA, user, role } = env;
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteB = await createSite({ orgId: orgB.id });

    const device = await insertDevice(orgA.id, siteA.id);
    const [agent] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgents)
        .values({ orgId: orgA.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
        .returning(),
    );
    const now = new Date();
    const [incident] = await adminDb
      .insert(metricAnomalyIncidents)
      .values({
        orgId: orgA.id,
        deviceId: device.id,
        anomalyType: 'cpu_spike',
        bucketSeconds: 300,
        windowStart: now,
        firstSeenAt: now,
        lastSeenAt: now,
        peakScore: '3.2',
      })
      .returning();
    const [run] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentRuns)
        .values({
          ...runValues(agent!.id, orgA.id, `run-move-anomaly-${randomUUID()}`),
          triggerKind: 'anomaly',
          deviceId: device.id,
          anomalyIncidentId: incident!.id,
        })
        .returning(),
    );
    // The dispatch marker's best-effort back-link, stamped by the subscriber
    // on admission (Task 3) — set directly here since this test targets only
    // the move-org detach, not the subscriber.
    await adminDb
      .update(metricAnomalyIncidents)
      .set({ agentRunId: run!.id })
      .where(eq(metricAnomalyIncidents.id, incident!.id));

    const token = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });

    const app = new Hono();
    app.route('/devices', moveOrgRoutes);
    const res = await app.request(`/devices/${device.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: orgB.id, siteId: siteB.id }),
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    // The incident followed the device to the target org (it's in
    // getDeviceOrgDenormalizedTables()).
    const [movedIncident] = await adminDb
      .select()
      .from(metricAnomalyIncidents)
      .where(eq(metricAnomalyIncidents.id, incident!.id));
    expect(movedIncident.orgId).toBe(orgB.id);
    // Reverse pointer nulled — it must not keep naming a source-org run now
    // that the incident lives in the target org.
    expect(movedIncident.agentRunId).toBeNull();

    // The run stayed home in the source org, with anomaly_incident_id
    // detached — no cross-tenant reference left.
    const [movedRun] = await adminDb.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, run!.id));
    expect(movedRun.orgId).toBe(orgA.id);
    expect(movedRun.anomalyIncidentId).toBeNull();
    expect(movedRun.deviceId).toBeNull();
  });

  it('#4215: the REAL move route detaches ticket_id on device-less ticket runs, and only those', async () => {
    // The fifth device-lineage FK. Unlike the four above it is unreachable
    // from `WHERE device_id = <moved>`: a triage run on a ticket carries
    // ticket_id with a NULL device_id (trigger_kind 'ticket'), so the
    // device-keyed detach never sees it while `tickets` IS in
    // getDeviceOrgDenormalizedTables() — the ticket follows the device to the
    // target org and the retained source-org run is left naming a foreign
    // ticket. Both the route and breeze_cascade_device_org_id() now run a
    // second, ticket-keyed statement; this drives the route end to end.
    //
    // The second run/ticket pair is the discriminator: a ticket NOT bound to
    // the moved device stays in the source org, so its run must keep its
    // ticket_id. Without it a detach that simply nulled every ticket_id would
    // pass this test.
    const adminDb = getTestDb() as any;
    const env = await setupTestEnvironment({ scope: 'partner' });
    const { partner, organization: orgA, site: siteA, user, role } = env;
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteB = await createSite({ orgId: orgB.id });

    const device = await insertDevice(orgA.id, siteA.id);
    const [agent] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgents)
        .values({ orgId: orgA.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id })
        .returning(),
    );

    const unique = randomUUID().slice(0, 8);
    const [ticketOnDevice] = await adminDb
      .insert(tickets)
      .values({
        orgId: orgA.id,
        partnerId: partner.id,
        deviceId: device.id,
        ticketNumber: `RUNMOVE-DEV-${unique}`,
        subject: 'ticket bound to the moving device',
        source: 'manual',
      })
      .returning();
    const [ticketElsewhere] = await adminDb
      .insert(tickets)
      .values({
        orgId: orgA.id,
        partnerId: partner.id,
        deviceId: null,
        ticketNumber: `RUNMOVE-OTHER-${unique}`,
        subject: 'ticket that stays in the source org',
        source: 'manual',
      })
      .returning();

    const [movingTicketRun, stayingTicketRun] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentRuns)
        .values([
          {
            ...runValues(agent!.id, orgA.id, `run-move-ticket-${randomUUID()}`),
            triggerKind: 'ticket',
            deviceId: null,
            ticketId: ticketOnDevice.id,
          },
          {
            ...runValues(agent!.id, orgA.id, `run-stay-ticket-${randomUUID()}`),
            triggerKind: 'ticket',
            deviceId: null,
            ticketId: ticketElsewhere.id,
          },
        ])
        .returning(),
    );
    // Guard the fixture itself: a device-less ticket run is the whole point.
    expect(movingTicketRun!.deviceId).toBeNull();

    const token = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });

    const app = new Hono();
    app.route('/devices', moveOrgRoutes);
    const res = await app.request(`/devices/${device.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: orgB.id, siteId: siteB.id }),
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    // The device's ticket followed it; the unrelated one did not.
    const [movedTicket] = await adminDb
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketOnDevice.id));
    expect(movedTicket.orgId).toBe(orgB.id);
    const [stayedTicket] = await adminDb
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketElsewhere.id));
    expect(stayedTicket.orgId).toBe(orgA.id);

    // The run stayed home with ticket_id severed — no cross-tenant pointer.
    const [detached] = await adminDb
      .select()
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, movingTicketRun!.id));
    expect(detached.orgId).toBe(orgA.id);
    expect(detached.ticketId).toBeNull();

    // ...and the run whose ticket never left is untouched.
    const [untouched] = await adminDb
      .select()
      .from(aiAgentRuns)
      .where(eq(aiAgentRuns.id, stayingTicketRun!.id));
    expect(untouched.orgId).toBe(orgA.id);
    expect(untouched.ticketId).toBe(ticketElsewhere.id);
  });
});
