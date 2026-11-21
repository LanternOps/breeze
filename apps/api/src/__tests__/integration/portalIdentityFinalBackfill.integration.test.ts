/**
 * Portal registration W10 (#11387) PR-A, plan D3: the final identity backfill
 * at the release-N boundary (2027-01-28-210000-portal-identity-final-backfill.sql).
 *
 * Every case runs inside ONE superuser postgres.js transaction that is always
 * rolled back (template: portalAccessPolicyMigration.integration.test.ts), so
 * seeded drift and the replay leave the fresh-migrated schema untouched.
 *
 * Proven:
 *  - a never-backfilled legacy pair gets its identity (`migrated`), on the
 *    login's own org (inv. 4), so the identity lookup — the add-in exchange's
 *    only way to find an account now — reaches the ORIGINAL account, disabled
 *    or not, instead of letting JIT mint a fresh active login;
 *  - a pair whose (issuer, subject) is linked to another login is skipped and
 *    counted with a WARNING, never refused;
 *  - FAIL CLOSED (plan D8): a complete legacy pair that no identity reserves
 *    (its login already holds a different Entra identity) refuses the whole
 *    file, because from release N nothing else would refuse a JIT login for it;
 *  - a mismatched pair whose key another login holds, and a half-populated
 *    row, are only counted (no refusal is lost);
 *  - a re-apply inserts nothing; the file elects system scope first.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalIdentityFinalBackfill.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';

const MIGRATION = '2027-01-28-210000-portal-identity-final-backfill.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
const entraIssuer = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;

async function inRolledBackTx(body: (tx: Tx, notices: string[]) => Promise<void>): Promise<void> {
  const notices: string[] = [];
  const client = postgres(DATABASE_URL, { max: 1, onnotice: (n) => { notices.push(`${n.severity}: ${n.message}`); } });
  try {
    await client.begin(async (tx) => { await body(tx as unknown as Tx, notices); throw new Rollback(); });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function newOrg(): Promise<string> {
  const partner = await createPartner();
  return (await createOrganization({ partnerId: partner.id })).id;
}

/** A login written by a pre-W2 binary: legacy pair set, no identity row. */
async function seedLegacyLogin(tx: Tx, orgId: string, opts: { tid?: string | null; oid?: string | null; status?: string } = {}) {
  const id = randomUUID();
  const status = opts.status ?? 'active';
  await tx`
    INSERT INTO portal_users (id, org_id, email, auth_method, status, browser_access, disabled_by, entra_oid, entra_tenant_id)
    VALUES (${id}, ${orgId}, ${`${id}@w10-backfill.test`}, 'entra', ${status}, 'none',
            ${status === 'disabled' ? 'msp' : null}, ${opts.oid ?? null}, ${opts.tid ?? null})`;
  return id;
}

async function seedIdentity(tx: Tx, orgId: string, portalUserId: string, tid: string, oid: string) {
  await tx`
    INSERT INTO portal_user_identities (org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via)
    VALUES (${orgId}, ${portalUserId}, 'entra', ${entraIssuer(tid)}, ${oid}, ${tid}, 'jit')`;
}

/** The add-in exchange's lookup (findPortalUserIdByEntraIdentity): identity key only. */
async function loginByIdentity(tx: Tx, tid: string, oid: string) {
  const rows = await tx<{ portal_user_id: string; org_id: string; linked_via: string }[]>`
    SELECT i.portal_user_id, i.org_id, i.linked_via FROM portal_user_identities i
     WHERE i.issuer = ${entraIssuer(tid)} AND i.subject = ${oid}`;
  return rows[0] ?? null;
}

