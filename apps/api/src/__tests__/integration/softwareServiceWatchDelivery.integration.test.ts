/**
 * #6958 PR E4 (k): derived software service watches against REAL Postgres and
 * RLS. A mocked statement counter cannot see a join that RLS silently empties
 * (an agent context that cannot read a partner-wide software policy would just
 * get no watches), so these run as breeze_app in the agent's own context.
 *
 * Also pins, through the real heartbeat inputs (loadDeviceHierarchy +
 * loadDevicePolicySet in the agent context → buildMonitoringConfigUpdate),
 * that a device whose only policy carries a `software_policy` link now gets
 * its derived watches on the heartbeat path (Option A: the set carries that
 * link, so the statement-free pre-filter admits the device), and the system-
 * context catalog-version read the compliance worker uses honours catalog
 * reachability.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyFeatureLinks,
  softwareCatalog,
  softwareComplianceStatus,
  softwarePolicies,
  softwareVersions,
} from '../../db/schema';
import { loadDeviceHierarchy } from '../../services/deviceHierarchy';
import { loadDevicePolicySet, withPolicySet } from '../../services/devicePolicySet';
import {
  buildMonitoringConfigUpdate,
  resolveMonitoringConfigForDisplay,
  resolveSoftwarePolicyServiceWatches,
} from '../../routes/agents/helpers';
import { loadServiceBridgeVersions } from '../../jobs/softwareComplianceWorker';
import { createOrganization, createPartner, createSite } from './db-utils';
import { dropDeviceRedisCaches, seedDevice, seedPolicy, sys } from './policySetFixtures';

/** Copied from middleware/agentAuth.ts (the agent request's own context). */
function agentCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: partnerId,
  } as DbAccessContext;
}

const ARMED = { mode: 'allowlist' as const, enforceMode: true, remediationOptions: { autoInstall: true } };

type World = { partnerId: string; orgId: string; deviceId: string; otherPartnerId: string; otherOrgId: string };
let w: World;

async function seedWorld(): Promise<World> {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const deviceId = await seedDevice(org.id, site.id, 'svcwatch');
  const otherPartner = (await createPartner())!;
  const otherOrg = (await createOrganization({ partnerId: otherPartner.id }))!;
  await dropDeviceRedisCaches(deviceId);
  return { partnerId: partner.id, orgId: org.id, deviceId, otherPartnerId: otherPartner.id, otherOrgId: otherOrg.id };
}

/** A software policy + its compliance row for w.deviceId; optionally linked into an org-assigned config policy. */
async function seedSoftwarePolicy(opts: {
  owner: { orgId: string | null; partnerId: string | null };
  names?: string[];
  lastChecked?: Date;
  isActive?: boolean;
  policy?: Partial<typeof ARMED>;
  link?: boolean;
}): Promise<string> {
  const policyId = await sys(async () => {
    const [sw] = await db.insert(softwarePolicies).values({
      orgId: opts.owner.orgId, partnerId: opts.owner.partnerId, name: `svcwatch ${Math.random()}`,
      rules: { software: [{ name: 'Control D', catalogId: '00000000-0000-4000-8000-000000000001' }] },
      isActive: opts.isActive ?? true, ...ARMED, ...opts.policy,
    }).returning({ id: softwarePolicies.id });
    await db.insert(softwareComplianceStatus).values({
      deviceId: w.deviceId, policyId: sw!.id, status: 'violation', violations: [],
      lastChecked: opts.lastChecked ?? new Date(),
      serviceWatches: (opts.names ?? ['ctrld']).map((name) => ({ name })),
    });
    return sw!.id;
  });
  if (opts.link !== false) {
    const configPolicyId = await seedPolicy({
      owner: { orgId: w.orgId, partnerId: null },
      assignments: [{ level: 'organization', targetId: w.orgId }],
    });
    await sys(() => db.insert(configPolicyFeatureLinks).values({
      configPolicyId, featureType: 'software_policy' as const, featurePolicyId: policyId,
    }));
  }
  return policyId;
}

