import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  deviceCommands,
  devicePatches,
  devices,
  deviceVulnerabilities,
  patchApprovals,
  patches,
  softwareInventory,
  softwareProductResolutions,
  softwareProducts,
  softwareVulnerabilities,
  vulnerabilities,
  vulnerabilitySources,
} from '../../db/schema';
import { vulnerabilityRoutes } from '../../routes/vulnerabilities';
import { createAccessToken } from '../../services/jwt';
import { getTestDb } from './setup';
import { setupTestEnvironment, type TestEnvironment } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/vulnerabilities', vulnerabilityRoutes);
  return app;
}

async function mfaHeaders(env: TestEnvironment): Promise<Record<string, string>> {
  // setupTestEnvironment issues an mfa:false token; the remediate route requires
  // requireMfa(), so forge an mfa-satisfied token for the same user/role/org.
  const token = await createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    // Epoch claims (core-auth PR 1): authMiddleware rejects access tokens
    // missing aep/mep/sid or stale vs users.auth_epoch/mfa_epoch (DB default 1).
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(async () => {
  await withSystemDbAccessContext(async () => {
    await db.delete(deviceVulnerabilities);
    await db.delete(softwareVulnerabilities);
    await db.delete(softwareProductResolutions);
    await db.delete(softwareProducts);
    await db.delete(vulnerabilities);
    await db.delete(vulnerabilitySources);
  });
});

async function seedDevice(env: TestEnvironment): Promise<string> {
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: uniq('rem-agent'),
      hostname: uniq('rem-host'),
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('failed to seed device');
  return device.id;
}

async function seedVuln(cveId: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(vulnerabilities)
    .values({
      cveId,
      source: 'msrc',
      description: `${cveId} remediation test`,
      severity: 'critical',
      cvssVersion: '3.1',
      cvssScore: '9.8',
      knownExploited: true,
      patchAvailable: true,
      rawPayload: { test: true },
    })
    .returning({ id: vulnerabilities.id });
  if (!row) throw new Error('failed to seed vulnerability');
  return row.id;
}

async function seedDeviceVuln(
  orgId: string,
  deviceId: string,
  vulnerabilityId: string,
  softwareInventoryId?: string,
): Promise<string> {
  const [row] = await getTestDb()
    .insert(deviceVulnerabilities)
    .values({
      orgId,
      deviceId,
      vulnerabilityId,
      softwareInventoryId: softwareInventoryId ?? null,
      status: 'open',
      riskScore: '100.00',
      detectedAt: new Date('2026-06-23T12:00:00Z'),
    })
    .returning({ id: deviceVulnerabilities.id });
  if (!row) throw new Error('failed to seed device vulnerability');
  return row.id;
}

/** Full remediable state: device + open device-vuln + a pending, non-superseded
 *  patch advertising the CVE + (optionally) a partner-wide approval. */
async function seedRemediableDeviceVuln(opts: { cveId: string; approved?: boolean }): Promise<{
  env: TestEnvironment;
  orgId: string;
  deviceId: string;
  dvId: string;
}> {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const deviceId = await seedDevice(env);
  const vulnerabilityId = await seedVuln(opts.cveId);
  const dvId = await seedDeviceVuln(env.organization.id, deviceId, vulnerabilityId);

  const [patch] = await getTestDb()
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: uniq('KB'),
      title: 'Cumulative security update',
      severity: 'critical',
      cveIds: [opts.cveId],
      supersededBy: null,
      releaseDate: '2026-06-01',
    })
    .returning({ id: patches.id });
  if (!patch) throw new Error('failed to seed patch');

  await getTestDb().insert(devicePatches).values({
    deviceId,
    orgId: env.organization.id,
    patchId: patch.id,
    status: 'pending',
  });

  if (opts.approved !== false) {
    await getTestDb().insert(patchApprovals).values({
      partnerId: env.partner.id,
      patchId: patch.id,
      status: 'approved',
    });
  }

  return { env, orgId: env.organization.id, deviceId, dvId };
}

/**
 * Third-party finding shape: the finding is tied to an installed-software row
 * and the device has a pending winget-style patch for the same product that
 * does NOT advertise the CVE (cveIds empty — the production norm, since only
 * OSV-enriched catalog packages ever get cveIds). Remediation must fall back
 * to product-identity matching.
 */
