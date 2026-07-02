/**
 * automations RLS — dual-axis (org OR partner) enforcement (#2133, epic #2135).
 *
 * Migration under test: 2026-07-02-automations-partner-ownership.sql.
 *
 * A standalone automation is owned by EITHER an org (org_id set, partner_id
 * NULL — the original shape) OR a partner (partner_id set, org_id NULL —
 * partner-wide / "all orgs"). automation_runs has no ownership columns and
 * stays parent-join (its EXISTS policies gained the partner branch on the
 * automations parent in the same migration). Same dual-axis contract-test
 * blindspot as the sibling suites: this functional test through the REAL
 * postgres.js driver (breeze_app role) is the guard that a partner cannot
 * forge a partner_id for another partner.
 *
 * The second describe block proves the event-trigger fan-out (#1724 trap): a
 * stored partner-wide automation must actually MATCH a device event raised in
 * a member org — queueEventTriggers previously filtered by
 * eq(automations.orgId, event.orgId), which silently matched ZERO rows for
 * org_id NULL. Unit tests mock the query away, so this is the only place the
 * real query shape is proven against Postgres (the BullMQ queue is mocked).
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const { queueAddMock } = vi.hoisted(() => ({ queueAddMock: vi.fn() }));

// queueEventTriggers hits real Postgres for its candidate query, but its
// dispatch side is BullMQ. Mock the queue (and the connection factory it is
// constructed from) so no Redis is needed; assertions run against add() calls.
vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAddMock;
    getJob = async () => null;
    getRepeatableJobs = async () => [];
    removeRepeatableByKey = async () => undefined;
    close = async () => undefined;
  },
  Worker: class {
    on() { /* noop */ }
    close = async () => undefined;
  },
}));
vi.mock('../../services/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/redis')>();
  return {
    ...actual,
    getBullMQConnection: () => ({}) as never,
    isRedisAvailable: () => true,
  };
});

// publishEvent writes to a Redis stream — mock it (no Redis in this
// environment) and use the captured calls to assert the per-device-org
// lifecycle fan-out for partner-wide runs.
const { publishEventMock } = vi.hoisted(() => ({ publishEventMock: vi.fn() }));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return {
    ...actual,
    publishEvent: publishEventMock,
    getEventBus: () => ({ subscribe: () => () => undefined }) as never,
  };
});

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { alertRules, alerts, alertTemplates, automationRuns, automations, devices, sites } from '../../db/schema';
import { queueEventTriggers } from '../../jobs/automationWorker';
import { createAutomationRunRecord, executeAutomationRun } from '../../services/automationRuntime';
import { resolvePolicyRemediationAutomationIdForOrg } from '../../services/policyEvaluationService';
import type { BreezeEvent } from '../../services/eventBus';
import { createOrganization, createPartner } from './db-utils';

const createdAutomations: string[] = [];
const createdDevices: string[] = [];
const createdSites: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

beforeEach(() => {
  queueAddMock.mockReset().mockResolvedValue({ id: 'job-1' });
  publishEventMock.mockReset().mockResolvedValue('evt-mock');
});

afterEach(async () => {
  if (createdAutomations.length === 0 && createdDevices.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdAutomations.length > 0) {
      await db
        .delete(automationRuns)
        .where(inArray(automationRuns.automationId, createdAutomations));
    }
    for (const id of createdAutomations) {
      await db.delete(automations).where(eq(automations.id, id));
    }
    if (createdDevices.length > 0) {
      // Alert rows (created by the execution-attribution tests) hold a device
      // FK — remove them before their devices.
      await db.delete(alerts).where(inArray(alerts.deviceId, createdDevices));
    }
    for (const id of createdDevices) {
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdSites) {
      await db.delete(sites).where(eq(sites.id, id));
    }
  });
  createdAutomations.length = 0;
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

const BASE_AUTOMATION = {
  name: 'Partner-wide offline diagnostic',
  trigger: { type: 'event', eventType: 'device.offline' },
  actions: [{ type: 'create_alert', alertSeverity: 'medium', alertMessage: 'Device went offline' }],
  enabled: true,
};

async function seedPartnerAutomation(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(automations)
      .values({ ...BASE_AUTOMATION, orgId: null, partnerId })
      .returning(),
  );
  const id = rows[0]!.id;
  createdAutomations.push(id);
  return id;
}

