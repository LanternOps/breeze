/**
 * Real-Postgres proof for the X-Breeze-Mobile-Device-Id resolution on
 * POST /authenticator/devices (Sentry BREEZE-12 / BREEZE-13).
 *
 * The bug: the route wrote the header value straight into
 * `authenticator_devices.mobile_device_id`, which FKs `mobile_devices.id`
 * (2026-06-14-a-authenticator-foundation.sql). But the header carries
 * `mobile_devices.device_id` — a VARCHAR per-install id minted on the phone —
 * not the server-side uuid PK. Every mobile registration therefore 500'd:
 * 23503 for the uuid-SHAPED per-install id, 22P02 for a non-uuid header.
 *
 * The unit suite fully mocks `../db`, so the FK, the uuid cast and RLS are all
 * structurally invisible to it — which is exactly how this shipped. Only a real
 * connection can prove:
 *
 *   1. the FK really does reject the raw header (negative control — this is the
 *      500 that shipped), while the resolved id is accepted;
 *   2. a junk header really is a varchar miss and not a 22P02 cast error;
 *   3. the ownership predicate does real work, because RLS does NOT supply it:
 *      `mobile_devices`' SELECT policy
 *      (2026-04-11-bucket-c-phase-6-user-scoped-rls.sql) has an `OR EXISTS`
 *      branch that makes a same-tenant colleague's row fully visible to the
 *      caller. This test seeds exactly that row and asserts the registration
 *      still resolves to null.
 *
 * The route is driven end-to-end through Hono with only the auth middleware and
 * the auth-audit/step-up helpers mocked; `db` is the real breeze_app pool.
 */
import './setup';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

let activeAuth: { userId: string; orgId: string; partnerId: string } | null = null;

// Partial mock: only the three gates this route uses are replaced. The rest of
// the module (requireScope, …) must stay real — other modules pulled in through
// the services barrel import it at module scope.
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuth) return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', {
        scope: 'partner',
        user: { id: activeAuth.userId, email: 'approver@test', name: 'Approver' },
        orgId: activeAuth.orgId,
        partnerId: activeAuth.partnerId,
        token: { mfa: true, sid: 'sid-integration' },
      });
      // Same shape the real authMiddleware opens (middleware/auth.ts). userId is
      // what seeds breeze_current_user_id(), which both authenticator_devices'
      // and mobile_devices' policies key off.
      return withDbAccessContext(
        {
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: [activeAuth.orgId],
          accessiblePartnerIds: [activeAuth.partnerId],
          userId: activeAuth.userId,
        },
        () => next()
      );
    },
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

const auditCalls: any[] = [];

vi.mock('../../routes/auth/helpers', () => ({
  writeAuthAudit: (_c: unknown, entry: unknown) => {
    auditCalls.push(entry);
  },
  enforceApproverRegisterStepUp: async () => null,
  requireCurrentPasswordStepUp: async () => null,
  userHasStrongerReauthFactor: async () => false,
}));

import { db, withSystemDbAccessContext } from '../../db';
import { authenticatorDevices, mobileDevices } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const createdPartnerIds: string[] = [];

afterEach(async () => {
  activeAuth = null;
  auditCalls.length = 0;
  if (createdPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const { sql } = await import('drizzle-orm');
  const partnerList = sql.join(createdPartnerIds.map((id) => sql`${id}`), sql`, `);
  await adminDb.execute(
    sql`DELETE FROM authenticator_devices WHERE user_id IN (SELECT id FROM users WHERE partner_id IN (${partnerList}))`
  );
  await adminDb.execute(
    sql`DELETE FROM mobile_devices WHERE user_id IN (SELECT id FROM users WHERE partner_id IN (${partnerList}))`
  );
  await adminDb.execute(sql`DELETE FROM users WHERE partner_id IN (${partnerList})`);
  await adminDb.execute(
    sql`DELETE FROM organizations WHERE partner_id IN (${partnerList})`
  );
  await adminDb.execute(sql`DELETE FROM partners WHERE id IN (${partnerList})`);
  createdPartnerIds.length = 0;
});

async function buildApp() {
  // Import AFTER the mocks are registered.
  const { authenticatorRoutes } = await import('../../routes/authenticator');
  const app = new Hono();
  app.route('/authenticator', authenticatorRoutes);
  return app;
}

function unique() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** One partner + org + two users in the SAME tenant (caller and a colleague). */
async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const caller = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `mdid-caller-${unique()}@example.test`,
  });
  const colleague = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `mdid-colleague-${unique()}@example.test`,
  });
  createdPartnerIds.push(partner.id);
  return { partnerId: partner.id, orgId: org.id, caller, colleague };
}

async function seedMobileDevice(userId: string, deviceId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(mobileDevices)
      .values({ userId, deviceId, platform: 'ios' })
      .returning({ id: mobileDevices.id })
  );
  return row!.id;
}

const REGISTER_BODY = {
  registerGrantId: 'g-integration',
  publicKey: 'pk-integration',
  label: 'iPhone',
};

async function register(app: Hono, header?: string) {
  return app.request('/authenticator/devices', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer access-token',
      ...(header === undefined ? {} : { 'X-Breeze-Mobile-Device-Id': header }),
    },
    body: JSON.stringify(REGISTER_BODY),
  });
}

