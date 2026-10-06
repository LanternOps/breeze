/**
 * Live-Postgres check that an RCA remediation source only accepts a
 * caller-supplied device when that device is on one of the correlation group's
 * alerts (root or member) and is still in the group's org. The unit suite
 * mocks the query builder, so only a real database proves the join.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { withSystemDbAccessContext } from '../../db';
import {
  alertCorrelationGroups,
  alertCorrelationMembers,
  alertRules,
  alertTemplates,
  alerts,
  devices,
} from '../../db/schema';
import { __testOnly, RemediationSourceDeviceError } from '../../services/remediationSuggestions';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedDevice(orgId: string, siteId: string, label: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `rca-device-${label}-${suffix}`,
      hostname: `rca-device-${label}-${suffix}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('failed to seed device');
  return device.id;
}

describe('RCA remediation source device binding', () => {
  runDb('accepts root/member alert devices and rejects any other device', async () => {
    {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org.id });
      const otherSite = await createSite({ orgId: otherOrg.id });

      const rootDevice = await seedDevice(org.id, site.id, 'root');
      const memberDevice = await seedDevice(org.id, site.id, 'member');
      const unrelatedDevice = await seedDevice(org.id, site.id, 'unrelated');
      const foreignDevice = await seedDevice(otherOrg.id, otherSite.id, 'foreign');

      const suffix = randomUUID().slice(0, 8);
      const [template] = await getTestDb()
        .insert(alertTemplates)
        .values({
          orgId: org.id,
          partnerId: null,
          name: `RCA device template ${suffix}`,
          conditions: { type: 'metric', metric: 'cpu', operator: 'gt', value: 90 },
          severity: 'high',
          titleTemplate: '{{ruleName}} on {{deviceName}}',
          messageTemplate: '{{ruleName}}',
        })
        .returning({ id: alertTemplates.id });
      const [rule] = await getTestDb()
        .insert(alertRules)
        .values({
          orgId: org.id,
          partnerId: null,
          templateId: template!.id,
          name: `RCA device rule ${suffix}`,
          targetType: 'organization',
          targetId: org.id,
          isActive: true,
        })
        .returning({ id: alertRules.id });

      const now = new Date();
      const [rootAlert, memberAlert, unrelatedAlert] = await getTestDb()
        .insert(alerts)
        .values([
          { ruleId: rule!.id, deviceId: rootDevice, orgId: org.id, severity: 'critical', title: 'root', triggeredAt: now, subjectKey: 'root' },
          { ruleId: rule!.id, deviceId: memberDevice, orgId: org.id, severity: 'critical', title: 'member', triggeredAt: now, subjectKey: 'member' },
          { ruleId: rule!.id, deviceId: unrelatedDevice, orgId: org.id, severity: 'critical', title: 'unrelated', triggeredAt: now, subjectKey: 'unrelated' },
        ])
        .returning({ id: alerts.id });

      const [group] = await getTestDb()
        .insert(alertCorrelationGroups)
        .values({
          orgId: org.id,
          groupKey: `rca-device-${suffix}`,
          rootAlertId: rootAlert!.id,
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .returning({ id: alertCorrelationGroups.id });
      await getTestDb().insert(alertCorrelationMembers).values({ orgId: org.id, groupId: group!.id, alertId: memberAlert!.id });
      // An alert that exists in the same org but is a member of no group.
      expect(unrelatedAlert).toBeTruthy();

      const resolve = (deviceId?: string) => withSystemDbAccessContext(() => __testOnly.resolveSourceContext({
        sourceType: 'rca', sourceId: group!.id, orgId: org.id, deviceId,
      }));

      expect(await resolve(rootDevice)).toMatchObject({ deviceId: rootDevice, correlationGroupId: group!.id });
      expect(await resolve(memberDevice)).toMatchObject({ deviceId: memberDevice });
      expect(await resolve(undefined)).toMatchObject({ deviceId: null });
      await expect(resolve(unrelatedDevice)).rejects.toBeInstanceOf(RemediationSourceDeviceError);
      await expect(resolve(foreignDevice)).rejects.toBeInstanceOf(RemediationSourceDeviceError);

      // A member device that has since moved to another org no longer matches.
      await getTestDb().update(devices).set({ orgId: otherOrg.id, siteId: otherSite.id }).where(eq(devices.id, memberDevice));
      await expect(resolve(memberDevice)).rejects.toBeInstanceOf(RemediationSourceDeviceError);
    }
  });
});
