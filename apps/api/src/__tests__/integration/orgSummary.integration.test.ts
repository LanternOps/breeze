/**
 * Real-Postgres coverage for GET /orgs/organizations/:id/summary (#5075 W01,
 * wave-5076). The mocked unit suite (routes/orgSummary.test.ts) pins the
 * permission-gated section shape; this proves the actual aggregate SQL
 * (FILTER-based counts, cross-tenant isolation) against genuine rows.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { orgSummaryRoutes } from '../../routes/orgSummary';
import { db, withSystemDbAccessContext } from '../../db';
import { alerts, auditLogs, contacts, contracts, devices, invoices, portalUsers, tickets } from '../../db/schema';
import { createIntegrationTestClient, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/orgs', orgSummaryRoutes);
  return app;
}

describe('GET /orgs/organizations/:id/summary', () => {
  runDb('aggregates devices, alerts, tickets, and sites for the org', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const { organization } = client.env;
    const site = await createSite({ orgId: organization.id });

    const suffix = randomUUID().slice(0, 8);
    // Seeding writes real rows through breeze_app's FORCE-RLS tables — must
    // run under system scope, same as every other integration fixture that
    // inserts through the app `db` handle (see billingEvidenceConstraints
    // .integration.test.ts) rather than the privileged test-only connection
    // db-utils.ts uses for partner/org/site scaffolding.
    const onlineDeviceRow = await withSystemDbAccessContext(async () => {
      await db.insert(devices).values([
        {
          orgId: organization.id,
          siteId: site.id,
          agentId: `agent-online-${suffix}`,
          hostname: 'online-01',
          status: 'online',
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.99.0',
        },
        {
          orgId: organization.id,
          siteId: site.id,
          agentId: `agent-offline-${suffix}`,
          hostname: 'offline-01',
          status: 'offline',
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.99.0',
        },
      ]);
      // Pull back the online device row (by agentId, unique) to attach the
      // alert to it — org-scoped so this can't collide with another test's rows.
      const [row] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.agentId, `agent-online-${suffix}`));
      return row;
    });

    const newerAuditRow = await withSystemDbAccessContext(async () => {
      await db.insert(alerts).values({
        deviceId: onlineDeviceRow!.id,
        orgId: organization.id,
        status: 'active',
        severity: 'critical',
        title: `Disk full ${suffix}`,
      });

      await db.insert(tickets).values({
        orgId: organization.id,
        partnerId: client.env.partner.id,
        ticketNumber: `SUM-${suffix}`,
        subject: `Summary ticket ${suffix}`,
        source: 'manual',
        status: 'open',
      });

      // Contracts: one active with a future end date (counts toward `active`
      // AND is the nextRenewalAt candidate), one non-active that must NOT be
      // counted — `active` filters on status alone, so a status other than
      // 'active' is the only way to exclude a row from that count.
      await db.insert(contracts).values([
        {
          partnerId: client.env.partner.id,
          orgId: organization.id,
          name: `Active contract ${suffix}`,
          status: 'active',
          intervalMonths: 12,
          startDate: '2026-01-01',
          endDate: '2027-06-01',
          currencyCode: 'USD',
        },
        {
          partnerId: client.env.partner.id,
          orgId: organization.id,
          name: `Cancelled contract ${suffix}`,
          status: 'cancelled',
          intervalMonths: 12,
          startDate: '2026-01-01',
          endDate: '2027-06-01',
          currencyCode: 'USD',
        },
      ]);

      // Invoices: one open+overdue (drives outstanding/nextDueAt/overdueCount),
      // one paid (must be excluded from all three).
      await db.insert(invoices).values([
        {
          partnerId: client.env.partner.id,
          orgId: organization.id,
          currencyCode: 'USD',
          status: 'sent',
          dueDate: '2020-01-01',
          total: '100.00',
          amountPaid: '0.00',
        },
        {
          partnerId: client.env.partner.id,
          orgId: organization.id,
          currencyCode: 'USD',
          status: 'paid',
          dueDate: '2026-01-01',
          total: '50.00',
          amountPaid: '50.00',
        },
      ]);

      // Contacts: exactly one primary, org-level (site_id IS NULL).
      await db.insert(contacts).values({
        orgId: organization.id,
        name: `Primary Contact ${suffix}`,
        email: `primary-${suffix}@example.com`,
        isPrimary: true,
        siteId: null,
      });
      await db.insert(contacts).values({
        orgId: organization.id,
        name: `Secondary Contact ${suffix}`,
        email: `secondary-${suffix}@example.com`,
        isPrimary: false,
        siteId: null,
      });

      // Portal users: one enabled, one disabled — `portalUsers.count` filters
      // OUT 'disabled', so only the enabled row should be counted.
      await db.insert(portalUsers).values([
        { orgId: organization.id, email: `enabled-${suffix}@example.com`, status: 'active' },
        { orgId: organization.id, email: `disabled-${suffix}@example.com`, status: 'disabled' },
      ]);

      // Audit rows: two distinct timestamps so lastActivityAt is a real MAX,
      // not a single-row coincidence. `audit_logs.timestamp` is a plain
      // `timestamp` (no time zone) column, so the exact wall-clock value that
      // round-trips through the driver depends on the runner's local
      // timezone — comparing against a hardcoded ISO literal is flaky across
      // environments. Instead, `.returning()` the newer row's own
      // driver-parsed value and assert the route reports exactly that.
      await db.insert(auditLogs).values({
        orgId: organization.id,
        timestamp: new Date('2026-08-01T00:00:00.000Z'),
        actorType: 'user',
        actorId: client.env.user.id,
        action: `summary.audit.older.${suffix}`,
        resourceType: 'organization',
        result: 'success',
      });
      const [newer] = await db
        .insert(auditLogs)
        .values({
          orgId: organization.id,
          timestamp: new Date('2026-08-15T12:00:00.000Z'),
          actorType: 'user',
          actorId: client.env.user.id,
          action: `summary.audit.newer.${suffix}`,
          resourceType: 'organization',
          result: 'success',
        })
        .returning({ timestamp: auditLogs.timestamp });
      return newer;
    });

    const res = await client.get(`/orgs/organizations/${organization.id}/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.orgId).toBe(organization.id);
    expect(body.devices).toEqual({ total: 2, online: 1, offline: 1 });
    expect(body.alerts).toEqual({ open: 1, critical: 1, high: 0 });
    expect(body.tickets).toEqual({ open: 1, awaitingCustomer: 0 });
    expect(body.sites.count).toBeGreaterThanOrEqual(1);

    expect(body.contracts).toEqual({
      active: 1,
      nextRenewalAt: new Date('2027-06-01').toISOString(),
    });

    expect(body.invoices).toEqual({
      outstanding: '100.00',
      currencyCode: 'USD',
      nextDueAt: new Date('2020-01-01').toISOString(),
      overdueCount: 1,
    });

    expect(body.contacts.count).toBe(2);
    expect(body.contacts.primary).toEqual({
      id: expect.any(String),
      name: `Primary Contact ${suffix}`,
      email: `primary-${suffix}@example.com`,
      phone: null,
    });

    expect(body.portalUsers).toEqual({ count: 1 });

    expect(body.lastActivityAt).toBe(new Date(newerAuditRow!.timestamp).toISOString());
  });

  runDb("404s for a second partner's token against the first partner's org", async () => {
    const app = buildApp();
    const firstClient = await createIntegrationTestClient(app, { scope: 'partner' });
    const secondClient = await createIntegrationTestClient(app, { scope: 'partner' });

    const res = await secondClient.get(
      `/orgs/organizations/${firstClient.env.organization.id}/summary`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Organization not found' });
  });
});
