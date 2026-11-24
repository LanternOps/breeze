/**
 * #12309 / #11776 (plan W05b K2): Copy a configuration policy through the REAL
 * routes (authMiddleware → requirePermission → requireMfa → handler) on real
 * Postgres, as `breeze_app` under forced RLS, with minted tokens.
 *
 * What only Postgres can prove:
 *  - a copy across organizations stores only references the new owner may link;
 *  - the dry run and the real run agree on what is left behind;
 *  - the copy is inactive, applies nowhere, and round-trips settings it carries;
 *  - an organization admin can copy an MSP-managed policy that applies to it,
 *    and gets a 404 for one that does not;
 *  - a refusal mapped to a 4xx after the first write rolls the whole copy back
 *    (the writes are in one savepoint; the request transaction still commits).
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/configPolicyCopy.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { warrantyHpCmslCollectionEffective } from '@breeze/shared/validators';
import { configPolicyRoutes } from '../../routes/configurationPolicies';
import {
  backupProfiles,
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  monitorDefinitions,
  patchPolicies,
  scripts,
  softwarePolicies,
} from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { shutdownPeripheralJobs } from '../../jobs/peripheralJobs';
import { shutdownPolicyEvaluationWorker } from '../../jobs/policyEvaluationWorker';
import { closeRedis } from '../../services/redis';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

// Lets one case make the SECOND link write of a copy fail with an error the
// copy maps to a 400, after the policy row and the first link were written.
const failure = vi.hoisted(() => ({ onCall: 0, calls: 0 }));
vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    addFeatureLink: (async (...args: Parameters<typeof original.addFeatureLink>) => {
      failure.calls += 1;
      if (failure.onCall > 0 && failure.calls === failure.onCall) {
        throw new original.WarrantyConsentError('forced failure for the rollback case');
      }
      return original.addFeatureLink(...args);
    }) as typeof original.addFeatureLink,
  };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

afterAll(async () => {
  await shutdownPeripheralJobs();
  await shutdownPolicyEvaluationWorker();
  await closeRedis();
});

beforeEach(() => {
  failure.onCall = 0;
  failure.calls = 0;
});

const ALL = [
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
];

function buildApp(): Hono {
  const app = new Hono();
  app.route('/configuration-policies', configPolicyRoutes);
  return app;
}

function call(app: Hono, token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const WRITE_NO_EXECUTE = ALL.filter((p) => p.action !== 'execute');

async function partnerToken(partnerId: string, permissions = ALL) {
  const user = await createUser({ partnerId, orgId: null, email: `copy-p-${randomUUID().slice(0, 8)}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, permissions);
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, scope: 'partner',
    orgId: null, partnerId, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

async function orgToken(partnerId: string, orgId: string) {
  const user = await createUser({ partnerId, orgId, email: `copy-o-${randomUUID().slice(0, 8)}@example.test` });
  const role = await createRole({ scope: 'organization', orgId, partnerId });
  await grantRolePermissions(role.id, ALL);
  await assignUserToOrganization(user.id, orgId, role.id);
  // A real org session carries its org's partner (bindOrganizationSessionPartner).
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, scope: 'organization',
    orgId, partnerId, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const token = await partnerToken(partner.id);
  const db = getTestDb() as any;
  const [ring] = await db.insert(patchPolicies)
    .values({ partnerId: partner.id, kind: 'ring', name: `Ring ${randomUUID().slice(0, 6)}`, enabled: true })
    .returning({ id: patchPolicies.id });
  const [orgSoftware] = await db.insert(softwarePolicies)
    .values({ orgId: orgA.id, name: `Org A software ${randomUUID().slice(0, 6)}`, mode: 'allowlist', rules: { software: [{ name: 'Seeded' }] } })
    .returning({ id: softwarePolicies.id });
  const [orgMonitor] = await db.insert(monitorDefinitions)
    .values({ orgId: orgA.id, name: `copy-${randomUUID()}`, kind: 'service', condition: { serviceName: 'Spooler' }, severity: 'high' })
    .returning({ id: monitorDefinitions.id });
  const [partnerMonitor] = await db.insert(monitorDefinitions)
    .values({ orgId: null, partnerId: partner.id, name: `copy-p-${randomUUID()}`, kind: 'service', condition: { serviceName: 'W32Time' }, severity: 'high' })
    .returning({ id: monitorDefinitions.id });
  return {
    partner, orgA, orgB, token,
    ringId: ring.id as string,
    orgSoftwareId: orgSoftware.id as string,
    orgMonitorId: orgMonitor.id as string,
    partnerMonitorId: partnerMonitor.id as string,
  };
}

async function createPolicy(app: Hono, token: string, body: Record<string, unknown>): Promise<string> {
  const res = await call(app, token, 'POST', '/configuration-policies', { status: 'active', ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function addLink(app: Hono, token: string, policyId: string, link: Record<string, unknown>) {
  const res = await call(app, token, 'POST', `/configuration-policies/${policyId}/features`, link);
  expect(res.status, `${String(link.featureType)}: ${await res.clone().text()}`).toBe(201);
}

async function linksOf(policyId: string) {
  return (getTestDb() as any)
    .select({
      featureType: configPolicyFeatureLinks.featureType,
      featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
    })
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.configPolicyId, policyId)) as Promise<Array<{ featureType: string; featurePolicyId: string | null }>>;
}

async function policyRow(policyId: string) {
  const [row] = await (getTestDb() as any)
    .select()
    .from(configurationPolicies)
    .where(eq(configurationPolicies.id, policyId));
  return row as { status: string; orgId: string | null; partnerId: string | null; parentPolicyId: string | null; name: string } | undefined;
}

async function assignmentCount(policyId: string) {
  const rows = await (getTestDb() as any)
    .select({ id: configPolicyAssignments.id })
    .from(configPolicyAssignments)
    .where(eq(configPolicyAssignments.configPolicyId, policyId));
  return rows.length as number;
}

describe('POST /configuration-policies/:id/copy on real Postgres (#12309, #11776)', () => {
  runDb('a copy across organizations references only entities the new owner may link', async () => {
    const app = buildApp();
    const f = await seed();
    const sourceId = await createPolicy(app, f.token, { name: 'Workstations', orgId: f.orgA.id });
    await addLink(app, f.token, sourceId, { featureType: 'patch', featurePolicyId: f.ringId, inlineSettings: { sources: ['os'] } });
    await addLink(app, f.token, sourceId, { featureType: 'software_policy', featurePolicyId: f.orgSoftwareId });
    await addLink(app, f.token, sourceId, { featureType: 'monitors', inlineSettings: { items: [{ monitorId: f.orgMonitorId }] } });
    await addLink(app, f.token, sourceId, { featureType: 'event_log', inlineSettings: { retentionDays: 14 } });
    await (getTestDb() as any).insert(configPolicyAssignments).values({ configPolicyId: sourceId, level: 'organization', targetId: f.orgA.id });

    const body = { name: 'Workstations (Birch)', ownerScope: 'organization', orgId: f.orgB.id };
    const dry = await call(app, f.token, 'POST', `/configuration-policies/${sourceId}/copy`, { ...body, dryRun: true });
    expect(dry.status).toBe(200);
    const dryBody = await dry.json() as { carried: string[]; dropped: unknown[] };
    expect(dryBody.carried).toEqual(['event_log', 'patch']);

    const res = await call(app, f.token, 'POST', `/configuration-policies/${sourceId}/copy`, body);
    expect(res.status, await res.clone().text()).toBe(201);
    const copy = await res.json() as { policyId: string; orgId: string; dropped: unknown[] };
    // The dry run and the real run leave the same features behind.
    expect(copy.dropped).toEqual(dryBody.dropped);
    expect(copy.dropped).toEqual([
      { featureType: 'monitors', reason: 'linked_item_unavailable' },
      { featureType: 'software_policy', reason: 'linked_item_unavailable' },
    ]);
    expect(copy.orgId).toBe(f.orgB.id);

    const row = await policyRow(copy.policyId);
    expect(row).toMatchObject({ status: 'inactive', orgId: f.orgB.id, partnerId: null, name: 'Workstations (Birch)' });
    expect(await assignmentCount(copy.policyId)).toBe(0);

    // Every stored reference belongs to the new owner's side: the ring is the
    // partner's; nothing of org A is linked.
    const links = await linksOf(copy.policyId);
    expect(links.map((l) => l.featureType).sort()).toEqual(['event_log', 'patch']);
    expect(links.find((l) => l.featureType === 'patch')?.featurePolicyId).toBe(f.ringId);
    const [ring] = await (getTestDb() as any).select({ partnerId: patchPolicies.partnerId }).from(patchPolicies).where(eq(patchPolicies.id, f.ringId));
    expect(ring.partnerId).toBe(f.partner.id);
    expect(links.some((l) => l.featurePolicyId === f.orgSoftwareId)).toBe(false);

    // The settings it carried read back the same.
    const features = await call(app, f.token, 'GET', `/configuration-policies/${copy.policyId}/features`);
    const data = (await features.json() as { data: Array<{ featureType: string; inlineSettings: Record<string, unknown> }> }).data;
    expect(data.find((l) => l.featureType === 'event_log')?.inlineSettings).toMatchObject({ retentionDays: 14 });
  });

  runDb('a copy to MSP-managed drops OneDrive Helper and org-owned links, and the dry run says so first', async () => {
    const app = buildApp();
    const f = await seed();
    const sourceId = await createPolicy(app, f.token, { name: 'Acme desks', orgId: f.orgA.id });
    await addLink(app, f.token, sourceId, { featureType: 'onedrive_helper', inlineSettings: { libraries: [] } });
    await addLink(app, f.token, sourceId, { featureType: 'software_policy', featurePolicyId: f.orgSoftwareId });
    await addLink(app, f.token, sourceId, { featureType: 'monitors', inlineSettings: { items: [{ monitorId: f.partnerMonitorId }] } });

    const body = { name: 'MSP desks', ownerScope: 'partner' };
    const dry = await (await call(app, f.token, 'POST', `/configuration-policies/${sourceId}/copy`, { ...body, dryRun: true })).json();
    const res = await call(app, f.token, 'POST', `/configuration-policies/${sourceId}/copy`, body);
    expect(res.status, await res.clone().text()).toBe(201);
    const copy = await res.json() as { policyId: string; dropped: unknown[] };

    expect(dry).toEqual({
      dryRun: true,
      carried: ['monitors'],
      // In feature-type order, whatever order the links are read in.
      dropped: [
        { featureType: 'onedrive_helper', reason: 'org_only_feature' },
        { featureType: 'software_policy', reason: 'linked_item_unavailable' },
      ],
      notices: [],
    });
    expect(copy.dropped).toEqual((dry as { dropped: unknown[] }).dropped);
    expect(await policyRow(copy.policyId)).toMatchObject({ status: 'inactive', orgId: null, partnerId: f.partner.id });
    expect((await linksOf(copy.policyId)).map((l) => l.featureType)).toEqual(['monitors']);
  });

  runDb('a same-owner copy carries every feature it can, with the same settings', async () => {
    const app = buildApp();
    const f = await seed();
    const parentId = await createPolicy(app, f.token, { name: 'Baseline', orgId: f.orgA.id });
    const sourceId = await createPolicy(app, f.token, { name: 'Servers', orgId: f.orgA.id, parentPolicyId: parentId });
    const sourceLinks = [
      { featureType: 'patch', featurePolicyId: f.ringId, inlineSettings: { sources: ['os', 'third_party'], scheduleFrequency: 'weekly', scheduleDayOfWeek: 'tue' } },
      { featureType: 'monitors', inlineSettings: { items: [{ monitorId: f.orgMonitorId }, { monitorId: f.partnerMonitorId, enabled: false }], checkIntervalSeconds: 120 } },
      { featureType: 'event_log', inlineSettings: { retentionDays: 60, minimumLevel: 'warning' } },
      { featureType: 'software_policy', featurePolicyId: f.orgSoftwareId },
      { featureType: 'remote_access', inlineSettings: { webrtcDesktop: true, vncRelay: false } },
      { featureType: 'helper', inlineSettings: { enabled: true } },
      { featureType: 'onedrive_helper', inlineSettings: { libraries: [] } },
      { featureType: 'warranty', inlineSettings: { enabled: true, hpCmsl: { enabled: true } } },
      { featureType: 'security', inlineSettings: { autoQuarantine: false } },
    ];
    for (const link of sourceLinks) await addLink(app, f.token, sourceId, link);

    const res = await call(app, f.token, 'POST', `/configuration-policies/${sourceId}/copy`, { name: 'Servers (copy)', ownerScope: 'organization', orgId: f.orgA.id });
    expect(res.status, await res.clone().text()).toBe(201);
    const copy = await res.json() as { policyId: string; dropped: unknown[] };
    expect(copy.dropped).toEqual([]);
    // Omitted parentPolicyId keeps the source's parent.
    expect(await policyRow(copy.policyId)).toMatchObject({ status: 'inactive', parentPolicyId: parentId });

    const read = async (id: string) => {
      const r = await call(app, f.token, 'GET', `/configuration-policies/${id}/features`);
      const rows = (await r.json() as { data: Array<Record<string, unknown>> }).data;
      return Object.fromEntries(rows.map((l) => [l.featureType as string, { featurePolicyId: l.featurePolicyId, inlineSettings: l.inlineSettings }]));
    };
    const before = await read(sourceId);
    const after = await read(copy.policyId);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const featureType of Object.keys(before)) {
      if (featureType === 'warranty') continue;
      expect(after[featureType], featureType).toEqual(before[featureType]);
    }
    // HP collection is copied off, with no licence acceptance (its own case below).
    expect(after.warranty!.inlineSettings).toEqual({ enabled: true, hpCmsl: { enabled: false } });
  });

  runDb('copy does not carry or record HP licence consent', async () => {
    const app = buildApp();
    const f = await seed();
    // The source's HP collection is on, accepted by the partner admin.
    const sourceId = await createPolicy(app, f.token, { name: 'HP fleet', orgId: f.orgA.id });
    await addLink(app, f.token, sourceId, { featureType: 'warranty', inlineSettings: { enabled: true, warnDays: 60, criticalDays: 14, hpCmsl: { enabled: true } } });
    const warrantyRow = async (policyId: string) => {
      const [row] = await (getTestDb() as any)
        .select({ id: configPolicyFeatureLinks.id, inlineSettings: configPolicyFeatureLinks.inlineSettings })
        .from(configPolicyFeatureLinks)
        .where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'warranty')));
      return row as { id: string; inlineSettings: Record<string, unknown> };
    };
    const sourceBefore = await warrantyRow(sourceId);
    expect(warrantyHpCmslCollectionEffective(sourceBefore.inlineSettings)).toBe(true);

    // A copier WITHOUT devices.execute: the copy arms nothing, so it may copy.
    const copier = await partnerToken(f.partner.id, WRITE_NO_EXECUTE);
    const body = { name: 'HP fleet (Birch)', ownerScope: 'organization', orgId: f.orgB.id };
    const dryRes = await call(app, copier, 'POST', `/configuration-policies/${sourceId}/copy`, { ...body, dryRun: true });
    expect(dryRes.status, await dryRes.clone().text()).toBe(200);
    const dry = await dryRes.json() as { carried: string[]; dropped: unknown[]; notices: unknown[] };
    expect(dry).toEqual({
      dryRun: true,
      carried: ['warranty'],
      dropped: [],
      notices: [{ featureType: 'warranty', code: 'consent_required' }],
    });

    const res = await call(app, copier, 'POST', `/configuration-policies/${sourceId}/copy`, body);
    expect(res.status, await res.clone().text()).toBe(201);
    const copy = await res.json() as { policyId: string; dropped: unknown[]; notices: unknown[] };
    expect(copy.notices).toEqual(dry.notices);
    expect(copy.dropped).toEqual(dry.dropped);

    // Stored: alert settings kept, HP switched off, no consent key at all.
    const copied = await warrantyRow(copy.policyId);
    expect(copied.inlineSettings).toEqual({ enabled: true, warnDays: 60, criticalDays: 14, hpCmsl: { enabled: false } });
    expect(warrantyHpCmslCollectionEffective(copied.inlineSettings)).toBe(false);
    // The source is untouched.
    expect((await warrantyRow(sourceId)).inlineSettings).toEqual(sourceBefore.inlineSettings);

    // Turning it on in the editor as usual records the acceptance of whoever does it.
    const editor = await partnerToken(f.partner.id);
    const editorSub = (JSON.parse(Buffer.from(editor.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub;
    const patch = await call(app, editor, 'PATCH', `/configuration-policies/${copy.policyId}/features/${copied.id}`, {
      inlineSettings: { enabled: true, warnDays: 60, criticalDays: 14, hpCmsl: { enabled: true } },
    });
    expect(patch.status, await patch.clone().text()).toBe(200);
    const enabled = await warrantyRow(copy.policyId);
    expect(warrantyHpCmslCollectionEffective(enabled.inlineSettings)).toBe(true);
    expect((enabled.inlineSettings.hpCmsl as { consent: { acceptedByUserId: string } }).consent.acceptedByUserId).toBe(editorSub);
  });

  runDb('the rest of the feature types round-trip, and an organization\'s own scripts stay with it', async () => {
    const app = buildApp();
    const f = await seed();
    const db = getTestDb() as any;
    const [script] = await db.insert(scripts).values({
      orgId: f.orgA.id, partnerId: f.partner.id, name: `copy-${randomUUID().slice(0, 8)}`, osTypes: ['windows'], language: 'powershell',
      content: 'Write-Output ok', runAs: 'system', timeoutSeconds: 300,
    }).returning({ id: scripts.id });
    const [profile] = await db.insert(backupProfiles)
      .values({ orgId: null, partnerId: f.partner.id, name: `Profile ${randomUUID().slice(0, 6)}`, selections: {} })
      .returning({ id: backupProfiles.id });

    const sourceId = await createPolicy(app, f.token, { name: 'Everything', orgId: f.orgA.id });
    const sourceLinks = [
      { featureType: 'backup', featurePolicyId: profile.id, inlineSettings: { schedule: { frequency: 'daily', time: '02:00' }, retention: { preset: 'standard' } } },
      { featureType: 'maintenance', inlineSettings: { recurrence: 'weekly', windowStart: '02:00', dayOfWeek: 'sun', durationHours: 2, timezone: 'UTC', suppressAlerts: true, suppressPatching: true, suppressAutomations: false, suppressScripts: false, rebootIfPending: false, notifyOnStart: true, notifyOnEnd: true } },
      { featureType: 'compliance', inlineSettings: { items: [{ name: 'Agent present', enforcementLevel: 'monitor', rules: [{ type: 'required_software', softwareName: 'Contoso Agent', remediation: { type: 'script', scriptId: script.id } }] }] } },
      { featureType: 'automation', inlineSettings: { items: [{ name: 'Nightly', enabled: true, triggerType: 'manual', actions: [{ type: 'run_script', scriptId: script.id }], onFailure: 'stop' }] } },
      { featureType: 'containment', inlineSettings: { version: 1 } },
      { featureType: 'wake_on_lan', inlineSettings: { configureSettings: false, buttonMode: 'verified' } },
      { featureType: 'device_lifecycle', inlineSettings: { purgeRemovedAfterDays: 90 } },
      { featureType: 'system_protection', inlineSettings: { beforePatching: true, beforeScripts: false, beforeSoftwareInstall: false, labelPrefix: 'Breeze' } },
      { featureType: 'pam', inlineSettings: { uacInterceptionEnabled: false } },
      { featureType: 'vulnerability', inlineSettings: { enabled: true } },
      { featureType: 'oem_updates', inlineSettings: { version: 1, enabled: false, schedule: { weekOfMonth: 'first', dayOfWeek: 'sun', windowStart: '02:00', windowHours: 2 }, catchUpNights: 0, reboot: 'never', vendors: {} } },
      { featureType: 'hardware_monitoring', inlineSettings: { enabled: true } },
      { featureType: 'time_sync', inlineSettings: { enforceNtp: false } },
      { featureType: 'workload_inventory', inlineSettings: { enabled: false } },
      { featureType: 'sensitive_data', inlineSettings: { detectionClasses: ['credential'] } },
      // Bound to org A's Microsoft 365 tenant: it stays with org A.
      { featureType: 'onedrive_helper', inlineSettings: { tenantAssociationId: 'acme-tenant', libraries: [{ libraryId: 'lib-1', displayName: 'Shared Documents' }] } },
    ];
    for (const link of sourceLinks) await addLink(app, f.token, sourceId, link);

    const read = async (id: string) => {
      const r = await call(app, f.token, 'GET', `/configuration-policies/${id}/features`);
      const rows = (await r.json() as { data: Array<Record<string, unknown>> }).data;
      return Object.fromEntries(rows.map((l) => [l.featureType as string, { featurePolicyId: l.featurePolicyId, inlineSettings: l.inlineSettings }]));
    };

    // Same owner: everything is carried, with the same settings.
    const same = await call(app, f.token, 'POST', `/configuration-policies/${sourceId}/copy`, { name: 'Everything (copy)', ownerScope: 'organization', orgId: f.orgA.id });
    expect(same.status, await same.clone().text()).toBe(201);
    const sameCopy = await same.json() as { policyId: string; dropped: unknown[] };
    expect(sameCopy.dropped).toEqual([]);
    const before = await read(sourceId);
    const after = await read(sameCopy.policyId);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const featureType of Object.keys(before)) expect(after[featureType], featureType).toEqual(before[featureType]);

    // Another organization: org A's script and Microsoft 365 tenant cannot be used there.
    const body = { name: 'Everything (Birch)', ownerScope: 'organization', orgId: f.orgB.id };
    const dry = await (await call(app, f.token, 'POST', `/configuration-policies/${sourceId}/copy`, { ...body, dryRun: true })).json() as { dropped: unknown[] };
    const other = await call(app, f.token, 'POST', `/configuration-policies/${sourceId}/copy`, body);
    expect(other.status, await other.clone().text()).toBe(201);
    const otherCopy = await other.json() as { policyId: string; dropped: unknown[] };
    expect(otherCopy.dropped).toEqual([
      { featureType: 'automation', reason: 'linked_item_unavailable' },
      { featureType: 'compliance', reason: 'linked_item_unavailable' },
      { featureType: 'onedrive_helper', reason: 'linked_item_unavailable' },
    ]);
    expect(dry.dropped).toEqual(otherCopy.dropped);
    const left = new Set(['automation', 'compliance', 'onedrive_helper']);
    const otherLinks = (await linksOf(otherCopy.policyId)).map((l) => l.featureType).sort();
    expect(otherLinks).toEqual(sourceLinks.map((l) => l.featureType).filter((t) => !left.has(t)).sort());
  });

  runDb('an organization admin copies an MSP-managed policy that applies to it, and cannot read one that does not', async () => {
    const app = buildApp();
    const f = await seed();
    const applies = await createPolicy(app, f.token, { name: 'MSP baseline', ownerScope: 'partner' });
    await (getTestDb() as any).insert(configPolicyAssignments).values({ configPolicyId: applies, level: 'organization', targetId: f.orgA.id });
    const hidden = await createPolicy(app, f.token, { name: 'MSP other', ownerScope: 'partner' });
    await (getTestDb() as any).insert(configPolicyAssignments).values({ configPolicyId: hidden, level: 'organization', targetId: f.orgB.id });
    const admin = await orgToken(f.partner.id, f.orgA.id);

    const ok = await call(app, admin, 'POST', `/configuration-policies/${applies}/copy`, { name: 'Our baseline', ownerScope: 'organization' });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const copy = await ok.json() as { policyId: string };
    expect(await policyRow(copy.policyId)).toMatchObject({ orgId: f.orgA.id, partnerId: null, status: 'inactive' });

    const denied = await call(app, admin, 'POST', `/configuration-policies/${hidden}/copy`, { name: 'Theirs', ownerScope: 'organization', dryRun: true });
    expect(denied.status).toBe(404);

    // Nor can it copy anywhere but its own organization, or to the MSP.
    const elsewhere = await call(app, admin, 'POST', `/configuration-policies/${applies}/copy`, { name: 'X', ownerScope: 'organization', orgId: f.orgB.id });
    expect(elsewhere.status).toBe(403);
    const toMsp = await call(app, admin, 'POST', `/configuration-policies/${applies}/copy`, { name: 'X', ownerScope: 'partner' });
    expect(toMsp.status).toBe(403);
  });

  runDb('a refusal after the first write rolls the whole copy back', async () => {
    const app = buildApp();
    const f = await seed();
    const sourceId = await createPolicy(app, f.token, { name: 'Rollback', orgId: f.orgA.id });
    await addLink(app, f.token, sourceId, { featureType: 'event_log', inlineSettings: { retentionDays: 30 } });
    await addLink(app, f.token, sourceId, { featureType: 'helper', inlineSettings: { enabled: true } });

    failure.calls = 0;
    failure.onCall = 2;
    const name = `Rolled back ${randomUUID().slice(0, 8)}`;
    const res = await call(app, f.token, 'POST', `/configuration-policies/${sourceId}/copy`, { name, ownerScope: 'organization', orgId: f.orgB.id });

    expect(res.status).toBe(400);
    expect(failure.calls).toBe(2);
    // The 400 commits the request transaction; the savepoint is what removed
    // the policy row and the first link.
    const rows = await (getTestDb() as any).select({ id: configurationPolicies.id }).from(configurationPolicies).where(eq(configurationPolicies.name, name));
    expect(rows).toEqual([]);
  });
});
