/**
 * partner_sending_daily_stats — live RLS, concurrent upsert-increment
 * correctness, and the delivery webhook end-to-end with NO ambient DB context
 * (spec §9.3, §14; CLAUDE.md "Tenant Isolation" step 6).
 *
 * The shipped policy (2026-10-20-100100-partner-sending-daily-stats.sql) is:
 *   partner_sending_daily_stats_partner_access  FOR ALL
 *     system OR breeze_has_partner_access(partner_id)
 *
 * rls-coverage.integration.test.ts proves the policy EXISTS by reading
 * pg_catalog; it cannot prove it enforces anything. This suite drives the real
 * postgres.js driver as `breeze_app` under FORCE RLS, which is the only thing
 * that does.
 */
import './setup';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { partnerSendingDailyStats, partnerSendingDomains } from '../../db/schema';
import {
  incrementPartnerSendingStat,
  loadAllPartnerSendingWindowStats,
  loadPartnerSendingWindowStats,
} from '../../services/emailDomains/deliveryStats';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SECRET = `whsec_${Buffer.from('an-integration-thirty-two-byte!!').toString('base64')}`;

// Redis: in-memory. The three properties this suite exists to prove are all
// DATABASE properties, and a mocked database cannot show any of them; Redis
// only contributes the replay reservation, which emailProvider.test.ts covers.
const reservations = new Set<string>();
vi.mock('../../services/redis', () => ({
  getRedis: () => ({
    set: async (key: string, _v: string, _ex: string, _ttl: number, _nx: string) => {
      if (reservations.has(key)) return null;
      reservations.add(key);
      return 'OK';
    },
  }),
}));
// The route's only enqueue targets; BullMQ is not part of what this suite proves.
const enqueueSyncSpy = vi.fn(async () => undefined);
const enqueueAutoSuspendSpy = vi.fn(async () => undefined);
vi.mock('../../jobs/sendingDomainsWorker', () => ({
  enqueueSyncDomain: (...args: unknown[]) => enqueueSyncSpy(...(args as [])),
  enqueueAutoSuspendEvaluation: (...args: unknown[]) => enqueueAutoSuspendSpy(...(args as [])),
}));
vi.mock('../../services/rate-limit', () => ({
  rateLimiter: async () => ({ allowed: true, remaining: 100, resetAt: new Date() }),
}));

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
}
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const createdPartnerIds: string[] = [];

afterEach(async () => {
  const partnerIds = [...new Set(createdPartnerIds)];
  createdPartnerIds.length = 0;
  reservations.clear();
  vi.clearAllMocks();
  if (partnerIds.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.delete(partnerSendingDailyStats).where(inArray(partnerSendingDailyStats.partnerId, partnerIds));
    // The BEFORE DELETE guard raises while provider_domain_id is set.
    await db.update(partnerSendingDomains).set({ providerDomainId: null })
      .where(inArray(partnerSendingDomains.partnerId, partnerIds));
    await db.delete(partnerSendingDomains).where(inArray(partnerSendingDomains.partnerId, partnerIds));
  });
});

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  createdPartnerIds.push(partnerA.id, partnerB.id);
  return { partnerA: partnerA.id, partnerB: partnerB.id, orgA: orgA.id };
}

const TODAY = new Date().toISOString().slice(0, 10);

describe('partner_sending_daily_stats — RLS (shape 3)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('FORGE: partner B cannot insert a stats row for partner A (42501)', async () => {
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, []), () =>
        db.insert(partnerSendingDailyStats)
          .values({ partnerId: f.partnerA, day: TODAY, sent: 1 })
          .returning()),
      '42501',
    );
  });

  it("FORGE: partner B cannot read or update partner A's row", async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDailyStats).values({ partnerId: f.partnerA, day: TODAY, sent: 5 }));

    const read = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.select({ sent: partnerSendingDailyStats.sent }).from(partnerSendingDailyStats));
    expect(read).toHaveLength(0);

    const updated = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.update(partnerSendingDailyStats).set({ sent: 999 })
        .where(eq(partnerSendingDailyStats.partnerId, f.partnerA))
        .returning({ sent: partnerSendingDailyStats.sent }));
    expect(updated).toHaveLength(0);
  });

  it('partner A CAN read its own row', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDailyStats).values({ partnerId: f.partnerA, day: TODAY, delivered: 7 }));
    const rows = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.select({ delivered: partnerSendingDailyStats.delivered }).from(partnerSendingDailyStats));
    expect(rows).toEqual([{ delivered: 7 }]);
  });

  it('an ORG-scoped context sees ZERO rows even for its own partner', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDailyStats).values({ partnerId: f.partnerA, day: TODAY, delivered: 7 }));
    const rows = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      db.select({ delivered: partnerSendingDailyStats.delivered }).from(partnerSendingDailyStats));
    expect(rows).toHaveLength(0);
  });

  it('a CONTEXTLESS read sees zero rows — the reason the webhook must elect system scope', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDailyStats).values({ partnerId: f.partnerA, day: TODAY, delivered: 7 }));
    const rows = await db.select({ delivered: partnerSendingDailyStats.delivered }).from(partnerSendingDailyStats);
    expect(rows).toHaveLength(0);
  });
});

