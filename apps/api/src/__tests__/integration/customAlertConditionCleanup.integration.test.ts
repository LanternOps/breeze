/**
 * Replays 2026-08-06-g-drop-custom-alert-conditions.sql against seeded "dirty"
 * data — rules still storing the retired `custom` condition type, the shape a
 * pre-#2946 tenant has in production.
 *
 * CI databases are migrated schema-fresh in globalSetup, so the migration's
 * cleanup DO-block would otherwise only ever run against zero rows. This suite
 * seeds every case the migration distinguishes between, re-runs the migration
 * file from disk, and asserts the behaviours the cleanup contract depends on:
 * all-custom config-policy rules deleted, mixed rules untouched, alert-
 * referenced rules left in place, the inline_settings items[] mirror rebuilt
 * for links that lost rows, standalone alert_rules deactivated (never deleted)
 * from either source of effective conditions, and replay being a true no-op.
 *
 * Unlike the ownership-consolidation precedent this migration has no
 * `-- @data-section-end` sentinel: the whole file is one DML section, so it is
 * replayed verbatim.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/customAlertConditionCleanup.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  alertRules,
  alertTemplates,
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
  '../../../migrations/2026-08-06-g-drop-custom-alert-conditions.sql',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function runMigration() {
  await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
}

// The retired type: conditionRegistry.evaluate() has no handler for it, so a
// rule made only of these has never fired and never can.
const CUSTOM_CONDITIONS = [{ type: 'custom', expression: 'cpu > 90 && disk < 10' }];
const METRIC_CONDITIONS = [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 90 }];
// A `custom` condition alongside a real one — deliberately NOT cleaned up: under
// an explicit {logic:'or'} group the rule is still live, and guessing risks
// silently disabling working alerting.
const MIXED_CONDITIONS = [
  { type: 'custom', expression: 'anything' },
  { type: 'metric', metric: 'cpu', operator: 'gt', value: 90 },
];

/**
 * Seeds the pre-migration world.
 *
 * config policies:
 *   policy A — alert_rule link owning an all-custom rule (must be DELETED) and
 *              a mixed rule (must SURVIVE); stale mirror listing both.
 *   policy B — alert_rule link whose ONLY rule is all-custom, so the rebuilt
 *              mirror must collapse to `{items: []}`.
 *   policy C — alert_rule link owning an all-custom rule that an `alerts` row
 *              references via alerts.config_policy_id: LEFT IN PLACE.
 *
 * alert_rules (standalone Alerts > Rules path):
 *   overrideCustom  — override_settings->'conditions' is all-custom  -> deactivated
 *   templateCustom  — no override conditions, template is all-custom -> deactivated
 *   supported       — template has a metric condition                -> stays active
 */
