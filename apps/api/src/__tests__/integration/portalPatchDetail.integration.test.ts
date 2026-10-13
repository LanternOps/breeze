import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { devicePatches, devices, patches, portalBranding } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { patchDetailDevicePage, patchDetailSummary } from '../../services/portal/patchDetailReadModel';

const NOW = new Date('2026-10-10T04:00:00Z');
const args = { page: 1, limit: 50, now: NOW };

function context(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
}

async function seedDevice(orgId: string, siteId: string, marker: string, isEphemeral = false) {
  const [device] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: randomUUID().replace(/-/g, ''), hostname: marker, osType: 'linux',
    osVersion: '1', architecture: 'amd64', agentVersion: '1', isEphemeral,
  }).returning();
  return device!.id;
}

async function seedPatch(title: string, severity: 'critical' | 'important' | 'moderate' | 'low' | 'unknown' = 'unknown') {
  const [patch] = await getTestDb().insert(patches).values({
    source: 'custom', externalId: `ext-${randomUUID()}`, title, severity,
    version: '9.9', kbArticleUrl: 'https://example.test/kb/1',
  }).returning();
  return patch!.id;
}

async function link(
  orgId: string, deviceId: string, patchId: string,
  status: 'pending' | 'installed' | 'failed' | 'skipped' | 'missing',
  extra: Partial<typeof devicePatches.$inferInsert> = {},
) {
  await getTestDb().insert(devicePatches).values({
    orgId, deviceId, patchId, status, lastCheckedAt: NOW,
    lastError: 'SECRET-ERROR', failureCount: 7, rollbackAvailable: true, scope: 'user',
    ...extra,
  });
}

