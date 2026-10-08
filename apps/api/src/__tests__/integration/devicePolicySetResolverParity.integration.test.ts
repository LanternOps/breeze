/**
 * #8142 (scaling W03) — every heartbeat policy resolver returns the SAME answer
 * three ways against real PostgreSQL:
 *   1. its own reads in SYSTEM scope (the pre-W03 heartbeat),
 *   2. its own reads in the heartbeat's ORG-scoped context (the W03 fallback
 *      path; proves the *_partner_wide_select branches carry every feature),
 *   3. the one-statement DevicePolicySet loaded in that org-scoped context.
 * Every resolver resolves to a NON-default answer (see seedParityWorld), so
 * parity cannot pass on two defaults. Discriminating controls: an EMPTY set
 * changes the answer (the set is really used), another device's set is
 * refused, forged cross-tenant rows never appear, and equal-ranked
 * assignments resolve to the earliest on every path.
 */
import './setup';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { automationPolicies, organizations, pamOrgConfig } from '../../db/schema';
import { resolveMonitorsForDevice } from '../../services/monitors/monitorResolver';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDeviceHierarchy, type DeviceHierarchy } from '../../services/deviceHierarchy';
import {
  DevicePolicySetMismatchError,
  loadDevicePolicySet,
  withPolicySet,
  type DevicePolicySet,
  type DevicePolicySetOpts,
} from '../../services/devicePolicySet';
import { buildHelperConfigUpdate, resolveDeviceHelperSettings } from '../../services/helperSettings';
import { resolveEffectiveWarrantyInlineSettings } from '../../services/warrantyPolicyResolution';
import { resolveDeviceTimeSyncSettings } from '../../services/timeSync/settings';
import { buildResolvedTimeSyncConfigUpdate } from '../../services/timeSync/configUpdate';
import { getOrgHelperSettings } from '../../services/helperSettings';
import {
  buildPolicyProbeConfigUpdate,
  resolveOrgPamFallback,
  buildEventLogConfigUpdate,
  buildMonitoringConfigUpdate,
  buildOnedriveHelperConfigUpdate,
  buildHardwareMonitoringConfigUpdate,
  buildPamConfigUpdate,
  buildPatchSourceConfigUpdate,
  buildTimeSyncConfigUpdate,
  buildWarrantyConfigUpdate,
} from '../../routes/agents/helpers';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  dropDeviceRedisCaches,
  inOrg,
  seedDevice,
  seedParityWorld,
  seedPolicy,
  sys,
  type ParityWorld,
  type SeedLink,
} from './policySetFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);
let w: ParityWorld;

type Resolver = (deviceId: string, opts?: DevicePolicySetOpts) => Promise<unknown>;

async function loadSetFor(deviceId: string, orgId: string, partnerId: string): Promise<{ hierarchy: DeviceHierarchy; set: DevicePolicySet }> {
  return inOrg(orgId, partnerId, async () => {
    const hierarchy = await loadDeviceHierarchy(deviceId);
    expect(hierarchy).not.toBeNull();
    return { hierarchy: hierarchy!, set: await loadDevicePolicySet(hierarchy!) };
  });
}

async function threeWay(
  ctx: { deviceId: string; orgId: string; partnerId: string },
  name: string,
  resolve: Resolver,
): Promise<unknown> {
  await dropDeviceRedisCaches(ctx.deviceId);
  const legacySystem = await sys(() => resolve(ctx.deviceId));
  await dropDeviceRedisCaches(ctx.deviceId);
  const legacyOrg = await inOrg(ctx.orgId, ctx.partnerId, () => resolve(ctx.deviceId));
  await dropDeviceRedisCaches(ctx.deviceId);
  const viaSet = await inOrg(ctx.orgId, ctx.partnerId, async () => {
    const hierarchy = await loadDeviceHierarchy(ctx.deviceId);
    return resolve(ctx.deviceId, withPolicySet(await loadDevicePolicySet(hierarchy!), hierarchy));
  });
  expect(legacyOrg, `${name}: own reads in the org-scoped context`).toEqual(legacySystem);
  expect(viaSet, `${name}: policy set`).toEqual(legacySystem);
  return legacySystem;
}

