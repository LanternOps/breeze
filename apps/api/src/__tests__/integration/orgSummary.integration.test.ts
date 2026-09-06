/**
 * Real-Postgres coverage for GET /orgs/organizations/:id/summary (#5075 W02,
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
import { alerts, devices, tickets } from '../../db/schema';
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

    await withSystemDbAccessContext(async () => {
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
    });

    const res = await client.get(`/orgs/organizations/${organization.id}/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.orgId).toBe(organization.id);
    expect(body.devices).toEqual({ total: 2, online: 1, offline: 1 });
    expect(body.alerts).toEqual({ open: 1, critical: 1, high: 0 });
    expect(body.tickets).toEqual({ open: 1, awaitingCustomer: 0 });
    expect(body.sites.count).toBeGreaterThanOrEqual(1);
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
