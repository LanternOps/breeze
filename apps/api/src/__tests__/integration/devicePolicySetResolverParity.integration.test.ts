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
import { buildPamConfigUpdate, buildWarrantyConfigUpdate } from '../../routes/agents/helpers';
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