/** name → [resolver, non-trivial expectation on the answer, answer with an EMPTY set]. */
const RESOLVERS: Array<[string, Resolver, (answer: any) => void, (emptyAnswer: any) => void]> = [
  ['resolveDeviceHelperSettings', (id, o) => resolveDeviceHelperSettings(id, o),
    (a) => expect(a).toMatchObject({ enabled: true, showTrayIcon: false }),
    (e) => expect(e).toBeNull()],
  ['buildHelperConfigUpdate', (id, o) => buildHelperConfigUpdate(id, w.orgId, o),
    (a) => expect(a).toMatchObject({ enabled: true, showTrayIcon: false }),
    (e) => expect(e).toMatchObject({ enabled: false, showTrayIcon: true })],
  ['buildPamConfigUpdate', (id, o) => buildPamConfigUpdate(id, o),
    (a) => expect(a).toEqual({ uacInterceptionEnabled: true }),
    (e) => expect(e).toEqual({ uacInterceptionEnabled: false })],
  ['resolveEffectiveWarrantyInlineSettings', (id, o) => resolveEffectiveWarrantyInlineSettings(id, o),
    (a) => expect(a).toMatchObject({ enabled: true, warnDays: 45 }),
    (e) => expect(e).toBeUndefined()],
  // The winning warranty link carries an hpCmsl block with a CURRENT EULA acceptance.
  ['buildWarrantyConfigUpdate', (id, o) => buildWarrantyConfigUpdate(id, o),
    (a) => expect(a).toEqual({ hpCmslEnabled: true }),
    (e) => expect(e).toEqual({ hpCmslEnabled: false })],
  ['buildEventLogConfigUpdate', (id, o) => buildEventLogConfigUpdate(id, o),
    // 321 = partner-wide partner-level winner; 555 (printer) and the bare device-level link are excluded; 999 is forged.
    (a) => expect(a).toMatchObject({ max_events_per_cycle: 321 }),
    (e) => expect(e).toMatchObject({ max_events_per_cycle: 100 })],
  ['buildHardwareMonitoringConfigUpdate', (id, o) => buildHardwareMonitoringConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ enabled: true, poll_interval_minutes: 7 }),
    (e) => expect(e).toEqual({ enabled: true, poll_interval_minutes: 10, disk_health_interval_minutes: 60 })],
  ['resolveDeviceTimeSyncSettings', (id, o) => resolveDeviceTimeSyncSettings(id, o),
    // Device-level child inherits the INACTIVE partner-wide parent's link.
    (a) => expect(a).toMatchObject({ settings: { ntpServers: ['time.parent.example'] } }),
    (e) => expect(e).toMatchObject({ policy: null })],
  ['buildResolvedTimeSyncConfigUpdate', (id, o) => buildResolvedTimeSyncConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ ntp_servers: ['time.parent.example'] }),
    (e) => expect(e).toEqual({ enforce_ntp: false, ntp_servers: [], poll_interval_minutes: 60, timezone: { expected_windows_id: null, auto_fix: false }, fingerprint: expect.stringMatching(/^sha256:/) })],
  ['buildTimeSyncConfigUpdate', (id, o) => buildTimeSyncConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ ntp_servers: ['time.parent.example'] }),
    (e) => expect(e).toEqual({ enforce_ntp: false, ntp_servers: [], poll_interval_minutes: 60, timezone: { expected_windows_id: null, auto_fix: false }, fingerprint: expect.stringMatching(/^sha256:/) })],
  ['buildPatchSourceConfigUpdate', (id, o) => buildPatchSourceConfigUpdate(id, o),
    (a) => expect(a).toEqual({ exclusiveWindowsUpdate: true }),
    (e) => expect(e).toEqual({ exclusiveWindowsUpdate: false })],
  ['resolveMonitorsForDevice', (id, o) => resolveMonitorsForDevice(id, db, o),
    // Partner-wide cumulative attachment survives the closer EMPTY replace link at site level.
    (a) => {
      expect(a.kind).toBe('resolved');
      expect(a.monitors).toHaveLength(1);
      expect(a.monitors[0]).toMatchObject({ enabled: true, sourceLevel: 'partner' });
    },
    (e) => expect(e).toEqual({ kind: 'resolved', monitors: [] })],
  ['buildMonitoringConfigUpdate', (id, o) => buildMonitoringConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ check_interval_seconds: 120, watches: [expect.objectContaining({ name: 'ParityService' })] }),
    (e) => expect(e).toEqual({ check_interval_seconds: 60, watches: [] })],
  ['buildOnedriveHelperConfigUpdate', (id, o) => buildOnedriveHelperConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ base: { filesOnDemand: false }, libraries: [expect.objectContaining({ displayName: 'Parity Docs', allowedUpns: [] })] }),
    (e) => expect(e).toBeNull()],
];

