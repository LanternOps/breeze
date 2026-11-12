/**
 * Portal registration W7 (#11384): the Workspace domain (`hd`) of a Google
 * access request (2027-01-24-170000-portal-access-requests-google-hosted-domain.sql;
 * plan D8).
 *
 * Every case runs inside ONE superuser postgres.js transaction that is always
 * rolled back, and replays the migration first, so a missing file fails every
 * case (template: portalEntraTenantProofMigration.integration.test.ts).
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalGoogleRequestMigration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';

const MIGRATION = '2027-01-24-170000-portal-access-requests-google-hosted-domain.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const CONSTRAINT = 'portal_access_requests_google_hd_chk';
const GOOGLE_ISSUER = 'https://accounts.google.com';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
const entraIssuer = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;
const FUTURE = new Date(Date.now() + 14 * 86_400_000);

async function inRolledBackTx(body: (tx: Tx) => Promise<void>, opts: { replayFirst?: boolean } = {}): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      if (opts.replayFirst !== false) await (tx as unknown as Tx).unsafe(await loadMigration());
      await body(tx as unknown as Tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

/** Runs one statement inside a savepoint so a deliberate failure does not abort the outer tx. */
async function pgErrorOf(tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await tx.savepoint(async (sp) => { await fn(sp as unknown as Tx); });
  } catch (error) {
    return error as { code?: string; constraint_name?: string };
  }
  throw new Error('expected the statement to fail');
}

async function newOrgId(): Promise<string> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return org.id;
}

const insertGoogle = (tx: Tx, orgId: string, email: string, hd: string | null) => tx`
  INSERT INTO portal_access_requests (org_id, email, source, issuer, subject, google_hosted_domain, expires_at)
  VALUES (${orgId}, ${email}, 'google', ${GOOGLE_ISSUER}, ${`sub-${randomUUID()}`}, ${hd}, ${FUTURE})`;

async function constraintState(tx: Tx): Promise<{ convalidated: boolean; def: string } | undefined> {
  const [row] = await tx<{ convalidated: boolean; def: string }[]>`
    SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'public.portal_access_requests'::regclass AND conname = ${CONSTRAINT}`;
  return row;
}

describe('2027-01-24-170000-portal-access-requests-google-hosted-domain.sql', () => {
  it('starts with the system-scope line', async () => {
    const text = await loadMigration();
    const firstStatement = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('--'));
    expect(firstStatement).toBe("SELECT set_config('breeze.scope', 'system', true);");
  });

  it(`refuses a google request without google_hosted_domain (23514 ${CONSTRAINT})`, async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      const err = await pgErrorOf(tx, (sp) => insertGoogle(sp, orgId, 'a@example.com', null));
      expect(err).toMatchObject({ code: '23514', constraint_name: CONSTRAINT });
    });
  });

  it('refuses google_hosted_domain on an entra, self or addin_user request (23514)', async () => {
    const orgId = await newOrgId();
    const tid = randomUUID();
    await inRolledBackTx(async (tx) => {
      const entra = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, issuer, subject, entra_tenant_id, google_hosted_domain, expires_at)
        VALUES (${orgId}, 'a@example.com', 'entra', ${entraIssuer(tid)}, 'oid-1', ${tid}, 'example.com', ${FUTURE})`);
      expect(entra).toMatchObject({ code: '23514', constraint_name: CONSTRAINT });
      const self = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, google_hosted_domain, expires_at)
        VALUES (${orgId}, 'b@example.com', 'self', 'example.com', ${FUTURE})`);
      expect(self).toMatchObject({ code: '23514', constraint_name: CONSTRAINT });
      const userId = randomUUID();
      await tx`
        INSERT INTO portal_users (id, org_id, email, auth_method, status, browser_access)
        VALUES (${userId}, ${orgId}, ${`${userId}@w7-migration.example.com`}, 'password', 'active', 'granted')`;
      const addin = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, portal_user_id, email, source, google_hosted_domain, expires_at)
        VALUES (${orgId}, ${userId}, 'c@example.com', 'addin_user', 'example.com', ${FUTURE})`);
      expect(addin).toMatchObject({ code: '23514', constraint_name: CONSTRAINT });
    });
  });

  it('refuses an upper-case or padded google_hosted_domain (23514)', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      const upper = await pgErrorOf(tx, (sp) => insertGoogle(sp, orgId, 'a@example.com', 'Example.com'));
      expect(upper).toMatchObject({ code: '23514', constraint_name: CONSTRAINT });
      const padded = await pgErrorOf(tx, (sp) => insertGoogle(sp, orgId, 'b@example.com', ' example.com'));
      expect(padded).toMatchObject({ code: '23514', constraint_name: CONSTRAINT });
    });
  });

  it('accepts a google request with a lowercase hosted domain', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      await insertGoogle(tx, orgId, 'a@example.com', 'contoso.example.com');
      const [row] = await tx`SELECT google_hosted_domain FROM portal_access_requests WHERE org_id = ${orgId} AND email = 'a@example.com'`;
      expect(row).toEqual({ google_hosted_domain: 'contoso.example.com' });
      // The other sources keep their pre-W7 shape (column NULL).
      await tx`INSERT INTO portal_access_requests (org_id, email, source, expires_at) VALUES (${orgId}, 'b@example.com', 'self', ${FUTURE})`;
    });
  });

  it('is idempotent: a second replay changes nothing and leaves the constraint VALID', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      await insertGoogle(tx, orgId, 'a@example.com', 'example.com');
      const snapshot = async () => ({
        constraint: await constraintState(tx),
        column: await tx`
          SELECT data_type, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'portal_access_requests' AND column_name = 'google_hosted_domain'`,
        checks: await tx`
          SELECT conname FROM pg_constraint WHERE conrelid = 'public.portal_access_requests'::regclass AND contype = 'c' ORDER BY conname`,
        rows: await tx`SELECT email, google_hosted_domain FROM portal_access_requests WHERE org_id = ${orgId}`,
      });
      const first = await snapshot();
      expect(first.constraint?.convalidated).toBe(true);
      expect(first.column).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
      await tx.unsafe(await loadMigration());
      expect(await snapshot()).toEqual(first);
    });
  });

  it('with a pre-existing google row lacking a domain: the constraint stays NOT VALID, the row is untouched (no hd inferred from email)', async () => {
    const orgId = await newOrgId();
    await inRolledBackTx(async (tx) => {
      // Recreate the pre-W7 world: no constraint, and a google row with no hd.
      await tx.unsafe(`ALTER TABLE public.portal_access_requests DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
      await insertGoogle(tx, orgId, 'legacy@contoso.example.com', null);
      await tx.unsafe(await loadMigration());

      expect((await constraintState(tx))?.convalidated).toBe(false);
      const [row] = await tx`
        SELECT google_hosted_domain FROM portal_access_requests WHERE org_id = ${orgId} AND email = 'legacy@contoso.example.com'`;
      expect(row).toEqual({ google_hosted_domain: null });
      // NOT VALID still binds new rows.
      const err = await pgErrorOf(tx, (sp) => insertGoogle(sp, orgId, 'new@contoso.example.com', null));
      expect(err).toMatchObject({ code: '23514', constraint_name: CONSTRAINT });
    }, { replayFirst: false });
  });
});
