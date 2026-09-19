/**
 * Regression (#6001): "backup_run payload has no paths".
 *
 * A reporter's six devices backed up fine when a tech clicked Run on each
 * device page, and every one of them failed at 0s on the nightly schedule with
 * the agent's last-resort guard `backup_run payload has no paths`
 * (agent/cmd/breeze-backup/exec_backup.go). Three defects stacked:
 *
 *  1. DIVERGENT RESOLVERS. The manual route resolves a device's backup policy
 *     with `resolveBackupConfigForDevice`, which filters candidate assignments
 *     by the device's role/OS (`buildRoleOsFilterConditions`). The scheduled
 *     sweep and run-all use `resolveAllBackupAssignedDevices`, which applied NO
 *     role/OS filter at all. Its candidate set was therefore a strict superset,
 *     and since both are first-wins-by-hierarchy, an assignment the manual path
 *     EXCLUDES could outrank — and silently replace — the one it picks. Two
 *     resolvers, two different winning `featureLinkId`s for the same device.
 *
 *  2. NO CHOKEPOINT. `resolveBackupTargets` emitted `{ paths: [] }`
 *     unconditionally for file mode, so a pathless winner produced a
 *     guaranteed-failing `backup_run` instead of a job failed server-side with
 *     a reason. The `targets.length === 0` net never fires: there IS one
 *     target, just a pathless one.
 *
 *  3. `targets`-ONLY DISPATCH. `config_policy_backup_settings` carries the file
 *     path list in BOTH `targets.paths` and the legacy top-level `paths`
 *     column; dispatch only ever read `targets`.
 *
 * These cases are integration (not unit) because the divergence is entirely in
 * two hand-written SQL candidate queries against real assignment rows — a
 * mocked drizzle chain returns whatever rows it is handed regardless of the
 * WHERE clause, which is exactly how the missing filter survived.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import {
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  partners,
  organizations,
  sites,
  devices,
  deviceGroups,
  deviceGroupMemberships,
} from '../../db/schema';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyBackupSettings,
  configPolicyAssignments,
} from '../../db/schema/configurationPolicies';
import { backupConfigs, backupJobs } from '../../db/schema/backup';
import {
  resolveBackupConfigForDevice,
  resolveAllBackupAssignedDevices,
} from '../../services/featureConfigResolver';
import { resolveBackupTargets, __testOnly } from '../../jobs/backupWorker';

const WINDOWS_PATH = 'C:\\Users';

let partnerId: string;
let orgId: string;
let siteId: string;
let deviceId: string;
let backupConfigId: string;
let orgContext: DbAccessContext;
let sfx: string;

/** Seed a policy + backup feature link + backup settings row. Returns the link id. */
async function seedBackupPolicy(opts: {
  name: string;
  /** Written to BOTH `targets` and the legacy `paths` column unless overridden. */
  paths?: string[];
  /** Override the legacy top-level `paths` column independently of `targets`. */
  legacyPaths?: string[];
  targets?: Record<string, unknown>;
  assignment: {
    level: 'organization' | 'site' | 'device_group' | 'device' | 'partner';
    targetId: string;
    roleFilter?: string[];
    osFilter?: string[];
    priority?: number;
  };
}): Promise<string> {
  const tdb = getTestDb();
  const [policy] = await tdb
    .insert(configurationPolicies)
    .values({ orgId, name: `${opts.name} ${sfx}` })
    .returning({ id: configurationPolicies.id });
  const [link] = await tdb
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policy!.id, featureType: 'backup' })
    .returning({ id: configPolicyFeatureLinks.id });

  await tdb.insert(configPolicyBackupSettings).values({
    featureLinkId: link!.id,
    orgId,
    schedule: { frequency: 'daily', time: '03:00' },
    retention: {},
    paths: opts.legacyPaths ?? opts.paths ?? [],
    backupMode: 'file',
    targets: opts.targets ?? (opts.paths ? { paths: opts.paths } : {}),
    destinationConfigId: backupConfigId,
  });

  await tdb.insert(configPolicyAssignments).values({
    configPolicyId: policy!.id,
    level: opts.assignment.level,
    targetId: opts.assignment.targetId,
    priority: opts.assignment.priority ?? 0,
    roleFilter: opts.assignment.roleFilter ?? null,
    osFilter: opts.assignment.osFilter ?? null,
  });

  return link!.id;
}

