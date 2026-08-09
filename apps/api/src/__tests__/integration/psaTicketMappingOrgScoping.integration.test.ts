/**
 * PSA ticket-mapping org scoping — the cross-org data leak (PR #3308 review,
 * findings 0/1/8).
 *
 * THE CONCEPTUAL ERROR THIS GUARDS: "partner scope" is not authorization for
 * everything reachable from a partner-owned row. Two different things were
 * conflated:
 *
 *   psa_connections  = partner-owned CONFIG. Correctly visible to any
 *                      partner-scope caller of that partner.
 *   psa_ticket_mappings = PER-ORG DATA. Each row names a specific org's device,
 *                      alert, and external ticket id/URL. It must ALWAYS be
 *                      filtered by the caller's accessible orgs, whatever the
 *                      scope.
 *
 * Because the route scoped tickets through the CONNECTION, a partner_user with
 * org_access='selected' limited to org A read org B's external ticket ids and
 * URLs through the shared partner-wide connection. RLS cannot catch this: the
 * psa_ticket_mappings connection arm passes for every partner-scope caller of
 * the owning partner (it must — an unanchored mapping has no org to check), so
 * `psaTicketMappingOrgCondition` in routes/psa.ts is the enforcement point.
 * That makes these route-level tests, against a real DB, the only thing that
 * can prove the fix. A Drizzle mock would return whatever rows we fabricate.
 *
 * Also covers the mirror image (finding 8): an ORG-scope caller must SEE their
 * own device's ticket under a partner-wide connection. That previously returned
 * an empty list, because the query innerJoin'd psa_connections and RLS hides
 * partner-wide connections from org tokens.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 */
import './setup';

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
// psaRoutes applies authMiddleware itself (`psaRoutes.use('*', ...)`), so the
// harness must NOT wrap it again.
import { psaRoutes } from '../../routes/psa';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts,
  devices,
  partnerUsers,
  psaConnections,
  psaTicketMappings,
} from '../../db/schema';
import { createIntegrationTestClient, createOrganization, createSite } from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/psa', psaRoutes);
  return app;
}

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

async function seedDevice(orgId: string, hostname: string) {
  const site = await createSite({ orgId });
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(devices)
      .values({
        orgId,
        siteId: site.id,
        agentId: `psa-scope-${site.id.slice(0, 16)}`,
        hostname,
        osType: 'windows',
        osVersion: '10.0',
        architecture: 'x64',
        agentVersion: '1.0.0',
      })
      .returning(),
  );
  return rows[0]!.id;
}

async function seedAlert(orgId: string, deviceId: string, title: string) {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(alerts)
      .values({ orgId, deviceId, configItemName: title, severity: 'high', title })
      .returning({ id: alerts.id }),
  );
  return rows[0]!.id;
}

async function seedPartnerConnection(partnerId: string) {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(psaConnections)
      .values({
        name: 'MSP Jira',
        provider: 'jira',
        orgId: null,
        partnerId,
        credentials: { baseUrl: 'https://acme.atlassian.net', apiToken: 'tok' },
      })
      .returning(),
  );
  return rows[0]!.id;
}

async function seedMapping(
  connectionId: string,
  externalTicketId: string,
  anchors: { deviceId?: string; alertId?: string },
) {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(psaTicketMappings)
      .values({ connectionId, externalTicketId, ...anchors })
      .returning(),
  );
  return rows[0]!.id;
}

function ticketIds(body: { data?: Array<{ raw?: { externalTicketId?: string | null } }> }) {
  return (body.data ?? []).map((row) => row.raw?.externalTicketId).filter(Boolean);
}