describe('heartbeat policy resolvers: three-way parity with the policy set (#8142) — real PostgreSQL', () => {
  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    w = await seedParityWorld();
  });

  for (const [name, resolve, nonTrivial, emptyAnswer] of RESOLVERS) {
    runDb(`${name}: same answer three ways`, async () => {
      nonTrivial(await threeWay({ deviceId: w.deviceId, orgId: w.orgId, partnerId: w.partnerId }, name, resolve));
    });

    runDb(`${name}: an EMPTY set changes the answer (the set is really used)`, async () => {
      const { hierarchy, set } = await loadSetFor(w.deviceId, w.orgId, w.partnerId);
      const empty: DevicePolicySet = Object.freeze({ ...set, candidates: Object.freeze([]) });
      await dropDeviceRedisCaches(w.deviceId);
      emptyAnswer(await inOrg(w.orgId, w.partnerId, () => resolve(w.deviceId, { hierarchy, policySet: empty })));
    });

    runDb(`${name}: refuses another device's set`, async () => {
      const sibling = await loadSetFor(w.siblingId, w.orgId, w.partnerId);
      await dropDeviceRedisCaches(w.deviceId);
      // The set alone (no hierarchy), so the SET guard — not the W01 hierarchy guard — is what refuses.
      await expect(inOrg(w.orgId, w.partnerId, () => resolve(w.deviceId, { policySet: sibling.set })))
        .rejects.toBeInstanceOf(DevicePolicySetMismatchError);
    });
  }

  runDb('forged cross-tenant helper rows never reach the device (portalUrl stays unset)', async () => {
    const answer = await threeWay({ deviceId: w.deviceId, orgId: w.orgId, partnerId: w.partnerId },
      'resolveDeviceHelperSettings', (id, o) => resolveDeviceHelperSettings(id, o));
    expect(answer).not.toMatchObject({ portalUrl: expect.anything() });
    expect(JSON.stringify(answer)).not.toContain('cross-org.example');
  });

  runDb('the forged PAM row (priority -10, uac false) never beats the real partner-wide PAM policy', async () => {
    expect(await threeWay({ deviceId: w.deviceId, orgId: w.orgId, partnerId: w.partnerId },
      'buildPamConfigUpdate', (id, o) => buildPamConfigUpdate(id, o))).toEqual({ uacInterceptionEnabled: true });
  });
});

