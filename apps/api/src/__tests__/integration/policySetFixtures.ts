/**
 * Real-Postgres fixture world for the W03 policy-set suites (#8142). Not a
 * test file. Every helper seeds in SYSTEM scope; the suites then read in
 * system scope (legacy) and in the heartbeat's org-scoped context.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyEventLogSettings,
  configPolicyFeatureLinks,
  configPolicyHardwareMonitoringSettings,
  configPolicyMonitoringSettings,
  configPolicyMonitors,
  configPolicyOnedriveLibraries,
  configPolicyOnedriveSettings,
  configPolicyPatchSettings,
  configPolicyTimeSyncSettings,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  monitorDefinitions,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

export const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
export const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

/** Exactly the heartbeat's org-scoped dbContext (heartbeat.ts `dbContext`). */
export function orgCtxFor(orgId: string, partnerId: string | null): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null,
    currentPartnerId: partnerId,
  };
}
export const inOrg = <T>(orgId: string, partnerId: string | null, fn: () => Promise<T>) =>
  withDbAccessContext(orgCtxFor(orgId, partnerId), fn);

export type Level = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

export async function seedDevice(orgId: string, siteId: string, label: string, osType = 'windows'): Promise<string> {
  return sys(async () => {
    const unique = randomUUID().slice(0, 8);
    await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
    const [device] = await db.insert(devices).values({
      orgId, siteId, agentId: `ps-${label}-${unique}`, hostname: `ps-${label}-${unique}`,
      osType, osVersion: '11', architecture: 'amd64', agentVersion: '0.0.0-test',
      status: 'online', deviceRole: 'workstation',
    } as never).returning();
    return device!.id;
  });
}

export type SeedLink =
  | { featureType: 'helper' | 'pam' | 'warranty'; inlineSettings: Record<string, unknown> }
  | { featureType: 'event_log'; maxEventsPerCycle?: number; withoutSettings?: true }
  | { featureType: 'hardware_monitoring'; pollIntervalMinutes: number }
  | { featureType: 'patch'; exclusiveWindowsUpdate: boolean }
  | { featureType: 'time_sync'; ntpServers: string[] }
  | { featureType: 'monitors'; serviceName?: string; checkIntervalSeconds?: number; inheritance?: 'cumulative' | 'replace' }
  | { featureType: 'onedrive_helper'; orgId: string; filesOnDemand: boolean; libraryName: string; graphGroupId?: string };

export interface SeedAssignment {
  /** Explicit assignment id (default: generated). Lets a test force the id tie-break. */
  id?: string;
  level: Level;
  targetId: string;
  priority?: number;
  roleFilter?: string[];
  osFilter?: string[];
  createdAt?: Date;
}

