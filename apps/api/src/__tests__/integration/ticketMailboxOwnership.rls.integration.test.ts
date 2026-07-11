/**
 * Real-database proof for verified Microsoft tenant ownership and consent state.
 *
 * This suite deliberately replays the real migration over a pre-hardening row,
 * then exercises the constraints and forced partner-axis RLS as breeze_app.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-15-a-ticket-mailbox-verified-ownership.sql',
);

function partnerCtx(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

async function seedPartnersAndUsers() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const userA = await createUser({ partnerId: partnerA.id });
  const userB = await createUser({ partnerId: partnerB.id });
  return {
    partnerA,
    partnerB,
    userA,
    userB,
    contextA: partnerCtx(partnerA.id),
    contextB: partnerCtx(partnerB.id),
  };
}

async function captureCause(fn: () => Promise<unknown>): Promise<{
  code?: string;
  message?: string;
  constraint_name?: string;
} | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as {
      cause?: { code?: string; message?: string; constraint_name?: string };
    }).cause;
  }
}

async function verifyMigrationCleanup() {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const connectionId = randomUUID();
    const cleanDisabledConnectionId = randomUUID();
    const dirtyDisabledConnectionId = randomUUID();
    const legacyTenantId = randomUUID();

    // Recreate the pre-hardening schema and row, then replay the real migration.
    await adminDb.execute(sql`DROP TABLE IF EXISTS ticket_mailbox_consent_sessions CASCADE`);
    await adminDb.execute(sql`ALTER TABLE ticket_mailbox_connections
      DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_connected_requires_verified_tenant`);
    await adminDb.execute(sql`ALTER TABLE ticket_mailbox_connections
      DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_tenant_partner_fk`);
    await adminDb.execute(sql`DROP TABLE IF EXISTS ticket_mailbox_tenant_ownerships CASCADE`);
    await adminDb.execute(sql`ALTER TABLE ticket_mailbox_connections
      ALTER COLUMN tenant_id TYPE text USING tenant_id::text`);
    await adminDb.execute(sql`
      INSERT INTO ticket_mailbox_connections
        (id, partner_id, tenant_id, mailbox_address, status, delta_link, last_error)
      VALUES
        (${connectionId}, ${partner.id}, ${legacyTenantId}, 'legacy@example.com',
         'connected', 'https://graph.example/delta', 'legacy error')
    `);
    await adminDb.execute(sql`
      INSERT INTO ticket_mailbox_connections
        (id, partner_id, tenant_id, mailbox_address, status, delta_link)
      VALUES
        (${cleanDisabledConnectionId}, ${partner.id}, NULL, 'clean-disabled@example.com',
         'disabled', NULL),
        (${dirtyDisabledConnectionId}, ${partner.id}, ${randomUUID()}, 'dirty-disabled@example.com',
         'disabled', 'https://graph.example/legacy-disabled-delta')
    `);

    await adminDb.execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
    // autoMigrate calls ensureAppRole after applying migrations in production.
    // This direct replay bypasses that wrapper, so mirror its table grants.
    await adminDb.execute(sql`
      GRANT SELECT, INSERT, UPDATE, DELETE
      ON ticket_mailbox_tenant_ownerships, ticket_mailbox_consent_sessions
      TO breeze_app
    `);

    const rows = await adminDb.execute(sql`
      SELECT status, tenant_id AS "tenantId", delta_link AS "deltaLink", last_error AS "lastError"
      FROM ticket_mailbox_connections WHERE id = ${connectionId}
    `) as unknown as Array<{
      status: string;
      tenantId: string | null;
      deltaLink: string | null;
      lastError: string | null;
    }>;
    expect(rows[0]?.status).toBe('reauth_required');
    expect(rows[0]?.tenantId).toBeNull();
    expect(rows[0]?.deltaLink).toBeNull();
    expect(rows[0]?.lastError).toBeNull();

    const disabledRows = await adminDb.execute(sql`
      SELECT id, status, tenant_id AS "tenantId", delta_link AS "deltaLink"
      FROM ticket_mailbox_connections
      WHERE id IN (${cleanDisabledConnectionId}, ${dirtyDisabledConnectionId})
      ORDER BY mailbox_address
    `) as unknown as Array<{
      id: string;
      status: string;
      tenantId: string | null;
      deltaLink: string | null;
    }>;
    expect(disabledRows).toEqual([
      expect.objectContaining({
        id: cleanDisabledConnectionId, status: 'disabled', tenantId: null, deltaLink: null,
      }),
      expect.objectContaining({
        id: dirtyDisabledConnectionId, status: 'reauth_required', tenantId: null, deltaLink: null,
      }),
    ]);

    const sessionColumns = await adminDb.execute(sql`
      SELECT column_name AS "columnName", data_type AS "dataType"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ticket_mailbox_consent_sessions'
        AND column_name IN ('tenant_hint', 'tenant_hint_hash')
      ORDER BY column_name
    `) as unknown as Array<{ columnName: string; dataType: string }>;
    expect(sessionColumns).toEqual([{ columnName: 'tenant_hint_hash', dataType: 'text' }]);

    // Once the column is hardened to UUID, replay must not revoke a valid
    // verified binding or discard its active delta cursor.
    const verifiedTenantId = randomUUID();
    const verifiedConnectionId = randomUUID();
    const deltaLink = 'https://graph.example/verified-delta';
    await adminDb.execute(sql`
      INSERT INTO ticket_mailbox_tenant_ownerships
        (tenant_id, partner_id, verified_microsoft_oid)
      VALUES (${verifiedTenantId}, ${partner.id}, ${randomUUID()})
    `);
    await adminDb.execute(sql`
      INSERT INTO ticket_mailbox_connections
        (id, partner_id, tenant_id, mailbox_address, status, delta_link)
      VALUES (${verifiedConnectionId}, ${partner.id}, ${verifiedTenantId},
              'verified@example.com', 'connected', ${deltaLink})
    `);

    // The migration is additive/idempotent, including the UUID type guard.
    await expect(adminDb.execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')))).resolves.toBeDefined();

    const preservedRows = await adminDb.execute(sql`
      SELECT status, tenant_id AS "tenantId", delta_link AS "deltaLink"
      FROM ticket_mailbox_connections WHERE id = ${verifiedConnectionId}
    `) as unknown as Array<{
      status: string;
      tenantId: string | null;
      deltaLink: string | null;
    }>;
    expect(preservedRows[0]?.status).toBe('connected');
    expect(preservedRows[0]?.tenantId).toBe(verifiedTenantId);
    expect(preservedRows[0]?.deltaLink).toBe(deltaLink);
}

async function verifyConnectedOwnershipGuard() {
    const adminDb = getTestDb();
    const { partnerA, partnerB, userA, contextA, contextB } = await seedPartnersAndUsers();
    const tenantId = randomUUID();

    await withDbAccessContext(contextA, () => db.execute(sql`
      INSERT INTO ticket_mailbox_tenant_ownerships
        (tenant_id, partner_id, verified_by, verified_microsoft_oid)
      VALUES (${tenantId}, ${partnerA.id}, ${userA.id}, ${randomUUID()})
    `));

    const missingTenantCause = await captureCause(() => withDbAccessContext(contextA, () => db.execute(sql`
      INSERT INTO ticket_mailbox_connections (partner_id, mailbox_address, status, tenant_id)
      VALUES (${partnerA.id}, 'missing-tenant@example.com', 'connected', NULL)
    `)));
    expect(missingTenantCause?.code).toBe('23514');
    expect(missingTenantCause?.constraint_name).toBe(
      'ticket_mailbox_connections_connected_requires_verified_tenant',
    );

    const wrongPartnerCause = await captureCause(() => withDbAccessContext(contextB, () => db.execute(sql`
      INSERT INTO ticket_mailbox_connections (partner_id, mailbox_address, status, tenant_id)
      VALUES (${partnerB.id}, 'wrong-partner@example.com', 'connected', ${tenantId})
    `)));
    expect(wrongPartnerCause?.code).toBe('23503');
    expect(wrongPartnerCause?.constraint_name).toBe('ticket_mailbox_connections_tenant_partner_fk');

    await expect(withDbAccessContext(contextA, () => db.execute(sql`
      INSERT INTO ticket_mailbox_connections (partner_id, mailbox_address, status, tenant_id)
      VALUES (${partnerA.id}, 'verified@example.com', 'connected', ${tenantId})
    `))).resolves.toBeDefined();

    const typeRows = await adminDb.execute(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ticket_mailbox_connections'
        AND column_name = 'tenant_id'
    `) as unknown as Array<{ data_type: string }>;
    expect(typeRows[0]?.data_type).toBe('uuid');
}

async function verifyGlobalTenantUniqueness() {
    const { partnerA, partnerB, userA, userB, contextA, contextB } = await seedPartnersAndUsers();
    const tenantId = randomUUID();

    await withDbAccessContext(contextA, () => db.execute(sql`
      INSERT INTO ticket_mailbox_tenant_ownerships
        (tenant_id, partner_id, verified_by, verified_microsoft_oid)
      VALUES (${tenantId}, ${partnerA.id}, ${userA.id}, ${randomUUID()})
    `));

    const duplicateCause = await captureCause(() => withDbAccessContext(contextB, () => db.execute(sql`
      INSERT INTO ticket_mailbox_tenant_ownerships
        (tenant_id, partner_id, verified_by, verified_microsoft_oid)
      VALUES (${tenantId}, ${partnerB.id}, ${userB.id}, ${randomUUID()})
    `)));
    expect(duplicateCause?.code).toBe('23505');
    expect(duplicateCause?.message).toMatch(/duplicate key|unique/i);
}

async function verifyPartnerAxisRls() {
    const { partnerB, userA, userB, contextA } = await seedPartnersAndUsers();
    const tenantB = randomUUID();
    const connectionB = randomUUID();
    const ownershipA = randomUUID();

    const adminDb = getTestDb();
    await adminDb.execute(sql`
      INSERT INTO ticket_mailbox_tenant_ownerships
        (tenant_id, partner_id, verified_by, verified_microsoft_oid)
      VALUES (${tenantB}, ${partnerB.id}, ${userB.id}, ${randomUUID()})
    `);
    await adminDb.execute(sql`
      INSERT INTO ticket_mailbox_connections (id, partner_id, mailbox_address)
      VALUES (${connectionB}, ${partnerB.id}, 'consent-b@example.com')
    `);
    await adminDb.execute(sql`
      INSERT INTO ticket_mailbox_consent_sessions
        (state, phase, partner_id, connection_id, user_id, tenant_hint_hash, expires_at)
      VALUES ('state-b', 'admin_consent', ${partnerB.id}, ${connectionB}, ${userB.id},
              'test-only-tenant-hash', now() + interval '10 minutes')
    `);

    const ownershipRows = await withDbAccessContext(contextA, () => db.execute(sql`
      SELECT tenant_id FROM ticket_mailbox_tenant_ownerships WHERE tenant_id = ${tenantB}
    `));
    const sessionRows = await withDbAccessContext(contextA, () => db.execute(sql`
      SELECT id FROM ticket_mailbox_consent_sessions WHERE connection_id = ${connectionB}
    `));
    expect(ownershipRows).toHaveLength(0);
    expect(sessionRows).toHaveLength(0);

    const ownershipForgeCause = await captureCause(() => withDbAccessContext(contextA, () => db.execute(sql`
      INSERT INTO ticket_mailbox_tenant_ownerships
        (tenant_id, partner_id, verified_by, verified_microsoft_oid)
      VALUES (${ownershipA}, ${partnerB.id}, ${userA.id}, ${randomUUID()})
    `)));
    expect(ownershipForgeCause?.code).toBe('42501');
    expect(ownershipForgeCause?.message).toMatch(/row-level security/i);

    const sessionForgeCause = await captureCause(() => withDbAccessContext(contextA, () => db.execute(sql`
      INSERT INTO ticket_mailbox_consent_sessions
        (state, phase, partner_id, connection_id, user_id, expires_at)
      VALUES ('forged-state', 'identity_verification', ${partnerB.id}, ${connectionB},
              ${userA.id}, now() + interval '10 minutes')
    `)));
    expect(sessionForgeCause?.code).toBe('42501');
    expect(sessionForgeCause?.message).toMatch(/row-level security/i);
}

describe('ticket mailbox verified tenant ownership storage', () => {
  // Keep all assertions under one integration setup cycle. The shared cleanup
  // truncates hundreds of tables and can exceed Vitest's 30-second hook limit
  // when repeated several times on slower CI/OrbStack disks.
  runDb('enforces migration cleanup, verified ownership, composite FKs, and partner-axis RLS', async () => {
    await verifyMigrationCleanup();
    await verifyConnectedOwnershipGuard();
    await verifyGlobalTenantUniqueness();
    await verifyPartnerAxisRls();
  }, 120_000);
});
