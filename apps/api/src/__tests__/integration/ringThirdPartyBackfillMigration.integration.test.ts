/**
 * Replays 2026-08-13-ring-third-party-auto-approve-backfill.sql against seeded
 * pre-backfill rings — the shapes production rows actually had before the
 * explicit thirdPartyApps field existed.
 *
 * CI databases are migrated schema-fresh in globalSetup, so the backfill's
 * DO-block would otherwise only ever run against zero rows. This suite seeds
 * the real pre-migration shapes, re-runs the migration file from disk, and
 * asserts the behaviours the expand/contract plan depends on:
 *
 *  - a converted third_party_app rule carries its deferralDaysOverride into
 *    thirdPartyDeferralDays;
 *  - a converted rule WITHOUT a usable override carries the ring's
 *    deferral_days COLUMN (the old category-path hold) — the fail-open bug
 *    class this test exists to pin: without the carry, converted rings
 *    auto-approve third-party updates immediately;
 *  - the pre-image guard: severities that belonged to a not-boolean-true
 *    enabled state (including the malformed {"enabled":"true"} string shape)
 *    are cleared, so flipping `enabled` on never silently enables OS
 *    auto-approval;
 *  - severity-derived thirdPartyApps stamping for enabled rows without rules;
 *  - autoApprove:false rules are stripped without enabling anything;
 *  - replay is a true no-op (idempotent).
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/ringThirdPartyBackfillMigration.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { patchPolicies } from '../../db/schema';
import { createPartner } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-08-13-ring-third-party-auto-approve-backfill.sql',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function runMigration() {
  await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
}

type SeededRing = { id: string; name: string };

async function seedRing(
  partnerId: string,
  name: string,
  row: {
    deferralDays: number;
    autoApprove: unknown;
    categoryRules?: unknown[];
  }
): Promise<SeededRing> {
  const db = getTestDb();
  const [ring] = await db
    .insert(patchPolicies)
    .values({
      partnerId,
      kind: 'ring',
      name,
      deferralDays: row.deferralDays,
      autoApprove: row.autoApprove,
      categoryRules: row.categoryRules ?? [],
    })
    .returning({ id: patchPolicies.id, name: patchPolicies.name });
  return ring!;
}

async function fetchRings(ids: string[]) {
  const db = getTestDb();
  const rows = await db
    .select({
      id: patchPolicies.id,
      autoApprove: patchPolicies.autoApprove,
      categoryRules: patchPolicies.categoryRules,
      deferralDays: patchPolicies.deferralDays,
    })
    .from(patchPolicies)
    .where(inArray(patchPolicies.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

describe('2026-08-13 ring third-party backfill migration', () => {
  runDb('backfills every pre-image shape correctly and is idempotent', async () => {
    const partner = await createPartner();
    const pid = partner!.id;

    // 1) Enabled ring, 3P allow rule WITH explicit deferralDaysOverride: the
    //    override wins; severities survive (pre-image was boolean-true
    //    enabled); the unrelated rule survives the strip.
    const withOverride = await seedRing(pid, 'bf-with-override', {
      deferralDays: 14,
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 3 },
      categoryRules: [
        { category: 'third_party_app', autoApprove: true, deferralDaysOverride: 30 },
        { category: 'security', autoApprove: true },
      ],
    });

    // 2) Legacy boolean-true auto_approve, 3P allow rule WITHOUT an override:
    //    the old category path held 3P patches for the ring's deferral_days
    //    COLUMN (14) — that value must be carried, not dropped to 0.
    const columnCarry = await seedRing(pid, 'bf-column-carry', {
      deferralDays: 14,
      autoApprove: true,
      categoryRules: [{ category: 'third_party_app', autoApprove: true }],
    });

    // 3) DISABLED ring with parked severities + 3P allow rule: the ring-level
    //    enable must not resurrect severities that belonged to a disabled
    //    state (pre-image guard), and the column hold (7) is carried.
    const disabledGuard = await seedRing(pid, 'bf-disabled-guard', {
      deferralDays: 7,
      autoApprove: { enabled: false, severities: ['critical', 'important'] },
      categoryRules: [{ category: 'third_party_app', autoApprove: true }],
    });

    // 4) Malformed {"enabled":"true"} STRING row + 3P allow rule: the jsonb
    //    boolean comparison must treat it as not-enabled and clear severities
    //    (the ->>'enabled' text form would wrongly preserve them).
    const stringEnabled = await seedRing(pid, 'bf-string-enabled', {
      deferralDays: 0,
      autoApprove: { enabled: 'true', severities: ['critical'] },
      categoryRules: [{ category: 'third_party_app', autoApprove: true }],
    });

    // 5) 3P allow rule whose override is out of range (999 > 365): falls back
    //    to the column carry (5), not to the invalid value and not to 0.
    const invalidOverride = await seedRing(pid, 'bf-invalid-override', {
      deferralDays: 5,
      autoApprove: true,
      categoryRules: [{ category: 'third_party_app', autoApprove: true, deferralDaysOverride: 999 }],
    });

    // 6) Enabled ring, recognized severities, NO rules: severity-derived
    //    thirdPartyApps stamp with inherit hold (statement 2).
    const derivedOn = await seedRing(pid, 'bf-derived-on', {
      deferralDays: 0,
      autoApprove: { enabled: true, severities: ['important'] },
    });

    // 7) Enabled ring, only unrecognized severities: derives to false.
    const derivedOff = await seedRing(pid, 'bf-derived-off', {
      deferralDays: 0,
      autoApprove: { enabled: true, severities: ['bogus'] },
    });

    // 8) autoApprove:false 3P rule only: stripped by statement 3, toggle stays
    //    derived (true here — severities exist), nothing else changes.
    const denyRuleOnly = await seedRing(pid, 'bf-deny-rule-only', {
      deferralDays: 9,
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 2 },
      categoryRules: [{ category: 'third_party_app', autoApprove: false }],
    });

    const ids = [
      withOverride.id,
      columnCarry.id,
      disabledGuard.id,
      stringEnabled.id,
      invalidOverride.id,
      derivedOn.id,
      derivedOff.id,
      denyRuleOnly.id,
    ];

    await runMigration();
    const after = await fetchRings(ids);

    expect(after.get(withOverride.id)!.autoApprove).toEqual({
      enabled: true,
      severities: ['critical'],
      deferralDays: 3,
      thirdPartyApps: true,
      thirdPartyDeferralDays: 30,
    });
    expect(after.get(withOverride.id)!.categoryRules).toEqual([
      { category: 'security', autoApprove: true },
    ]);

    expect(after.get(columnCarry.id)!.autoApprove).toEqual({
      enabled: true,
      severities: [],
      thirdPartyApps: true,
      thirdPartyDeferralDays: 14,
    });
    expect(after.get(columnCarry.id)!.categoryRules).toEqual([]);

    expect(after.get(disabledGuard.id)!.autoApprove).toEqual({
      enabled: true,
      severities: [],
      thirdPartyApps: true,
      thirdPartyDeferralDays: 7,
    });

    expect(after.get(stringEnabled.id)!.autoApprove).toEqual({
      enabled: true,
      severities: [],
      thirdPartyApps: true,
      thirdPartyDeferralDays: 0,
    });

    expect(after.get(invalidOverride.id)!.autoApprove).toEqual({
      enabled: true,
      severities: [],
      thirdPartyApps: true,
      thirdPartyDeferralDays: 5,
    });

    expect(after.get(derivedOn.id)!.autoApprove).toEqual({
      enabled: true,
      severities: ['important'],
      thirdPartyApps: true,
      thirdPartyDeferralDays: null,
    });

    expect(after.get(derivedOff.id)!.autoApprove).toEqual({
      enabled: true,
      severities: ['bogus'],
      thirdPartyApps: false,
      thirdPartyDeferralDays: null,
    });

    expect(after.get(denyRuleOnly.id)!.autoApprove).toEqual({
      enabled: true,
      severities: ['critical'],
      deferralDays: 2,
      thirdPartyApps: true,
      thirdPartyDeferralDays: null,
    });
    expect(after.get(denyRuleOnly.id)!.categoryRules).toEqual([]);

    // Idempotency: a replay must be a byte-for-byte no-op on every row.
    await runMigration();
    const replayed = await fetchRings(ids);
    for (const id of ids) {
      expect(replayed.get(id)).toEqual(after.get(id));
    }
  });
});
