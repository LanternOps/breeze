/**
 * Replays 2026-07-30-alert-rule-ownership-consolidation.sql against seeded
 * "dirty" data — a policy whose alert rules still hang off the MONITORING
 * feature link, the shape every pre-consolidation config policy has in
 * production.
 *
 * CI databases are migrated schema-fresh in globalSetup, so the migration's
 * data-moving DO-block would otherwise only ever run against zero rows. This
 * suite seeds the real pre-migration shape, re-runs the migration file from
 * disk, and asserts the six behaviours the consolidation contract depends on:
 * ids preserved, missing alert_rule links created, exact duplicates deduped
 * with alert provenance repointed, both JSONB mirrors rebuilt, and replay
 * being a true no-op.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/alertRuleOwnershipMigration.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  alerts,
  configPolicyAlertRules,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-07-30-alert-rule-ownership-consolidation.sql',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);

function migrationText(): string {
  return readFileSync(MIGRATION_FILE, 'utf8');
}

async function runMigration() {
  await getTestDb().execute(sql.raw(migrationText()));
}

/**
 * The RLS-sensitive DML half of the migration — everything above the
 * `-- @data-section-end` sentinel. The half below it is function DDL that only
 * the owner/migration role may execute, so it cannot be replayed as
 * `breeze_app`.
 */
function dataSection(): string {
  const [dml, ...rest] = migrationText().split('-- @data-section-end');
  if (rest.length === 0) {
    throw new Error('migration lost its `-- @data-section-end` sentinel — see the note in the .sql file');
  }
  return dml!;
}

/**
 * Runs SQL as the unprivileged `breeze_app` role — the same non-superuser,
 * non-BYPASSRLS role production uses, so FORCE ROW LEVEL SECURITY actually
 * applies. `SET LOCAL ROLE` reverts when the transaction commits.
 */
async function runAsAppRole(statements: string) {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql.raw('SET LOCAL ROLE breeze_app'));
    await tx.execute(sql.raw(statements));
  });
}

const METRIC_CONDITIONS = [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 90 }];
const EVENT_LOG_CONDITIONS = [{
  type: 'event_log',
  category: 'system',
  level: 'error',
  countThreshold: 3,
  windowMinutes: 15,
}];
// Fingerprint shared by the rule already under the alert_rule link and the
// monitoring-owned copy the migration must drop.
const DUPE_CONDITIONS = [{ type: 'metric', metric: 'disk', operator: 'gt', value: 95 }];

/**
 * Seeds the pre-migration world:
 *
 *   policy A — monitoring link owning three rules (metric / event_log / an
 *              exact duplicate of the rule already under A's alert_rule link),
 *              plus an `alerts` row whose config_policy_id points at the
 *              duplicate.
 *   policy B — monitoring link owning one rule and NO alert_rule link.
 */