describe(MIGRATION, () => {
  it('starts with the system-scope line and contains no DDL', async () => {
    const text = await loadMigration();
    const firstStatement = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('--'));
    expect(firstStatement).toBe("SELECT set_config('breeze.scope', 'system', true);");
    const code = text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\b(ALTER|DROP|CREATE)\s+(TABLE|INDEX|TRIGGER|FUNCTION|POLICY)\b/i);
  });

  it('backfills a never-backfilled pair onto the login (inv. 4), so the identity lookup reaches the original DISABLED account', async () => {
    const orgId = await newOrg();
    const tid = randomUUID();
    const oid = randomUUID();
    await inRolledBackTx(async (tx, notices) => {
      const original = await seedLegacyLogin(tx, orgId, { tid, oid, status: 'disabled' });
      expect(await loginByIdentity(tx, tid, oid)).toBeNull();

      await tx.unsafe(await loadMigration());

      expect(await loginByIdentity(tx, tid, oid)).toEqual({ portal_user_id: original, org_id: orgId, linked_via: 'migrated' });
      // The account itself is untouched: still disabled, so the exchange refuses it.
      const [acct] = await tx<{ status: string; browser_access: string }[]>`SELECT status, browser_access FROM portal_users WHERE id = ${original}`;
      expect(acct).toEqual({ status: 'disabled', browser_access: 'none' });
      expect(notices.some((n) => /final backfill inserted 1 identit/.test(n))).toBe(true);
    });
  });

  it('skips a pair whose (issuer, subject) is linked to another login, and WARNs the count (never refuses)', async () => {
    const orgId = await newOrg();
    const tid = randomUUID();
    const oid = randomUUID();
    await inRolledBackTx(async (tx, notices) => {
      const holder = await seedLegacyLogin(tx, orgId);
      await seedIdentity(tx, orgId, holder, tid, oid);
      const drifted = await seedLegacyLogin(tx, orgId, { tid, oid });

      await tx.unsafe(await loadMigration());

      expect((await loginByIdentity(tx, tid, oid))!.portal_user_id).toBe(holder);
      const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM portal_user_identities WHERE portal_user_id = ${drifted}`;
      expect(row!.n).toBe(0);
      expect(notices.some((n2) => /WARNING: portal_users: 1 legacy Entra pair\(s\) still have no identity/.test(n2))).toBe(true);
    });
  });

  it('FAILS CLOSED (plan D8) when a login holds a legacy pair no identity reserves and a different Entra identity of its own — nothing is changed', async () => {
    const orgId = await newOrg();
    const tid = randomUUID();
    await inRolledBackTx(async (tx) => {
      const mismatched = await seedLegacyLogin(tx, orgId, { tid, oid: 'legacy-oid' });
      await seedIdentity(tx, orgId, mismatched, tid, 'identity-oid');
      const neverBackfilled = await seedLegacyLogin(tx, orgId, { tid: randomUUID(), oid: randomUUID() });

      let error: { code?: string; message?: string; hint?: string } | null = null;
      try {
        await tx.savepoint(async (sp) => { await sp.unsafe(await loadMigration()); });
      } catch (e) {
        error = e as typeof error;
      }
      expect(error).toMatchObject({ code: 'P0001' });
      expect(error!.message).toMatch(/final backfill refused: 1 portal_users row\(s\) hold a legacy Entra pair/);
      expect(error!.hint).toMatch(/2026-11-21-100000-portal-entra-columns-drop-preflight\.sql/);
      // The whole file rolled back: not even the repairable row was backfilled.
      const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM portal_user_identities WHERE portal_user_id = ${neverBackfilled}`;
      expect(row!.n).toBe(0);
    });
  });

  it('only WARNs (never refuses) a mismatched pair whose key another login holds, and a half-populated row: neither loses a refusal', async () => {
    const orgId = await newOrg();
    const tid = randomUUID();
    await inRolledBackTx(async (tx, notices) => {
      const holder = await seedLegacyLogin(tx, orgId);
      await seedIdentity(tx, orgId, holder, tid, 'held-oid');
      const mismatched = await seedLegacyLogin(tx, orgId, { tid, oid: 'held-oid' });
      await seedIdentity(tx, orgId, mismatched, tid, 'identity-oid');
      const half = await seedLegacyLogin(tx, orgId, { tid: null, oid: randomUUID() });

      await tx.unsafe(await loadMigration());

      const rows = await tx<{ portal_user_id: string; subject: string }[]>`
        SELECT portal_user_id, subject FROM portal_user_identities WHERE portal_user_id IN (${mismatched}, ${half})`;
      expect(rows).toEqual([{ portal_user_id: mismatched, subject: 'identity-oid' }]);
      expect(notices.some((n) => /WARNING: portal_users: 1 legacy Entra pair\(s\) disagree/.test(n))).toBe(true);
      expect(notices.some((n) => /WARNING: portal_users: 1 row\(s\) have only one of entra_oid\/entra_tenant_id/.test(n))).toBe(true);
    });
  });

  it('a re-apply inserts nothing', async () => {
    const orgId = await newOrg();
    await inRolledBackTx(async (tx, notices) => {
      await seedLegacyLogin(tx, orgId, { tid: randomUUID(), oid: randomUUID() });
      await tx.unsafe(await loadMigration());
      notices.length = 0;
      await tx.unsafe(await loadMigration());
      expect(notices.some((n) => /final backfill inserted 0 identities/.test(n))).toBe(true);
    });
  });
});
