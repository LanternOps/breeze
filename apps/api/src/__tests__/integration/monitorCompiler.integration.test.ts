/**
 * monitorCompiler — live compile round-trip (#5287 W02, Task 11 step 2).
 *
 * `compileMonitorInTx` is the ONLY writer of managed alert_templates /
 * alert_rules / automations rows; this suite proves the round-trip against
 * real Postgres: one compile produces exactly one row per table, a recompile
 * (after an edit) keeps the SAME three row ids so alert history and
 * automation runs stay attached, and deleting the definition cascades away
 * every managed row and policy attachment.
 *
 * The core round-trip below drives `compileMonitorInTx` / `verifyCompiled`
 * directly against a hand-inserted definition row, which is the narrowest way
 * to prove the compiler's own contract. The service-level path
 * (`createMonitorDefinition`, which validates and then compiles in one
 * transaction) gets its own describe block at the bottom — it is what a route
 * actually calls, and it is where a blocking bug hid: `validateDefinitionShape`
 * used to push `recurrenceActions` through `normalizeAutomationActions`, which
 * throws on an EMPTY array, so every create failed on the schema's own `[]`
 * default until that was fixed. An empty action list is a normal, supported
 * shape (an alert-only monitor), so it must stay covered here.
 */
import './setup';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alertRules,
  alertTemplates,
  automations,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configurationPolicies,
  monitorDefinitions,
  scripts,
  type MonitorDefinitionRow,
} from '../../db/schema';
import { compileMonitorInTx, verifyCompiled } from '../../services/monitors/monitorCompiler';
import { createMonitorDefinition } from '../../services/monitors/monitorService';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdOrgIds: string[] = [];
const createdPartnerIds: string[] = [];

afterEach(async () => {
  const orgIds = [...new Set(createdOrgIds)];
  const partnerIds = [...new Set(createdPartnerIds)];
  createdOrgIds.length = 0;
  createdPartnerIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    // monitor_definitions cascades (ON DELETE CASCADE) into alert_templates /
    // alert_rules / automations (managed_by_monitor_id) and config_policy_
    // monitors; deleting the org/policy tree deletes everything else through
    // their own cascades.
    const { inArray } = await import('drizzle-orm');
    if (orgIds.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.orgId, orgIds));
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.orgId, orgIds));
      await db.delete(scripts).where(inArray(scripts.orgId, orgIds));
    }
    if (partnerIds.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.partnerId, partnerIds));
    }
  });
});

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  createdPartnerIds.push(partner.id);
  createdOrgIds.push(org.id);

  // Owned by the SAME org as the monitor (org-scope automation-reference
  // resolution looks up the org's partner and requires the script to carry
  // BOTH orgId and that partnerId — see automationReferenceAuthorization.ts
  // `ownsScript` / `scriptOwnershipCondition`).
  const [script] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(scripts)
      .values({
        orgId: org.id,
        partnerId: partner.id,
        name: 'Free disk space',
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Get-Date',
      })
      .returning({ id: scripts.id }),
  );

  return { partnerId: partner.id, orgId: org.id, userId: user.id, scriptId: script!.id };
}

async function insertMonitor(f: Awaited<ReturnType<typeof fixture>>): Promise<MonitorDefinitionRow> {
  const [created] = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(monitorDefinitions)
      .values({
        orgId: f.orgId,
        partnerId: null,
        name: `Low disk (compiler test) ${randomUUID().slice(0, 8)}`,
        kind: 'disk',
        condition: { operator: 'gt', value: 80 },
        severity: 'high',
        responses: [{ type: 'run_script', scriptId: f.scriptId, whenOffline: 'queue' }],
        deliveryMode: 'channels',
        deliveryChannelIds: [randomUUID()],
        createdBy: f.userId,
      })
      .returning(),
  );
  return created!;
}

function compile(def: MonitorDefinitionRow) {
  return withDbAccessContext(SYSTEM_CTX, () => db.transaction((tx) => compileMonitorInTx(tx, def)));
}

async function fetchDefinition(id: string): Promise<MonitorDefinitionRow> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, id)),
  );
  return row!;
}

function templateRows(monitorId: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.select().from(alertTemplates).where(eq(alertTemplates.managedByMonitorId, monitorId)),
  );
}

function ruleRows(monitorId: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.select().from(alertRules).where(eq(alertRules.managedByMonitorId, monitorId)),
  );
}

