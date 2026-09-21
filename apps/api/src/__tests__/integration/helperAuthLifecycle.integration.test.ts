/**
 * Real-PostgreSQL proof for the Breeze Helper device-credential ingress
 * (`middleware/helperAuth.ts`).
 *
 * Two independent properties:
 *
 *  1. LIFECYCLE — the shared device-credential gate
 *     (`middleware/deviceCredentialLifecycle.ts`) fails closed for a suspended
 *     agent token and for a suspended/severed tenant. Before this suite,
 *     helperAuth checked only `decommissioned`/`quarantined`, so a suspended
 *     token or a dead tenant still got a working Helper session (AI chat, LLM,
 *     tool results, screenshots).
 *
 *  2. RLS — the Helper AuthContext must NOT carry partner-axis WRITE access.
 *     `accessiblePartnerIds` feeds `breeze.accessible_partner_ids`, which is the
 *     only input to `breeze_has_partner_access()` — the predicate the Shape-3
 *     partner-axis policies use for UPDATE/DELETE targeting. The assertion runs
 *     as the unprivileged `breeze_app` role (rolbypassrls = false, see
 *     setup.ts) against `ticket_categories` (PARTNER_TENANT_TABLES, partner_id
 *     axis), with the SAME context differing only in that array — so the
 *     negative control proves the assertion bites rather than passing because
 *     the UPDATE was a no-op.
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, organizations, partners } from '../../db/schema';
import { ticketCategories } from '../../db/schema/tickets';
import { helperAuth } from '../../middleware/helperAuth';
import { invalidateAgentTenantCache } from '../../services/tenantStatus';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

const app = new Hono();
app.use('*', helperAuth);
app.get('/probe', (c) => c.json({ deviceId: c.get('helperDevice').id }));
// Attempts a partner-axis UPDATE inside the AMBIENT DB context helperAuth opened,
// so the assertion exercises the real middleware wiring, not a hand-built context.
app.post('/forge-partner-write/:categoryId', async (c) => {
  const rows = await db
    .update(ticketCategories)
    .set({ name: 'forged-by-helper' })
    .where(eq(ticketCategories.id, c.req.param('categoryId')))
    .returning({ id: ticketCategories.id });
  return c.json({ affected: rows.length });
});

async function seedHelperDevice(options: { orgStatus?: 'active' | 'suspended' } = {}) {
  const partner = await createPartner();
  const org = await createOrganization({
    partnerId: partner.id,
    status: options.orgStatus ?? 'active',
  });
  const site = await createSite({ orgId: org.id });
  seededPartnerIds.push(partner.id);
  seededOrgIds.push(org.id);

  const token = `brz_helper_${randomUUID().replace(/-/g, '')}`;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `helper-lifecycle-${randomUUID()}`,
      agentTokenHash: digest(`${token}-agent`),
      helperTokenHash: digest(token),
      hostname: `helper-lifecycle-${randomUUID()}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });
  expect(device).toBeDefined();

  // Never let a cached positive from an earlier case answer for this org.
  await invalidateAgentTenantCache([org.id]);

  return { partner, org, device: device!, token };
}

const probe = (token: string) =>
  app.request('/probe', { headers: { Authorization: `Bearer ${token}` } });

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);
  const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);

  await adminDb.delete(ticketCategories).where(sql`${ticketCategories.partnerId} IN (${partnerList})`);
  await adminDb.delete(devices).where(sql`${devices.orgId} IN (${orgList})`);
  await adminDb.execute(sql`DELETE FROM sites WHERE org_id IN (${orgList})`);
  await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('helper auth device-credential lifecycle (real PostgreSQL)', () => {
  runDb('runs as the unprivileged breeze_app role (assertions are not vacuous)', async () => {
    const role = (await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT current_user AS who, rolsuper, rolbypassrls
        FROM pg_roles WHERE rolname = current_user
      `),
    )) as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(role[0]).toMatchObject({ who: 'breeze_app', rolsuper: false, rolbypassrls: false });
  });

  runDb('admits a healthy helper token (positive control)', async () => {
    const { token, device } = await seedHelperDevice();
    const res = await probe(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deviceId: device.id });
  });

  runDb('denies a helper token whose device agent token is suspended', async () => {
    const { token, device } = await seedHelperDevice();
    expect((await probe(token)).status).toBe(200);

    await getTestDb()
      .update(devices)
      .set({ agentTokenSuspendedAt: new Date(), agentTokenSuspendedReason: 'tenant_suspended' })
      .where(eq(devices.id, device.id));

    const res = await probe(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid agent credentials' });
  });

  runDb('denies a helper token whose organization is suspended', async () => {
    const { token, org } = await seedHelperDevice();
    expect((await probe(token)).status).toBe(200);

    await getTestDb()
      .update(organizations)
      .set({ status: 'suspended' })
      .where(eq(organizations.id, org.id));
    await invalidateAgentTenantCache([org.id]);

    const res = await probe(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid agent credentials' });
  });

  runDb('denies a helper token whose organization is soft-deleted (severed tenant)', async () => {
    const { token, org } = await seedHelperDevice();
    await getTestDb()
      .update(organizations)
      .set({ deletedAt: new Date() })
      .where(eq(organizations.id, org.id));
    await invalidateAgentTenantCache([org.id]);

    expect((await probe(token)).status).toBe(401);
  });

  runDb('denies a helper token whose PARTNER is suspended', async () => {
    const { token, partner, org } = await seedHelperDevice();
    await getTestDb().update(partners).set({ status: 'suspended' }).where(eq(partners.id, partner.id));
    await invalidateAgentTenantCache([org.id]);

    expect((await probe(token)).status).toBe(401);
  });

  runDb(
    'a helper context (accessiblePartnerIds []) cannot UPDATE a partner-owned row, while the same context WITH the partner id can',
    async () => {
      const { partner, org, token } = await seedHelperDevice();

      const [category] = await withSystemDbAccessContext(() =>
        db
          .insert(ticketCategories)
          .values({ partnerId: partner.id, name: `helper-rls-${randomUUID().slice(0, 8)}` })
          .returning({ id: ticketCategories.id }),
      );
      expect(category?.id).toBeDefined();

      // EXACTLY what helperAuth now opens.
      const helperContext: DbAccessContext = {
        scope: 'organization',
        orgId: org.id,
        accessibleOrgIds: [org.id],
        accessiblePartnerIds: [],
        currentPartnerId: partner.id,
      };

      // Through the REAL middleware: the request's ambient context is whatever
      // helperAuth opened, so this is red if helperAuth ever re-grants the
      // partner axis.
      const forged = await app.request(`/forge-partner-write/${category!.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(forged.status).toBe(200);
      expect(await forged.json()).toEqual({ affected: 0 });

      // Same assertion against a hand-built copy of that context, for the
      // negative control below to differ from by exactly one field.
      const denied = await withDbAccessContext(helperContext, () =>
        db
          .update(ticketCategories)
          .set({ name: 'forged-by-helper' })
          .where(eq(ticketCategories.id, category!.id))
          .returning({ id: ticketCategories.id }),
      );
      expect(denied).toHaveLength(0);

      // Negative control: the ONLY difference is the partner-axis array. If this
      // also affected 0 rows the assertion above would be vacuous.
      const allowed = await withDbAccessContext(
        { ...helperContext, accessiblePartnerIds: [partner.id] },
        () =>
          db
            .update(ticketCategories)
            .set({ name: 'written-with-partner-axis' })
            .where(eq(ticketCategories.id, category!.id))
            .returning({ id: ticketCategories.id }),
      );
      expect(allowed).toHaveLength(1);

      const [after] = await withSystemDbAccessContext(() =>
        db
          .select({ name: ticketCategories.name })
          .from(ticketCategories)
          .where(eq(ticketCategories.id, category!.id)),
      );
      expect(after?.name).toBe('written-with-partner-axis');
    },
  );
});