beforeEach(async () => {
  const tdb = getTestDb();
  sfx = `${Date.now()}-${Math.floor(performance.now())}`;

  const [p] = await tdb
    .insert(partners)
    .values({ name: 'BSRP', slug: `bsrp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  partnerId = p!.id;
  const [o] = await tdb
    .insert(organizations)
    .values({ currencyCode: 'USD', partnerId, name: 'BSRP Org', slug: `bsrp-org-${sfx}` })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [site] = await tdb.insert(sites).values({ orgId, name: 'HQ' }).returning({ id: sites.id });
  siteId = site!.id;

  // A plain Windows workstation — deliberately NOT a server, so a
  // roleFilter: ['server'] assignment must not govern it.
  const [device] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `bsrp-${sfx}`,
      hostname: `bsrp-${sfx}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      deviceRole: 'workstation',
    })
    .returning({ id: devices.id });
  deviceId = device!.id;

  const [cfg] = await tdb
    .insert(backupConfigs)
    .values({
      orgId,
      name: `BSRP Config ${sfx}`,
      type: 'file',
      provider: 'local',
      providerConfig: { path: '/tmp/bsrp' },
    })
    .returning({ id: backupConfigs.id });
  backupConfigId = cfg!.id;

  orgContext = {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: null,
    userId: null,
    currentPartnerId: partnerId,
  };
});

