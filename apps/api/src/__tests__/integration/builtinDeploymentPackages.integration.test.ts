/**
 * Integration test for built-in EDR deployment packages (Task 4).
 *
 * ensureBuiltinPackage upserts a PARTNER-scoped software_catalog row (org_id
 * NULL, partner_id set, integration_provider set) and — for providers whose
 * installer URL is derivable (Huntress) — a templated software_versions row.
 * It runs in a system DB context so the partner-axis write passes RLS even
 * though the connection is the unprivileged breeze_app role.
 *
 * Runs as breeze_app so RLS + the dual-axis policy are genuinely exercised.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { softwareCatalog, softwareVersions } from '../../db/schema';
import {
  BUILTIN_TENANT_VAR_PACKAGES,
  catalogIdForBuiltinKey,
  ensureBuiltinPackage,
  ensurePinnedBuiltinPackage,
  refreshPinnedBuiltinPackages,
  type PinnedBuiltinPackageDef,
} from '../../services/builtinDeploymentPackages';
import { createPartner } from './db-utils';

describe('ensureBuiltinPackage (db)', () => {
  it('is idempotent for huntress: one catalog row + one templated version', async () => {
    const partner = await createPartner();

    const first = await ensureBuiltinPackage({ provider: 'huntress', partnerId: partner.id });
    const second = await ensureBuiltinPackage({ provider: 'huntress', partnerId: partner.id });
    expect(second.catalogId).toBe(first.catalogId);

    const { rows, versions } = await withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(softwareCatalog)
        .where(and(
          eq(softwareCatalog.partnerId, partner.id),
          eq(softwareCatalog.integrationProvider, 'huntress'),
        ));
      const versions = await db
        .select()
        .from(softwareVersions)
        .where(eq(softwareVersions.catalogId, first.catalogId));
      return { rows, versions };
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBeNull();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.downloadUrl).toContain('{huntress_acct_key}');
    expect(versions[0]!.silentInstallArgs).toContain('{huntress_org_key}');
  });

  it('creates a catalog row but NO version for sentinelone (needs upload)', async () => {
    const partner = await createPartner();

    const { catalogId } = await ensureBuiltinPackage({ provider: 'sentinelone', partnerId: partner.id });

    const versions = await withSystemDbAccessContext(() =>
      db.select().from(softwareVersions).where(eq(softwareVersions.catalogId, catalogId)),
    );
    expect(versions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #6958 PR D: code-pinned DNS built-ins.
// ---------------------------------------------------------------------------
async function readKeyed(partnerId: string, key: string) {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select()
      .from(softwareCatalog)
      .where(and(eq(softwareCatalog.partnerId, partnerId), eq(softwareCatalog.builtinPackageKey, key)));
    const versions = rows[0]
      ? await db.select().from(softwareVersions).where(eq(softwareVersions.catalogId, rows[0].id))
      : [];
    return { rows, versions };
  });
}

function withPin(def: PinnedBuiltinPackageDef, version: string, checksum = def.checksum): PinnedBuiltinPackageDef {
  return { ...def, version, checksum };
}

describe('ensurePinnedBuiltinPackage (db, #6958)', () => {
  it('is idempotent: one keyed partner row + one latest pinned version with scripts enabled', async () => {
    const partner = await createPartner();
    const first = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });
    const second = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });
    expect(second).toEqual(first);

    const { rows, versions } = await readKeyed(partner.id, 'controld_windows');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.catalogId,
      partnerId: partner.id,
      orgId: null,
      integrationProvider: null,
      isManaged: true,
      name: 'Control D (Windows)',
      deletedAt: null,
    });
    expect(versions).toHaveLength(1);
    const def = BUILTIN_TENANT_VAR_PACKAGES.controld_windows;
    expect(versions[0]).toMatchObject({
      id: first.versionId,
      isLatest: true,
      version: def.version,
      checksum: def.checksum,
      downloadUrl: def.downloadUrl,
      fileType: 'zip',
      supportedOs: ['windows'],
      architecture: 'x64',
      detectionRules: def.detectionRules,
      preInstallScript: null,
      postInstallScript: def.postInstallScript,
      installScriptsEnabled: true,
      silentInstallArgs: null,
    });
  });

  it('provisions the hidden macOS key with its pre-script (system callers only reach it)', async () => {
    const partner = await createPartner();
    const { versionId } = await ensurePinnedBuiltinPackage({ key: 'controld_macos', partnerId: partner.id });
    const { versions } = await readKeyed(partner.id, 'controld_macos');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: versionId,
      fileType: 'pkg',
      supportedOs: ['macos'],
      architecture: null,
      preInstallScript: BUILTIN_TENANT_VAR_PACKAGES.controld_macos.preInstallScript,
      installScriptsEnabled: true,
    });
  });

  it('un-archives a soft-deleted row and returns the same ids', async () => {
    const partner = await createPartner();
    const first = await ensurePinnedBuiltinPackage({ key: 'nextdns_windows', partnerId: partner.id });
    await withSystemDbAccessContext(() =>
      db.update(softwareCatalog).set({ deletedAt: new Date() }).where(eq(softwareCatalog.id, first.catalogId)),
    );
    expect(await withSystemDbAccessContext(() => catalogIdForBuiltinKey(partner.id, 'nextdns_windows'))).toBeNull();

    const again = await ensurePinnedBuiltinPackage({ key: 'nextdns_windows', partnerId: partner.id });
    expect(again).toEqual(first);
    const { rows, versions } = await readKeyed(partner.id, 'nextdns_windows');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deletedAt).toBeNull();
    expect(versions).toHaveLength(1);
  });

  it('concurrent provisioning (×5) yields one row and one version', async () => {
    const partner = await createPartner();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id })),
    );
    expect(new Set(results.map((r) => r.catalogId)).size).toBe(1);
    expect(new Set(results.map((r) => r.versionId)).size).toBe(1);
    const { rows, versions } = await readKeyed(partner.id, 'controld_windows');
    expect(rows).toHaveLength(1);
    expect(versions).toHaveLength(1);
  });

  it('keeps each partner on its own row', async () => {
    const a = await createPartner();
    const b = await createPartner();
    const ra = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: a.id });
    const rb = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: b.id });
    expect(ra.catalogId).not.toBe(rb.catalogId);
  });
});

describe('refreshPinnedBuiltinPackages (db, #6958)', () => {
  it('moves a provisioned row forward to a newer pin and keeps the old version', async () => {
    const partner = await createPartner();
    const before = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });
    const newer = withPin(BUILTIN_TENANT_VAR_PACKAGES.controld_windows, '1.6.0', 'a'.repeat(64));

    const result = await refreshPinnedBuiltinPackages({ ...BUILTIN_TENANT_VAR_PACKAGES, controld_windows: newer });
    expect(result).toEqual({ refreshed: 1, failed: 0 });

    const { versions } = await readKeyed(partner.id, 'controld_windows');
    expect(versions).toHaveLength(2);
    const latest = versions.filter((v) => v.isLatest);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ version: '1.6.0', checksum: 'a'.repeat(64), installScriptsEnabled: true });
    expect(versions.find((v) => v.id === before.versionId)).toMatchObject({ isLatest: false, version: '1.5.8' });

    // A second boot at the same pin is a no-op.
    expect(await refreshPinnedBuiltinPackages({ ...BUILTIN_TENANT_VAR_PACKAGES, controld_windows: newer }))
      .toEqual({ refreshed: 0, failed: 0 });
  });

  it('concurrent refreshes (two replicas booting) create the newer version exactly once', async () => {
    const partner = await createPartner();
    await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });
    const defs = {
      ...BUILTIN_TENANT_VAR_PACKAGES,
      controld_windows: withPin(BUILTIN_TENANT_VAR_PACKAGES.controld_windows, '1.6.0', 'd'.repeat(64)),
    };
    const results = await Promise.all(Array.from({ length: 4 }, () => refreshPinnedBuiltinPackages(defs)));
    expect(results.reduce((n, r) => n + r.refreshed, 0)).toBe(1);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    const { versions } = await readKeyed(partner.id, 'controld_windows');
    expect(versions.map((v) => v.version).sort()).toEqual(['1.5.8', '1.6.0']);
  });

  it('re-provisioning after a newer refresh never creates an older latest; un-archive keeps scripts enabled', async () => {
    const partner = await createPartner();
    const { catalogId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });
    const newer = withPin(BUILTIN_TENANT_VAR_PACKAGES.controld_windows, '1.6.0', 'e'.repeat(64));
    await refreshPinnedBuiltinPackages({ ...BUILTIN_TENANT_VAR_PACKAGES, controld_windows: newer });
    await withSystemDbAccessContext(() =>
      db.update(softwareCatalog).set({ deletedAt: new Date() }).where(eq(softwareCatalog.id, catalogId)),
    );

    // An older replica (code pin 1.5.8) handles the POST.
    const again = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });
    expect(again.catalogId).toBe(catalogId);
    const { rows, versions } = await readKeyed(partner.id, 'controld_windows');
    expect(rows[0]!.deletedAt).toBeNull();
    expect(versions).toHaveLength(2);
    const latest = versions.find((v) => v.isLatest)!;
    expect(latest).toMatchObject({ id: again.versionId, version: '1.6.0', installScriptsEnabled: true });
    expect(latest.postInstallScript).toBe(BUILTIN_TENANT_VAR_PACKAGES.controld_windows.postInstallScript);
  });

  it('never downgrades: an older pin (an older replica booting) leaves the row alone', async () => {
    const partner = await createPartner();
    const before = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });
    const older = withPin(BUILTIN_TENANT_VAR_PACKAGES.controld_windows, '1.5.7', 'b'.repeat(64));

    expect(await refreshPinnedBuiltinPackages({ ...BUILTIN_TENANT_VAR_PACKAGES, controld_windows: older }))
      .toEqual({ refreshed: 0, failed: 0 });
    const { versions } = await readKeyed(partner.id, 'controld_windows');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ id: before.versionId, isLatest: true, version: '1.5.8' });
  });

  it('skips archived rows', async () => {
    const partner = await createPartner();
    const before = await ensurePinnedBuiltinPackage({ key: 'nextdns_windows', partnerId: partner.id });
    await withSystemDbAccessContext(() =>
      db.update(softwareCatalog).set({ deletedAt: new Date() }).where(eq(softwareCatalog.id, before.catalogId)),
    );
    const newer = withPin(BUILTIN_TENANT_VAR_PACKAGES.nextdns_windows, '1.48.0');
    expect(await refreshPinnedBuiltinPackages({ ...BUILTIN_TENANT_VAR_PACKAGES, nextdns_windows: newer }))
      .toEqual({ refreshed: 0, failed: 0 });
    const { versions } = await readKeyed(partner.id, 'nextdns_windows');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe('1.47.3');
  });

  it('isolates a failing row: it is counted in `failed` and the others still move', async () => {
    const good = await createPartner();
    const bad = await createPartner();
    await ensurePinnedBuiltinPackage({ key: 'nextdns_windows', partnerId: good.id });
    await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: bad.id });

    // varchar(128) checksum: an oversized value makes the version insert fail in the DB.
    const broken = withPin(BUILTIN_TENANT_VAR_PACKAGES.controld_windows, '1.6.0', 'c'.repeat(200));
    const newerNextdns = withPin(BUILTIN_TENANT_VAR_PACKAGES.nextdns_windows, '1.48.0');
    const result = await refreshPinnedBuiltinPackages({
      ...BUILTIN_TENANT_VAR_PACKAGES,
      controld_windows: broken,
      nextdns_windows: newerNextdns,
    });
    expect(result).toEqual({ refreshed: 1, failed: 1 });

    const goodState = await readKeyed(good.id, 'nextdns_windows');
    expect(goodState.versions.find((v) => v.isLatest)!.version).toBe('1.48.0');
    const badState = await readKeyed(bad.id, 'controld_windows');
    expect(badState.versions).toHaveLength(1); // rolled back, still on the old pin
    expect(badState.versions[0]).toMatchObject({ isLatest: true, version: '1.5.8' });
  });
});

describe('catalogIdForBuiltinKey (db, #6958)', () => {
  it('returns the live row id, null for an archived row and null for another partner', async () => {
    const partner = await createPartner();
    const other = await createPartner();
    expect(await withSystemDbAccessContext(() => catalogIdForBuiltinKey(partner.id, 'controld_windows'))).toBeNull();

    const { catalogId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });
    expect(await withSystemDbAccessContext(() => catalogIdForBuiltinKey(partner.id, 'controld_windows'))).toBe(catalogId);
    expect(await withSystemDbAccessContext(() => catalogIdForBuiltinKey(other.id, 'controld_windows'))).toBeNull();

    await withSystemDbAccessContext(() =>
      db.update(softwareCatalog).set({ deletedAt: new Date() }).where(eq(softwareCatalog.id, catalogId)),
    );
    expect(await withSystemDbAccessContext(() => catalogIdForBuiltinKey(partner.id, 'controld_windows'))).toBeNull();
  });
});