export async function seedPolicy(input: {
  owner: { orgId: string | null; partnerId: string | null };
  name?: string;
  status?: 'active' | 'inactive';
  parentPolicyId?: string;
  links?: SeedLink[];
  assignments?: SeedAssignment[];
  /**
   * Insert the assignments as the superuser AFTER the policy has committed,
   * with `session_replication_role = replica`. Replica mode turns off ALL
   * triggers on the insert — the config_policy_assignments integrity trigger
   * (which rightly refuses a target outside the policy owner's tenant), the
   * FK/RI triggers, and the partner-export AFTER INSERT trigger — not just
   * the integrity one. The cross-tenant forge tests need exactly such rows to
   * prove RLS ALONE hides them.
   */
  forgeAssignments?: boolean;
}): Promise<string> {
  const policyId = await sys(async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: input.owner.orgId, partnerId: input.owner.partnerId,
      name: input.name ?? `ps ${randomUUID()}`, status: input.status ?? 'active',
      ...(input.parentPolicyId ? { parentPolicyId: input.parentPolicyId } : {}),
    } as never).returning();
    for (const l of input.links ?? []) {
      const inline = l.featureType === 'helper' || l.featureType === 'pam' || l.featureType === 'warranty'
        ? l.inlineSettings
        : l.featureType === 'monitors' && l.inheritance ? { inheritance: l.inheritance } : undefined;
      const [link] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id, featureType: l.featureType as never,
        ...(inline ? { inlineSettings: inline } : {}),
      }).returning();
      const linkId = link!.id;
      if (l.featureType === 'event_log' && !l.withoutSettings) {
        await db.insert(configPolicyEventLogSettings).values({ featureLinkId: linkId, retentionDays: 30, maxEventsPerCycle: l.maxEventsPerCycle ?? 100 });
      }
      if (l.featureType === 'hardware_monitoring') {
        await db.insert(configPolicyHardwareMonitoringSettings).values({ featureLinkId: linkId, enabled: true, pollIntervalMinutes: l.pollIntervalMinutes, diskHealthIntervalMinutes: 60 });
      }
      if (l.featureType === 'patch') {
        await db.insert(configPolicyPatchSettings).values({ featureLinkId: linkId, exclusiveWindowsUpdate: l.exclusiveWindowsUpdate } as never);
      }
      if (l.featureType === 'time_sync') {
        await db.insert(configPolicyTimeSyncSettings).values({ featureLinkId: linkId, enforceNtp: true, ntpServers: l.ntpServers, pollIntervalMinutes: 30 } as never);
      }
      if (l.featureType === 'monitors') {
        if (l.serviceName) {
          const [monitor] = await db.insert(monitorDefinitions).values({
            orgId: input.owner.orgId, partnerId: input.owner.partnerId, name: `ps-mon-${randomUUID()}`, kind: 'service',
            condition: { serviceName: l.serviceName, consecutiveFailures: 2 }, severity: 'high',
          } as never).returning({ id: monitorDefinitions.id });
          await db.insert(configPolicyMonitors).values({ featureLinkId: linkId, monitorId: monitor!.id, enabled: true });
        }
        if (l.checkIntervalSeconds !== undefined) {
          await db.insert(configPolicyMonitoringSettings).values({ featureLinkId: linkId, checkIntervalSeconds: l.checkIntervalSeconds });
        }
      }
      if (l.featureType === 'onedrive_helper') {
        const [settings] = await db.insert(configPolicyOnedriveSettings).values({
          featureLinkId: linkId, orgId: l.orgId, filesOnDemand: l.filesOnDemand,
        } as never).returning();
        await db.insert(configPolicyOnedriveLibraries).values({
          settingsId: settings!.id, orgId: l.orgId, libraryId: `lib-${randomUUID()}`, displayName: l.libraryName,
          ...(l.graphGroupId
            ? { targetingMode: 'graph_group', groupId: l.graphGroupId, groupName: 'Parity group' }
            : { targetingMode: 'everyone' }),
          sortOrder: 0, enabled: true,
        } as never);
      }
    }
    if (input.forgeAssignments) return policy!.id;
    for (const a of input.assignments ?? []) {
      await db.insert(configPolicyAssignments).values({
        ...(a.id ? { id: a.id } : {}), configPolicyId: policy!.id, level: a.level, targetId: a.targetId, priority: a.priority ?? 0,
        ...(a.roleFilter ? { roleFilter: a.roleFilter } : {}),
        ...(a.osFilter ? { osFilter: a.osFilter } : {}),
        ...(a.createdAt ? { createdAt: a.createdAt } : {}),
      });
    }
    return policy!.id;
  });
  if (input.forgeAssignments) {
    // Policy is committed and sys() has released its connection: only the
    // admin connection is held here.
    const admin = getTestDb();
    await admin.transaction(async (tx: any) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      for (const a of input.assignments ?? []) {
        await tx.insert(configPolicyAssignments).values({
          ...(a.id ? { id: a.id } : {}), configPolicyId: policyId, level: a.level, targetId: a.targetId, priority: a.priority ?? 0,
          ...(a.roleFilter ? { roleFilter: a.roleFilter } : {}),
          ...(a.osFilter ? { osFilter: a.osFilter } : {}),
          ...(a.createdAt ? { createdAt: a.createdAt } : {}),
        });
      }
    });
  }
  return policyId;
}