async function seedThirdPartyFinding(opts: {
  cveId: string;
  patchTitle?: string;
  patchVersion?: string;
  extraPatch?: { title: string; packageId: string };
  vulnerableRange?: { versionEndExcluding: string };
  approved?: boolean;
}): Promise<{ env: TestEnvironment; orgId: string; deviceId: string; dvId: string }> {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const deviceId = await seedDevice(env);
  const vulnerabilityId = await seedVuln(opts.cveId);

  const [inv] = await getTestDb()
    .insert(softwareInventory)
    .values({
      deviceId,
      orgId: env.organization.id,
      name: 'Mozilla Firefox (x64 en-US)',
      version: '128.0',
      vendor: 'Mozilla',
    })
    .returning({ id: softwareInventory.id });
  if (!inv) throw new Error('failed to seed software inventory');

  const dvId = await seedDeviceVuln(env.organization.id, deviceId, vulnerabilityId, inv.id);

  const patchRows: Array<{ title: string; packageId: string }> = [
    { title: opts.patchTitle ?? 'Mozilla Firefox', packageId: 'Mozilla.Firefox' },
    ...(opts.extraPatch ? [opts.extraPatch] : []),
  ];
  for (const p of patchRows) {
    const [patch] = await getTestDb()
      .insert(patches)
      .values({
        source: 'third_party',
        externalId: uniq(p.packageId),
        title: p.title,
        packageId: p.packageId,
        version: opts.patchVersion ?? '129.0',
        severity: 'unknown',
        supersededBy: null,
        releaseDate: '2026-07-01',
      })
      .returning({ id: patches.id });
    if (!patch) throw new Error('failed to seed third-party patch');

    await getTestDb().insert(devicePatches).values({
      deviceId,
      orgId: env.organization.id,
      patchId: patch.id,
      status: 'pending',
    });

    if (opts.approved !== false) {
      await getTestDb().insert(patchApprovals).values({
        partnerId: env.partner.id,
        patchId: patch.id,
        status: 'approved',
      });
    }
  }

  if (opts.vulnerableRange) {
    const [product] = await getTestDb()
      .insert(softwareProducts)
      .values({
        normalizedName: 'mozilla firefox',
        normalizedVendor: 'mozilla',
        cpe: 'cpe:2.3:a:mozilla:firefox',
        cpeConfidence: 'curated',
      })
      .returning({ id: softwareProducts.id });
    if (!product) throw new Error('failed to seed software product');
    await getTestDb().insert(softwareProductResolutions).values({
      lookupName: 'mozilla firefox (x64 en-us)',
      lookupVendor: 'mozilla',
      normalizedName: 'mozilla firefox',
      softwareProductId: product.id,
      confidence: 'curated',
      matchedVia: 'curated',
      resolverVersion: 1,
      resolvedAt: new Date('2026-07-01T00:00:00Z'),
    });
    await getTestDb().insert(softwareVulnerabilities).values({
      productId: product.id,
      vulnerabilityId,
      versionEndExcluding: opts.vulnerableRange.versionEndExcluding,
    });
  }

  return { env, orgId: env.organization.id, deviceId, dvId };
}

/** Open device-vuln with NO matching pending patch. */
async function seedDeviceVulnNoPatch(): Promise<{ env: TestEnvironment; dvId: string }> {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const deviceId = await seedDevice(env);
  const vulnerabilityId = await seedVuln(uniq('CVE-NOPATCH'));
  const dvId = await seedDeviceVuln(env.organization.id, deviceId, vulnerabilityId);
  return { env, dvId };
}

async function auditCount(action: string, orgId: string): Promise<number> {
  const rows = await getTestDb()
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.orgId, orgId)));
  return rows.length;
}