describe('equal-ranked assignments resolve to the EARLIEST assignment on every path (#8142)', () => {
  async function tieWorld(firstWins: boolean) {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const site = (await createSite({ orgId: org.id }))!;
    const deviceId = await seedDevice(org.id, site.id, 'tie');
    const early = new Date(Date.UTC(2026, 0, 1));
    const late = new Date(Date.UTC(2026, 0, 2));
    await seedPolicy({ owner: { orgId: org.id, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } },
        { featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://true.example' } }],
      assignments: [{ level: 'organization', targetId: org.id, priority: 0, createdAt: firstWins ? early : late }] });
    await seedPolicy({ owner: { orgId: org.id, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: false } },
        { featureType: 'helper', inlineSettings: { enabled: true, portalUrl: 'https://false.example' } }],
      assignments: [{ level: 'organization', targetId: org.id, priority: 0, createdAt: firstWins ? late : early }] });
    return { deviceId, orgId: org.id, partnerId: partner.id };
  }

  for (const firstWins of [true, false]) {
    runDb(`pam + helper tie (${firstWins ? 'true' : 'false'} policy assigned first)`, async () => {
      const t = await tieWorld(firstWins);
      expect(await threeWay(t, 'pam tie', (id, o) => buildPamConfigUpdate(id, o)))
        .toEqual({ uacInterceptionEnabled: firstWins });
      expect(await threeWay(t, 'helper tie', (id, o) => resolveDeviceHelperSettings(id, o)))
        .toMatchObject({ portalUrl: firstWins ? 'https://true.example' : 'https://false.example' });
    });
  }
});

describe('equal created_at AND priority: the LOWEST assignment id wins on every path (#8142)', () => {
  const LOW_ID = '11111111-0000-4000-8000-000000000001';
  const HIGH_ID = 'ffffffff-0000-4000-8000-00000000000f';

  // The LOW-id policy always carries the "winning" values (uac true, low portal, 401).
  async function idTieWorld(insertHighFirst: boolean) {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const site = (await createSite({ orgId: org.id }))!;
    const deviceId = await seedDevice(org.id, site.id, 'id-tie');
    const sameInstant = new Date(Date.UTC(2026, 0, 1));
    const seed = (id: string, low: boolean) => seedPolicy({ owner: { orgId: org.id, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: low } },
        { featureType: 'helper', inlineSettings: { enabled: true, portalUrl: low ? 'https://low.example' : 'https://high.example' } },
        { featureType: 'event_log', maxEventsPerCycle: low ? 401 : 402 }],
      assignments: [{ id, level: 'organization', targetId: org.id, priority: 0, createdAt: sameInstant }] });
    if (insertHighFirst) {
      await seed(HIGH_ID, false);
      await seed(LOW_ID, true);
    } else {
      await seed(LOW_ID, true);
      await seed(HIGH_ID, false);
    }
    return { deviceId, orgId: org.id, partnerId: partner.id };
  }

  // Both insert orders: a resolver that ignored the id (plan/insert order) could pass one, never both.
  for (const insertHighFirst of [true, false]) {
    runDb(`pam + helper + event_log (${insertHighFirst ? 'high' : 'low'} id inserted first)`, async () => {
      const t = await idTieWorld(insertHighFirst);
      expect(await threeWay(t, 'pam id tie', (id, o) => buildPamConfigUpdate(id, o)))
        .toEqual({ uacInterceptionEnabled: true });
      expect(await threeWay(t, 'helper id tie', (id, o) => resolveDeviceHelperSettings(id, o)))
        .toMatchObject({ portalUrl: 'https://low.example' });
      expect(await threeWay(t, 'event_log id tie', (id, o) => buildEventLogConfigUpdate(id, o)))
        .toMatchObject({ max_events_per_cycle: 401 });
    });
  }
});