describe('GET /psa/tickets — org scoping of partner-wide connection data', () => {
  it('LEAK GUARD: a selected-access partner user sees only their own orgs\' mappings', async () => {
    const app = buildApp();
    // setupTestEnvironment builds partner + org A and a partner-scope token.
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const partnerId = client.env.partner.id;
    const orgA = client.env.organization;

    // A second org under the SAME partner, which this user must not reach.
    const orgB = await createOrganization({ partnerId });

    // Restrict the membership to org A only.
    await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .update(partnerUsers)
        .set({ orgAccess: 'selected', orgIds: [orgA.id] })
        .where(eq(partnerUsers.userId, client.env.user.id)),
    );

    const connectionId = await seedPartnerConnection(partnerId);
    const deviceA = await seedDevice(orgA.id, 'org-a-host');
    const deviceB = await seedDevice(orgB.id, 'org-b-host');
    await seedMapping(connectionId, 'ORG-A-1', { deviceId: deviceA });
    await seedMapping(connectionId, 'ORG-B-SECRET', { deviceId: deviceB });

    const res = await client.get('/psa/tickets?limit=50');
    expect(res.status).toBe(200);
    const seen = ticketIds(await res.json());

    expect(seen).toContain('ORG-A-1');
    // The leak: org B's external ticket id must never appear.
    expect(seen).not.toContain('ORG-B-SECRET');
  });

  it('LEAK GUARD: the same holds for GET /connections/:id/tickets', async () => {
    // This route applied NO org filter at all once connection access passed.
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const partnerId = client.env.partner.id;
    const orgA = client.env.organization;
    const orgB = await createOrganization({ partnerId });

    await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .update(partnerUsers)
        .set({ orgAccess: 'selected', orgIds: [orgA.id] })
        .where(eq(partnerUsers.userId, client.env.user.id)),
    );

    const connectionId = await seedPartnerConnection(partnerId);
    const deviceA = await seedDevice(orgA.id, 'org-a-host-2');
    const deviceB = await seedDevice(orgB.id, 'org-b-host-2');
    await seedMapping(connectionId, 'CONN-ORG-A', { deviceId: deviceA });
    await seedMapping(connectionId, 'CONN-ORG-B-SECRET', { deviceId: deviceB });

    const res = await client.get(`/psa/connections/${connectionId}/tickets?limit=50`);
    expect(res.status).toBe(200);
    const seen = ticketIds(await res.json());

    expect(seen).toContain('CONN-ORG-A');
    expect(seen).not.toContain('CONN-ORG-B-SECRET');
  });

  it('the ALERT anchor is scoped too, not just the device anchor', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const partnerId = client.env.partner.id;
    const orgA = client.env.organization;
    const orgB = await createOrganization({ partnerId });

    await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .update(partnerUsers)
        .set({ orgAccess: 'selected', orgIds: [orgA.id] })
        .where(eq(partnerUsers.userId, client.env.user.id)),
    );

    const connectionId = await seedPartnerConnection(partnerId);
    const deviceB = await seedDevice(orgB.id, 'org-b-alert-host');
    const alertB = await seedAlert(orgB.id, deviceB, 'Org B alert');
    // device_id NULL — only the alert anchors this row to org B.
    await seedMapping(connectionId, 'ALERT-ORG-B-SECRET', { alertId: alertB });

    const res = await client.get('/psa/tickets?limit=50');
    expect(res.status).toBe(200);
    expect(ticketIds(await res.json())).not.toContain('ALERT-ORG-B-SECRET');
  });

  it('a FULL partner admin still sees every org\'s mappings', async () => {
    // The fix must not over-restrict: org_access='all' keeps full reach.
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const partnerId = client.env.partner.id;
    const orgA = client.env.organization;
    const orgB = await createOrganization({ partnerId });

    const connectionId = await seedPartnerConnection(partnerId);
    const deviceA = await seedDevice(orgA.id, 'full-a-host');
    const deviceB = await seedDevice(orgB.id, 'full-b-host');
    await seedMapping(connectionId, 'FULL-ORG-A', { deviceId: deviceA });
    await seedMapping(connectionId, 'FULL-ORG-B', { deviceId: deviceB });

    const res = await client.get('/psa/tickets?limit=50');
    expect(res.status).toBe(200);
    const seen = ticketIds(await res.json());
    expect(seen).toContain('FULL-ORG-A');
    expect(seen).toContain('FULL-ORG-B');
  });

  it('FINDING 8: an ORG-scope caller sees their own device\'s ticket under a PARTNER-wide connection', async () => {
    // Previously an empty list: the query innerJoin'd psa_connections, and
    // psa_connections RLS hides partner-wide rows from org tokens, so the
    // ticket vanished with the connection it hung off.
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'organization' });
    const partnerId = client.env.partner.id;
    const org = client.env.organization;

    const connectionId = await seedPartnerConnection(partnerId);
    const deviceId = await seedDevice(org.id, 'org-scope-host');
    await seedMapping(connectionId, 'MY-OWN-TICKET', { deviceId });

    const res = await client.get('/psa/tickets?limit=50');
    expect(res.status).toBe(200);
    expect(ticketIds(await res.json())).toContain('MY-OWN-TICKET');
  });

  it('an org-scope caller still cannot see ANOTHER org\'s ticket on that connection', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'organization' });
    const partnerId = client.env.partner.id;
    const otherOrg = await createOrganization({ partnerId });

    const connectionId = await seedPartnerConnection(partnerId);
    const otherDevice = await seedDevice(otherOrg.id, 'other-org-host');
    await seedMapping(connectionId, 'OTHER-ORG-SECRET', { deviceId: otherDevice });

    const res = await client.get('/psa/tickets?limit=50');
    expect(res.status).toBe(200);
    expect(ticketIds(await res.json())).not.toContain('OTHER-ORG-SECRET');
  });
});
