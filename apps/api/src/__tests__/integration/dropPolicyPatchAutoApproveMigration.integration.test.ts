/**
 * Live-Postgres proof for 2026-12-31-160000-drop-policy-patch-auto-approve.sql
 * (#8184 W04, #8188).
 *
 * setup.ts has already applied the migration to an empty database, so its
 * data step never met a row there. This suite seeds pre-migration state —
 * patch links still carrying the retired policy-level approval keys, plus the
 * two dropped config_policy_patch_settings columns re-added — and replays the
 * file:
 *   - the DDL half (function replace, column drop) as the test superuser,
 *     which owns the objects;
 *   - the data half (from the `@data-section-start` marker) as a dedicated
 *     NOSUPERUSER NOBYPASSRLS role with only the privileges a table-owning
 *     migrator has on what that half touches, so FORCE RLS applies and a
 *     missing system-scope election would match zero rows here as it would
 *     in production.
 * Then it replays the data half again to prove the re-run writes nothing.
 *
 * Run:
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/dropPolicyPatchAutoApproveMigration.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configPolicyFeatureLinks, configurationPolicies, patchPolicies } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-12-31-160000-drop-policy-patch-auto-approve.sql',
);
const DATA_MARKER = '-- @data-section-start';
const MIGRATOR = 'breeze_test_drop_policy_auto_approve_migrator';
const RETIRED_KEYS = ['apps', 'autoApprove', 'autoApproveSeverities', 'autoApproveDeferralDays'];

const runDb = it.runIf(!!process.env.DATABASE_URL);

function migrationHalves(): { ddl: string; data: string } {
  const text = readFileSync(MIGRATION_FILE, 'utf8');
  const at = text.indexOf(DATA_MARKER);
  if (at === -1) throw new Error(`migration lost its "${DATA_MARKER}" marker`);
  return { ddl: text.slice(0, at), data: text.slice(at) };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
          CREATE ROLE ${MIGRATOR} NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
    `);
    // What the data half reads and writes (the export-state triggers on
    // config_policy_feature_links update partners / organizations).
    await admin.unsafe(`
      GRANT USAGE ON SCHEMA public TO ${MIGRATOR};
      GRANT SELECT, UPDATE ON public.config_policy_feature_links, public.partners, public.organizations TO ${MIGRATOR};
      GRANT SELECT ON public.configuration_policies, public.patch_policies TO ${MIGRATOR};
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

type Metrics = { stripped?: number; unenforced?: number; unenforcedLinks: string[] };

function parseNotices(notices: string[]): Metrics {
  const out: Metrics = { unenforcedLinks: [] };
  for (const n of notices) {
    const total = /^drop_policy_patch_auto_approve (\w+)=(\d+)$/.exec(n);
    if (total?.[1] === 'inline_links_stripped') out.stripped = Number(total[2]);
    if (total?.[1] === 'links_with_unenforced_app_rules') out.unenforced = Number(total[2]);
    const perLink = /^drop_policy_patch_auto_approve unenforced_app_rules link=(\S+) policy=\S+ ring_ref=\S+ apps=(.*)$/.exec(n);
    if (perLink) out.unenforcedLinks.push(perLink[1]!);
  }
  out.unenforcedLinks.sort();
  return out;
}

async function seedPolicy(name: string, owner: { orgId?: string; partnerId?: string }) {
  const [row] = await getTestDb()
    .insert(configurationPolicies)
    .values({ orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null, name })
    .returning({ id: configurationPolicies.id });
  return row!.id;
}

async function seedLink(policyId: string, featureType: string, ringId: string | null, inline: unknown) {
  const [row] = await getTestDb()
    .insert(configPolicyFeatureLinks)
    .values({
      configPolicyId: policyId,
      featureType: featureType as typeof configPolicyFeatureLinks.$inferInsert.featureType,
      featurePolicyId: ringId,
      inlineSettings: inline,
    })
    .returning({ id: configPolicyFeatureLinks.id });
  return row!.id;
}

async function seedRing(partnerId: string, name: string, enabled: boolean, appRules: unknown[]) {
  const [row] = await getTestDb()
    .insert(patchPolicies)
    .values({ partnerId, kind: 'ring', name, enabled, appRules } as typeof patchPolicies.$inferInsert)
    .returning({ id: patchPolicies.id });
  return row!.id;
}

describe('2026-12-31-160000 drop policy patch auto-approve migration (#8188)', () => {
  runDb('strips the retired keys from patch links only, reports unenforced rules per link, drops the columns, and re-runs as a no-op', async () => {
    const firefox = { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' };
    const vlc = { source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin', pinnedVersion: '3.0.20' };
    const partner = await createPartner();
    const P = partner!.id;
    const O1 = (await createOrganization({ partnerId: P }))!.id;
    // A partner with no organizations: its partner-wide policy's link gets no
    // org lock rows but must still be rewritten.
    const lonely = await createPartner();
    const Q = lonely!.id;

    const ring = await seedRing(P, 'Ring with rules', true, [firefox]);
    const disabledRing = await seedRing(P, 'Disabled ring', false, []);

    const lValid = await seedLink(await seedPolicy('valid ring', { orgId: O1 }), 'patch', ring, {
      sources: ['os', 'third_party'], scheduleTime: '04:00',
      autoApprove: true, autoApproveSeverities: ['critical'], autoApproveDeferralDays: 3, apps: [firefox],
    });
    const lDisabled = await seedLink(await seedPolicy('disabled ring', { orgId: O1 }), 'patch', disabledRing, {
      sources: ['third_party'], apps: [firefox],
    });
    const lNoRing = await seedLink(await seedPolicy('no ring', { orgId: O1 }), 'patch', null, { apps: [vlc] });
    const lPartnerWide = await seedLink(await seedPolicy('partner-wide, no orgs', { partnerId: Q }), 'patch', null, {
      autoApprove: true, autoApproveSeverities: ['important'],
    });
    const lEmptyApps = await seedLink(await seedPolicy('empty apps', { orgId: O1 }), 'patch', null, {
      apps: [], rebootPolicy: 'never',
    });
    // Non-array `apps` must not crash the unenforced-rules scan (the planner
    // may evaluate jsonb_array_length before the jsonb_typeof guard).
    const lAppsNull = await seedLink(await seedPolicy('apps null', { orgId: O1 }), 'patch', null, { apps: null });
    const lAppsObject = await seedLink(await seedPolicy('apps object', { orgId: O1 }), 'patch', null, {
      apps: { source: 'third_party' }, scheduleTime: '05:00',
    });
    // Partner-wide policy on a valid ring of its partner: enforced, not reported.
    const lPartnerWideRing = await seedLink(await seedPolicy('partner-wide, valid ring', { partnerId: P }), 'patch', ring, {
      apps: [firefox],
    });
    // Non-object documents that `?|` would match ('apps' as an array element
    // or the scalar itself) must be left alone, never handed to jsonb `-`.
    const lArray = await seedLink(await seedPolicy('array inline', { orgId: O1 }), 'patch', null, ['apps']);
    const lScalar = await seedLink(await seedPolicy('scalar inline', { orgId: O1 }), 'patch', null, 'apps');
    const lClean = await seedLink(await seedPolicy('clean', { orgId: O1 }), 'patch', ring, { sources: ['os'] });
    const lNull = await seedLink(await seedPolicy('null inline', { orgId: O1 }), 'patch', null, null);
    const lOther = await seedLink(await seedPolicy('maintenance', { orgId: O1 }), 'maintenance', null, {
      apps: ['not-a-patch-link'], autoApprove: true, recurrence: 'weekly',
    });

    const readInline = async () => {
      const rows = await getTestDb()
        .select({ id: configPolicyFeatureLinks.id, inline: configPolicyFeatureLinks.inlineSettings })
        .from(configPolicyFeatureLinks)
        .where(inArray(configPolicyFeatureLinks.id, [
          lValid, lDisabled, lNoRing, lPartnerWide, lEmptyApps, lAppsNull, lAppsObject, lPartnerWideRing,
          lClean, lNull, lOther, lArray, lScalar,
        ]));
      return new Map(rows.map((r) => [r.id, r.inline as Record<string, unknown> | null]));
    };
    const before = await readInline();

    const { ddl, data } = migrationHalves();
    const notices: string[] = [];
    const client = postgres(process.env.DATABASE_URL!, {
      max: 1,
      onnotice: (notice) => notices.push(String(notice.message ?? '')),
    });
    let first: Metrics;
    let second: Metrics;
    try {
      await client.begin(async (tx) => {
        // Pre-migration schema: plain ADD so a database that still has the
        // columns fails loudly instead of being altered.
        await tx.unsafe(`
          ALTER TABLE public.config_policy_patch_settings
            ADD COLUMN auto_approve boolean NOT NULL DEFAULT false,
            ADD COLUMN auto_approve_severities text[] DEFAULT '{}'::text[]
        `);
        await tx.unsafe(ddl);

        const replayData = async (): Promise<Metrics> => {
          notices.length = 0;
          await tx.unsafe(`SELECT set_config('breeze.scope', 'none', true)`);
          await tx.unsafe(`SET LOCAL ROLE ${MIGRATOR}`);
          const [role] = await tx.unsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
            'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
          );
          expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
          await tx.unsafe(data);
          await tx.unsafe('RESET ROLE');
          return parseNotices([...notices]);
        };
        first = await replayData();
        second = await replayData();
      });
    } finally {
      await client.end();
    }

    // The data step matched rows under FORCE RLS, and reported each link whose
    // rules no valid ring enforces (disabled ring, no ring).
    expect(first!.stripped).toBe(8);
    expect(first!.unenforced).toBe(2);
    expect(first!.unenforcedLinks).toEqual([lDisabled, lNoRing].sort());
    // Re-run: nothing left to strip or report.
    expect(second!).toEqual({ stripped: 0, unenforced: 0, unenforcedLinks: [] });

    const after = await readInline();
    expect(after.get(lValid)).toEqual({ sources: ['os', 'third_party'], scheduleTime: '04:00' });
    expect(after.get(lDisabled)).toEqual({ sources: ['third_party'] });
    expect(after.get(lNoRing)).toEqual({});
    expect(after.get(lPartnerWide)).toEqual({});
    expect(after.get(lEmptyApps)).toEqual({ rebootPolicy: 'never' });
    expect(after.get(lAppsNull)).toEqual({});
    expect(after.get(lAppsObject)).toEqual({ scheduleTime: '05:00' });
    expect(after.get(lPartnerWideRing)).toEqual({});
    for (const id of [lValid, lDisabled, lNoRing, lPartnerWide, lEmptyApps, lAppsNull, lAppsObject, lPartnerWideRing]) {
      for (const key of RETIRED_KEYS) expect(after.get(id)).not.toHaveProperty(key);
    }
    // Untouched: a link without retired keys, a NULL document, a non-patch link.
    for (const id of [lClean, lNull, lOther, lArray, lScalar]) expect(after.get(id)).toEqual(before.get(id));

    const columns = await getTestDb().execute(
      sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'config_policy_patch_settings'
           AND column_name IN ('auto_approve', 'auto_approve_severities')`,
    ) as unknown as unknown[];
    expect(columns).toEqual([]);
  });
});
