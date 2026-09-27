/**
 * Sibling readers of `patches.severity`/`.category` wired to the effective
 * per-device overlay (see patchSeverityOverlay.ts and
 * patchReportedSeverityOverlay.integration.test.ts for the overlay itself).
 *
 * `patches.severity`/`.category` only ever carry a trusted-source value —
 * every `microsoft`/`apple`/`linux`/`custom` row starts and stays
 * `'unknown'`/NULL there forever, since no trusted classifier exists for
 * those sources. A reader that filters/displays the raw shared column
 * silently drops or misrepresents the majority of a Windows-heavy fleet's
 * patch volume unless it falls back to the device's own reported value.
 *
 * Prerequisites:
 *   pnpm test-stack up
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/patchSeverityOverlayReaders.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';
import { getTestDb } from './setup';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  devices,
  patches,
  devicePatches,
  patchPolicies,
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, setupTestEnvironment } from './db-utils';
import { generateComplianceSummary } from '../../jobs/patchComplianceReportWorker';
import { computeAndPersistOrgSecurityPosture } from '../../services/securityPosture';
import { generateSecurityCompliancePostureReport } from '../../services/securityComplianceReport';
import type { OrgReportExecutionAuthority } from '../../services/siteScope';
import { windowsOsUpdateCandidates } from '../../services/vulnerabilityRemediation';
import { registerFleetTools } from '../../services/aiToolsFleet';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';
import { updateRingRoutes } from '../../routes/updateRings';
import { Hono } from 'hono';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let agentSeq = 0;
async function seedDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  const tdb = getTestDb();
  agentSeq++;
  const [row] = await tdb
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-overlay-readers-${agentSeq}-${Date.now()}`,
      hostname,
      displayName: hostname,
      osType: 'windows',
      osVersion: '11',
      osBuild: '22631',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row');
  return row.id;
}

/** A `microsoft`-source patch with no trusted classification on the shared row. */
async function seedUnclassifiedMicrosoftPatch(titlePrefix = 'Cumulative Update for Windows'): Promise<string> {
  const tdb = getTestDb();
  const [patch] = await tdb
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `msrc:${randomUUID()}`,
      title: titlePrefix,
      severity: 'unknown',
      category: null,
    })
    .returning({ id: patches.id });
  if (!patch) throw new Error('seedUnclassifiedMicrosoftPatch: no patch');
  return patch.id;
}

async function seedDevicePatch(opts: {
  deviceId: string;
  orgId: string;
  patchId: string;
  status?: 'pending' | 'installed' | 'failed' | 'missing' | 'skipped';
  reportedSeverity?: string | null;
  reportedCategory?: string | null;
}): Promise<void> {
  const tdb = getTestDb();
  await tdb.insert(devicePatches).values({
    deviceId: opts.deviceId,
    orgId: opts.orgId,
    patchId: opts.patchId,
    status: opts.status ?? 'pending',
    reportedSeverity: (opts.reportedSeverity ?? null) as never,
    reportedCategory: opts.reportedCategory ?? null,
    lastCheckedAt: new Date(),
  });
}

describe('patchComplianceReportWorker.generateComplianceSummary — severity filter', () => {
  runDb('counts a pending patch under a severity filter using its device-reported severity', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'compliance-worker-device');
    const patchId = await seedUnclassifiedMicrosoftPatch();
    await seedDevicePatch({ deviceId, orgId: org.id, patchId, reportedSeverity: 'critical' });

    const summary = await withSystemDbAccessContext(() =>
      generateComplianceSummary(org.id, { version: 1, kind: 'unrestricted', orgId: org.id }, null, 'critical' as never),
    );

    expect(summary.total).toBe(1);
    expect(summary.pending).toBe(1);
  });
});

describe('securityPosture.computeAndPersistOrgSecurityPosture — patch_compliance factor', () => {
  runDb('scores a device-reported-critical outstanding patch as non-compliant, not "no telemetry"', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'posture-device');
    const patchId = await seedUnclassifiedMicrosoftPatch();
    await seedDevicePatch({ deviceId, orgId: org.id, patchId, reportedSeverity: 'critical' });

    const result = await withSystemDbAccessContext(() => computeAndPersistOrgSecurityPosture(org.id));
    const item = result.devices.find((d) => d.deviceId === deviceId);
    if (!item) throw new Error('device posture missing');

    // scorePatchCompliance: total<=0 => 100 ("no telemetry"); the pending,
    // reported-critical patch must count toward the total and NOT be installed.
    expect(item.factors.patch_compliance.evidence).toEqual({
      totalCriticalAndImportant: 1,
      installedCriticalAndImportant: 0,
    });
    expect(item.factors.patch_compliance.score).toBe(0);
  });
});

