/**
 * Portal registration W5 (#11382): domain verification columns on
 * customer_email_domains, the platform-wide verified-domain unique index and
 * the clear-on-repoint trigger with its org-merge exemption
 * (2027-01-22-233700-portal-domain-verification.sql; plan D1–D4, spec §5.4, inv. 3).
 *
 * Every case runs inside ONE superuser postgres.js transaction that is always
 * rolled back (template: portalEntraTenantProofMigration.integration.test.ts).
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalDomainVerificationMigration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner, createUser } from './db-utils';

const MIGRATION = '2027-01-22-233700-portal-domain-verification.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      // Replay first: a missing file fails every case (red before the migration exists).
      await (tx as unknown as Tx).unsafe(await loadMigration());
      await body(tx as unknown as Tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function pgErrorOf(tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await tx.savepoint(async (sp) => { await fn(sp as unknown as Tx); });
  } catch (error) {
    return error as { code?: string; constraint_name?: string };
  }
  throw new Error('expected the statement to fail');
}

async function newOrg(partnerId?: string): Promise<{ orgId: string; partnerId: string }> {
  const pid = partnerId ?? (await createPartner()).id;
  const org = await createOrganization({ partnerId: pid });
  return { orgId: org.id, partnerId: pid };
}

const domainName = () => `d-${randomUUID().slice(0, 8)}.example.com`;

async function seedDomain(tx: Tx, org: { orgId: string; partnerId: string }, domain = domainName()): Promise<string> {
  const id = randomUUID();
  await tx`
    INSERT INTO customer_email_domains (id, partner_id, org_id, domain)
    VALUES (${id}, ${org.partnerId}, ${org.orgId}, ${domain})`;
  return id;
}

async function seedVerified(
  tx: Tx,
  org: { orgId: string; partnerId: string },
  domain = domainName(),
  verifiedBy: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await tx`
    INSERT INTO customer_email_domains
      (id, partner_id, org_id, domain, verification_token, verified_at, verified_method, verified_evidence,
       verified_by_user_id, last_checked_at, last_passed_at, last_check_status)
    VALUES (${id}, ${org.partnerId}, ${org.orgId}, ${domain}, 'tok', now(), 'dns_txt',
            ${tx.json({ via: 'dns_txt', recordName: `_breeze-verify.${domain}` })}, ${verifiedBy}, now(), now(), 'pass')`;
  return id;
}

type VerifRow = {
  verification_token: string | null;
  verified_at: Date | null;
  verified_method: string | null;
  verified_evidence: unknown;
  verified_by_user_id: string | null;
  last_passed_at: Date | null;
  last_check_status: string | null;
  check_failures: number;
  cleared_at: Date | null;
  cleared_reason: string | null;
};

async function rowOf(tx: Tx, id: string): Promise<VerifRow> {
  const [row] = await tx<VerifRow[]>`
    SELECT verification_token, verified_at, verified_method, verified_evidence, verified_by_user_id,
           last_passed_at, last_check_status, check_failures, cleared_at, cleared_reason
      FROM customer_email_domains WHERE id = ${id}`;
  return row!;
}

describe('2027-01-22-233700-portal-domain-verification.sql', () => {
  it('starts with the system-scope line', async () => {
    const text = await loadMigration();
    const firstStatement = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('--'));
    expect(firstStatement).toBe("SELECT set_config('breeze.scope', 'system', true);");
  });

  it('refuses verified_method "manual" (23514 customer_email_domains_verified_method_chk)', async () => {
    const org = await newOrg();
    await inRolledBackTx(async (tx) => {
      const err = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO customer_email_domains (partner_id, org_id, domain, verified_at, verified_method, verified_evidence, last_passed_at)
        VALUES (${org.partnerId}, ${org.orgId}, ${domainName()}, now(), 'manual', ${sp.json({ via: 'manual' })}, now())`);
      expect(err).toMatchObject({ code: '23514', constraint_name: 'customer_email_domains_verified_method_chk' });
    });
  });

  it('refuses verified_at set with verified_method, verified_evidence or last_passed_at NULL, and the reverse (23514 customer_email_domains_verification_shape_chk)', async () => {
    const org = await newOrg();
    await inRolledBackTx(async (tx) => {
      const ev = (d: string) => tx.json({ via: 'dns_txt', recordName: `_breeze-verify.${d}` });
      const cases: Array<[string, (sp: Tx, d: string) => Promise<unknown>]> = [
        ['no method', (sp, d) => sp`
          INSERT INTO customer_email_domains (partner_id, org_id, domain, verified_at, verified_evidence, last_passed_at)
          VALUES (${org.partnerId}, ${org.orgId}, ${d}, now(), ${ev(d)}, now())`],
        ['no evidence', (sp, d) => sp`
          INSERT INTO customer_email_domains (partner_id, org_id, domain, verified_at, verified_method, last_passed_at)
          VALUES (${org.partnerId}, ${org.orgId}, ${d}, now(), 'dns_txt', now())`],
        ['no last_passed_at', (sp, d) => sp`
          INSERT INTO customer_email_domains (partner_id, org_id, domain, verified_at, verified_method, verified_evidence)
          VALUES (${org.partnerId}, ${org.orgId}, ${d}, now(), 'dns_txt', ${ev(d)})`],
        ['method + evidence without verified_at', (sp, d) => sp`
          INSERT INTO customer_email_domains (partner_id, org_id, domain, verified_method, verified_evidence, last_passed_at)
          VALUES (${org.partnerId}, ${org.orgId}, ${d}, 'dns_txt', ${ev(d)}, now())`],
        ['last_passed_at alone', (sp, d) => sp`
          INSERT INTO customer_email_domains (partner_id, org_id, domain, last_passed_at)
          VALUES (${org.partnerId}, ${org.orgId}, ${d}, now())`],
      ];
      for (const [name, fn] of cases) {
        const err = await pgErrorOf(tx, (sp) => fn(sp, domainName()));
        expect(err, name).toMatchObject({ code: '23514', constraint_name: 'customer_email_domains_verification_shape_chk' });
      }
      // A declared row (all NULL) is the pre-W5 shape and stays valid.
      await seedDomain(tx, org);
    });
  });

  it('refuses dns_txt evidence without recordName, entra_tenant without tenantId/connectionId, google_directory without connectionId (23514 customer_email_domains_evidence_chk)', async () => {
    const org = await newOrg();
    const cases: Array<[string, string, postgres.JSONValue]> = [
      ['dns_txt without recordName', 'dns_txt', { via: 'dns_txt' }],
      ['entra_tenant without tenantId', 'entra_tenant', { via: 'entra_tenant', connectionId: randomUUID() }],
      ['entra_tenant without connectionId', 'entra_tenant', { via: 'entra_tenant', tenantId: randomUUID() }],
      ['google_directory without connectionId', 'google_directory', { via: 'google_directory' }],
      ['dns evidence recorded as google_directory', 'google_directory', { via: 'dns_txt', recordName: 'x' }],
      ['an array of the key names', 'dns_txt', ['recordName']],
    ];
    await inRolledBackTx(async (tx) => {
      for (const [name, method, evidence] of cases) {
        const err = await pgErrorOf(tx, (sp) => sp`
          INSERT INTO customer_email_domains (partner_id, org_id, domain, verified_at, verified_method, verified_evidence, last_passed_at)
          VALUES (${org.partnerId}, ${org.orgId}, ${domainName()}, now(), ${method}, ${sp.json(evidence)}, now())`);
        expect(err, name).toMatchObject({ code: '23514', constraint_name: 'customer_email_domains_evidence_chk' });
      }
      // The three real shapes are accepted.
      const good: Array<[string, postgres.JSONValue]> = [
        ['dns_txt', { via: 'dns_txt', recordName: '_breeze-verify.a.example.com' }],
        ['entra_tenant', { via: 'entra_tenant', tenantId: randomUUID(), connectionId: randomUUID() }],
        ['google_directory', { via: 'google_directory', connectionId: randomUUID() }],
      ];
      for (const [method, evidence] of good) {
        await tx`
          INSERT INTO customer_email_domains (partner_id, org_id, domain, verified_at, verified_method, verified_evidence, last_passed_at)
          VALUES (${org.partnerId}, ${org.orgId}, ${domainName()}, now(), ${method}, ${tx.json(evidence)}, now())`;
      }
    });
  });

  it('refuses an unknown last_check_status and negative check_failures (23514 customer_email_domains_check_status_chk)', async () => {
    const org = await newOrg();
    await inRolledBackTx(async (tx) => {
      const id = await seedDomain(tx, org);
      const badStatus = await pgErrorOf(tx, (sp) => sp`UPDATE customer_email_domains SET last_check_status = 'maybe' WHERE id = ${id}`);
      expect(badStatus).toMatchObject({ code: '23514', constraint_name: 'customer_email_domains_check_status_chk' });
      const negative = await pgErrorOf(tx, (sp) => sp`UPDATE customer_email_domains SET check_failures = -1 WHERE id = ${id}`);
      expect(negative).toMatchObject({ code: '23514', constraint_name: 'customer_email_domains_check_status_chk' });
    });
  });

  it('refuses cleared_at on a verified row (23514 customer_email_domains_cleared_shape_chk)', async () => {
    const org = await newOrg();
    await inRolledBackTx(async (tx) => {
      const id = await seedVerified(tx, org);
      const onVerified = await pgErrorOf(tx, (sp) => sp`
        UPDATE customer_email_domains SET cleared_at = now(), cleared_reason = 'stale' WHERE id = ${id}`);
      expect(onVerified).toMatchObject({ code: '23514', constraint_name: 'customer_email_domains_cleared_shape_chk' });
      const declared = await seedDomain(tx, org);
      const atWithoutReason = await pgErrorOf(tx, (sp) => sp`UPDATE customer_email_domains SET cleared_at = now() WHERE id = ${declared}`);
      expect(atWithoutReason).toMatchObject({ code: '23514', constraint_name: 'customer_email_domains_cleared_shape_chk' });
      const unknownReason = await pgErrorOf(tx, (sp) => sp`
        UPDATE customer_email_domains SET cleared_at = now(), cleared_reason = 'because' WHERE id = ${declared}`);
      expect(unknownReason).toMatchObject({ code: '23514', constraint_name: 'customer_email_domains_cleared_shape_chk' });
    });
  });

  it('partial unique index refuses a second verified row for the same domain in another partner, case-insensitively (23505 customer_email_domains_verified_domain_uq)', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await inRolledBackTx(async (tx) => {
      const domain = domainName();
      await seedVerified(tx, a, domain);
      const err = await pgErrorOf(tx, (sp) => seedVerified(sp, b, domain.toUpperCase()));
      expect(err).toMatchObject({ code: '23505', constraint_name: 'customer_email_domains_verified_domain_uq' });
    });
  });

  it('allows two unverified rows for the same domain in different partners', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await inRolledBackTx(async (tx) => {
      const domain = domainName();
      await seedDomain(tx, a, domain);
      await seedDomain(tx, b, domain);
      // ...and one verified + one declared.
      const c = await newOrg();
      await seedVerified(tx, c, domain);
    });
  });

  it('repointing org_id clears verification and the token, and records cleared_reason repointed', async () => {
    const a = await newOrg();
    const b = await newOrg(a.partnerId);
    await inRolledBackTx(async (tx) => {
      const id = await seedVerified(tx, a);
      await tx`UPDATE customer_email_domains SET org_id = ${b.orgId}, updated_at = now() WHERE id = ${id}`;
      const row = await rowOf(tx, id);
      expect(row).toMatchObject({
        verification_token: null,
        verified_at: null,
        verified_method: null,
        verified_evidence: null,
        verified_by_user_id: null,
        last_passed_at: null,
        last_check_status: null,
        check_failures: 0,
        cleared_reason: 'repointed',
      });
      expect(row.cleared_at).not.toBeNull();
    });
  });

  it('repointing an unverified row clears the token and nulls any earlier cleared_at/cleared_reason', async () => {
    const a = await newOrg();
    const b = await newOrg(a.partnerId);
    await inRolledBackTx(async (tx) => {
      const id = await seedDomain(tx, a);
      await tx`
        UPDATE customer_email_domains
           SET verification_token = 'tok', cleared_at = now(), cleared_reason = 'stale',
               last_check_status = 'fail', check_failures = 1
         WHERE id = ${id}`;
      await tx`UPDATE customer_email_domains SET org_id = ${b.orgId} WHERE id = ${id}`;
      expect(await rowOf(tx, id)).toMatchObject({
        verification_token: null,
        cleared_at: null,
        cleared_reason: null,
        last_check_status: null,
        check_failures: 0,
      });
    });
  });

  it('changing only is_active, auto_create_contact or updated_at keeps verification', async () => {
    const a = await newOrg();
    await inRolledBackTx(async (tx) => {
      const id = await seedVerified(tx, a);
      await tx`
        UPDATE customer_email_domains
           SET is_active = false, auto_create_contact = false, updated_at = now() + interval '1 minute'
         WHERE id = ${id}`;
      const row = await rowOf(tx, id);
      expect(row.verified_method).toBe('dns_txt');
      expect(row.verification_token).toBe('tok');
      expect(row.verified_at).not.toBeNull();
      expect(row.cleared_at).toBeNull();
    });
  });

  it('org merge keeps verification: an UPDATE of org_id with breeze.org_merge=on in the same transaction', async () => {
    const a = await newOrg();
    const b = await newOrg(a.partnerId);
    await inRolledBackTx(async (tx) => {
      const id = await seedVerified(tx, a);
      await tx`SELECT set_config('breeze.org_merge', 'on', true)`;
      await tx`UPDATE customer_email_domains SET org_id = ${b.orgId} WHERE id = ${id}`;
      const row = await rowOf(tx, id);
      expect(row.verified_method).toBe('dns_txt');
      expect(row.verification_token).toBe('tok');
      expect(row.verified_at).not.toBeNull();
      expect(row.cleared_reason).toBeNull();
    });
  });

  it('breeze.org_merge does not leak past the transaction', async () => {
    const a = await newOrg();
    const b = await newOrg(a.partnerId);
    const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const domain = domainName();
    try {
      // The committed table already carries the migration (setup migrates), so commit for real here.
      await client.begin(async (tx) => {
        await tx`SELECT set_config('breeze.org_merge', 'on', true)`;
      });
      const [setting] = await client<{ v: string | null }[]>`SELECT current_setting('breeze.org_merge', true) AS v`;
      expect(setting?.v ?? '').not.toBe('on');
      // A repoint on the same connection after that transaction is NOT exempt.
      await inRolledBackTx(async (tx) => {
        const id = await seedVerified(tx, a, domain);
        await tx`UPDATE customer_email_domains SET org_id = ${b.orgId} WHERE id = ${id}`;
        expect((await rowOf(tx, id)).cleared_reason).toBe('repointed');
      });
    } finally {
      await client.end({ timeout: 1 });
    }
  });

  it('deleting the verifying user nulls verified_by_user_id and keeps verification', async () => {
    const a = await newOrg();
    const user = await createUser({ partnerId: a.partnerId });
    await inRolledBackTx(async (tx) => {
      const id = await seedVerified(tx, a, domainName(), user.id);
      await tx`DELETE FROM users WHERE id = ${user.id}`;
      const row = await rowOf(tx, id);
      expect(row.verified_by_user_id).toBeNull();
      expect(row.verified_method).toBe('dns_txt');
      expect(row.verified_at).not.toBeNull();
    });
  });

  it('is idempotent: a second replay changes nothing', async () => {
    const a = await newOrg();
    await inRolledBackTx(async (tx) => {
      const id = await seedVerified(tx, a);
      const snapshot = async () => ({
        columns: await tx`
          SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'customer_email_domains' ORDER BY column_name`,
        checks: await tx`
          SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = 'public.customer_email_domains'::regclass ORDER BY conname`,
        indexes: await tx`
          SELECT indexname, indexdef FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'customer_email_domains' ORDER BY indexname`,
        triggers: await tx`
          SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.customer_email_domains'::regclass AND NOT tgisinternal ORDER BY tgname`,
        row: await rowOf(tx, id),
      });
      const first = await snapshot();
      await tx.unsafe(await loadMigration());
      expect(await snapshot()).toEqual(first);
    });
  });
});
