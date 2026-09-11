/**
 * Integration test: the ALERT-axis children of a device org-move (#4867, and
 * the post-merge review of #5005).
 *
 * The three tables `alert_correlation_members`, `alert_correlation_groups` and
 * `ai_alert_verdicts` denormalize `org_id` but have NO `device_id` column, so
 * moveOrg.ts reaches them with three hand-written raw UPDATEs. `moveOrg.test.ts`
 * mocks `../../db` wholesale, so those statements are only ever compared as
 * TEXT there — nothing in CI executed them until this file. Every predicate
 * they carry (the three group hold-back guards, the member gate, the verdict's
 * two legs) is therefore asserted here against real Postgres, through the real
 * route, under real RLS.
 *
 * Proves:
 *   (1) a correlation group whose member alerts ALL reach the target org
 *       travels with the device — the group, every one of its member rows, its
 *       group-level verdict and the alert-level verdict on a moved alert are
 *       all re-stamped to the target org;
 *   (2) a group still SPANNING two orgs afterwards (one member alert sits on a
 *       device that did not move) is held back — and, the #5005 review's
 *       split-brain finding, its member rows are held back WITH it. Before the
 *       fix the member row moved unconditionally while its group stayed, and
 *       `correlationMetadataCondition` (routes/alerts/alerts.ts) pins BOTH
 *       org_ids, so the row was then visible to neither org;
 *   (3) both audit rows carry the split hold-back counts.
 *
 * Harness mirrors deviceMoveOrgCurrency.integration.test.ts: a partner-scope
 * environment with wildcard permissions and an MFA-bearing access token.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  aiAgentRuns,
  aiAgents,
  aiAlertVerdicts,
  alertCorrelationGroups,
  alertCorrelationMembers,
  alerts,
  auditLogs,
  devices,
} from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Two orgs under one partner, two devices in the source org, and two
 * correlation groups whose fates differ:
 *
 *   gTravelling — members are alertA1 + alertA2, BOTH on `deviceMoved`. After
 *     the move every member alert is in orgB, so the group travels.
 *   gSpanning   — members are alertA4 (on `deviceMoved`) and alertB1 (on
 *     `deviceStays`). After the move alertB1 is still in orgA, so the group is
 *     held back — and alertA4's member row must be held back with it.
 *
 * Verdicts cover both legs of the verdict statement: `verdictOnAlert` is
 * alert-level on alertA1, `verdictOnTravellingGroup` is group-level on
 * gTravelling (alert_id NULL — the `duplicate_of_group` shape the alert leg
 * alone can never reach), `verdictOnSpanningGroup` is group-level on the group
 * that stays.
 */