describe('equal-ranked ties resolve to the EARLIEST assignment for every other resolver (#8142)', () => {
  type TieLink = (n: 'a' | 'b') => SeedLink;
  async function tieWorld(label: string, link: TieLink, firstWins: boolean) {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const site = (await createSite({ orgId: org.id }))!;
    const deviceId = await seedDevice(org.id, site.id, label);
    const early = new Date(Date.UTC(2026, 0, 1));
    const late = new Date(Date.UTC(2026, 0, 2));
    // 'a' is the policy expected to win when firstWins; 'b' otherwise.
    const aId = await seedPolicy({ owner: { orgId: org.id, partnerId: null }, links: [link('a')],
      assignments: [{ level: 'organization', targetId: org.id, priority: 0, createdAt: firstWins ? early : late }] });
    const bId = await seedPolicy({ owner: { orgId: org.id, partnerId: null }, links: [link('b')],
      assignments: [{ level: 'organization', targetId: org.id, priority: 0, createdAt: firstWins ? late : early }] });
    return { deviceId, orgId: org.id, partnerId: partner.id, aId, bId };
  }

  for (const firstWins of [true, false]) {
    const tag = `(${firstWins ? 'a' : 'b'} assigned first)`;
    const pick = <T,>(a: T, b: T) => (firstWins ? a : b);

    runDb(`warranty tie ${tag}`, async () => {
      const t = await tieWorld('tie-warranty', (n) => ({ featureType: 'warranty',
        inlineSettings: { enabled: true, warnDays: n === 'a' ? 41 : 42, criticalDays: 10 } }), firstWins);
      expect(await threeWay(t, 'warranty tie', (id, o) => resolveEffectiveWarrantyInlineSettings(id, o)))
        .toMatchObject({ warnDays: pick(41, 42) });
    });

    runDb(`event_log tie ${tag}`, async () => {
      const t = await tieWorld('tie-eventlog', (n) => ({ featureType: 'event_log', maxEventsPerCycle: n === 'a' ? 211 : 212 }), firstWins);
      expect(await threeWay(t, 'event_log tie', (id, o) => buildEventLogConfigUpdate(id, o)))
        .toMatchObject({ max_events_per_cycle: pick(211, 212) });
    });

    runDb(`hardware_monitoring tie ${tag}`, async () => {
      const t = await tieWorld('tie-hw', (n) => ({ featureType: 'hardware_monitoring', pollIntervalMinutes: n === 'a' ? 11 : 12 }), firstWins);
      expect(await threeWay(t, 'hardware_monitoring tie', (id, o) => buildHardwareMonitoringConfigUpdate(id, o)))
        .toMatchObject({ poll_interval_minutes: pick(11, 12) });
    });

    runDb(`check-interval tie ${tag}`, async () => {
      const t = await tieWorld('tie-interval', (n) => ({ featureType: 'monitors', checkIntervalSeconds: n === 'a' ? 91 : 92 }), firstWins);
      expect(await threeWay(t, 'check-interval tie', (id, o) => buildMonitoringConfigUpdate(id, o)))
        .toMatchObject({ check_interval_seconds: pick(91, 92) });
    });

    runDb(`monitors tie ${tag}`, async () => {
      const t = await tieWorld('tie-monitors', (n) => ({ featureType: 'monitors', inheritance: 'replace',
        serviceName: n === 'a' ? 'TieSvcA' : 'TieSvcB' }), firstWins);
      const answer: any = await threeWay(t, 'monitors tie', (id, o) => resolveMonitorsForDevice(id, db, o));
      expect(answer.kind).toBe('resolved');
      // Monitor rows carry only ids; the winning POLICY is the observable.
      expect(answer.monitors).toHaveLength(1);
      expect(answer.monitors[0].sourcePolicyId).toBe(pick(t.aId, t.bId));
    });
  }
});

describe('monitors link inherited from a parent policy (#8142)', () => {
  runDb('a child with NO monitors link inherits the parent link: monitors + interval three ways, not the empty result', async () => {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const site = (await createSite({ orgId: org.id }))!;
    const deviceId = await seedDevice(org.id, site.id, 'inherit-mon');
    const parent = await seedPolicy({ owner: { orgId: org.id, partnerId: null }, status: 'inactive',
      links: [{ featureType: 'monitors', serviceName: 'InheritedSvc', checkIntervalSeconds: 77 }] });
    await seedPolicy({ owner: { orgId: org.id, partnerId: null }, parentPolicyId: parent,
      assignments: [{ level: 'device', targetId: deviceId }] });
    const ctx = { deviceId, orgId: org.id, partnerId: partner.id };
    const monitors: any = await threeWay(ctx, 'resolveMonitorsForDevice', (id, o) => resolveMonitorsForDevice(id, db, o));
    expect(monitors.kind).toBe('resolved');
    expect(monitors.monitors).toHaveLength(1);
    expect(await threeWay(ctx, 'buildMonitoringConfigUpdate', (id, o) => buildMonitoringConfigUpdate(id, o)))
      .toMatchObject({ check_interval_seconds: 77, watches: [expect.objectContaining({ name: 'InheritedSvc' })] });
  });
});

