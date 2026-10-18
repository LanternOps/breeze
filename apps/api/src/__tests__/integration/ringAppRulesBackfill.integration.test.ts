/**
 * Replays 2026-12-26-230000-ring-app-rules-backfill.sql (#8184 W02, #8186)
 * against seeded pre-backfill rows.
 *
 * The migration moves per-app block/pin rules from configuration-policy patch
 * links (`inline_settings->'apps'`) onto Update Rings (`patch_policies.app_rules`)
 * without changing the rule set ANY policy enforces:
 *
 *  - A  ring-less link with rules → a new ring (auto_approve '{}', approves
 *       nothing) carrying the rules; the link is relinked to it.
 *  - B  a ring whose every rule-carrying linker has the same set → the ring
 *       gets that set; no clone.
 *  - C  a ring shared by linkers with different sets → the ring keeps the set
 *       of its rule-less linkers (else the most common set); every other set
 *       gets a full-column clone of the ring with its ring-scoped approvals.
 *  - D  invalid ring references (missing, another partner's ring) → untouched;
 *       W02 makes those policies fail closed at read time.
 *  - a ring that already carries DIFFERENT rules → the migration aborts.
 *  - the SQL normaliser equals the runtime salvage of that release
 *    (`normalizeStoredInlineSettingsWithSalvage`, frozen below as
 *    `w02RuntimeSalvagedApps` since #8188 retired it) entry for entry.
 *  - policy-level auto-approve is never converted into a ring.
 *  - a second run writes nothing and every write count reports 0.
 *
 * The file is replayed as a dedicated NOSUPERUSER NOBYPASSRLS migrator role
 * (deliberately not `breeze_app`, which may not call the partner-export lock
 * functions) holding only the privileges a table-owning migrator has on what
 * the file touches, so FORCE RLS is in effect as on a managed-Postgres or
 * self-hosted non-bypass install. Fixtures are seeded and read back through
 * the superuser test connection.
 *
 * #8188 (W04) dropped `config_policy_patch_settings.auto_approve`, which this
 * file's step 4 reads. On a fresh install the backfill runs before that drop;
 * the replay here re-creates the column inside the replay transaction (and
 * drops it again before commit) so the shipped file runs against the schema it
 * was written for, without the shared test database ever seeing the column.
 *
 * Run:
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/ringAppRulesBackfill.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalAppRuleKey } from '@breeze/shared/validators';
import {
  configPolicyFeatureLinks,
  configurationPolicies,
  patchApprovals,
  patches,
  patchPolicies,
} from '../../db/schema';
import { Hono } from 'hono';
import { createAccessToken } from '../../services/jwt';
import { configPolicyRoutes } from '../../routes/configurationPolicies';
import { createOrganization, createPartner, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { withSystemDbAccessContext } from '../../db';
import { loadPolicyLocalPatchConfig } from '../../services/configPolicyPatching';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-12-26-230000-ring-app-rules-backfill.sql',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Write counters the migration reports; each must be 0 on a re-run. */
const WRITE_METRICS = [
  'rings_created_for_ringless_links',
  'ringless_links_relinked',
  'shared_rings_rules_set',
  'clone_rings_created',
  'clone_approvals_copied',
  'clone_links_relinked',
] as const;

const MIGRATOR = 'breeze_test_ring_rules_migrator';

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
          CREATE ROLE ${MIGRATOR} NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
        EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO ${MIGRATOR}', current_database());
      END $$;
    `);
    // The privileges a table-owning migrator has on everything the file touches.
    await admin.unsafe(`
      GRANT USAGE ON SCHEMA public TO ${MIGRATOR};
      GRANT SELECT, INSERT, UPDATE ON public.patch_policies, public.patch_approvals TO ${MIGRATOR};
      GRANT SELECT, UPDATE ON public.config_policy_feature_links, public.partners, public.organizations TO ${MIGRATOR};
      GRANT SELECT ON public.configuration_policies, public.config_policy_patch_settings TO ${MIGRATOR};
      GRANT EXECUTE ON FUNCTION public.breeze_partner_export_lock_partners_exclusive(uuid[]) TO ${MIGRATOR};
      GRANT EXECUTE ON FUNCTION public.breeze_partner_export_lock_orgs_under_exclusive_partners(uuid[], uuid[]) TO ${MIGRATOR};
    `);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
          EXECUTE 'DROP OWNED BY ${MIGRATOR}';
          EXECUTE 'DROP ROLE ${MIGRATOR}';
        END IF;
      END $$;
    `);
  } finally {
    await admin.end();
  }
});