async function seed() {
  const adminDb = getTestDb() as any;
  const unique = uid();

  const env = await setupTestEnvironment({ scope: 'partner' });
  const { partner, organization: orgA, site: siteA, user, role } = env;

  const orgB = await createOrganization({ partnerId: partner.id });
  const siteB = await createSite({ orgId: orgB.id });

  const insertDevice = async (label: string) => {
    const [row] = await adminDb.insert(devices).values({
      orgId: orgA.id,
      siteId: siteA.id,
      agentId: `ac-${label}-agent-${unique}`,
      hostname: `ac-${label}-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    }).returning();
    return row;
  };
  const deviceMoved = await insertDevice('moved');
  const deviceStays = await insertDevice('stays');

  const insertAlert = async (deviceId: string, title: string) => {
    const [row] = await adminDb.insert(alerts).values({
      orgId: orgA.id,
      deviceId,
      severity: 'high',
      status: 'active',
      title: `${title} ${unique}`,
    }).returning();
    return row;
  };
  const alertA1 = await insertAlert(deviceMoved.id, 'moved-root');
  const alertA2 = await insertAlert(deviceMoved.id, 'moved-related');
  const alertA4 = await insertAlert(deviceMoved.id, 'moved-spanning');
  const alertB1 = await insertAlert(deviceStays.id, 'stays-spanning');

  const insertGroup = async (rootAlertId: string) => {
    const [row] = await adminDb.insert(alertCorrelationGroups).values({
      orgId: orgA.id,
      // Same shape the correlation job mints (services/alertCorrelationGroups.ts).
      groupKey: `root:${rootAlertId}`,
      rootAlertId,
      status: 'open',
      score: '0.90',
      noiseReductionPercent: 50,
      memberCount: 2,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    }).returning();
    return row;
  };
  const gTravelling = await insertGroup(alertA1.id);
  const gSpanning = await insertGroup(alertA4.id);

  const insertMember = async (groupId: string, alertId: string, role_: 'root' | 'related') => {
    const [row] = await adminDb.insert(alertCorrelationMembers).values({
      orgId: orgA.id,
      groupId,
      alertId,
      role: role_,
      confidence: '0.90',
    }).returning();
    return row;
  };
  const memberA1 = await insertMember(gTravelling.id, alertA1.id, 'root');
  const memberA2 = await insertMember(gTravelling.id, alertA2.id, 'related');
  const memberA4 = await insertMember(gSpanning.id, alertA4.id, 'root');
  const memberB1 = await insertMember(gSpanning.id, alertB1.id, 'related');

  // `ai_alert_verdicts.run_id` is NOT NULL, so a verdict needs a real agent run.
  // The run itself deliberately STAYS in the source org (owner decision
  // 2026-08-23), which is why the route re-stamps the verdict and not the run.
  const [agent] = await adminDb.insert(aiAgents).values({
    orgId: orgA.id,
    partnerId: null,
    kind: 'triage',
    name: `Verdict agent ${unique}`,
    createdBy: user.id,
  }).returning();
  const [run] = await adminDb.insert(aiAgentRuns).values({
    agentId: agent.id,
    orgId: orgA.id,
    triggerKind: 'alert',
    dedupeKey: `alert-children-${unique}`,
    modeAtStart: 'shadow',
    policySnapshot: { schemaVersion: 1 } as never,
  }).returning();

  const insertVerdict = async (target: { alertId?: string; correlationGroupId?: string }) => {
    const [row] = await adminDb.insert(aiAlertVerdicts).values({
      orgId: orgA.id,
      runId: run.id,
      alertId: target.alertId ?? null,
      correlationGroupId: target.correlationGroupId ?? null,
      classification: target.alertId ? 'actionable' : 'duplicate_of_group',
      confidence: '0.80',
      rationale: 'integration fixture',
    }).returning();
    return row;
  };
  const verdictOnAlert = await insertVerdict({ alertId: alertA1.id });
  const verdictOnTravellingGroup = await insertVerdict({ correlationGroupId: gTravelling.id });
  const verdictOnSpanningGroup = await insertVerdict({ correlationGroupId: gSpanning.id });

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
    sid: 'it-session',
  });

  const app = new Hono();
  app.route('/devices', moveOrgRoutes);

  const move = () =>
    app.request(`/devices/${deviceMoved.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: orgB.id, siteId: siteB.id }),
    });

  return {
    adminDb, orgA, orgB, siteB,
    deviceMoved, deviceStays,
    alertA1, alertA2, alertA4, alertB1,
    gTravelling, gSpanning,
    memberA1, memberA2, memberA4, memberB1,
    verdictOnAlert, verdictOnTravellingGroup, verdictOnSpanningGroup,
    move,
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

/** org_id of every seeded row, keyed by the fixture's own names. */
async function readOrgIds(f: Fixture) {
  const byId = (rows: Array<{ id: string; orgId: string }>) =>
    new Map(rows.map((r) => [r.id, r] as const));

  const deviceRows = byId(await f.adminDb
    .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(inArray(devices.id, [f.deviceMoved.id, f.deviceStays.id])));
  const alertRows = byId(await f.adminDb
    .select({ id: alerts.id, orgId: alerts.orgId })
    .from(alerts)
    .where(inArray(alerts.id, [f.alertA1.id, f.alertA2.id, f.alertA4.id, f.alertB1.id])));
  const groupRows = byId(await f.adminDb
    .select({ id: alertCorrelationGroups.id, orgId: alertCorrelationGroups.orgId })
    .from(alertCorrelationGroups)
    .where(inArray(alertCorrelationGroups.id, [f.gTravelling.id, f.gSpanning.id])));
  const memberRows = byId(await f.adminDb
    .select({ id: alertCorrelationMembers.id, orgId: alertCorrelationMembers.orgId })
    .from(alertCorrelationMembers)
    .where(inArray(alertCorrelationMembers.id, [
      f.memberA1.id, f.memberA2.id, f.memberA4.id, f.memberB1.id,
    ])));
  const verdictRows = byId(await f.adminDb
    .select({ id: aiAlertVerdicts.id, orgId: aiAlertVerdicts.orgId })
    .from(aiAlertVerdicts)
    .where(inArray(aiAlertVerdicts.id, [
      f.verdictOnAlert.id, f.verdictOnTravellingGroup.id, f.verdictOnSpanningGroup.id,
    ])));

  const org = (map: Map<string, { orgId: string }>, id: string) => map.get(id)?.orgId;
  return {
    deviceMoved: org(deviceRows, f.deviceMoved.id),
    deviceStays: org(deviceRows, f.deviceStays.id),
    alertA1: org(alertRows, f.alertA1.id),
    alertA2: org(alertRows, f.alertA2.id),
    alertA4: org(alertRows, f.alertA4.id),
    alertB1: org(alertRows, f.alertB1.id),
    gTravelling: org(groupRows, f.gTravelling.id),
    gSpanning: org(groupRows, f.gSpanning.id),
    memberA1: org(memberRows, f.memberA1.id),
    memberA2: org(memberRows, f.memberA2.id),
    memberA4: org(memberRows, f.memberA4.id),
    memberB1: org(memberRows, f.memberB1.id),
    verdictOnAlert: org(verdictRows, f.verdictOnAlert.id),
    verdictOnTravellingGroup: org(verdictRows, f.verdictOnTravellingGroup.id),
    verdictOnSpanningGroup: org(verdictRows, f.verdictOnSpanningGroup.id),
  };
}

describe('POST /devices/:id/move-org — alert-axis children (#4867)', () => {
  it('re-stamps the group, ALL of its members and both verdict legs when every member alert reaches the target org', async () => {
    const f = await seed();

    const res = await f.move();
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(200);

    const after = await readOrgIds(f);
    expect(after.deviceMoved).toBe(f.orgB.id);
    // The generic device loop carries the alerts themselves.
    expect(after.alertA1).toBe(f.orgB.id);
    expect(after.alertA2).toBe(f.orgB.id);

    // Group: all member alerts are in orgB and the (org_id, group_key) slot is
    // free there, so all three guards pass.
    expect(after.gTravelling).toBe(f.orgB.id);
    // Members travel WITH the group — never apart from it.
    expect(after.memberA1).toBe(f.orgB.id);
    expect(after.memberA2).toBe(f.orgB.id);
    // Verdict, alert leg (alert_id set) and group leg (alert_id NULL,
    // correlation_group_id set) — the second is the one the alert leg alone
    // can never reach.
    expect(after.verdictOnAlert).toBe(f.orgB.id);
    expect(after.verdictOnTravellingGroup).toBe(f.orgB.id);
  });

  it('holds a group that still spans two orgs back — and holds ITS member rows back with it', async () => {
    const f = await seed();

    const res = await f.move();
    expect(res.status).toBe(200);

    const after = await readOrgIds(f);
    // The moved device's alert follows the device...
    expect(after.alertA4).toBe(f.orgB.id);
    // ...but the alert on the device that stayed does not, so the group is
    // still split across two orgs and is deliberately left behind.
    expect(after.deviceStays).toBe(f.orgA.id);
    expect(after.alertB1).toBe(f.orgA.id);
    expect(after.gSpanning).toBe(f.orgA.id);

    // THE REGRESSION THIS FILE EXISTS FOR (#5005 review, split-brain): the
    // member row for the MOVED device's alert must stay with its group. Moving
    // it while the group stays makes it invisible to both orgs, because
    // correlationMetadataCondition joins on members.org_id AND groups.org_id.
    expect(after.memberA4).toBe(f.orgA.id);
    expect(after.memberB1).toBe(f.orgA.id);
    // A group-level verdict follows its group, so it stays too.
    expect(after.verdictOnSpanningGroup).toBe(f.orgA.id);
  });

  it('records the moved and held-back counts, split by hold-back reason, on BOTH audit rows', async () => {
    const f = await seed();

    const res = await f.move();
    expect(res.status).toBe(200);

    // writeRouteAudit is fire-and-forget — let it land.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const audits = await f.adminDb
      .select({ action: auditLogs.action, orgId: auditLogs.orgId, details: auditLogs.details })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, f.deviceMoved.id));
    expect(audits.map((a: { action: string }) => a.action).sort())
      .toEqual(['device.move_org.source', 'device.move_org.target']);
    expect(audits.map((a: { orgId: string }) => a.orgId).sort())
      .toEqual([f.orgA.id, f.orgB.id].sort());

    for (const row of audits) {
      expect(row.details).toMatchObject({
        alertChildRewrite: {
          // gTravelling moved; gSpanning was held back for spanning two orgs
          // (no group_key collision in this fixture).
          correlationGroups: 1,
          correlationGroupsHeldSpanning: 1,
          correlationGroupsHeldKeyCollision: 0,
          // memberA1 + memberA2 travelled with gTravelling; memberA4 (this
          // device's membership in the held group) stayed.
          correlationMembers: 2,
          correlationMembersHeld: 1,
          // verdictOnAlert + verdictOnTravellingGroup.
          alertVerdicts: 2,
        },
      });
    }
  });
});