export async function dropDeviceRedisCaches(deviceId: string): Promise<void> {
  const redis = getTestRedis();
  const keys = await redis.keys(`*${deviceId}*`);
  if (keys.length > 0) await redis.del(...keys);
}

export interface ParityWorld {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  siblingId: string;
  groupIds: [string, string];
  otherOrgId: string;
  foreignPartnerId: string;
  foreignOrgId: string;
  forgedPolicyIds: string[];
}

/**
 * Every heartbeat feature resolves to a NON-default answer for `deviceId`, and
 * each answer is decided by a rule the selectors must mirror:
 *  - helper: org policy at group g2 beats a partner-wide policy at partner level;
 *  - warranty: two group-level policies, the HIGHER priority number wins;
 *  - event_log: partner-wide at partner level (role-filtered to workstation)
 *    wins; an org site-level policy filtered to printer is excluded; a
 *    device-level link with NO settings row is excluded (presence sentinel);
 *  - hardware_monitoring: partner-wide at partner level (Task 1's RLS branch);
 *  - pam: partner-wide at partner level;
 *  - patch: partner-wide at partner level (true) beats nothing — an org policy
 *    filtered to linux is excluded;
 *  - time_sync: an org child policy assigned at DEVICE level inherits its
 *    time_sync link from an INACTIVE partner-wide parent (view inheritance;
 *    parent status ignored), beating a partner-wide partner-level policy;
 *  - monitors / check interval: partner-wide at partner level (attachment +
 *    120 s) plus an org site-level REPLACE link with no attachments and no
 *    interval (empty replace link);
 *  - onedrive: org policy at site level.
 * Negatives that must never reach `deviceId`: a sibling's device-level helper;
 * forged rows — another org's policy (same partner) and another partner's
 * org policy, each assigned at level 'device' to `deviceId`, and another
 * partner's partner-wide policy assigned at level 'partner' to OUR partner.
 */