/** Apply the migration as the non-bypass migrator and return the parsed `metric=n` warnings. */
async function applyMigration(): Promise<{ metrics: Map<string, number>; notices: string[] }> {
  const notices: string[] = [];
  const client = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: (notice) => notices.push(String(notice.message ?? '')),
  });
  try {
    await client.begin(async (tx) => {
      // Pre-#8188 schema shim (see the file header): plain ADD so a database
      // that still has the column fails loudly instead of being altered.
      await tx.unsafe('ALTER TABLE public.config_policy_patch_settings ADD COLUMN auto_approve boolean NOT NULL DEFAULT false');
      await tx.unsafe(`SET LOCAL ROLE ${MIGRATOR}`);
      const [role] = await tx.unsafe<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>(
        'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      // Precondition: the replay must not bypass RLS, or a missing system-scope
      // election would read green here and match zero rows in production.
      expect(role).toEqual({ rolname: MIGRATOR, rolsuper: false, rolbypassrls: false });
      await tx.unsafe(readFileSync(MIGRATION_FILE, 'utf8'));
      await tx.unsafe('RESET ROLE');
      await tx.unsafe('ALTER TABLE public.config_policy_patch_settings DROP COLUMN auto_approve');
    });
  } finally {
    await client.end();
  }
  const metrics = new Map<string, number>();
  for (const n of notices) {
    const m = /^ring_app_rules_backfill (\w+)=(\d+)$/.exec(n);
    if (m) metrics.set(m[1]!, Number(m[2]));
  }
  return { metrics, notices };
}

type Rule = Record<string, unknown>;

/**
 * `policyAppRuleSchema` as it stood when this migration shipped, copied so a
 * later ring-side change to the live schema cannot redden a comparison
 * against SQL that can no longer change.
 */
const W02_APP_RULE_SCHEMA = z.object({
  source: z.enum(['third_party', 'custom']),
  packageId: z.string().min(1).max(256),
  displayName: z.string().max(255).optional(),
  action: z.enum(['block', 'pin']),
  pinnedVersion: z.string().min(1).max(64).optional(),
}).refine((r) => r.action !== 'pin' || !!r.pinnedVersion);

/** W02-era canonical key: third_party/custom share a bucket, id lowercased. */
function w02AppRuleKey(source: string, packageId: string): string {
  return `${source === 'custom' ? 'third_party' : source}|${packageId.toLowerCase()}`;
}

/**
 * The runtime's per-entry `apps` salvage as it shipped with this migration
 * (configPolicyPatching.normalizeStoredInlineSettingsWithSalvage, retired by
 * #8188): first valid entry per canonical key wins, invalid entries are
 * dropped whole, capped at 200. When the whole document parsed, the result
 * was the same list, so the per-entry form is the complete reference.
 */
function w02RuntimeSalvagedApps(inline: unknown): Rule[] {
  const raw = inline && typeof inline === 'object' && !Array.isArray(inline)
    ? (inline as Record<string, unknown>).apps
    : undefined;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Rule[] = [];
  for (const entry of raw) {
    const parsed = W02_APP_RULE_SCHEMA.safeParse(entry);
    if (!parsed.success) continue;
    const key = w02AppRuleKey(parsed.data.source, parsed.data.packageId);
    if (seen.has(key) || out.length >= 200) continue;
    seen.add(key);
    out.push(parsed.data);
  }
  return out;
}

async function seedPolicy(opts: { orgId?: string | null; partnerId?: string | null; name: string }) {
  const [row] = await getTestDb()
    .insert(configurationPolicies)
    .values({ orgId: opts.orgId ?? null, partnerId: opts.partnerId ?? null, name: opts.name })
    .returning({ id: configurationPolicies.id });
  return row!.id;
}

async function seedLink(policyId: string, ringId: string | null, inline: Record<string, unknown>) {
  const [row] = await getTestDb()
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policyId, featureType: 'patch', featurePolicyId: ringId, inlineSettings: inline })
    .returning({ id: configPolicyFeatureLinks.id });
  return row!.id;
}

/**
 * Invalid references cannot be written through the feature-reference
 * validators, but legacy rows carrying them exist. Seed them with triggers
 * suppressed on a dedicated superuser connection.
 */
