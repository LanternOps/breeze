/**
 * Integration test — software report wipe-and-reinsert with linked vuln
 * findings, against real Postgres + RLS (Sentry BREEZE-3).
 *
 * The mocked unit suite (inventory.test.ts) encodes the route's assumptions;
 * this suite checks them for real: the `device_vulnerabilities_software_
 * inventory_id_fkey` constraint must actually be ON DELETE SET NULL after the
 * 2026-07-17-a/-b migrations (a constraint-name mismatch would silently leave
 * the FK as NO ACTION and re-freeze inventories — the original shipped bug),
 * and the re-link UPDATE on device_vulnerabilities must work under the same
 * org-scoped RLS context agentAuthMiddleware gives the route (a silently
 * 0-row RLS write would detach findings on every report while mocked tests
 * stay green).
 */
import '../../__tests__/integration/setup';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, deviceVulnerabilities, softwareInventory, vulnerabilities } from '../../db/schema';
import { setupTestEnvironment } from '../../__tests__/integration/db-utils';
import { inventoryRoutes } from './inventory';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** The exact RLS context `agentAuthMiddleware` sets up for org-scoped agent routes. */
function agentRequestContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

async function insertDevice(orgId: string, siteId: string): Promise<{ id: string; agentId: string }> {
  const agentId = `agent-swrelink-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId,
        hostname: `swrelink-${agentId}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
        enrolledAt: new Date(),
      })
      .returning({ id: devices.id });
    if (!row) throw new Error('insertDevice: no row');
    return { id: row.id, agentId };
  });
}

async function seedInventoryRow(orgId: string, deviceId: string, name: string, vendor: string): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(softwareInventory)
      .values({ orgId, deviceId, name, vendor, version: '1.0', lastSeen: new Date() })
      .returning({ id: softwareInventory.id });
    if (!row) throw new Error('seedInventoryRow: no row');
    return row.id;
  });
}

async function seedLinkedFinding(orgId: string, deviceId: string, cveId: string, softwareInventoryId: string): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [vuln] = await db
      .insert(vulnerabilities)
      .values({ cveId, source: 'nvd', description: 'x', rawPayload: { t: true } })
      .returning({ id: vulnerabilities.id });
    const [finding] = await db
      .insert(deviceVulnerabilities)
      .values({ orgId, deviceId, vulnerabilityId: vuln!.id, softwareInventoryId, status: 'open', detectedAt: new Date() })
      .returning({ id: deviceVulnerabilities.id });
    return finding!.id;
  });
}

/** Submits a software report through the real Hono handler, under the same
 * withDbAccessContext wrap agentAuthMiddleware applies in production. */
async function submitSoftware(orgId: string, agentId: string, software: unknown[]) {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('agent', { orgId, agentId, role: 'agent' });
    await next();
  });
  app.route('/agents', inventoryRoutes);
  return withDbAccessContext(agentRequestContext(orgId), async () =>
    app.request(`/agents/${agentId}/software`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ software }),
    })
  );
}

describe('software report with linked vuln findings (real FK + RLS, BREEZE-3)', () => {
  runDb('wipe succeeds, surviving software is re-linked, uninstalled software degrades to NULL', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const orgId = env.organization.id;
    const dev = await insertDevice(orgId, env.site.id);

    const chromeRowId = await seedInventoryRow(orgId, dev.id, 'Google Chrome', 'Google LLC');
    const goneRowId = await seedInventoryRow(orgId, dev.id, 'Old App', 'Gone Inc.');
    const chromeFindingId = await seedLinkedFinding(orgId, dev.id, 'CVE-2025-RELINK-1', chromeRowId);
    const goneFindingId = await seedLinkedFinding(orgId, dev.id, 'CVE-2025-RELINK-2', goneRowId);

    // The report keeps Chrome (different casing — must still re-link) and
    // drops Old App. Pre-fix this DELETE failed with FK 23503.
    const res = await submitSoftware(orgId, dev.agentId, [
      { name: 'google chrome', vendor: 'Google LLC', version: '127.0' },
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, count: 1 });

    const inventoryRows = await withSystemDbAccessContext(() =>
      db.select().from(softwareInventory).where(eq(softwareInventory.deviceId, dev.id)));
    expect(inventoryRows).toHaveLength(1);
    const newChromeRowId = inventoryRows[0]!.id;
    expect(newChromeRowId).not.toBe(chromeRowId);

    const findings = await withSystemDbAccessContext(() =>
      db.select().from(deviceVulnerabilities).where(eq(deviceVulnerabilities.deviceId, dev.id)));
    const byId = new Map(findings.map((f) => [f.id, f]));
    // Surviving software: re-linked to the replacement row (real RLS UPDATE,
    // not a silent 0-row write).
    expect(byId.get(chromeFindingId)?.softwareInventoryId).toBe(newChromeRowId);
    expect(byId.get(chromeFindingId)?.status).toBe('open');
    // Uninstalled software: the real SET NULL trigger fired (constraint name
    // and delete action are correct on a fully-migrated database).
    expect(byId.get(goneFindingId)?.softwareInventoryId).toBeNull();
    expect(byId.get(goneFindingId)?.status).toBe('open');
  });
});
