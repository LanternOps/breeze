import './setup';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import { alerts, devices, partnerServicePrincipals } from '../../db/schema';
import { partnerApiAuthMiddleware } from '../../middleware/partnerApiAuth';
import { publishEvent } from '../../services/eventBus';
import { partnerAlertWriteRoutes } from '../../routes/partnerApi/alertWrites';
import { partnerAlertWriteResponseSchema } from '../../routes/partnerApi/schemas';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import type { PartnerServicePrincipalScope } from '../../services/partnerServicePrincipalScopes';
import { createOrganization, createPartner, createSite, createUser, userEpochs } from './db-utils';
import { getTestDb } from './setup';

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return { ...actual, PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8') };
});
// Keep auth, keys, RLS, actions and audit real; publishing needs no event worker.
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn().mockResolvedValue(undefined) };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function issueKey(partnerId: string, userId: string, scopes: PartnerServicePrincipalScope[]) {
  const admin = getTestDb();
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId, name: `Alert write-back ${crypto.randomUUID()}`, scopes,
    sourceCidrs: [], expiresAt: null, createdBy: userId, updatedBy: userId,
  }).returning();
  if (!principal) throw new Error('principal seed failed');
  const { rawKey } = await issuePartnerServicePrincipalKey(admin as unknown as Database, {
    partnerServicePrincipalId: principal.id, partnerId, name: 'Alert write-back key',
    actorId: userId, actorSessionEpochs: await userEpochs(userId),
  });
  return { principal, rawKey };
}

async function seed() {
  const admin = getTestDb();
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await admin.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `alert-write-${crypto.randomUUID()}`,
    hostname: 'alert-write-device', osType: 'linux', osVersion: 'Ubuntu 24.04',
    architecture: 'amd64', agentVersion: '1.0.0',
  }).returning();
  if (!device) throw new Error('device seed failed');
  const [alert] = await admin.insert(alerts).values({
    orgId: org.id, deviceId: device.id, severity: 'high', title: 'Integration alert', status: 'active',
  }).returning();
  if (!alert) throw new Error('alert seed failed');
  return { partner, user, org, alert };
}

function partnerApp(): Hono {
  const app = new Hono();
  app.use('*', partnerApiAuthMiddleware);
  app.route('/', partnerAlertWriteRoutes);
  return app;
}

function send(app: Hono, key: string, id: string, action: 'acknowledge' | 'resolve', body?: unknown) {
  return app.request(`/alerts/${id}/${action}`, {
    method: 'POST', headers: { 'X-API-Key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function storedAlert(id: string) {
  const [row] = await getTestDb().select().from(alerts).where(eq(alerts.id, id));
  if (!row) throw new Error('alert disappeared');
  return row;
}

describe('partner alert writes (real Postgres and real authentication)', () => {
  runDb('attributes idempotent writes, isolates partners/scopes, and clears deleted-principal attribution', async () => {
    const mine = await seed();
    const foreign = await seed();
    const { principal, rawKey } = await issueKey(mine.partner.id, mine.user.id, ['alerts:write']);
    const reader = await issueKey(mine.partner.id, mine.user.id, ['alerts:read']);
    const app = partnerApp();
    const originalMine = await storedAlert(mine.alert.id);
    const originalForeign = await storedAlert(foreign.alert.id);

    for (const action of ['acknowledge', 'resolve'] as const) {
      const denied = await send(app, reader.rawKey, mine.alert.id, action);
      expect(denied.status, await denied.clone().text()).toBe(403);
      expect(await storedAlert(mine.alert.id)).toEqual(originalMine);
      const hidden = await send(app, rawKey, foreign.alert.id, action);
      expect(hidden.status, await hidden.clone().text()).toBe(404);
      expect(await hidden.json()).toEqual({ error: 'Alert not found.', code: 'partner_alert_not_found' });
      expect(await storedAlert(foreign.alert.id)).toEqual(originalForeign);
    }

    const acknowledged = await send(app, rawKey, mine.alert.id, 'acknowledge');
    expect(acknowledged.status, await acknowledged.clone().text()).toBe(200);
    expect(partnerAlertWriteResponseSchema.parse(await acknowledged.json()).changed).toBe(true);
    const acknowledgedRow = await storedAlert(mine.alert.id);
    expect(acknowledgedRow).toMatchObject({
      status: 'acknowledged', acknowledgedByPrincipalId: principal.id, acknowledgedBy: null,
    });
    const ackRepeat = await send(app, rawKey, mine.alert.id, 'acknowledge', {});
    expect(ackRepeat.status).toBe(200);
    expect(partnerAlertWriteResponseSchema.parse(await ackRepeat.json()).changed).toBe(false);
    expect(await storedAlert(mine.alert.id)).toEqual(acknowledgedRow);

    const resolved = await send(app, rawKey, mine.alert.id, 'resolve', { note: '  Completed in the PSA  ' });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    expect(partnerAlertWriteResponseSchema.parse(await resolved.json()).changed).toBe(true);
    const resolvedRow = await storedAlert(mine.alert.id);
    expect(resolvedRow).toMatchObject({
      status: 'resolved', resolvedByPrincipalId: principal.id, resolvedBy: null,
      resolutionReason: 'manual', resolutionNote: 'Completed in the PSA',
      acknowledgedByPrincipalId: principal.id, acknowledgedBy: null,
    });
    const resolveRepeat = await send(app, rawKey, mine.alert.id, 'resolve', { note: 'Do not overwrite' });
    expect(resolveRepeat.status).toBe(200);
    expect(partnerAlertWriteResponseSchema.parse(await resolveRepeat.json()).changed).toBe(false);
    expect(await storedAlert(mine.alert.id)).toEqual(resolvedRow);

    // One event per real transition, none for the repeats, the 403s or the
    // foreign 404s — each carrying the principal, never a user id.
    const published = vi.mocked(publishEvent).mock.calls.filter(([, orgId]) => orgId === mine.org.id || orgId === foreign.org.id);
    expect(published.map(([type, orgId]) => [type, orgId])).toEqual([
      ['alert.acknowledged', mine.org.id],
      ['alert.resolved', mine.org.id],
    ]);
    expect(published[0]![2]).toMatchObject({ alertId: mine.alert.id, acknowledgedBy: null, acknowledgedByPrincipalId: principal.id });
    expect(published[1]![2]).toMatchObject({
      alertId: mine.alert.id, resolvedBy: null, resolvedByPrincipalId: principal.id, resolutionReason: 'manual',
    });

    await getTestDb().delete(partnerServicePrincipals).where(eq(partnerServicePrincipals.id, principal.id));
    expect(await storedAlert(mine.alert.id)).toMatchObject({
      status: 'resolved', acknowledgedByPrincipalId: null, resolvedByPrincipalId: null,
      acknowledgedBy: null, resolvedBy: null, resolutionReason: 'manual',
    });
    expect(await storedAlert(foreign.alert.id)).toEqual(originalForeign);
  });
});
