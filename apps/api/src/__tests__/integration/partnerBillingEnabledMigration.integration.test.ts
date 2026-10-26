/**
 * Partner billing toggle PR 1 (spec 2026-10-16-partner-billing-enabled-design.md
 * §5.1-5.4, §11 "Migration"): real-DB proof of the partners.billing_enabled
 * migration. The column is dropped back to nullable/NULL, the migration is
 * replayed, and the backfill is checked against the §5.2 matrix.
 */
import './setup';
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { AR_OPEN_STATUSES } from '../../db/schema/invoices';
import { AUTOPAY_ENROLLMENT_STATUSES } from '@breeze/shared';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { replayMigration } from './replayMigration';

const FILE = '2027-01-05-120000-partner-billing-enabled.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '../../../migrations/', FILE), 'utf8');

type Mode = 'native' | 'external' | 'off';
const MODES: Mode[] = ['native', 'external', 'off'];

/** Scenario = what billing footprint a partner carries; `live` = the §5.2 "live billing" expectation. */
type Scenario = { label: string; live: boolean; seed: (partnerId: string, orgId: string) => Promise<void> };

async function seedInvoice(partnerId: string, orgId: string, status: string) {
  const n = randomUUID().slice(0, 8);
  await getTestDb().execute(sql`
    INSERT INTO invoices (org_id, partner_id, currency_code, status, invoice_number, issue_date, due_date, total, subtotal, balance)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, 'USD', ${status}::invoice_status, ${'INV-' + n}, '2026-10-01', '2026-10-31', 50.00, 50.00, 50.00)
  `);
}

async function seedEnrollment(partnerId: string, orgId: string, status: string) {
  const sfx = randomUUID();
  const [conn] = await getTestDb().execute(sql`
    INSERT INTO stripe_connect_accounts (partner_id, stripe_account_id, api_key, key_last4, status, livemode, account_country)
    VALUES (${partnerId}::uuid, ${'acct_' + sfx}, 'enc:synthetic', 'test', 'connected', false, 'US') RETURNING id
  `) as unknown as Array<{ id: string }>;
  await getTestDb().execute(sql`
    INSERT INTO org_autopay_enrollments
      (org_id, partner_id, status, generation, stripe_connection_id, stripe_account_id, effective_from, cancelled_at, cancel_source)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, ${status}::autopay_enrollment_status, 1, ${conn!.id}::uuid, ${'acct_' + sfx},
      ${status === 'active' ? sql`'2026-09-01'::timestamptz` : sql`NULL`},
      ${status === 'cancelled' ? sql`now()` : sql`NULL`},
      ${status === 'cancelled' ? sql`'msp'` : sql`NULL`})
  `);
}

async function seedContract(partnerId: string, orgId: string, status: string) {
  await getTestDb().execute(sql`
    INSERT INTO contracts (partner_id, org_id, name, interval_months, start_date, currency_code, status)
    VALUES (${partnerId}::uuid, ${orgId}::uuid, 'c', 1, '2026-07-01', 'USD', ${status}::contract_status)
  `);
}

const SCENARIOS: Scenario[] = [
  { label: 'no billing footprint', live: false, seed: async () => {} },
  { label: 'draft contract only', live: false, seed: (p, o) => seedContract(p, o, 'draft') },
  { label: 'cancelled contract only', live: false, seed: (p, o) => seedContract(p, o, 'cancelled') },
  { label: 'active contract', live: true, seed: (p, o) => seedContract(p, o, 'active') },
  { label: 'draft invoice only', live: false, seed: (p, o) => seedInvoice(p, o, 'draft') },
  ...AR_OPEN_STATUSES.map((s): Scenario => ({ label: `${s} invoice`, live: true, seed: (p, o) => seedInvoice(p, o, s) })),
  ...AUTOPAY_ENROLLMENT_STATUSES.filter((s) => s !== 'cancelled').map((s): Scenario => (
    { label: `${s} autopay enrolment`, live: true, seed: (p, o) => seedEnrollment(p, o, s) })),
  { label: 'cancelled autopay enrolment only', live: false, seed: (p, o) => seedEnrollment(p, o, 'cancelled') },
];

