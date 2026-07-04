/**
 * Replays the 2026-07-04-user-sso-identities-unique-external.sql migration
 * against DIRTY data (#2195).
 *
 * CI databases are always created schema-fresh, so the migration's dedupe
 * DO-block — whose entire purpose is cleaning up the duplicate rows the
 * pre-#2195 returning-login bug produced in production — would otherwise
 * never execute against non-empty data. This test drops the unique index,
 * seeds the exact duplicate shape the bug created, re-runs the REAL
 * migration file from disk, and asserts the freshest row per
 * (provider_id, external_id) survives.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/ssoIdentityDedupeMigration.integration.test.ts
 */
import './setup';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { sql, and, eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { ssoProviders, userSsoIdentities, users } from '../../db/schema';
import { createPartner } from './db-utils';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-07-04-user-sso-identities-unique-external.sql');

describe('user_sso_identities dedupe migration replay (#2195)', () => {
  it('keeps the freshest row per (provider_id, external_id), drops the rest, and restores the unique index', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const [provider] = await db
      .insert(ssoProviders)
      .values({
        partnerId: partner.id,
        orgId: null,
        name: 'Dedupe IdP',
        type: 'oidc',
        status: 'active',
        issuer: 'https://idp.dedupe.test',
        clientId: 'dedupe-client',
        autoProvision: false,
      })
      .returning();
    const [user] = await db
      .insert(users)
      .values({
        partnerId: partner.id,
        orgId: null,
        email: `dedupe-${randomUUID()}@example.com`,
        name: 'Dedupe User',
        passwordHash: null,
        status: 'active',
      })
      .returning();
    if (!provider || !user) throw new Error('fixture seed failed');

    // Recreate the pre-migration world: no unique index, duplicate links.
    await db.execute(sql`DROP INDEX IF EXISTS user_sso_identities_provider_external_idx`);

    const mkRow = (lastLoginAt: Date | null, createdAt: Date, marker: string) =>
      db.insert(userSsoIdentities).values({
        userId: user.id,
        providerId: provider.id,
        externalId: 'dedupe-sub',
        email: user.email,
        accessToken: marker, // marker to identify the surviving row
        lastLoginAt,
        createdAt,
      });

    // The bug inserted one row per returning login. Survivor must be the one
    // with the freshest last_login_at (NULLS LAST), created_at as tiebreak.
    await mkRow(new Date('2026-06-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'), 'stale');
    await mkRow(new Date('2026-07-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'), 'freshest');
    await mkRow(null, new Date('2026-07-02T00:00:00Z'), 'never-logged-in');

    // Replay the REAL migration file (multi-statement: DO-block + CREATE INDEX).
    await db.execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));

    const rows = await db
      .select()
      .from(userSsoIdentities)
      .where(and(
        eq(userSsoIdentities.providerId, provider.id),
        eq(userSsoIdentities.externalId, 'dedupe-sub')
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accessToken).toBe('freshest');

    // The unique index is back and enforcing.
    await expect(
      db.insert(userSsoIdentities).values({
        userId: user.id,
        providerId: provider.id,
        externalId: 'dedupe-sub',
        email: user.email,
      })
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    // Idempotency: re-applying the migration on clean data is a no-op.
    await expect(db.execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')))).resolves.toBeDefined();
  });

  it('resolves a CROSS-USER collision (the fired TOCTOU race) by keeping the freshest link', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const [provider] = await db
      .insert(ssoProviders)
      .values({
        partnerId: partner.id,
        orgId: null,
        name: 'Collision IdP',
        type: 'oidc',
        status: 'active',
        issuer: 'https://idp.collision.test',
        clientId: 'collision-client',
        autoProvision: false,
      })
      .returning();
    const mkUser = (tag: string) =>
      db.insert(users).values({
        partnerId: partner.id,
        orgId: null,
        email: `collision-${tag}-${randomUUID()}@example.com`,
        name: `Collision ${tag}`,
        passwordHash: null,
        status: 'active',
      }).returning();
    const [[userA], [userB]] = await Promise.all([mkUser('a'), mkUser('b')]);
    if (!provider || !userA || !userB) throw new Error('fixture seed failed');

    await db.execute(sql`DROP INDEX IF EXISTS user_sso_identities_provider_external_idx`);
    await db.insert(userSsoIdentities).values({
      userId: userA.id,
      providerId: provider.id,
      externalId: 'collision-sub',
      email: userA.email,
      lastLoginAt: new Date('2026-06-01T00:00:00Z'),
    });
    await db.insert(userSsoIdentities).values({
      userId: userB.id,
      providerId: provider.id,
      externalId: 'collision-sub',
      email: userB.email,
      lastLoginAt: new Date('2026-07-01T00:00:00Z'),
    });

    await db.execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));

    // userB's link (freshest last_login_at) survives; userA's is revoked.
    // The migration RAISE WARNINGs the collision with both user ids first —
    // visible in Postgres logs, not assertable from here.
    const rows = await db
      .select()
      .from(userSsoIdentities)
      .where(and(
        eq(userSsoIdentities.providerId, provider.id),
        eq(userSsoIdentities.externalId, 'collision-sub')
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userB.id);
  });
});