/** The heartbeat's inputs, loaded exactly as heartbeat.ts does, in the agent context. */
async function beat<T>(fn: (opts: ReturnType<typeof withPolicySet>) => Promise<T>): Promise<T> {
  return withDbAccessContext(agentCtx(w.orgId, w.partnerId), async () => {
    const hierarchy = await loadDeviceHierarchy(w.deviceId);
    const set = await loadDevicePolicySet(hierarchy!);
    return fn(withPolicySet(set, hierarchy));
  });
}

describe('software-policy-derived service watches — real RLS (#6958 PR E4)', () => {
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('heartbeat path: a device whose only policy carries a software_policy link gets its derived watch', async () => {
    await seedSoftwarePolicy({ owner: { orgId: w.orgId, partnerId: null } });
    const out = await beat((opts) => buildMonitoringConfigUpdate(w.deviceId, opts));
    expect(out).toEqual({
      check_interval_seconds: 300,
      watches: [expect.objectContaining({ watch_type: 'service', name: 'ctrld', auto_restart: true })],
    });
  });

  it('agent context resolves a PARTNER-WIDE software policy (org_id NULL) through its partner-wide select branch', async () => {
    await seedSoftwarePolicy({ owner: { orgId: null, partnerId: w.partnerId } });
    const watches = await beat((opts) => resolveSoftwarePolicyServiceWatches(w.deviceId, opts));
    expect(watches.map((x) => [x.name, x.auto_restart])).toEqual([['ctrld', true]]);
  });

  it('agent context resolves an org-owned software policy', async () => {
    await seedSoftwarePolicy({ owner: { orgId: w.orgId, partnerId: null }, policy: { enforceMode: false } });
    const watches = await beat((opts) => resolveSoftwarePolicyServiceWatches(w.deviceId, opts));
    expect(watches.map((x) => [x.name, x.auto_restart])).toEqual([['ctrld', false]]);
  });

  it('another partner\'s policy yields nothing: RLS hides it from the join', async () => {
    // Forged in system scope: a compliance row on OUR device pointing at a
    // policy owned by ANOTHER partner (the DB refuses a cross-tenant feature
    // link, so it is unlinked). Our own linked policy makes the pre-filter
    // admit the query, which is the point: RLS alone must drop the foreign row.
    await seedSoftwarePolicy({ owner: { orgId: null, partnerId: w.otherPartnerId }, names: ['foreignsvc'], link: false });
    await seedSoftwarePolicy({ owner: { orgId: w.orgId, partnerId: null }, names: ['nextdns'] });
    const asSystem = await sys(() => resolveSoftwarePolicyServiceWatches(w.deviceId));
    expect(asSystem.map((x) => x.name)).toEqual(['foreignsvc', 'nextdns']); // control: both rows exist
    expect((await beat((opts) => resolveSoftwarePolicyServiceWatches(w.deviceId, opts))).map((x) => x.name)).toEqual(['nextdns']);
  });

  it('a row older than 30 minutes is not delivered', async () => {
    await seedSoftwarePolicy({ owner: { orgId: w.orgId, partnerId: null }, lastChecked: new Date(Date.now() - 31 * 60_000) });
    expect(await beat((opts) => resolveSoftwarePolicyServiceWatches(w.deviceId, opts))).toEqual([]);
  });

  it('an inactive policy\'s watches are not delivered', async () => {
    await seedSoftwarePolicy({ owner: { orgId: w.orgId, partnerId: null }, isActive: false });
    expect(await beat((opts) => resolveSoftwarePolicyServiceWatches(w.deviceId, opts))).toEqual([]);
  });

  it('pre-filter: with a loaded set and NO software_policy link, a fresh row is never read', async () => {
    await seedSoftwarePolicy({ owner: { orgId: w.orgId, partnerId: null }, link: false });
    expect(await beat((opts) => resolveSoftwarePolicyServiceWatches(w.deviceId, opts))).toEqual([]);
    // Control: without the set the same row is legible.
    expect(await withDbAccessContext(agentCtx(w.orgId, w.partnerId), () => resolveSoftwarePolicyServiceWatches(w.deviceId)))
      .toHaveLength(1);
  });

  it('display path: a user context with currentPartnerId null answers null (unknown) by design', async () => {
    await seedSoftwarePolicy({ owner: { orgId: null, partnerId: w.partnerId } });
    const ctx: DbAccessContext = {
      scope: 'organization', orgId: w.orgId, accessibleOrgIds: [w.orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: null,
    };
    expect(await withDbAccessContext(ctx, () => resolveMonitoringConfigForDisplay(w.deviceId, w.orgId))).toBeNull();
  });

  it('display path: a user context with its partner shows the derived watch', async () => {
    await seedSoftwarePolicy({ owner: { orgId: null, partnerId: w.partnerId } });
    const ctx: DbAccessContext = {
      scope: 'organization', orgId: w.orgId, accessibleOrgIds: [w.orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: w.partnerId,
    };
    const out = await withDbAccessContext(ctx, () => resolveMonitoringConfigForDisplay(w.deviceId, w.orgId));
    expect(out?.watches.map((x) => x.name)).toEqual(['ctrld']);
  });
});

describe('compliance worker catalog-version read honours catalog reachability (#6958 PR E3)', () => {
  beforeEach(async () => {
    w = await seedWorld();
  });

  async function catalogWithLatest(owner: { orgId: string | null; partnerId: string | null }, deleted = false): Promise<string> {
    return sys(async () => {
      const [catalog] = await db.insert(softwareCatalog).values({
        orgId: owner.orgId, partnerId: owner.partnerId, name: `svc cat ${Math.random()}`,
        ...(deleted ? { deletedAt: new Date() } : {}),
      } as never).returning({ id: softwareCatalog.id });
      await db.insert(softwareVersions).values({
        catalogId: catalog!.id, version: '1.0.0', isLatest: true, supportedOs: ['windows'],
        detectionRules: [{ type: 'service_running', serviceName: 'ctrld' }],
      } as never);
      return catalog!.id;
    });
  }

  it('returns own-org and same-partner partner-wide items, never another tenant\'s or a deleted one', async () => {
    const own = await catalogWithLatest({ orgId: w.orgId, partnerId: null });
    const partnerWide = await catalogWithLatest({ orgId: null, partnerId: w.partnerId });
    const foreignOrg = await catalogWithLatest({ orgId: w.otherOrgId, partnerId: null });
    const foreignPartner = await catalogWithLatest({ orgId: null, partnerId: w.otherPartnerId });
    const deleted = await catalogWithLatest({ orgId: w.orgId, partnerId: null }, true);

    const rows = await sys(() => loadServiceBridgeVersions(
      'allowlist',
      [own, partnerWide, foreignOrg, foreignPartner, deleted].map((catalogId) => ({ name: catalogId, catalogId })),
      [w.orgId],
    ));
    expect((rows ?? []).map((r) => [r.catalogId, r.orgId]).sort()).toEqual([[own, w.orgId], [partnerWide, w.orgId]].sort());
  });

  it('a foreign org is reachable only for that org\'s own devices', async () => {
    const foreignOrg = await catalogWithLatest({ orgId: w.otherOrgId, partnerId: null });
    const rows = await sys(() => loadServiceBridgeVersions('allowlist', [{ name: 'x', catalogId: foreignOrg }], [w.orgId, w.otherOrgId]));
    expect((rows ?? []).map((r) => r.orgId)).toEqual([w.otherOrgId]);
  });

  it('no allowlist / no catalogId → null without a read', async () => {
    expect(await sys(() => loadServiceBridgeVersions('blocklist', [{ name: 'x', catalogId: 'y' }], [w.orgId]))).toBeNull();
    expect(await sys(() => loadServiceBridgeVersions('allowlist', [{ name: 'x' }], [w.orgId]))).toBeNull();
  });
});