async function seedScenario() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });

  const [device] = await db.insert(devices).values({
    orgId: org!.id,
    siteId: site!.id,
    agentId: `agent-consolidation-${Date.now()}`,
    hostname: 'consolidation-host',
    osType: 'windows',
    osVersion: '11',
    architecture: 'x64',
    agentVersion: '1.0.0',
  }).returning({ id: devices.id });

  const [policyA] = await db.insert(configurationPolicies).values({
    orgId: org!.id,
    partnerId: null,
    name: 'Policy A — monitoring owns rules',
  }).returning({ id: configurationPolicies.id });
  const [policyB] = await db.insert(configurationPolicies).values({
    orgId: org!.id,
    partnerId: null,
    name: 'Policy B — no alert_rule link',
  }).returning({ id: configurationPolicies.id });

  const [alertLinkA] = await db.insert(configPolicyFeatureLinks).values({
    configPolicyId: policyA!.id,
    featureType: 'alert_rule',
    // Deliberately stale mirror: the migration must rebuild it from the rows.
    inlineSettings: { items: [] },
  }).returning({ id: configPolicyFeatureLinks.id });

  const [monitoringLinkA] = await db.insert(configPolicyFeatureLinks).values({
    configPolicyId: policyA!.id,
    featureType: 'monitoring',
    inlineSettings: {
      checkIntervalSeconds: 60,
      watches: [],
      alertRules: [{ name: 'CPU high', severity: 'high', conditions: METRIC_CONDITIONS }],
      eventLogAlerts: [{ name: 'System errors', category: 'system', level: 'error' }],
    },
  }).returning({ id: configPolicyFeatureLinks.id });

  const [monitoringLinkB] = await db.insert(configPolicyFeatureLinks).values({
    configPolicyId: policyB!.id,
    featureType: 'monitoring',
    inlineSettings: {
      checkIntervalSeconds: 120,
      watches: [],
      eventLogAlerts: [{ name: 'App crashes', category: 'application', level: 'critical' }],
    },
  }).returning({ id: configPolicyFeatureLinks.id });

  const [keepRule] = await db.insert(configPolicyAlertRules).values({
    featureLinkId: alertLinkA!.id,
    name: 'Disk nearly full',
    severity: 'high',
    conditions: DUPE_CONDITIONS,
    cooldownMinutes: 5,
    autoResolve: false,
    sortOrder: 0,
  }).returning({ id: configPolicyAlertRules.id });

  const [metricRule] = await db.insert(configPolicyAlertRules).values({
    featureLinkId: monitoringLinkA!.id,
    name: 'CPU high',
    severity: 'critical',
    conditions: METRIC_CONDITIONS,
    cooldownMinutes: 10,
    autoResolve: true,
    sortOrder: 0,
  }).returning({ id: configPolicyAlertRules.id });

  const [eventRule] = await db.insert(configPolicyAlertRules).values({
    featureLinkId: monitoringLinkA!.id,
    name: 'System errors',
    severity: 'high',
    conditions: EVENT_LOG_CONDITIONS,
    cooldownMinutes: 5,
    autoResolve: false,
    sortOrder: 1,
  }).returning({ id: configPolicyAlertRules.id });

  // Exact fingerprint match of keepRule — must be deleted, not moved.
  const [dupeRule] = await db.insert(configPolicyAlertRules).values({
    featureLinkId: monitoringLinkA!.id,
    name: 'Disk nearly full',
    severity: 'high',
    conditions: DUPE_CONDITIONS,
    cooldownMinutes: 5,
    autoResolve: false,
    sortOrder: 2,
  }).returning({ id: configPolicyAlertRules.id });

  const [soloRule] = await db.insert(configPolicyAlertRules).values({
    featureLinkId: monitoringLinkB!.id,
    name: 'App crashes',
    severity: 'medium',
    conditions: EVENT_LOG_CONDITIONS,
    cooldownMinutes: 5,
    autoResolve: false,
    sortOrder: 0,
  }).returning({ id: configPolicyAlertRules.id });

  // Alert provenance: alerts.config_policy_id stores the RULE id (plain uuid,
  // no FK), so the dedupe must repoint it at the survivor.
  const [alertRow] = await db.insert(alerts).values({
    deviceId: device!.id,
    orgId: org!.id,
    configPolicyId: dupeRule!.id,
    configItemName: 'Disk nearly full',
    severity: 'high',
    title: 'Disk nearly full on consolidation-host',
  }).returning({ id: alerts.id });

  return {
    orgId: org!.id,
    policyAId: policyA!.id,
    policyBId: policyB!.id,
    alertLinkAId: alertLinkA!.id,
    monitoringLinkAId: monitoringLinkA!.id,
    monitoringLinkBId: monitoringLinkB!.id,
    keepRuleId: keepRule!.id,
    metricRuleId: metricRule!.id,
    eventRuleId: eventRule!.id,
    dupeRuleId: dupeRule!.id,
    soloRuleId: soloRule!.id,
    alertId: alertRow!.id,
  };
}

async function rulesForLink(linkId: string) {
  return getTestDb()
    .select({
      id: configPolicyAlertRules.id,
      name: configPolicyAlertRules.name,
      sortOrder: configPolicyAlertRules.sortOrder,
      featureLinkId: configPolicyAlertRules.featureLinkId,
    })
    .from(configPolicyAlertRules)
    .where(eq(configPolicyAlertRules.featureLinkId, linkId))
    .orderBy(asc(configPolicyAlertRules.sortOrder));
}

async function linkById(linkId: string) {
  const [row] = await getTestDb()
    .select()
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.id, linkId));
  return row;
}

