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

import { describe, it, expect, vi } from 'vitest';
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
  partners,
  psaConnections,
  psaTicketMappings,
} from '../../db/schema';
import { createIntegrationTestClient, createOrganization, createPartner, createSite } from './db-utils';

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
        name: 'Example PSA',
        provider: 'jira',
        orgId: null,
        partnerId,
        credentials: { baseUrl: 'https://example-psa.test', apiToken: 'tok' },
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

// W08 admission guard: the actual partial unique index and binding resolver,
// without a Redis wake-up (the reconciler repairs a lost enqueue).
import { loadAdmission, insertAdmission, admissionCandidates } from '../../services/psaAlertTicketing/storage';
import { encryptCredentials } from '../../services/psa/credentials';
import { claimTicketing, loadTicketingContext, saveTicketing } from '../../services/psaAlertTicketing/workerStorage';
import { randomUUID } from 'node:crypto';
import { psaInstanceKey } from '../../services/psaAlertTicketing/config';
describe('W08 committed admission ledger', () => {
  it('dedupes concurrent admissions and rejects a non-external binding', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    const org = client.env.organization;
    const partnerId = client.env.partner.id;
    const credentials = { baseUrl: 'https://example-psa.test', companyId: 'example', publicKey: 'public', privateKey: 'private' };
    const [connection] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(psaConnections).values({
      name: 'Example PSA', provider: 'connectwise', partnerId, orgId: null,
      credentials: encryptCredentials(credentials), alertTicketingRev: 1, alertTicketingEnabledAt: new Date(),
      alertTicketing: { enabled: true, boardId: 1, openStatusId: 2, closedStatusId: 3,
        companyLinksConfirmedFor: psaInstanceKey('connectwise', credentials) },
    }).returning());
    await withDbAccessContext(SYSTEM_CTX, () => db.update(partners).set({ serviceManagementMode: 'external',
      serviceManagementPsaConnectionId: connection!.id }).where(eq(partners.id, partnerId)));
    const device = await seedDevice(org.id, 'admission-host');
    const alert = await seedAlert(org.id, device, 'Admission alert');
    const loaded = await loadAdmission(alert);
    expect(loaded).not.toBeNull();
    // More than one batch of filtered rows cannot hide a qualifying alert.
    await withDbAccessContext(SYSTEM_CTX, () => db.insert(alerts).values(Array.from({length:501}, (_,i)=>({
      orgId:org.id,deviceId:device,severity:'info' as const,title:`Filtered alert ${i}`,triggeredAt:new Date(Date.now()-60000),
    }))));
    expect(await admissionCandidates(connection!.id,new Date(Date.now()-3600000),{...loaded!.target.config,minSeverity:'high'})).toContain(alert);
    const results = await Promise.all([insertAdmission(loaded!.alert, loaded!.target, 'auto'), insertAdmission(loaded!.alert, loaded!.target, 'auto')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(psaTicketMappings).where(eq(psaTicketMappings.alertId, alert)));
    expect(rows).toHaveLength(1);
    const context=await loadTicketingContext(rows[0]!.id);
    expect(context).not.toBeNull();
    // Even an otherwise eligible create loses its claim after a config edit.
    await withDbAccessContext(SYSTEM_CTX,()=>db.update(psaConnections).set({alertTicketingRev:2}).where(eq(psaConnections.id,connection!.id)));
    expect(await claimTicketing(context!.mapping,randomUUID(),{createState:'create_in_flight',createSnapshot:context!.snapshot},new Date())).toBe(false);
    // Two replicas observing the same row still grant one permission to send.
    await withDbAccessContext(SYSTEM_CTX,()=>db.update(psaConnections).set({alertTicketingRev:1}).where(eq(psaConnections.id,connection!.id)));
    const refreshed=await loadTicketingContext(rows[0]!.id);
    const tokens=[randomUUID(),randomUUID()];
    const claims=await Promise.all(tokens.map(token=>claimTicketing(refreshed!.mapping,token,{createState:'create_in_flight',createSnapshot:refreshed!.snapshot},new Date())));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await saveTicketing(rows[0]!.id,randomUUID(),{createState:'failed'},new Date())).toBe(false);
    await withDbAccessContext(SYSTEM_CTX, () => db.update(partners).set({ serviceManagementMode: 'native' }).where(eq(partners.id, partnerId)));
    expect(await loadAdmission(alert)).toBeNull();
  });
});

import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { createSourcedAlert } from '../../services/alertService';
import { drainSubjectAlertOutbox } from '../../services/subjectAlertOutbox';
import * as eventBus from '../../services/eventBus';


async function mappingRows(id: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: psaTicketMappings.id, connectionId: psaTicketMappings.connectionId })
      .from(psaTicketMappings).where(eq(psaTicketMappings.id, id)));
}

async function alertRows(id: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: alerts.id, orgId: alerts.orgId }).from(alerts).where(eq(alerts.id, id)));
}