describe('POST /api/v1/vulnerabilities/remediate', () => {
  runDb('queues an install command for a remediable device vuln', async () => {
    const { env, orgId, deviceId, dvId } = await seedRemediableDeviceVuln({ cveId: 'CVE-2025-50165' });
    const res = await buildApp().request('/api/v1/vulnerabilities/remediate', {
      method: 'POST',
      headers: await mfaHeaders(env),
      body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { scheduled: number; skipped: unknown[] };
    expect(body.scheduled).toBe(1);

    const cmds = await getTestDb()
      .select()
      .from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'install_patches')));
    expect(cmds.length).toBe(1);

    // Audit is fire-and-forget (createAuditLogAsync is void) — poll for the row.
    await expect.poll(() => auditCount('vulnerability.remediate', orgId), {
      timeout: 5000,
      interval: 100,
    }).toBeGreaterThanOrEqual(1);
  });

  runDb('skips a vuln whose patch is unapproved', async () => {
    const { env, dvId } = await seedRemediableDeviceVuln({ cveId: 'CVE-2025-50166', approved: false });
    const res = await buildApp().request('/api/v1/vulnerabilities/remediate', {
      method: 'POST',
      headers: await mfaHeaders(env),
      body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { scheduled: number; skipped: Array<{ reason: string }> };
    expect(body.scheduled).toBe(0);
    expect(body.skipped[0]!.reason).toBe('patch_not_approved');
  });

  runDb('skips a vuln with no pending matching patch', async () => {
    const { env, dvId } = await seedDeviceVulnNoPatch();
    const res = await buildApp().request('/api/v1/vulnerabilities/remediate', {
      method: 'POST',
      headers: await mfaHeaders(env),
      body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { scheduled: number; skipped: Array<{ reason: string }> };
    expect(body.scheduled).toBe(0);
    expect(body.skipped[0]!.reason).toBe('no_available_patch');
  });

  runDb('falls back to product matching for a third-party finding without cveIds', async () => {
    const { env, deviceId, dvId } = await seedThirdPartyFinding({ cveId: 'CVE-2025-60001' });
    const res = await buildApp().request('/api/v1/vulnerabilities/remediate', {
      method: 'POST',
      headers: await mfaHeaders(env),
      body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { scheduled: number; skipped: unknown[] };
    expect(body.scheduled).toBe(1);
    expect(body.skipped).toEqual([]);

    const cmds = await getTestDb()
      .select()
      .from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'install_patches')));
    expect(cmds.length).toBe(1);
  });

  runDb('keeps the approval gate on the third-party fallback path', async () => {
    const { env, dvId } = await seedThirdPartyFinding({ cveId: 'CVE-2025-60002', approved: false });
    const res = await buildApp().request('/api/v1/vulnerabilities/remediate', {
      method: 'POST',
      headers: await mfaHeaders(env),
      body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
    });
    const body = await res.json() as { scheduled: number; skipped: Array<{ reason: string }> };
    expect(body.scheduled).toBe(0);
    expect(body.skipped[0]!.reason).toBe('patch_not_approved');
  });

  runDb('skips a third-party fallback patch whose version is still vulnerable', async () => {
    // Pending upgrade targets 129.0 but the CVE is only fixed in 130.0 —
    // installing it cannot resolve the finding, so nothing is scheduled.
    const { env, dvId } = await seedThirdPartyFinding({
      cveId: 'CVE-2025-60003',
      patchVersion: '129.0',
      vulnerableRange: { versionEndExcluding: '130.0' },
    });
    const res = await buildApp().request('/api/v1/vulnerabilities/remediate', {
      method: 'POST',
      headers: await mfaHeaders(env),
      body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
    });
    const body = await res.json() as { scheduled: number; skipped: Array<{ reason: string }> };
    expect(body.scheduled).toBe(0);
    expect(body.skipped[0]!.reason).toBe('no_available_patch');
  });

  runDb('schedules a third-party fallback patch whose version clears the vulnerable range', async () => {
    const { env, dvId } = await seedThirdPartyFinding({
      cveId: 'CVE-2025-60004',
      patchVersion: '130.0',
      vulnerableRange: { versionEndExcluding: '130.0' },
    });
    const res = await buildApp().request('/api/v1/vulnerabilities/remediate', {
      method: 'POST',
      headers: await mfaHeaders(env),
      body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
    });
    const body = await res.json() as { scheduled: number; skipped: unknown[] };
    expect(body.scheduled).toBe(1);
  });

  runDb('drops an ambiguous normalized title (two packageIds) instead of guessing', async () => {
    const { env, dvId } = await seedThirdPartyFinding({
      cveId: 'CVE-2025-60005',
      // Same normalized name ("mozilla firefox") from a different packageId —
      // the x64/x86-twin shape. Neither may be picked.
      extraPatch: { title: 'Mozilla Firefox (x86)', packageId: 'Mozilla.Firefox.x86' },
    });
    const res = await buildApp().request('/api/v1/vulnerabilities/remediate', {
      method: 'POST',
      headers: await mfaHeaders(env),
      body: JSON.stringify({ deviceVulnerabilityIds: [dvId] }),
    });
    const body = await res.json() as { scheduled: number; skipped: Array<{ reason: string }> };
    expect(body.scheduled).toBe(0);
    expect(body.skipped[0]!.reason).toBe('no_available_patch');
  });

  runDb('rejects an unauthenticated caller', async () => {
    const res = await buildApp().request('/api/v1/vulnerabilities/remediate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceVulnerabilityIds: ['00000000-0000-0000-0000-000000000000'] }),
    });
    expect(res.status).toBe(401);
  });
});
