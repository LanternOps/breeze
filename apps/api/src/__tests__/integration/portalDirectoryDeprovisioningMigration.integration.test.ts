/**
 * Portal registration W8 (#11385): directory deprovisioning schema
 * (2027-01-24-200000-portal-directory-deprovisioning.sql; plan Task 1, D1/D2/D12).
 *
 * Every case runs inside ONE superuser postgres.js transaction that is always
 * rolled back, and (unless it rebuilds the pre-W8 shape itself) replays the
 * migration first, so a missing file fails every case (template:
 * portalGoogleRequestMigration.integration.test.ts). The CI database is
 * migrated schema-fresh, so the disabled_by backfill otherwise runs against
 * zero rows: the backfill case drops the column inside the transaction, seeds
 * pre-W8 rows, and replays.
 *
 * Cross-org RLS invisibility as breeze_app lives in rls-coverage.integration.test.ts.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalDirectoryDeprovisioningMigration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';

const MIGRATION = '2027-01-24-200000-portal-directory-deprovisioning.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const GOOGLE_ISSUER = 'https://accounts.google.com';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
type PgError = { code?: string; constraint_name?: string };
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');

async function inRolledBackTx(
  body: (tx: Tx, notices: string[]) => Promise<void>,
  opts: { replayFirst?: boolean } = {},
): Promise<void> {
  const notices: string[] = [];
  const client = postgres(DATABASE_URL, {
    max: 1,
    onnotice: (n) => { notices.push(`${n.severity}: ${n.message}`); },
  });
  try {
    await client.begin(async (tx) => {
      if (opts.replayFirst !== false) await (tx as unknown as Tx).unsafe(await loadMigration());
      await body(tx as unknown as Tx, notices);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

/** Runs one statement inside a savepoint so a deliberate failure does not abort the outer tx. */
async function pgErrorOf(tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<PgError> {
  try {
    await tx.savepoint(async (sp) => { await fn(sp as unknown as Tx); });
  } catch (error) {
    return error as PgError;
  }
  throw new Error('expected the statement to fail');
}

async function newOrgId(): Promise<string> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return org.id;
}

