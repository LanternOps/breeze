/**
 * Live-Postgres proof for 2026-12-31-170000-m365-consent-sessions-v2-only.sql
 * (#7910 W04).
 *
 * setup.ts has already applied every migration, so the case rewinds the table
 * to its W02 state inside one transaction (W02's flow_version IN (1, 2) CHECK,
 * its three-branch phase/field CHECK, DEFAULT 1), seeds legacy and current
 * rows, replays the real W04 file and rolls everything back.
 *
 * The test connection is a superuser and owns the table, so it bypasses even
 * FORCE ROW LEVEL SECURITY. The cleanup DO block is therefore first run on its
 * own, inside a rolled-back savepoint, as the RLS-bound breeze_app role at the
 * default ('none') scope: only the block's own system-scope election lets its
 * DELETE see the rows. The whole file then runs as the owner against the still
 * populated table (the deploy path), and once more to prove it is idempotent.
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/m365ConsentSessionsV2OnlyMigration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const migration = (name: string) => readFileSync(
  new URL(`../../../migrations/${name}`, import.meta.url),
  'utf8',
);
const W02_SQL = migration('2026-12-06-090000-m365-consent-identity-first.sql');
const W04_SQL = migration('2026-12-31-170000-m365-consent-sessions-v2-only.sql');
const W04_CLEANUP_BLOCK = (() => {
  const match = /DO \$\$[\s\S]*?END \$\$;/.exec(W04_SQL);
  if (!match) throw new Error('W04 migration has no cleanup DO block');
  return match[0];
})();

const runDb = it.runIf(!!process.env.DATABASE_URL);

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '55555555-5555-4555-8555-555555555555';

class Rollback extends Error {}

async function seedConnection() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `m365-v2-only-${randomUUID()}@example.com`,
    });
    const consentAttemptId = randomUUID();
    const [connection] = await db.insert(m365Connections).values({
      orgId: org.id,
      userId: null,
      tenantId: null,
      consentAttemptId,
      clientId: '33333333-3333-4333-8333-333333333333',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: 'akv://vault.example/graph-read/0123456789abcdef0123456789abcdef',
      credentialVersion: '0123456789abcdef0123456789abcdef',
      permissionManifestVersion: 2,
      observedGrants: [],
      status: 'pending-consent',
    }).returning({ id: m365Connections.id });
    return { orgId: org.id, userId: user.id, connectionId: connection!.id, consentAttemptId };
  });
}

describe('m365_consent_sessions v2-only migration (#7910 W04)', () => {
  runDb('deletes pre-seeded v1 rows under forced RLS with a count warning, keeps v2 rows, and tightens the table', async () => {
    const fx = await seedConnection();
    const notices: string[] = [];
    const client = postgres(process.env.DATABASE_URL!, {
      max: 1,
      onnotice: (notice) => { notices.push(`${notice.severity}: ${notice.message}`); },
    });
    const observed: Record<string, unknown> = {};
    try {
      await client.begin(async (tx) => {
        // Rewind to the W02 layout. W02 only adds flow_version_check when it is
        // absent, so drop the W04 one first; it re-creates phase_fields_check
        // unconditionally. The column DEFAULT is restored by hand.
        await tx.unsafe('ALTER TABLE m365_consent_sessions DROP CONSTRAINT IF EXISTS m365_consent_sessions_flow_version_check');
        await tx.unsafe(W02_SQL);
        await tx.unsafe('ALTER TABLE m365_consent_sessions ALTER COLUMN flow_version SET DEFAULT 1');

        const owner = [fx.connectionId, fx.orgId, 'customer-graph-read', fx.consentAttemptId, fx.userId] as const;
        // Both v1 layouts the W02 CHECK admitted, plus one live v2 row.
        await tx`
          INSERT INTO m365_consent_sessions
            (state_hash, phase, connection_id, org_id, profile, consent_attempt_id, user_id, expires_at)
          VALUES (${'1'.repeat(64)}, 'admin_consent', ${owner[0]}, ${owner[1]}, ${owner[2]}, ${owner[3]}, ${owner[4]},
                  now() - interval '1 day')`;
        await tx`
          INSERT INTO m365_consent_sessions
            (state_hash, phase, connection_id, org_id, profile, consent_attempt_id, user_id, expires_at,
             tenant_hint_hash, nonce, code_verifier)
          VALUES (${'2'.repeat(64)}, 'identity_verification', ${owner[0]}, ${owner[1]}, ${owner[2]}, ${owner[3]},
                  ${owner[4]}, now() - interval '1 day', ${'a'.repeat(64)}, 'n', ${'v'.repeat(43)})`;
        await tx`
          INSERT INTO m365_consent_sessions
            (state_hash, phase, flow_version, connection_id, org_id, profile, consent_attempt_id, user_id, expires_at,
             verified_tenant_id, verified_admin_object_id, identity_verified_at)
          VALUES (${'3'.repeat(64)}, 'admin_consent', 2, ${owner[0]}, ${owner[1]}, ${owner[2]}, ${owner[3]},
                  ${owner[4]}, now() + interval '10 minutes', ${TENANT}, ${ADMIN}, now())`;
        observed.seededFlowVersions = (await tx`
          SELECT flow_version FROM m365_consent_sessions WHERE connection_id = ${fx.connectionId} ORDER BY state_hash
        `).map((row) => row.flow_version);

        // The cleanup block alone, as the RLS-bound app role at default scope,
        // inside a savepoint that is then rolled back so the v1 rows survive.
        await tx.savepoint(async (sp) => {
          await sp.unsafe("SELECT set_config('breeze.scope', 'none', true)");
          await sp.unsafe('SET LOCAL ROLE breeze_app');
          await sp.unsafe(W04_CLEANUP_BLOCK);
          await sp.unsafe('RESET ROLE');
          observed.afterCleanup = (await sp`
            SELECT state_hash, flow_version FROM m365_consent_sessions WHERE connection_id = ${fx.connectionId}
          `).map((row) => ({ stateHash: row.state_hash, flowVersion: row.flow_version }));
          throw new Rollback();
        }).catch((error: unknown) => { if (!(error instanceof Rollback)) throw error; });
        observed.beforeFullRun = (await tx`
          SELECT flow_version FROM m365_consent_sessions WHERE connection_id = ${fx.connectionId} ORDER BY state_hash
        `).map((row) => row.flow_version);

        // The full file as deployed (owner, table still holding v1 rows), then
        // again: re-applying must be a no-op.
        await tx.unsafe(W04_SQL);
        observed.afterFullRun = (await tx`
          SELECT state_hash, flow_version FROM m365_consent_sessions WHERE connection_id = ${fx.connectionId}
        `).map((row) => ({ stateHash: row.state_hash, flowVersion: row.flow_version }));
        await tx.unsafe(W04_SQL);

        observed.flowVersionCheck = (await tx`
          SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conname = 'm365_consent_sessions_flow_version_check'
             AND conrelid = 'public.m365_consent_sessions'::regclass
        `).map((row) => row.def);
        observed.phaseFieldsCheck = (await tx`
          SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conname = 'm365_consent_sessions_phase_fields_check'
             AND conrelid = 'public.m365_consent_sessions'::regclass
        `).map((row) => row.def);
        observed.columnDefault = (await tx`
          SELECT column_default FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'm365_consent_sessions' AND column_name = 'flow_version'
        `).map((row) => row.column_default);

        // A v1 row can no longer be written.
        observed.v1InsertError = await tx.savepoint((sp) => sp`
          INSERT INTO m365_consent_sessions
            (state_hash, phase, flow_version, connection_id, org_id, profile, consent_attempt_id, user_id, expires_at)
          VALUES (${'4'.repeat(64)}, 'admin_consent', 1, ${owner[0]}, ${owner[1]}, ${owner[2]}, ${owner[3]},
                  ${owner[4]}, now() + interval '10 minutes')
        `).then(() => null, (error: { code?: string; constraint_name?: string }) => ({
          code: error.code, constraint: error.constraint_name,
        }));

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    } finally {
      await client.end();
    }

    expect(observed.seededFlowVersions).toEqual([1, 1, 2]);
    // The RLS-bound cleanup saw both v1 rows (its own system-scope election)...
    expect(observed.afterCleanup).toEqual([{ stateHash: '3'.repeat(64), flowVersion: 2 }]);
    // ...and was rolled back, so the full run started from a populated table.
    expect(observed.beforeFullRun).toEqual([1, 1, 2]);
    expect(observed.afterFullRun).toEqual([{ stateHash: '3'.repeat(64), flowVersion: 2 }]);
    // One count warning per run that found rows; the re-apply stayed silent.
    expect(notices.filter((n) => /legacy m365_consent_sessions rows/.test(n))).toEqual([
      'WARNING: cleaned 2 legacy m365_consent_sessions rows',
      'WARNING: cleaned 2 legacy m365_consent_sessions rows',
    ]);
    expect(observed.flowVersionCheck).toEqual(['CHECK ((flow_version = 2))']);
    expect(observed.phaseFieldsCheck).toHaveLength(1);
    expect(String((observed.phaseFieldsCheck as string[])[0])).not.toMatch(/flow_version = 1/);
    expect(observed.columnDefault).toEqual(['2']);
    expect(observed.v1InsertError).toEqual({
      code: '23514', constraint: 'm365_consent_sessions_flow_version_check',
    });
  });
});