describe('automations RLS — dual-axis (2026-07-02 migration)', () => {
  it('partner scope can INSERT a partner-wide automation (org_id NULL, partner_id set)', async () => {
    const partner = await createPartner();

    const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(automations)
        .values({ ...BASE_AUTOMATION, orgId: null, partnerId: partner.id })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBeNull();
    expect(rows[0]?.partnerId).toBe(partner.id);
    if (rows[0]) createdAutomations.push(rows[0].id);
  });

  it('a different partner can neither see nor forge an automation attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerAutomation(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: automations.id }).from(automations).where(eq(automations.id, id)),
    );
    expect(visibleToB).toEqual([]);

    // WITH CHECK denies the cross-partner forge (Postgres 42501 on the cause).
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(automations)
          .values({ ...BASE_AUTOMATION, name: 'Forged partner-wide', orgId: null, partnerId: partnerA.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scope caller cannot see a partner-wide automation owned by its partner (the worker still fires it for the org, see fan-out below)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await seedPartnerAutomation(partner.id);

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: automations.id }).from(automations).where(eq(automations.id, id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('org scope can still INSERT and SELECT an org-scoped automation (unchanged shape)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const inserted = await withDbAccessContext(orgContext(org.id), () =>
      db
        .insert(automations)
        .values({ ...BASE_AUTOMATION, name: 'Org automation', orgId: org.id, partnerId: null })
        .returning(),
    );
    if (inserted[0]) createdAutomations.push(inserted[0].id);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(org.id);

    const visible = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: automations.id })
        .from(automations)
        .where(eq(automations.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('the one-owner CHECK rejects an automation that sets BOTH axes and one that sets NEITHER', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(automations)
          .values({ ...BASE_AUTOMATION, name: 'Both axes', orgId: org.id, partnerId: partner.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(automations)
          .values({ ...BASE_AUTOMATION, name: 'No axis', orgId: null, partnerId: null })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('partner scope can UPDATE and DELETE its own partner-wide automation, and its runs are partner-visible via the parent join', async () => {
    const partner = await createPartner();
    const id = await seedPartnerAutomation(partner.id);

    const updated = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .update(automations)
        .set({ name: 'Renamed automation', enabled: false })
        .where(eq(automations.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.enabled).toBe(false);

    // A run of the partner-wide automation (inserted by the worker under
    // system context) is visible to the owning partner through the widened
    // automation_runs EXISTS policy — and invisible to another partner.
    const [run] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(automationRuns)
        .values({ automationId: id, triggeredBy: 'event:device.offline', status: 'running' })
        .returning(),
    );
    const partnerVisibleRuns = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.id, run!.id)),
    );
    expect(partnerVisibleRuns.map((r) => r.id)).toEqual([run!.id]);

    const otherPartner = await createPartner();
    const otherVisibleRuns = await withDbAccessContext(partnerContext(otherPartner.id, []), () =>
      db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.id, run!.id)),
    );
    expect(otherVisibleRuns).toEqual([]);

    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(automationRuns).where(eq(automationRuns.id, run!.id)),
    );

    const deleted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.delete(automations).where(eq(automations.id, id)).returning(),
    );
    expect(deleted).toHaveLength(1);
    createdAutomations.splice(createdAutomations.indexOf(id), 1);
  });
});

// ============================================================
// Event-trigger fan-out (#2133): the load-bearing SQL that makes a stored
// partner-wide automation actually FIRE. queueEventTriggers previously
// filtered by eq(automations.orgId, event.orgId), which silently matched ZERO
// rows for org_id NULL — the #1724 trap. The worker runs this under a system
// DB context (RLS bypass); mirror that here.
// ============================================================

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

