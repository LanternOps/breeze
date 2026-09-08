/**
 * One-level configuration-policy inheritance (#5080 W01) against real Postgres.
 *
 * Migration under test: 2026-10-12-100000-config-policy-inheritance.sql.
 *
 * Everything here needs a live database and RLS: the code under test connects as
 * `breeze_app` (DATABASE_URL_APP, see ./setup), so a forged INSERT genuinely
 * meets the constraint trigger and the view genuinely runs under
 * `security_invoker`. None of it is reachable from a mocked unit test — mocks
 * have no triggers, no RLS, and no view.
 *
 * Four properties:
 *
 *  1. OWNERSHIP. The service rejects an ineligible parent with a friendly
 *     InvalidParentPolicyError, and the constraint trigger rejects the same edge
 *     when the service is bypassed entirely. The service check is a nicety; the
 *     trigger is the authority, and the forge tests are what prove that.
 *  2. IMMUTABILITY. parent_policy_id cannot change after insert — including
 *     NULL -> value, so a baseline can never retroactively acquire a parent.
 *     Ownership can only move in system context, and a whole-family move under
 *     `SET CONSTRAINTS ALL DEFERRED` (what org merge does) still commits.
 *  3. THE VIEW. A child sees its own link for an overridden feature type and the
 *     PARENT's link — carrying the parent link's id — for one it does not
 *     override. It resolves through RLS for an org session reading a
 *     partner-wide parent, and for an agent-shaped session, with no
 *     system-context escalation anywhere.
 *  4. DELETION. A parent with children cannot be deleted alone, but an org
 *     cascade that removes the family in ONE statement still succeeds.
 *  5. ERASURE ROW-SET CLOSURE. The org-erasure FK ledger
 *     (orgCascadeFkOnDeleteAllowlist.ts) pins this self-FK with a reviewed
 *     argument instead of a migration. The "erasure row-set closure" describe
 *     block below is that argument's evidence, plus the two service-shape
 *     properties it leans on (single-statement org erasure; the partner purge
 *     clearing org children before partner-wide baselines).
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyEffectiveFeatureLinks,
  configPolicyAssignments,
  configPolicyAlertRules,
  configPolicyEventLogSettings,
  devices,
} from '../../db/schema';
import {
  createConfigPolicy,
  deleteConfigPolicy,
  getConfigPolicy,
  getParentLinkFeatureTypes,
  listEligibleParentPolicies,
  InvalidParentPolicyError,
  PolicyHasChildrenError,
} from '../../services/configurationPolicy';
import { resolveEffectiveConfig } from '../../services/configurationPolicy';
import { resolveAlertRulesForDevice } from '../../services/featureConfigResolver';
import { buildEventLogConfigUpdate, EVENT_LOG_DEFAULTS } from '../../routes/agents/helpers';
import { resolveHelperPermissionLevelForDevice } from '../../services/helperPermissions';
import { getOrgPurgeRemovedAfterDays } from '../../services/deviceLifecyclePolicy';
import { cascadeDeleteOrg, cascadeDeletePartner } from '../../services/tenantCascade';
import type { AuthContext } from '../../middleware/auth';
import { createPartner, createOrganization, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[] = []): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/**
 * An ORG-scoped session. `currentPartnerId` is populated from the token's
 * partnerId for org scope (buildDbAccessContext), which is what the
 * `*_partner_wide_select` read branch keys on. `accessiblePartnerIds` stays
 * EMPTY — an org token never passes `breeze_has_partner_access`, which is what
 * keeps that branch read-only.
 */
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

/**
 * The AGENT session shape: no org/partner ACCESS at all, but
 * `breeze.current_partner_id` IS populated (middleware/agentAuth.ts, #4673 W02).
 * Agent config delivery must inherit through the same read branch with no
 * escalation.
 */
function agentContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function orgAuth(orgId: string, partnerId: string): AuthContext {
  return {
    scope: 'organization',
    orgId,
    partnerId,
    accessibleOrgIds: [orgId],
    partnerOrgAccess: undefined,
    user: { id: null },
    // Honour the column the caller passes: the effective-config resolver
    // applies this to `devices.org_id`, not to configuration_policies. A
    // hardcoded column produces a query referencing a table that is not in the
    // FROM clause (42P01), which is a harness bug that looks like a code bug.
    orgCondition: (col?: unknown) =>
      eq((col ?? configurationPolicies.orgId) as typeof configurationPolicies.orgId, orgId),
    canAccessOrg: (o: string) => o === orgId,
  } as unknown as AuthContext;
}

function partnerAuth(partnerId: string, orgIds: string[]): AuthContext {
  return {
    scope: 'partner',
    orgId: null,
    partnerId,
    accessibleOrgIds: orgIds,
    partnerOrgAccess: 'all',
    user: { id: null },
    orgCondition: () => inArray(configurationPolicies.orgId, orgIds),
    canAccessOrg: (o: string) => orgIds.includes(o),
  } as unknown as AuthContext;
}

async function expectSqlState(fn: () => Promise<unknown>, code: string, constraint?: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string; constraint_name?: string } })?.cause;
  const node = cause?.code ? cause : (raised as { code?: string; constraint_name?: string });
  expect(node.code).toBe(code);
  if (constraint) expect(node.constraint_name).toBe(constraint);
}

const createdPolicies: string[] = [];

function track<T extends { id: string }>(row: T): T {
  createdPolicies.push(row.id);
  return row;
}

/**
 * Teardown has to respect two independent orderings, which is why it is one row
 * per transaction rather than one bulk statement:
 *
 *  - the self-FK is NO ACTION, so every CHILD must go before its parent; and
 *  - `breeze_partner_export_lock_partners_exclusive` refuses a partner lock
 *    taken after an org lock in the SAME transaction, so a single DELETE
 *    spanning org-owned and partner-wide policies raises P0001.
 *
 * Deleting one id at a time in its own transaction satisfies both without
 * encoding assumptions about which shape a given test seeded.
 */
afterEach(async () => {
  if (createdPolicies.length === 0) return;
  const ids = [...createdPolicies];
  createdPolicies.length = 0;

  const surviving = await withDbAccessContext(SYSTEM_CTX, () =>
    db.select({ id: configurationPolicies.id, parentPolicyId: configurationPolicies.parentPolicyId })
      .from(configurationPolicies)
      .where(inArray(configurationPolicies.id, ids)));

  const ordered = [
    ...surviving.filter((r) => r.parentPolicyId !== null),
    ...surviving.filter((r) => r.parentPolicyId === null),
  ];
  for (const row of ordered) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(configurationPolicies).where(eq(configurationPolicies.id, row.id)));
  }
});

