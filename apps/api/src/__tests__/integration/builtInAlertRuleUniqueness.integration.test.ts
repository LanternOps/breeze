/**
 * #7650 — built-in anchor alert rules must exist at most once per org.
 *
 * "Patch job failures", "Reboot pending too long", the policy-violation bridge
 * rule and the config-compliance bridge rule are created lazily on first fire
 * by find-then-insert. Before the fix `alert_rules` had no unique key on that
 * identity, so two producers firing at once for the first time in an org could
 * each insert a rule; after #7639 both rows showed in the Built-in alerts list
 * with separate Active switches, and switching one off did not silence the
 * other.
 *
 * Against live PostgreSQL:
 *  1. Concurrent first fire of each creator leaves exactly one live row and
 *     every caller gets that row's id.
 *  2. The migration collapses duplicates that already exist: the oldest row
 *     survives, alerts move to it (a loser's open alert that would collide with
 *     the survivor's open alert on the same device is resolved first), "off"
 *     wins over "on", unrelated same-named rules are untouched, and a replay is
 *     a no-op.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/builtInAlertRuleUniqueness.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { alertRules, alertTemplates, alerts, devices } from '../../db/schema';
import { ensurePatchJobFailureRule, ensureRebootPendingRule } from '../../services/patchAlerts';
import { ensureRule as ensurePolicyRule } from '../../services/policyAlertBridge';
import {
  ensureRule as ensureConfigComplianceRule,
  type ResolvedComplianceRule,
} from '../../services/configComplianceAlertBridge';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION = '2026-11-19-110000-builtin-alert-rule-unique-index.sql';
const INDEX_NAME = 'alert_rules_builtin_anchor_uidx';
const RACERS = 8;

async function seedOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org!.id });
  return { orgId: org!.id, siteId: site!.id };
}

async function seedDevice(orgId: string, siteId: string) {
  const [d] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `br-agent-${randomUUID()}`,
      hostname: `br-host-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '10.0.19045',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning({ id: devices.id }));
  return d!.id;
}

async function liveRules(orgId: string, name: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: alertRules.id, isActive: alertRules.isActive })
    .from(alertRules)
    .where(and(eq(alertRules.orgId, orgId), eq(alertRules.name, name), isNull(alertRules.retiredAt))));
}

/** Every racer runs in its own system-scope transaction, i.e. its own pooled connection. */
async function race(fn: () => Promise<string>): Promise<string[]> {
  return Promise.all(Array.from({ length: RACERS }, () => withSystemDbAccessContext(fn)));
}

describe('built-in alert rules: concurrent first fire (#7650)', () => {
  runDb('ensurePatchJobFailureRule creates one rule under a concurrent first fire', async () => {
    const { orgId } = await seedOrg();
    const ids = await race(() => ensurePatchJobFailureRule(orgId));
    const rows = await liveRules(orgId, 'Patch job failures');
    expect(rows).toHaveLength(1);
    expect(new Set(ids)).toEqual(new Set([rows[0]!.id]));
  });

  runDb('ensureRebootPendingRule creates one rule under a concurrent first fire', async () => {
    const { orgId } = await seedOrg();
    const ids = await race(() => ensureRebootPendingRule(orgId));
    const rows = await liveRules(orgId, 'Reboot pending too long');
    expect(rows).toHaveLength(1);
    expect(new Set(ids)).toEqual(new Set([rows[0]!.id]));
  });

  runDb('the policy-violation bridge creates one rule under a concurrent first fire', async () => {
    const { orgId } = await seedOrg();
    const policyId = randomUUID();
    const ids = await race(() => ensurePolicyRule(orgId, policyId, 'Baseline', 'enforce'));
    const rows = await liveRules(orgId, `Policy Violation Rule:${policyId}`);
    expect(rows).toHaveLength(1);
    expect(new Set(ids)).toEqual(new Set([rows[0]!.id]));
  });

  runDb('the config-compliance bridge creates one rule under a concurrent first fire', async () => {
    const { orgId } = await seedOrg();
    const rule: ResolvedComplianceRule = {
      id: randomUUID(),
      name: 'Keep the agent installed',
      enforcementLevel: 'enforce',
      featureLinkId: randomUUID(),
      policyId: randomUUID(),
      policyName: 'Baseline',
      policyOrgId: orgId,
      policyPartnerId: null,
    };
    const ids = await race(() => ensureConfigComplianceRule(orgId, rule));
    const rows = await withSystemDbAccessContext(() => db
      .select({ id: alertRules.id, name: alertRules.name })
      .from(alertRules)
      .where(and(eq(alertRules.orgId, orgId), isNull(alertRules.retiredAt))));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name.startsWith(`Config Compliance Rule:${rule.featureLinkId}:`)).toBe(true);
    expect(new Set(ids)).toEqual(new Set([rows[0]!.id]));
  });

  runDb('an existing inactive rule is returned, not re-created ("off" stays off)', async () => {
    const { orgId } = await seedOrg();
    const id = await withSystemDbAccessContext(() => ensurePatchJobFailureRule(orgId));
    await withSystemDbAccessContext(() => db.update(alertRules).set({ isActive: false }).where(eq(alertRules.id, id)));
    const ids = await race(() => ensurePatchJobFailureRule(orgId));
    expect(new Set(ids)).toEqual(new Set([id]));
    expect(await liveRules(orgId, 'Patch job failures')).toEqual([{ id, isActive: false }]);
  });
});