describe('queueEventTriggers — partner-wide event fan-out (#2133)', () => {
  function offlineEvent(orgId: string, deviceId: string, eventId: string): BreezeEvent<Record<string, unknown>> {
    return {
      id: eventId,
      type: 'device.offline',
      orgId,
      source: 'integration-test',
      priority: 'normal',
      payload: { deviceId },
      metadata: { timestamp: new Date().toISOString() },
    } as BreezeEvent<Record<string, unknown>>;
  }

  function queuedAutomationIds(): string[] {
    return queueAddMock.mock.calls
      .filter(([name]) => name === 'trigger-event')
      .map(([, data]) => (data as { automationId: string }).automationId);
  }

  it('a device event in a member org matches the partner-wide automation (and an org-owned one); another partner never matches', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA1 = await createOrganization({ partnerId: partnerA.id });
    const orgA2 = await createOrganization({ partnerId: partnerA.id });
    const orgB1 = await createOrganization({ partnerId: partnerB.id });

    const deviceA1 = await seedDevice(orgA1.id, 'fanout-a1');
    const deviceB1 = await seedDevice(orgB1.id, 'fanout-b1');

    const partnerWideId = await seedPartnerAutomation(partnerA.id);

    // Org-owned automation in the SAME member org — must keep matching.
    const [orgOwned] = await withDbAccessContext(orgContext(orgA1.id), () =>
      db
        .insert(automations)
        .values({ ...BASE_AUTOMATION, name: 'Org-owned offline', orgId: orgA1.id, partnerId: null })
        .returning(),
    );
    createdAutomations.push(orgOwned!.id);

    // Event raised in member org A1 (the worker's system context).
    await withDbAccessContext(SYSTEM_CTX, () =>
      queueEventTriggers(offlineEvent(orgA1.id, deviceA1, 'evt-a1')),
    );
    expect(queuedAutomationIds()).toEqual(
      expect.arrayContaining([partnerWideId, orgOwned!.id]),
    );

    // Event in a SECOND member org still matches the partner-wide automation
    // (but not org A1's own automation).
    queueAddMock.mockClear();
    await withDbAccessContext(SYSTEM_CTX, () =>
      queueEventTriggers(offlineEvent(orgA2.id, deviceA1, 'evt-a2')),
    );
    expect(queuedAutomationIds()).toContain(partnerWideId);
    expect(queuedAutomationIds()).not.toContain(orgOwned!.id);

    // Event in ANOTHER PARTNER's org never matches partner A's automations.
    queueAddMock.mockClear();
    await withDbAccessContext(SYSTEM_CTX, () =>
      queueEventTriggers(offlineEvent(orgB1.id, deviceB1, 'evt-b1')),
    );
    expect(queuedAutomationIds()).not.toContain(partnerWideId);
    expect(queuedAutomationIds()).not.toContain(orgOwned!.id);
  });

  it('a disabled partner-wide automation does not match', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const device = await seedDevice(org.id, 'fanout-disabled');

    const id = await seedPartnerAutomation(partner.id);
    await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.update(automations).set({ enabled: false }).where(eq(automations.id, id)),
    );

    await withDbAccessContext(SYSTEM_CTX, () =>
      queueEventTriggers(offlineEvent(org.id, device, 'evt-disabled')),
    );
    expect(queuedAutomationIds()).not.toContain(id);
  });
});

// ============================================================
// Execution attribution (#2133, playbook rule 5): worker-created child rows
// take the DEVICE's org, never the automation owner's. A partner-wide
// automation has NO org of its own — a regression back to automation.orgId
// would insert alerts with org_id NULL (RLS/NOT NULL failure) or, worse,
// attribute them to the wrong tenant. Lifecycle events must publish once per
// distinct target-device org (publishEvent is mocked; Postgres is real).
// ============================================================

