/**
 * Replays 2026-07-30-b-drop-never-firing-metric-alert-rules.sql against seeded
 * alert rules that the threshold evaluator can never resolve — a single metric
 * condition naming a metric outside METRIC_NAME_MAP (the retired "Network
 * Usage" option), or carrying no metric name at all.
 *
 * CI databases are migrated schema-fresh in globalSetup, so this migration's
 * DO-block would otherwise only ever run against zero rows. This suite seeds the
 * post-consolidation shape (rules under an ALERT_RULE link, which is where the
 * 2026-07-30 consolidation leaves them) and asserts the contract: dead rules go,
 * rules with alert provenance stay and are warned about, multi-condition rules
 * are untouched, the inline_settings mirror is rebuilt, and a replay changes
 * nothing at all.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/neverFiringRuleCleanup.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
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
  '../../../migrations/2026-07-30-b-drop-never-firing-metric-alert-rules.sql',
);

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function migrationText(): string {
  return readFileSync(MIGRATION_FILE, 'utf8');
}

async function runMigration() {
  await getTestDb().execute(sql.raw(migrationText()));
}

/**
 * Runs the migration on a short-lived client with the notice handler left in
 * place, so the RAISE WARNING forensic trail can actually be asserted. The
 * shared integration client sets `onnotice: () => {}` and would swallow them.
 */
async function runMigrationCapturingWarnings(): Promise<string[]> {
  const warnings: string[] = [];
  const client = postgres(DATABASE_URL, {
    max: 1,
    onnotice: (notice) => {
      if (notice.message) warnings.push(String(notice.message));
    },
  });
  try {
    await client.unsafe(migrationText());
  } finally {
    await client.end({ timeout: 5 });
  }
  return warnings;
}

const CPU_CONDITIONS = [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 90 }];
const NETWORK_CONDITIONS = [{ type: 'metric', metric: 'network', operator: 'gt', value: 80 }];
// The evaluator's own name for the metric handler (handlers/threshold.ts
// declares it with aliases ['metric']) — the migration must catch it too.
const THRESHOLD_ALIAS_CONDITIONS = [{ type: 'threshold', metric: 'network', operator: 'gt', value: 80 }];
// No metric name at all: normalizeMetricName(undefined) is null, so this is dead
// by exactly the same mechanism.
const METRICLESS_CONDITIONS = [{ type: 'metric', operator: 'gt', value: 80 }];
const MIXED_CONDITIONS = [
  { type: 'metric', metric: 'cpu', operator: 'gt', value: 90 },
  { type: 'metric', metric: 'network', operator: 'gt', value: 80 },
];

async function createPolicyWithAlertLink(name: string, inlineSettings: unknown = { items: [] }) {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const [policy] = await db.insert(configurationPolicies).values({
    orgId: org!.id,
    partnerId: null,
    name,
  }).returning({ id: configurationPolicies.id });
  const [alertLink] = await db.insert(configPolicyFeatureLinks).values({
    configPolicyId: policy!.id,
    featureType: 'alert_rule',
    inlineSettings: inlineSettings as Record<string, unknown>,
  }).returning({ id: configPolicyFeatureLinks.id });
  return { orgId: org!.id, policyId: policy!.id, alertLinkId: alertLink!.id };
}

async function insertRule(
  featureLinkId: string,
  name: string,
  conditions: unknown,
  sortOrder: number,
) {
  const [row] = await getTestDb().insert(configPolicyAlertRules).values({
    featureLinkId,
    name,
    severity: 'medium',
    conditions: conditions as Record<string, unknown>[],
    sortOrder,
  }).returning({ id: configPolicyAlertRules.id });
  return row!.id;
}

async function ruleIdsFor(ids: string[]) {
  const rows = await getTestDb()
    .select({ id: configPolicyAlertRules.id })
    .from(configPolicyAlertRules)
    .where(inArray(configPolicyAlertRules.id, ids));
  return rows.map((r) => r.id);
}

async function linkById(linkId: string) {
  const [row] = await getTestDb()
    .select()
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.id, linkId));
  return row;
}