describe('alert-rule ownership consolidation migration (2026-07-30)', () => {
  runDb('moves rule rows to the alert_rule link preserving ids', async () => {
    const seed = await seedScenario();
    await runMigration();

    const moved = await rulesForLink(seed.alertLinkAId);
    // keepRule (0) + the two surviving monitoring-owned rules, renumbered to
    // continue after the highest sort_order already on the target link.
    expect(moved.map((r) => r.id)).toEqual([seed.keepRuleId, seed.metricRuleId, seed.eventRuleId]);
    expect(moved.map((r) => r.sortOrder)).toEqual([0, 1, 2]);
    expect(moved.map((r) => r.name)).toEqual(['Disk nearly full', 'CPU high', 'System errors']);

    // Nothing left under the monitoring link.
    expect(await rulesForLink(seed.monitoringLinkAId)).toHaveLength(0);
  });

  runDb('creates an alert_rule link when the policy has none', async () => {
    const seed = await seedScenario();
    const before = await getTestDb()
      .select({ id: configPolicyFeatureLinks.id })
      .from(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.configPolicyId, seed.policyBId));
    expect(before.map((l) => l.id)).toEqual([seed.monitoringLinkBId]);

    await runMigration();

    const [createdLink] = await getTestDb()
      .select()
      .from(configPolicyFeatureLinks)
      .where(sql`${configPolicyFeatureLinks.configPolicyId} = ${seed.policyBId}
        AND ${configPolicyFeatureLinks.featureType} = 'alert_rule'`);
    expect(createdLink).toBeDefined();
    expect(createdLink!.featurePolicyId).toBeNull();

    const moved = await rulesForLink(createdLink!.id);
    expect(moved.map((r) => r.id)).toEqual([seed.soloRuleId]);
    expect(moved[0]!.sortOrder).toBe(0);
    expect(await rulesForLink(seed.monitoringLinkBId)).toHaveLength(0);
  });

  runDb('dedupes exact fingerprints and repoints alerts.config_policy_id', async () => {
    const seed = await seedScenario();
    await runMigration();

    const survivors = await getTestDb()
      .select({ id: configPolicyAlertRules.id })
      .from(configPolicyAlertRules)
      .where(inArray(configPolicyAlertRules.id, [seed.keepRuleId, seed.dupeRuleId]));
    expect(survivors.map((r) => r.id)).toEqual([seed.keepRuleId]);

    const [alertRow] = await getTestDb()
      .select({ configPolicyId: alerts.configPolicyId })
      .from(alerts)
      .where(eq(alerts.id, seed.alertId));
    expect(alertRow!.configPolicyId).toBe(seed.keepRuleId);
  });

  runDb('strips alertRules/eventLogAlerts from the monitoring inline_settings mirror', async () => {
    const seed = await seedScenario();
    await runMigration();

    const monitoringA = await linkById(seed.monitoringLinkAId);
    expect(monitoringA!.inlineSettings).toEqual({ checkIntervalSeconds: 60, watches: [] });

    const monitoringB = await linkById(seed.monitoringLinkBId);
    expect(monitoringB!.inlineSettings).toEqual({ checkIntervalSeconds: 120, watches: [] });
  });

  runDb('rebuilds the alert_rule inline_settings items mirror from normalized rows', async () => {
    const seed = await seedScenario();
    await runMigration();

    const alertLinkA = await linkById(seed.alertLinkAId);
    const items = (alertLinkA!.inlineSettings as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.name)).toEqual(['Disk nearly full', 'CPU high', 'System errors']);
    expect(items.map((i) => i.sortOrder)).toEqual([0, 1, 2]);
    expect(items[1]).toMatchObject({
      name: 'CPU high',
      severity: 'critical',
      conditions: METRIC_CONDITIONS,
      cooldownMinutes: 10,
      autoResolve: true,
      titleTemplate: '{{ruleName}} triggered on {{deviceName}}',
      messageTemplate: '{{ruleName}} condition met',
      autoResolveConditions: null,
    });
    expect(items[2]!.conditions).toEqual(EVENT_LOG_CONDITIONS);

    // Policy B's freshly created link mirrors its single moved rule.
    const [createdLink] = await getTestDb()
      .select()
      .from(configPolicyFeatureLinks)
      .where(sql`${configPolicyFeatureLinks.configPolicyId} = ${seed.policyBId}
        AND ${configPolicyFeatureLinks.featureType} = 'alert_rule'`);
    const bItems = (createdLink!.inlineSettings as { items: Array<Record<string, unknown>> }).items;
    expect(bItems.map((i) => i.name)).toEqual(['App crashes']);
  });

  runDb('is idempotent — second run changes zero rows', async () => {
    const seed = await seedScenario();
    await runMigration();

    const db = getTestDb();
    const policyIds = [seed.policyAId, seed.policyBId];
    const snapshot = async () => ({
      links: await db
        .select()
        .from(configPolicyFeatureLinks)
        .where(inArray(configPolicyFeatureLinks.configPolicyId, policyIds))
        .orderBy(asc(configPolicyFeatureLinks.id)),
      rules: await db
        .select()
        .from(configPolicyAlertRules)
        .orderBy(asc(configPolicyAlertRules.id)),
      alert: await db
        .select({ id: alerts.id, configPolicyId: alerts.configPolicyId })
        .from(alerts)
        .where(eq(alerts.id, seed.alertId)),
    });

    const before = await snapshot();
    await runMigration();
    const after = await snapshot();

    // Deep equality includes updated_at on both links and rules: a replay that
    // rewrote an identical mirror would still bump the timestamp (and the
    // partner-export watermark), which is what the IS DISTINCT FROM guard and
    // the empty affected-policy set exist to prevent.
    expect(after).toEqual(before);
  });

  // ==========================================================================
  // The `SELECT set_config('breeze.scope', 'system', true)` line at the top of
  // the migration is load-bearing in production and invisible in every test
  // above: the integration superuser (`breeze_test`) is BYPASSRLS, so those
  // tests pass identically with the line deleted. Production applies migrations
  // as a role that is NOT guaranteed to bypass RLS, and all three tables
  // touched here are FORCE ROW LEVEL SECURITY. Without system scope the DML
  // sees zero rows: nothing moves, no warning is raised, the postcondition
  // counts zero and passes vacuously, the migration records as applied, and the
  // resolver cutover then silently stops evaluating every monitoring-owned
  // rule. These two tests are the only thing standing between that line and
  // someone deleting it as redundant.
  // ==========================================================================
  runDb('moves rules under FORCE RLS when replayed as the unprivileged breeze_app role', async () => {
    const db = getTestDb();
    const [role] = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'breeze_app'`
    );
    // Guard: if this ever stops being a genuinely RLS-bound role the test is
    // no longer proving anything, and we want to know rather than pass silently.
    expect(role, 'breeze_app role missing from the test database').toBeDefined();
    expect(role!.rolsuper, 'breeze_app must not be superuser for this test to mean anything').toBe(false);
    expect(role!.rolbypassrls, 'breeze_app must not have BYPASSRLS for this test to mean anything').toBe(false);

    const seed = await seedScenario();
    await runAsAppRole(dataSection());

    const moved = await rulesForLink(seed.alertLinkAId);
    expect(moved.map((r) => r.id)).toEqual([seed.keepRuleId, seed.metricRuleId, seed.eventRuleId]);
    expect(await rulesForLink(seed.monitoringLinkAId)).toHaveLength(0);
    const monitoringA = await linkById(seed.monitoringLinkAId);
    expect(monitoringA!.inlineSettings).toEqual({ checkIntervalSeconds: 60, watches: [] });
  });

  runDb('silently moves nothing as breeze_app once the system-scope line is removed', async () => {
    const seed = await seedScenario();
    const withoutSystemScope = dataSection().replace(
      /SELECT set_config\('breeze\.scope', 'system', true\);/,
      '-- system scope deliberately removed for this negative control',
    );
    expect(withoutSystemScope).not.toContain("set_config('breeze.scope', 'system'");

    // The damning part: this does NOT throw. RLS hides the rows, so the
    // postcondition counts zero and the migration "succeeds" while doing
    // nothing at all.
    await expect(runAsAppRole(withoutSystemScope)).resolves.toBeUndefined();

    const stranded = await rulesForLink(seed.monitoringLinkAId);
    expect(stranded.map((r) => r.id)).toEqual([seed.metricRuleId, seed.eventRuleId, seed.dupeRuleId]);
    expect(await rulesForLink(seed.alertLinkAId)).toHaveLength(1);
    const monitoringA = await linkById(seed.monitoringLinkAId);
    expect(monitoringA!.inlineSettings).toHaveProperty('alertRules');
  });

  runDb('is a no-op when no rules are owned by monitoring links', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner!.id });
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: org!.id,
      partnerId: null,
      name: 'Already consolidated',
    }).returning({ id: configurationPolicies.id });
    const [alertLink] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id,
      featureType: 'alert_rule',
      // A stale-looking mirror that the migration must NOT touch: this policy
      // never had monitoring-owned rules, so it is outside the affected set.
      inlineSettings: { items: [] },
    }).returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyAlertRules).values({
      featureLinkId: alertLink!.id,
      name: 'Untouched rule',
      severity: 'low',
      conditions: METRIC_CONDITIONS,
      sortOrder: 0,
    });

    const before = await linkById(alertLink!.id);
    await runMigration();
    const after = await linkById(alertLink!.id);
    expect(after).toEqual(before);
  });
});
