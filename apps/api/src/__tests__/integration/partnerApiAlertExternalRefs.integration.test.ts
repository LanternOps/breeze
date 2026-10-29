import './setup';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { withSystemDbAccessContext, type Database } from '../../db';
import {
  alertExternalRefs, alerts, auditLogs, organizationExternalLinks, organizations,
  partnerApiIdempotencyKeys, partnerServicePrincipals, psaConnections, psaTicketMappings, ticketAlertLinks, ticketExternalRefs, tickets,
} from '../../db/schema';
import { partnerApiRoutes } from '../../routes/partnerApi';
import { listAlertExternalTickets } from '../../services/alertExternalTickets';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import type { PartnerServicePrincipalScope } from '../../services/partnerServicePrincipalScopes';
import { seedAlertRefFixture } from './alertExternalRefsFixtures';
import { getTestDb } from './setup';
import { createDevice, createSite, userEpochs } from './db-utils';

const faults = vi.hoisted(() => ({ failAfterLink: false }));
vi.mock('../../config/env', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../config/env')>(),
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../services/eventBus')>(), publishEvent: vi.fn().mockResolvedValue(undefined),
}));
// Exercise the real ticket and link inserts, then force the transaction to fail.
vi.mock('../../services/ticketService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/ticketService')>();
  return { ...actual, linkAlertToTicket: async (...args: Parameters<typeof actual.linkAlertToTicket>) => {
    const result = await actual.linkAlertToTicket(...args);
    if (faults.failAfterLink) throw new actual.TicketServiceError('forced failure after link insert', 500);
    return result;
  } };
});
const runDb = it.runIf(!!process.env.DATABASE_URL);
type Fixture = Awaited<ReturnType<typeof seedAlertRefFixture>>;
async function key(f: Fixture, scopes: PartnerServicePrincipalScope[]) {
  const admin = getTestDb();
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId: f.partner.id, name: `External refs ${crypto.randomUUID()}`, scopes,
    createdBy: f.actor.id, updatedBy: f.actor.id,
  }).returning();
  const { rawKey } = await issuePartnerServicePrincipalKey(admin as unknown as Database, {
    partnerServicePrincipalId: principal!.id, partnerId: f.partner.id, name: 'External refs key',
    actorId: f.actor.id, actorSessionEpochs: await userEpochs(f.actor.id),
  });
  return { rawKey, principal: principal! };
}
function app() { const application = new Hono(); application.route('/', partnerApiRoutes); return application; }
function request(application: Hono, rawKey: string, path: string, method = 'GET', body?: unknown, idempotencyKey?: string) {
  return application.request(path, { method, headers: {
    'X-API-Key': rawKey, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function jsonOk(response: Response, status = 200): Promise<any> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}

// Real authentication, RLS, transactions, idempotency claims, and database triggers.
describe('partner API alert external refs', () => {
  runDb('namespaces PUT/DELETE by principal, reads both, and treats identical/concurrent PUTs as no-ops', async () => {
    const f = await seedAlertRefFixture();
    const a = await key(f, ['alerts:write', 'alerts:read']);
    const b = await key(f, ['alerts:write', 'alerts:read']);
    const application = app(); const admin = getTestDb();
    const path = `/alerts/${f.alert.id}/external-ticket`;
    const body = { externalId: 'PSA-42', externalUrl: 'https://psa.example/t/42?view=private', externalNumber: '42' };
    const creates = await Promise.all([request(application, a.rawKey, path, 'PUT', body), request(application, a.rawKey, path, 'PUT', body)]);
    expect(creates.map((response) => response.status).sort()).toEqual([200, 201]);
    const first = await jsonOk(creates.find((response) => response.status === 201)!, 201);
    expect(await jsonOk(creates.find((response) => response.status === 200)!)).toEqual({ ...first, changed: false });
    expect(first).toMatchObject({ changed: true, data: { alertId: f.alert.id, orgId: f.orgA.id, partnerServicePrincipalId: a.principal.id, ...body } });
    const concurrent = await Promise.all([request(application, a.rawKey, path, 'PUT', body), request(application, a.rawKey, path, 'PUT', body)]);
    for (const response of concurrent) expect(await jsonOk(response)).toEqual({ ...first, changed: false });
    expect(await jsonOk(await request(application, b.rawKey, path, 'PUT', { externalId: 'PSA-42' }), 201)).toMatchObject({ data: { partnerServicePrincipalId: b.principal.id } });
    const refs = (await jsonOk(await request(application, a.rawKey, `${path}s`))).data;
    expect(refs).toHaveLength(2);
    expect(refs.map((r: any) => r.partnerServicePrincipalId).sort()).toEqual([a.principal.id, b.principal.id].sort());
    expect(refs[0]).toMatchObject({ source: 'partner_api', externalId: 'PSA-42', state: null });
    const replacement = await jsonOk(await request(application, a.rawKey, path, 'PUT', { externalId: 'PSA-43' }));
    expect(replacement).toMatchObject({ changed: true, data: { externalUrl: null, externalNumber: null } });
    expect(await jsonOk(await request(application, a.rawKey, path, 'DELETE'))).toEqual({ schemaVersion: '1', deleted: true });
    expect(await jsonOk(await request(application, a.rawKey, path, 'DELETE'))).toEqual({ schemaVersion: '1', deleted: false });
    const remaining = await admin.select().from(alertExternalRefs).where(eq(alertExternalRefs.alertId, f.alert.id));
    expect(remaining).toHaveLength(1); expect(remaining[0]?.partnerServicePrincipalId).toBe(b.principal.id);
    const deadline = Date.now() + 5000;
    let audits: typeof auditLogs.$inferSelect[] = [];
    do {
      audits = await admin.select().from(auditLogs).where(and(eq(auditLogs.resourceId, f.alert.id), eq(auditLogs.actorId, a.principal.id)));
      if (audits.filter((a) => a.action.startsWith('alert.external_ticket.')).length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    const changedAudits = audits.filter((a) => a.action.startsWith('alert.external_ticket.'));
    expect(changedAudits).toHaveLength(3);
    expect(JSON.stringify(changedAudits)).not.toContain('view=private');
  });

  runDb('rejects missing scopes, http URLs, foreign alerts and alerts outside the accessible org set', async () => {
    const f = await seedAlertRefFixture(); const foreign = await seedAlertRefFixture();
    const writer = await key(f, ['alerts:write']); const reader = await key(f, ['alerts:read']);
    const application = app(); const path = `/alerts/${f.alert.id}/external-ticket`;
    for (const method of ['PUT', 'DELETE']) expect((await request(application, reader.rawKey, path, method, method === 'PUT' ? { externalId: '1' } : undefined)).status).toBe(403);
    expect((await request(application, writer.rawKey, `${path}s`)).status).toBe(403);
    expect((await request(application, writer.rawKey, path, 'PUT', { externalId: '1', externalUrl: 'http://psa.example/1' })).status).toBe(400);
    const hiddenSite = await createSite({ orgId: f.orgB.id });
    const hiddenDevice = await createDevice({ orgId: f.orgB.id, siteId: hiddenSite.id });
    const [hidden] = await getTestDb().insert(alerts).values({ orgId: f.orgB.id, deviceId: hiddenDevice.id, severity: 'high', title: 'Suspended org' }).returning();
    await getTestDb().update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, f.orgB.id));
    for (const id of [foreign.alert.id, hidden!.id, crypto.randomUUID()]) {
      for (const method of ['PUT', 'DELETE', 'GET']) {
        const response = await request(application, method === 'GET' ? reader.rawKey : writer.rawKey, `/alerts/${id}/external-ticket${method === 'GET' ? 's' : ''}`, method, method === 'PUT' ? { externalId: '1' } : undefined);
        expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'partner_alert_not_found' });
      }
    }
  });

  runDb('creates one alert link and binds alertId to the ticket idempotency fingerprint', async () => {
    const f = await seedAlertRefFixture(); const foreign = await seedAlertRefFixture();
    const owner = await key(f, ['tickets:write']); const application = app(); const admin = getTestDb();
    const otherSite = await createSite({ orgId: f.orgB.id });
    const otherDevice = await createDevice({ orgId: f.orgB.id, siteId: otherSite.id });
    const [otherAlert] = await admin.insert(alerts).values({ orgId: f.orgB.id, deviceId: otherDevice.id, severity: 'high', title: 'Other org' }).returning();
    const base = { orgId: f.orgA.id, subject: 'Alert originated ticket' };
    for (const [alertId, status, code] of [[otherAlert!.id, 422, 'partner_ticket_alert_org_mismatch'], [foreign.alert.id, 404, 'partner_alert_not_found']] as const) {
      const response = await request(application, owner.rawKey, '/tickets', 'POST', { ...base, alertId }, 'rejected');
      expect(response.status, await response.clone().text()).toBe(status); expect(await response.json()).toMatchObject({ code });
      expect(await admin.select().from(tickets).where(eq(tickets.orgId, f.orgA.id))).toHaveLength(0);
      expect(await admin.select().from(partnerApiIdempotencyKeys).where(eq(partnerApiIdempotencyKeys.orgId, f.orgA.id))).toHaveLength(0);
    }
    const body = { ...base, alertId: f.alert.id, externalTicketId: 'CREATED-1' };
    const created = await jsonOk(await request(application, owner.rawKey, '/tickets', 'POST', body, 'created-from-alert'), 201);
    expect(await jsonOk(await request(application, owner.rawKey, '/tickets', 'POST', body, 'created-from-alert'))).toMatchObject({ id: created.id, idempotencyReplay: true });
    expect(await admin.select().from(ticketAlertLinks).where(eq(ticketAlertLinks.ticketId, created.id))).toMatchObject([{ alertId: f.alert.id, linkType: 'created_from' }]);
    const reused = await request(application, owner.rawKey, '/tickets', 'POST', { ...body, alertId: otherAlert!.id }, 'created-from-alert');
    expect(reused.status).toBe(409); expect(await reused.json()).toMatchObject({ code: 'partner_tickets_idempotency_key_reused' });
    expect(await admin.select().from(tickets).where(eq(tickets.orgId, f.orgA.id))).toHaveLength(1);
  });

  runDb('rolls back the ticket, link, ref and idempotency claim after a forced post-insert link failure', async () => {
    const f = await seedAlertRefFixture(); const owner = await key(f, ['tickets:write']); const application = app(); const admin = getTestDb();
    faults.failAfterLink = true;
    try {
      const response = await request(application, owner.rawKey, '/tickets', 'POST', { orgId: f.orgA.id, subject: 'Rollback me', alertId: f.alert.id, externalTicketId: 'ROLLBACK-1' }, 'rolled-back');
      expect(response.status, await response.clone().text()).toBe(500);
      for (const table of [tickets, ticketAlertLinks, ticketExternalRefs, partnerApiIdempotencyKeys]) {
        expect(await admin.select().from(table).where(eq(table.orgId, f.orgA.id))).toHaveLength(0);
      }
    } finally { faults.failAfterLink = false; }
  });

  runDb('reads PSA refs only from the viewer partner or alert org, even when RLS is bypassed by a system caller', async () => {
    const f = await seedAlertRefFixture(); const owner = await key(f, ['alerts:read']); const application = app(); const admin = getTestDb();
    const [partnerConnection] = await admin.insert(psaConnections).values({ partnerId: f.partner.id, name: 'Partner PSA', provider: 'jira', credentials: {} }).returning();
    const [orgConnection] = await admin.insert(psaConnections).values({ orgId: f.orgA.id, name: 'Org PSA', provider: 'jira', credentials: {} }).returning();
    const [foreignConnection] = await admin.insert(psaConnections).values({ partnerId: f.otherPartner.id, name: 'Foreign PSA', provider: 'jira', credentials: {} }).returning();
    await admin.insert(psaTicketMappings).values([
      { connectionId: partnerConnection!.id, alertId: f.alert.id, externalTicketId: 'PARTNER-1', externalTicketUrl: 'https://psa.example/1', status: 'open' },
      { connectionId: orgConnection!.id, alertId: f.alert.id, externalTicketId: 'ORG-1', status: 'closed' },
      { connectionId: foreignConnection!.id, alertId: f.alert.id, externalTicketId: 'FOREIGN-SECRET' },
      { connectionId: partnerConnection!.id, alertId: f.alert.id, externalTicketId: null },
    ]);
    const expected = ['PARTNER-1', 'ORG-1'].sort();
    const response = await jsonOk(await request(application, owner.rawKey, `/alerts/${f.alert.id}/external-tickets`));
    expect(response.data.map((r: any) => r.externalId).sort()).toEqual(expected);
    expect(response.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'psa', partnerServicePrincipalId: null, externalId: 'PARTNER-1', externalNumber: null, state: 'open' }),
      expect.objectContaining({ source: 'psa', externalId: 'ORG-1', state: 'closed' }),
    ]));
    const systemRead = await withSystemDbAccessContext(() => listAlertExternalTickets(f.alert.id, f.partner.id));
    expect(systemRead.map((r) => r.externalId).sort()).toEqual(expected);
    const orgOnly = await withSystemDbAccessContext(() => listAlertExternalTickets(f.alert.id, null));
    expect(orgOnly.map((r) => r.externalId)).toEqual(['ORG-1']);
  });

  runDb('moving an external link re-emits both its former and new organizations', async () => {
    const f = await seedAlertRefFixture(); const owner = await key(f, ['organizations:read']); const application = app(); const admin = getTestDb();
    const link = { system: 'connectwise', externalId: 'MOVE-1', label: 'Moved link' };
    const [inserted] = await admin.insert(organizationExternalLinks).values({ orgId: f.orgA.id, partnerId: f.partner.id, ...link }).returning();
    const before = await jsonOk(await request(application, owner.rawKey, '/organizations'));
    expect(before.data.find((r: any) => r.id === f.orgA.id).externalLinks).toEqual([link]);
    expect(before.data.find((r: any) => r.id === f.orgB.id).externalLinks).toEqual([]);
    // Transition tables must retain both affected orgs even if a writer
    // replaces the row's primary key while moving it.
    await admin.update(organizationExternalLinks).set({ id: crypto.randomUUID(), orgId: f.orgB.id }).where(eq(organizationExternalLinks.id, inserted!.id));
    const after = await jsonOk(await request(application, owner.rawKey, `/organizations?updatedSince=${encodeURIComponent(before.snapshotAt)}`));
    expect(after.data.map((r: any) => r.id).sort()).toEqual([f.orgA.id, f.orgB.id].sort());
    expect(after.data.find((r: any) => r.id === f.orgA.id).externalLinks).toEqual([]);
    expect(after.data.find((r: any) => r.id === f.orgB.id).externalLinks).toEqual([link]);
  });

  runDb('watermark polling re-emits an org when a link is inserted, its label changes, or its last link is deleted', async () => {
    const f = await seedAlertRefFixture(); const owner = await key(f, ['organizations:read']); const application = app(); const admin = getTestDb();
    const path = `/organizations?orgId=${f.orgA.id}`;
    let previous = await jsonOk(await request(application, owner.rawKey, path));
    expect(previous.data).toHaveLength(1); expect(previous.data[0].externalLinks).toEqual([]);
    let watermark = (await admin.select().from(organizations).where(eq(organizations.id, f.orgA.id)))[0]!.partnerExportUpdatedAt;
    const link = { system: 'connectwise', externalId: 'f14ab81d-7c26-4fa5-938b-83cd352dda1f', label: 'Acme PSA' };
    const [inserted] = await admin.insert(organizationExternalLinks).values({ orgId: f.orgA.id, partnerId: f.partner.id, ...link }).returning();
    async function poll(expectedLinks: Array<typeof link>) {
      const nextWatermark = (await admin.select().from(organizations).where(eq(organizations.id, f.orgA.id)))[0]!.partnerExportUpdatedAt;
      expect(nextWatermark.getTime(), 'external link change must advance organization export watermark').toBeGreaterThan(watermark.getTime());
      const response = await jsonOk(await request(application, owner.rawKey, `${path}&updatedSince=${encodeURIComponent(previous.snapshotAt)}`));
      expect(response.data.map((r: any) => r.id), 'poller must see the organization after external link changes').toEqual([f.orgA.id]);
      expect(response.data[0].externalLinks).toEqual(expectedLinks);
      previous = response; watermark = nextWatermark;
    }
    await poll([link]);
    await admin.update(organizationExternalLinks).set({ label: link.label }).where(eq(organizationExternalLinks.id, inserted!.id));
    expect((await admin.select().from(organizations).where(eq(organizations.id, f.orgA.id)))[0]!.partnerExportUpdatedAt).toEqual(watermark);
    expect((await jsonOk(await request(application, owner.rawKey, `${path}&updatedSince=${encodeURIComponent(previous.snapshotAt)}`))).data).toEqual([]);
    await admin.update(organizationExternalLinks).set({ label: 'Renamed PSA' }).where(eq(organizationExternalLinks.id, inserted!.id));
    await poll([{ ...link, label: 'Renamed PSA' }]);
    await admin.delete(organizationExternalLinks).where(eq(organizationExternalLinks.id, inserted!.id));
    await poll([]);
  });
});