describe('W08 PSA ledger follows alert/device lifecycle', () => {
  it.each([
    [false, 'device'], [false, 'alert'], [true, 'device'], [true, 'alert'],
  ] as const)('device mover crossPartner=%s anchor=%s', async (crossPartner, anchor) => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    const sourceOrg = client.env.organization;
    const sourcePartner = client.env.partner;
    const targetPartner = crossPartner ? await createPartner() : sourcePartner;
    const targetOrg = await createOrganization({ partnerId: targetPartner.id });
    const targetSite = await createSite({ orgId: targetOrg.id });
    const connectionId = await seedPartnerConnection(sourcePartner.id);
    const deviceId = await seedDevice(sourceOrg.id, 'mapping-move-device');
    const alertId = await seedAlert(sourceOrg.id, deviceId, 'Mapping move alert');
    const anchors = anchor === 'device' ? { deviceId } : { alertId };
    const mappingId = await seedMapping(connectionId, 'MOVE-1', anchors);

    // A second device proves the deletion is scoped to the moving device.
    const otherDevice = await seedDevice(sourceOrg.id, 'mapping-stays-device');
    const otherAlert = await seedAlert(sourceOrg.id, otherDevice, 'Mapping remains alert');
    const otherId = await seedMapping(connectionId, 'STAY-1',
      anchor === 'device' ? { deviceId: otherDevice } : { alertId: otherAlert });

    // A row already pinned to the destination partner must survive. This
    // catches a deletion that tests only cross-partner=true and omits the
    // connection.partner_id mismatch predicate.
    const destinationConnectionId = crossPartner
      ? await seedPartnerConnection(targetPartner.id) : null;
    const destinationMappingId = destinationConnectionId
      ? await seedMapping(destinationConnectionId, 'DEST-1', anchors) : null;

    await withDbAccessContext(SYSTEM_CTX, () => db.transaction((tx) =>
      moveDeviceOrgInTransaction(tx, {
        deviceId, sourceOrgId: sourceOrg.id, targetOrgId: targetOrg.id,
        targetSiteId: targetSite.id, targetOrgName: targetOrg.name,
        deviceLinkGroupId: null, acceptCurrencyMismatch: false,
        actor: { userId: client.env.user.id, allowedSiteIds: undefined },
        stepUp: null, via: 'generic_move',
      })));

    expect(await mappingRows(mappingId)).toEqual(crossPartner ? [] : [{ id: mappingId, connectionId }]);
    expect(await mappingRows(otherId)).toEqual([{ id: otherId, connectionId }]);
    if (destinationMappingId) {
      expect(await mappingRows(destinationMappingId))
        .toEqual([{ id: destinationMappingId, connectionId: destinationConnectionId }]);
    }
    expect(await alertRows(alertId)).toEqual([{ id: alertId, orgId: targetOrg.id }]);
    expect(await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, deviceId))))
      .toEqual([{ orgId: targetOrg.id }]);
  });

  it.each(['alert', 'both'] as const)('deleting an alert cascades a %s-anchored mapping', async (anchor) => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    const connectionId = await seedPartnerConnection(client.env.partner.id);
    const deviceId = await seedDevice(client.env.organization.id, 'mapping-delete-device');
    const alertId = await seedAlert(client.env.organization.id, deviceId, 'Delete mapped alert');
    const mappingId = await seedMapping(connectionId, 'DELETE-1',
      anchor === 'both' ? { alertId, deviceId } : { alertId });
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(alerts).where(eq(alerts.id, alertId)));
    expect(await alertRows(alertId)).toEqual([]);
    expect(await mappingRows(mappingId)).toEqual([]);
  });

  it('legacy publish compensation deletes an alert even when a subscriber admitted its mapping', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    const connectionId = await seedPartnerConnection(client.env.partner.id);
    const deviceId = await seedDevice(client.env.organization.id, 'mapping-rollback-device');
    let publishedAlertId: string | undefined;
    let mappingId: string | undefined;
    const publish = vi.spyOn(eventBus, 'publishEvent').mockImplementation(async (_type, _orgId, payload) => {
      publishedAlertId = (payload as Record<string, unknown>).alertId as string;
      mappingId = await seedMapping(connectionId, 'ROLLBACK-1', { alertId: publishedAlertId, deviceId });
      throw new Error('Fixture publication failure after admission');
    });
    try {
      const result = await withDbAccessContext(SYSTEM_CTX, () => createSourcedAlert({
        deviceId, orgId: client.env.organization.id, severity: 'high',
        title: 'Mapped rollback alert', message: 'Fixture message',
        context: { source: 'network_monitor' }, publisher: 'monitor-worker',
      }));
      expect(result).toBeNull();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publishedAlertId).toBeTruthy();
      expect(mappingId).toBeTruthy();
      expect(await alertRows(publishedAlertId!)).toEqual([]);
      expect(await mappingRows(mappingId!)).toEqual([]);
    } finally {
      publish.mockRestore();
    }
  });

  it('subject outbox compensation deletes a committed mapped alert on publication failure', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'partner' });
    const connectionId = await seedPartnerConnection(client.env.partner.id);
    const deviceId = await seedDevice(client.env.organization.id, 'mapping-outbox-device');
    const alertId = await seedAlert(client.env.organization.id, deviceId, 'Mapped outbox alert');
    const mappingId = await seedMapping(connectionId, 'OUTBOX-1', { alertId, deviceId });
    await withDbAccessContext(SYSTEM_CTX, () => db.update(alerts).set({
      context: { _subjectDispatch: {
        eventId: alertId, eventType: 'alert.triggered', siteId: null,
        cooldownMinutes: 0, payload: { alertId, deviceId },
      } },
    }).where(eq(alerts.id, alertId)));
    const publish = vi.spyOn(eventBus, 'publishEvent')
      .mockRejectedValue(new Error('Fixture outbox publication failure'));
    try {
      // Must be called OUTSIDE any ambient DB context; it opens its own
      // short system contexts and a new compensation transaction.
      await drainSubjectAlertOutbox(deviceId);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await alertRows(alertId)).toEqual([]);
      expect(await mappingRows(mappingId)).toEqual([]);
    } finally {
      publish.mockRestore();
    }
  });
});