function mirrorItems(inlineSettings: unknown): Array<Record<string, unknown>> {
  return (inlineSettings as { items: Array<Record<string, unknown>> }).items;
}

describe('never-firing metric alert rule cleanup migration (2026-07-30-b)', () => {
  runDb('drops an unfirable single-condition rule from an alert_rule link', async () => {
    const { alertLinkId } = await createPolicyWithAlertLink('Policy — network rule');
    const networkRuleId = await insertRule(alertLinkId, 'Network usage high', NETWORK_CONDITIONS, 0);
    const aliasRuleId = await insertRule(alertLinkId, 'Network usage (threshold)', THRESHOLD_ALIAS_CONDITIONS, 1);
    const cpuRuleId = await insertRule(alertLinkId, 'CPU high', CPU_CONDITIONS, 2);

    await runMigration();

    // Gone entirely — not relocated, not left behind.
    expect(await ruleIdsFor([networkRuleId, aliasRuleId, cpuRuleId])).toEqual([cpuRuleId]);
  });

  runDb('drops a metric condition carrying no metric name', async () => {
    const { alertLinkId } = await createPolicyWithAlertLink('Policy — metric-less rule');
    const metriclessRuleId = await insertRule(alertLinkId, 'Unnamed metric', METRICLESS_CONDITIONS, 0);
    const cpuRuleId = await insertRule(alertLinkId, 'CPU high', CPU_CONDITIONS, 1);

    await runMigration();

    expect(await ruleIdsFor([metriclessRuleId, cpuRuleId])).toEqual([cpuRuleId]);
  });

  runDb('leaves a never-firing rule that alerts reference, and says so', async () => {
    const db = getTestDb();
    const { orgId, alertLinkId } = await createPolicyWithAlertLink('Policy — referenced network rule');
    const site = await createSite({ orgId });
    const [device] = await db.insert(devices).values({
      orgId,
      siteId: site!.id,
      agentId: `agent-neverfiring-${Date.now()}`,
      hostname: 'neverfiring-host',
      osType: 'windows',
      osVersion: '11',
      architecture: 'x64',
      agentVersion: '1.0.0',
    }).returning({ id: devices.id });

    const networkRuleId = await insertRule(alertLinkId, 'Network usage high', NETWORK_CONDITIONS, 0);
    await db.insert(alerts).values({
      deviceId: device!.id,
      orgId,
      configPolicyId: networkRuleId,
      configItemName: 'Network usage high',
      severity: 'medium',
      title: 'Network usage high on neverfiring-host',
    });

    const warnings = await runMigrationCapturingWarnings();

    // Alert provenance wins over tidiness: alerts.config_policy_id is a plain
    // uuid with no FK, so deleting the rule would orphan the alert's origin.
    expect(await ruleIdsFor([networkRuleId])).toEqual([networkRuleId]);
    // The warning must say plainly that the row is NOT deleted — an operator
    // reading "left in place ... moved" (the wording this replaced) cannot tell
    // whether the rule still exists.
    expect(
      warnings.some((w) => w.includes('LEFT IN PLACE') && /\bNOT deleted\b/.test(w)),
      `expected a LEFT IN PLACE warning, got: ${JSON.stringify(warnings)}`,
    ).toBe(true);
    // And it must not be miscounted as dropped.
    expect(warnings.some((w) => w.includes('Network usage high') && w.includes('dropped'))).toBe(false);
  });

  runDb('leaves a multi-condition rule intact even when one condition names a bad metric', async () => {
    const { alertLinkId } = await createPolicyWithAlertLink('Policy — mixed conditions');
    const mixedRuleId = await insertRule(alertLinkId, 'CPU or network', MIXED_CONDITIONS, 0);

    await runMigration();

    expect(await ruleIdsFor([mixedRuleId])).toEqual([mixedRuleId]);
    // Conditions untouched — the CPU half still fires, and AlertRuleTab flags
    // the network half for the tech rather than the migration guessing.
    const [row] = await getTestDb()
      .select({ conditions: configPolicyAlertRules.conditions })
      .from(configPolicyAlertRules)
      .where(eq(configPolicyAlertRules.id, mixedRuleId));
    expect(row!.conditions).toEqual(MIXED_CONDITIONS);
  });

  runDb('rebuilds the inline_settings items mirror for links that lost rows', async () => {
    const staleMirror = {
      items: [
        { name: 'Network usage high', severity: 'medium', conditions: NETWORK_CONDITIONS, sortOrder: 0 },
        { name: 'CPU high', severity: 'medium', conditions: CPU_CONDITIONS, sortOrder: 1 },
      ],
    };
    const { alertLinkId } = await createPolicyWithAlertLink('Policy — mirror rebuild', staleMirror);
    await insertRule(alertLinkId, 'Network usage high', NETWORK_CONDITIONS, 0);
    const cpuRuleId = await insertRule(alertLinkId, 'CPU high', CPU_CONDITIONS, 1);

    await runMigration();

    const link = await linkById(alertLinkId);
    const items = mirrorItems(link!.inlineSettings);
    expect(items.map((i) => i.name)).toEqual(['CPU high']);
    expect(items[0]).toMatchObject({
      name: 'CPU high',
      severity: 'medium',
      conditions: CPU_CONDITIONS,
      sortOrder: 1,
    });
    expect(await ruleIdsFor([cpuRuleId])).toEqual([cpuRuleId]);
  });

  runDb('empties the mirror when the link loses its only rule', async () => {
    // The grouped `GROUP BY feature_link_id` form of the rebuild would skip this
    // link entirely — no rows left to group — and strand the dead rule in the
    // mirror forever. This is the case that forces the per-link correlated form.
    const staleMirror = {
      items: [{ name: 'Network usage high', severity: 'medium', conditions: NETWORK_CONDITIONS, sortOrder: 0 }],
    };
    const { alertLinkId } = await createPolicyWithAlertLink('Policy — sole dead rule', staleMirror);
    await insertRule(alertLinkId, 'Network usage high', NETWORK_CONDITIONS, 0);

    await runMigration();

    const link = await linkById(alertLinkId);
    expect(link!.inlineSettings).toEqual({ items: [] });
  });

  runDb('is idempotent — second run changes zero rows, including updated_at', async () => {
    const db = getTestDb();
    const { policyId, alertLinkId } = await createPolicyWithAlertLink('Policy — idempotency');
    await insertRule(alertLinkId, 'Network usage high', NETWORK_CONDITIONS, 0);
    await insertRule(alertLinkId, 'CPU high', CPU_CONDITIONS, 1);

    await runMigration();

    const snapshot = async () => ({
      links: await db
        .select()
        .from(configPolicyFeatureLinks)
        .where(eq(configPolicyFeatureLinks.configPolicyId, policyId))
        .orderBy(asc(configPolicyFeatureLinks.id)),
      rules: await db
        .select()
        .from(configPolicyAlertRules)
        .where(eq(configPolicyAlertRules.featureLinkId, alertLinkId))
        .orderBy(asc(configPolicyAlertRules.id)),
    });

    const before = await snapshot();
    await runMigration();
    const after = await snapshot();

    // Deep equality includes updated_at: a replay that rewrote an identical
    // mirror would still bump it (and the partner-export watermark), which is
    // what the empty affected-links guard and IS DISTINCT FROM exist to prevent.
    expect(after).toEqual(before);
  });

  runDb('leaves an already-clean policy untouched', async () => {
    const { alertLinkId } = await createPolicyWithAlertLink('Policy — already clean', { items: [] });
    await insertRule(alertLinkId, 'CPU high', CPU_CONDITIONS, 0);

    // Deliberately stale mirror on a policy with nothing to drop: the migration
    // must not "helpfully" rebuild it, because it never lost a row.
    const before = await linkById(alertLinkId);
    await runMigration();
    const after = await linkById(alertLinkId);
    expect(after).toEqual(before);
  });
});