// --- W02 resolution helpers -------------------------------------------------
// Devices are tracked separately from policies: a device outlives the policies
// assigned to it, and the policy teardown above is ordered by the self-FK.
const createdDevices: string[] = [];

afterEach(async () => {
  if (createdDevices.length === 0) return;
  const ids = [...createdDevices];
  createdDevices.length = 0;
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.delete(devices).where(inArray(devices.id, ids)));
});

async function seedInheritanceDevice(orgId: string, siteId: string): Promise<{ id: string }> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-inh-${suffix}`,
        hostname: `host-inh-${suffix}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole: 'workstation',
      })
      .returning({ id: devices.id });
    createdDevices.push(row!.id);
    return row!;
  });
}

async function seedAssignment(
  configPolicyId: string,
  level: 'partner' | 'organization' | 'site',
  targetId: string,
  priority = 0,
): Promise<void> {
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(configPolicyAssignments).values({ configPolicyId, level, targetId, priority }));
}

/** An event_log link plus its normalized settings row, keyed by the link id. */
async function seedEventLogLink(configPolicyId: string, maxEventsPerCycle: number): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId, featureType: 'event_log' })
      .returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyEventLogSettings).values({
      featureLinkId: link!.id,
      maxEventsPerCycle,
    });
    return link!.id;
  });
}

/** A link whose settings live entirely in the compat inline JSONB. */
async function seedInlineLink(
  configPolicyId: string,
  featureType: 'helper' | 'device_lifecycle',
  inlineSettings: Record<string, unknown>,
): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId, featureType, inlineSettings })
      .returning({ id: configPolicyFeatureLinks.id });
    return link!.id;
  });
}

/** An alert_rule link plus one rule row hanging off it. */
async function seedAlertRuleLink(configPolicyId: string, name: string): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId, featureType: 'alert_rule' })
      .returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyAlertRules).values({
      featureLinkId: link!.id,
      name,
      severity: 'medium',
      conditions: { metric: 'cpu', operator: 'gt', threshold: 90 },
    });
    return link!.id;
  });
}

interface Tenancy {
  p1: string;
  p2: string;
  a1: string;
  a2: string;
  b1: string;
}

async function seedTenancy(): Promise<Tenancy> {
  const p1 = await createPartner();
  const p2 = await createPartner();
  const a1 = await createOrganization({ partnerId: p1.id });
  const a2 = await createOrganization({ partnerId: p1.id });
  const b1 = await createOrganization({ partnerId: p2.id });
  return { p1: p1.id, p2: p2.id, a1: a1.id, a2: a2.id, b1: b1.id };
}

/** Insert a policy directly under system scope (seeding, not the path under test). */
async function seedPolicy(values: {
  orgId?: string | null;
  partnerId?: string | null;
  name: string;
  parentPolicyId?: string | null;
}): Promise<{ id: string }> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = await db
      .insert(configurationPolicies)
      .values({
        orgId: values.orgId ?? null,
        partnerId: values.partnerId ?? null,
        name: values.name,
        parentPolicyId: values.parentPolicyId ?? null,
      })
      .returning({ id: configurationPolicies.id });
    return track(row!);
  });
}

async function seedLink(configPolicyId: string, featureType: 'event_log' | 'monitoring'): Promise<string> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId, featureType, inlineSettings: { marker: featureType } })
      .returning({ id: configPolicyFeatureLinks.id });
    return row!.id;
  });
}

// ============================================================
// 1. Ownership — service layer and the trigger behind it
// ============================================================