describe('W05 patch detail real PostgreSQL isolation', () => {
  it('replays the DDL idempotently and defaults existing and new rows to false', async () => {
    const migration = readFileSync(new URL('../../../migrations/2026-12-23-230000-portal-branding-enable-patch-detail.sql', import.meta.url), 'utf8');
    await getTestDb().transaction(async (tx) => {
      // Transaction-local shadow: never changes the real portal_branding table.
      await tx.execute(sql.raw('CREATE TEMP TABLE portal_branding (id integer PRIMARY KEY) ON COMMIT DROP'));
      await tx.execute(sql.raw('INSERT INTO portal_branding (id) VALUES (1)'));
      await tx.execute(sql.raw(migration));
      await tx.execute(sql.raw(migration));
      await tx.execute(sql.raw('INSERT INTO portal_branding (id) VALUES (2)'));
      const rows = await tx.execute(sql.raw('SELECT enable_patch_detail FROM portal_branding ORDER BY id'));
      expect(Array.from(rows)).toEqual([{ enable_patch_detail: false }, { enable_patch_detail: false }]);
    });
  });

  it('defaults the flag to false for new portal settings', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [row] = await getTestDb().insert(portalBranding).values({ orgId: org.id }).returning();
    expect(row!.enablePatchDetail).toBe(false);
  });

  it('isolates organizations, drops missing/skipped rows and ephemeral devices, and emits only permitted fields', async () => {
    const partner = await createPartner();
    const a = await createOrganization({ partnerId: partner.id });
    const b = await createOrganization({ partnerId: partner.id });
    const sa = await createSite({ orgId: a.id });
    const sb = await createSite({ orgId: b.id });
    const da = await seedDevice(a.id, sa.id, 'HOST-A');
    const eph = await seedDevice(a.id, sa.id, 'HOST-EPH', true);
    const db = await seedDevice(b.id, sb.id, 'HOST-B');

    const pending = await seedPatch('PENDING-A', 'critical');
    const installed = await seedPatch('INSTALLED-A', 'low');
    const failed = await seedPatch('FAILED-A', 'important');
    const skipped = await seedPatch('SKIPPED-A', 'moderate');
    const missing = await seedPatch('MISSING-A', 'moderate');
    const otherOrg = await seedPatch('ORG-B-ONLY', 'critical');
    const ephemeralOnly = await seedPatch('EPHEMERAL-ONLY', 'critical');
    await link(a.id, da, pending, 'pending', { availableVersion: '9.9' });
    await link(a.id, da, installed, 'installed', { installedAt: NOW, installedVersion: '9.8' });
    await link(a.id, da, failed, 'failed');
    await link(a.id, da, skipped, 'skipped');
    await link(a.id, da, missing, 'missing');
    await link(b.id, db, otherOrg, 'pending');
    await link(a.id, eph, ephemeralOnly, 'pending');

    const ca = context(a.id, partner.id);
    const cb = context(b.id, partner.id);
    const page = await withDbAccessContext(ca, () => patchDetailDevicePage(a.id, da, args));
    expect(page!.pagination.total).toBe(3);
    expect(page!.data.map((row) => row.title)).toEqual(['PENDING-A', 'FAILED-A', 'INSTALLED-A']);
    expect(page!.data.map((row) => row.status)).toEqual(['pending', 'failed', 'installed']);
    expect(Object.keys(page!.data[0]!).sort()).toEqual([
      'availableVersion', 'installedAt', 'installedVersion', 'kbArticleUrl', 'lastCheckedAt', 'severity', 'status', 'title', 'version',
    ]);
    expect(page!.data[2]).toMatchObject({ installedAt: NOW.toISOString(), installedVersion: '9.8' });

    const summary = await withDbAccessContext(ca, () => patchDetailSummary(a.id, args));
    expect(summary.pagination.total).toBe(3);
    expect(summary.data.map((row) => row.title)).toEqual(['PENDING-A', 'FAILED-A', 'INSTALLED-A']);
    expect(summary.data[0]).toMatchObject({ pendingDevices: 1, failedDevices: 0, installedDevices: 0 });

    const serialized = JSON.stringify({ page, summary });
    for (const leaked of ['SECRET-ERROR', 'MISSING-A', 'SKIPPED-A', 'ORG-B-ONLY', 'EPHEMERAL-ONLY']) {
      expect(serialized).not.toContain(leaked);
    }

    // Cross-organization: forged device ids resolve to null, org B sees only its own.
    expect(await withDbAccessContext(ca, () => patchDetailDevicePage(a.id, db, args))).toBeNull();
    expect(await withDbAccessContext(cb, () => patchDetailDevicePage(b.id, da, args))).toBeNull();
    expect(await withDbAccessContext(ca, () => patchDetailDevicePage(a.id, eph, args))).toBeNull();
    expect((await withDbAccessContext(ca, () => patchDetailSummary(b.id, args))).data).toEqual([]);
    expect((await withDbAccessContext(cb, () => patchDetailSummary(b.id, args))).data.map((row) => row.title)).toEqual(['ORG-B-ONLY']);
  });

  it('shows the device-reported severity when the shared severity is unknown', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id, 'HOST');
    const patchId = await seedPatch('REPORTED', 'unknown');
    const trusted = await seedPatch('TRUSTED', 'low');
    await link(org.id, device, patchId, 'pending', { reportedSeverity: 'critical' });
    // The shared classification wins over a device report when it is known.
    await link(org.id, device, trusted, 'pending', { reportedSeverity: 'critical' });
    const ctx = context(org.id, partner.id);
    const page = await withDbAccessContext(ctx, () => patchDetailDevicePage(org.id, device, args));
    expect(Object.fromEntries(page!.data.map((row) => [row.title, row.severity]))).toEqual({
      REPORTED: 'critical', TRUSTED: 'low',
    });
    const summary = await withDbAccessContext(ctx, () => patchDetailSummary(org.id, args));
    expect(Object.fromEntries(summary.data.map((row) => [row.title, row.severity]))).toEqual({
      REPORTED: 'critical', TRUSTED: 'low',
    });
  });

  it('walks summary and device pages without repeats or omissions', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const d1 = await seedDevice(org.id, site.id, 'H1');
    const d2 = await seedDevice(org.id, site.id, 'H2');
    // Every title ties so the id tiebreaker is what keeps pages stable.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await seedPatch('SAME-TITLE', 'moderate');
      await getTestDb().update(patches).set({ version: `v${i}` }).where(eq(patches.id, id));
      ids.push(id);
      await link(org.id, d1, id, 'pending');
      await link(org.id, d2, id, 'pending');
    }
    const ctx = context(org.id, partner.id);
    const fullSummary = (await withDbAccessContext(ctx, () => patchDetailSummary(org.id, args))).data.map((row) => row.version);
    const fullDevice = (await withDbAccessContext(ctx, () => patchDetailDevicePage(org.id, d1, args)))!.data.map((row) => row.version);
    expect(new Set(fullSummary).size).toBe(ids.length);
    expect(new Set(fullDevice).size).toBe(ids.length);
    for (const limit of [1, 2]) {
      const summaryWalk: Array<string | null> = [];
      const deviceWalk: Array<string | null> = [];
      for (let page = 1; page <= Math.ceil(ids.length / limit); page++) {
        const s = await withDbAccessContext(ctx, () => patchDetailSummary(org.id, { ...args, page, limit }));
        expect(s.pagination).toEqual({ page, limit, total: ids.length });
        summaryWalk.push(...s.data.map((row) => row.version));
        const d = await withDbAccessContext(ctx, () => patchDetailDevicePage(org.id, d1, { ...args, page, limit }));
        expect(d!.pagination.total).toBe(ids.length);
        deviceWalk.push(...d!.data.map((row) => row.version));
      }
      // Pages concatenate to exactly the unpaged order: no repeat, no omission.
      expect(summaryWalk).toEqual(fullSummary);
      expect(deviceWalk).toEqual(fullDevice);
      const beyond = await withDbAccessContext(ctx, () => patchDetailSummary(org.id, { ...args, page: 99, limit }));
      expect(beyond.data).toEqual([]);
      expect(beyond.dataStatus).toBe('ok');
    }
  });

  it('orders by outstanding work then effective severity, and counts statuses per patch', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [d1, d2, d3, d4, d5] = [
      await seedDevice(org.id, site.id, 'H1'), await seedDevice(org.id, site.id, 'H2'),
      await seedDevice(org.id, site.id, 'H3'), await seedDevice(org.id, site.id, 'H4'),
      await seedDevice(org.id, site.id, 'H5'),
    ];
    const moderate = await seedPatch('A-MODERATE', 'moderate');
    const critical = await seedPatch('B-CRITICAL', 'critical');
    const promoted = await seedPatch('C-PROMOTED', 'unknown');
    const instCritical = await seedPatch('D-INSTALLED-CRITICAL', 'critical');
    await link(org.id, d1, moderate, 'pending');
    await link(org.id, d1, critical, 'pending');
    await link(org.id, d1, promoted, 'pending', { reportedSeverity: 'important' });
    await link(org.id, d1, instCritical, 'installed');
    // One patch across five devices: pending, failed, installed, skipped, missing.
    const mixed = await seedPatch('E-MIXED', 'low');
    const later = new Date('2026-10-11T04:00:00Z');
    await link(org.id, d1, mixed, 'pending');
    await link(org.id, d2, mixed, 'failed', { lastCheckedAt: later });
    await link(org.id, d3, mixed, 'installed');
    await link(org.id, d4, mixed, 'skipped', { lastCheckedAt: new Date('2026-12-31T00:00:00Z') });
    await link(org.id, d5, mixed, 'missing');
    const ctx = context(org.id, partner.id);

    const summary = await withDbAccessContext(ctx, () => patchDetailSummary(org.id, args));
    // Outstanding first (critical, important, moderate, low), installed-only last.
    expect(summary.data.map((row) => row.title)).toEqual([
      'B-CRITICAL', 'C-PROMOTED', 'A-MODERATE', 'E-MIXED', 'D-INSTALLED-CRITICAL',
    ]);
    expect(summary.data.find((row) => row.title === 'C-PROMOTED')!.severity).toBe('important');
    const mixedRow = summary.data.find((row) => row.title === 'E-MIXED')!;
    expect(mixedRow).toMatchObject({ pendingDevices: 1, failedDevices: 1, installedDevices: 1 });
    // skipped/missing neither count nor feed the max.
    expect(mixedRow.lastCheckedAt).toBe(later.toISOString());

    const page = await withDbAccessContext(ctx, () => patchDetailDevicePage(org.id, d1, args));
    expect(page!.data.map((row) => row.title)).toEqual([
      'B-CRITICAL', 'C-PROMOTED', 'A-MODERATE', 'E-MIXED', 'D-INSTALLED-CRITICAL',
    ]);
  });

  it('answers no_data (not 404) for a device whose only rows are skipped or missing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await seedDevice(org.id, site.id, 'H');
    await link(org.id, device, await seedPatch('S'), 'skipped');
    await link(org.id, device, await seedPatch('M'), 'missing');
    const ctx = context(org.id, partner.id);
    const page = await withDbAccessContext(ctx, () => patchDetailDevicePage(org.id, device, args));
    expect(page).not.toBeNull();
    expect(page!.dataStatus).toBe('no_data');
    expect((await withDbAccessContext(ctx, () => patchDetailSummary(org.id, args))).dataStatus).toBe('no_data');
  });
});