async function seedMatrix() {
  const rows: Array<{ id: string; mode: Mode; scenario: Scenario }> = [];
  for (const mode of MODES) {
    for (const scenario of SCENARIOS) {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      if (mode === 'external') {
        // partners_service_management_connection_chk: external <=> a PSA connection id.
        const [conn] = await getTestDb().execute(sql`
          INSERT INTO psa_connections (partner_id, org_id, provider, name, credentials)
          VALUES (${partner.id}::uuid, NULL, 'halo', 'psa', '{}'::jsonb) RETURNING id
        `) as unknown as Array<{ id: string }>;
        await getTestDb().execute(sql`
          UPDATE partners SET service_management_mode = 'external', service_management_psa_connection_id = ${conn!.id}::uuid
          WHERE id = ${partner.id}::uuid`);
      } else {
        await getTestDb().execute(sql`UPDATE partners SET service_management_mode = ${mode} WHERE id = ${partner.id}::uuid`);
      }
      await scenario.seed(partner.id, org.id);
      rows.push({ id: partner.id, mode, scenario });
    }
  }
  return rows;
}

async function resetToLegacyShape(ids: string[]) {
  const db = getTestDb();
  await db.execute(sql`ALTER TABLE partners ALTER COLUMN billing_enabled DROP NOT NULL`);
  await db.execute(sql`ALTER TABLE partners ALTER COLUMN billing_enabled DROP DEFAULT`);
  await db.execute(sql`UPDATE partners SET billing_enabled = NULL WHERE id = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'`).join(',')}]::uuid[]`)})`);
}

async function valueOf(id: string): Promise<boolean | null> {
  const [r] = await getTestDb().execute(sql`SELECT billing_enabled FROM partners WHERE id = ${id}::uuid`) as unknown as Array<{ billing_enabled: boolean | null }>;
  return r!.billing_enabled;
}

describe('partners.billing_enabled migration (real DB) spec §5', () => {
  it('§5.2: backfill is true for native or live billing, false otherwise, across the full mode x scenario matrix', async () => {
    const rows = await seedMatrix();
    await resetToLegacyShape(rows.map((r) => r.id));
    await replayMigration(FILE);
    for (const r of rows) {
      const expected = r.mode === 'native' || r.scenario.live;
      expect(await valueOf(r.id), `${r.mode} / ${r.scenario.label}`).toBe(expected);
    }
  });

  it('§5.3: ends NOT NULL with DEFAULT true, and a new partner inherits true', async () => {
    await replayMigration(FILE);
    const [col] = await getTestDb().execute(sql`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'partners' AND column_name = 'billing_enabled'
    `) as unknown as Array<{ is_nullable: string; column_default: string }>;
    expect(col).toEqual({ is_nullable: 'NO', column_default: 'true' });
    const p = await createPartner();
    expect(await valueOf(p.id)).toBe(true);
  });

  it('§5 / §11: a re-run keeps an admin-changed value (backfill touches only NULL rows)', async () => {
    const rows = await seedMatrix();
    await resetToLegacyShape(rows.map((r) => r.id));
    await replayMigration(FILE);
    // Admin flips an external/no-footprint partner on and a native partner off.
    const ext = rows.find((r) => r.mode === 'external' && !r.scenario.live)!;
    const nat = rows.find((r) => r.mode === 'native')!;
    await getTestDb().execute(sql`UPDATE partners SET billing_enabled = true WHERE id = ${ext.id}::uuid`);
    await getTestDb().execute(sql`UPDATE partners SET billing_enabled = false WHERE id = ${nat.id}::uuid`);
    await replayMigration(FILE);
    expect(await valueOf(ext.id)).toBe(true);
    expect(await valueOf(nat.id)).toBe(false);
  });

  it('§5.4: the backfill is not blinded by FORCE RLS for a non-bypass role (system scope elected first)', async () => {
    const rows = await seedMatrix();
    await resetToLegacyShape(rows.map((r) => r.id));
    const ids = rows.map((r) => r.id);
    // The backfill block + scope election only (ALTERs need ownership, not RLS).
    const scope = MIGRATION_SQL.match(/SELECT set_config\('breeze\.scope', 'system', true\);/)![0];
    const doBlock = MIGRATION_SQL.match(/DO \$\$[\s\S]*?END \$\$;/)![0];

    // Negative control: as breeze_app WITHOUT system scope the UPDATE matches zero rows silently.
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE breeze_app`);
      await tx.execute(sql.raw(doBlock));
    });
    for (const id of ids) expect(await valueOf(id), 'control: untouched without system scope').toBeNull();

    // Real path: same role, scope elected first.
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE breeze_app`);
      await tx.execute(sql.raw(scope));
      await tx.execute(sql.raw(doBlock));
    });
    for (const r of rows) {
      expect(await valueOf(r.id), `${r.mode} / ${r.scenario.label} as breeze_app`).toBe(r.mode === 'native' || r.scenario.live);
    }
  });

  // resetToLegacyShape drops NOT NULL/DEFAULT; restore them so later files in the shard see the final shape.
  afterAll(async () => {
    await replayMigration(FILE);
  });
});