describe('config policy inheritance — ownership (live DB)', () => {
  it('org token: a child of a same-org parent is created with the parent persisted', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'A1 baseline' });

    const child = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      createConfigPolicy({ orgId: t.a1 }, { name: 'A1 child', parentPolicyId: parent.id }, null as never));
    track(child);

    expect(child.parentPolicyId).toBe(parent.id);
  });

  it('org token: a child of the org partner\'s PARTNER-WIDE parent is created', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });

    const child = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      createConfigPolicy({ orgId: t.a1 }, { name: 'A1 child', parentPolicyId: parent.id }, null as never));
    track(child);

    expect(child.parentPolicyId).toBe(parent.id);
  });

  it('org token: another org\'s parent is rejected as INVALID_PARENT_POLICY', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a2, name: 'A2 baseline' });

    await expect(
      withDbAccessContext(orgContext(t.a1, t.p1), () =>
        createConfigPolicy({ orgId: t.a1 }, { name: 'child', parentPolicyId: parent.id }, null as never)),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
  });

  it('org token: another PARTNER\'s partner-wide parent is rejected', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p2, name: 'Other MSP baseline' });

    await expect(
      withDbAccessContext(orgContext(t.a1, t.p1), () =>
        createConfigPolicy({ orgId: t.a1 }, { name: 'child', parentPolicyId: parent.id }, null as never)),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
  });

  it('org token: a parent that already has a parent is rejected (one level only)', async () => {
    const t = await seedTenancy();
    const grand = await seedPolicy({ orgId: t.a1, name: 'grand' });
    const parent = await seedPolicy({ orgId: t.a1, name: 'parent', parentPolicyId: grand.id });

    await expect(
      withDbAccessContext(orgContext(t.a1, t.p1), () =>
        createConfigPolicy({ orgId: t.a1 }, { name: 'child', parentPolicyId: parent.id }, null as never)),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
  });

  it('partner-wide child: an ORG-OWNED parent is rejected', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'A1 baseline' });

    await expect(
      withDbAccessContext(partnerContext(t.p1, [t.a1, t.a2]), () =>
        createConfigPolicy({ partnerId: t.p1 }, { name: 'wide child', parentPolicyId: parent.id }, null as never)),
    ).rejects.toBeInstanceOf(InvalidParentPolicyError);
  });

  // The service check is a nicety. THESE are the tests that matter: they bypass
  // the service entirely and prove the database refuses the edge on its own.
  it('FORGE as breeze_app: a cross-ORG parent hits the constraint trigger', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a2, name: 'A2 baseline' });

    await expectSqlState(
      () => withDbAccessContext(orgContext(t.a1, t.p1), () => db.execute(sql`
        INSERT INTO configuration_policies (org_id, name, parent_policy_id)
        VALUES (${t.a1}::uuid, 'forged cross-org child', ${parent.id}::uuid)
      `)),
      '23514',
      'configuration_policies_parent_guard',
    );
  });

  it('FORGE as breeze_app: another partner\'s partner-wide parent hits the trigger', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p2, name: 'Other MSP baseline' });

    await expectSqlState(
      () => withDbAccessContext(orgContext(t.a1, t.p1), () => db.execute(sql`
        INSERT INTO configuration_policies (org_id, name, parent_policy_id)
        VALUES (${t.a1}::uuid, 'forged cross-partner child', ${parent.id}::uuid)
      `)),
      '23514',
      'configuration_policies_parent_guard',
    );
  });

  it('FORGE as breeze_app: a two-level chain hits the trigger', async () => {
    const t = await seedTenancy();
    const grand = await seedPolicy({ orgId: t.a1, name: 'grand' });
    const parent = await seedPolicy({ orgId: t.a1, name: 'parent', parentPolicyId: grand.id });

    await expectSqlState(
      () => withDbAccessContext(orgContext(t.a1, t.p1), () => db.execute(sql`
        INSERT INTO configuration_policies (org_id, name, parent_policy_id)
        VALUES (${t.a1}::uuid, 'forged grandchild', ${parent.id}::uuid)
      `)),
      '23514',
      'configuration_policies_parent_guard',
    );
  });

  /**
   * Root-cause regression for the fail-open bug the forge test above caught.
   *
   * `breeze_config_policy_parent_compatible` is called as `... IS NOT TRUE` by
   * both guards, but it must ALSO never return NULL on its own: under
   * three-valued logic `parent_org = child_org` is NULL whenever the parent is
   * partner-wide, so `NULL OR false` was NULL, `NOT NULL` was NULL, and the
   * guard silently accepted a cross-partner parent. Assert the function is
   * strictly two-valued for every shape, including unknown ids.
   */
  it('the SQL compatibility function is strictly two-valued (never NULL)', async () => {
    const t = await seedTenancy();
    const unknown = '00000000-0000-4000-8000-0000000000ff';

    // Called on the OWNER connection: the migration REVOKEs EXECUTE from PUBLIC
    // so `breeze_app` cannot use the function as an "is org X under partner P"
    // oracle. That revoke is itself asserted below.
    const [row] = (await getTestDb().execute(sql`
      SELECT
        -- org child <- another partner's partner-wide parent: the shape that was NULL
        public.breeze_config_policy_parent_compatible(${t.a1}::uuid, NULL, NULL, ${t.p2}::uuid) AS cross_partner_wide,
        -- org child <- own partner's partner-wide parent
        public.breeze_config_policy_parent_compatible(${t.a1}::uuid, NULL, NULL, ${t.p1}::uuid) AS own_partner_wide,
        -- org child <- same-org parent
        public.breeze_config_policy_parent_compatible(${t.a1}::uuid, NULL, ${t.a1}::uuid, NULL) AS same_org,
        -- org child <- other-org parent
        public.breeze_config_policy_parent_compatible(${t.a1}::uuid, NULL, ${t.a2}::uuid, NULL) AS other_org,
        -- child org that does not exist (or is invisible): the sub-select is NULL
        public.breeze_config_policy_parent_compatible(${unknown}::uuid, NULL, NULL, ${t.p1}::uuid) AS unknown_child_org,
        -- partner-wide child <- same / other partner-wide parent
        public.breeze_config_policy_parent_compatible(NULL, ${t.p1}::uuid, NULL, ${t.p1}::uuid) AS wide_same_partner,
        public.breeze_config_policy_parent_compatible(NULL, ${t.p1}::uuid, NULL, ${t.p2}::uuid) AS wide_other_partner,
        -- partner-wide child <- org-owned parent
        public.breeze_config_policy_parent_compatible(NULL, ${t.p1}::uuid, ${t.a1}::uuid, NULL) AS wide_org_parent,
        -- neither axis set
        public.breeze_config_policy_parent_compatible(NULL, NULL, NULL, ${t.p1}::uuid) AS no_owner
    `)) as unknown as Record<string, unknown>[];

    expect(row).toEqual({
      cross_partner_wide: false,
      own_partner_wide: true,
      same_org: true,
      other_org: false,
      unknown_child_org: false,
      wide_same_partner: true,
      wide_other_partner: false,
      wide_org_parent: false,
      no_owner: false,
    });
  });

  it('the compatibility function is NOT callable by breeze_app (no tenancy oracle)', async () => {
    const t = await seedTenancy();
    await expectSqlState(
      () => withDbAccessContext(orgContext(t.a1, t.p1), () => db.execute(sql`
        SELECT public.breeze_config_policy_parent_compatible(${t.a1}::uuid, NULL, NULL, ${t.p2}::uuid)
      `)),
      '42501',
    );
  });

  it('partner-wide child: a partner-wide parent of the SAME partner is accepted', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });

    const child = await withDbAccessContext(partnerContext(t.p1, [t.a1, t.a2]), () =>
      createConfigPolicy({ partnerId: t.p1 }, { name: 'wide child', parentPolicyId: parent.id }, null as never));
    track(child);

    expect(child.parentPolicyId).toBe(parent.id);
    expect(child.orgId).toBeNull();
    expect(child.partnerId).toBe(t.p1);
  });

  it('FORGE as breeze_app: a PARTNER-WIDE child naming an org-owned parent hits the trigger', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'A1 baseline' });

    await expectSqlState(
      () => withDbAccessContext(partnerContext(t.p1, [t.a1, t.a2]), () => db.execute(sql`
        INSERT INTO configuration_policies (partner_id, name, parent_policy_id)
        VALUES (${t.p1}::uuid, 'forged wide child of org parent', ${parent.id}::uuid)
      `)),
      '23514',
      'configuration_policies_parent_guard',
    );
  });

  // Self-parenting is unreachable through the service (the id is generated by the
  // DB) and UPDATE is blocked by immutability first, so the CHECK can only be
  // reached by naming the id explicitly on INSERT.
  it('FORGE as breeze_app: a policy that names itself as parent hits the CHECK', async () => {
    const t = await seedTenancy();
    const selfId = '11111111-2222-4333-8444-555555555555';

    await expectSqlState(
      () => withDbAccessContext(orgContext(t.a1, t.p1), () => db.execute(sql`
        INSERT INTO configuration_policies (id, org_id, name, parent_policy_id)
        VALUES (${selfId}::uuid, ${t.a1}::uuid, 'forged self parent', ${selfId}::uuid)
      `)),
      '23514',
      'configuration_policies_not_own_parent_chk',
    );
  });

  // The comment on listEligibleParentPolicies says archived roots are offered on
  // purpose (a parent's status does not gate inheritance, so hiding it would
  // misrepresent what is selectable). Pin that decision.
  it('eligible parents still include an ARCHIVED root', async () => {
    const t = await seedTenancy();
    const archived = await seedPolicy({ orgId: t.a1, name: 'ZZZ archived root' });
    await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      UPDATE configuration_policies SET status = 'archived' WHERE id = ${archived.id}::uuid
    `));

    const rows = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      listEligibleParentPolicies(orgAuth(t.a1, t.p1), { ownerScope: 'organization', orgId: t.a1 }));

    expect(rows.map((r) => r.id)).toContain(archived.id);
  });

  it('eligible parents for an org caller include the partner baseline, never another partner\'s', async () => {
    const t = await seedTenancy();
    const own = await seedPolicy({ orgId: t.a1, name: 'AAA own root' });
    const wide = await seedPolicy({ partnerId: t.p1, name: 'BBB msp root' });
    const otherOrg = await seedPolicy({ orgId: t.a2, name: 'CCC other org root' });
    const otherPartner = await seedPolicy({ partnerId: t.p2, name: 'DDD other msp root' });
    // A non-root must never be offered as a parent.
    await seedPolicy({ orgId: t.a1, name: 'EEE child', parentPolicyId: own.id });

    const rows = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      listEligibleParentPolicies(orgAuth(t.a1, t.p1), { ownerScope: 'organization', orgId: t.a1 }));

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(own.id);
    expect(ids).toContain(wide.id);
    expect(ids).not.toContain(otherOrg.id);
    expect(ids).not.toContain(otherPartner.id);
    expect(rows.find((r) => r.id === wide.id)?.ownerScope).toBe('partner');
    expect(rows.find((r) => r.id === own.id)?.ownerScope).toBe('organization');
  });
});

// ============================================================
// 2. Immutability and ownership moves
// ============================================================

describe('config policy inheritance — immutability (live DB)', () => {
  it('UPDATE parent_policy_id NULL -> value is rejected', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'baseline' });
    const orphan = await seedPolicy({ orgId: t.a1, name: 'standalone' });

    await expectSqlState(
      () => withDbAccessContext(orgContext(t.a1, t.p1), () => db.execute(sql`
        UPDATE configuration_policies SET parent_policy_id = ${parent.id}::uuid WHERE id = ${orphan.id}::uuid
      `)),
      '23514',
      'configuration_policies_parent_immutable',
    );
  });

  it('UPDATE parent_policy_id value -> NULL (detach) is rejected', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'child', parentPolicyId: parent.id });

    await expectSqlState(
      () => withDbAccessContext(orgContext(t.a1, t.p1), () => db.execute(sql`
        UPDATE configuration_policies SET parent_policy_id = NULL WHERE id = ${child.id}::uuid
      `)),
      '23514',
      'configuration_policies_parent_immutable',
    );
  });

  it('an ownership move outside system scope is rejected', async () => {
    const t = await seedTenancy();
    const policy = await seedPolicy({ orgId: t.a1, name: 'movable' });

    await expectSqlState(
      () => withDbAccessContext(partnerContext(t.p1, [t.a1, t.a2]), () => db.execute(sql`
        UPDATE configuration_policies SET org_id = ${t.a2}::uuid WHERE id = ${policy.id}::uuid
      `)),
      '23514',
      'configuration_policies_owner_immutable',
    );
  });

  // What org merge actually does: SET CONSTRAINTS ALL DEFERRED, then re-point
  // parent and child org_id in SEPARATE statements. Between the two the rule is
  // violated; only the deferral to COMMIT makes it legal. A plain (non-constraint)
  // trigger would abort here, which is the whole reason this is a CONSTRAINT
  // trigger.
  it('a whole-family org move in system scope under SET CONSTRAINTS ALL DEFERRED commits', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'family parent' });
    const child = await seedPolicy({ orgId: t.a1, name: 'family child', parentPolicyId: parent.id });

    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      // Child first: this is the ordering that is transiently illegal.
      await db.execute(sql`UPDATE configuration_policies SET org_id = ${t.a2}::uuid WHERE id = ${child.id}::uuid`);
      await db.execute(sql`UPDATE configuration_policies SET org_id = ${t.a2}::uuid WHERE id = ${parent.id}::uuid`);
    });

    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId })
        .from(configurationPolicies)
        .where(inArray(configurationPolicies.id, [parent.id, child.id])));

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.orgId === t.a2)).toBe(true);
  });

  // The other half of the incoming-edge check: a partial org-merge re-point that
  // moves the PARENT and leaves the children behind. Without this the "whole
  // family move" test above would still pass even if the orphan clause were dead,
  // because it validates already-consistent data at commit.
  it('moving ONLY the parent, leaving children behind, is rejected even in system scope', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'leaving parent' });
    await seedPolicy({ orgId: t.a1, name: 'stranded child', parentPolicyId: parent.id });

    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
        UPDATE configuration_policies SET org_id = ${t.a2}::uuid WHERE id = ${parent.id}::uuid
      `)),
      '23514',
      'configuration_policies_parent_guard',
    );
  });

  it('moving ONLY the child out of the family is rejected even in system scope', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'stay parent' });
    const child = await seedPolicy({ orgId: t.a1, name: 'leaving child', parentPolicyId: parent.id });

    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
        UPDATE configuration_policies SET org_id = ${t.a2}::uuid WHERE id = ${child.id}::uuid
      `)),
      '23514',
      'configuration_policies_parent_guard',
    );
  });
});

// ============================================================
// 2b. The organizations-side guard
// ============================================================

/**
 * `organizations_partner_config_policy_guard` exists because moving an ORG to a
 * different partner would strand any of its policies that inherit from the OLD
 * partner's partner-wide baseline — the child would keep pointing at a parent
 * its new partner does not own. No code path re-points `organizations.partner_id`
 * today, which is exactly why this needs a test: it is defensive code with no
 * caller to notice if it silently stopped working.
 */
describe('config policy inheritance — organizations partner guard (live DB)', () => {
  it('re-pointing an org to another partner is rejected while it has children of the old partner\'s baseline', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    await seedPolicy({ orgId: t.a1, name: 'inheriting child', parentPolicyId: parent.id });

    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
        UPDATE organizations SET partner_id = ${t.p2}::uuid WHERE id = ${t.a1}::uuid
      `)),
      '23514',
      'organizations_partner_config_policy_guard',
    );
  });

  // Control: the guard must be narrow. Without this the test above would pass
  // even if the trigger rejected EVERY partner change.
  it('re-pointing an org with no inheriting policies is allowed', async () => {
    const t = await seedTenancy();

    await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      UPDATE organizations SET partner_id = ${t.p2}::uuid WHERE id = ${t.a2}::uuid
    `));

    const [row] = await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      SELECT partner_id FROM organizations WHERE id = ${t.a2}::uuid
    `)) as unknown as { partner_id: string }[];
    expect(row!.partner_id).toBe(t.p2);
  });

  // A child of a SAME-ORG parent is unaffected by its org changing partner —
  // the guard only cares about partner-wide parents.
  it('re-pointing an org whose policies inherit from a SAME-ORG parent is allowed', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a2, name: 'A2 baseline' });
    await seedPolicy({ orgId: t.a2, name: 'A2 child', parentPolicyId: parent.id });

    await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      UPDATE organizations SET partner_id = ${t.p2}::uuid WHERE id = ${t.a2}::uuid
    `));

    const [row] = await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      SELECT partner_id FROM organizations WHERE id = ${t.a2}::uuid
    `)) as unknown as { partner_id: string }[];
    expect(row!.partner_id).toBe(t.p2);
  });
});