function automationRows(monitorId: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.select().from(automations).where(eq(automations.managedByMonitorId, monitorId)),
  );
}

describe('monitorCompiler — compile round-trip against real Postgres (#5289)', () => {
  it('compiles exactly one managed row per table, with the right shape', async () => {
    const f = await fixture();
    const def = await insertMonitor(f);

    const refs = await compile(def);

    const [templates, rules, autos] = await Promise.all([
      templateRows(def.id),
      ruleRows(def.id),
      automationRows(def.id),
    ]);
    expect(templates).toHaveLength(1);
    expect(rules).toHaveLength(1);
    expect(autos).toHaveLength(1);
    expect(templates[0]!.id).toBe(refs.alertTemplateId);
    expect(rules[0]!.id).toBe(refs.alertRuleId);
    expect(autos[0]!.id).toBe(refs.automationId);

    // Rule targets the definition through the 'monitor' target type.
    expect(rules[0]!.targetType).toBe('monitor');
    expect(rules[0]!.targetId).toBe(def.id);

    // A SINGLE root condition object, never an array.
    expect(Array.isArray(templates[0]!.conditions)).toBe(false);
    expect(typeof templates[0]!.conditions).toBe('object');
    expect(templates[0]!.conditions).not.toBeNull();
    expect((templates[0]!.conditions as { type: string }).type).toBe('threshold');

    // Right after a compile, the stored rows and the definition agree.
    const fresh = await fetchDefinition(def.id);
    const verification = await withDbAccessContext(SYSTEM_CTX, () => verifyCompiled(fresh));
    expect(verification.inSync, `expected inSync, diff: ${verification.diff.join('; ')}`).toBe(true);
  });

  it('recompiling after an edit keeps the same three row ids and updates the stored condition', async () => {
    const f = await fixture();
    const def = await insertMonitor(f);
    const firstRefs = await compile(def);

    const [rule] = await ruleRows(def.id);
    const [template] = await templateRows(def.id);
    const [automation] = await automationRows(def.id);
    expect(rule!.id).toBe(firstRefs.alertRuleId);
    expect(template!.id).toBe(firstRefs.alertTemplateId);
    expect(automation!.id).toBe(firstRefs.automationId);

    // Raise the threshold — same shape update `updateMonitorDefinition` would
    // make to `condition` before recompiling.
    const [updated] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .update(monitorDefinitions)
        .set({ condition: { operator: 'gt', value: 95 }, updatedAt: new Date() })
        .where(eq(monitorDefinitions.id, def.id))
        .returning(),
    );
    const secondRefs = await compile(updated!);

    // Same three ids — alert history and automation runs stay attached.
    expect(secondRefs.alertTemplateId).toBe(firstRefs.alertTemplateId);
    expect(secondRefs.alertRuleId).toBe(firstRefs.alertRuleId);
    expect(secondRefs.automationId).toBe(firstRefs.automationId);
    expect(secondRefs.hash).not.toBe(firstRefs.hash);

    const [templateAfter] = await templateRows(def.id);
    expect((templateAfter!.conditions as { value: number }).value).toBe(95);

    const freshDef = await fetchDefinition(def.id);
    expect(freshDef.compiledHash).toBe(secondRefs.hash);
    const verification = await withDbAccessContext(SYSTEM_CTX, () => verifyCompiled(freshDef));
    expect(verification.inSync, `expected inSync, diff: ${verification.diff.join('; ')}`).toBe(true);
  });

  it('deleting the monitor cascades away every managed row and its policy attachment, with no orphan', async () => {
    const f = await fixture();
    const def = await insertMonitor(f);
    await compile(def);

    // Attach it to a policy so the delete also has to clean up config_policy_monitors.
    const { policyId, linkId } = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [policy] = await db
        .insert(configurationPolicies)
        .values({ orgId: f.orgId, name: `policy-${randomUUID().slice(0, 8)}`, status: 'active' })
        .returning({ id: configurationPolicies.id });
      const [link] = await db
        .insert(configPolicyFeatureLinks)
        .values({ configPolicyId: policy!.id, featureType: 'monitors' })
        .returning({ id: configPolicyFeatureLinks.id });
      await db.insert(configPolicyMonitors).values({ featureLinkId: link!.id, monitorId: def.id });
      return { policyId: policy!.id, linkId: link!.id };
    });

    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(monitorDefinitions).where(eq(monitorDefinitions.id, def.id)),
    );

    const [templates, rules, autos, attachments] = await Promise.all([
      templateRows(def.id),
      ruleRows(def.id),
      automationRows(def.id),
      withDbAccessContext(SYSTEM_CTX, () =>
        db.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.monitorId, def.id)),
      ),
    ]);
    expect(templates).toHaveLength(0);
    expect(rules).toHaveLength(0);
    expect(autos).toHaveLength(0);
    expect(attachments).toHaveLength(0);

    // Cleanup the policy tree explicitly — it is not covered by the org-scoped
    // afterEach delete-by-orgId sweep timing (the policy row itself is
    // deleted here rather than left for teardown so a second test's policy
    // insert never collides on this partner/org's rows).
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, linkId));
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, policyId));
    });
  });
});


