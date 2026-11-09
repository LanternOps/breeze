/**
 * Portal registration W2 (#11379): account foundations migration
 * (2027-01-22-230200-portal-account-foundations.sql).
 *
 * The CI database is migrated schema-fresh, so every backfill in the file
 * otherwise runs against zero rows. Each replay case below runs inside ONE
 * superuser postgres.js transaction that is always rolled back: it drops the
 * objects the migration creates, seeds rows in the pre-W2 shape, replays the
 * file exactly as autoMigrate would, asserts, and the ROLLBACK leaves the live
 * schema as the fresh migrate produced it.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalAccountFoundationsMigration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';

const MIGRATION = '2027-01-22-230200-portal-account-foundations.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');

/** Runs `body` in a superuser transaction that is always rolled back; collects `SEVERITY: message` notices. */
async function inRolledBackTx(body: (tx: Tx, notices: string[]) => Promise<void>): Promise<void> {
  const notices: string[] = [];
  const client = postgres(DATABASE_URL, {
    max: 1,
    onnotice: (n) => { notices.push(`${n.severity}: ${n.message}`); },
  });
  try {
    await client.begin(async (tx) => { await body(tx as unknown as Tx, notices); throw new Rollback(); });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

/**
 * Puts portal_users back in its pre-W2 shape (inside the rolled-back transaction).
 * CASCADE on the (id, org_id) index also drops the composite FKs later migrations
 * point at it (e.g. portal_access_requests_user_org_fk); the ROLLBACK restores them.
 */
async function dropW2Objects(tx: Tx): Promise<void> {
  await tx.unsafe(`
    DROP TABLE IF EXISTS public.portal_user_identities;
    DROP INDEX IF EXISTS public.portal_users_id_org_uq CASCADE;
    DROP TRIGGER IF EXISTS portal_users_browser_access_fill ON public.portal_users;
    DROP FUNCTION IF EXISTS public.breeze_portal_users_fill_browser_access();
    ALTER TABLE public.portal_users DROP CONSTRAINT IF EXISTS portal_users_status_chk;
    ALTER TABLE public.portal_users DROP CONSTRAINT IF EXISTS portal_users_browser_access_chk;
    ALTER TABLE public.portal_users DROP COLUMN IF EXISTS browser_access;
  `);
}

async function replay(tx: Tx): Promise<void> {
  await tx.unsafe(await loadMigration());
}

async function newOrg(): Promise<string> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return org.id;
}

type SeedRow = {
  authMethod?: 'password' | 'entra';
  status?: string;
  entraOid?: string | null;
  entraTenantId?: string | null;
  lastLoginAt?: Date | null;
  authEpoch?: number;
};

/** Inserts a pre-W2-shaped row (no browser_access column) and returns its id. */
async function seedRow(tx: Tx, orgId: string, row: SeedRow = {}): Promise<string> {
  const id = randomUUID();
  await tx`
    INSERT INTO portal_users (id, org_id, email, auth_method, status, entra_oid, entra_tenant_id, last_login_at, auth_epoch)
    VALUES (${id}, ${orgId}, ${`${id}@foundations.test`}, ${row.authMethod ?? 'password'}, ${row.status ?? 'active'},
            ${row.entraOid ?? null}, ${row.entraTenantId ?? null}, ${row.lastLoginAt ?? null}, ${row.authEpoch ?? 1})`;
  return id;
}

async function userRow(tx: Tx, id: string) {
  const [row] = await tx`SELECT status, browser_access, auth_epoch FROM portal_users WHERE id = ${id}`;
  return row as { status: string; browser_access: string; auth_epoch: number };
}

async function pgErrorOf(fn: () => Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await fn();
  } catch (error) {
    return error as { code?: string; constraint_name?: string };
  }
  throw new Error('expected the statement to fail');
}