// ============================================================
// 3. The effective-links view
// ============================================================

describe('config policy inheritance — effective-links view (live DB)', () => {
  it('a child inherits an un-overridden feature type and keeps the PARENT link id', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'child', parentPolicyId: parent.id });
    const parentEventLog = await seedLink(parent.id, 'event_log');
    const parentMonitoring = await seedLink(parent.id, 'monitoring');
    const childMonitoring = await seedLink(child.id, 'monitoring');

    const rows = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      db.select({
        id: configPolicyEffectiveFeatureLinks.id,
        featureType: configPolicyEffectiveFeatureLinks.featureType,
        sourcePolicyId: configPolicyEffectiveFeatureLinks.sourcePolicyId,
        inherited: configPolicyEffectiveFeatureLinks.inherited,
      })
        .from(configPolicyEffectiveFeatureLinks)
        .where(eq(configPolicyEffectiveFeatureLinks.configPolicyId, child.id)));

    const byType = Object.fromEntries(rows.map((r) => [r.featureType, r]));
    expect(Object.keys(byType).sort()).toEqual(['event_log', 'monitoring']);

    // Inherited: the parent's row, carrying the PARENT link id so joins on
    // config_policy_*_settings.feature_link_id keep resolving.
    expect(byType.event_log).toMatchObject({
      id: parentEventLog,
      sourcePolicyId: parent.id,
      inherited: true,
    });
    // Overridden: the child's own row wins completely.
    expect(byType.monitoring).toMatchObject({
      id: childMonitoring,
      sourcePolicyId: child.id,
      inherited: false,
    });
    expect(byType.monitoring!.id).not.toBe(parentMonitoring);
  });

  it('the parent itself sees only its own links, never its children\'s', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'child', parentPolicyId: parent.id });
    const parentEventLog = await seedLink(parent.id, 'event_log');
    await seedLink(child.id, 'monitoring');

    const rows = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      db.select({
        id: configPolicyEffectiveFeatureLinks.id,
        featureType: configPolicyEffectiveFeatureLinks.featureType,
        inherited: configPolicyEffectiveFeatureLinks.inherited,
      })
        .from(configPolicyEffectiveFeatureLinks)
        .where(eq(configPolicyEffectiveFeatureLinks.configPolicyId, parent.id)));

    expect(rows).toEqual([{ id: parentEventLog, featureType: 'event_log', inherited: false }]);
  });

  // The load-bearing case: an ORG session reading a PARTNER-WIDE parent's links
  // through the view, with no system-context escalation. This only works because
  // security_invoker lets the *_partner_wide_select branches apply.
  it('an ORG session sees a PARTNER-WIDE parent\'s links through the view', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'child', parentPolicyId: parent.id });
    const parentEventLog = await seedLink(parent.id, 'event_log');

    const rows = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      db.select({
        id: configPolicyEffectiveFeatureLinks.id,
        inherited: configPolicyEffectiveFeatureLinks.inherited,
      })
        .from(configPolicyEffectiveFeatureLinks)
        .where(eq(configPolicyEffectiveFeatureLinks.configPolicyId, child.id)));

    expect(rows).toEqual([{ id: parentEventLog, inherited: true }]);
  });

  it('an AGENT-shaped session inherits the same partner-wide links', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'child', parentPolicyId: parent.id });
    const parentEventLog = await seedLink(parent.id, 'event_log');

    const rows = await withDbAccessContext(agentContext(t.a1, t.p1), () =>
      db.select({ id: configPolicyEffectiveFeatureLinks.id })
        .from(configPolicyEffectiveFeatureLinks)
        .where(eq(configPolicyEffectiveFeatureLinks.configPolicyId, child.id)));

    expect(rows).toEqual([{ id: parentEventLog }]);
  });

  // The view must not become a hole: it is security_invoker precisely so a
  // session cannot read another tenant's links through it.
  it('the view leaks nothing across tenants', async () => {
    const t = await seedTenancy();
    const otherParent = await seedPolicy({ partnerId: t.p2, name: 'Other MSP baseline' });
    const otherChild = await seedPolicy({ orgId: t.b1, name: 'other child', parentPolicyId: otherParent.id });
    await seedLink(otherParent.id, 'event_log');

    const rows = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      db.select({ id: configPolicyEffectiveFeatureLinks.id })
        .from(configPolicyEffectiveFeatureLinks)
        .where(inArray(configPolicyEffectiveFeatureLinks.configPolicyId, [otherParent.id, otherChild.id])));

    expect(rows).toEqual([]);
  });

  it('a root policy with no parent is unaffected by the view', async () => {
    const t = await seedTenancy();
    const root = await seedPolicy({ orgId: t.a1, name: 'root' });
    const link = await seedLink(root.id, 'event_log');

    const rows = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      db.select({
        id: configPolicyEffectiveFeatureLinks.id,
        inherited: configPolicyEffectiveFeatureLinks.inherited,
      })
        .from(configPolicyEffectiveFeatureLinks)
        .where(eq(configPolicyEffectiveFeatureLinks.configPolicyId, root.id)));

    expect(rows).toEqual([{ id: link, inherited: false }]);
  });
});