/**
 * The path a route actually takes. Regression guard for the empty-action-list
 * bug described in this file's header: an alert-only monitor (no responses, no
 * recurrence actions) must create and compile.
 */
describe('createMonitorDefinition — service path (#5289)', () => {
  function authFor(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      principal: 'user',
      user: { id: f.userId, email: 'test@example.com', name: 'Test', isPlatformAdmin: false },
      token: null,
      partnerId: f.partnerId,
      orgId: f.orgId,
      scope: 'organization' as const,
      accessibleOrgIds: [f.orgId],
      partnerOrgAccess: null,
      orgCondition: (column: Parameters<typeof eq>[0]) => eq(column, f.orgId),
      canAccessOrg: (orgId: string) => orgId === f.orgId,
    } as unknown as Parameters<typeof createMonitorDefinition>[1];
  }

  it('creates and compiles an ALERT-ONLY monitor (no responses, no recurrence actions)', async () => {
    const f = await fixture();
    const created = await withDbAccessContext(SYSTEM_CTX, () =>
      createMonitorDefinition(
        {
          ownerScope: 'organization',
          name: `Alert only ${randomUUID().slice(0, 8)}`,
          kind: 'cpu',
          enabled: true,
          condition: { operator: 'gt', value: 90 },
          severity: 'high',
          cooldownMinutes: 5,
          autoResolve: false,
          responses: [],
          deliveryMode: 'inherit',
          deliveryChannelIds: [],
          recurrenceActions: [],
          pauseResponsesOnEscalation: true,
        } as unknown as Parameters<typeof createMonitorDefinition>[0],
        authFor(f),
      ),
    );

    expect(created.id).toBeDefined();

    const [stored] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, created.id)),
    );
    expect(stored?.compiledAlertRuleId).toBeTruthy();
    expect(stored?.compiledHash).toBeTruthy();

    const [rule] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(alertRules).where(eq(alertRules.managedByMonitorId, created.id)),
    );
    expect(rule?.targetType).toBe('monitor');
    expect(rule?.targetId).toBe(created.id);

    // The compiled automation exists but is disabled: no responses means no
    // work, and an enabled row would cost a worker dispatch per alert.
    const [automation] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(automations).where(eq(automations.managedByMonitorId, created.id)),
    );
    expect(automation?.enabled).toBe(false);

    const verification = await withDbAccessContext(SYSTEM_CTX, () =>
      verifyCompiled({ ...(stored as MonitorDefinitionRow) }),
    );
    expect(verification.diff).toEqual([]);
    expect(verification.inSync).toBe(true);
  });

  it('creates a monitor WITH a run_script response and enables its automation', async () => {
    const f = await fixture();
    const created = await withDbAccessContext(SYSTEM_CTX, () =>
      createMonitorDefinition(
        {
          ownerScope: 'organization',
          name: `With response ${randomUUID().slice(0, 8)}`,
          kind: 'disk',
          enabled: true,
          condition: { operator: 'gt', value: 80 },
          severity: 'high',
          cooldownMinutes: 5,
          autoResolve: false,
          responses: [{ type: 'run_script', scriptId: f.scriptId, whenOffline: 'queue' }],
          deliveryMode: 'inherit',
          deliveryChannelIds: [],
          recurrenceActions: [],
          pauseResponsesOnEscalation: true,
        } as unknown as Parameters<typeof createMonitorDefinition>[0],
        authFor(f),
      ),
    );

    const [automation] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(automations).where(eq(automations.managedByMonitorId, created.id)),
    );
    expect(automation?.enabled).toBe(true);
    expect(automation?.managedByMonitorId).toBe(created.id);
  });
});
