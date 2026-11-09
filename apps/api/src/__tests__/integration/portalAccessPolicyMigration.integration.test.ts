/**
 * Portal registration W3 (#11380): access policy + access request tables,
 * auth_method 'google', identities release-B re-backfill
 * (2027-01-22-232800-portal-access-policies-requests.sql).
 *
 * Every case runs inside ONE superuser postgres.js transaction that is always
 * rolled back, so constraint probes and replays leave the fresh-migrated
 * schema untouched (template: portalAccountFoundationsMigration).
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalAccessPolicyMigration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';

const MIGRATION = '2027-01-22-232800-portal-access-policies-requests.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
const entraIssuer = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;

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

/** Runs one statement inside a savepoint so a deliberate failure does not abort the outer tx. */
async function pgErrorOf(tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await tx.savepoint(async (sp) => { await fn(sp as unknown as Tx); });
  } catch (error) {
    return error as { code?: string; constraint_name?: string };
  }
  throw new Error('expected the statement to fail');
}

async function newOrg(): Promise<{ orgId: string; partnerId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return { orgId: org.id, partnerId: partner.id };
}

async function seedPortalUser(tx: Tx, orgId: string, row: { authMethod?: string; entraOid?: string | null; entraTenantId?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  await tx`
    INSERT INTO portal_users (id, org_id, email, auth_method, status, browser_access, entra_oid, entra_tenant_id)
    VALUES (${id}, ${orgId}, ${`${id}@w3-migration.test`}, ${row.authMethod ?? 'password'}, 'active',
            ${(row.authMethod ?? 'password') === 'password' ? 'granted' : 'none'},
            ${row.entraOid ?? null}, ${row.entraTenantId ?? null})`;
  return id;
}

const FUTURE = new Date(Date.now() + 14 * 86_400_000);

describe('2027-01-22-232800-portal-access-policies-requests.sql', () => {
  it('starts with the system-scope line', async () => {
    const text = await loadMigration();
    const firstStatement = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('--'));
    expect(firstStatement).toBe("SELECT set_config('breeze.scope', 'system', true);");
  });

  it('portal_access_policies: refuses a row with both or neither owner (23514 portal_access_policies_one_owner_chk)', async () => {
    const { orgId, partnerId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const both = await pgErrorOf(tx, (sp) => sp`INSERT INTO portal_access_policies (org_id, partner_id) VALUES (${orgId}, ${partnerId})`);
      expect(both).toMatchObject({ code: '23514', constraint_name: 'portal_access_policies_one_owner_chk' });
      const neither = await pgErrorOf(tx, (sp) => sp`INSERT INTO portal_access_policies (entra_enabled) VALUES (true)`);
      expect(neither).toMatchObject({ code: '23514', constraint_name: 'portal_access_policies_one_owner_chk' });
    });
  });

  it('portal_access_policies: refuses a second org row and a second partner row (23505 _org_uq / _partner_uq)', async () => {
    const { orgId, partnerId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      await tx`INSERT INTO portal_access_policies (org_id) VALUES (${orgId})`;
      await tx`INSERT INTO portal_access_policies (partner_id) VALUES (${partnerId})`;
      const org2 = await pgErrorOf(tx, (sp) => sp`INSERT INTO portal_access_policies (org_id) VALUES (${orgId})`);
      expect(org2).toMatchObject({ code: '23505', constraint_name: 'portal_access_policies_org_uq' });
      const partner2 = await pgErrorOf(tx, (sp) => sp`INSERT INTO portal_access_policies (partner_id) VALUES (${partnerId})`);
      expect(partner2).toMatchObject({ code: '23505', constraint_name: 'portal_access_policies_partner_uq' });
    });
  });

  it('portal_access_policies: refuses password_mode "off", sso_session_max_hours 0 and 169 (23514)', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const off = await pgErrorOf(tx, (sp) => sp`INSERT INTO portal_access_policies (org_id, password_mode) VALUES (${orgId}, 'off')`);
      expect(off.code).toBe('23514');
      const zero = await pgErrorOf(tx, (sp) => sp`INSERT INTO portal_access_policies (org_id, sso_session_max_hours) VALUES (${orgId}, 0)`);
      expect(zero.code).toBe('23514');
      const over = await pgErrorOf(tx, (sp) => sp`INSERT INTO portal_access_policies (org_id, sso_session_max_hours) VALUES (${orgId}, 169)`);
      expect(over.code).toBe('23514');
      await tx`INSERT INTO portal_access_policies (org_id, password_mode, sso_session_max_hours, self_registration_mode, sso_new_person_mode)
               VALUES (${orgId}, 'sso_only', 168, 'approval', 'invited_only')`;
    });
  });

  it('portal_access_requests: refuses entra source without issuer/subject/entra_tenant_id and self source with claims (23514 portal_access_requests_claims_chk)', async () => {
    const { orgId } = await newOrg();
    const tid = randomUUID();
    await inRolledBackTx(async (tx) => {
      const bareEntra = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, expires_at) VALUES (${orgId}, 'a@x.test', 'entra', ${FUTURE})`);
      expect(bareEntra).toMatchObject({ code: '23514', constraint_name: 'portal_access_requests_claims_chk' });
      const selfWithClaims = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, issuer, subject, entra_tenant_id, expires_at)
        VALUES (${orgId}, 'b@x.test', 'self', ${entraIssuer(tid)}, 'oid-1', ${tid}, ${FUTURE})`);
      expect(selfWithClaims).toMatchObject({ code: '23514', constraint_name: 'portal_access_requests_claims_chk' });
      const wrongIssuer = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, issuer, subject, entra_tenant_id, expires_at)
        VALUES (${orgId}, 'c@x.test', 'entra', 'https://accounts.google.com', 'oid-1', ${tid}, ${FUTURE})`);
      expect(wrongIssuer).toMatchObject({ code: '23514', constraint_name: 'portal_access_requests_claims_chk' });
      const addinNoUser = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, expires_at) VALUES (${orgId}, 'd@x.test', 'addin_user', ${FUTURE})`);
      expect(addinNoUser).toMatchObject({ code: '23514', constraint_name: 'portal_access_requests_claims_chk' });
      // The valid shapes insert.
      await tx`INSERT INTO portal_access_requests (org_id, email, source, issuer, subject, entra_tenant_id, expires_at)
               VALUES (${orgId}, 'e@x.test', 'entra', ${entraIssuer(tid)}, 'oid-1', ${tid}, ${FUTURE})`;
      await tx`INSERT INTO portal_access_requests (org_id, email, source, issuer, subject, expires_at)
               VALUES (${orgId}, 'f@x.test', 'google', 'https://accounts.google.com', 'sub-1', ${FUTURE})`;
      await tx`INSERT INTO portal_access_requests (org_id, email, source, expires_at) VALUES (${orgId}, 'g@x.test', 'self', ${FUTURE})`;
    });
  });

  it('portal_access_requests: refuses a self row with issuer set and subject NULL, and an entra row with subject only (23514)', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const selfIssuer = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, issuer, expires_at)
        VALUES (${orgId}, 'a@x.test', 'self', 'https://accounts.google.com', ${FUTURE})`);
      expect(selfIssuer.code).toBe('23514');
      const entraSubjectOnly = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, subject, expires_at)
        VALUES (${orgId}, 'b@x.test', 'entra', 'oid-1', ${FUTURE})`);
      expect(entraSubjectOnly.code).toBe('23514');
    });
  });

  it('portal_access_requests: refuses status approved with portal_user_id NULL (23514 portal_access_requests_decision_chk)', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const err = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, status, decided_at, expires_at)
        VALUES (${orgId}, 'a@x.test', 'self', 'approved', now(), ${FUTURE})`);
      expect(err).toMatchObject({ code: '23514', constraint_name: 'portal_access_requests_decision_chk' });
      const deniedUndated = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, status, expires_at)
        VALUES (${orgId}, 'b@x.test', 'self', 'denied', ${FUTURE})`);
      expect(deniedUndated).toMatchObject({ code: '23514', constraint_name: 'portal_access_requests_decision_chk' });
    });
  });

  it('portal_access_requests: refuses a non-normalized email "  A@X.test" (23514 portal_access_requests_email_chk)', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const err = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, expires_at) VALUES (${orgId}, '  A@X.test', 'self', ${FUTURE})`);
      expect(err).toMatchObject({ code: '23514', constraint_name: 'portal_access_requests_email_chk' });
    });
  });

  it('portal_access_requests: a second PENDING row for the same (org, email) → 23505; a denied one beside it is fine', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      await tx`INSERT INTO portal_access_requests (org_id, email, source, expires_at) VALUES (${orgId}, 'dup@x.test', 'self', ${FUTURE})`;
      const dup = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, email, source, expires_at) VALUES (${orgId}, 'dup@x.test', 'self', ${FUTURE})`);
      expect(dup).toMatchObject({ code: '23505', constraint_name: 'portal_access_requests_pending_email_uq' });
      await tx`INSERT INTO portal_access_requests (org_id, email, source, status, decided_at, expires_at)
               VALUES (${orgId}, 'dup@x.test', 'self', 'denied', now(), ${FUTURE})`;
    });
  });

  it('portal_access_requests_user_org_fk is DEFERRABLE INITIALLY IMMEDIATE and refuses a portal user from another org (23503)', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await inRolledBackTx(async (tx) => {
      const [fk] = await tx`
        SELECT condeferrable, condeferred FROM pg_constraint
         WHERE conrelid = 'public.portal_access_requests'::regclass AND conname = 'portal_access_requests_user_org_fk'`;
      expect(fk).toEqual({ condeferrable: true, condeferred: false });
      const userInB = await seedPortalUser(tx, b.orgId);
      const err = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO portal_access_requests (org_id, portal_user_id, email, source, expires_at)
        VALUES (${a.orgId}, ${userInB}, 'x@x.test', 'addin_user', ${FUTURE})`);
      expect(err).toMatchObject({ code: '23503', constraint_name: 'portal_access_requests_user_org_fk' });
    });
  });

  it('auth_method CHECK accepts google and still refuses "saml"', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      await seedPortalUser(tx, orgId, { authMethod: 'google' });
      const err = await pgErrorOf(tx, (sp) => seedPortalUser(sp, orgId, { authMethod: 'saml' }));
      expect(err).toMatchObject({ code: '23514', constraint_name: 'portal_users_auth_method_check' });
    });
  });

  it('re-backfills an entra login that has no identity row (linked_via migrated) and NOTICEs the count', async () => {
    const { orgId } = await newOrg();
    const tid = randomUUID();
    const oid = randomUUID();
    await inRolledBackTx(async (tx, notices) => {
      const userId = await seedPortalUser(tx, orgId, { authMethod: 'entra', entraOid: oid, entraTenantId: tid });
      await tx`DELETE FROM portal_user_identities WHERE portal_user_id = ${userId}`;
      await tx.unsafe(await loadMigration());
      const rows = await tx`
        SELECT provider, issuer, subject, entra_tenant_id, linked_via, org_id FROM portal_user_identities WHERE portal_user_id = ${userId}`;
      expect(rows).toEqual([{ provider: 'entra', issuer: entraIssuer(tid), subject: oid, entra_tenant_id: tid, linked_via: 'migrated', org_id: orgId }]);
      expect(notices.some((n) => /^NOTICE: portal_user_identities: release-B backfill inserted [1-9]\d* identit\(ies\)$/.test(n))).toBe(true);
    });
  });

  it('WARNs (does not fail) for a login whose (issuer, subject) belongs to another user', async () => {
    const { orgId } = await newOrg();
    const tid = randomUUID();
    const oid = randomUUID();
    await inRolledBackTx(async (tx, notices) => {
      const owner = await seedPortalUser(tx, orgId);
      await tx`INSERT INTO portal_user_identities (org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via)
               VALUES (${orgId}, ${owner}, 'entra', ${entraIssuer(tid)}, ${oid}, ${tid}, 'jit')`;
      const orphan = await seedPortalUser(tx, orgId, { authMethod: 'entra', entraOid: oid, entraTenantId: tid });
      await tx`DELETE FROM portal_user_identities WHERE portal_user_id = ${orphan}`;
      await tx.unsafe(await loadMigration());
      const [n] = await tx`SELECT count(*)::int AS n FROM portal_user_identities WHERE portal_user_id = ${orphan}`;
      expect(n!.n).toBe(0);
      expect(notices.some((m) => /^WARNING: portal_users: [1-9]\d* entra login\(s\) have no matching identity after backfill/.test(m))).toBe(true);
    });
  });

  it('is idempotent: a second replay changes nothing', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx, notices) => {
      await tx`INSERT INTO portal_access_policies (org_id, password_mode) VALUES (${orgId}, 'allowed')`;
      await tx.unsafe(await loadMigration());
      const snapshot = async () => ({
        policies: await tx`SELECT polname FROM pg_policy WHERE polrelid IN ('public.portal_access_policies'::regclass, 'public.portal_access_requests'::regclass) ORDER BY polname`,
        identities: await tx`SELECT count(*)::int AS n FROM portal_user_identities`,
        rows: await tx`SELECT org_id, password_mode FROM portal_access_policies WHERE org_id = ${orgId}`,
        check: await tx`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'portal_users_auth_method_check'`,
      });
      const first = await snapshot();
      notices.length = 0;
      await tx.unsafe(await loadMigration());
      expect(await snapshot()).toEqual(first);
      expect(notices).toContain('NOTICE: portal_user_identities: release-B backfill inserted 0 identit(ies)');
    });
  });

  it('forces RLS on both tables', async () => {
    await inRolledBackTx(async (tx) => {
      const rows = await tx`
        SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname IN ('portal_access_policies', 'portal_access_requests') ORDER BY relname`;
      expect(rows).toEqual([
        { relname: 'portal_access_policies', relrowsecurity: true, relforcerowsecurity: true },
        { relname: 'portal_access_requests', relrowsecurity: true, relforcerowsecurity: true },
      ]);
    });
  });
});
