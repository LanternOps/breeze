/**
 * Strix (PR #12184): a compliance rule the per-org probe cap leaves uncollected
 * is `pending`: no violation, no alert, no remediation (#12130). The org's own
 * policies can fill their reserved half of the cap and so decide which
 * partner-wide rules go uncollected; that must be loud to the partner.
 *
 * Real Postgres + RLS, the real evaluate-policy job and the real event bus with
 * the real `policy-not-assessed-notice` handler: a partner-wide rule pushed off
 * the probe list reaches the partner's full-access staff as one in-app notice,
 * not the org's users, and a second evaluation does not notify again.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { automationPolicies, automationPolicyCompliance, devices, userNotifications } from '../../db/schema';
import { __processEvaluatePolicy } from '../../jobs/policyEvaluationWorker';
import { handlePolicyNotAssessedEvent } from '../../services/policyNotAssessedNotice';
import {
  _resetEventSubscriberRegistryForTests,
  registerEventSubscriber,
} from '../../services/eventSubscriberRegistry';
import { MAX_POLICY_STATE_PROBES_PER_ORG } from '../../services/policyStateProbes';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DEVICES_WRITE = { resource: 'devices', action: 'write' };
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

beforeAll(() => {
  _resetEventSubscriberRegistryForTests();
  registerEventSubscriber({
    id: 'policy-not-assessed-notice',
    eventTypes: ['policy.not_assessed'],
    handler: handlePolicyNotAssessedEvent,
  });
});

afterAll(() => {
  _resetEventSubscriberRegistryForTests();
});

const registryRule = (prefix: string, n: number) => ({
  type: 'registry_check',
  registryPath: `HKLM\\SOFTWARE\\Policies\\${prefix}\\Key${String(n).padStart(4, '0')}`,
  registryValueName: 'Enabled',
  registryExpectedValue: '1',
});
const rules = (prefix: string, count: number) => Array.from({ length: count }, (_, n) => registryRule(prefix, n));

let emailSeq = 0;
const email = () => `not-assessed-${Date.now()}-${(emailSeq += 1)}@example.com`;

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });

  // Partner staff with devices:write: full org access (the partner-wide owner)
  // and selected access (not an owner of partner-wide rules).
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id, name: `writers ${randomUUID().slice(0, 8)}` });
  await grantRolePermissions(partnerRole.id, [DEVICES_WRITE]);
  const partnerAll = (await createUser({ partnerId: partner.id, email: email() })).id;
  await assignUserToPartner(partnerAll, partner.id, partnerRole.id, 'all');
  const partnerSelected = (await createUser({ partnerId: partner.id, email: email() })).id;
  await assignUserToPartner(partnerSelected, partner.id, partnerRole.id, 'selected');
  // The org's own policy manager: the org authored what crowds the list, but
  // a partner-wide rule is not theirs to be told about.
  const orgRole = await createRole({ scope: 'organization', orgId: org!.id, name: `org writers ${randomUUID().slice(0, 8)}` });
  await grantRolePermissions(orgRole.id, [DEVICES_WRITE]);
  const orgUser = (await createUser({ partnerId: partner.id, orgId: org!.id, email: email() })).id;
  await assignUserToOrganization(orgUser, org!.id, orgRole.id);

  return asSystem(async () => {
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org!.id,
        siteId: site!.id,
        agentId: `na-agent-${randomUUID()}`,
        hostname: `na-host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '10.0.19045',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning();
    // The org's own policy fills its reserved half and more.
    await db.insert(automationPolicies).values({
      orgId: org!.id,
      name: `org crowding ${randomUUID()}`,
      enabled: true,
      targets: { deviceIds: [] },
      rules: rules('AAOrg', MAX_POLICY_STATE_PROBES_PER_ORG),
      enforcement: 'monitor',
      checkIntervalMinutes: 60,
    });
    // Partner-wide filler that sorts first, so only half of the partner's
    // probes fit and the evaluated policy's one rule (sorting last) is cut.
    await db.insert(automationPolicies).values({
      orgId: null,
      partnerId: partner.id,
      name: `partner filler ${randomUUID()}`,
      enabled: true,
      targets: { deviceIds: [] },
      rules: rules('BBPartner', MAX_POLICY_STATE_PROBES_PER_ORG),
      enforcement: 'monitor',
      checkIntervalMinutes: 60,
    });
    const [policy] = await db
      .insert(automationPolicies)
      .values({
        orgId: null,
        partnerId: partner.id,
        name: `partner firewall ${randomUUID().slice(0, 8)}`,
        enabled: true,
        targets: { deviceIds: [device!.id] },
        rules: [registryRule('ZZPartner', 0)],
        enforcement: 'enforce',
        checkIntervalMinutes: 60,
      })
      .returning();
    return { orgId: org!.id, deviceId: device!.id, policyId: policy!.id, partnerAll, partnerSelected, orgUser };
  });
}

describe('policy.not_assessed → partner notice (real DB)', () => {
  runDb('a partner-wide rule pushed off the probe list notifies the partner once, not the org', async () => {
    const s = await seed();

    const first = await __processEvaluatePolicy(s.policyId);
    expect(first).toMatchObject({ devicesEvaluated: 1 });

    const [row] = await asSystem(() => db
      .select({ status: automationPolicyCompliance.status, details: automationPolicyCompliance.details })
      .from(automationPolicyCompliance)
      .where(eq(automationPolicyCompliance.policyId, s.policyId)));
    expect(row?.status).toBe('pending');
    expect((row?.details as { ruleResults: Array<{ data?: { reason?: string } }> }).ruleResults[0]?.data?.reason).toBe('probe_cap');

    const notices = () => asSystem(() => db
      .select()
      .from(userNotifications)
      .where(inArray(userNotifications.userId, [s.partnerAll, s.partnerSelected, s.orgUser])));
    const afterFirst = await notices();
    expect(afterFirst.map((n) => n.userId)).toEqual([s.partnerAll]);
    expect(afterFirst[0]).toMatchObject({
      orgId: s.orgId,
      type: 'system',
      priority: 'high',
      link: `/policies/${s.policyId}`,
      read: false,
    });
    expect(afterFirst[0]!.message).toContain('probe list is full');

    // Every later scan publishes the event again; the owner is told once a week.
    await __processEvaluatePolicy(s.policyId);
    expect(await notices()).toHaveLength(1);
  });
});