describe('#6001 backup resolver parity (manual vs scheduled sweep)', () => {
  it('both resolvers pick the same link for a parent-at-org / override-at-site shape', async () => {
    // The reporter's shape: a parent policy assigned org-wide whose Backup tab
    // has no paths, and a child override assigned at the site with C:\Users.
    await seedBackupPolicy({
      name: 'Parent (no paths)',
      assignment: { level: 'organization', targetId: orgId },
    });
    const overrideLinkId = await seedBackupPolicy({
      name: 'Site override',
      paths: [WINDOWS_PATH],
      assignment: { level: 'site', targetId: siteId },
    });

    const manual = await withDbAccessContext(orgContext, () =>
      resolveBackupConfigForDevice(deviceId)
    );
    const swept = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(orgId));

    // Control: with no role/OS filters in play the two already agreed. If this
    // case ever goes red, the divergence is somewhere other than the filter.
    expect(manual?.featureLinkId).toBe(overrideLinkId);
    expect(swept.find((e) => e.deviceId === deviceId)?.featureLinkId).toBe(overrideLinkId);
  });

  it('the sweep honours role/OS targeting, so a filtered-out assignment cannot outrank the one the manual run picks', async () => {
    // THE DIVERGENCE. A site-level assignment (higher precedence than org)
    // that targets SERVERS only, with an empty Backup tab — the manual path
    // excludes it via buildRoleOsFilterConditions; the sweep did not, so the
    // sweep's winner was this pathless link while the tech's manual run used
    // the org-level policy that actually has C:\Users.
    await seedBackupPolicy({
      name: 'Servers only (no paths)',
      assignment: { level: 'site', targetId: siteId, roleFilter: ['server'] },
    });
    const orgLinkId = await seedBackupPolicy({
      name: 'Org wide (C:\\Users)',
      paths: [WINDOWS_PATH],
      assignment: { level: 'organization', targetId: orgId },
    });

    const manual = await withDbAccessContext(orgContext, () =>
      resolveBackupConfigForDevice(deviceId)
    );
    const swept = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(orgId));
    const entry = swept.find((e) => e.deviceId === deviceId);

    expect(manual?.featureLinkId).toBe(orgLinkId);
    // RED before the fix: the sweep returned the servers-only link.
    expect(entry?.featureLinkId).toBe(orgLinkId);
    expect(entry?.featureLinkId).toBe(manual?.featureLinkId);
    expect((entry?.settings?.targets as { paths?: string[] })?.paths).toEqual([WINDOWS_PATH]);
  });

  it('the sweep honours osFilter the same way', async () => {
    await seedBackupPolicy({
      name: 'macOS only (no paths)',
      assignment: { level: 'site', targetId: siteId, osFilter: ['macos'] },
    });
    const orgLinkId = await seedBackupPolicy({
      name: 'Org wide (C:\\Users)',
      paths: [WINDOWS_PATH],
      assignment: { level: 'organization', targetId: orgId },
    });

    const manual = await withDbAccessContext(orgContext, () =>
      resolveBackupConfigForDevice(deviceId)
    );
    const swept = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(orgId));

    expect(manual?.featureLinkId).toBe(orgLinkId);
    expect(swept.find((e) => e.deviceId === deviceId)?.featureLinkId).toBe(orgLinkId);
  });

  it('the sweep honours role targeting on a DEVICE_GROUP assignment', async () => {
    // Each level is its own expansion branch, and each had to grow the
    // role/os select independently — so each needs its own proof. A
    // group-level assignment outranks org, so a mis-wired branch here
    // reproduces the reported failure on any device in a group.
    const [group] = await getTestDb()
      .insert(deviceGroups)
      .values({ orgId, siteId, name: `Servers ${sfx}` })
      .returning({ id: deviceGroups.id });
    await getTestDb()
      .insert(deviceGroupMemberships)
      .values({ deviceId, groupId: group!.id, orgId });

    await seedBackupPolicy({
      name: 'Group, servers only (no paths)',
      assignment: { level: 'device_group', targetId: group!.id, roleFilter: ['server'] },
    });
    const orgLinkId = await seedBackupPolicy({
      name: 'Org wide (C:\\Users)',
      paths: [WINDOWS_PATH],
      assignment: { level: 'organization', targetId: orgId },
    });

    const manual = await withDbAccessContext(orgContext, () =>
      resolveBackupConfigForDevice(deviceId)
    );
    const swept = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(orgId));

    expect(manual?.featureLinkId).toBe(orgLinkId);
    expect(swept.find((e) => e.deviceId === deviceId)?.featureLinkId).toBe(orgLinkId);
  });

  it('the sweep honours role targeting on a PARTNER assignment', async () => {
    // The partner branch joins through `organizations`, so its role/os select
    // is the one most likely to alias the wrong table. Partner is the LOWEST
    // precedence level, so a higher-level fallback would mask a mis-wired
    // filter entirely — this case therefore makes the filtered partner
    // assignment the ONLY one, and asserts the device is governed by NOTHING.
    const partnerLinkId = await seedBackupPolicy({
      name: 'Partner, servers only (no paths)',
      assignment: { level: 'partner', targetId: partnerId, roleFilter: ['server'] },
    });

    const manual = await withDbAccessContext(orgContext, () =>
      resolveBackupConfigForDevice(deviceId)
    );
    const swept = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(orgId));

    // Both resolvers agree the workstation has no backup config at all —
    // rather than the sweep silently adopting the servers-only, pathless link.
    expect(manual).toBeNull();
    expect(swept.find((e) => e.deviceId === deviceId)).toBeUndefined();
    expect(swept.map((e) => e.featureLinkId)).not.toContain(partnerLinkId);
  });

  it('an empty-array filter matches NOTHING, in both resolvers', async () => {
    // Postgres reads `x = ANY('{}')` as false, so `roleFilter: []` is
    // "match no device" — NOT "no filter". The JS mirror must agree, and only a
    // real assignment row proves the column round-trips as [] rather than null.
    await seedBackupPolicy({
      name: 'Match nothing (no paths)',
      assignment: { level: 'site', targetId: siteId, roleFilter: [] },
    });
    const orgLinkId = await seedBackupPolicy({
      name: 'Org wide (C:\\Users)',
      paths: [WINDOWS_PATH],
      assignment: { level: 'organization', targetId: orgId },
    });

    const manual = await withDbAccessContext(orgContext, () =>
      resolveBackupConfigForDevice(deviceId)
    );
    const swept = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(orgId));

    expect(manual?.featureLinkId).toBe(orgLinkId);
    expect(swept.find((e) => e.deviceId === deviceId)?.featureLinkId).toBe(orgLinkId);
  });

  it('an UNCLASSIFIED device is excluded by a role filter, in both resolvers', async () => {
    // `devices.device_role` is NOT NULL DEFAULT 'unknown', so the real-world
    // "role not determined yet" state — the common one on a freshly enrolled
    // fleet — is the literal 'unknown', not NULL. It must be excluded by a
    // roleFilter that does not name it, in BOTH resolvers. (The NULL branch of
    // `matchesRoleOsFilter` is unreachable through this column by schema;
    // its unit coverage lives in featureConfigResolver.roleOsFilter.test.ts.)
    const [unclassified] = await getTestDb()
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `bsrp-unclassified-${sfx}`,
        hostname: `bsrp-unclassified-${sfx}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        deviceRole: 'unknown',
      })
      .returning({ id: devices.id });

    await seedBackupPolicy({
      name: 'Workstations only (no paths)',
      assignment: { level: 'site', targetId: siteId, roleFilter: ['workstation'] },
    });
    const orgLinkId = await seedBackupPolicy({
      name: 'Org wide (C:\\Users)',
      paths: [WINDOWS_PATH],
      assignment: { level: 'organization', targetId: orgId },
    });

    const manual = await withDbAccessContext(orgContext, () =>
      resolveBackupConfigForDevice(unclassified!.id)
    );
    const swept = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(orgId));

    expect(manual?.featureLinkId).toBe(orgLinkId);
    expect(swept.find((e) => e.deviceId === unclassified!.id)?.featureLinkId).toBe(orgLinkId);
  });

  it('a device matching the filter is still governed by the filtered assignment', async () => {
    // Negative control: the filter must EXCLUDE, not disable. A workstation
    // filter matches this device, so the site-level assignment still wins.
    const siteLinkId = await seedBackupPolicy({
      name: 'Workstations only',
      paths: [WINDOWS_PATH],
      assignment: {
        level: 'site',
        targetId: siteId,
        roleFilter: ['workstation'],
        osFilter: ['windows'],
      },
    });
    await seedBackupPolicy({
      name: 'Org wide',
      paths: ['C:\\Other'],
      assignment: { level: 'organization', targetId: orgId },
    });

    const manual = await withDbAccessContext(orgContext, () =>
      resolveBackupConfigForDevice(deviceId)
    );
    const swept = await withSystemDbAccessContext(() => resolveAllBackupAssignedDevices(orgId));

    expect(manual?.featureLinkId).toBe(siteLinkId);
    expect(swept.find((e) => e.deviceId === deviceId)?.featureLinkId).toBe(siteLinkId);
  });
});

describe('#6001 file-mode dispatch never ships an empty path list', () => {
  it('resolveBackupTargets refuses a file-mode job with no paths', async () => {
    // RED before the fix: returned [{ commandType: 'backup_run',
    // payload: { paths: [] } }], which the agent bounces at 0s.
    await expect(resolveBackupTargets('file', {}, deviceId)).rejects.toThrow(/no paths/i);
    await expect(resolveBackupTargets('file', { paths: [] }, deviceId)).rejects.toThrow(/no paths/i);
    await expect(
      resolveBackupTargets('file', { paths: ['  ', ''] }, deviceId)
    ).rejects.toThrow(/no paths/i);
  });

  it('resolveBackupTargets still dispatches a well-configured file job', async () => {
    const targets = await resolveBackupTargets('file', { paths: [WINDOWS_PATH] }, deviceId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.commandType).toBe('backup_run');
    expect(targets[0]!.payload).toEqual({ paths: [WINDOWS_PATH] });
  });

  it('dispatch builds a non-empty backup_run payload from the winning link', async () => {
    const linkId = await seedBackupPolicy({
      name: 'Org wide (C:\\Users)',
      paths: [WINDOWS_PATH],
      assignment: { level: 'organization', targetId: orgId },
    });
    const jobId = await seedLegacyJob(linkId);

    const cfg = await loadBackupConfig();
    const prepared = await withSystemDbAccessContext(() =>
      __testOnly.prepareBackupDispatchTargets(
        { type: 'dispatch-backup', jobId, configId: backupConfigId, orgId, deviceId },
        cfg
      )
    );

    expect(prepared.status).toBe('ok');
    const command = prepared.status === 'ok' ? prepared.prepared[0]!.command : null;
    expect(command?.type).toBe('backup_run');
    expect((command?.payload as { paths?: string[] }).paths).toEqual([WINDOWS_PATH]);
  });

  it('dispatch falls back to the legacy `paths` column when `targets` carries none', async () => {
    // A settings row written before targets existed (or by an API caller that
    // sent only the top-level `paths` field) must still back up its paths
    // rather than dispatch an empty list.
    const linkId = await seedBackupPolicy({
      name: 'Legacy paths only',
      legacyPaths: [WINDOWS_PATH],
      targets: {},
      assignment: { level: 'organization', targetId: orgId },
    });
    const jobId = await seedLegacyJob(linkId);

    const cfg = await loadBackupConfig();
    const prepared = await withSystemDbAccessContext(() =>
      __testOnly.prepareBackupDispatchTargets(
        { type: 'dispatch-backup', jobId, configId: backupConfigId, orgId, deviceId },
        cfg
      )
    );

    expect(prepared.status).toBe('ok');
    const command = prepared.status === 'ok' ? prepared.prepared[0]!.command : null;
    expect((command?.payload as { paths?: string[] }).paths).toEqual([WINDOWS_PATH]);
  });

  it('a populated `targets` is authoritative — the legacy column never overrides it', async () => {
    // The fallback must be a fallback, not a merge: a tech who narrows the
    // selection in the Backup tab must not keep backing up the paths they
    // removed. Without this case the `targets` emptiness guard could be
    // dropped and every other test here would still pass.
    const linkId = await seedBackupPolicy({
      name: 'Narrowed targets, stale legacy column',
      targets: { paths: ['C:\\Narrowed'] },
      legacyPaths: ['C:\\Stale', 'C:\\AlsoStale'],
      assignment: { level: 'organization', targetId: orgId },
    });
    const jobId = await seedLegacyJob(linkId);

    const cfg = await loadBackupConfig();
    const prepared = await withSystemDbAccessContext(() =>
      __testOnly.prepareBackupDispatchTargets(
        { type: 'dispatch-backup', jobId, configId: backupConfigId, orgId, deviceId },
        cfg
      )
    );

    expect(prepared.status).toBe('ok');
    const command = prepared.status === 'ok' ? prepared.prepared[0]!.command : null;
    expect((command?.payload as { paths?: string[] }).paths).toEqual(['C:\\Narrowed']);
  });

  it('a link with no paths anywhere fails the job with the typed reason instead of dispatching', async () => {
    const linkId = await seedBackupPolicy({
      name: 'No paths at all',
      assignment: { level: 'organization', targetId: orgId },
    });
    const jobId = await seedLegacyJob(linkId);

    const cfg = await loadBackupConfig();
    const prepared = await withSystemDbAccessContext(() =>
      __testOnly.prepareBackupDispatchTargets(
        { type: 'dispatch-backup', jobId, configId: backupConfigId, orgId, deviceId },
        cfg
      )
    );

    // Nothing prepared for the agent.
    expect(prepared.status).toBe('done');
    expect(prepared.status === 'done' ? prepared.result.dispatched : true).toBe(false);

    const [row] = await getTestDb()
      .select({ status: backupJobs.status, errorLog: backupJobs.errorLog })
      .from(backupJobs)
      .where(eq(backupJobs.id, jobId));
    expect(row?.status).toBe('failed');
    // Actionable: names the cause AND the remedy, not "payload has no paths".
    expect(row?.errorLog).toMatch(/no paths/i);
    expect(row?.errorLog).toMatch(/backup/i);
  });
});

/** A legacy (NULL-mode) scheduled job — the shape the sweep creates with no profile. */
async function seedLegacyJob(featureLinkId: string): Promise<string> {
  const [job] = await getTestDb()
    .insert(backupJobs)
    .values({
      orgId,
      configId: backupConfigId,
      featureLinkId,
      deviceId,
      status: 'pending',
      type: 'scheduled',
    })
    .returning({ id: backupJobs.id });
  return job!.id;
}

async function loadBackupConfig(): Promise<typeof backupConfigs.$inferSelect> {
  const [cfg] = await getTestDb()
    .select()
    .from(backupConfigs)
    .where(eq(backupConfigs.id, backupConfigId));
  return cfg!;
}
