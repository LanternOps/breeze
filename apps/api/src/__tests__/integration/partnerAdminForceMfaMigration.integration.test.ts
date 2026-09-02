/**
 * Replays the RMM-QA-164 reconcile migration over real rows. globalSetup
 * applies it against an EMPTY roles table (the same reason 2026-05-25-f was
 * a no-op on fresh installs), so the reconcile itself is only exercised
 * here.
 *
 * Fixtures (all force_mfa = false):
 *   - global Partner Admin template          (is_system, partner_id NULL)  → flips
 *   - tenant Partner Admin copy + one member (is_system, partner_id set)   → flips, member epoch +1
 *   - custom same-name role                  (is_system = false)          → untouched
 *   - organization-scope system "Partner Admin" (scope != 'partner')      → untouched
 *   - global Org Admin template              (is_system, other name)      → untouched
 * Second apply: identical rows, epoch unchanged, "0 rows" notice.
 *
 * The migration's row count is its only observable for the
 * `force_mfa = false` predicate (the epoch trigger already ignores same-value
 * updates), so this file captures the Postgres notice stream with its own
 * client — setup.ts deliberately swallows notices — and asserts the count.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { roles, users } from '../../db/schema';
import { assignUserToPartner, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-09-30-110000-partner-admin-force-mfa-reconcile.sql',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Apply the migration as the schema owner and return every NOTICE/WARNING it raised. */
async function applyMigration(): Promise<string[]> {
  const notices: string[] = [];
  const client = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: (notice) => notices.push(String(notice.message ?? '')),
  });
  try {
    await client.unsafe(readFileSync(MIGRATION_FILE, 'utf8'));
  } finally {
    await client.end();
  }
  return notices;
}

async function forceMfaById(ids: string[]): Promise<Map<string, boolean>> {
  const rows = await getTestDb()
    .select({ id: roles.id, forceMfa: roles.forceMfa })
    .from(roles)
    .where(inArray(roles.id, ids));
  return new Map(rows.map((row) => [row.id, row.forceMfa]));
}

async function epochOf(userId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ permissionsEpoch: users.permissionsEpoch })
    .from(users)
    .where(eq(users.id, userId));
  return row!.permissionsEpoch;
}

describe('2026-09-30-110000 partner-admin force_mfa reconcile migration (RMM-QA-164)', () => {
  runDb('flips only system partner-scope Partner Admin rows, bumps member epochs once, and is idempotent', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const member = await createUser({ partnerId: partner.id });

    const inserted = await tdb
      .insert(roles)
      .values([
        { scope: 'partner', name: 'Partner Admin', isSystem: true, forceMfa: false },
        { partnerId: partner.id, scope: 'partner', name: 'Partner Admin', isSystem: true, forceMfa: false },
        { partnerId: partner.id, scope: 'partner', name: 'Partner Admin', isSystem: false, forceMfa: false },
        { scope: 'organization', name: 'Partner Admin', isSystem: true, forceMfa: false },
        { scope: 'organization', name: 'Org Admin', isSystem: true, forceMfa: false },
      ])
      .returning({ id: roles.id });
    const [template, tenantCopy, custom, orgScoped, orgAdmin] = inserted.map((row) => row.id);
    await assignUserToPartner(member.id, partner.id, tenantCopy!);
    const ids = [template!, tenantCopy!, custom!, orgScoped!, orgAdmin!];

    const epochBefore = await epochOf(member.id);

    const firstNotices = await applyMigration();
    expect(firstNotices.some((n) => /flipped 2 system Partner Admin role\(s\)/.test(n)), firstNotices.join(' | ')).toBe(true);

    const afterFirst = await forceMfaById(ids);
    expect(afterFirst.get(template!)).toBe(true);
    expect(afterFirst.get(tenantCopy!)).toBe(true);
    expect(afterFirst.get(custom!)).toBe(false);
    expect(afterFirst.get(orgScoped!)).toBe(false);
    expect(afterFirst.get(orgAdmin!)).toBe(false);
    expect(await epochOf(member.id)).toBe(epochBefore + 1);

    const secondNotices = await applyMigration();
    expect(secondNotices.some((n) => /0 rows needed flipping/.test(n)), secondNotices.join(' | ')).toBe(true);

    const afterSecond = await forceMfaById(ids);
    expect([...afterSecond.entries()]).toEqual([...afterFirst.entries()]);
    expect(await epochOf(member.id)).toBe(epochBefore + 1);
  });
});