describe(`migration ${MIGRATION}`, () => {
  const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
  afterAll(async () => {
    // Leave the database the way autoMigrate left it, whatever the test did.
    if (process.env.DATABASE_URL) await adminSql.unsafe(migrationSql());
    await adminSql.end({ timeout: 5 });
  });

  function migrationSql() {
    return readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
  }

  async function builtInTemplate() {
    const [t] = await withSystemDbAccessContext(() => db
      .insert(alertTemplates)
      .values({
        orgId: null,
        partnerId: null,
        name: `Patch job failure ${randomUUID().slice(0, 6)}`,
        conditions: { source: 'patch-job-finalizer' },
        severity: 'high',
        titleTemplate: 't',
        messageTemplate: 'm',
        autoResolve: false,
        isBuiltIn: true,
        cooldownMinutes: 240,
      })
      .returning({ id: alertTemplates.id }));
    return t!.id;
  }

  async function insertRule(values: {
    orgId: string;
    templateId: string;
    name: string;
    source: string | null;
    isActive?: boolean;
    createdAt: Date;
  }) {
    const [r] = await withSystemDbAccessContext(() => db
      .insert(alertRules)
      .values({
        orgId: values.orgId,
        templateId: values.templateId,
        name: values.name,
        targetType: 'org',
        targetId: values.orgId,
        isActive: values.isActive ?? true,
        overrideSettings: values.source === null ? {} : { source: values.source },
        createdAt: values.createdAt,
      })
      .returning({ id: alertRules.id }));
    return r!.id;
  }

  async function insertAlert(values: {
    orgId: string;
    ruleId: string;
    deviceId: string;
    status: 'active' | 'resolved';
  }) {
    const [a] = await withSystemDbAccessContext(() => db
      .insert(alerts)
      .values({
        orgId: values.orgId,
        ruleId: values.ruleId,
        deviceId: values.deviceId,
        status: values.status,
        severity: 'high',
        title: 'Patch job failed',
        message: 'm',
        ...(values.status === 'resolved' ? { resolvedAt: new Date() } : {}),
      })
      .returning({ id: alerts.id }));
    return a!.id;
  }

  async function alertRows(ids: string[]) {
    return withSystemDbAccessContext(() => db
      .select({
        id: alerts.id,
        ruleId: alerts.ruleId,
        status: alerts.status,
        resolutionReason: alerts.resolutionReason,
      })
      .from(alerts)
      .where(inArray(alerts.id, ids)));
  }

  runDb('collapses existing duplicates onto the oldest row, then enforces uniqueness, and replays as a no-op', async () => {
    await adminSql.unsafe(`DROP INDEX IF EXISTS ${INDEX_NAME}`);

    const { orgId, siteId } = await seedOrg();
    const other = await seedOrg();
    const deviceA = await seedDevice(orgId, siteId);
    const deviceB = await seedDevice(orgId, siteId);
    const templateId = await builtInTemplate();
    const t0 = Date.now() - 60_000;

    // Three live copies of the same built-in rule; the middle one is switched off.
    const survivor = await insertRule({ orgId, templateId, name: 'Patch job failures', source: 'patch-job-finalizer', createdAt: new Date(t0) });
    const loserOff = await insertRule({ orgId, templateId, name: 'Patch job failures', source: 'patch-job-finalizer', isActive: false, createdAt: new Date(t0 + 1_000) });
    const loser = await insertRule({ orgId, templateId, name: 'Patch job failures', source: 'patch-job-finalizer', createdAt: new Date(t0 + 2_000) });
    // Same name, but not a built-in anchor (no source): left alone.
    const notBuiltIn = await insertRule({ orgId, templateId, name: 'Patch job failures', source: null, createdAt: new Date(t0 + 3_000) });
    // Same name in another org: a different identity, left alone.
    const otherOrg = await insertRule({ orgId: other.orgId, templateId, name: 'Patch job failures', source: 'patch-job-finalizer', createdAt: new Date(t0 + 4_000) });
    // A second built-in identity in the same org, also duplicated, both on.
    const rebootSurvivor = await insertRule({ orgId, templateId, name: 'Reboot pending too long', source: 'maintenance-reboot-sweep', createdAt: new Date(t0) });
    const rebootLoser = await insertRule({ orgId, templateId, name: 'Reboot pending too long', source: 'maintenance-reboot-sweep', createdAt: new Date(t0 + 1_000) });

    // deviceA: open on the survivor AND on a loser → the loser's would collide on
    // alerts_open_rule_device_subject_uidx once re-pointed, so it is resolved.
    const survivorOpenA = await insertAlert({ orgId, ruleId: survivor, deviceId: deviceA, status: 'active' });
    const loserOpenA = await insertAlert({ orgId, ruleId: loser, deviceId: deviceA, status: 'active' });
    // deviceB: open on two losers only → the older loser's stays open, moved to the survivor.
    const loserOffOpenB = await insertAlert({ orgId, ruleId: loserOff, deviceId: deviceB, status: 'active' });
    const loserOpenB = await insertAlert({ orgId, ruleId: loser, deviceId: deviceB, status: 'active' });
    // History on a loser just moves.
    const loserResolved = await insertAlert({ orgId, ruleId: loser, deviceId: deviceA, status: 'resolved' });

    await adminSql.unsafe(migrationSql());

    const remaining = await withSystemDbAccessContext(() => db
      .select({ id: alertRules.id, isActive: alertRules.isActive })
      .from(alertRules)
      .where(inArray(alertRules.id, [survivor, loserOff, loser, notBuiltIn, otherOrg, rebootSurvivor, rebootLoser])));
    const byId = new Map(remaining.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual([survivor, notBuiltIn, otherOrg, rebootSurvivor].sort());
    // One copy was switched off, so the merged rule is off.
    expect(byId.get(survivor)!.isActive).toBe(false);
    expect(byId.get(rebootSurvivor)!.isActive).toBe(true);
    expect(byId.get(notBuiltIn)!.isActive).toBe(true);

    const moved = new Map((await alertRows([survivorOpenA, loserOpenA, loserOffOpenB, loserOpenB, loserResolved])).map((a) => [a.id, a]));
    for (const a of moved.values()) expect(a.ruleId).toBe(survivor);
    expect(moved.get(survivorOpenA)!.status).toBe('active');
    expect(moved.get(loserOpenA)!.status).toBe('resolved');
    expect(moved.get(loserOpenA)!.resolutionReason).toBe('source_retired');
    expect(moved.get(loserOffOpenB)!.status).toBe('active');
    expect(moved.get(loserOpenB)!.status).toBe('resolved');
    expect(moved.get(loserResolved)!.status).toBe('resolved');

    // The index now refuses a second live copy.
    await expect(insertRule({ orgId, templateId, name: 'Patch job failures', source: 'patch-job-finalizer', createdAt: new Date() }))
      .rejects.toThrow();
    // …but not a same-named rule outside the built-in set.
    await insertRule({ orgId, templateId, name: 'Patch job failures', source: null, createdAt: new Date() });

    // Replay is a no-op.
    await adminSql.unsafe(migrationSql());
    const after = await liveRules(orgId, 'Patch job failures');
    expect(after.map((r) => r.id)).toContain(survivor);
    expect(after).toHaveLength(3);
  });

  runDb('the index covers exactly the built-in sources the creators write', async () => {
    const [row] = await adminSql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${INDEX_NAME}`;
    expect(row?.indexdef).toBeDefined();
    for (const source of ['patch-job-finalizer', 'maintenance-reboot-sweep', 'policy-evaluation', 'config-policy-compliance']) {
      expect(row!.indexdef).toContain(`'${source}'`);
    }
    expect(row!.indexdef).toMatch(/UNIQUE INDEX/);
    expect(row!.indexdef).toContain('(org_id, name)');
  });
});