describe('2027-01-22-230200-portal-account-foundations.sql', () => {
  it('backfills browser_access: password → granted, entra → none', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx, notices) => {
      await dropW2Objects(tx);
      const p1 = await seedRow(tx, orgId, { authMethod: 'password' });
      const p2 = await seedRow(tx, orgId, { authMethod: 'password', status: 'invited' });
      const e1 = await seedRow(tx, orgId, { authMethod: 'entra', entraOid: randomUUID(), entraTenantId: randomUUID() });
      await replay(tx);
      expect((await userRow(tx, p1)).browser_access).toBe('granted');
      expect((await userRow(tx, p2)).browser_access).toBe('granted');
      expect((await userRow(tx, e1)).browser_access).toBe('none');
      expect(notices).toContain('NOTICE: portal_users: browser_access backfilled granted=2 none=1');
    });
  });

  // Fail closed (advisor quorum): a non-canonical value is never mapped back
  // to a canonical one. " Active " is refused by login and the session gate
  // today (status !== 'active'); re-casing it to 'active' would GRANT access
  // without review. Every non-canonical value becomes 'disabled' + epoch bump.
  it('normalizes non-canonical statuses fail-closed: " Active " and "pending" → disabled (epoch bumped), WARN once per value', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx, notices) => {
      await dropW2Objects(tx);
      const recased = await seedRow(tx, orgId, { status: ' Active ' });
      const pendingA = await seedRow(tx, orgId, { status: 'pending', authEpoch: 4 });
      const pendingB = await seedRow(tx, orgId, { status: 'pending' });
      const ok = await seedRow(tx, orgId, { status: 'invited', authEpoch: 2 });
      const active = await seedRow(tx, orgId, { status: 'active', authEpoch: 3 });
      await replay(tx);

      expect(await userRow(tx, recased)).toMatchObject({ status: 'disabled', auth_epoch: 2 });
      expect(await userRow(tx, pendingA)).toMatchObject({ status: 'disabled', auth_epoch: 5 });
      expect(await userRow(tx, pendingB)).toMatchObject({ status: 'disabled', auth_epoch: 2 });
      expect(await userRow(tx, ok)).toMatchObject({ status: 'invited', auth_epoch: 2 });
      expect(await userRow(tx, active)).toMatchObject({ status: 'active', auth_epoch: 3 });

      expect(notices.filter((n) => n.includes("unknown status 'pending'"))).toEqual([
        "WARNING: portal_users: unknown status 'pending' on 2 row(s) -> disabled",
      ]);
      expect(notices).toContain("WARNING: portal_users: unknown status ' Active ' on 1 row(s) -> disabled");
      expect(notices).toContain('WARNING: portal_users: disabled 3 row(s) with an unknown status');
    });
  });

  it('rejects status outside invited|active|disabled with 23514 portal_users_status_chk', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx) => {
      const id = await seedRow(tx, orgId);
      const err = await pgErrorOf(() => tx`UPDATE portal_users SET status = 'pending' WHERE id = ${id}`);
      expect(err.code).toBe('23514');
      expect(err.constraint_name).toBe('portal_users_status_chk');
    });
  });

  it('rejects browser_access outside granted|none with 23514 portal_users_browser_access_chk', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx) => {
      const id = await seedRow(tx, orgId);
      const err = await pgErrorOf(() => tx`UPDATE portal_users SET browser_access = 'maybe' WHERE id = ${id}`);
      expect(err.code).toBe('23514');
      expect(err.constraint_name).toBe('portal_users_browser_access_chk');
    });
  });

  // Review Focus 1: an old (pre-W2) API binary inserts without the column
  // during a rolling deploy. The invite row must come out granted, the add-in
  // JIT row none, and no NOT NULL error may surface.
  it('fills browser_access from auth_method when an insert omits it', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx) => {
      const invite = await seedRow(tx, orgId, { authMethod: 'password', status: 'invited' });
      const jit = await seedRow(tx, orgId, { authMethod: 'entra', entraOid: randomUUID(), entraTenantId: randomUUID() });
      expect((await userRow(tx, invite)).browser_access).toBe('granted');
      expect((await userRow(tx, jit)).browser_access).toBe('none');

      // Explicit NULL (Drizzle's DEFAULT keyword on a column with no default) takes the same path.
      const viaDefault = randomUUID();
      await tx`INSERT INTO portal_users (id, org_id, email, auth_method, browser_access)
               VALUES (${viaDefault}, ${orgId}, ${`${viaDefault}@foundations.test`}, 'password', DEFAULT)`;
      expect((await userRow(tx, viaDefault)).browser_access).toBe('granted');
    });
  });

  it('keeps an explicit browser_access on insert', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx) => {
      const id = randomUUID();
      await tx`INSERT INTO portal_users (id, org_id, email, auth_method, entra_oid, entra_tenant_id, browser_access)
               VALUES (${id}, ${orgId}, ${`${id}@foundations.test`}, 'entra', ${randomUUID()}, ${randomUUID()}, 'granted')`;
      expect((await userRow(tx, id)).browser_access).toBe('granted');
      const pw = randomUUID();
      await tx`INSERT INTO portal_users (id, org_id, email, auth_method, browser_access)
               VALUES (${pw}, ${orgId}, ${`${pw}@foundations.test`}, 'password', 'none')`;
      expect((await userRow(tx, pw)).browser_access).toBe('none');
    });
  });

  it('backfills one entra identity per (entra_tenant_id, entra_oid) row with the v2.0 issuer and linked_via=migrated', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx, notices) => {
      await dropW2Objects(tx);
      const tid = randomUUID();
      const oidA = randomUUID();
      const oidB = randomUUID();
      const lastLogin = new Date('2026-10-01T12:00:00Z');
      const a = await seedRow(tx, orgId, { authMethod: 'entra', entraTenantId: tid, entraOid: oidA, lastLoginAt: lastLogin });
      const b = await seedRow(tx, orgId, { authMethod: 'entra', entraTenantId: tid, entraOid: oidB });
      const pw = await seedRow(tx, orgId, { authMethod: 'password' });
      await replay(tx);

      const rows = await tx`
        SELECT i.portal_user_id, i.org_id, i.provider, i.issuer, i.subject, i.entra_tenant_id, i.linked_via,
               i.last_used_at, i.created_at = pu.created_at AS created_matches
          FROM portal_user_identities i JOIN portal_users pu ON pu.id = i.portal_user_id
         WHERE i.org_id = ${orgId} ORDER BY i.subject`;
      const byUser = new Map(rows.map((r) => [r.portal_user_id as string, r]));
      expect(rows).toHaveLength(2);
      expect(byUser.has(pw)).toBe(false);
      expect(byUser.get(a)).toMatchObject({
        org_id: orgId,
        provider: 'entra',
        issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
        subject: oidA,
        entra_tenant_id: tid,
        linked_via: 'migrated',
        created_matches: true,
      });
      expect((byUser.get(a)!.last_used_at as Date).toISOString()).toBe(lastLogin.toISOString());
      expect(byUser.get(b)).toMatchObject({ subject: oidB, last_used_at: null, linked_via: 'migrated' });
      expect(notices).toContain('NOTICE: portal_user_identities: backfilled 2 entra identit(ies)');
    });
  });

  it('skips half-populated rows (oid without tid) and WARNs their count', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx, notices) => {
      await dropW2Objects(tx);
      const half = await seedRow(tx, orgId, { authMethod: 'entra', entraOid: randomUUID(), entraTenantId: null });
      const halfTid = await seedRow(tx, orgId, { authMethod: 'entra', entraOid: null, entraTenantId: randomUUID() });
      await replay(tx);
      const [counted] = await tx`SELECT count(*)::int AS n FROM portal_user_identities WHERE portal_user_id IN (${half}, ${halfTid})`;
      expect(counted!.n).toBe(0);
      expect(notices).toContain('WARNING: portal_users: 2 row(s) have only one of entra_oid/entra_tenant_id — not backfilled');
    });
  });

  it('is idempotent: a second replay changes no row and does not reset a browser_access changed after the first', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx, notices) => {
      await dropW2Objects(tx);
      const revoked = await seedRow(tx, orgId, { authMethod: 'password' });
      await seedRow(tx, orgId, { authMethod: 'password', status: 'invited' });
      await seedRow(tx, orgId, { authMethod: 'entra', entraOid: randomUUID(), entraTenantId: randomUUID() });
      await replay(tx);
      await tx`UPDATE portal_users SET browser_access = 'none' WHERE id = ${revoked}`;

      const snapshot = async () => ({
        users: await tx`SELECT id, status, browser_access, auth_epoch, updated_at::text FROM portal_users WHERE org_id = ${orgId} ORDER BY id`,
        identities: await tx`SELECT id, portal_user_id, issuer, subject, linked_via, last_used_at::text, created_at::text
                               FROM portal_user_identities WHERE org_id = ${orgId} ORDER BY id`,
      });
      const before = await snapshot();
      notices.length = 0;
      await replay(tx);
      const after = await snapshot();

      expect(after).toEqual(before);
      expect((await userRow(tx, revoked)).browser_access).toBe('none');
      expect(notices).toContain('NOTICE: portal_users: disabled 0 row(s) with an unknown status');
      expect(notices).toContain('NOTICE: portal_users: browser_access backfilled granted=0 none=0');
      expect(notices).toContain('NOTICE: portal_user_identities: backfilled 0 entra identit(ies)');
      expect(notices.some((n) => n.startsWith('WARNING:'))).toBe(false);
    });
  });

  it('creates portal_users_id_org_uq on (id, org_id)', async () => {
    await inRolledBackTx(async (tx) => {
      const rows = await tx`
        SELECT ix.indisunique AS is_unique,
               array_agg(a.attname ORDER BY k.ord) AS cols
          FROM pg_index ix
          JOIN pg_class i ON i.oid = ix.indexrelid
          CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
         WHERE i.relname = 'portal_users_id_org_uq'
         GROUP BY ix.indisunique`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ is_unique: true, cols: ['id', 'org_id'] });
    });
  });

  it('starts with the system-scope line', async () => {
    const text = await loadMigration();
    const firstStatement = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('--'));
    expect(firstStatement).toBe("SELECT set_config('breeze.scope', 'system', true);");
  });
});
