/**
 * YARA rule-set delivery on real Postgres (#6263 W03a).
 *
 *  1. Partner-Wide First step 5: a P1 partner-wide security policy whose
 *     `ruleSetIds` name a P1 partner-wide set and the built-in pack resolves
 *     refs for a device in O1a AND a device in O1b — both under each device's
 *     own agent RLS context and under the dispatch worker's system context.
 *  2. The resolver's device-ownership backstop: a foreign tenant's set id that
 *     reached a policy anyway never resolves, even in system scope.
 *  3. The policy write gate against real rows (org vs partner-wide policies).
 *  4. The agent fetch route under the agent's real RLS context: attached ->
 *     bundle bytes; visible-but-unattached partner-wide set -> 404 (W03-d);
 *     stale version -> 409.
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { buildYaraBundleJson, YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
  organizations,
  partners,
  sites,
  yaraRuleSets,
} from '../../db/schema';
import { resolveSecurityScanPolicyForDevice } from '../../services/featureConfigResolver';
import { MIN_AGENT_VERSION_YARA_SCAN, planYaraScan } from '../../services/yaraScanRefs';
import { checkSecurityRuleSetsWrite } from '../../routes/configurationPolicies/securityRuleSetGate';
import { agentYaraRuleSetRoutes } from '../../routes/agents/yaraRuleSets';

const u = () => randomUUID().slice(0, 8);

function agentCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

async function publishedSet(values: { orgId?: string | null; partnerId?: string | null; isBuiltin?: boolean; id?: string; name: string }, version = 1) {
  return withSystemDbAccessContext(async () => {
    const id = values.id ?? randomUUID();
    const json = buildYaraBundleJson({ ruleSetId: id, version, autoQuarantine: false, rules: [] });
    const bytes = Buffer.from(json, 'utf8');
    await db.insert(yaraRuleSets).values({
      id,
      orgId: values.orgId ?? null,
      partnerId: values.partnerId ?? null,
      isBuiltin: values.isBuiltin ?? false,
      source: values.isBuiltin ? 'builtin' : 'custom',
      name: values.name,
      currentVersion: version,
      publishedVersion: version,
      publishedBundle: bytes,
      publishedSha256: createHash('sha256').update(bytes).digest('hex'),
    }).onConflictDoNothing();
    return { id, bytes };
  });
}

async function seedOrgWithDevice(partnerId: string) {
  return withSystemDbAccessContext(async () => {
    const s = u();
    const [org] = await db.insert(organizations).values({
      currencyCode: 'USD', partnerId, name: `Yara Org ${s}`, slug: `yara-org-${s}`, type: 'customer', status: 'active',
    }).returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: org!.id, name: `Yara Site ${s}` }).returning({ id: sites.id });
    const agentId = `yara-agent-${s}`;
    const [device] = await db.insert(devices).values({
      orgId: org!.id, siteId: site!.id, agentId, hostname: `yara-host-${s}`, osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: MIN_AGENT_VERSION_YARA_SCAN, status: 'online',
    }).returning({ id: devices.id });
    return { orgId: org!.id, deviceId: device!.id, agentId };
  });
}

async function seedPartner() {
  return withSystemDbAccessContext(async () => {
    const s = u();
    const [p] = await db.insert(partners).values({ name: `Yara Partner ${s}`, slug: `yara-partner-${s}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    return p!.id;
  });
}

async function partnerWideSecurityPolicy(partnerId: string, ruleSetIds: string[]) {
  return withSystemDbAccessContext(async () => {
    const [policy] = await db.insert(configurationPolicies)
      .values({ orgId: null, partnerId, name: `Yara policy ${u()}`, status: 'active' })
      .returning({ id: configurationPolicies.id });
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'security', inlineSettings: { scheduledScans: true, ruleSetIds },
    });
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'partner', targetId: partnerId, priority: 0 });
    return policy!.id;
  });
}

let builtin: { id: string; bytes: Buffer };

beforeAll(async () => {
  builtin = await publishedSet({ id: YARA_BUILTIN_RULE_SET_ID, isBuiltin: true, name: 'Built-in pack' }, 5);
});

afterAll(async () => {
  await withSystemDbAccessContext(() => db.delete(yaraRuleSets).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)));
});

describe('YARA rule-set refs: partner-wide fan-out (Partner-Wide First step 5)', () => {
  it('a P1 partner-wide set on a P1 partner policy resolves for devices in BOTH O1a and O1b', async () => {
    // cleanupDatabase() truncates between tests; the built-in row has no
    // tenant FK, so re-ensure it in case a sibling suite removed it.
    builtin = await publishedSet({ id: YARA_BUILTIN_RULE_SET_ID, isBuiltin: true, name: 'Built-in pack' }, 5);
    const P1 = await seedPartner();
    const setP1 = await publishedSet({ partnerId: P1, name: 'P1 baseline' }, 3);
    await partnerWideSecurityPolicy(P1, [setP1.id, YARA_BUILTIN_RULE_SET_ID]);
    const a = await seedOrgWithDevice(P1);
    const b = await seedOrgWithDevice(P1);
    expect(a.orgId).not.toBe(b.orgId);

    for (const dev of [a, b]) {
      // The agent's own context (what the fetch route and heartbeat see).
      const viaAgent = await withDbAccessContext(agentCtx(dev.orgId, P1), async () => {
        const policy = await resolveSecurityScanPolicyForDevice(dev.deviceId);
        return planYaraScan({ deviceId: dev.deviceId, agentVersion: MIN_AGENT_VERSION_YARA_SCAN, ruleSetIds: policy?.settings.ruleSetIds ?? [] });
      });
      // The dispatch worker's system context.
      const viaWorker = await withSystemDbAccessContext(async () => {
        const policy = await resolveSecurityScanPolicyForDevice(dev.deviceId);
        return planYaraScan({ deviceId: dev.deviceId, agentVersion: MIN_AGENT_VERSION_YARA_SCAN, ruleSetIds: policy?.settings.ruleSetIds ?? [] });
      });
      for (const plan of [viaAgent, viaWorker]) {
        expect(plan.engine).toBe('yara');
        expect(plan.ruleSetErrors).toBeNull();
        expect(plan.ruleSets).toEqual([
          { id: setP1.id, version: 3, sha256: createHash('sha256').update(setP1.bytes).digest('hex'), url: `/api/v1/agents/${dev.agentId}/yara/rule-sets/${setP1.id}/3` },
          { id: YARA_BUILTIN_RULE_SET_ID, version: 5, sha256: createHash('sha256').update(builtin.bytes).digest('hex'), url: `/api/v1/agents/${dev.agentId}/yara/rule-sets/${YARA_BUILTIN_RULE_SET_ID}/5` },
        ]);
      }
    }
  });

  it('a foreign tenant\'s set id that reached a policy never resolves, even in system scope', async () => {
    const P1 = await seedPartner();
    const P2 = await seedPartner();
    const dev = await seedOrgWithDevice(P1);
    const foreignOrg = await seedOrgWithDevice(P2);
    const foreign = await publishedSet({ orgId: foreignOrg.orgId, name: 'foreign' });
    const foreignPw = await publishedSet({ partnerId: P2, name: 'foreign partner-wide' });

    const plan = await withSystemDbAccessContext(() =>
      planYaraScan({ deviceId: dev.deviceId, agentVersion: MIN_AGENT_VERSION_YARA_SCAN, ruleSetIds: [foreign.id, foreignPw.id] }));
    expect(plan).toEqual({
      ruleSets: [],
      engine: 'legacy',
      ruleSetErrors: [{ id: foreign.id, code: 'not_found' }, { id: foreignPw.id, code: 'not_found' }],
    });
  });
});

describe('policy rule-set write gate (real rows)', () => {
  it('org policy: own-org, own partner-wide and built-in attach; a sibling org\'s set does not', async () => {
    const P1 = await seedPartner();
    const a = await seedOrgWithDevice(P1);
    const b = await seedOrgWithDevice(P1);
    await publishedSet({ id: YARA_BUILTIN_RULE_SET_ID, isBuiltin: true, name: 'Built-in pack' }, 5);
    const own = await publishedSet({ orgId: a.orgId, name: 'own' });
    const pw = await publishedSet({ partnerId: P1, name: 'pw' });
    const sibling = await publishedSet({ orgId: b.orgId, name: 'sibling' });
    const partnerCtx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [a.orgId, b.orgId], accessiblePartnerIds: [P1], userId: null, currentPartnerId: P1,
    };

    await withDbAccessContext(partnerCtx, async () => {
      await expect(checkSecurityRuleSetsWrite({ orgId: a.orgId, partnerId: null }, { ruleSetIds: [own.id, pw.id, YARA_BUILTIN_RULE_SET_ID] }))
        .resolves.toEqual({ ok: true });
      await expect(checkSecurityRuleSetsWrite({ orgId: a.orgId, partnerId: null }, { ruleSetIds: [own.id, sibling.id] }))
        .resolves.toMatchObject({ ok: false, body: { ruleSetIds: [sibling.id] } });
    });
  });

  it('partner-wide policy: partner-wide + built-in attach; an org set never does', async () => {
    const P1 = await seedPartner();
    const a = await seedOrgWithDevice(P1);
    await publishedSet({ id: YARA_BUILTIN_RULE_SET_ID, isBuiltin: true, name: 'Built-in pack' }, 5);
    const own = await publishedSet({ orgId: a.orgId, name: 'org set' });
    const pw = await publishedSet({ partnerId: P1, name: 'pw' });
    const partnerCtx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [a.orgId], accessiblePartnerIds: [P1], userId: null, currentPartnerId: P1,
    };

    await withDbAccessContext(partnerCtx, async () => {
      await expect(checkSecurityRuleSetsWrite({ orgId: null, partnerId: P1 }, { ruleSetIds: [pw.id, YARA_BUILTIN_RULE_SET_ID] }))
        .resolves.toEqual({ ok: true });
      await expect(checkSecurityRuleSetsWrite({ orgId: null, partnerId: P1 }, { ruleSetIds: [pw.id, own.id] }))
        .resolves.toMatchObject({ ok: false, body: { ruleSetIds: [own.id] } });
    });
  });
});

describe('agent fetch route under the agent\'s real RLS context', () => {
  function appFor(dev: { orgId: string; agentId: string }, partnerId: string) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent' as never, { role: 'agent', agentId: dev.agentId, orgId: dev.orgId } as never);
      await withDbAccessContext(agentCtx(dev.orgId, partnerId), () => next());
    });
    app.route('/api/v1/agents', agentYaraRuleSetRoutes);
    return app;
  }

  it('attached -> exact bytes; unattached partner-wide -> 404; stale version -> 409', async () => {
    const P1 = await seedPartner();
    const attached = await publishedSet({ partnerId: P1, name: 'attached' }, 2);
    const unattached = await publishedSet({ partnerId: P1, name: 'unattached' }, 1);
    await partnerWideSecurityPolicy(P1, [attached.id]);
    const dev = await seedOrgWithDevice(P1);
    const app = appFor(dev, P1);

    const ok = await app.request(`/api/v1/agents/${dev.agentId}/yara/rule-sets/${attached.id}/2`);
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(attached.bytes)).toBe(true);
    expect(ok.headers.get('ETag')).toBe(`"${createHash('sha256').update(attached.bytes).digest('hex')}"`);

    expect((await app.request(`/api/v1/agents/${dev.agentId}/yara/rule-sets/${unattached.id}/1`)).status).toBe(404);
    expect((await app.request(`/api/v1/agents/${dev.agentId}/yara/rule-sets/${attached.id}/1`)).status).toBe(409);
  });

  it('a set attached by policy but owned by another partner is invisible under RLS -> 404', async () => {
    const P1 = await seedPartner();
    const P2 = await seedPartner();
    const foreign = await publishedSet({ partnerId: P2, name: 'foreign' }, 1);
    await partnerWideSecurityPolicy(P1, [foreign.id]); // bypasses the gate on purpose
    const dev = await seedOrgWithDevice(P1);
    expect((await appFor(dev, P1).request(`/api/v1/agents/${dev.agentId}/yara/rule-sets/${foreign.id}/1`)).status).toBe(404);
  });
});