describe('incrementPartnerSendingStat — real Postgres', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('inserts then updates the same (partner, day) row', async () => {
    await expect(incrementPartnerSendingStat(f.partnerA, 'delivered')).resolves.toBe(true);
    await expect(incrementPartnerSendingStat(f.partnerA, 'delivered')).resolves.toBe(true);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivered).toBe(2);
  });

  // The whole reason the statement is INSERT … SELECT … ON CONFLICT and not a
  // read-modify-write: concurrent deliveries must not lose an increment.
  it('loses no increment under 50 concurrent calls', async () => {
    await Promise.all(Array.from({ length: 50 }, () => incrementPartnerSendingStat(f.partnerA, 'bounced')));
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.bounced).toBe(50);
  });

  it('counts concurrent increments of DIFFERENT columns independently', async () => {
    await Promise.all([
      ...Array.from({ length: 20 }, () => incrementPartnerSendingStat(f.partnerA, 'sent')),
      ...Array.from({ length: 5 }, () => incrementPartnerSendingStat(f.partnerA, 'complained')),
    ]);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.sent).toBe(20);
    expect(rows[0]!.complained).toBe(5);
  });

  // A forged tag must be counted nowhere and must NOT raise 23503 — a caught
  // FK violation would abort the surrounding transaction.
  it('returns false and raises nothing for a partner id that does not exist', async () => {
    await expect(
      incrementPartnerSendingStat('99999999-9999-4999-8999-999999999999', 'bounced'),
    ).resolves.toBe(false);
  });

  it('rolls the window up per partner and fleet-wide from the same rows', async () => {
    await incrementPartnerSendingStat(f.partnerA, 'sent');
    await incrementPartnerSendingStat(f.partnerA, 'bounced');
    await incrementPartnerSendingStat(f.partnerB, 'delivered');

    const a = await loadPartnerSendingWindowStats(f.partnerA);
    expect(a.sent).toBe(1);
    expect(a.bounced).toBe(1);
    expect(a.messages).toBe(1);   // GREATEST(1, 0 + 1 + 0)

    const all = await loadAllPartnerSendingWindowStats();
    const ids = all.map((r) => r.partnerId);
    expect(ids).toContain(f.partnerA);
    expect(ids).toContain(f.partnerB);
  });

  it('excludes a day outside the 7-day window', async () => {
    await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      insert into partner_sending_daily_stats (partner_id, day, bounced)
      values (${f.partnerA}::uuid, (current_date - 30), 99)
    `));
    const stats = await loadPartnerSendingWindowStats(f.partnerA);
    expect(stats.bounced).toBe(0);
  });
});

describe('the delivery webhook end-to-end, with NO ambient DB context', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
    process.env.EMAIL_DOMAINS_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => { delete process.env.EMAIL_DOMAINS_WEBHOOK_SECRET; });

  async function post(payload: unknown, id = `msg_${Math.random().toString(36).slice(2)}`) {
    const { resendWebhookRoutes } = await import('../../routes/webhooks/emailProvider');
    const app = new Hono();
    app.route('/webhooks', resendWebhookRoutes);
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
    const signature = `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
    // Note: NO withDbAccessContext wrapper. The handler must elect system scope
    // itself; if it does not, forced RLS silently counts nothing.
    return app.request('/webhooks/email-provider/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature },
      body,
    });
  }

  function event(type: string, partnerId: string) {
    return {
      type, created_at: new Date().toISOString(),
      data: { email_id: 'e1', from: 'a@b.test', to: ['c@d.test'], subject: 's', created_at: new Date().toISOString(), tags: { partner_id: partnerId } },
    };
  }

  it("counts a delivered event into the tagged partner's row", async () => {
    const res = await post(event('email.delivered', f.partnerA));
    expect(res.status).toBe(202);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.delivered).toBe(1);
  });

  it('counts a bounce and enqueues exactly one auto-suspend evaluation', async () => {
    const res = await post(event('email.bounced', f.partnerA));
    expect(res.status).toBe(202);
    expect(enqueueAutoSuspendSpy).toHaveBeenCalledWith(f.partnerA);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.bounced).toBe(1);
  });

  it('does not double-count a redelivery of the same svix-id', async () => {
    const id = 'msg_replayed';
    expect((await post(event('email.bounced', f.partnerA), id)).status).toBe(202);
    expect((await post(event('email.bounced', f.partnerA), id)).status).toBe(202);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats).where(eq(partnerSendingDailyStats.partnerId, f.partnerA)));
    expect(rows[0]!.bounced).toBe(1);
  });

  it('counts a forged partner tag nowhere and enqueues nothing', async () => {
    const res = await post(event('email.bounced', '99999999-9999-4999-8999-999999999999'));
    expect(res.status).toBe(202);
    expect(enqueueAutoSuspendSpy).not.toHaveBeenCalled();
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats)
        .where(inArray(partnerSendingDailyStats.partnerId, [f.partnerA, f.partnerB])));
    expect(rows).toHaveLength(0);
  });

  it('resolves domain.updated to the local row and enqueues a sync', async () => {
    const [domain] = await withDbAccessContext(SYSTEM_CTX, () => db
      .insert(partnerSendingDomains)
      .values({ partnerId: f.partnerA, domain: `wh-${Date.now()}.test`, provider: 'fake', providerDomainId: 'prov-wh-1', status: 'verified' })
      .returning());
    const res = await post({
      type: 'domain.updated', created_at: new Date().toISOString(),
      data: { id: 'prov-wh-1', name: domain!.domain, status: 'verified', created_at: new Date().toISOString(), region: 'us-east-1', records: [] },
    });
    expect(res.status).toBe(202);
    expect(enqueueSyncSpy).toHaveBeenCalledWith(domain!.id);
  });

  it('is inert with a 404 when the secret is unset', async () => {
    delete process.env.EMAIL_DOMAINS_WEBHOOK_SECRET;
    const res = await post(event('email.delivered', f.partnerA));
    expect(res.status).toBe(404);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(partnerSendingDailyStats)
        .where(inArray(partnerSendingDailyStats.partnerId, [f.partnerA, f.partnerB])));
    expect(rows).toHaveLength(0);
  });
});
