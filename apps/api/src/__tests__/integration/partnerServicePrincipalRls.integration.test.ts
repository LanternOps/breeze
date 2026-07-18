/**
 * Real-PostgreSQL contract for partner-owned service principals and keys.
 * All authorization assertions run through the production `db` pool as the
 * non-BYPASSRLS `breeze_app` role.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { partnerServicePrincipalKeys, partnerServicePrincipals } from '../../db/schema';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-16-partner-service-principals.sql',
);
const ALL_SCOPES = [
  'organizations:read',
  'sites:read',
  'devices:read',
  'inventory:read',
  'configuration:read',
  'scripts:read',
  'backup-configuration:read',
  'custom-fields:read',
] as const;

function partnerContext(partnerId: string, userId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId,
  };
}

async function seedTwoPartners() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const userA = await createUser({ partnerId: partnerA.id });
  const userB = await createUser({ partnerId: partnerB.id });

  return {
    partnerA,
    partnerB,
    userA,
    userB,
    contextA: partnerContext(partnerA.id, userA.id),
  };
}

async function insertPrincipal(input: {
  partnerId: string;
  userId: string;
  name: string;
}) {
  const [principal] = await withSystemDbAccessContext(() =>
    db
      .insert(partnerServicePrincipals)
      .values({
        partnerId: input.partnerId,
        name: input.name,
        scopes: [...ALL_SCOPES],
        createdBy: input.userId,
        updatedBy: input.userId,
      })
      .returning(),
  );
  if (!principal) throw new Error('service principal seed insert returned no row');
  return principal;
}

async function insertKey(input: {
  partnerId: string;
  principalId: string;
  userId: string;
  name: string;
  rotatedFromId?: string;
}) {
  const [key] = await withSystemDbAccessContext(() =>
    db
      .insert(partnerServicePrincipalKeys)
      .values({
        partnerId: input.partnerId,
        partnerServicePrincipalId: input.principalId,
        name: input.name,
        keyHash: `hash-${randomUUID()}`,
        keyPrefix: `brz_sp_${randomUUID().slice(0, 8)}`,
        rotatedFromId: input.rotatedFromId,
        createdBy: input.userId,
      })
      .returning(),
  );
  if (!key) throw new Error('service principal key seed insert returned no row');
  return key;
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
    const wrapped = error as {
      code?: string;
      message?: string;
      constraint_name?: string;
      cause?: { code?: string; message?: string; constraint_name?: string };
    };
    return wrapped.cause ?? wrapped;
  }
}

describe('partner-service-principal database contract', () => {
  runDb('migration is idempotent', async () => {
    const adminDb = getTestDb();
    const migration = readFileSync(MIGRATION_FILE, 'utf8');

    await expect(adminDb.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(adminDb.execute(sql.raw(migration))).resolves.toBeDefined();
  });

  runDb('enforces unique principal names within a partner', async () => {
    const { partnerA, userA } = await seedTwoPartners();
    await insertPrincipal({ partnerId: partnerA.id, userId: userA.id, name: 'unique-name' });
    const cause = await captureCause(() => insertPrincipal({
      partnerId: partnerA.id,
      userId: userA.id,
      name: 'unique-name',
    }));
    expect(cause?.code).toBe('23505');
    expect(cause?.constraint_name).toBe('partner_service_principals_partner_name_unique');
  });

  runDb.each([
    { label: 'empty', scopes: [] },
    { label: 'duplicate', scopes: ['devices:read', 'devices:read'] },
    { label: 'unknown', scopes: ['devices:read', 'alerts:read'] },
  ])('rejects $label principal scopes in PostgreSQL', async ({ scopes }) => {
    const { partnerA, userA } = await seedTwoPartners();
    const cause = await captureCause(() =>
      (getTestDb() as any).insert(partnerServicePrincipals).values({
        partnerId: partnerA.id,
        name: `invalid-scopes-${randomUUID()}`,
        scopes,
        createdBy: userA.id,
        updatedBy: userA.id,
      }),
    );

    expect(cause?.code).toBe('23514');
    expect(cause?.constraint_name).toBe('partner_service_principals_scopes_check');
  });

  runDb('rejects unknown principal and key status values', async () => {
    const { partnerA, userA } = await seedTwoPartners();
    const principalStatusCause = await captureCause(() =>
      (getTestDb() as any).insert(partnerServicePrincipals).values({
        partnerId: partnerA.id,
        name: 'invalid-principal-status',
        status: 'suspended',
        scopes: ['devices:read'],
        createdBy: userA.id,
        updatedBy: userA.id,
      }),
    );
    expect(principalStatusCause?.code).toBe('23514');
    expect(principalStatusCause?.constraint_name).toBe('partner_service_principals_status_check');

    const principal = await insertPrincipal({
      partnerId: partnerA.id,
      userId: userA.id,
      name: 'valid-principal',
    });
    const keyStatusCause = await captureCause(() =>
      (getTestDb() as any).insert(partnerServicePrincipalKeys).values({
        partnerId: partnerA.id,
        partnerServicePrincipalId: principal.id,
        name: 'invalid-key-status',
        keyHash: `hash-${randomUUID()}`,
        keyPrefix: 'brz_sp_invalid',
        status: 'disabled',
        createdBy: userA.id,
      }),
    );
    expect(keyStatusCause?.code).toBe('23514');
    expect(keyStatusCause?.constraint_name).toBe('partner_service_principal_keys_status_check');
  });

  runDb('enforces principal ownership and rotated-key lineage within one partner', async () => {
    const { partnerA, partnerB, userA, userB, contextA } = await seedTwoPartners();
    const principalA = await insertPrincipal({
      partnerId: partnerA.id,
      userId: userA.id,
      name: 'principal-a',
    });
    const principalB = await insertPrincipal({
      partnerId: partnerB.id,
      userId: userB.id,
      name: 'principal-b',
    });
    const keyB = await insertKey({
      partnerId: partnerB.id,
      principalId: principalB.id,
      userId: userB.id,
      name: 'key-b',
    });

    const wrongPrincipalCause = await captureCause(() =>
      withDbAccessContext(contextA, () =>
        db.insert(partnerServicePrincipalKeys).values({
          partnerId: partnerA.id,
          partnerServicePrincipalId: principalB.id,
          name: 'wrong-principal-owner',
          keyHash: `hash-${randomUUID()}`,
          keyPrefix: 'brz_sp_wrongprincipal',
          createdBy: userA.id,
        }),
      ),
    );
    expect(wrongPrincipalCause?.code).toBe('23503');
    expect(wrongPrincipalCause?.constraint_name).toBe(
      'partner_service_principal_keys_principal_partner_fk',
    );

    const wrongLineageCause = await captureCause(() =>
      withDbAccessContext(contextA, () =>
        db.insert(partnerServicePrincipalKeys).values({
          partnerId: partnerA.id,
          partnerServicePrincipalId: principalA.id,
          name: 'wrong-rotated-owner',
          keyHash: `hash-${randomUUID()}`,
          keyPrefix: 'brz_sp_wrongrotation',
          rotatedFromId: keyB.id,
          createdBy: userA.id,
        }),
      ),
    );
    expect(wrongLineageCause?.code).toBe('23503');
    expect(wrongLineageCause?.constraint_name).toBe(
      'partner_service_principal_keys_rotated_from_partner_fk',
    );
  });
});

describe('partner-service-principal partner-axis RLS (breeze_app)', () => {
  runDb('uses the non-BYPASSRLS breeze_app role', async () => {
    const { contextA } = await seedTwoPartners();
    const result = await withDbAccessContext(contextA, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`),
    ) as unknown as Array<{ who: string; rolbypassrls: boolean }>;

    expect(result[0]).toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('hides Partner B principals and keys from Partner A', async () => {
    const { partnerB, userB, contextA } = await seedTwoPartners();
    const principalB = await insertPrincipal({
      partnerId: partnerB.id,
      userId: userB.id,
      name: 'hidden-principal-b',
    });
    const keyB = await insertKey({
      partnerId: partnerB.id,
      principalId: principalB.id,
      userId: userB.id,
      name: 'hidden-key-b',
    });

    const [principals, keys] = await withDbAccessContext(contextA, () =>
      Promise.all([
        db.select({ id: partnerServicePrincipals.id }).from(partnerServicePrincipals)
          .where(eq(partnerServicePrincipals.id, principalB.id)),
        db.select({ id: partnerServicePrincipalKeys.id }).from(partnerServicePrincipalKeys)
          .where(eq(partnerServicePrincipalKeys.id, keyB.id)),
      ]),
    );

    expect(principals).toEqual([]);
    expect(keys).toEqual([]);
  });

  runDb.each([
    { table: 'partner_service_principals' as const },
    { table: 'partner_service_principal_keys' as const },
  ])('rejects forged Partner B inserts into $table by Partner A', async ({ table }) => {
    const { partnerB, userA, userB, contextA } = await seedTwoPartners();
    const principalB = await insertPrincipal({
      partnerId: partnerB.id,
      userId: userB.id,
      name: 'forge-target-b',
    });

    const cause = await captureCause(() =>
      withDbAccessContext(contextA, () =>
        table === 'partner_service_principals'
          ? db.insert(partnerServicePrincipals).values({
              partnerId: partnerB.id,
              name: 'forged-principal',
              scopes: ['devices:read'],
              createdBy: userA.id,
              updatedBy: userA.id,
            })
          : db.insert(partnerServicePrincipalKeys).values({
              partnerId: partnerB.id,
              partnerServicePrincipalId: principalB.id,
              name: 'forged-key',
              keyHash: `hash-${randomUUID()}`,
              keyPrefix: 'brz_sp_forged',
              createdBy: userA.id,
            }),
      ),
    );

    expect(cause?.code).toBe('42501');
    expect(cause?.message).toContain(
      `new row violates row-level security policy for table "${table}"`,
    );
  });

  runDb.each([
    { table: 'partner_service_principals' as const },
    { table: 'partner_service_principal_keys' as const },
  ])('rejects forged Partner B updates to $table by Partner A', async ({ table }) => {
    const { partnerA, partnerB, userA, contextA } = await seedTwoPartners();
    const principalA = await insertPrincipal({
      partnerId: partnerA.id,
      userId: userA.id,
      name: 'update-source-a',
    });
    const keyA = await insertKey({
      partnerId: partnerA.id,
      principalId: principalA.id,
      userId: userA.id,
      name: 'update-key-a',
    });

    const cause = await captureCause(() =>
      withDbAccessContext(contextA, () =>
        table === 'partner_service_principals'
          ? db.update(partnerServicePrincipals).set({ partnerId: partnerB.id })
              .where(eq(partnerServicePrincipals.id, principalA.id))
          : db.update(partnerServicePrincipalKeys).set({ partnerId: partnerB.id })
              .where(eq(partnerServicePrincipalKeys.id, keyA.id)),
      ),
    );

    expect(cause?.code).toBe('42501');
    expect(cause?.message).toContain(
      `new row violates row-level security policy for table "${table}"`,
    );
  });
});
