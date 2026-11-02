/** Real database predicates for W08 admission, retry selection and board scope. */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { alerts, monitorDefinitions, organizationExternalLinks, partners, psaConnections, psaTicketMappings } from '../../db/schema';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { encryptCredentials } from '../../services/psa/credentials';
import { psaInstanceKey } from '../../services/psaAlertTicketing/config';
import { activeTargets, dueMappings, insertAdmission, loadAdmission } from '../../services/psaAlertTicketing/storage';
import { loadTicketingContext } from '../../services/psaAlertTicketing/workerStorage';

const system = <T>(fn: () => Promise<T>) => withDbAccessContext({ scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null }, fn);
async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  const credentials = { baseUrl: 'https://example-psa.test', companyId: 'example', publicKey: 'public', privateKey: 'private' };
  const config = { enabled: true, boardId: 1, openStatusId: 2, closedStatusId: 3,
    companyLinksConfirmedFor: psaInstanceKey('connectwise', credentials) };
  const [connection] = await system(() => db.insert(psaConnections).values({
    name: 'Example PSA', provider: 'connectwise', partnerId: partner.id,
    credentials: encryptCredentials(credentials), alertTicketingRev: 1,
    alertTicketingEnabledAt: new Date(), alertTicketing: config,
  }).returning());
  await system(() => db.update(partners).set({ serviceManagementMode: 'external',
    serviceManagementPsaConnectionId: connection!.id }).where(eq(partners.id, partner.id)));
  const addAlert = async (monitorId?: string) => {
    const [row] = await system(() => db.insert(alerts).values({ orgId: org.id, deviceId: device.id,
      severity: 'high', title: 'Example alert', monitorId }).returning());
    return row!;
  };
  return { partner, org, device, connection: connection!, config, addAlert };
}

describe('W08 ticketing database recovery predicates', () => {
  it('rearms skipped company mappings only after a company link arrives', async () => {
    const f = await fixture();
    const alert = await f.addAlert();
    const [mapping] = await system(() => db.insert(psaTicketMappings).values({ connectionId: f.connection.id,
      alertId: alert.id, deviceId: f.device.id, createState: 'skipped_no_company' }).returning());
    expect(await dueMappings(new Date())).not.toContain(mapping!.id);
    await system(() => db.insert(organizationExternalLinks).values({ orgId: f.org.id, partnerId: f.partner.id,
      system: 'connectwise', externalId: 'example-company' }));
    expect(await dueMappings(new Date(Date.now() + 1000))).toContain(mapping!.id);
    const [saved] = await system(() => db.select().from(psaTicketMappings).where(eq(psaTicketMappings.id, mapping!.id)));
    expect(saved!.createState).toBe('never_attempted');
  });

  it('selects created tickets for resolved alerts but excludes closed tickets', async () => {
    const f = await fixture();
    const pendingAlert = await f.addAlert();
    const closedAlert = await f.addAlert();
    await system(() => db.update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(alerts.orgId, f.org.id)));
    const mappings = await system(() => db.insert(psaTicketMappings).values([
      { connectionId: f.connection.id, alertId: pendingAlert.id, createState: 'created', externalTicketId: 'open', closeState: 'none' },
      { connectionId: f.connection.id, alertId: closedAlert.id, createState: 'created', externalTicketId: 'closed', closeState: 'closed' },
    ]).returning());
    const due = await dueMappings(new Date());
    expect(due).toContain(mappings[0]!.id);
    expect(due).not.toContain(mappings[1]!.id);
  });

  it('uses the partner monitor board override and rejects a monitor belonging to another org', async () => {
    const f = await fixture();
    const otherOrg = await createOrganization({ partnerId: f.partner.id });
    const monitors = await system(() => db.insert(monitorDefinitions).values([
      { partnerId: f.partner.id, name: 'Partner monitor', kind: 'cpu', severity: 'high', condition: {}, psaBoardId: 42 },
      { orgId: otherOrg.id, name: 'Other org monitor', kind: 'cpu', severity: 'high', condition: {}, psaBoardId: 99 },
    ]).returning());
    for (const [index, boardId] of [[0, 42], [1, 1]] as const) {
      const alert = await f.addAlert(monitors[index]!.id);
      const loaded = await loadAdmission(alert.id);
      expect(loaded).not.toBeNull();
      const mappingId = await insertAdmission(loaded!.alert, loaded!.target, 'auto');
      expect(typeof mappingId).toBe('string');
      const context = await loadTicketingContext(mappingId!);
      expect(context!.snapshot.input.boardId).toBe(boardId);
    }
  });

  it.each(['disabled', 'different_binding', 'revision_changed'] as const)('rejects stale admission at the database boundary: %s', async (kind) => {
    const f = await fixture();
    const alert = await f.addAlert();
    const loaded = await loadAdmission(alert.id);
    expect(loaded).not.toBeNull();
    if (kind === 'disabled') {
      await system(() => db.update(psaConnections).set({ alertTicketing: { ...f.config, enabled: false } }).where(eq(psaConnections.id, f.connection.id)));
    } else if (kind === 'different_binding') {
      const [other] = await system(() => db.insert(psaConnections).values({ name: 'Other PSA', provider: 'connectwise',
        partnerId: f.partner.id, credentials: f.connection.credentials }).returning());
      await system(() => db.update(partners).set({ serviceManagementPsaConnectionId: other!.id }).where(eq(partners.id, f.partner.id)));
    } else {
      await system(() => db.update(psaConnections).set({ alertTicketingRev: 2 }).where(eq(psaConnections.id, f.connection.id)));
    }
    expect(await insertAdmission(loaded!.alert, loaded!.target, 'auto')).toBe('inactive');
    if (kind !== 'revision_changed') {
      expect(await loadAdmission(alert.id)).toBeNull();
      expect((await activeTargets()).map(target => target.connectionId)).not.toContain(f.connection.id);
    }
    expect(await system(() => db.select().from(psaTicketMappings).where(eq(psaTicketMappings.alertId, alert.id)))).toEqual([]);
  });
});