describe('quick_support: check interval keeps the partner target, monitors drops it (#8142)', () => {
  runDb('partner-level monitors policy: interval 133 survives, monitors resolve empty, three ways', async () => {
    const partner = (await createPartner())!;
    const qs = (await createOrganization({ partnerId: partner.id, type: 'quick_support' }))!;
    const qsSite = (await createSite({ orgId: qs.id }))!;
    const deviceId = await seedDevice(qs.id, qsSite.id, 'qs-interval');
    await seedPolicy({ owner: { orgId: null, partnerId: partner.id },
      links: [{ featureType: 'monitors', serviceName: 'QsSvc', checkIntervalSeconds: 133 }],
      assignments: [{ level: 'partner', targetId: partner.id }] });
    const ctx = { deviceId, orgId: qs.id, partnerId: partner.id };
    expect(await threeWay(ctx, 'check interval (via buildMonitoringConfigUpdate)',
      async (id, o) => ((await buildMonitoringConfigUpdate(id, o)) as any)?.check_interval_seconds)).toBe(133);
    expect(await threeWay(ctx, 'resolveMonitorsForDevice', (id, o) => resolveMonitorsForDevice(id, db, o)))
      .toEqual({ kind: 'resolved', monitors: [] });
  });
});

describe('parked orgs keep their partner-drop rules on the set path (#8142)', () => {
  for (const orgType of ['unassigned_pool', 'quick_support'] as const) {
    runDb(`${orgType}: patch source and time sync agree three ways`, async () => {
      const world = await seedParityWorld();
      const parked = (await createOrganization({ partnerId: world.partnerId, type: orgType }))!;
      const parkedSite = (await createSite({ orgId: parked.id }))!;
      const deviceId = await seedDevice(parked.id, parkedSite.id, orgType);
      const ctx = { deviceId, orgId: parked.id, partnerId: world.partnerId };
      const patch = await threeWay(ctx, 'buildPatchSourceConfigUpdate', (id, o) => buildPatchSourceConfigUpdate(id, o));
      // Patch drops the partner for unassigned_pool only.
      expect(patch).toEqual({ exclusiveWindowsUpdate: orgType !== 'unassigned_pool' });
      // Time sync keeps the partner target for parked orgs: the partner-wide
      // policy's servers reach the device (the device-level child is the other
      // world's device, so this is the partner-level link).
      expect(await threeWay(ctx, 'resolveDeviceTimeSyncSettings', (id, o) => resolveDeviceTimeSyncSettings(id, o)))
        .toMatchObject({ settings: { ntpServers: ['time.partner.example'] } });
    });
  }
});