describe('securityComplianceReport.generateSecurityCompliancePostureReport — patch currency', () => {
  runDb('a device with only a reported-critical pending patch is not counted "patch current"', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'compliance-report-device');
    const patchId = await seedUnclassifiedMicrosoftPatch();
    await seedDevicePatch({ deviceId, orgId: org.id, patchId, reportedSeverity: 'critical' });

    const authority: OrgReportExecutionAuthority = {
      principalKind: 'user',
      scope: { version: 1, kind: 'unrestricted', orgId: org.id },
      principalUserId: randomUUID(),
      capturedAt: new Date(),
      fingerprint: 'f'.repeat(64),
    };

    const result = await withSystemDbAccessContext(() =>
      generateSecurityCompliancePostureReport(org.id, {}, authority),
    );

    const controls = (result.summary as { controls: { patchCurrentPct: number | null } }).controls;
    expect(controls.patchCurrentPct).toBe(0);
  });
});

describe('vulnerabilityRemediation.windowsOsUpdateCandidates — category fallback', () => {
  runDb('finds a pending microsoft security update by its device-reported category', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'os-update-candidate-device');
    const patchId = await seedUnclassifiedMicrosoftPatch('Cumulative Update for Windows 11');
    await seedDevicePatch({ deviceId, orgId: org.id, patchId, reportedCategory: 'security' });

    const candidates = await withSystemDbAccessContext(() => windowsOsUpdateCandidates([deviceId]));

    expect(candidates.get(deviceId) ?? []).toContain(patchId);
  });
});

function authFor(orgId: string): AuthContext {
  return {
    principal: { kind: 'api_key', apiKeyId: randomUUID() },
    user: { id: randomUUID(), email: 'operator@example.test', name: 'Operator', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (column) => eq(column, orgId),
    canAccessOrg: (candidate) => candidate === orgId,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
  } as AuthContext;
}

describe('aiToolsFleet manage_patches:list — severity filter/display', () => {
  runDb('per-device list filters and displays the device-reported severity', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'ai-fleet-device');
    const patchId = await seedUnclassifiedMicrosoftPatch();
    await seedDevicePatch({ deviceId, orgId: org.id, patchId, reportedSeverity: 'critical' });

    const tools = new Map<string, AiTool>();
    registerFleetTools(tools);
    const tool = tools.get('manage_patches')!;
    const auth = authFor(org.id);

    const raw = await withDbAccessContext(
      { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
      () => tool.handler({ action: 'list', deviceId, severity: 'critical' }, auth, {}),
    );
    const body = JSON.parse(raw);
    expect(body.patches.map((p: { id: string }) => p.id)).toContain(patchId);
    const row = body.patches.find((p: { id: string }) => p.id === patchId);
    expect(row.severity).toBe('critical');
  });

  runDb('org-wide list filters by the device-reported severity across the org fleet', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const deviceId = await seedDevice(org.id, site.id, 'ai-fleet-orgwide-device');
    const patchId = await seedUnclassifiedMicrosoftPatch();
    await seedDevicePatch({ deviceId, orgId: org.id, patchId, reportedSeverity: 'critical' });

    const tools = new Map<string, AiTool>();
    registerFleetTools(tools);
    const tool = tools.get('manage_patches')!;
    const auth = authFor(org.id);

    const raw = await withDbAccessContext(
      { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
      () => tool.handler({ action: 'list', severity: 'critical' }, auth, {}),
    );
    const body = JSON.parse(raw);
    expect(body.patches.map((p: { id: string }) => p.id)).toContain(patchId);
  });
});

async function linkPolicyToRing(opts: {
  ringId: string;
  partnerId: string;
  orgId: string;
}): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: opts.orgId,
        partnerId: null,
        name: `cfg-${randomUUID().slice(0, 8)}`,
        status: 'active',
      })
      .returning({ id: configurationPolicies.id });
    if (!policy) throw new Error('failed to seed config policy');
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy.id,
      featureType: 'patch',
      featurePolicyId: opts.ringId,
    });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy.id,
      level: 'organization',
      targetId: opts.orgId,
    });
  });
}

describe('GET /update-rings/:id/patches — severity filter/display', () => {
  runDb('filters and displays a ring device\'s reported severity for an unclassified shared patch', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const site = await createSite({ orgId: env.organization.id });
    const deviceId = await seedDevice(env.organization.id, site.id, 'ring-patches-device');
    const patchId = await seedUnclassifiedMicrosoftPatch();
    await seedDevicePatch({ deviceId, orgId: env.organization.id, patchId, reportedSeverity: 'critical' });

    const [ring] = await withSystemDbAccessContext(() =>
      db.insert(patchPolicies).values({
        partnerId: env.partner.id,
        kind: 'ring',
        name: `ring-${randomUUID().slice(0, 8)}`,
      }).returning({ id: patchPolicies.id }),
    );
    if (!ring) throw new Error('failed to seed ring');
    await linkPolicyToRing({ ringId: ring.id, partnerId: env.partner.id, orgId: env.organization.id });

    const app = new Hono();
    app.route('/update-rings', updateRingRoutes);

    const res = await app.request(`/update-rings/${ring.id}/patches?severity=critical`, {
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data.find((p: { id: string }) => p.id === patchId);
    expect(row).toBeDefined();
    expect(row.severity).toBe('critical');
  });
});
