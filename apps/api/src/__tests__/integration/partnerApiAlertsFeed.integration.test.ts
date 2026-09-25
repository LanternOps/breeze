import './setup';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import { alerts, devices, partnerServicePrincipals } from '../../db/schema';
import { partnerApiAuthMiddleware } from '../../middleware/partnerApiAuth';
import { partnerAlertRoutes } from '../../routes/partnerApi/alerts';
import { partnerAlertFeedEnvelopeSchema } from '../../routes/partnerApi/schemas';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  };
});

/**
 * Partner alerts feed (alerts:read) against real Postgres.
 *
 * The property under test is the one a timestamp watermark cannot give: an
 * alert written by a transaction that COMMITS AFTER a later-started one must
 * still be delivered, never skipped behind a checkpoint the poller already
 * holds. The feed bounds each traversal by the snapshot xmin, so a still-open
 * writer holds the horizon back instead of being overtaken.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  const admin = getTestDb();
  const partner = await createPartner({ name: 'Feed-Partner' });
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id, name: 'Feed-Org' });
  const site = await createSite({ orgId: org.id, name: 'Feed-Site' });
  const [device] = await admin.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `feed-${crypto.randomUUID()}`.slice(0, 64),
    hostname: 'feed-device-1',
    osType: 'linux',
    osVersion: 'Ubuntu 24.04',
    architecture: 'amd64',
    agentVersion: '1.0.0',
  }).returning();
  if (!device) throw new Error('device seed failed');
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId: partner.id,
    name: `Alerts feed ${crypto.randomUUID()}`,
    scopes: ['alerts:read'],
    sourceCidrs: [],
    expiresAt: null,
    createdBy: user.id,
    updatedBy: user.id,
  }).returning();
  if (!principal) throw new Error('principal seed failed');
  const { rawKey } = await issuePartnerServicePrincipalKey(admin as unknown as Database, {
    partnerServicePrincipalId: principal.id,
    partnerId: partner.id,
    name: 'Alerts feed key',
    actorId: user.id,
  });
  return { org, device, rawKey };
}

function feedApp(): Hono {
  const app = new Hono();
  app.use('*', partnerApiAuthMiddleware);
  app.route('/', partnerAlertRoutes);
  return app;
}

async function sync(app: Hono, rawKey: string, since: string | null) {
  const ids: string[] = [];
  const records: Array<{ id: string; status: string; changeVersion: string }> = [];
  let cursor: string | null = null;
  let checkpoint: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: '1' });
    if (cursor) params.set('cursor', cursor);
    else if (since) params.set('since', since);
    const res = await app.request(`/alerts?${params}`, { headers: { 'X-API-Key': rawKey } });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = partnerAlertFeedEnvelopeSchema.parse(await res.json());
    for (const record of body.data) {
      ids.push(record.id);
      records.push({ id: record.id, status: record.status, changeVersion: record.changeVersion });
    }
    cursor = body.nextCursor;
    checkpoint = body.checkpoint;
    pages += 1;
    expect(pages).toBeLessThan(50);
  } while (cursor);
  return { ids, records, checkpoint: checkpoint! };
}

describe('partner alerts feed (real Postgres)', () => {
  runDb('never skips an alert whose transaction commits after a later one', async () => {
    const { org, device, rawKey } = await seed();
    const app = feedApp();
    const admin = getTestDb();
    const insertAlert = async (title: string) => {
      const [row] = await admin.insert(alerts).values({
        orgId: org.id, deviceId: device.id, severity: 'high', title,
      }).returning({ id: alerts.id, xid: alerts.partnerFeedXid });
      return row!;
    };

    const old = await insertAlert('old');
    const first = await sync(app, rawKey, null);
    expect(first.ids).toEqual([old.id]);

    // Writer A starts first and stays open; writer B starts later and commits.
    const raw = postgres(process.env.DATABASE_URL!, { max: 2 });
    const writerA = await raw.reserve();
    try {
      await writerA`BEGIN`;
      const [lateRow] = await writerA<{ id: string }[]>`
        INSERT INTO alerts (org_id, device_id, severity, title)
        VALUES (${org.id}, ${device.id}, 'critical', 'late-commit')
        RETURNING id`;
      const early = await insertAlert('early-commit');

      // B is committed but A is still open: the horizon must stay at/below A,
      // so B is withheld rather than returned ahead of A.
      const second = await sync(app, rawKey, first.checkpoint);
      expect(second.ids).toEqual([]);

      await writerA`COMMIT`;
      const third = await sync(app, rawKey, second.checkpoint);
      expect(new Set(third.ids)).toEqual(new Set([lateRow!.id, early.id]));

      // Every committed alert has now been delivered exactly once.
      const delivered = [...first.ids, ...second.ids, ...third.ids];
      expect(new Set(delivered).size).toBe(delivered.length);
      expect(new Set(delivered)).toEqual(new Set([old.id, lateRow!.id, early.id]));

      // An UPDATE restamps the row, so a status change is delivered again.
      await admin.update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(alerts.id, old.id));
      // A later no-op transaction lets the horizon pass the UPDATE.
      await insertAlert('horizon-bump');
      const fourth = await sync(app, rawKey, third.checkpoint);
      const resolved = fourth.records.find((r) => r.id === old.id);
      expect(resolved?.status).toBe('resolved');
      expect(BigInt(resolved!.changeVersion)).toBeGreaterThan(BigInt(old.xid));
    } finally {
      await writerA`ROLLBACK`.catch(() => {});
      writerA.release();
      await raw.end();
    }
  });

  runDb('never discloses a device id from another tenant when alerts.device_id points across orgs', async () => {
    const mine = await seed();
    const foreign = await seed();
    const admin = getTestDb();
    // alerts has only existence FKs, so this cross-org row is storable.
    const [row] = await admin.insert(alerts).values({
      orgId: mine.org.id, deviceId: foreign.device.id, severity: 'high', title: 'forged-device',
    }).returning({ id: alerts.id });
    const result = await sync(feedApp(), mine.rawKey, null);
    expect(result.ids).toContain(row!.id);
    const res = await feedApp().request('/alerts', { headers: { 'X-API-Key': mine.rawKey } });
    const body = partnerAlertFeedEnvelopeSchema.parse(await res.json());
    const record = body.data.find((r) => r.id === row!.id)!;
    expect(record.deviceId).toBeNull();
    expect(record.deviceHostname).toBeNull();
    expect(JSON.stringify(body)).not.toContain(foreign.device.id);
  });

  runDb('stamps partner_feed_xid on insert and update via the trigger, ignoring app-supplied values', async () => {
    const { org, device } = await seed();
    const admin = getTestDb();
    const [row] = await admin.insert(alerts).values({
      orgId: org.id, deviceId: device.id, severity: 'low', title: 'stamp', partnerFeedXid: '1',
    }).returning({ id: alerts.id, xid: alerts.partnerFeedXid });
    expect(BigInt(row!.xid)).toBeGreaterThan(1n);
    const [updated] = await admin.update(alerts).set({ title: 'stamp-2' })
      .where(eq(alerts.id, row!.id)).returning({ xid: alerts.partnerFeedXid });
    expect(BigInt(updated!.xid)).toBeGreaterThan(BigInt(row!.xid));
  });
});
