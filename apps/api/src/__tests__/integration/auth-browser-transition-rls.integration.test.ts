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

  it('keeps rollout columns nullable and binds SSO state to a transition ID', () => {
    expect(refreshFamilySchema).toContain(
      "currentRefreshJtiDigest: varchar('current_refresh_jti_digest', { length: 64 })",
    );
    expect(refreshFamilySchema).not.toContain(
      "currentRefreshJtiDigest: varchar('current_refresh_jti_digest', { length: 64 }).notNull()",
    );
    expect(ssoSchema).toContain("browserTransitionId: uuid('browser_transition_id')");
    expect(ssoSchema).toContain("browserGeneration: bigint('browser_generation', { mode: 'number' })");
    expect(ssoSchema).toContain('sso_sessions_browser_transition_fk');
    expect(ssoSchema).not.toContain('sso_sessions_browser_transition_generation_fk');
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
    expect(migrationSql).not.toMatch(/ON UPDATE CASCADE/i);
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
      SELECT conname, pg_get_constraintdef(oid, true) AS definition
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
        'sso_token_exchange_grants_transition_fk',
        'sso_token_exchange_grants_family_owner_fk',
        'sso_sessions_browser_transition_fk',
        'sso_sessions_browser_transition_pair_chk',
        'sso_sessions_browser_generation_chk',
      ]),
    );
    expect(
      constraints.find((row) => row.conname === 'sso_sessions_browser_transition_fk')?.definition,
    ).toMatch(/^FOREIGN KEY \(browser_transition_id\) REFERENCES auth_browser_transitions\(id\)$/);
    expect(
      constraints.find((row) => row.conname === 'sso_token_exchange_grants_transition_fk')?.definition,
    ).toMatch(/^FOREIGN KEY \(browser_transition_id\) REFERENCES auth_browser_transitions\(id\)$/);

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
    async function catalogSnapshot() {
      const [columns, constraints, indexes, policies, rls] = await Promise.all([
        admin!`
          SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN (
              'auth_browser_transitions',
              'sso_token_exchange_grants',
              'sso_sessions',
              'refresh_token_families'
            )
          ORDER BY table_name, ordinal_position
        `,
        admin!`
          SELECT conrelid::regclass::text AS table_name,
                 conname,
                 pg_get_constraintdef(oid, true) AS definition
          FROM pg_constraint
          WHERE conrelid IN (
            'auth_browser_transitions'::regclass,
            'sso_token_exchange_grants'::regclass,
            'sso_sessions'::regclass,
            'refresh_token_families'::regclass
          )
          ORDER BY table_name, conname
        `,
        admin!`
          SELECT tablename, indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename IN (
              'auth_browser_transitions',
              'sso_token_exchange_grants',
              'sso_sessions',
              'refresh_token_families'
            )
          ORDER BY tablename, indexname
        `,
        admin!`
          SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename IN ('auth_browser_transitions', 'sso_token_exchange_grants')
          ORDER BY tablename, policyname
        `,
        admin!`
          SELECT relname, relrowsecurity, relforcerowsecurity
          FROM pg_class
          WHERE relname IN ('auth_browser_transitions', 'sso_token_exchange_grants')
          ORDER BY relname
        `,
      ]);
      return { columns, constraints, indexes, policies, rls };
    }

    expect(migrationSql).not.toBe('');
    await admin!.unsafe(migrationSql);
    const before = await catalogSnapshot();
    await admin!.unsafe(migrationSql);
    const after = await catalogSnapshot();
    expect(after).toEqual(before);
  });

  it('advances a transition generation while SSO children retain their admitted generation', async () => {
    const suffix = randomUUID();
    const partnerId = randomUUID();
    const userId = randomUUID();
    const familyId = randomUUID();
    const providerId = randomUUID();
    const transitionId = randomUUID();
    const sessionId = randomUUID();
    const grantId = randomUUID();

    await admin!`
      INSERT INTO partners (id, name, slug)
      VALUES (${partnerId}, 'Generation advance fixture', ${`generation-advance-${suffix}`})
    `;
    await admin!`
      INSERT INTO users (id, partner_id, email, name, status)
      VALUES (${userId}, ${partnerId}, ${`generation-advance-${suffix}@example.test`}, 'Generation fixture', 'active')
    `;
    await admin!`
      INSERT INTO refresh_token_families (family_id, user_id, absolute_expires_at)
      VALUES (${familyId}, ${userId}, now() + interval '1 day')
    `;
    await admin!`
      INSERT INTO sso_providers (id, partner_id, name, type, status)
      VALUES (${providerId}, ${partnerId}, 'Generation fixture', 'oidc', 'active')
    `;

    try {
      await app!.begin(async (sql) => {
        await sql`SELECT set_config('breeze.scope', 'system', true)`;
        await sql`
          INSERT INTO auth_browser_transitions (id, binding_digest)
          VALUES (${transitionId}, ${'1'.repeat(64)})
        `;
      });
      await expect(app!.begin(async (sql) => {
        await sql`SELECT set_config('breeze.scope', 'system', true)`;
        await sql`
          INSERT INTO sso_sessions
            (provider_id, state, nonce, browser_transition_id, browser_generation, expires_at)
          VALUES (${providerId}, ${`invalid-state-${suffix}`}, ${`invalid-nonce-${suffix}`}, ${transitionId}, 0, now() + interval '5 minutes')
        `;
      })).rejects.toThrow(/sso_sessions_browser_generation_chk/);

      const result = await app!.begin(async (sql) => {
        await sql`SELECT set_config('breeze.scope', 'system', true)`;
        await sql`
          INSERT INTO sso_sessions
            (id, provider_id, state, nonce, browser_transition_id, browser_generation, expires_at)
          VALUES (${sessionId}, ${providerId}, ${`state-${suffix}`}, ${`nonce-${suffix}`}, ${transitionId}, 1, now() + interval '5 minutes')
        `;
        await sql`
          INSERT INTO sso_token_exchange_grants
            (id, code_digest, browser_transition_id, browser_generation, user_id, family_id, expires_at)
          VALUES (${grantId}, ${'2'.repeat(64)}, ${transitionId}, 1, ${userId}, ${familyId}, now() + interval '5 minutes')
        `;

        const [transition] = await sql`
          UPDATE auth_browser_transitions
          SET generation = 2, updated_at = now()
          WHERE id = ${transitionId}
          RETURNING generation
        `;
        const [session] = await sql`
          SELECT browser_generation FROM sso_sessions WHERE id = ${sessionId}
        `;
        const [grant] = await sql`
          SELECT browser_generation FROM sso_token_exchange_grants WHERE id = ${grantId}
        `;
        return { transition, session, grant };
      });

      expect(result.transition?.generation).toBe('2');
      expect(result.session?.browser_generation).toBe('1');
      expect(result.grant?.browser_generation).toBe('1');
    } finally {
      await admin!`DELETE FROM sso_token_exchange_grants WHERE id = ${grantId}`;
      await admin!`DELETE FROM sso_sessions WHERE id = ${sessionId}`;
      await admin!`DELETE FROM auth_browser_transitions WHERE id = ${transitionId}`;
      await admin!`DELETE FROM sso_providers WHERE id = ${providerId}`;
      await admin!`DELETE FROM refresh_token_families WHERE family_id = ${familyId}`;
      await admin!`DELETE FROM users WHERE id = ${userId}`;
      await admin!`DELETE FROM partners WHERE id = ${partnerId}`;
    }
  });

  it('enforces transition and grant coherence constraints behaviorally', async () => {
    const suffix = randomUUID();
    const partnerId = randomUUID();
    const userAId = randomUUID();
    const userBId = randomUUID();
    const familyAId = randomUUID();
    const familyBId = randomUUID();
    const transitionId = randomUUID();
    const validGrantId = randomUUID();

    await admin!`
      INSERT INTO partners (id, name, slug)
      VALUES (${partnerId}, 'Constraint fixture', ${`constraint-fixture-${suffix}`})
    `;
    await admin!`
      INSERT INTO users (id, partner_id, email, name, status)
      VALUES
        (${userAId}, ${partnerId}, ${`constraint-a-${suffix}@example.test`}, 'Constraint A', 'active'),
        (${userBId}, ${partnerId}, ${`constraint-b-${suffix}@example.test`}, 'Constraint B', 'active')
    `;
    await admin!`
      INSERT INTO refresh_token_families (family_id, user_id, absolute_expires_at)
      VALUES
        (${familyAId}, ${userAId}, now() + interval '1 day'),
        (${familyBId}, ${userBId}, now() + interval '1 day')
    `;

    const systemStatement = async (statement: (sql: postgres.TransactionSql) => Promise<unknown>) =>
      app!.begin(async (sql) => {
        await sql`SELECT set_config('breeze.scope', 'system', true)`;
        return statement(sql);
      });

    try {
      await expect(systemStatement((sql) => sql`
        INSERT INTO auth_browser_transitions (binding_digest, logout_id)
        VALUES (${'3'.repeat(64)}, ${randomUUID()})
      `)).rejects.toThrow(/auth_browser_transitions_state_chk/);

      await expect(systemStatement((sql) => sql`
        INSERT INTO auth_browser_transitions (binding_digest, active_operation_id)
        VALUES (${'4'.repeat(64)}, ${randomUUID()})
      `)).rejects.toThrow(/auth_browser_transitions_operation_pair_chk/);

      await expect(systemStatement((sql) => sql`
        INSERT INTO auth_browser_transitions
          (binding_digest, current_user_id, current_family_id)
        VALUES (${'5'.repeat(64)}, ${userAId}, ${familyBId})
      `)).rejects.toThrow(/auth_browser_transitions_current_family_owner_fk/);

      await systemStatement((sql) => sql`
        INSERT INTO auth_browser_transitions
          (id, binding_digest, current_user_id, current_family_id,
           active_operation_id, active_operation_expires_at)
        VALUES (${transitionId}, ${'6'.repeat(64)}, ${userAId}, ${familyAId},
                ${randomUUID()}, now() + interval '1 minute')
      `);

      await expect(systemStatement((sql) => sql`
        INSERT INTO sso_token_exchange_grants
          (code_digest, browser_transition_id, browser_generation, user_id, family_id, expires_at)
        VALUES (${'7'.repeat(64)}, ${transitionId}, 1, ${userAId}, ${familyAId}, now() - interval '1 minute')
      `)).rejects.toThrow(/sso_token_exchange_grants_lifecycle_chk/);

      await expect(systemStatement((sql) => sql`
        INSERT INTO sso_token_exchange_grants
          (code_digest, browser_transition_id, browser_generation, user_id, family_id, expires_at)
        VALUES (${'8'.repeat(64)}, ${transitionId}, 1, ${userAId}, ${familyBId}, now() + interval '1 minute')
      `)).rejects.toThrow(/sso_token_exchange_grants_family_owner_fk/);

      await systemStatement((sql) => sql`
        INSERT INTO sso_token_exchange_grants
          (id, code_digest, browser_transition_id, browser_generation, user_id, family_id, expires_at)
        VALUES (${validGrantId}, ${'9'.repeat(64)}, ${transitionId}, 1, ${userAId}, ${familyAId}, now() + interval '1 minute')
      `);
    } finally {
      await admin!`DELETE FROM sso_token_exchange_grants WHERE id = ${validGrantId}`;
      await admin!`DELETE FROM auth_browser_transitions WHERE id = ${transitionId}`;
      await admin!`DELETE FROM refresh_token_families WHERE family_id IN (${familyAId}, ${familyBId})`;
      await admin!`DELETE FROM users WHERE id IN (${userAId}, ${userBId})`;
      await admin!`DELETE FROM partners WHERE id = ${partnerId}`;
    }
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
