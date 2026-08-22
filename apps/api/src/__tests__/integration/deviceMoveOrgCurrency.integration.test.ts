/**
 * Integration test: device org-move is a ticket org-move for every ticket bound
 * to the device (multi-currency wave 4, #3776, Task 13).
 *
 * Proves, against real Postgres through POST /devices/:id/move-org:
 *   (1) moving a device from a USD org to a EUR org while a bound ticket carries
 *       an unbilled part → 409 TICKET_MOVE_CURRENCY_BLOCKED with
 *       details.unbilledParts === 1, and the WHOLE transaction rolled back —
 *       devices.org_id, tickets.org_id and ticket_parts.org_id all unchanged;
 *   (2) the same request with acceptCurrencyMismatch: true → 200, the part's
 *       org_id follows the device, its currency_code snapshot stays 'USD', and
 *       both audit rows record the accepted counts;
 *   (3) acceptCurrencyMismatch: true without invoices:write → 403 before any DB
 *       write.
 *
 * Harness mirrors the moveOrg driver case in time-entries-rls: a partner-scope
 * environment with wildcard permissions and an MFA-bearing access token.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  auditLogs,
  devices,
  organizations,
  ticketParts,
  tickets,
} from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed(rolePermissions?: Array<{ resource: string; action: string }>) {
  const adminDb = getTestDb() as any;
  const unique = uid();

  // partnerA → orgA (USD, default) with siteA/userA (wildcard perms unless
  // narrowed by the caller, partner scope).
  const env = await setupTestEnvironment({ scope: 'partner', rolePermissions });
  const { partner, organization: orgA, site: siteA, user, role } = env;

  // Move target under the same partner, billing in EUR.
  const orgB = await createOrganization({ partnerId: partner.id });
  await adminDb.update(organizations).set({ currencyCode: 'EUR' }).where(eq(organizations.id, orgB.id));
  const siteB = await createSite({ orgId: orgB.id });

  const [device] = await adminDb.insert(devices).values({
    orgId: orgA.id,
    siteId: siteA.id,
    agentId: `mc-move-agent-${unique}`,
    hostname: `mc-move-host-${unique}`,
    osType: 'linux',
    osVersion: '22.04',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'offline',
  }).returning();

  const [ticket] = await adminDb.insert(tickets).values({
    orgId: orgA.id,
    partnerId: partner.id,
    deviceId: device.id,
    ticketNumber: `MC-${unique}`,
    subject: `device move currency ${unique}`,
    source: 'manual',
  }).returning();

  // Unbilled USD part — unit_price is NOT NULL, so every unbilled part is money.
  const [part] = await adminDb.insert(ticketParts).values({
    ticketId: ticket.id,
    orgId: orgA.id,
    description: `SSD ${unique}`,
    quantity: '1.00',
    unitPrice: '120.00',
    currencyCode: 'USD',
    isBillable: true,
    billingStatus: 'not_billed',
    addedBy: user.id,
  }).returning();

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
    sid: 'it-session',
  });

  const app = new Hono();
  app.route('/devices', moveOrgRoutes);

  const post = (body: Record<string, unknown>) =>
    app.request(`/devices/${device.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: orgB.id, siteId: siteB.id, ...body }),
    });

  return { adminDb, partner, orgA, orgB, siteA, siteB, device, ticket, part, role, post };
}

async function readOrgIds(f: Awaited<ReturnType<typeof seed>>) {
  const [d] = await f.adminDb.select({ orgId: devices.orgId, siteId: devices.siteId }).from(devices).where(eq(devices.id, f.device.id));
  const [t] = await f.adminDb.select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, f.ticket.id));
  const [p] = await f.adminDb
    .select({ orgId: ticketParts.orgId, currencyCode: ticketParts.currencyCode, unitPrice: ticketParts.unitPrice })
    .from(ticketParts)
    .where(eq(ticketParts.id, f.part.id));
  return { device: d, ticket: t, part: p };
}

describe('POST /devices/:id/move-org — ticket currency guard (#3776)', () => {
  it('409s a USD→EUR move while a bound ticket carries an unbilled part, and rolls the whole move back', async () => {
    const f = await seed();

    const res = await f.post({});
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('TICKET_MOVE_CURRENCY_BLOCKED');
    expect(body.details).toEqual({
      sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 0, unbilledParts: 1, accepted: false,
      blockedByCurrency: [{ currencyCode: 'USD', timeEntries: 0, parts: 1 }],
    });
    expect(body.error).toContain('bills in EUR');

    // Transaction rolled back: the device flip, the tickets rewrite and the
    // part rewrite were all undone.
    const after = await readOrgIds(f);
    expect(after.device?.orgId).toBe(f.orgA.id);
    expect(after.device?.siteId).toBe(f.siteA.id);
    expect(after.ticket?.orgId).toBe(f.orgA.id);
    expect(after.part?.orgId).toBe(f.orgA.id);
    expect(after.part?.currencyCode).toBe('USD');

    // A policy block is not a failure: no device.move_org.* audit rows at all.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const audits = await f.adminDb
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, f.device.id));
    expect(audits).toHaveLength(0);
  });

  it('acceptCurrencyMismatch moves the device and its ticket, keeps the USD snapshot under the EUR org, and audits the counts', async () => {
    const f = await seed();

    const res = await f.post({ acceptCurrencyMismatch: true });
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.success).toBe(true);

    const after = await readOrgIds(f);
    expect(after.device?.orgId).toBe(f.orgB.id);
    expect(after.ticket?.orgId).toBe(f.orgB.id);
    expect(after.part?.orgId).toBe(f.orgB.id);
    expect(after.part?.currencyCode).toBe('USD'); // snapshot never restamped
    expect(after.part?.unitPrice).toBe('120.00');

    // writeRouteAudit is fire-and-forget — let it land.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const audits = await f.adminDb
      .select({ action: auditLogs.action, orgId: auditLogs.orgId, details: auditLogs.details })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, f.device.id));
    const actions = audits.map((a: { action: string }) => a.action).sort();
    expect(actions).toEqual(['device.move_org.source', 'device.move_org.target']);
    for (const a of audits) {
      expect(a.details).toMatchObject({
        currencyMismatchAccepted: {
          sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 0, unbilledParts: 1, accepted: true,
          blockedByCurrency: [{ currencyCode: 'USD', timeEntries: 0, parts: 1 }],
        },
      });
    }
  });

  it('403s acceptCurrencyMismatch without invoices:write before any write', async () => {
    // Exactly the move's own gates — no invoices:write.
    const f = await seed([
      { resource: 'devices', action: 'write' },
      { resource: 'organizations', action: 'write' },
    ]);

    const res = await f.post({ acceptCurrencyMismatch: true });
    const body = (await res.json()) as any;
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.error).toMatch(/invoices:write/);

    const after = await readOrgIds(f);
    expect(after.device?.orgId).toBe(f.orgA.id);
    expect(after.ticket?.orgId).toBe(f.orgA.id);
    expect(after.part?.orgId).toBe(f.orgA.id);

    // Without the flag the same caller is blocked by the guard (409), proving
    // the 403 above came from the invoices:write gate, not the move's own gates.
    const plain = await f.post({});
    expect(plain.status).toBe(409);
  });
});
