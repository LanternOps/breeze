/**
 * Regression (#1855): Config Policy automation runs were RLS-invisible in the
 * portal because `createConfigPolicyAutomationRun` stored a
 * `config_policy_feature_links.id` into `automation_runs.config_policy_id`,
 * while every consumer treats that column as a `configuration_policies.id`.
 *
 * `automation_runs` has no `org_id`; tenancy is an EXISTS-join against
 * `configuration_policies` (2026-05-30-fk-child-tables-rls.sql):
 *   EXISTS (SELECT 1 FROM configuration_policies cp
 *           WHERE cp.id = automation_runs.config_policy_id
 *             AND breeze_has_org_access(cp.org_id))
 * A feature-link id matches no `configuration_policies` row, so an org-scoped
 * reader saw zero rows even though the worker's system-scope INSERT succeeded.
 *
 * These run against a real DB as `breeze_app` (forced RLS) under an org-scoped
 * context, exactly as the portal read path does. They are RED before the fix
 * (the run created with the feature-link id is invisible) and GREEN after (the
 * run is created with the resolved policy id and is visible).
 *
 * Per CLAUDE.md, RLS forge tests MUST run on a non-BYPASSRLS connection — case
 * (0) asserts `rolbypassrls = false` under the app context before trusting the
 * visibility assertions (see memory: worktree_env_test_rls_vacuous).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations } from '../../db/schema';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAutomations,
} from '../../db/schema/configurationPolicies';
import { automationRuns } from '../../db/schema/automations';
import { createConfigPolicyAutomationRun } from '../../services/automationRuntime';

let orgId: string;
let foreignOrgId: string;
let policyId: string;
let featureLinkId: string;
let automationRow: typeof configPolicyAutomations.$inferSelect;
let orgContext: DbAccessContext;

beforeEach(async () => {
  // Seed on the superuser test connection (bypasses RLS).
  const tdb = getTestDb();
  const sfx = `${Date.now()}-${Math.floor(performance.now())}`;

  // automation_runs has no FK to configuration_policies / organizations, so the
  // organizations TRUNCATE CASCADE in setup.ts does NOT clear it. Wipe it here.
  await tdb.delete(automationRuns);

  const [p] = await tdb
    .insert(partners)
    .values({ name: 'CP Run RLS', slug: `cp-run-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const [o] = await tdb
    .insert(organizations)
    .values({ partnerId: p!.id, name: 'CP Run Org', slug: `cp-run-org-${sfx}` })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [fo] = await tdb
    .insert(organizations)
    .values({ partnerId: p!.id, name: 'CP Run Foreign Org', slug: `cp-run-forg-${sfx}` })
    .returning({ id: organizations.id });
  foreignOrgId = fo!.id;

  const [policy] = await tdb
    .insert(configurationPolicies)
    .values({ orgId, name: 'CP Run Policy' })
    .returning({ id: configurationPolicies.id });
  policyId = policy!.id;

  const [link] = await tdb
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policyId, featureType: 'automation' })
    .returning({ id: configPolicyFeatureLinks.id });
  featureLinkId = link!.id;

  const [auto] = await tdb
    .insert(configPolicyAutomations)
    .values({
      featureLinkId,
      name: 'CP Run Automation',
      triggerType: 'schedule',
      cronExpression: '0 2 * * *',
      timezone: 'UTC',
      actions: [{ type: 'execute_command', command: 'echo hello' }],
    })
    .returning();
  automationRow = auto!;

  // Org-scoped context exactly as the request middleware would build it for a
  // user in `orgId`.
  orgContext = {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: null,
    userId: null,
    currentPartnerId: p!.id,
  };
});

describe('config policy automation run RLS visibility (#1855)', () => {
  it('(0) app context runs as breeze_app with RLS enforced (guards vacuous pass)', async () => {
    const rows = await withDbAccessContext(orgContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`),
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  it('an org-scoped reader can SELECT a run created by the worker (the fix)', async () => {
    // The worker inserts under system db context (automationWorker.ts).
    const run = await withSystemDbAccessContext(() =>
      createConfigPolicyAutomationRun({
        automation: automationRow,
        targetDeviceIds: ['dev-1', 'dev-2'],
        triggeredBy: 'scheduler',
      }),
    );

    // The stored config_policy_id must be the owning configuration_policies.id,
    // NOT the feature-link id — otherwise the RLS EXISTS-join resolves nothing.
    expect(run.configPolicyId).toBe(policyId);
    expect(run.configPolicyId).not.toBe(featureLinkId);

    // An org-scoped reader (breeze_app, forced RLS) must see the run.
    const visible = await withDbAccessContext(orgContext, () =>
      db
        .select({ id: automationRuns.id, configPolicyId: automationRuns.configPolicyId })
        .from(automationRuns)
        .where(eq(automationRuns.id, run.id))
        .limit(1),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]!.configPolicyId).toBe(policyId);
  });

  it('a run mis-keyed with the feature-link id is RLS-invisible (the bug it replaces)', async () => {
    // Seed a legacy mis-keyed row on the superuser test connection (bypasses
    // RLS). Such rows could exist from before the automation_runs RLS migration
    // (2026-05-30) landed its WITH CHECK — the bug wrote the feature-link id,
    // which the EXISTS-join can no longer resolve. (Note: the breeze_app
    // INSERT WITH CHECK now rejects a feature-link id even under system scope,
    // because the EXISTS finds no matching configuration_policies row — which is
    // itself a useful guard, but is not how the legacy rows were created.)
    const tdb = getTestDb();
    const [bad] = await tdb
      .insert(automationRuns)
      .values({
        automationId: null,
        configPolicyId: featureLinkId, // the bug
        configItemName: 'Mis-keyed run',
        triggeredBy: 'scheduler',
        status: 'running',
      })
      .returning({ id: automationRuns.id });

    // The superuser connection (bypasses RLS) proves the row exists.
    const superuserView = await tdb
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(eq(automationRuns.id, bad!.id));
    expect(superuserView).toHaveLength(1);

    // Org scope sees nothing — the feature-link id matches no configuration_policies row.
    const orgView = await withDbAccessContext(orgContext, () =>
      db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.id, bad!.id)),
    );
    expect(orgView).toHaveLength(0);

    // Even system scope (breeze_app with the system GUC) cannot SELECT it: the
    // EXISTS-join still needs a matching configuration_policies row, which a
    // feature-link id never has. This is exactly why such runs are unreadable
    // in the portal.
    const systemView = await withSystemDbAccessContext(() =>
      db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.id, bad!.id)),
    );
    expect(systemView).toHaveLength(0);
  });

  it('a foreign org cannot SELECT another org\'s config policy run', async () => {
    const run = await withSystemDbAccessContext(() =>
      createConfigPolicyAutomationRun({
        automation: automationRow,
        targetDeviceIds: ['dev-1'],
        triggeredBy: 'scheduler',
      }),
    );

    const foreignContext: DbAccessContext = {
      scope: 'organization',
      orgId: foreignOrgId,
      accessibleOrgIds: [foreignOrgId],
      accessiblePartnerIds: null,
      userId: null,
      currentPartnerId: null,
    };
    const foreignView = await withDbAccessContext(foreignContext, () =>
      db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.id, run.id)),
    );
    expect(foreignView).toHaveLength(0);
  });

  it('the backfill remaps a feature-keyed run to the policy id, making it visible', async () => {
    // Seed a legacy mis-keyed row on the superuser connection (bypasses RLS),
    // then run the backfill UPDATE.
    const tdb = getTestDb();
    const [legacy] = await tdb
      .insert(automationRuns)
      .values({
        automationId: null,
        configPolicyId: featureLinkId, // legacy bug value
        configItemName: 'Legacy run',
        triggeredBy: 'scheduler',
        status: 'completed',
      })
      .returning({ id: automationRuns.id });

    // Invisible before backfill.
    const before = await withDbAccessContext(orgContext, () =>
      db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.id, legacy!.id)),
    );
    expect(before).toHaveLength(0);

    // The backfill statement from 2026-06-24-config-policy-run-tenant-key-backfill.sql.
    await tdb.execute(sql`
      UPDATE automation_runs ar
      SET config_policy_id = fl.config_policy_id
      FROM config_policy_feature_links fl
      WHERE ar.automation_id IS NULL
        AND ar.config_policy_id = fl.id
        AND NOT EXISTS (
          SELECT 1 FROM configuration_policies cp WHERE cp.id = ar.config_policy_id
        )
    `);

    // Visible after backfill, now keyed to the policy id.
    const after = await withDbAccessContext(orgContext, () =>
      db
        .select({ id: automationRuns.id, configPolicyId: automationRuns.configPolicyId })
        .from(automationRuns)
        .where(eq(automationRuns.id, legacy!.id)),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.configPolicyId).toBe(policyId);

    // Idempotent: re-running the backfill is a no-op (already a valid policy id).
    await tdb.execute(sql`
      UPDATE automation_runs ar
      SET config_policy_id = fl.config_policy_id
      FROM config_policy_feature_links fl
      WHERE ar.automation_id IS NULL
        AND ar.config_policy_id = fl.id
        AND NOT EXISTS (
          SELECT 1 FROM configuration_policies cp WHERE cp.id = ar.config_policy_id
        )
    `);
    const afterRerun = await withDbAccessContext(orgContext, () =>
      db
        .select({ configPolicyId: automationRuns.configPolicyId })
        .from(automationRuns)
        .where(and(eq(automationRuns.id, legacy!.id), isNull(automationRuns.automationId))),
    );
    expect(afterRerun[0]!.configPolicyId).toBe(policyId);
  });
});
