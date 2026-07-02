/**
 * Alert delivery rails RLS — dual-axis (org OR partner) enforcement
 * (#2130, epic #2135).
 *
 * Migration under test: 2026-07-01-notification-rails-partner-ownership.sql,
 * covering notification_channels, notification_routing_rules, and
 * escalation_policies. alert_notifications stay alert-join (the firing
 * device's org) and are unchanged.
 *
 * Same dual-axis contract-test blindspot as the sibling suites: this
 * functional test through the REAL postgres.js driver (breeze_app role) is
 * the guard that a partner cannot forge a partner_id for another partner.
 *
 * The second describe block proves the dispatcher fan-out (#1724 trap): the
 * routing/channel lookups previously filtered eq(orgId, alert.orgId), so a
 * stored partner-wide rule/channel would silently never deliver anything.
 */
import './setup';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alertRules,
  alertTemplates,
  alerts,
  devices,
  escalationPolicies,
  notificationChannels,
  notificationRoutingRules,
  sites,
} from '../../db/schema';
import { processAlertNotifications, shutdownNotificationDispatcher } from '../../services/notificationDispatcher';
import { createOrganization, createPartner } from './db-utils';

const createdChannels: string[] = [];
const createdRules: string[] = [];
const createdPolicies: string[] = [];
const createdAlerts: string[] = [];
const createdAlertRules: string[] = [];
const createdTemplates: string[] = [];
const createdDevices: string[] = [];
const createdSites: string[] = [];

// The dispatcher lazily opens a BullMQ queue; close it so vitest can exit.
afterAll(async () => {
  await shutdownNotificationDispatcher();
});

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdAlerts.length > 0) {
      await db.delete(alerts).where(inArray(alerts.id, createdAlerts));
    }
    for (const id of createdAlertRules) {
      await db.delete(alertRules).where(eq(alertRules.id, id));
    }
    for (const id of createdTemplates) {
      await db.delete(alertTemplates).where(eq(alertTemplates.id, id));
    }
    for (const id of createdRules) {
      await db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, id));
    }
    for (const id of createdPolicies) {
      await db.delete(escalationPolicies).where(eq(escalationPolicies.id, id));
    }
    for (const id of createdChannels) {
      await db.delete(notificationChannels).where(eq(notificationChannels.id, id));
    }
    for (const id of createdDevices) {
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdSites) {
      await db.delete(sites).where(eq(sites.id, id));
    }
  });
  createdChannels.length = 0;
  createdRules.length = 0;
  createdPolicies.length = 0;
  createdAlerts.length = 0;
  createdAlertRules.length = 0;
  createdTemplates.length = 0;
  createdDevices.length = 0;
  createdSites.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function seedPartnerChannel(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(notificationChannels)
      .values({
        orgId: null,
        partnerId,
        name: 'Partner NOC Slack',
        type: 'slack',
        config: { webhookUrl: 'https://hooks.slack.example/noc' },
        enabled: true,
      })
      .returning(),
  );
  const id = rows[0]!.id;
  createdChannels.push(id);
  return id;
}

// The three rails share one migration and one policy shape — exercise the
// forge/XOR/isolation contract per table without triplicating prose.
const RAIL_CASES = [
  {
    label: 'notification_channels',
    insert: (owner: { orgId: string | null; partnerId: string | null }) =>
      db.insert(notificationChannels).values({
        ...owner,
        name: 'Rail case channel',
        type: 'slack',
        config: { webhookUrl: 'https://hooks.slack.example/x' },
        enabled: true,
      }).returning({ id: notificationChannels.id, orgId: notificationChannels.orgId, partnerId: notificationChannels.partnerId }),
    selectById: (id: string) =>
      db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.id, id)),
    track: createdChannels,
  },
  {
    label: 'notification_routing_rules',
    insert: (owner: { orgId: string | null; partnerId: string | null }) =>
      db.insert(notificationRoutingRules).values({
        ...owner,
        name: 'Rail case rule',
        priority: 10,
        conditions: { severities: ['critical'] },
        channelIds: [],
        enabled: true,
      }).returning({ id: notificationRoutingRules.id, orgId: notificationRoutingRules.orgId, partnerId: notificationRoutingRules.partnerId }),
    selectById: (id: string) =>
      db.select({ id: notificationRoutingRules.id }).from(notificationRoutingRules).where(eq(notificationRoutingRules.id, id)),
    track: createdRules,
  },
  {
    label: 'escalation_policies',
    insert: (owner: { orgId: string | null; partnerId: string | null }) =>
      db.insert(escalationPolicies).values({
        ...owner,
        name: 'Rail case escalation',
        steps: [{ delayMinutes: 15, channelIds: [] }],
      }).returning({ id: escalationPolicies.id, orgId: escalationPolicies.orgId, partnerId: escalationPolicies.partnerId }),
    selectById: (id: string) =>
      db.select({ id: escalationPolicies.id }).from(escalationPolicies).where(eq(escalationPolicies.id, id)),
    track: createdPolicies,
  },
] as const;