async function seedAccount(
  tx: Tx,
  orgId: string,
  opts: { status?: 'invited' | 'active' | 'disabled'; disabledBy?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  const status = opts.status ?? 'active';
  const disabledBy = opts.disabledBy === undefined ? (status === 'disabled' ? 'msp' : null) : opts.disabledBy;
  await tx`
    INSERT INTO portal_users (id, org_id, email, auth_method, status, browser_access, disabled_by)
    VALUES (${id}, ${orgId}, ${`${id}@w8-migration.example.com`}, 'password', ${status}, 'granted', ${disabledBy})`;
  return id;
}

async function seedIdentity(tx: Tx, orgId: string, portalUserId: string): Promise<string> {
  const id = randomUUID();
  await tx`
    INSERT INTO portal_user_identities (id, org_id, portal_user_id, provider, issuer, subject, linked_via)
    VALUES (${id}, ${orgId}, ${portalUserId}, 'google', ${GOOGLE_ISSUER}, ${`sub-${id}`}, 'jit')`;
  return id;
}

async function seedRun(tx: Tx, orgId: string): Promise<string> {
  const id = randomUUID();
  await tx`
    INSERT INTO portal_directory_runs (id, org_id, source, chain_key, snapshot_key, snapshot_at, outcome, mode, disposition)
    VALUES (${id}, ${orgId}, 'google', ${`${orgId}:conn`}, ${`conn-${id}:2027-01-24`}, now(), 'evaluated', 'report', 'reported')`;
  return id;
}

const insertAction = (
  tx: Tx,
  row: { orgId: string; runId: string; identityId: string; portalUserId: string },
) => tx`
  INSERT INTO portal_directory_actions (org_id, run_id, identity_id, portal_user_id, provider, reason, effect, status)
  VALUES (${row.orgId}, ${row.runId}, ${row.identityId}, ${row.portalUserId}, 'google', 'suspended', 'identity', 'reported')`;

/** One org with an account, its identity, a run and an action on it. */
async function seedChain(tx: Tx, orgId: string) {
  const portalUserId = await seedAccount(tx, orgId);
  const identityId = await seedIdentity(tx, orgId, portalUserId);
  const runId = await seedRun(tx, orgId);
  await insertAction(tx, { orgId, runId, identityId, portalUserId });
  const [action] = await tx<{ id: string }[]>`
    SELECT id FROM portal_directory_actions WHERE run_id = ${runId} AND identity_id = ${identityId}`;
  return { portalUserId, identityId, runId, actionId: action!.id };
}

async function statusConstraint(tx: Tx) {
  const [row] = await tx<{ convalidated: boolean }[]>`
    SELECT convalidated FROM pg_constraint
     WHERE conrelid = 'public.portal_users'::regclass AND conname = 'portal_users_disabled_by_status_chk'`;
  return row;
}

describe('2027-01-24-200000-portal-directory-deprovisioning.sql', () => {
  it('starts with the system-scope line and has no BEGIN/COMMIT', async () => {
    const text = await loadMigration();
    const firstStatement = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('--'));
    expect(firstStatement).toBe("SELECT set_config('breeze.scope', 'system', true);");
    const code = text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('is idempotent: applying it twice succeeds and changes nothing', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      const chain = await seedChain(tx, orgId);
      const disabled = await seedAccount(tx, orgId, { status: 'disabled', disabledBy: 'directory' });
      const snapshot = async () => ({
        constraints: await tx`
          SELECT conrelid::regclass::text AS tbl, conname, convalidated, condeferrable, condeferred
            FROM pg_constraint
           WHERE conrelid IN ('public.portal_users'::regclass, 'public.portal_user_identities'::regclass,
                              'public.portal_directory_runs'::regclass, 'public.portal_directory_actions'::regclass)
           ORDER BY 1, 2`,
        policies: await tx`
          SELECT tablename, policyname, cmd FROM pg_policies
           WHERE tablename IN ('portal_directory_runs', 'portal_directory_actions') ORDER BY 1, 2`,
        indexes: await tx`
          SELECT indexname FROM pg_indexes
           WHERE tablename IN ('portal_user_identities', 'portal_directory_runs', 'portal_directory_actions') ORDER BY 1`,
        accounts: await tx`SELECT id, status, disabled_by FROM portal_users WHERE id IN (${chain.portalUserId}, ${disabled}) ORDER BY id`,
        actions: await tx`SELECT id FROM portal_directory_actions WHERE org_id = ${orgId}`,
      });
      const first = await snapshot();
      expect((await statusConstraint(tx))?.convalidated).toBe(true);
      await tx.unsafe(await loadMigration());
      expect(await snapshot()).toEqual(first);
    });
  });

  it('backfills disabled_by = msp for every disabled portal user and validates the status constraint', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx, notices) => {
      // The pre-W8 world: no disabled_by column (its two CHECKs go with it).
      await tx.unsafe('ALTER TABLE public.portal_users DROP COLUMN IF EXISTS disabled_by CASCADE');
      const ids: Record<'disabledA' | 'disabledB' | 'active' | 'invited', string> = {
        disabledA: randomUUID(), disabledB: randomUUID(), active: randomUUID(), invited: randomUUID(),
      };
      const statusOf = { disabledA: 'disabled', disabledB: 'disabled', active: 'active', invited: 'invited' } as const;
      for (const [key, id] of Object.entries(ids) as Array<[keyof typeof ids, string]>) {
        await tx`
          INSERT INTO portal_users (id, org_id, email, auth_method, status, browser_access)
          VALUES (${id}, ${orgId}, ${`${id}@w8-backfill.example.com`}, 'password', ${statusOf[key]}, 'granted')`;
      }
      await tx.unsafe(await loadMigration());

      const rows = await tx<{ id: string; disabled_by: string | null }[]>`
        SELECT id, disabled_by FROM portal_users WHERE org_id = ${orgId}`;
      const by = Object.fromEntries(rows.map((r) => [r.id, r.disabled_by]));
      expect(by[ids.disabledA]).toBe('msp');
      expect(by[ids.disabledB]).toBe('msp');
      expect(by[ids.active]).toBeNull();
      expect(by[ids.invited]).toBeNull();
      expect((await statusConstraint(tx))?.convalidated).toBe(true);
      expect(notices.some((n) => /backfilled disabled_by = msp on \d+ disabled account/.test(n))).toBe(true);
    }, { replayFirst: false });
  });

  it('refuses a half-set disabled state, an unknown blocker or reason (23514)', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      const portalUserId = await seedAccount(tx, orgId);
      const identityId = await seedIdentity(tx, orgId, portalUserId);
      // disabled_at without a blocker or a reason.
      expect(await pgErrorOf(tx, (sp) => sp`
        UPDATE portal_user_identities SET disabled_at = now() WHERE id = ${identityId}`))
        .toMatchObject({ code: '23514', constraint_name: 'portal_user_identities_disabled_chk' });
      // A blocker without disabled_at.
      expect(await pgErrorOf(tx, (sp) => sp`
        UPDATE portal_user_identities SET disabled_blockers = ARRAY['google_directory']::text[], disabled_reason = 'suspended'
         WHERE id = ${identityId}`))
        .toMatchObject({ code: '23514', constraint_name: 'portal_user_identities_disabled_chk' });
      // disabled_at + blocker, but no reason.
      expect(await pgErrorOf(tx, (sp) => sp`
        UPDATE portal_user_identities SET disabled_at = now(), disabled_blockers = ARRAY['google_directory']::text[]
         WHERE id = ${identityId}`))
        .toMatchObject({ code: '23514', constraint_name: 'portal_user_identities_disabled_chk' });
      // An unknown blocker.
      expect(await pgErrorOf(tx, (sp) => sp`
        UPDATE portal_user_identities
           SET disabled_at = now(), disabled_blockers = ARRAY['okta']::text[], disabled_reason = 'absent'
         WHERE id = ${identityId}`))
        .toMatchObject({ code: '23514', constraint_name: 'portal_user_identities_blockers_chk' });
      // An unknown reason.
      expect(await pgErrorOf(tx, (sp) => sp`
        UPDATE portal_user_identities
           SET disabled_at = now(), disabled_blockers = ARRAY['google_directory']::text[], disabled_reason = 'deleted'
         WHERE id = ${identityId}`))
        .toMatchObject({ code: '23514', constraint_name: 'portal_user_identities_disabled_reason_chk' });
      // A negative absence counter.
      expect(await pgErrorOf(tx, (sp) => sp`
        UPDATE portal_user_identities SET directory_absent_runs = -1 WHERE id = ${identityId}`))
        .toMatchObject({ code: '23514', constraint_name: 'portal_user_identities_absent_runs_chk' });

      // A fully-set disabled state with two blockers is accepted, and clears back.
      await tx`
        UPDATE portal_user_identities
           SET disabled_at = now(), disabled_blockers = ARRAY['google_directory','scim']::text[], disabled_reason = 'suspended'
         WHERE id = ${identityId}`;
      await tx`
        UPDATE portal_user_identities SET disabled_at = NULL, disabled_blockers = '{}', disabled_reason = NULL
         WHERE id = ${identityId}`;
    });
  });

  it('refuses a disabled portal user without disabled_by and an active one with it', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      expect(await pgErrorOf(tx, (sp) => seedAccount(sp, orgId, { status: 'disabled', disabledBy: null })))
        .toMatchObject({ code: '23514', constraint_name: 'portal_users_disabled_by_status_chk' });
      expect(await pgErrorOf(tx, (sp) => seedAccount(sp, orgId, { status: 'active', disabledBy: 'msp' })))
        .toMatchObject({ code: '23514', constraint_name: 'portal_users_disabled_by_status_chk' });
      expect(await pgErrorOf(tx, (sp) => seedAccount(sp, orgId, { status: 'disabled', disabledBy: 'okta' })))
        .toMatchObject({ code: '23514', constraint_name: 'portal_users_disabled_by_chk' });
      for (const disabledBy of ['msp', 'directory', 'scim']) {
        await seedAccount(tx, orgId, { status: 'disabled', disabledBy });
      }
    });
  });

  it('portal_directory_actions refuses an identity or account from another org (composite FK)', async () => {
    const orgA = await newOrgId();
    const orgB = await newOrgId();
    await inRolledBackTx(async (tx) => {
      const a = await seedChain(tx, orgA);
      const bUser = await seedAccount(tx, orgB);
      const bIdentity = await seedIdentity(tx, orgB, bUser);
      const bRun = await seedRun(tx, orgB);

      // Org A's action naming org B's identity.
      expect(await pgErrorOf(tx, (sp) => insertAction(sp, {
        orgId: orgA, runId: a.runId, identityId: bIdentity, portalUserId: a.portalUserId,
      }))).toMatchObject({ code: '23503', constraint_name: 'portal_directory_actions_identity_fk' });
      // Org A's action naming org B's account.
      const aIdentity2 = await seedIdentity(tx, orgA, await seedAccount(tx, orgA));
      expect(await pgErrorOf(tx, (sp) => insertAction(sp, {
        orgId: orgA, runId: a.runId, identityId: aIdentity2, portalUserId: bUser,
      }))).toMatchObject({ code: '23503', constraint_name: 'portal_directory_actions_user_fk' });
      // Org A's action naming org B's run.
      expect(await pgErrorOf(tx, (sp) => insertAction(sp, {
        orgId: orgA, runId: bRun, identityId: aIdentity2, portalUserId: a.portalUserId,
      }))).toMatchObject({ code: '23503', constraint_name: 'portal_directory_actions_run_fk' });
    });
  });

  it('every composite org_id FK on portal_directory_actions is DEFERRABLE INITIALLY IMMEDIATE', async () => {
    await inRolledBackTx(async (tx) => {
      const rows = await tx<{ conname: string; condeferrable: boolean; condeferred: boolean }[]>`
        SELECT conname, condeferrable, condeferred FROM pg_constraint
         WHERE conrelid = 'public.portal_directory_actions'::regclass AND contype = 'f'
           AND conname IN ('portal_directory_actions_run_fk', 'portal_directory_actions_identity_fk', 'portal_directory_actions_user_fk')
         ORDER BY conname`;
      expect(rows).toEqual([
        { conname: 'portal_directory_actions_identity_fk', condeferrable: true, condeferred: false },
        { conname: 'portal_directory_actions_run_fk', condeferrable: true, condeferred: false },
        { conname: 'portal_directory_actions_user_fk', condeferrable: true, condeferred: false },
      ]);
    });
  });

  it('deleting a portal user cascades its actions; deleting a run cascades its actions', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      const byUser = await seedChain(tx, orgId);
      const byRun = await seedChain(tx, orgId);
      const byIdentity = await seedChain(tx, orgId);

      await tx`DELETE FROM portal_users WHERE id = ${byUser.portalUserId}`;
      expect(await tx`SELECT 1 FROM portal_directory_actions WHERE id = ${byUser.actionId}`).toHaveLength(0);
      expect(await tx`SELECT 1 FROM portal_directory_runs WHERE id = ${byUser.runId}`).toHaveLength(1);

      await tx`DELETE FROM portal_directory_runs WHERE id = ${byRun.runId}`;
      expect(await tx`SELECT 1 FROM portal_directory_actions WHERE id = ${byRun.actionId}`).toHaveLength(0);
      expect(await tx`SELECT 1 FROM portal_users WHERE id = ${byRun.portalUserId}`).toHaveLength(1);

      await tx`DELETE FROM portal_user_identities WHERE id = ${byIdentity.identityId}`;
      expect(await tx`SELECT 1 FROM portal_directory_actions WHERE id = ${byIdentity.actionId}`).toHaveLength(0);
    });
  });

  it('refuses an applied action without applied_at and a reported one with it (23514)', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      const chain = await seedChain(tx, orgId);
      expect(await pgErrorOf(tx, (sp) => sp`
        UPDATE portal_directory_actions SET status = 'applied' WHERE id = ${chain.actionId}`))
        .toMatchObject({ code: '23514', constraint_name: 'portal_directory_actions_applied_chk' });
      expect(await pgErrorOf(tx, (sp) => sp`
        UPDATE portal_directory_actions SET applied_at = now() WHERE id = ${chain.actionId}`))
        .toMatchObject({ code: '23514', constraint_name: 'portal_directory_actions_applied_chk' });
      await tx`UPDATE portal_directory_actions SET status = 'applied', applied_at = now() WHERE id = ${chain.actionId}`;
    });
  });

  it('refuses a second run for the same (org, source, snapshot_key) (23505)', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      const insert = (sp: Tx) => sp`
        INSERT INTO portal_directory_runs (org_id, source, snapshot_key, snapshot_at, outcome, mode, disposition)
        VALUES (${orgId}, 'entra', 'conn:1:7', now(), 'evaluated', 'report', 'reported')`;
      await insert(tx);
      expect(await pgErrorOf(tx, insert))
        .toMatchObject({ code: '23505', constraint_name: 'portal_directory_runs_snapshot_uq' });
    });
  });
});
