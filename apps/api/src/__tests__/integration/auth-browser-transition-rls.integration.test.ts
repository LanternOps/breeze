import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../migrations/2026-07-12-a-auth-browser-transitions.sql',
);
const transitionSchemaPath = path.resolve(
  import.meta.dirname,
  '../../db/schema/authBrowserTransitions.ts',
);
const refreshFamilySchemaPath = path.resolve(
  import.meta.dirname,
  '../../db/schema/refreshTokenFamilies.ts',
);
const ssoSchemaPath = path.resolve(import.meta.dirname, '../../db/schema/sso.ts');

function readSource(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const migrationSql = readSource(migrationPath);
const transitionSchema = readSource(transitionSchemaPath);
const refreshFamilySchema = readSource(refreshFamilySchemaPath);
const ssoSchema = readSource(ssoSchemaPath);

const databaseUrl = process.env.DATABASE_URL;
const appDatabaseUrl = process.env.DATABASE_URL_APP;
const runDb = Boolean(databaseUrl && appDatabaseUrl);
const admin = runDb ? postgres(databaseUrl!, { max: 1 }) : null;
const app = runDb ? postgres(appDatabaseUrl!, { max: 1 }) : null;

afterAll(async () => {
  await Promise.all([admin?.end(), app?.end()]);
});

describe('durable browser transition schema contract', () => {
  it('defines the complete transition state, operation, and logout lifecycle', () => {
    expect(transitionSchema).toMatch(/pgTable\(\s*'auth_browser_transitions'/);
    expect(transitionSchema).toContain("bindingDigest: varchar('binding_digest', { length: 64 }).notNull()");
    expect(transitionSchema).toContain("generation: bigint('generation', { mode: 'number' })");
    expect(transitionSchema).toContain("state: varchar('state'");
    expect(transitionSchema).toContain("activeOperationId: uuid('active_operation_id')");
    expect(transitionSchema).toContain("activeOperationExpiresAt: timestamp('active_operation_expires_at'");
    expect(transitionSchema).toContain("logoutId: uuid('logout_id')");
    expect(transitionSchema).toContain("completionNonceDigest: varchar('completion_nonce_digest', { length: 64 })");
    expect(transitionSchema).toContain("logoutExpiresAt: timestamp('logout_expires_at'");
    expect(transitionSchema).toContain("retiredAt: timestamp('retired_at'");
    expect(transitionSchema).toContain('auth_browser_transitions_binding_digest_unique');
  });

  it('keeps rollout columns nullable and binds SSO state to a transition generation', () => {
    expect(refreshFamilySchema).toContain(
      "currentRefreshJtiDigest: varchar('current_refresh_jti_digest', { length: 64 })",
    );
    expect(refreshFamilySchema).not.toContain(
      "currentRefreshJtiDigest: varchar('current_refresh_jti_digest', { length: 64 }).notNull()",
    );
    expect(ssoSchema).toContain("browserTransitionId: uuid('browser_transition_id')");
    expect(ssoSchema).toContain("browserGeneration: bigint('browser_generation', { mode: 'number' })");
    expect(ssoSchema).toContain('sso_sessions_browser_transition_generation_fk');
  });

  it('stores durable SSO exchange authority as a digest and never as a raw code', () => {
    expect(transitionSchema).toMatch(/pgTable\(\s*'sso_token_exchange_grants'/);
    expect(transitionSchema).toContain("codeDigest: varchar('code_digest', { length: 64 }).notNull()");
    expect(transitionSchema).not.toMatch(/\bcode:\s*(?:text|varchar)\(/);
    expect(migrationSql).not.toMatch(/\bcode\s+(?:text|varchar)\b/i);
  });

  it('declares idempotent, system-only forced-RLS migration primitives', () => {
    for (const table of ['auth_browser_transitions', 'sso_token_exchange_grants']) {
      expect(migrationSql).toMatch(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'),
      );
      expect(migrationSql).toMatch(
        new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'),
      );
      expect(migrationSql).toMatch(
        new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'),
      );
      expect(migrationSql).toMatch(
        new RegExp(`${table}_system_only[\\s\\S]+breeze\\.scope[\\s\\S]+system`, 'i'),
      );
    }
    expect(migrationSql).toMatch(
      /ALTER TABLE refresh_token_families\s+ADD COLUMN IF NOT EXISTS current_refresh_jti_digest/i,
    );
    expect(migrationSql).toMatch(
      /ALTER TABLE sso_sessions\s+ADD COLUMN IF NOT EXISTS browser_transition_id/i,
    );
    expect(migrationSql).toMatch(
      /ALTER TABLE sso_sessions\s+ADD COLUMN IF NOT EXISTS browser_generation/i,
    );
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
});

describe.runIf(runDb)('durable browser transition migration and RLS', () => {
  it('has the required nullable columns, checks, indexes, and system-only policies', async () => {
    const columns = await admin!`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          table_name IN ('auth_browser_transitions', 'sso_token_exchange_grants')
          OR (table_name = 'refresh_token_families' AND column_name = 'current_refresh_jti_digest')
          OR (table_name = 'sso_sessions' AND column_name IN ('browser_transition_id', 'browser_generation'))
        )
    `;
    expect(columns.some((row) => row.table_name === 'auth_browser_transitions')).toBe(true);
    expect(columns.some((row) => row.table_name === 'sso_token_exchange_grants')).toBe(true);
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table_name: 'refresh_token_families',
          column_name: 'current_refresh_jti_digest',
          is_nullable: 'YES',
        }),
        expect.objectContaining({
          table_name: 'sso_sessions',
          column_name: 'browser_transition_id',
          is_nullable: 'YES',
        }),
        expect.objectContaining({
          table_name: 'sso_sessions',
          column_name: 'browser_generation',
          is_nullable: 'YES',
        }),
      ]),
    );

    const tables = await admin!`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('auth_browser_transitions', 'sso_token_exchange_grants')
    `;
    expect(tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relname: 'auth_browser_transitions',
          relrowsecurity: true,
          relforcerowsecurity: true,
        }),
        expect.objectContaining({
          relname: 'sso_token_exchange_grants',
          relrowsecurity: true,
          relforcerowsecurity: true,
        }),
      ]),
    );

    const policies = await admin!`
      SELECT tablename, policyname, cmd, qual, with_check
      FROM pg_policies
      WHERE tablename IN ('auth_browser_transitions', 'sso_token_exchange_grants')
    `;
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(policy.policyname).toBe(`${policy.tablename}_system_only`);
      expect(policy.cmd).toBe('ALL');
      expect(`${policy.qual} ${policy.with_check}`).toMatch(/breeze\.scope.*system/i);
    }

    const constraints = await admin!`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid IN (
        'auth_browser_transitions'::regclass,
        'sso_token_exchange_grants'::regclass,
        'sso_sessions'::regclass,
        'refresh_token_families'::regclass
      )
    `;
    const constraintNames = constraints.map((row) => row.conname);
    expect(constraintNames).toEqual(
      expect.arrayContaining([
        'auth_browser_transitions_binding_digest_unique',
        'auth_browser_transitions_state_chk',
        'auth_browser_transitions_operation_pair_chk',
        'auth_browser_transitions_current_family_owner_fk',
        'sso_token_exchange_grants_transition_generation_fk',
        'sso_token_exchange_grants_family_owner_fk',
        'sso_sessions_browser_transition_generation_fk',
        'sso_sessions_browser_transition_pair_chk',
      ]),
    );

    const indexes = await admin!`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'auth_browser_transitions_logout_expires_idx',
          'auth_browser_transitions_current_family_idx',
          'sso_token_exchange_grants_expires_idx',
          'sso_token_exchange_grants_transition_idx'
        )
    `;
    expect(indexes.map((row) => row.indexname).sort()).toEqual([
      'auth_browser_transitions_current_family_idx',
      'auth_browser_transitions_logout_expires_idx',
      'sso_token_exchange_grants_expires_idx',
      'sso_token_exchange_grants_transition_idx',
    ]);

    const grantColumns = columns
      .filter((row) => row.table_name === 'sso_token_exchange_grants')
      .map((row) => row.column_name);
    expect(grantColumns).toContain('code_digest');
    expect(grantColumns).not.toContain('code');
  });

  it('reapplies the migration twice without changing the catalog contract', async () => {
    expect(migrationSql).not.toBe('');
    await admin!.unsafe(migrationSql);
    const before = await admin!`
      SELECT count(*)::int AS count
      FROM pg_constraint
      WHERE conname LIKE 'auth_browser_transitions_%'
         OR conname LIKE 'sso_token_exchange_grants_%'
         OR conname = 'sso_sessions_browser_transition_generation_fk'
         OR conname = 'sso_sessions_browser_transition_pair_chk'
    `;
    await admin!.unsafe(migrationSql);
    const after = await admin!`
      SELECT count(*)::int AS count
      FROM pg_constraint
      WHERE conname LIKE 'auth_browser_transitions_%'
         OR conname LIKE 'sso_token_exchange_grants_%'
         OR conname = 'sso_sessions_browser_transition_generation_fk'
         OR conname = 'sso_sessions_browser_transition_pair_chk'
    `;
    expect(after).toEqual(before);
  });

  it('denies non-system SELECT, INSERT, and UPDATE while system scope succeeds', async () => {
    const suffix = randomUUID();
    const partnerId = randomUUID();
    const userId = randomUUID();
    const familyId = randomUUID();
    const transitionId = randomUUID();
    const grantId = randomUUID();

    await admin!`
      INSERT INTO partners (id, name, slug)
      VALUES (${partnerId}, 'Browser transition RLS fixture', ${`browser-transition-${suffix}`})
    `;
    await admin!`
      INSERT INTO users (id, partner_id, email, name, status)
      VALUES (${userId}, ${partnerId}, ${`browser-transition-${suffix}@example.test`}, 'Browser transition fixture', 'active')
    `;
    await admin!`
      INSERT INTO refresh_token_families (family_id, user_id, absolute_expires_at)
      VALUES (${familyId}, ${userId}, now() + interval '1 day')
    `;

    try {
      await app!.begin(async (sql) => {
        await sql`SELECT set_config('breeze.scope', 'system', true)`;
        await sql`
          INSERT INTO auth_browser_transitions
            (id, binding_digest, current_user_id, current_family_id)
          VALUES (${transitionId}, ${'a'.repeat(64)}, ${userId}, ${familyId})
        `;
        await sql`
          INSERT INTO sso_token_exchange_grants
            (id, code_digest, browser_transition_id, browser_generation, user_id, family_id, expires_at)
          VALUES (${grantId}, ${'b'.repeat(64)}, ${transitionId}, 1, ${userId}, ${familyId}, now() + interval '5 minutes')
        `;
      });

      const systemRows = await app!.begin(async (sql) => {
        await sql`SELECT set_config('breeze.scope', 'system', true)`;
        await sql`
          UPDATE auth_browser_transitions
          SET updated_at = now()
          WHERE id = ${transitionId}
        `;
        await sql`
          UPDATE sso_token_exchange_grants
          SET consumed_at = NULL
          WHERE id = ${grantId}
        `;
        return sql`
          SELECT 'transition' AS kind, id FROM auth_browser_transitions WHERE id = ${transitionId}
          UNION ALL
          SELECT 'grant' AS kind, id FROM sso_token_exchange_grants WHERE id = ${grantId}
        `;
      });
      expect(systemRows).toHaveLength(2);

      const tenantRows = await app!.begin(async (sql) => {
        await sql`SELECT set_config('breeze.scope', 'organization', true)`;
        return sql`
          SELECT 'transition' AS kind, id FROM auth_browser_transitions WHERE id = ${transitionId}
          UNION ALL
          SELECT 'grant' AS kind, id FROM sso_token_exchange_grants WHERE id = ${grantId}
        `;
      });
      expect(tenantRows).toEqual([]);

      await expect(
        app!.begin(async (sql) => {
          await sql`SELECT set_config('breeze.scope', 'organization', true)`;
          await sql`
            INSERT INTO auth_browser_transitions (binding_digest)
            VALUES (${'c'.repeat(64)})
          `;
        }),
      ).rejects.toThrow(/row-level security|permission denied/i);

      await expect(
        app!.begin(async (sql) => {
          await sql`SELECT set_config('breeze.scope', 'organization', true)`;
          await sql`
            INSERT INTO sso_token_exchange_grants
              (code_digest, browser_transition_id, browser_generation, user_id, family_id, expires_at)
            VALUES (${'d'.repeat(64)}, ${transitionId}, 1, ${userId}, ${familyId}, now() + interval '5 minutes')
          `;
        }),
      ).rejects.toThrow(/row-level security|permission denied/i);

      const tenantUpdated = await app!.begin(async (sql) => {
        await sql`SELECT set_config('breeze.scope', 'organization', true)`;
        const transitions = await sql`
          UPDATE auth_browser_transitions
          SET updated_at = now()
          WHERE id = ${transitionId}
          RETURNING id
        `;
        const grants = await sql`
          UPDATE sso_token_exchange_grants
          SET consumed_at = now()
          WHERE id = ${grantId}
          RETURNING id
        `;
        return { transitions, grants };
      });
      expect(tenantUpdated).toEqual({ transitions: [], grants: [] });
    } finally {
      await admin!`DELETE FROM sso_token_exchange_grants WHERE id = ${grantId}`;
      await admin!`DELETE FROM auth_browser_transitions WHERE id = ${transitionId}`;
      await admin!`DELETE FROM refresh_token_families WHERE family_id = ${familyId}`;
      await admin!`DELETE FROM users WHERE id = ${userId}`;
      await admin!`DELETE FROM partners WHERE id = ${partnerId}`;
    }
  });
});