describe.each(RAIL_CASES)('$label RLS — dual-axis (2026-07-01 migration)', (rail) => {
  it('partner scope can INSERT and SELECT a partner-wide row; another partner can neither see nor forge it', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      rail.insert({ orgId: null, partnerId: partnerA.id }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partnerA.id);
    const id = rows[0]!.id;
    rail.track.push(id);

    const visibleToA = await withDbAccessContext(partnerContext(partnerA.id, []), () => rail.selectById(id));
    expect(visibleToA).toHaveLength(1);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () => rail.selectById(id));
    expect(visibleToB).toEqual([]);

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        rail.insert({ orgId: null, partnerId: partnerA.id }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scope caller cannot see a partner-wide row; org-owned rows keep the original shape', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const partnerRows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      rail.insert({ orgId: null, partnerId: partner.id }),
    );
    rail.track.push(partnerRows[0]!.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () => rail.selectById(partnerRows[0]!.id));
    expect(visibleToOrg).toEqual([]);

    const orgRows = await withDbAccessContext(orgContext(org.id), () =>
      rail.insert({ orgId: org.id, partnerId: null }),
    );
    rail.track.push(orgRows[0]!.id);
    expect(orgRows[0]?.orgId).toBe(org.id);
  });

  it('the one-owner CHECK rejects a row that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () => rail.insert({ orgId: org.id, partnerId: partner.id })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () => rail.insert({ orgId: null, partnerId: null })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

// ============================================================
// Dispatcher fan-out (#2130): the load-bearing SQL that makes a stored
// partner-wide rail actually DELIVER. processAlertNotifications previously
// filtered routing rules and channels by eq(orgId, alert.orgId), which
// silently never matched org_id NULL rows — the #1724 trap. The worker runs
// under system context, so RLS was never the filter; these prove the app
// queries.
// ============================================================

describe('processAlertNotifications — partner-wide rail fan-out (#2130)', () => {
  async function seedDevice(orgId: string, hostname: string): Promise<string> {
    const [site] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(sites).values({ orgId, name: 'HQ' }).returning(),
    );
    createdSites.push(site!.id);
    const [device] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(devices)
        .values({
          orgId,
          siteId: site!.id,
          agentId: `agent-${site!.id.slice(0, 18)}`,
          hostname,
          osType: 'windows',
          osVersion: '10.0',
          architecture: 'x64',
          agentVersion: '1.0.0',
        })
        .returning(),
    );
    createdDevices.push(device!.id);
    return device!.id;
  }

  async function seedAlert(orgId: string, deviceId: string): Promise<string> {
    const [alert] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(alerts)
        .values({
          orgId,
          deviceId,
          severity: 'critical',
          status: 'active',
          title: 'Rail fan-out test alert',
          message: 'CPU on fire',
        })
        .returning(),
    );
    createdAlerts.push(alert!.id);
    return alert!.id;
  }

  it("a partner-wide routing rule + channel deliver a member org's alert; a FOREIGN partner's rails never match", async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });

    const deviceA = await seedDevice(orgA.id, 'rail-fanout-a');
    const alertA = await seedAlert(orgA.id, deviceA);

    // Partner A: partner-wide channel + partner-wide routing rule for critical.
    const channelA = await seedPartnerChannel(partnerA.id);
    const [ruleA] = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db
        .insert(notificationRoutingRules)
        .values({
          orgId: null,
          partnerId: partnerA.id,
          name: 'Criticals to partner NOC',
          priority: 5,
          conditions: { severities: ['critical'] },
          channelIds: [channelA],
          enabled: true,
        })
        .returning(),
    );
    createdRules.push(ruleA!.id);

    // Partner B: a decoy partner-wide rule + channel that must NEVER match
    // an org-A alert.
    const channelB = await seedPartnerChannel(partnerB.id);
    const [ruleB] = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .insert(notificationRoutingRules)
        .values({
          orgId: null,
          partnerId: partnerB.id,
          name: 'Foreign partner rule',
          priority: 1,
          conditions: { severities: ['critical'] },
          channelIds: [channelB],
          enabled: true,
        })
        .returning(),
    );
    createdRules.push(ruleB!.id);

    // The dispatcher worker runs under system context — mirror that.
    const result = await withDbAccessContext(SYSTEM_CTX, () =>
      processAlertNotifications({ type: 'process-alert', alertId: alertA }),
    );

    // Exactly the partner-wide channel of the alert org's OWN partner is
    // queued: rule A matched (despite org_id NULL) and its channel survived
    // the dual-axis validation; partner B's higher-priority rule never
    // entered the candidate set.
    expect(result.queued).toBe(1);
  });

  it("a partner-wide channel participates in the no-rules fallback for member-org alerts only", async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const deviceA = await seedDevice(orgA.id, 'rail-fallback-a');
    const deviceB = await seedDevice(orgB.id, 'rail-fallback-b');
    const alertA = await seedAlert(orgA.id, deviceA);
    const alertB = await seedAlert(orgB.id, deviceB);

    // Only partner A has a (partner-wide) channel; no routing rules at all.
    await seedPartnerChannel(partnerA.id);

    const resultA = await withDbAccessContext(SYSTEM_CTX, () =>
      processAlertNotifications({ type: 'process-alert', alertId: alertA }),
    );
    expect(resultA.queued).toBe(1); // fallback found the partner-wide channel

    const resultB = await withDbAccessContext(SYSTEM_CTX, () =>
      processAlertNotifications({ type: 'process-alert', alertId: alertB }),
    );
    expect(resultB.queued).toBe(0); // another partner's channel NEVER leaks in
  });

  it('a partner-wide escalation policy schedules delayed sends for a member-org alert', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const deviceId = await seedDevice(org.id, 'rail-escalation');

    const channelId = await seedPartnerChannel(partner.id);

    // Partner-wide escalation policy whose step routes to the partner channel.
    const [policy] = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(escalationPolicies)
        .values({
          orgId: null,
          partnerId: partner.id,
          name: 'Partner NOC escalation',
          steps: [{ delayMinutes: 15, channelIds: [channelId] }],
        })
        .returning(),
    );
    createdPolicies.push(policy!.id);

    // Org-owned alert rule binding the partner-wide escalation policy + channel.
    const [template] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(alertTemplates)
        .values({
          orgId: org.id,
          name: 'Escalation template',
          conditions: { type: 'metric', metric: 'cpu', operator: '>', threshold: 95 },
          severity: 'critical',
          titleTemplate: 'High CPU',
          messageTemplate: 'CPU exceeded threshold',
        })
        .returning(),
    );
    createdTemplates.push(template!.id);

    const [rule] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(alertRules)
        .values({
          orgId: org.id,
          templateId: template!.id,
          name: 'Escalating rule',
          targetType: 'org',
          targetId: org.id,
          overrideSettings: {
            notificationChannelIds: [channelId],
            escalationPolicyId: policy!.id,
          },
        })
        .returning(),
    );
    createdAlertRules.push(rule!.id);

    const [alert] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(alerts)
        .values({
          orgId: org.id,
          deviceId,
          ruleId: rule!.id,
          severity: 'critical',
          status: 'active',
          title: 'Escalation fan-out test alert',
          message: 'CPU on fire',
        })
        .returning(),
    );
    createdAlerts.push(alert!.id);

    const result = await withDbAccessContext(SYSTEM_CTX, () =>
      processAlertNotifications({ type: 'process-alert', alertId: alert!.id }),
    );

    // The immediate send used the partner-wide channel (rule override), and
    // scheduleEscalation found the PARTNER-WIDE policy (org_id NULL) and
    // validated its step channel dual-axis — previously both lookups were
    // eq(orgId, alert.orgId) and would have silently no-opped.
    expect(result.queued).toBe(1);

    const { getNotificationQueue } = await import('../../services/notificationDispatcher');
    const delayed = await getNotificationQueue().getDelayed();
    const escalationJobs = delayed.filter(
      (job) => job.data?.alertId === alert!.id && job.data?.escalationStep,
    );
    expect(escalationJobs.length).toBe(1);
    expect(escalationJobs[0]!.data.channelId).toBe(channelId);
    for (const job of escalationJobs) {
      await job.remove();
    }
  });
});