export async function seedParityWorld(): Promise<ParityWorld> {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const otherOrg = (await createOrganization({ partnerId: partner.id }))!;
  const foreignPartner = (await createPartner())!;
  const foreignOrg = (await createOrganization({ partnerId: foreignPartner.id }))!;
  const deviceId = await seedDevice(org.id, site.id, 'agent');
  const siblingId = await seedDevice(org.id, site.id, 'sibling');
  const groupIds = await sys(async () => {
    const ids: string[] = [];
    for (const name of ['g1', 'g2']) {
      const [group] = await db.insert(deviceGroups).values({ orgId: org.id, name: `ps ${name} ${randomUUID().slice(0, 8)}` }).returning();
      await db.insert(deviceGroupMemberships).values({ deviceId, groupId: group!.id, orgId: org.id });
      ids.push(group!.id);
    }
    return ids as [string, string];
  });
  const P = { orgId: null, partnerId: partner.id };
  const O = { orgId: org.id, partnerId: null };

  await seedPolicy({ owner: O, links: [{ featureType: 'helper', inlineSettings: { enabled: true, showTrayIcon: false } }],
    assignments: [{ level: 'device_group', targetId: groupIds[1] }] });
  await seedPolicy({ owner: P, links: [{ featureType: 'helper', inlineSettings: { enabled: false } }],
    assignments: [{ level: 'partner', targetId: partner.id }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://sibling.example' } }],
    assignments: [{ level: 'device', targetId: siblingId }] });

  await seedPolicy({ owner: O, links: [{ featureType: 'warranty', inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 } }],
    assignments: [{ level: 'device_group', targetId: groupIds[0], priority: 1 }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'warranty', inlineSettings: {
      enabled: true, warnDays: 45, criticalDays: 10,
      hpCmsl: { enabled: true, consent: { acceptedByUserId: 'parity-user', acceptedAt: '2026-09-10T00:00:00.000Z', eulaId: HP_CMSL_EULA_ID } },
    } }],
    assignments: [{ level: 'device_group', targetId: groupIds[0], priority: 5 }] });

  await seedPolicy({ owner: P, links: [{ featureType: 'event_log', maxEventsPerCycle: 321 }],
    assignments: [{ level: 'partner', targetId: partner.id, roleFilter: ['workstation'] }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'event_log', maxEventsPerCycle: 555 }],
    assignments: [{ level: 'site', targetId: site.id, roleFilter: ['printer'] }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'event_log', withoutSettings: true }],
    assignments: [{ level: 'device', targetId: deviceId }] });

  await seedPolicy({ owner: P, links: [{ featureType: 'hardware_monitoring', pollIntervalMinutes: 7 }],
    assignments: [{ level: 'partner', targetId: partner.id }] });
  await seedPolicy({ owner: P, links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } }],
    assignments: [{ level: 'partner', targetId: partner.id }] });

  await seedPolicy({ owner: P, links: [{ featureType: 'patch', exclusiveWindowsUpdate: true }],
    assignments: [{ level: 'partner', targetId: partner.id }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'patch', exclusiveWindowsUpdate: false }],
    assignments: [{ level: 'organization', targetId: org.id, osFilter: ['linux'] }] });

  const timeParent = await seedPolicy({ owner: P, status: 'inactive', links: [{ featureType: 'time_sync', ntpServers: ['time.parent.example'] }] });
  await seedPolicy({ owner: O, parentPolicyId: timeParent, assignments: [{ level: 'device', targetId: deviceId }] });
  await seedPolicy({ owner: P, links: [{ featureType: 'time_sync', ntpServers: ['time.partner.example'] }],
    assignments: [{ level: 'partner', targetId: partner.id }] });

  await seedPolicy({ owner: P, links: [{ featureType: 'monitors', serviceName: 'ParityService', checkIntervalSeconds: 120 }],
    assignments: [{ level: 'partner', targetId: partner.id }] });
  await seedPolicy({ owner: O, links: [{ featureType: 'monitors', inheritance: 'replace' }],
    assignments: [{ level: 'site', targetId: site.id }] });
  // Servers only; the device is a workstation. Monitors filter role/OS ONLY
  // through MONITOR_APPLICABILITY on the set path (no second ranking check),
  // so a dropped rule surfaces this service on every path but legacy.
  await seedPolicy({ owner: O, links: [{ featureType: 'monitors', serviceName: 'ServerOnlySvc' }],
    assignments: [{ level: 'device', targetId: deviceId, roleFilter: ['server'] }] });

  await seedPolicy({ owner: O, links: [{ featureType: 'onedrive_helper', orgId: org.id, filesOnDemand: false, libraryName: 'Parity Docs' }],
    assignments: [{ level: 'site', targetId: site.id }] });

  // Forged rows (cross-tenant). Inserted in system scope; RLS must hide every
  // one of them from the device's org-scoped context.
  const forgedPolicyIds = [
    await seedPolicy({ owner: { orgId: otherOrg.id, partnerId: null }, links: [{ featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://cross-org.example' } }],
      assignments: [{ level: 'device', targetId: deviceId }], forgeAssignments: true }),
    await seedPolicy({ owner: { orgId: foreignOrg.id, partnerId: null }, links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: false } }],
      assignments: [{ level: 'device', targetId: deviceId, priority: -10 }], forgeAssignments: true }),
    await seedPolicy({ owner: { orgId: null, partnerId: foreignPartner.id }, links: [{ featureType: 'event_log', maxEventsPerCycle: 999 }],
      assignments: [{ level: 'partner', targetId: partner.id, priority: -10 }], forgeAssignments: true }),
  ];

  return {
    partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId, siblingId, groupIds,
    otherOrgId: otherOrg.id, foreignPartnerId: foreignPartner.id, foreignOrgId: foreignOrg.id, forgedPolicyIds,
  };
}