describe('monitoring with no monitors link resolves to the explicit clear on every path (#8142)', () => {
  runDb('a device whose only policy is PAM: watches [] three ways; quick_support drops the partner target', async () => {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const site = (await createSite({ orgId: org.id }))!;
    const deviceId = await seedDevice(org.id, site.id, 'pam-only');
    await seedPolicy({ owner: { orgId: org.id, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } }],
      assignments: [{ level: 'organization', targetId: org.id }] });
    const ctx = { deviceId, orgId: org.id, partnerId: partner.id };
    expect(await threeWay(ctx, 'buildMonitoringConfigUpdate', (id, o) => buildMonitoringConfigUpdate(id, o)))
      .toEqual({ check_interval_seconds: 60, watches: [] });
    expect(await threeWay(ctx, 'resolveMonitorsForDevice', (id, o) => resolveMonitorsForDevice(id, db, o)))
      .toEqual({ kind: 'resolved', monitors: [] });

    const world = await seedParityWorld();
    const qs = (await createOrganization({ partnerId: world.partnerId, type: 'quick_support' }))!;
    const qsSite = (await createSite({ orgId: qs.id }))!;
    const qsDevice = await seedDevice(qs.id, qsSite.id, 'qs');
    expect(await threeWay({ deviceId: qsDevice, orgId: qs.id, partnerId: world.partnerId }, 'monitors (quick_support)',
      (id, o) => resolveMonitorsForDevice(id, db, o))).toEqual({ kind: 'resolved', monitors: [] });
  });
});


describe('per-org cache fills: the org-scoped load equals the system-scoped load (#8142)', () => {
  // The heartbeat stores these three values in per-org caches from the org-scoped
  // post-commit context, and serves them to every device of the org. They are only
  // safe to share if that context shows the loader exactly what system scope does.
  const probeRules = (n: string) => [{ type: 'registry_check', registryPath: `HKLM\\Software\\${n}`, registryValueName: n }];

  async function cacheWorld() {
    const partner = (await createPartner())!;
    const org = (await createOrganization({ partnerId: partner.id }))!;
    const sibling = (await createOrganization({ partnerId: partner.id }))!;
    const foreignPartner = (await createPartner())!;
    await sys(async () => {
      const targets = { targetType: 'all', targetIds: [] };
      await db.insert(automationPolicies).values([
        { orgId: null, partnerId: partner.id, name: 'pw', targets, rules: probeRules('PartnerWide') },
        { orgId: org.id, partnerId: null, name: 'own', targets, rules: probeRules('OrgOwn') },
        { orgId: org.id, partnerId: null, name: 'off', enabled: false, targets, rules: probeRules('Disabled') },
        { orgId: sibling.id, partnerId: null, name: 'sib', targets, rules: probeRules('Sibling') },
        { orgId: null, partnerId: foreignPartner.id, name: 'fp', targets, rules: probeRules('ForeignPartner') },
      ] as never);
      await db.update(organizations).set({ settings: { helper: { enabled: true } } }).where(eq(organizations.id, org.id));
      await db.insert(pamOrgConfig).values({ orgId: org.id, uacInterceptionEnabled: true } as never);
    });
    return { orgId: org.id, partnerId: partner.id };
  }

  runDb('policy probe: partner-wide + own rows, equal in system and org scope; sibling/foreign/disabled never appear', async () => {
    const t = await cacheWorld();
    const load = () => buildPolicyProbeConfigUpdate(t.orgId, { partnerId: t.partnerId });
    const asSystem = await sys(load);
    const asOrg = await inOrg(t.orgId, t.partnerId, load);
    expect(asOrg).toEqual(asSystem);
    const names = (asOrg?.policy_registry_state_probes ?? []).map((p) => p.value_name).sort();
    expect(names).toEqual(['OrgOwn', 'PartnerWide']);
  });

  runDb('org helper flag: equal in system and org scope, and not the default', async () => {
    const t = await cacheWorld();
    const asSystem = await sys(() => getOrgHelperSettings(t.orgId));
    const asOrg = await inOrg(t.orgId, t.partnerId, () => getOrgHelperSettings(t.orgId));
    expect(asOrg).toEqual(asSystem);
    expect(asOrg).toEqual({ enabled: true });
  });

  runDb('org PAM fallback: equal in system and org scope, and not the default', async () => {
    const t = await cacheWorld();
    const asSystem = await sys(() => resolveOrgPamFallback(t.orgId));
    const asOrg = await inOrg(t.orgId, t.partnerId, () => resolveOrgPamFallback(t.orgId));
    expect(asOrg).toEqual(asSystem);
    expect(asOrg).toEqual({ uacInterceptionEnabled: true });
  });
});