async function seedLinkBypassingReferenceTriggers(policyId: string, ref: string, inline: Record<string, unknown>) {
  const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const id = randomUUID();
    await admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL session_replication_role = replica`);
      await tx.unsafe(
        `INSERT INTO config_policy_feature_links (id, config_policy_id, feature_type, feature_policy_id, inline_settings)
         VALUES ($1, $2, 'patch', $3, $4::text::jsonb)`,
        [id, policyId, ref, JSON.stringify(inline)],
      );
    });
    return id;
  } finally {
    await admin.end();
  }
}

async function seedRing(partnerId: string, name: string, extra: Partial<typeof patchPolicies.$inferInsert> = {}) {
  const [row] = await getTestDb()
    .insert(patchPolicies)
    .values({ partnerId, kind: 'ring', name, ...extra })
    .returning({ id: patchPolicies.id });
  return row!.id;
}

async function seedPatch(externalId: string) {
  const [row] = await getTestDb()
    .insert(patches)
    .values({ source: 'microsoft', externalId, title: externalId })
    .returning({ id: patches.id });
  return row!.id;
}

async function linkTarget(linkId: string): Promise<string | null> {
  const [row] = await getTestDb()
    .select({ ref: configPolicyFeatureLinks.featurePolicyId })
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.id, linkId));
  return row!.ref;
}

async function ringRow(id: string) {
  const rows = await getTestDb().execute(sql`SELECT to_jsonb(p) AS r FROM patch_policies p WHERE p.id = ${id}`);
  return (rows as unknown as Array<{ r: Record<string, unknown> }>)[0]!.r;
}

async function ringsOf(partnerId: string) {
  return getTestDb()
    .select({ id: patchPolicies.id, name: patchPolicies.name, appRules: patchPolicies.appRules })
    .from(patchPolicies)
    .where(eq(patchPolicies.partnerId, partnerId));
}

/** Canonical comparison form: sorted by key, display fields kept. */
function canonical(rules: unknown): Rule[] {
  return [...(rules as Rule[])].sort((a, b) =>
    canonicalAppRuleKey(String(a.source), String(a.packageId))
      .localeCompare(canonicalAppRuleKey(String(b.source), String(b.packageId))),
  );
}

function ruleKeys(rules: unknown): string[] {
  return (rules as Rule[])
    .map((r) => `${canonicalAppRuleKey(String(r.source), String(r.packageId))}:${r.action}:${r.action === 'pin' ? r.pinnedVersion : ''}`)
    .sort();
}

/** Full-state fingerprint for the idempotency check. */
async function stateFingerprint() {
  const tdb = getTestDb();
  const rings = await tdb.execute(sql`SELECT id, app_rules, updated_at FROM patch_policies ORDER BY id`);
  const links = await tdb.execute(sql`SELECT id, feature_policy_id, updated_at FROM config_policy_feature_links ORDER BY id`);
  const approvals = await tdb.execute(sql`SELECT id, ring_id, status FROM patch_approvals ORDER BY id`);
  return JSON.stringify({ rings, links, approvals });
}

/** Columns a clone must carry over unchanged from its source ring. */
const CLONE_EXCLUDED_COLUMNS = new Set(['id', 'name', 'app_rules', 'created_at', 'updated_at']);

describe('2026-12-26-230000 ring app-rules backfill migration (#8186)', () => {
  runDb('moves rules A/A′/B/C onto rings, leaves D, never converts policy auto-approve, matches salvage, and is idempotent', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const P = partner!.id;
    const O1 = (await createOrganization({ partnerId: P }))!.id;
    const O2 = (await createOrganization({ partnerId: P }))!.id;
    const other = await createPartner();
    const Q = other!.id;

    const firefoxBlock: Rule = { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' };

    // ---- A: org policy, ring-less link with rules ----
    const polA = await seedPolicy({ orgId: O1, name: 'Workstations A' });
    const linkA = await seedLink(polA, null, { sources: ['os', 'third_party'], apps: [firefoxBlock] });

    // ---- A′: partner-wide policy, ring-less, with rules ----
    const polA2 = await seedPolicy({ partnerId: P, name: 'Partner-wide A2' });
    const linkA2 = await seedLink(polA2, null, {
      apps: [{ source: 'custom', packageId: 'Foo.Tool', action: 'pin', pinnedVersion: '2.0' }],
    });

    // ---- B: shared ring, same set in different order / case ----
    const R1 = await seedRing(P, 'Ring B');
    const polB1 = await seedPolicy({ orgId: O1, name: 'B1' });
    const polB2 = await seedPolicy({ orgId: O2, name: 'B2' });
    const linkB1 = await seedLink(polB1, R1, {
      apps: [
        { source: 'third_party', packageId: 'Zoom.Zoom', action: 'block' },
        { source: 'third_party', packageId: '7zip.7zip', action: 'pin', pinnedVersion: '23.01' },
      ],
    });
    const linkB2 = await seedLink(polB2, R1, {
      apps: [
        { source: 'custom', packageId: '7ZIP.7zip', action: 'pin', pinnedVersion: '23.01' },
        { source: 'custom', packageId: 'zoom.zoom', action: 'block' },
      ],
    });

    // ---- C: shared ring, a rule-less linker and two different sets ----
    const R2 = await seedRing(P, 'Ring C', {
      description: 'pilot ring',
      enabled: false,
      targets: { deviceGroupIds: ['g1'] },
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 2 },
      schedule: { window: 'nightly' },
      rebootPolicy: { mode: 'if_required' },
      rollbackOnFailure: true,
      notifyOnComplete: true,
      ringOrder: 3,
      deferralDays: 7,
      deadlineDays: 14,
      gracePeriodHours: 9,
      categories: ['security'],
      excludeCategories: ['drivers'],
      categoryRules: [{ category: 'security', autoApprove: true }],
    });
    const polC1 = await seedPolicy({ orgId: O1, name: 'C1 no rules' });
    const polC2 = await seedPolicy({ orgId: O1, name: 'C2 blocks X' });
    const polC3 = await seedPolicy({ orgId: O2, name: 'C3 pins Y' });
    const linkC1 = await seedLink(polC1, R2, { sources: ['os'] });
    const linkC2 = await seedLink(polC2, R2, { apps: [{ source: 'third_party', packageId: 'Vendor.X', action: 'block' }] });
    // A second policy with C2's set, so the rule-carrying set OUTNUMBERS the
    // rule-less one: the rule-less linker must still keep the ring.
    const polC2b = await seedPolicy({ orgId: O2, name: 'C2b blocks X too' });
    const linkC2b = await seedLink(polC2b, R2, { apps: [{ source: 'custom', packageId: 'vendor.x', action: 'block' }] });
    const linkC3 = await seedLink(polC3, R2, {
      apps: [{ source: 'third_party', packageId: 'Vendor.Y', action: 'pin', pinnedVersion: '1.0' }],
    });
    const patchRingScoped = await seedPatch(`KB-${randomUUID()}`);
    const patchPartnerWide = await seedPatch(`KB-${randomUUID()}`);
    await tdb.insert(patchApprovals).values([
      { partnerId: P, patchId: patchRingScoped, ringId: R2, status: 'approved', approvedAt: new Date(), notes: 'ring C approval' },
      { partnerId: P, patchId: patchPartnerWide, ringId: null, status: 'approved', approvedAt: new Date() },
    ]);

    // A linker whose apps are ALL invalid enforces nothing at runtime: it is
    // a rule-less linker and must stay on R2.
    const polC6 = await seedPolicy({ orgId: O2, name: 'C6 only invalid rules' });
    const linkC6 = await seedLink(polC6, R2, {
      apps: [{ source: 'winget', packageId: 'Vendor.Z', action: 'block' }, { source: 'third_party', packageId: 'Vendor.Z', action: 'pin' }],
    });

    // ---- C′: shared ring, no rule-less linker → the most common set stays ----
    const R4 = await seedRing(P, 'Ring C prime');
    const polC4a = await seedPolicy({ orgId: O1, name: 'C4a' });
    const polC4b = await seedPolicy({ orgId: O2, name: 'C4b' });
    const polC5 = await seedPolicy({ orgId: O1, name: 'C5' });
    const blockX = [{ source: 'third_party', packageId: 'Vendor.X', action: 'block' }];
    const linkC4a = await seedLink(polC4a, R4, { apps: blockX });
    const linkC4b = await seedLink(polC4b, R4, { apps: blockX });
    const linkC5 = await seedLink(polC5, R4, { apps: [{ source: 'third_party', packageId: 'Vendor.Y', action: 'block' }] });

    // ---- D: invalid references, with rules ----
    const RQ = await seedRing(Q, 'Other partner ring');
    const polD1 = await seedPolicy({ orgId: O1, name: 'D1 missing ring' });
    const polD2 = await seedPolicy({ orgId: O1, name: 'D2 foreign ring' });
    const missingRef = randomUUID();
    const linkD1 = await seedLinkBypassingReferenceTriggers(polD1, missingRef, { apps: [firefoxBlock] });
    const linkD2 = await seedLinkBypassingReferenceTriggers(polD2, RQ, { apps: [firefoxBlock] });

    // ---- policy auto-approve, ring-less, no rules → no ring ----
    const polAuto = await seedPolicy({ orgId: O2, name: 'Auto on, no ring' });
    const linkAuto = await seedLink(polAuto, null, { autoApprove: true, autoApproveSeverities: ['critical'] });

    // ---- ring-less links whose apps enforce nothing → no ring ----
    const polJunk = await seedPolicy({ orgId: O1, name: 'Only invalid rules' });
    const linkJunk = await seedLink(polJunk, null, {
      apps: [{ source: 'third_party', packageId: 123, action: 'block' }, 'not-an-object'],
    });
    const polNotArray = await seedPolicy({ orgId: O2, name: 'apps not an array' });
    const linkNotArray = await seedLink(polNotArray, null, { apps: { source: 'third_party', packageId: 'X', action: 'block' } });

    // ---- length-boundary parity: each bad field drops the whole entry ----
    const polEdge = await seedPolicy({ orgId: O1, name: 'Length edges' });
    const edgeInline = {
      apps: [
        { source: 'third_party', packageId: 'Edge.EmptyPin', action: 'pin', pinnedVersion: '' },
        { source: 'third_party', packageId: 'Edge.LongPin', action: 'pin', pinnedVersion: 'v'.repeat(65) },
        { source: 'third_party', packageId: 'p'.repeat(257), action: 'block' },
        { source: 'third_party', packageId: 'p'.repeat(256), action: 'block' },
        { source: 'custom', packageId: '   ', action: 'block' },
        { source: 'third_party', packageId: 'Edge.Pin64', action: 'pin', pinnedVersion: 'v'.repeat(64) },
      ],
    };
    const linkEdge = await seedLink(polEdge, null, edgeInline);

    // ---- salvage parity ----
    const salvageInline = {
      sources: ['os'],
      // An unrelated invalid field forces the whole-document salvage path.
      scheduleTime: '2:00',
      apps: [
        { source: 'third_party', packageId: 'Foo.App', action: 'block' },
        // duplicate canonical key — the FIRST valid entry (the block) wins
        { source: 'custom', packageId: 'foo.app', action: 'pin', pinnedVersion: '1.0' },
        // pin without a version — invalid, dropped whole
        { source: 'third_party', packageId: 'Bar.App', action: 'pin' },
        // unknown source — invalid
        { source: 'winget', packageId: 'Baz.App', action: 'block' },
        // over-long displayName — invalid, dropped whole
        { source: 'third_party', packageId: 'Long.Name', action: 'block', displayName: 'x'.repeat(300) },
        // 128 astral chars = 256 UTF-16 code units > 255 — invalid in zod
        { source: 'third_party', packageId: 'Emoji.Name', action: 'block', displayName: '\u{1F600}'.repeat(128) },
        // numeric packageId — invalid
        { source: 'third_party', packageId: 12345, action: 'block' },
        // null displayName — invalid (optional, not nullable)
        { source: 'third_party', packageId: 'Null.Name', action: 'block', displayName: null },
        // unknown keys stripped; displayName kept; a block keeps a stray version
        { source: 'custom', packageId: 'Kept.App', action: 'block', displayName: 'Kept', pinnedVersion: '9', extra: true },
        // a later valid entry after invalid ones survives
        { source: 'third_party', packageId: 'Qux.App', action: 'pin', pinnedVersion: '3.1.4' },
        'not-an-object',
      ],
    };
    const polS = await seedPolicy({ orgId: O1, name: 'Salvage' });
    const linkS = await seedLink(polS, null, salvageInline);

    const manyApps: unknown[] = [];
    for (let i = 0; i < 205; i++) {
      manyApps.push(
        i === 3
          ? { source: 'third_party', packageId: '', action: 'block' } // invalid: empty packageId
          : { source: 'third_party', packageId: `Pkg.${String(i).padStart(3, '0')}`, action: 'block' },
      );
    }
    const polCap = await seedPolicy({ orgId: O2, name: 'Cap' });
    const linkCap = await seedLink(polCap, null, { apps: manyApps });

    const ringsBefore = await ringsOf(P);
    const rqBefore = await ringRow(RQ);

    // ===== first run =====
    const first = await applyMigration();

    // A
    const ringA = await linkTarget(linkA);
    expect(ringA).not.toBeNull();
    const rowA = await ringRow(ringA!);
    expect(rowA.partner_id).toBe(P);
    expect(rowA.kind).toBe('ring');
    expect(rowA.auto_approve).toEqual({});
    expect(rowA.name).toBe('Workstations A — app rules');
    expect(rowA.app_rules).toEqual([firefoxBlock]);

    // A′
    const ringA2 = await linkTarget(linkA2);
    expect(ringA2).not.toBeNull();
    const rowA2 = await ringRow(ringA2!);
    expect(rowA2.partner_id).toBe(P);
    expect(rowA2.auto_approve).toEqual({});
    expect(rowA2.app_rules).toEqual([{ source: 'custom', packageId: 'Foo.Tool', action: 'pin', pinnedVersion: '2.0' }]);

    // B
    expect(await linkTarget(linkB1)).toBe(R1);
    expect(await linkTarget(linkB2)).toBe(R1);
    expect(ruleKeys((await ringRow(R1)).app_rules)).toEqual([
      'third_party|7zip.7zip:pin:23.01',
      'third_party|zoom.zoom:block:',
    ]);

    // C
    const r2After = await ringRow(R2);
    expect(r2After.app_rules).toEqual([]);
    expect(await linkTarget(linkC1)).toBe(R2);
    const cloneC2 = (await linkTarget(linkC2))!;
    const cloneC3 = (await linkTarget(linkC3))!;
    expect(await linkTarget(linkC2b)).toBe(cloneC2);
    expect(new Set([R2, cloneC2, cloneC3]).size).toBe(3);
    // A clone is named after the policy of its group's first link (uuid order).
    const c2Name = linkC2 < linkC2b ? 'C2 blocks X' : 'C2b blocks X too';
    for (const [cloneId, policyName, rules] of [
      [cloneC2, c2Name, [{ source: 'third_party', packageId: 'Vendor.X', action: 'block' }]],
      [cloneC3, 'C3 pins Y', [{ source: 'third_party', packageId: 'Vendor.Y', action: 'pin', pinnedVersion: '1.0' }]],
    ] as const) {
      const clone = await ringRow(cloneId);
      expect(clone.name).toBe(`Ring C — ${policyName}`);
      // The group's set, in the first link's spelling.
      expect(ruleKeys(clone.app_rules)).toEqual(ruleKeys(rules));
      // Every other column — including any added after this test was
      // written — is copied from the source ring.
      for (const [col, value] of Object.entries(r2After)) {
        if (CLONE_EXCLUDED_COLUMNS.has(col)) continue;
        expect(clone[col], `clone column ${col}`).toEqual(value);
      }
      const approvals = await tdb
        .select({ patchId: patchApprovals.patchId, status: patchApprovals.status, partnerId: patchApprovals.partnerId, notes: patchApprovals.notes })
        .from(patchApprovals)
        .where(eq(patchApprovals.ringId, cloneId));
      expect(approvals).toEqual([{ patchId: patchRingScoped, status: 'approved', partnerId: P, notes: 'ring C approval' }]);
    }
    // The partner-wide approval is not ring-scoped and is not copied.
    const partnerWide = await tdb.select({ id: patchApprovals.id }).from(patchApprovals)
      .where(eq(patchApprovals.patchId, patchPartnerWide));
    expect(partnerWide).toHaveLength(1);

    // C′
    expect(await linkTarget(linkC4a)).toBe(R4);
    expect(await linkTarget(linkC4b)).toBe(R4);
    expect((await ringRow(R4)).app_rules).toEqual(blockX);
    const cloneC5 = (await linkTarget(linkC5))!;
    expect(cloneC5).not.toBe(R4);
    expect((await ringRow(cloneC5)).app_rules).toEqual([{ source: 'third_party', packageId: 'Vendor.Y', action: 'block' }]);

    // D: untouched (and the seed really carried rules)
    const [d1Inline] = await tdb.select({ inline: configPolicyFeatureLinks.inlineSettings }).from(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.id, linkD1));
    expect(d1Inline!.inline).toEqual({ apps: [firefoxBlock] });
    expect(await linkTarget(linkD1)).toBe(missingRef);
    expect(await linkTarget(linkD2)).toBe(RQ);
    expect(await ringRow(RQ)).toEqual(rqBefore);

    // policy auto-approve is reported, never converted
    expect(await linkTarget(linkAuto)).toBeNull();
    expect(first.metrics.get('ringless_links_with_policy_auto_approve')).toBe(1);

    // salvage parity: the ring carries exactly what the runtime enforced
    for (const [linkId, inline] of [[linkS, salvageInline], [linkCap, { apps: manyApps }], [linkEdge, edgeInline]] as const) {
      const ring = (await linkTarget(linkId))!;
      expect(ring).not.toBeNull();
      const expected = w02RuntimeSalvagedApps(inline);
      const actual = (await ringRow(ring)).app_rules;
      expect(canonical(actual)).toEqual(canonical(expected));
    }
    const salvageRing = (await ringRow((await linkTarget(linkS))!)).app_rules as Rule[];
    expect(ruleKeys(salvageRing)).toEqual([
      'third_party|foo.app:block:',
      'third_party|kept.app:block:',
      'third_party|qux.app:pin:3.1.4',
    ]);
    expect((await ringRow((await linkTarget(linkCap))!)).app_rules as Rule[]).toHaveLength(200);

    // Links whose apps enforce nothing are untouched: no ring, no clone.
    expect(await linkTarget(linkJunk)).toBeNull();
    expect(await linkTarget(linkNotArray)).toBeNull();
    expect(await linkTarget(linkC6)).toBe(R2);
    // Edge parity, explicitly: only the 256-char id, the whitespace id and the 64-char pin survive.
    expect((await ringRow((await linkTarget(linkEdge))!)).app_rules as Rule[]).toHaveLength(3);

    // Ring accounting: A, A′, salvage, cap, edge (5 new) + C (2 clones) + C′ (1 clone).
    const ringsAfter = await ringsOf(P);
    expect(ringsAfter.length - ringsBefore.length).toBe(8);
    expect(first.metrics.get('rings_created_for_ringless_links')).toBe(5);
    expect(first.metrics.get('ringless_links_relinked')).toBe(5);
    expect(first.metrics.get('shared_rings_rules_set')).toBe(2); // R1 (B) and R4 (C′)
    expect(first.metrics.get('clone_rings_created')).toBe(3);
    expect(first.metrics.get('clone_approvals_copied')).toBe(2);
    expect(first.metrics.get('clone_links_relinked')).toBe(4);
    expect(first.metrics.get('links_skipped_invalid_ring_reference')).toBe(2);
    expect(first.metrics.get('links_already_carried_by_ring')).toBe(0);

    // ===== second run: a true no-op =====
    const before = await stateFingerprint();
    const second = await applyMigration();
    expect(await stateFingerprint()).toBe(before);
    for (const metric of WRITE_METRICS) {
      expect(second.metrics.get(metric), `${metric} on re-run (${second.notices.join(' | ')})`).toBe(0);
    }
    // Every processed link is now recognised as already carried by its ring.
    expect(second.metrics.get('links_already_carried_by_ring')).toBe(5 + 2 + 3 + 3); // ring-less (A, A′, salvage, cap, edge) + B + C + C′
  });

  runDb('aborts on a non-ASCII package id rather than risk a case-folding mismatch with the runtime', async () => {
    // JS toLowerCase is locale-independent full Unicode folding; PostgreSQL's
    // lower() follows the database locale (e.g. 'İ' and 'i' fold together
    // under libc en_US but not in JS), so a non-ASCII id cannot be grouped or
    // de-duplicated with certainty. The migration folds ASCII only and stops.
    const partner = await createPartner();
    const P = partner!.id;
    const O1 = (await createOrganization({ partnerId: P }))!.id;
    const pol = await seedPolicy({ orgId: O1, name: 'Non-ASCII' });
    const link = await seedLink(pol, null, {
      apps: [
        { source: 'third_party', packageId: '\u0130nstaller.Tool', action: 'block' },
        { source: 'third_party', packageId: 'installer.tool', action: 'block' },
      ],
    });
    const ringCountBefore = (await ringsOf(P)).length;
    try {
      await expect(applyMigration()).rejects.toThrow(new RegExp(link));
      expect((await ringsOf(P)).length).toBe(ringCountBefore);
      expect(await linkTarget(link)).toBeNull();
    } finally {
      // The integration globalSetup re-applies every migration on the next run.
      await getTestDb().delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, link));
    }
  });

  runDb('aborts when a linked ring already carries different rules', async () => {
    const partner = await createPartner();
    const P = partner!.id;
    const O1 = (await createOrganization({ partnerId: P }))!.id;
    const R3 = await seedRing(P, 'Ring with rules', {
      appRules: [{ source: 'third_party', packageId: 'Vendor.Z', action: 'block' }],
    });
    const pol = await seedPolicy({ orgId: O1, name: 'Conflicting' });
    const link = await seedLink(pol, R3, { apps: [{ source: 'third_party', packageId: 'Vendor.X', action: 'block' }] });
    const ringless = await seedPolicy({ orgId: O1, name: 'Ring-less' });
    const ringlessLink = await seedLink(ringless, null, {
      apps: [{ source: 'third_party', packageId: 'Vendor.W', action: 'block' }],
    });
    const ringCountBefore = (await ringsOf(P)).length;

    try {
      await expect(applyMigration()).rejects.toThrow(new RegExp(R3));

      // Nothing was written: the whole file is one transaction.
      expect((await ringsOf(P)).length).toBe(ringCountBefore);
      expect(await linkTarget(link)).toBe(R3);
      expect(await linkTarget(ringlessLink)).toBeNull();
      const [r3] = await getTestDb().select({ appRules: patchPolicies.appRules }).from(patchPolicies)
        .where(inArray(patchPolicies.id, [R3]));
      expect(r3!.appRules).toEqual([{ source: 'third_party', packageId: 'Vendor.Z', action: 'block' }]);
    } finally {
      // Leave no conflicting state behind: the integration globalSetup applies
      // every migration to this database on the next run, and this one would
      // abort it.
      await getTestDb().update(patchPolicies).set({ appRules: [] }).where(eq(patchPolicies.id, R3));
    }
  });
});

describe('backfill -> feature-link PATCH seam (#8678, #8188)', () => {
  // Before #8188 a PATCH had to carry the link's legacy inline `apps` forward.
  // Since #8188 the policy schema strips them on every write: the rules are
  // safe because they live on the ring the backfill linked, which a PATCH
  // that does not change featurePolicyId leaves untouched.
  runDb('a PATCH after the backfill keeps the link on its rule-carrying ring and stores no inline apps', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const P = env.partner.id;
    const firefoxBlock: Rule = { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' };
    const pol = await seedPolicy({ orgId: env.organization.id, name: 'Seam policy' });
    const linkId = await seedLink(pol, null, { sources: ['os', 'third_party'], apps: [firefoxBlock] });

    await applyMigration();

    // Non-vacuous: the backfill relinked the link onto a ring carrying the rules.
    const ringId = await linkTarget(linkId);
    expect(ringId).not.toBeNull();
    expect(canonical((await ringsOf(P)).find((r) => r.id === ringId)!.appRules)).toEqual([firefoxBlock]);

    const token = await createAccessToken({
      sub: env.user.id,
      email: env.user.email,
      roleId: env.role.id,
      orgId: null,
      partnerId: P,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: 'it-session',
    });
    // configPolicyRoutes applies the real authMiddleware itself.
    const app = new Hono();
    app.route('/configuration-policies', configPolicyRoutes);

    const res = await app.request(`/configuration-policies/${pol}/features/${linkId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inlineSettings: { scheduleTime: '03:30' } }),
    });
    expect(res.status).toBe(200);

    const rows = await getTestDb().execute(sql`
      SELECT inline_settings ? 'apps' AS has_apps, inline_settings->>'scheduleTime' AS schedule_time
      FROM config_policy_feature_links WHERE id = ${linkId}`);
    const row = (rows as unknown as Array<{ has_apps: boolean; schedule_time: string | null }>)[0]!;
    expect(row.schedule_time).toBe('03:30'); // the PATCH really landed
    expect(row.has_apps).toBe(false); // the retired key is stripped on write...
    expect(await linkTarget(linkId)).toBe(ringId); // ...and the link keeps its ring,
    // ...so the policy's EFFECTIVE rules, read through the runtime loader,
    // still carry the backfilled block.
    const local = await withSystemDbAccessContext(() => loadPolicyLocalPatchConfig(pol));
    expect(local!.ring.valid).toBe(true);
    expect(local!.ring.ringId).toBe(ringId);
    expect(canonical(local!.ring.appRules)).toEqual([firefoxBlock]);
  });
});
