/**
 * #3205 W07 decision 10a — THE BLOCKING REGRESSION.
 *
 * breeze_cascade_device_org_id() restamps org_id on every table
 * breeze_device_child_orgid_tables() returns, DURING the devices UPDATE and
 * before any route code runs. That function discovers tables dynamically, so
 * without migration 2026-10-08-101300-device-move-exclude-billing-evidence.sql invoice_line_devices is auto-enrolled and
 * the initially-immediate composite FKs raise 23503, failing every cross-org
 * move of a billed device. A red here IS that failure.
 *
 * The exclusion also has to SURVIVE another suite replaying an EARLIER
 * definer of the same function by path — see the last case below and
 * `replayMigration.ts` (#3205 W07 / PR #4838 CI shard-4 regression).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, invoices, invoiceLines } from '../../db/schema';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { createAccessToken } from '../../services/jwt';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { replayMigration } from './replayMigration';

async function seed() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const { partner, organization: oA, site: siteA, user, role } = env;
  const oB = await createOrganization({ partnerId: partner.id });
  const siteB = await createSite({ orgId: oB.id });

  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [dev] = await db.insert(devices).values({
      orgId: oA.id, siteId: siteA.id, agentId: `agent-${sfx}`, hostname: 'billed-01',
      status: 'online', deviceRole: 'server', osType: 'linux', osVersion: '22.04',
      architecture: 'x86_64', agentVersion: '0.0.0-test',
    }).returning({ id: devices.id });
    const [inv] = await db.insert(invoices)
      .values({ partnerId: partner.id, orgId: oA.id, currencyCode: 'USD', status: 'sent', invoiceNumber: `INV-${sfx}` })
      .returning({ id: invoices.id });
    const [line] = await db.insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: oA.id, sourceType: 'contract', description: 'Endpoints',
      quantity: '1.00', unitPrice: '10.00', lineTotal: '10.00',
    }).returning({ id: invoiceLines.id });
    await db.execute(sql`
      INSERT INTO invoice_line_devices (invoice_line_id, invoice_id, org_id, device_id, hostname, device_role, site_id, counted_as)
      VALUES (${line!.id}::uuid, ${inv!.id}::uuid, ${oA.id}::uuid, ${dev!.id}::uuid, 'billed-01', 'server', ${siteA.id}::uuid, 'included')
    `);

    const token = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });
    const app = new Hono();
    app.route('/devices', moveOrgRoutes);

    return {
      orgA: oA.id,
      orgB: oB.id,
      deviceId: dev!.id,
      invoiceId: inv!.id,
      lineId: line!.id,
      postMove: () => app.request(`/devices/${dev!.id}/move-org`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: oB.id, siteId: siteB.id }),
      }),
    };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('cross-org device move with billing evidence (real DB) #3205 W07', () => {
  runDb('breeze_device_child_orgid_tables() does NOT return invoice_line_devices', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT 1 AS hit FROM public.breeze_device_child_orgid_tables() t(name) WHERE t.name = 'invoice_line_devices'
    `));
    // A future CREATE OR REPLACE of that function which drops the exclusion
    // fails HERE, not in production on a customer's device move.
    expect(rows).toEqual([]);
  });

  runDb('the move SUCCEEDS, the evidence keeps the invoice org, and device_id detaches', async () => {
    const f = await seed();
    // A 23503 raised inside this call is the exact failure the exclusion prevents.
    const res = await f.postMove();
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    const ev = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT org_id, invoice_id, device_id, hostname, device_role FROM invoice_line_devices WHERE invoice_line_id = ${f.lineId}::uuid
    `));
    expect(ev).toEqual([{
      org_id: f.orgA,            // stays with the INVOICE's org
      invoice_id: f.invoiceId,
      device_id: null,           // moveOrg.ts's explicit detach — load-bearing, not a mirror
      hostname: 'billed-01',     // still legible after the detach
      device_role: 'server',
    }]);
    const inv = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT org_id FROM invoices WHERE id = ${f.invoiceId}::uuid
    `));
    expect(inv).toEqual([{ org_id: f.orgA }]);
    const dev = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT org_id FROM devices WHERE id = ${f.deviceId}::uuid
    `));
    expect(dev).toEqual([{ org_id: f.orgB }]);
  });

  runDb('the exclusion survives a later suite replaying the EARLIER pam-device-move-guard.sql definer by path', async () => {
    // pamDeviceMoveGuard.integration.test.ts replays this exact file (to
    // prove it's a privilege-grant no-op on re-apply). That file's own
    // CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
    // body predates 2026-10-08-101300-device-move-exclude-billing-evidence.sql's
    // invoice_line_devices exclusion — a bare replay reverts the function to
    // the older body for the rest of this vitest process. replayMigration
    // (unlike a bare readFile + sql.raw) re-applies every LATER migration
    // that redefines the same function, so the exclusion must still hold
    // immediately afterward.
    await replayMigration('2026-09-17-pam-device-move-guard.sql');

    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT 1 AS hit FROM public.breeze_device_child_orgid_tables() t(name) WHERE t.name = 'invoice_line_devices'
    `));
    expect(rows).toEqual([]);
  });
});
