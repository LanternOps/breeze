import '../__tests__/integration/setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import {
  devices, organizations, partners, sites,
  softwareInventory, softwareProducts, softwareProductResolutions,
} from '../db/schema';
import { refreshResolutionCache } from './cpeResolution';
import { RESOLVER_VERSION } from './cpeResolver';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedDeviceAndInventory(name: string, vendor: string | null): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const u = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [p] = await db.insert(partners).values({ name: `P ${u}`, slug: `p-${u}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: `O ${u}`, slug: `o-${u}`, type: 'customer', status: 'active' }).returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `S ${u}` }).returning({ id: sites.id });
    const [d] = await db.insert(devices).values({ orgId: o!.id, siteId: s!.id, agentId: `a-${u}`, hostname: `h-${u}`, osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'offline' }).returning({ id: devices.id });
    await db.insert(softwareInventory).values({ orgId: o!.id, deviceId: d!.id, name, vendor, version: '1.0' });
  });
}

beforeEach(async () => {
  await withSystemDbAccessContext(async () => {
    await db.delete(softwareProductResolutions);
    await db.delete(softwareInventory);
    await db.delete(softwareProducts);
  });
});

describe('refreshResolutionCache', () => {
  runDb('resolves a curated DisplayName to a catalog product', async () => {
    await withSystemDbAccessContext(async () => {
      await db.insert(softwareProducts).values({ normalizedName: 'chrome', normalizedVendor: 'google', cpe: 'cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*', cpeConfidence: 'authoritative' });
    });
    await seedDeviceAndInventory('Google Chrome (64-bit)', 'Google LLC');

    const counts = await refreshResolutionCache();
    expect(counts.curated + counts.exact + counts.fuzzy).toBeGreaterThanOrEqual(1);

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(softwareProductResolutions).where(eq(softwareProductResolutions.lookupName, 'google chrome (64-bit)')));
    expect(rows[0]?.softwareProductId).not.toBeNull();
    expect(rows[0]?.resolverVersion).toBe(RESOLVER_VERSION);
  });

  runDb('logs an unmatched DisplayName with NULL product', async () => {
    // A populated catalog that simply doesn't contain this app (the real unmatched case;
    // an empty catalog is a different, alerted failure — see the catalog-health guard).
    await withSystemDbAccessContext(async () => {
      await db.insert(softwareProducts).values({ normalizedName: 'chrome', normalizedVendor: 'google', cpe: 'cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*', cpeConfidence: 'authoritative' });
    });
    await seedDeviceAndInventory('Totally Bespoke Internal Tool XYZ', 'Some Vendor');
    await refreshResolutionCache();
    const unmatched = await withSystemDbAccessContext(() =>
      db.select().from(softwareProductResolutions).where(isNull(softwareProductResolutions.softwareProductId)));
    expect(unmatched.length).toBeGreaterThanOrEqual(1);
    expect(unmatched[0]?.confidence).toBe('none');
  });

  runDb('is idempotent — re-run does not duplicate rows', async () => {
    await withSystemDbAccessContext(async () => {
      await db.insert(softwareProducts).values({ normalizedName: 'chrome', normalizedVendor: 'google', cpe: 'cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*', cpeConfidence: 'authoritative' });
    });
    await seedDeviceAndInventory('Google Chrome', 'Google LLC');
    await refreshResolutionCache();
    await refreshResolutionCache();
    const rows = await withSystemDbAccessContext(() =>
      db.select({ n: sql<number>`count(*)::int` }).from(softwareProductResolutions).where(eq(softwareProductResolutions.lookupName, 'google chrome')));
    expect(rows[0]?.n).toBe(1);
  });

  runDb('re-resolves a previously-unmatched name once the catalog grows (same resolver version)', async () => {
    // Catalog is populated (unrelated product) but does not yet contain "Bespoke Cache Tool".
    await withSystemDbAccessContext(async () => {
      await db.insert(softwareProducts).values({ normalizedName: 'chrome', normalizedVendor: 'google', cpe: 'cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*', cpeConfidence: 'authoritative' });
    });
    await seedDeviceAndInventory('Bespoke Cache Tool', 'Bespoke');

    // First pass: catalog lacks this product → unmatched (product NULL, confidence none).
    await refreshResolutionCache();
    const before = await withSystemDbAccessContext(() =>
      db.select().from(softwareProductResolutions).where(eq(softwareProductResolutions.lookupName, 'bespoke cache tool')));
    expect(before[0]?.softwareProductId).toBeNull();
    expect(before[0]?.confidence).toBe('none');

    // Catalog grows at runtime (NVD/MSRC ingest) — no RESOLVER_VERSION bump.
    await withSystemDbAccessContext(async () => {
      await db.insert(softwareProducts).values({
        normalizedName: 'bespoke cache tool',
        normalizedVendor: 'bespoke',
        cpe: 'cpe:2.3:a:bespoke:cache_tool:*:*:*:*:*:*:*:*',
        cpeConfidence: 'authoritative',
      });
    });

    // Second pass must re-resolve the unmatched row and now match it.
    await refreshResolutionCache();
    const after = await withSystemDbAccessContext(() =>
      db.select().from(softwareProductResolutions).where(eq(softwareProductResolutions.lookupName, 'bespoke cache tool')));
    expect(after[0]?.softwareProductId).not.toBeNull();
    expect(after[0]?.confidence).toBe('exact');
    expect(after[0]?.resolverVersion).toBe(RESOLVER_VERSION);
  });

  runDb('throws on an empty catalog rather than downgrading every key to unmatched', async () => {
    // Inventory present but software_products empty (feed/ingest failure). Refusing to run
    // prevents a fleet-wide false "all clear"; the caller (correlateEnabledOrgs) turns this
    // into a Sentry alert and correlates against the prior cache.
    await seedDeviceAndInventory('Google Chrome', 'Google LLC');
    await withSystemDbAccessContext(async () => {
      await db.delete(softwareProducts);
    });
    await expect(refreshResolutionCache()).rejects.toThrow(/catalog is empty/);
  });
});