describe('executeAutomationRun — partner-wide child-row org attribution (#2133)', () => {
  it('create_alert lands one alert per device carrying that DEVICE\'s org; lifecycle events publish per distinct device org', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const deviceA = await seedDevice(orgA.id, 'attr-a');
    const deviceB = await seedDevice(orgB.id, 'attr-b');

    const [automation] = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(automations)
        .values({
          name: 'Partner-wide alerting automation',
          orgId: null,
          partnerId: partner.id,
          trigger: { type: 'manual' },
          actions: [{ type: 'create_alert', alertSeverity: 'high', alertMessage: 'Cross-org alert' }],
          enabled: true,
        })
        .returning(),
    );
    createdAutomations.push(automation!.id);

    // The worker executes under system context — mirror that.
    const { run, targetDeviceIds } = await withDbAccessContext(SYSTEM_CTX, () =>
      createAutomationRunRecord({ automation: automation!, triggeredBy: 'manual:test' }),
    );
    expect(targetDeviceIds.sort()).toEqual([deviceA, deviceB].sort());

    const result = await withDbAccessContext(SYSTEM_CTX, () =>
      executeAutomationRun(run.id, targetDeviceIds),
    );
    expect(result.status).toBe('completed');
    expect(result.devicesSucceeded).toBe(2);

    // Each alert carries its own device's org — NOT the (NULL) automation org.
    const alertRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ deviceId: alerts.deviceId, orgId: alerts.orgId })
        .from(alerts)
        .where(inArray(alerts.deviceId, [deviceA, deviceB])),
    );
    expect(alertRows).toHaveLength(2);
    const orgByDevice = new Map(alertRows.map((row) => [row.deviceId, row.orgId]));
    expect(orgByDevice.get(deviceA)).toBe(orgA.id);
    expect(orgByDevice.get(deviceB)).toBe(orgB.id);

    // The backing rule/template are created in each DEVICE org.
    const ruleRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ orgId: alertRules.orgId })
        .from(alertRules)
        .where(inArray(alertRules.orgId, [orgA.id, orgB.id])),
    );
    expect(ruleRows.map((r) => r.orgId).sort()).toEqual([orgA.id, orgB.id].sort());
    const templateRows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select({ orgId: alertTemplates.orgId })
        .from(alertTemplates)
        .where(inArray(alertTemplates.orgId, [orgA.id, orgB.id])),
    );
    expect(templateRows).toHaveLength(2);

    // Lifecycle events fan out per distinct device org.
    const startedOrgs = publishEventMock.mock.calls
      .filter(([type]) => type === 'automation.started')
      .map(([, orgId]) => orgId);
    expect(startedOrgs.sort()).toEqual([orgA.id, orgB.id].sort());
    const completedOrgs = publishEventMock.mock.calls
      .filter(([type]) => type === 'automation.completed')
      .map(([, orgId]) => orgId);
    expect(completedOrgs.sort()).toEqual([orgA.id, orgB.id].sort());
    // alert.triggered also carries each DEVICE's org.
    const alertEventOrgs = publishEventMock.mock.calls
      .filter(([type]) => type === 'alert.triggered')
      .map(([, orgId]) => orgId);
    expect(alertEventOrgs.sort()).toEqual([orgA.id, orgB.id].sort());
  });
});

// ============================================================
// Remediation resolution (#2133): a partner-wide automation whose actions
// reference a policy's remediationScriptId must be found when remediation is
// anchored to a member-org device — resolvePolicyRemediationAutomationIdForOrg
// previously filtered by eq(automations.orgId, orgId), silently never matching
// org_id NULL rows.
// ============================================================

describe('resolvePolicyRemediationAutomationIdForOrg — partner-wide matching (#2133)', () => {
  const SCRIPT_ID = '00000000-0000-4000-8000-00000000cafe';

  function policyWithRemediationScript() {
    // Only .rules and .remediationScriptId are read by the resolver.
    return { rules: [], remediationScriptId: SCRIPT_ID } as never;
  }

  it('matches a partner-wide automation for a member org, and never for another partner\'s org', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA1 = await createOrganization({ partnerId: partnerA.id });
    const orgB1 = await createOrganization({ partnerId: partnerB.id });

    const [automation] = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db
        .insert(automations)
        .values({
          name: 'Partner-wide remediation automation',
          orgId: null,
          partnerId: partnerA.id,
          trigger: { type: 'manual' },
          actions: [{ type: 'run_script', scriptId: SCRIPT_ID }],
          enabled: true,
        })
        .returning(),
    );
    createdAutomations.push(automation!.id);

    // Anchored to a member org of the owning partner → found.
    const resolvedForMember = await withDbAccessContext(SYSTEM_CTX, () =>
      resolvePolicyRemediationAutomationIdForOrg(policyWithRemediationScript(), orgA1.id),
    );
    expect(resolvedForMember).toBe(automation!.id);

    // Anchored to another partner's org → never matches.
    const resolvedForStranger = await withDbAccessContext(SYSTEM_CTX, () =>
      resolvePolicyRemediationAutomationIdForOrg(policyWithRemediationScript(), orgB1.id),
    );
    expect(resolvedForStranger).toBeNull();
  });
});