async function seedScenario() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });

  const [device] = await db.insert(devices).values({
    orgId: org!.id,
    siteId: site!.id,
    agentId: `agent-custom-cleanup-${Date.now()}`,
    hostname: 'custom-cleanup-host',
    osType: 'windows',
    osVersion: '11',
    architecture: 'x64',
    agentVersion: '1.0.0',
  }).returning({ id: devices.id });

  const insertPolicy = async (name: string) => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: org!.id,
      partnerId: null,
      name,
    }).returning({ id: configurationPolicies.id });
    return policy!.id;
  };

  const policyAId = await insertPolicy('Policy A — mixed survivors');
  const policyBId = await insertPolicy('Policy B — only a custom rule');
  const policyCId = await insertPolicy('Policy C — referenced by an alert');

  const insertLink = async (configPolicyId: string, items: unknown[]) => {
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId,
      featureType: 'alert_rule',
      inlineSettings: { items },
    }).returning({ id: configPolicyFeatureLinks.id });
    return link!.id;
  };

  const mirrorItem = (name: string, severity: string, conditions: unknown, sortOrder: number) => ({
    name,
    severity,
    conditions,
    cooldownMinutes: 5,
    autoResolve: false,
    autoResolveConditions: null,
    titleTemplate: '{{ruleName}} triggered on {{deviceName}}',
    messageTemplate: '{{ruleName}} condition met',
    sortOrder,
  });

  // Mirrors seeded to match the rows exactly, so any post-migration difference
  // is the rebuild and nothing else.
  const linkAId = await insertLink(policyAId, [
    mirrorItem('All custom', 'high', CUSTOM_CONDITIONS, 0),
    mirrorItem('Mixed conditions', 'medium', MIXED_CONDITIONS, 1),
  ]);
  const linkBId = await insertLink(policyBId, [
    mirrorItem('Lone custom', 'low', CUSTOM_CONDITIONS, 0),
  ]);
  const linkCId = await insertLink(policyCId, [
    mirrorItem('Referenced custom', 'critical', CUSTOM_CONDITIONS, 0),
  ]);

  const insertRule = async (
    featureLinkId: string,
    name: string,
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info',
    conditions: unknown,
    sortOrder: number,
  ) => {
    const [rule] = await db.insert(configPolicyAlertRules).values({
      featureLinkId,
      name,
      severity,
      conditions,
      cooldownMinutes: 5,
      autoResolve: false,
      sortOrder,
    }).returning({ id: configPolicyAlertRules.id });
    return rule!.id;
  };

  const allCustomRuleId = await insertRule(linkAId, 'All custom', 'high', CUSTOM_CONDITIONS, 0);
  const mixedRuleId = await insertRule(linkAId, 'Mixed conditions', 'medium', MIXED_CONDITIONS, 1);
  const loneCustomRuleId = await insertRule(linkBId, 'Lone custom', 'low', CUSTOM_CONDITIONS, 0);
  const referencedRuleId = await insertRule(linkCId, 'Referenced custom', 'critical', CUSTOM_CONDITIONS, 0);

  // alerts.config_policy_id stores the RULE id (plain uuid, no FK). Its
  // presence is what keeps referencedRule from being deleted.
  const [alertRow] = await db.insert(alerts).values({
    deviceId: device!.id,
    orgId: org!.id,
    configPolicyId: referencedRuleId,
    configItemName: 'Referenced custom',
    severity: 'critical',
    title: 'Referenced custom fired on custom-cleanup-host',
  }).returning({ id: alerts.id });

  const insertTemplate = async (name: string, conditions: unknown) => {
    const [template] = await db.insert(alertTemplates).values({
      orgId: org!.id,
      partnerId: null,
      name,
      conditions,
      severity: 'high',
      titleTemplate: '{{ruleName}} triggered on {{deviceName}}',
      messageTemplate: '{{ruleName}} condition met',
    }).returning({ id: alertTemplates.id });
    return template!.id;
  };

  const customTemplateId = await insertTemplate('Custom template', CUSTOM_CONDITIONS);
  const metricTemplateId = await insertTemplate('Metric template', METRIC_CONDITIONS);

  const insertAlertRule = async (
    name: string,
    templateId: string,
    overrideSettings: unknown,
  ) => {
    const [rule] = await db.insert(alertRules).values({
      orgId: org!.id,
      partnerId: null,
      templateId,
      name,
      targetType: 'organization',
      targetId: org!.id,
      overrideSettings,
      isActive: true,
    }).returning({ id: alertRules.id });
    return rule!.id;
  };

  // (a) effective conditions come from the override…
  const overrideCustomRuleId = await insertAlertRule(
    'Override is custom',
    metricTemplateId,
    { conditions: CUSTOM_CONDITIONS, cooldownMinutes: 10 },
  );
  // …(b) and from the joined template when the override has no conditions key.
  const templateCustomRuleId = await insertAlertRule(
    'Template is custom',
    customTemplateId,
    { cooldownMinutes: 10 },
  );
  const templateCustomNoOverrideRuleId = await insertAlertRule(
    'Template is custom, no override at all',
    customTemplateId,
    null,
  );
  const supportedRuleId = await insertAlertRule('Supported metric', metricTemplateId, null);
  // A custom template whose override REPLACES the conditions with a real one:
  // the override wins, so this must stay active.
  const overrideRescuesRuleId = await insertAlertRule(
    'Override rescues a custom template',
    customTemplateId,
    { conditions: METRIC_CONDITIONS },
  );

  return {
    orgId: org!.id,
    policyIds: [policyAId, policyBId, policyCId],
    linkAId,
    linkBId,
    linkCId,
    allCustomRuleId,
    mixedRuleId,
    loneCustomRuleId,
    referencedRuleId,
    alertId: alertRow!.id,
    overrideCustomRuleId,
    templateCustomRuleId,
    templateCustomNoOverrideRuleId,
    supportedRuleId,
    overrideRescuesRuleId,
  };
}

