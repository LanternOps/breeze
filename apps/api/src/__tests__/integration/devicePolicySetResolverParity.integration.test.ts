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
import { db } from '../../db';
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
import {
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
    (e) => expect(e).not.toMatchObject({ poll_interval_minutes: 7 })],
  ['resolveDeviceTimeSyncSettings', (id, o) => resolveDeviceTimeSyncSettings(id, o),
    // Device-level child inherits the INACTIVE partner-wide parent's link.
    (a) => expect(a).toMatchObject({ settings: { ntpServers: ['time.parent.example'] } }),
    (e) => expect(e).toMatchObject({ policy: null })],
  ['buildResolvedTimeSyncConfigUpdate', (id, o) => buildResolvedTimeSyncConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ ntp_servers: ['time.parent.example'] }),
    (e) => expect(e).not.toMatchObject({ ntp_servers: ['time.parent.example'] })],
  ['buildTimeSyncConfigUpdate', (id, o) => buildTimeSyncConfigUpdate(id, o),
    (a) => expect(a).toMatchObject({ ntp_servers: ['time.parent.example'] }),
    (e) => expect(e).not.toMatchObject({ ntp_servers: ['time.parent.example'] })],
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
      await threeWay(ctx, 'resolveDeviceTimeSyncSettings', (id, o) => resolveDeviceTimeSyncSettings(id, o));
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