/** The single authenticator_devices row this registration created. */
async function insertedRow(userId: string) {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ id: authenticatorDevices.id, mobileDeviceId: authenticatorDevices.mobileDeviceId })
      .from(authenticatorDevices)
      .where(eq(authenticatorDevices.userId, userId))
  );
  return rows;
}

describe('POST /authenticator/devices — X-Breeze-Mobile-Device-Id resolution (real Postgres)', () => {
  runDb('resolves the per-install header to the caller-owned mobile_devices.id', async () => {
    const { partnerId, orgId, caller } = await seedTenant();
    // The app mints a uuid-SHAPED per-install id and stores it in device_id.
    const perInstallId = `11111111-2222-3333-4444-${Date.now().toString().slice(-12)}`;
    const mobileRowId = await seedMobileDevice(caller.id, perInstallId);
    expect(mobileRowId).not.toBe(perInstallId);

    activeAuth = { userId: caller.id, orgId, partnerId };
    const res = await register(await buildApp(), perInstallId);

    expect(res.status).toBe(201);
    const rows = await insertedRow(caller.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mobileDeviceId).toBe(mobileRowId);
    expect(rows[0]!.mobileDeviceId).not.toBe(perInstallId);
    expect(auditCalls.at(-1)?.details).toMatchObject({ mobileDeviceId: mobileRowId });
  });

  runDb(
    'NEGATIVE CONTROL: writing the raw header into the FK column is the 23503 that shipped',
    async () => {
      const { caller } = await seedTenant();
      const perInstallId = `11111111-2222-3333-4444-${Date.now().toString().slice(-12)}`;
      await seedMobileDevice(caller.id, perInstallId);

      let cause: string | undefined;
      try {
        await withSystemDbAccessContext(() =>
          db.insert(authenticatorDevices).values({
            userId: caller.id,
            kind: 'mobile_hw_key',
            publicKey: 'pk-fk-control',
            isPlatformBound: true,
            // The pre-fix behaviour: the per-install device_id straight into a
            // column that FKs mobile_devices.id.
            mobileDeviceId: perInstallId,
          })
        );
      } catch (err) {
        cause = (err as { cause?: { message?: string } } | undefined)?.cause?.message;
      }

      expect(cause).toBeDefined();
      expect(cause).toMatch(/violates foreign key constraint/i);
    }
  );

  runDb('a junk non-uuid header is a varchar miss (201 + null), never a 22P02 cast error', async () => {
    const { partnerId, orgId, caller } = await seedTenant();

    activeAuth = { userId: caller.id, orgId, partnerId };
    const res = await register(await buildApp(), 'hello');

    expect(res.status).toBe(201);
    const rows = await insertedRow(caller.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mobileDeviceId).toBeNull();
    expect(auditCalls.at(-1)?.details).toMatchObject({ mobileDeviceHeaderUnresolved: 'hello' });
  });

  runDb(
    "does not adopt a same-tenant colleague's mobile_devices row — RLS alone would let it through",
    async () => {
      const { partnerId, orgId, caller, colleague } = await seedTenant();
      const perInstallId = `22222222-3333-4444-5555-${Date.now().toString().slice(-12)}`;
      const colleagueRowId = await seedMobileDevice(colleague.id, perInstallId);

      activeAuth = { userId: caller.id, orgId, partnerId };
      const app = await buildApp();
      const res = await register(app, perInstallId);

      expect(res.status).toBe(201);
      const rows = await insertedRow(caller.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.mobileDeviceId).toBeNull();
      expect(rows[0]!.mobileDeviceId).not.toBe(colleagueRowId);

      // Proof the null above came from the APP-LAYER ownership predicate and not
      // from RLS: under the caller's own request context, the colleague's row is
      // visible (the policy's `OR EXISTS` same-tenant branch). Drop
      // `eq(mobileDevices.userId, ...)` from the route and this row is what the
      // lookup would return.
      const { withDbAccessContext } = await import('../../db');
      const visible = await withDbAccessContext(
        {
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: [orgId],
          accessiblePartnerIds: [partnerId],
          userId: caller.id,
        },
        () =>
          db
            .select({ id: mobileDevices.id })
            .from(mobileDevices)
            .where(eq(mobileDevices.deviceId, perInstallId))
      );
      expect(visible.map((r) => r.id)).toEqual([colleagueRowId]);

      // ...and the ownership-scoped form the route actually issues sees nothing.
      const owned = await withDbAccessContext(
        {
          scope: 'partner',
          orgId: null,
          accessibleOrgIds: [orgId],
          accessiblePartnerIds: [partnerId],
          userId: caller.id,
        },
        () =>
          db
            .select({ id: mobileDevices.id })
            .from(mobileDevices)
            .where(
              and(eq(mobileDevices.deviceId, perInstallId), eq(mobileDevices.userId, caller.id))
            )
      );
      expect(owned).toEqual([]);
    }
  );

  runDb('registers with a null mobile_device_id when the header is absent', async () => {
    const { partnerId, orgId, caller } = await seedTenant();

    activeAuth = { userId: caller.id, orgId, partnerId };
    const res = await register(await buildApp());

    expect(res.status).toBe(201);
    const rows = await insertedRow(caller.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mobileDeviceId).toBeNull();
    expect(auditCalls.at(-1)?.details).not.toHaveProperty('mobileDeviceHeaderUnresolved');
  });
});