// ============================================================
// 3b. RLS-dependent reads the routes depend on
// ============================================================

/**
 * Both of these are exercised elsewhere only against mocks, and both depend on
 * the caller's own RLS context resolving a PARTNER-WIDE parent through the
 * `*_partner_wide_select` branch. If that branch ever stops applying, a mock
 * test keeps passing while the real behaviour degrades silently — the MFA gate
 * stops firing and the editor stops showing inherited state.
 */
describe('config policy inheritance — RLS-dependent reads (live DB)', () => {
  it('getParentLinkFeatureTypes sees a PARTNER-WIDE parent\'s gated link from an ORG session', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    await seedLink(parent.id, 'event_log');
    await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      INSERT INTO config_policy_feature_links (config_policy_id, feature_type)
      VALUES (${parent.id}::uuid, 'maintenance')
    `));

    const types = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      getParentLinkFeatureTypes(parent.id));

    // This is what the create-time MFA gate keys on. An empty array here would
    // silently skip the gate.
    expect(types.sort()).toEqual(['event_log', 'maintenance']);
  });

  it('getParentLinkFeatureTypes returns nothing for ANOTHER partner\'s baseline', async () => {
    const t = await seedTenancy();
    const foreign = await seedPolicy({ partnerId: t.p2, name: 'Other MSP baseline' });
    await seedLink(foreign.id, 'event_log');

    const types = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      getParentLinkFeatureTypes(foreign.id));

    expect(types).toEqual([]);
  });

  it('getConfigPolicy embeds a PARTNER-WIDE parent for an ORG caller, with its links', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'org child', parentPolicyId: parent.id });
    await seedLink(parent.id, 'event_log');

    const result = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      getConfigPolicy(child.id, orgAuth(t.a1, t.p1)));

    // policyAccessCondition still hides the partner-wide parent from a direct
    // GET, but the read-only embed must resolve — otherwise the detail page
    // shows a child with no inherited state and the MFA revert gate fails closed.
    expect(result?.parentPolicy).toMatchObject({ id: parent.id, name: 'MSP baseline', orgId: null });
    expect(result?.parentPolicy?.featureLinks.map((l) => l.featureType)).toEqual(['event_log']);
    expect(result?.childPolicies).toEqual([]);
  });

  it('getConfigPolicy on the parent lists its children', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'org child', parentPolicyId: parent.id });

    const result = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      getConfigPolicy(parent.id, orgAuth(t.a1, t.p1)));

    expect(result?.parentPolicy).toBeNull();
    expect(result?.childPolicies).toEqual([{ id: child.id, name: 'org child' }]);
  });
});

// ============================================================
// 4. Deletion and org cascade
// ============================================================

describe('config policy inheritance — deletion (live DB)', () => {
  it('the guarded nullable self-FK closes an org family while preserving external policies', async () => {
    const t = await seedTenancy();
    const baseline = await seedPolicy({ partnerId: t.p1, name: 'partner survivor' });
    const sibling = await seedPolicy({ orgId: t.a2, name: 'sibling survivor', parentPolicyId: baseline.id });
    const parent = await seedPolicy({ orgId: t.a1, name: 'org parent' });
    const child = await seedPolicy({ orgId: t.a1, name: 'org child', parentPolicyId: parent.id });
    const baselineChild = await seedPolicy({ orgId: t.a1, name: 'baseline child', parentPolicyId: baseline.id });

    // System scope makes the constraint, rather than RLS visibility, establish
    // the closed row set required by orgCascadeFkOnDelete's exact exception.
    for (const owner of [{ orgId: t.a2 }, { partnerId: t.p1 }]) {
      await expectSqlState(
        () => seedPolicy({ ...owner, name: 'incompatible external child', parentPolicyId: parent.id }),
        '23514', 'configuration_policies_parent_guard',
      );
    }
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () => db.update(configurationPolicies)
        .set({ orgId: t.a2 }).where(eq(configurationPolicies.id, parent.id))),
      '23514', 'configuration_policies_parent_guard',
    );
    await withDbAccessContext(SYSTEM_CTX, () => db.delete(configurationPolicies)
      .where(eq(configurationPolicies.orgId, t.a1)));
    const remaining = await withDbAccessContext(SYSTEM_CTX, () => db.select({ id: configurationPolicies.id })
      .from(configurationPolicies).where(inArray(configurationPolicies.id, [parent.id, child.id, baselineChild.id, baseline.id, sibling.id])));
    expect(remaining.map((row) => row.id).sort()).toEqual([baseline.id, sibling.id].sort());
  });

  it('deleting a parent alone is refused, and naming its children', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'baseline' });
    await seedPolicy({ orgId: t.a1, name: 'the child', parentPolicyId: parent.id });

    const err = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      deleteConfigPolicy(parent.id, orgAuth(t.a1, t.p1)).then(() => null, (e) => e));

    expect(err).toBeInstanceOf(PolicyHasChildrenError);
    expect((err as PolicyHasChildrenError).children.map((c) => c.name)).toEqual(['the child']);

    const still = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: configurationPolicies.id }).from(configurationPolicies)
        .where(eq(configurationPolicies.id, parent.id)));
    expect(still).toHaveLength(1);
  });

  // The operationally significant case: an MSP deleting a shared baseline that
  // orgs still inherit from.
  it('deleting a PARTNER-WIDE baseline that an org inherits from is refused', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    await seedPolicy({ orgId: t.a1, name: 'org child', parentPolicyId: parent.id });

    const err = await withDbAccessContext(partnerContext(t.p1, [t.a1, t.a2]), () =>
      deleteConfigPolicy(parent.id, partnerAuth(t.p1, [t.a1, t.a2])).then(() => null, (e) => e));

    expect(err).toBeInstanceOf(PolicyHasChildrenError);
    expect((err as PolicyHasChildrenError).children.map((c) => c.name)).toEqual(['org child']);
  });

  it('deleting the child first, then the parent, succeeds', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'child', parentPolicyId: parent.id });

    await withDbAccessContext(orgContext(t.a1, t.p1), async () => {
      await deleteConfigPolicy(child.id, orgAuth(t.a1, t.p1));
      await deleteConfigPolicy(parent.id, orgAuth(t.a1, t.p1));
    });

    const remaining = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: configurationPolicies.id }).from(configurationPolicies)
        .where(inArray(configurationPolicies.id, [parent.id, child.id])));
    expect(remaining).toEqual([]);
  });

  // What tenantCascade does for an org erasure: ONE statement removing every
  // policy of the org. NO ACTION must not turn that into an FK violation.
  it('an org cascade removes parent and child in ONE statement', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ orgId: t.a1, name: 'baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'child', parentPolicyId: parent.id });

    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(configurationPolicies).where(eq(configurationPolicies.orgId, t.a1)));

    const remaining = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: configurationPolicies.id }).from(configurationPolicies)
        .where(inArray(configurationPolicies.id, [parent.id, child.id])));
    expect(remaining).toEqual([]);
  });

  it('a partner-wide parent survives the erasure of a child\'s org', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'child', parentPolicyId: parent.id });

    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(configurationPolicies).where(eq(configurationPolicies.orgId, t.a1)));

    const remaining = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: configurationPolicies.id }).from(configurationPolicies)
        .where(inArray(configurationPolicies.id, [parent.id, child.id])));
    expect(remaining).toEqual([{ id: parent.id }]);
  });
});

// ============================================================
// 5. Resolution — inheritance actually reaches devices (#5080 W02)
// ============================================================

/**
 * W01 proved the VIEW inherits. This proves the READERS do: the generic
 * effective-config resolver, one `featureConfigResolver` function, and one
 * agent-facing config builder under the real agent context.
 *
 * Every one of these is invisible to a unit test. The unit suites stub the
 * schema module by table name, so they prove which identifier a query names —
 * not that an org-scoped `breeze_app` session can actually read a partner-wide
 * parent's links through `security_invoker`, and not that the inherited row's
 * (parent) link id still joins the normalized settings table. Both of those are
 * the difference between "a device gets its MSP's baseline" and "a device gets
 * nothing", which is the bug the whole feature exists to fix.
 */
describe('config policy inheritance — resolution reaches devices (live DB)', () => {
  it('generic resolver: an inherited feature resolves with the PARENT named as its origin', async () => {
    const t = await seedTenancy();
    const site = await createSite({ orgId: t.a1 });
    const device = await seedInheritanceDevice(t.a1, site.id);

    // Partner-wide baseline authors event_log; the child overrides monitoring.
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'A1 child', parentPolicyId: parent.id });
    await seedLink(parent.id, 'event_log');
    await seedLink(parent.id, 'monitoring');
    await seedLink(child.id, 'monitoring');
    await seedAssignment(child.id, 'organization', t.a1);

    const resolved = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      resolveEffectiveConfig(device.id, orgAuth(t.a1, t.p1)));

    expect(resolved).not.toBeNull();

    // The inherited feature is delivered, and says where it came from.
    const eventLog = resolved!.features.event_log!;
    expect(eventLog).toBeDefined();
    expect(eventLog.inheritedFromPolicyId).toBe(parent.id);
    expect(eventLog.inheritedFromPolicyName).toBe('MSP baseline');
    // …but the ASSIGNED policy is still the child: that is the assignment that
    // won, and it is what any ownership clamp keys on.
    expect(eventLog.sourcePolicyId).toBe(child.id);
    expect(eventLog.sourceLevel).toBe('organization');

    // The overridden feature carries no provenance at all.
    const monitoring = resolved!.features.monitoring!;
    expect(monitoring.inheritedFromPolicyId).toBeNull();
    expect(monitoring.inheritedFromPolicyName).toBeNull();
    expect(monitoring.sourcePolicyId).toBe(child.id);
  });

  it('featureConfigResolver: alert rules authored by the parent reach a child\'s device', async () => {
    const t = await seedTenancy();
    const site = await createSite({ orgId: t.a2 });
    const device = await seedInheritanceDevice(t.a2, site.id);

    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a2, name: 'A2 child', parentPolicyId: parent.id });
    const parentAlertLink = await seedAlertRuleLink(parent.id, 'Baseline CPU rule');
    await seedAssignment(child.id, 'organization', t.a2);

    const rules = await withDbAccessContext(orgContext(t.a2, t.p1), () =>
      resolveAlertRulesForDevice(device.id));

    // The rule row hangs off the PARENT's link id — the reason the view keeps
    // it rather than synthesising a new one.
    expect(rules.map((r) => r.name)).toEqual(['Baseline CPU rule']);
    expect(rules[0]!.featureLinkId).toBe(parentAlertLink);
  });

  it('agent delivery: an AGENT context receives the partner-wide parent\'s event_log settings', async () => {
    const t = await seedTenancy();
    const site = await createSite({ orgId: t.a1 });
    const device = await seedInheritanceDevice(t.a1, site.id);

    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'A1 child', parentPolicyId: parent.id });
    await seedEventLogLink(parent.id, 777);
    await seedAssignment(child.id, 'organization', t.a1);

    const update = await withDbAccessContext(agentContext(t.a1, t.p1), () =>
      buildEventLogConfigUpdate(device.id));

    // 777, not EVENT_LOG_DEFAULTS.maxEventsPerCycle (100): the settings row
    // reached the agent through the child's assignment and the parent's link,
    // with no system-context escalation anywhere on the path.
    expect(update.max_events_per_cycle).toBe(777);
  });

  it('agent delivery: a child that overrides the feature keeps its OWN settings', async () => {
    const t = await seedTenancy();
    const site = await createSite({ orgId: t.a1 });
    const device = await seedInheritanceDevice(t.a1, site.id);

    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'A1 child', parentPolicyId: parent.id });
    await seedEventLogLink(parent.id, 777);
    await seedEventLogLink(child.id, 42);
    await seedAssignment(child.id, 'organization', t.a1);

    const update = await withDbAccessContext(agentContext(t.a1, t.p1), () =>
      buildEventLogConfigUpdate(device.id));

    expect(update.max_events_per_cycle).toBe(42);
  });

  it('agent delivery: an inherited HELPER restriction reaches the device under the agent context', async () => {
    // The security-relevant one: this resolver's fallback is the permissive
    // 'standard', so a baseline that restricts the helper agent to 'basic' and
    // fails to resolve does not error — it silently over-permissions.
    const t = await seedTenancy();
    const site = await createSite({ orgId: t.a1 });
    const device = await seedInheritanceDevice(t.a1, site.id);

    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'A1 child', parentPolicyId: parent.id });
    await seedInlineLink(parent.id, 'helper', { permissionLevel: 'basic' });
    await seedAssignment(child.id, 'organization', t.a1);

    const level = await withDbAccessContext(agentContext(t.a1, t.p1), () =>
      resolveHelperPermissionLevelForDevice(device.id));

    expect(level).toBe('basic');
  });

  it('an inherited device_lifecycle window reaches the org-level resolver', async () => {
    const t = await seedTenancy();
    const parent = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const child = await seedPolicy({ orgId: t.a1, name: 'A1 child', parentPolicyId: parent.id });
    await seedInlineLink(parent.id, 'device_lifecycle', { purgeRemovedAfterDays: 45 });
    await seedAssignment(child.id, 'organization', t.a1);

    const days = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      getOrgPurgeRemovedAfterDays(t.a1));

    expect(days).toBe(45);
  });

  it('a device under a policy with no parent is unaffected', async () => {
    const t = await seedTenancy();
    const site = await createSite({ orgId: t.a1 });
    const device = await seedInheritanceDevice(t.a1, site.id);

    const root = await seedPolicy({ orgId: t.a1, name: 'A1 root' });
    await seedEventLogLink(root.id, 55);
    await seedAssignment(root.id, 'organization', t.a1);

    const resolved = await withDbAccessContext(orgContext(t.a1, t.p1), () =>
      resolveEffectiveConfig(device.id, orgAuth(t.a1, t.p1)));

    expect(resolved!.features.event_log!.inheritedFromPolicyId).toBeNull();
    expect(resolved!.features.event_log!.sourcePolicyId).toBe(root.id);
  });

  it('inheritance does not cross tenants: another partner\'s baseline reaches nothing', async () => {
    const t = await seedTenancy();
    const site = await createSite({ orgId: t.a1 });
    const device = await seedInheritanceDevice(t.a1, site.id);

    // A1's own child, assigned — but the event_log link lives on ANOTHER
    // partner's baseline, which is not (and cannot be) its parent.
    const foreignBaseline = await seedPolicy({ partnerId: t.p2, name: 'Other MSP baseline' });
    await seedEventLogLink(foreignBaseline.id, 777);
    const child = await seedPolicy({ orgId: t.a1, name: 'A1 child' });
    await seedAssignment(child.id, 'organization', t.a1);

    const update = await withDbAccessContext(agentContext(t.a1, t.p1), () =>
      buildEventLogConfigUpdate(device.id));

    expect(update.max_events_per_cycle).toBe(EVENT_LOG_DEFAULTS.maxEventsPerCycle);
  });
});


// ============================================================
// 6. Erasure row-set closure -- the evidence behind the org-cascade FK ledger
// ============================================================

/**
 * `orgCascadeFkOnDelete.integration.test.ts` classifies
 * `configuration_policies(parent_policy_id)` as `self-ref-open-row-set`: the
 * table's `org_id` is nullable (partner-wide policies, epic #2135), so from the
 * catalog alone it cannot tell whether `DELETE ... WHERE org_id = $1` removes a
 * row set closed under the self-reference. It is pinned in the ledger with the
 * argument that the W01 constraint trigger closes it. That argument is only
 * worth something if it is checked, so these tests check it (#5123).
 *
 * Closure needs exactly one thing: no row that SURVIVES the erasure statement
 * may reference a row it deletes. The surviving rows are the partner-wide ones
 * and other orgs' rows, so the first two tests are the COMPLETE set of edges
 * that could break it -- both refused, in SYSTEM scope, which is the widest
 * scope any erasure or merge path runs under. Those two are the closure proof;
 * they fail the moment the guard stops rejecting a forged edge.
 *
 * The last two tests are a different, weaker property, and are not a second
 * proof of closure -- they seed only LEGAL edges, so they would pass even with
 * the guard gone. What they pin is the erasure SHAPE the closure argument
 * assumes: `cascadeDeleteOrg` still removes an org's policies in ONE statement
 * (so NO ACTION is checked once, against the final state, not per row), and
 * `cascadeDeletePartner` still runs its per-org cascades BEFORE the partner-axis
 * sweep, so an org-owned child is always gone before the partner-wide baseline
 * it inherits from is deleted. Both are properties of the service, not the
 * schema, so nothing else would catch a refactor that changed them.
 */
describe('config policy inheritance -- erasure row-set closure (live DB)', () => {
  it('SYSTEM scope still refuses a partner-wide child under an org-owned parent', async () => {
    const t = await seedTenancy();
    const orgParent = await seedPolicy({ orgId: t.a1, name: 'A1 baseline' });

    // The edge that would break closure: this child SURVIVES
    // `DELETE ... WHERE org_id = a1` (its org_id IS NULL) while its parent does not.
    await expectSqlState(
      () => seedPolicy({
        partnerId: t.p1,
        name: 'forged partner-wide child',
        parentPolicyId: orgParent.id,
      }),
      '23514',
      'configuration_policies_parent_guard',
    );
  });

  it("SYSTEM scope still refuses a child of ANOTHER org's parent", async () => {
    const t = await seedTenancy();
    const orgParent = await seedPolicy({ orgId: t.a1, name: 'A1 baseline' });

    // The other surviving shape: a2's row referencing a1's row.
    await expectSqlState(
      () => seedPolicy({
        orgId: t.a2,
        name: 'forged cross-org child',
        parentPolicyId: orgParent.id,
      }),
      '23514',
      'configuration_policies_parent_guard',
    );
  });

  it('the real org erasure removes a parent+child family and leaves the partner-wide baseline', async () => {
    const t = await seedTenancy();
    const baseline = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const orgParent = await seedPolicy({ orgId: t.a1, name: 'A1 baseline' });
    const orgChild = await seedPolicy({
      orgId: t.a1, name: 'A1 child', parentPolicyId: orgParent.id,
    });
    const inheritsBaseline = await seedPolicy({
      orgId: t.a1, name: 'A1 child of the MSP baseline', parentPolicyId: baseline.id,
    });

    // The real service, not a hand-written DELETE (the sibling tests above
    // already cover the hand-written shape). Every edge seeded here is LEGAL, so
    // this does not re-prove closure -- it pins the single-statement erasure the
    // closure argument depends on.
    await expect(cascadeDeleteOrg(t.a1, randomUUID(), 'config-policy-erasure@test.invalid'))
      .resolves.toBeDefined();

    const remaining = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: configurationPolicies.id }).from(configurationPolicies)
        .where(inArray(configurationPolicies.id, [
          baseline.id, orgParent.id, orgChild.id, inheritsBaseline.id,
        ])));
    expect(remaining).toEqual([{ id: baseline.id }]);
  });

  /**
   * The partner purge is the one place the ORDER of two separate statements is
   * load-bearing for this FK. `cascadeDeletePartner` runs `cascadeDeleteOrg` for
   * every child org first, then a partner-axis sweep that deletes the partner's
   * own `configuration_policies` baselines. An org-owned child of a partner-wide
   * baseline is removed by the first phase; the baseline by the second. Reverse
   * them and the sweep raises 23503 mid-purge, leaving the partner half-deleted
   * -- the #4100 failure mode, on the partner axis. Nothing else covers it:
   * tenantCascadePartner.integration.test.ts seeds no configuration_policies.
   */
  it('the real partner purge deletes org children before the partner-wide baseline', async () => {
    const t = await seedTenancy();
    const baseline = await seedPolicy({ partnerId: t.p1, name: 'MSP baseline' });
    const orgChild = await seedPolicy({
      orgId: t.a1, name: 'A1 child of the MSP baseline', parentPolicyId: baseline.id,
    });
    // A partner-wide child too: this pair is removed by the SWEEP's own single
    // statement, so it also has to be closed under the self-reference.
    const partnerChild = await seedPolicy({
      partnerId: t.p1, name: 'partner-wide child', parentPolicyId: baseline.id,
    });

    await expect(cascadeDeletePartner(t.p1, randomUUID())).resolves.toBeDefined();

    const remaining = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ id: configurationPolicies.id }).from(configurationPolicies)
        .where(inArray(configurationPolicies.id, [baseline.id, orgChild.id, partnerChild.id])));
    expect(remaining).toEqual([]);
  });
});
