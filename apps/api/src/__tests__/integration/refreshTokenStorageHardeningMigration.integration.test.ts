/**
 * MCP-OAUTH-04: replays 2026-07-11-refresh-token-storage-hardening.sql against
 * DIRTY, pre-hardening data (legacy plaintext refresh rows).
 *
 * The test DB is created schema-fresh with EVERY migration already applied, so
 * the hardening constraints exist and the cleanup DO-block has nothing to do on
 * a live insert. To exercise the real migration we recreate the pre-hardening
 * world: DROP both constraints, seed a legacy plaintext refresh row (raw id +
 * a `jti` in the payload) alongside a properly-digested survivor row, then
 * re-run the REAL migration file from disk and assert:
 *   - the legacy row's grant family is revoked with the hardening reason;
 *   - the legacy refresh row is deleted; the digest survivor + its grant remain;
 *   - both CHECK constraints are (re-)installed and enforcing;
 *   - re-applying the migration on clean data is a safe no-op.
 *
 * Prerequisites: docker compose -f docker-compose.test.yml up -d
 * Run:
 *   pnpm --filter @breeze/api test:integration \
 *     src/__tests__/integration/refreshTokenStorageHardeningMigration.integration.test.ts
 */
import './setup';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { oauthClients, oauthGrants, oauthRefreshTokens } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-07-11-refresh-token-storage-hardening.sql');
const runMigration = () => getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));

const future = () => new Date(Date.now() + 60 * 60 * 1000);
const digestId = (raw: string) => createHash('sha256').update(raw).digest('hex');

describe('refresh-token storage hardening migration replay (MCP-OAUTH-04)', () => {
  it('revokes legacy grants, deletes plaintext rows, keeps digest rows, and installs enforcing constraints', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `rt-harden-${Date.now()}@example.test` });

    const clientId = `client-harden-${Date.now()}`;
    await db.insert(oauthClients).values({ id: clientId, partnerId: null, metadata: { client_name: 'Harden DCR' } });

    // Grant referenced by the legacy plaintext row — must end up revoked.
    await db.insert(oauthGrants).values({
      id: 'grant-legacy', accountId: user.id, clientId, partnerId: partner.id, orgId: org.id,
      payload: { accountId: user.id, grantId: 'grant-legacy' }, expiresAt: future(),
    });
    // Grant referenced only by a proper digest row — must stay active.
    await db.insert(oauthGrants).values({
      id: 'grant-keep', accountId: user.id, clientId, partnerId: partner.id, orgId: org.id,
      payload: { accountId: user.id, grantId: 'grant-keep' }, expiresAt: future(),
    });

    // Recreate the pre-hardening world so we can seed illegal rows.
    await db.execute(sql`ALTER TABLE oauth_refresh_tokens DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_id_digest_chk`);
    await db.execute(sql`ALTER TABLE oauth_refresh_tokens DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_no_jti_chk`);

    // Legacy plaintext row: raw id + jti persisted in the payload.
    const rawId = 'plaintext-refresh-token-value';
    await db.insert(oauthRefreshTokens).values({
      id: rawId, userId: user.id, clientId, partnerId: partner.id, orgId: org.id,
      payload: { accountId: user.id, grantId: 'grant-legacy', jti: rawId }, expiresAt: future(),
    });
    // Properly-hardened survivor row: 64-hex id, no jti in payload.
    const survivorId = digestId('survivor-raw');
    await db.insert(oauthRefreshTokens).values({
      id: survivorId, userId: user.id, clientId, partnerId: partner.id, orgId: org.id,
      payload: { accountId: user.id, grantId: 'grant-keep' }, expiresAt: future(),
    });

    await runMigration();

    // Legacy grant revoked with the hardening reason; keep-grant untouched.
    const [legacyGrant] = await db.select({ revokedAt: oauthGrants.revokedAt, revokedReason: oauthGrants.revokedReason })
      .from(oauthGrants).where(eq(oauthGrants.id, 'grant-legacy'));
    expect(legacyGrant?.revokedAt).not.toBeNull();
    expect(legacyGrant?.revokedReason).toBe('refresh_token_storage_hardening');
    const [keepGrant] = await db.select({ revokedAt: oauthGrants.revokedAt })
      .from(oauthGrants).where(eq(oauthGrants.id, 'grant-keep'));
    expect(keepGrant?.revokedAt).toBeNull();

    // Legacy plaintext row deleted; digest survivor retained.
    const remaining = await db.select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens).where(eq(oauthRefreshTokens.clientId, clientId));
    expect(remaining.map((r) => r.id)).toEqual([survivorId]);

    // Constraint 1: a non-digest id is now rejected (CHECK violation 23514).
    await expect(db.insert(oauthRefreshTokens).values({
      id: 'still-plaintext', userId: user.id, clientId, partnerId: partner.id, orgId: org.id,
      payload: { accountId: user.id, grantId: 'grant-keep' }, expiresAt: future(),
    })).rejects.toMatchObject({ cause: { code: '23514' } });

    // Constraint 2: a jti key in the payload is now rejected.
    await expect(db.insert(oauthRefreshTokens).values({
      id: digestId('has-jti'), userId: user.id, clientId, partnerId: partner.id, orgId: org.id,
      payload: { accountId: user.id, grantId: 'grant-keep', jti: 'leak' }, expiresAt: future(),
    })).rejects.toMatchObject({ cause: { code: '23514' } });

    // Idempotent: re-applying on now-clean data revokes 0 / deletes 0 and the
    // DROP-then-ADD constraint dance is a net no-op (still enforcing below).
    await expect(runMigration()).resolves.toBeDefined();
    const keepGrantAfter = await db.select({ revokedAt: oauthGrants.revokedAt })
      .from(oauthGrants).where(eq(oauthGrants.id, 'grant-keep'));
    expect(keepGrantAfter[0]?.revokedAt).toBeNull();
    // Survivor row untouched by the repeat application.
    const survivorAfter = await db.select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, survivorId));
    expect(survivorAfter).toHaveLength(1);
    // Constraints still reject a plaintext id after repeated application.
    await expect(db.insert(oauthRefreshTokens).values({
      id: 'still-plaintext-2', userId: user.id, clientId, partnerId: partner.id, orgId: org.id,
      payload: { accountId: user.id, grantId: 'grant-keep' }, expiresAt: future(),
    })).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