async function rulesForLink(linkId: string) {
  return getTestDb()
    .select({
      id: configPolicyAlertRules.id,
      name: configPolicyAlertRules.name,
      conditions: configPolicyAlertRules.conditions,
      sortOrder: configPolicyAlertRules.sortOrder,
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

async function mirrorItems(linkId: string) {
  const link = await linkById(linkId);
  return (link!.inlineSettings as { items: Array<Record<string, unknown>> }).items;
}

async function alertRuleById(ruleId: string) {
  const [row] = await getTestDb()
    .select({ id: alertRules.id, isActive: alertRules.isActive })
    .from(alertRules)
    .where(eq(alertRules.id, ruleId));
  return row;
}

describe('retired `custom` alert-condition cleanup migration (2026-08-06-g)', () => {
  runDb('deletes a config-policy rule whose every condition is `custom`', async () => {
    const seed = await seedScenario();
    await runMigration();

    const survivors = await getTestDb()
      .select({ id: configPolicyAlertRules.id })
      .from(configPolicyAlertRules)
      .where(inArray(configPolicyAlertRules.id, [seed.allCustomRuleId, seed.loneCustomRuleId]));
    expect(survivors).toHaveLength(0);
  });

  runDb('leaves a rule that mixes `custom` with a supported condition intact', async () => {
    const seed = await seedScenario();
    await runMigration();

    const remaining = await rulesForLink(seed.linkAId);
    expect(remaining.map((r) => r.id)).toEqual([seed.mixedRuleId]);
    expect(remaining[0]!.name).toBe('Mixed conditions');
    // Conditions untouched — the migration must not rewrite a mixed rule.
    expect(remaining[0]!.conditions).toEqual(MIXED_CONDITIONS);
  });

  runDb('leaves an all-custom rule in place when an alerts row references it', async () => {
    const seed = await seedScenario();
    await runMigration();

    const kept = await rulesForLink(seed.linkCId);
    expect(kept.map((r) => r.id)).toEqual([seed.referencedRuleId]);

    // Alert provenance is untouched too.
    const [alertRow] = await getTestDb()
      .select({ configPolicyId: alerts.configPolicyId })
      .from(alerts)
      .where(eq(alerts.id, seed.alertId));
    expect(alertRow!.configPolicyId).toBe(seed.referencedRuleId);
  });

  runDb('rebuilds the inline_settings items[] mirror for links that lost rows', async () => {
    const seed = await seedScenario();
    const beforeC = await linkById(seed.linkCId);
    await runMigration();

    // Link A: the deleted rule is gone from the mirror, the survivor remains.
    const itemsA = await mirrorItems(seed.linkAId);
    expect(itemsA.map((i) => i.name)).toEqual(['Mixed conditions']);
    expect(itemsA[0]).toMatchObject({
      name: 'Mixed conditions',
      severity: 'medium',
      conditions: MIXED_CONDITIONS,
      cooldownMinutes: 5,
      autoResolve: false,
      autoResolveConditions: null,
      titleTemplate: '{{ruleName}} triggered on {{deviceName}}',
      messageTemplate: '{{ruleName}} condition met',
      sortOrder: 1,
    });

    // Link B lost its ONLY rule: the correlated aggregate must collapse the
    // mirror to an empty items[] rather than leaving the stale entry behind.
    const linkB = await linkById(seed.linkBId);
    expect(linkB!.inlineSettings).toEqual({ items: [] });

    // Link C lost nothing, so it is outside the affected set and untouched
    // (including updated_at).
    const afterC = await linkById(seed.linkCId);
    expect(afterC).toEqual(beforeC);
  });

  runDb('deactivates — never deletes — alert_rules whose effective conditions are all custom', async () => {
    const seed = await seedScenario();
    await runMigration();

    // (a) conditions from override_settings->'conditions'
    expect(await alertRuleById(seed.overrideCustomRuleId)).toEqual({
      id: seed.overrideCustomRuleId,
      isActive: false,
    });
    // (b) conditions from the joined alert_templates row
    expect(await alertRuleById(seed.templateCustomRuleId)).toEqual({
      id: seed.templateCustomRuleId,
      isActive: false,
    });
    expect(await alertRuleById(seed.templateCustomNoOverrideRuleId)).toEqual({
      id: seed.templateCustomNoOverrideRuleId,
      isActive: false,
    });

    // The rows still exist — alerts.rule_id is a real FK with no ON DELETE.
    const stillThere = await getTestDb()
      .select({ id: alertRules.id })
      .from(alertRules)
      .where(inArray(alertRules.id, [
        seed.overrideCustomRuleId,
        seed.templateCustomRuleId,
        seed.templateCustomNoOverrideRuleId,
      ]));
    expect(stillThere).toHaveLength(3);
  });

  runDb('leaves alert_rules with a supported condition active', async () => {
    const seed = await seedScenario();
    await runMigration();

    expect((await alertRuleById(seed.supportedRuleId))!.isActive).toBe(true);
    // The override supplies a real condition, so the custom template is moot.
    expect((await alertRuleById(seed.overrideRescuesRuleId))!.isActive).toBe(true);
  });

  runDb('is idempotent — a second run changes nothing', async () => {
    const seed = await seedScenario();
    await runMigration();

    const db = getTestDb();
    const snapshot = async () => ({
      links: await db
        .select()
        .from(configPolicyFeatureLinks)
        .where(inArray(configPolicyFeatureLinks.configPolicyId, seed.policyIds))
        .orderBy(asc(configPolicyFeatureLinks.id)),
      policyRules: await db
        .select()
        .from(configPolicyAlertRules)
        .orderBy(asc(configPolicyAlertRules.id)),
      alertRules: await db
        .select()
        .from(alertRules)
        .orderBy(asc(alertRules.id)),
    });

    const before = await snapshot();
    // A replay that rewrote an identical mirror would still bump updated_at
    // (and the partner-export watermark) — the IS DISTINCT FROM guard and the
    // empty affected-links set exist to prevent exactly that, so assert the
    // captured timestamps explicitly as well as by deep equality.
    const updatedAtBefore = before.links.map((l) => l.updatedAt);

    await runMigration();

    const after = await snapshot();
    expect(after.links.map((l) => l.updatedAt)).toEqual(updatedAtBefore);
    expect(after).toEqual(before);
  });
});
