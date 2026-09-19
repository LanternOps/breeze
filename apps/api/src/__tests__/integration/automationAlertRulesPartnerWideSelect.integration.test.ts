/**
 * Partner-wide READ branch on the automation + alert-rule config tables
 * (#4952 automations, #4950 automation_policies, #4951
 * automation_resource_bindings, #4949 alert_rules) — the group after the
 * configuration-policy chain (wave 1 of #4673).
 *
 * Migration under test:
 * 2026-10-11-000400-automation-alert-rules-partner-wide-select.sql, whose
 * rationale is 2026-10-05-110000-config-policy-partner-wide-select.sql.
 *
 * A partner-wide row is `org_id NULL, partner_id = P`. Before this migration an
 * ORG-scoped session could not see it: `breeze_has_org_access(NULL)` is false,
 * and `breeze_has_partner_access(P)` is false because org scope carries
 * `accessiblePartnerIds: []`. Every request-path reader therefore had to
 * escalate into a nested `withSystemDbAccessContext` (the #1105 pattern), which
 * acquires a SECOND pooled connection while the request's own transaction holds
 * the first and bypasses RLS entirely.
 *
 * All four tables carry both owner axes directly on the row with an XOR CHECK,
 * so each takes the direct-column branch as its own SEPARATE permissive
 * `FOR SELECT` policy:
 *
 *   <table>_partner_wide_select  FOR SELECT
 *     USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())
 *
 * Kept separate from each table's single dual-axis `FOR ALL` policy
 * (`automations_isolation`, `automation_policies_isolation`,
 * `automation_resource_bindings_isolation`, `alert_rules_isolation`) on purpose:
 * appending the branch to a FOR ALL `USING` would also widen UPDATE/DELETE row
 * targeting to the MSP's shared rows. Postgres never consults a FOR SELECT
 * policy when computing UPDATE/DELETE target rows, so a separate policy ORs into
 * reads only.
 *
 * Three properties this suite proves per table — none reachable from a mocked
 * unit test (no RLS runs there) and none proven by rls-coverage either (that is
 * a pg_catalog shape inspection, not a functional one):
 *
 *  1. An ORG session of the OWNING partner SELECTs BOTH its own org-owned row
 *     and the partner-wide row.
 *  2. An ORG session under a DIFFERENT partner sees NEITHER, and a session
 *     whose `currentPartnerId` is unset (so `breeze_current_partner_id()`
 *     returns NULL) sees no partner-wide row — the predicate must use `=`,
 *     never `IS NOT DISTINCT FROM`, which would make every NULL-GUC session
 *     read every partner's shared rows.
 *  3. The branch grants NO write: UPDATE and DELETE of the partner-wide row
 *     from that same org session affect ZERO rows and leave the row unchanged.
 *     Note this is a silent no-op, not a 42501 — RLS hides the target row from
 *     the write command rather than raising — so a test that only asserted "it
 *     threw" would be vacuous; assert rowCount AND re-read under system scope.
 *     The 42501 half is proven via the INSERT forge, where WITH CHECK does
 *     raise.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alertRules,
  alertTemplates,
  automationPolicies,
  automationResourceBindings,
  automations,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

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
 * An ORG-scoped session. `currentPartnerId` is populated from the token's own
 * partnerId for org scope too (`buildDbAccessContext`, middleware/auth.ts),
 * which is exactly what the read branch keys on — so it is set deliberately.
 * `accessiblePartnerIds` stays EMPTY: an org token never passes
 * `breeze_has_partner_access`, and that is what keeps the branch read-only.
 *
 * Passing `currentPartnerId: null` leaves the GUC empty, which is what
 * `breeze_current_partner_id()` reads back as NULL.
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
 * Assert a statement failed with a specific SQLSTATE. Drizzle wraps driver
 * errors in a DrizzleQueryError whose message is only "Failed query: ...", so
 * a regex on `.message` matches nothing useful — the pg error (with `.code`)
 * hangs off `.cause`.
 */
async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  const actual = cause?.code ?? (raised as { code?: string })?.code;
  expect(actual).toBe(code);
}

const created = {
  bindings: [] as string[],
  automations: [] as string[],
  policies: [] as string[],
  rules: [] as string[],
  templates: [] as string[],
};

afterEach(async () => {
  const any = Object.values(created).some((ids) => ids.length > 0);
  if (!any) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    // Children before parents; the org/partner roots are truncated by the
    // global beforeEach in ./setup, so this only has to leave no orphans.
    if (created.bindings.length > 0) {
      await db.delete(automationResourceBindings).where(inArray(automationResourceBindings.id, created.bindings));
    }
    if (created.automations.length > 0) {
      await db.delete(automations).where(inArray(automations.id, created.automations));
    }
    if (created.policies.length > 0) {
      await db.delete(automationPolicies).where(inArray(automationPolicies.id, created.policies));
    }
    if (created.rules.length > 0) {
      await db.delete(alertRules).where(inArray(alertRules.id, created.rules));
    }
    if (created.templates.length > 0) {
      await db.delete(alertTemplates).where(inArray(alertTemplates.id, created.templates));
    }
  });
  created.bindings.length = 0;
  created.automations.length = 0;
  created.policies.length = 0;
  created.rules.length = 0;
  created.templates.length = 0;
});

const AUTOMATION_TRIGGER = { type: 'manual' };
const AUTOMATION_ACTIONS = [{ type: 'create_alert', alertSeverity: 'medium', alertMessage: 'probe' }];
const POLICY_TARGETS = { targetType: 'all', targetIds: [] };
const POLICY_RULES = [{ type: 'prohibited_software', softwareName: 'BitTorrent' }];
const TEMPLATE = {
  conditions: { type: 'metric', metric: 'cpu', operator: '>', threshold: 95 },
  severity: 'high',
  titleTemplate: 'High CPU on {{hostname}}',
  messageTemplate: 'CPU exceeded threshold on {{hostname}}',
} as const;

interface Fixture {
  partnerId: string;
  orgId: string;
  automation: { orgOwnedId: string; partnerWideId: string };
  automationPolicy: { orgOwnedId: string; partnerWideId: string };
  resourceBinding: { orgOwnedId: string; partnerWideId: string };
  alertRule: { orgOwnedId: string; partnerWideId: string };
  /** alert_rules.template_id is NOT NULL — the forge needs a readable template. */
  orgTemplateId: string;
}

/**
 * Seed one ORG-OWNED row (org A of partner P) and one PARTNER-WIDE row
 * (`org_id NULL, partner_id P`) per table. Partner-wide rows are written under
 * a PARTNER context — the only scope that may write them — and org-owned rows
 * under the ORG context, so the fixture also proves neither write path moved.
 *
 * automation_resource_bindings copies its parent automation's owner axes (the
 * `automation_resource_binding_owner_guard` constraint trigger rejects drift),
 * so each binding needs a parent automation on the SAME axis, and its
 * `expected_resource_*` columns have to sit inside that tenant.
 */
async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const orgCtx = orgContext(org.id, partner.id);
  const partnerCtx = partnerContext(partner.id, [org.id]);

  const automationOrg = await withDbAccessContext(orgCtx, async () => {
    const [row] = await db
      .insert(automations)
      .values({
        orgId: org.id,
        partnerId: null,
        name: 'Org-owned automation',
        trigger: AUTOMATION_TRIGGER,
        actions: AUTOMATION_ACTIONS,
      })
      .returning();
    created.automations.push(row!.id);
    return row!.id;
  });

  const automationPartnerWide = await withDbAccessContext(partnerCtx, async () => {
    const [row] = await db
      .insert(automations)
      .values({
        orgId: null,
        partnerId: partner.id,
        name: 'Partner-wide automation',
        trigger: AUTOMATION_TRIGGER,
        actions: AUTOMATION_ACTIONS,
      })
      .returning();
    created.automations.push(row!.id);
    return row!.id;
  });

  const bindingOrg = await withDbAccessContext(orgCtx, async () => {
    const [row] = await db
      .insert(automationResourceBindings)
      .values({
        automationId: automationOrg,
        orgId: org.id,
        partnerId: null,
        resourceKind: 'notification_channel',
        resourceId: 'org-owned-resource',
        expectedResourceOrgId: org.id,
        expectedResourcePartnerId: null,
        expectedResourceIsSystem: false,
      })
      .returning();
    created.bindings.push(row!.id);
    return row!.id;
  });

  const bindingPartnerWide = await withDbAccessContext(partnerCtx, async () => {
    const [row] = await db
      .insert(automationResourceBindings)
      .values({
        automationId: automationPartnerWide,
        orgId: null,
        partnerId: partner.id,
        resourceKind: 'notification_channel',
        resourceId: 'partner-wide-resource',
        expectedResourceOrgId: null,
        expectedResourcePartnerId: partner.id,
        expectedResourceIsSystem: false,
      })
      .returning();
    created.bindings.push(row!.id);
    return row!.id;
  });

  const policyOrg = await withDbAccessContext(orgCtx, async () => {
    const [row] = await db
      .insert(automationPolicies)
      .values({
        orgId: org.id,
        partnerId: null,
        name: 'Org-owned automation policy',
        targets: POLICY_TARGETS,
        rules: POLICY_RULES,
      })
      .returning();
    created.policies.push(row!.id);
    return row!.id;
  });

  const policyPartnerWide = await withDbAccessContext(partnerCtx, async () => {
    const [row] = await db
      .insert(automationPolicies)
      .values({
        orgId: null,
        partnerId: partner.id,
        name: 'Partner-wide automation policy',
        targets: POLICY_TARGETS,
        rules: POLICY_RULES,
      })
      .returning();
    created.policies.push(row!.id);
    return row!.id;
  });

  const orgTemplate = await withDbAccessContext(orgCtx, async () => {
    const [row] = await db
      .insert(alertTemplates)
      .values({ orgId: org.id, partnerId: null, name: 'Org-owned template', ...TEMPLATE })
      .returning();
    created.templates.push(row!.id);
    return row!.id;
  });

  const partnerTemplate = await withDbAccessContext(partnerCtx, async () => {
    const [row] = await db
      .insert(alertTemplates)
      .values({ orgId: null, partnerId: partner.id, name: 'Partner-wide template', ...TEMPLATE })
      .returning();
    created.templates.push(row!.id);
    return row!.id;
  });

  const ruleOrg = await withDbAccessContext(orgCtx, async () => {
    const [row] = await db
      .insert(alertRules)
      .values({
        orgId: org.id,
        partnerId: null,
        templateId: orgTemplate,
        name: 'Org-owned alert rule',
        targetType: 'org',
        targetId: org.id,
      })
      .returning();
    created.rules.push(row!.id);
    return row!.id;
  });

  // Partner-wide rules always use targetType 'all' with targetId = partnerId
  // (target_id is NOT NULL; the 'all' match ignores it).
  const rulePartnerWide = await withDbAccessContext(partnerCtx, async () => {
    const [row] = await db
      .insert(alertRules)
      .values({
        orgId: null,
        partnerId: partner.id,
        templateId: partnerTemplate,
        name: 'Partner-wide alert rule',
        targetType: 'all',
        targetId: partner.id,
      })
      .returning();
    created.rules.push(row!.id);
    return row!.id;
  });

  return {
    partnerId: partner.id,
    orgId: org.id,
    automation: { orgOwnedId: automationOrg, partnerWideId: automationPartnerWide },
    automationPolicy: { orgOwnedId: policyOrg, partnerWideId: policyPartnerWide },
    resourceBinding: { orgOwnedId: bindingOrg, partnerWideId: bindingPartnerWide },
    alertRule: { orgOwnedId: ruleOrg, partnerWideId: rulePartnerWide },
    orgTemplateId: orgTemplate,
  };
}

/**
 * All four tables as uniform (select / update / delete / forge) descriptors, so
 * every assertion below covers ALL of them instead of a representative sample —
 * the per-table policies are hand-written and one omission is a silent
 * zero-rows-forever bug on that feature only.
 */
function tableProbes(fixture: Fixture): Array<{
  label: string;
  orgOwnedId: string;
  partnerWideId: string;
  selectById: (id: string) => Promise<unknown[]>;
  updateById: (id: string) => Promise<unknown[]>;
  deleteById: (id: string) => Promise<unknown[]>;
  forgePartnerWide: () => Promise<unknown>;
}> {
  return [
    {
      label: 'automations',
      orgOwnedId: fixture.automation.orgOwnedId,
      partnerWideId: fixture.automation.partnerWideId,
      selectById: (id) => db.select({ id: automations.id }).from(automations).where(eq(automations.id, id)),
      updateById: (id) => db.update(automations).set({ name: 'HIJACKED' }).where(eq(automations.id, id)).returning(),
      deleteById: (id) => db.delete(automations).where(eq(automations.id, id)).returning(),
      forgePartnerWide: () =>
        db
          .insert(automations)
          .values({
            orgId: null,
            partnerId: fixture.partnerId,
            name: 'Forged partner-wide automation',
            trigger: AUTOMATION_TRIGGER,
            actions: AUTOMATION_ACTIONS,
          })
          .returning(),
    },
    {
      label: 'automation_policies',
      orgOwnedId: fixture.automationPolicy.orgOwnedId,
      partnerWideId: fixture.automationPolicy.partnerWideId,
      selectById: (id) =>
        db.select({ id: automationPolicies.id }).from(automationPolicies).where(eq(automationPolicies.id, id)),
      updateById: (id) =>
        db.update(automationPolicies).set({ name: 'HIJACKED' }).where(eq(automationPolicies.id, id)).returning(),
      deleteById: (id) => db.delete(automationPolicies).where(eq(automationPolicies.id, id)).returning(),
      forgePartnerWide: () =>
        db
          .insert(automationPolicies)
          .values({
            orgId: null,
            partnerId: fixture.partnerId,
            name: 'Forged partner-wide policy',
            targets: POLICY_TARGETS,
            rules: POLICY_RULES,
          })
          .returning(),
    },
    {
      label: 'automation_resource_bindings',
      orgOwnedId: fixture.resourceBinding.orgOwnedId,
      partnerWideId: fixture.resourceBinding.partnerWideId,
      selectById: (id) =>
        db
          .select({ id: automationResourceBindings.id })
          .from(automationResourceBindings)
          .where(eq(automationResourceBindings.id, id)),
      updateById: (id) =>
        db
          .update(automationResourceBindings)
          .set({ state: 'quarantined', reason: 'HIJACKED' })
          .where(eq(automationResourceBindings.id, id))
          .returning(),
      deleteById: (id) =>
        db.delete(automationResourceBindings).where(eq(automationResourceBindings.id, id)).returning(),
      forgePartnerWide: () =>
        db
          .insert(automationResourceBindings)
          .values({
            automationId: fixture.automation.partnerWideId,
            orgId: null,
            partnerId: fixture.partnerId,
            resourceKind: 'notification_channel',
            resourceId: 'forged-partner-wide-resource',
            expectedResourceOrgId: null,
            expectedResourcePartnerId: fixture.partnerId,
            expectedResourceIsSystem: false,
          })
          .returning(),
    },
    {
      label: 'alert_rules',
      orgOwnedId: fixture.alertRule.orgOwnedId,
      partnerWideId: fixture.alertRule.partnerWideId,
      selectById: (id) => db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.id, id)),
      updateById: (id) =>
        db.update(alertRules).set({ name: 'HIJACKED', isActive: false }).where(eq(alertRules.id, id)).returning(),
      deleteById: (id) => db.delete(alertRules).where(eq(alertRules.id, id)).returning(),
      forgePartnerWide: () =>
        db
          .insert(alertRules)
          .values({
            orgId: null,
            partnerId: fixture.partnerId,
            templateId: fixture.orgTemplateId,
            name: 'Forged partner-wide rule',
            targetType: 'all',
            targetId: fixture.partnerId,
          })
          .returning(),
    },
  ];
}

/** Read a row back under system scope (RLS bypassed) to prove it is unchanged. */
async function reReadUnderSystem(probe: { label: string; selectById: (id: string) => Promise<unknown[]> }, id: string) {
  return withDbAccessContext(SYSTEM_CTX, () => probe.selectById(id));
}

describe('automation + alert_rules — partner-wide SELECT branch (#4949, #4950, #4951, #4952)', () => {
  it('an ORG session of the OWNING partner reads both its own row and the partner-wide row', async () => {
    const fixture = await seedFixture();

    const visible = await withDbAccessContext(orgContext(fixture.orgId, fixture.partnerId), async () => {
      const results: Record<string, { orgOwned: number; partnerWide: number }> = {};
      for (const probe of tableProbes(fixture)) {
        results[probe.label] = {
          orgOwned: (await probe.selectById(probe.orgOwnedId)).length,
          partnerWide: (await probe.selectById(probe.partnerWideId)).length,
        };
      }
      return results;
    });

    // Reported as one object so a failure names EVERY broken table at once
    // instead of stopping at the first.
    expect(visible).toEqual({
      automations: { orgOwned: 1, partnerWide: 1 },
      automation_policies: { orgOwned: 1, partnerWide: 1 },
      automation_resource_bindings: { orgOwned: 1, partnerWide: 1 },
      alert_rules: { orgOwned: 1, partnerWide: 1 },
    });
  });

  it('an ORG session under a DIFFERENT partner sees neither row', async () => {
    const fixture = await seedFixture();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });

    const visible = await withDbAccessContext(orgContext(otherOrg.id, otherPartner.id), async () => {
      const results: Record<string, { orgOwned: number; partnerWide: number }> = {};
      for (const probe of tableProbes(fixture)) {
        results[probe.label] = {
          orgOwned: (await probe.selectById(probe.orgOwnedId)).length,
          partnerWide: (await probe.selectById(probe.partnerWideId)).length,
        };
      }
      return results;
    });

    expect(visible).toEqual({
      automations: { orgOwned: 0, partnerWide: 0 },
      automation_policies: { orgOwned: 0, partnerWide: 0 },
      automation_resource_bindings: { orgOwned: 0, partnerWide: 0 },
      alert_rules: { orgOwned: 0, partnerWide: 0 },
    });
  });

  // The branch keys on `partner_id = breeze_current_partner_id()`. A NULL GUC
  // must never match, which is what rules out `IS NOT DISTINCT FROM` — under
  // that operator every session with an unset partner GUC would read EVERY
  // partner's shared rows. The org-owned row stays visible here; only the
  // partner-wide one must not.
  //
  // NB this is NOT the agent shape: `middleware/agentAuth.ts` sets
  // `currentPartnerId: device.partnerId` (#4673 W02), so a real agent session
  // DOES get the branch — that is the whole point of it on these tables
  // (buildPolicyProbeConfigUpdate's partner-wide automation_policies read on
  // the heartbeat path). This case covers contexts that leave the GUC unset.
  it('a session with no currentPartnerId (NULL GUC) sees no partner-wide row', async () => {
    const fixture = await seedFixture();

    const visible = await withDbAccessContext(orgContext(fixture.orgId, null), async () => {
      const results: Record<string, { orgOwned: number; partnerWide: number }> = {};
      for (const probe of tableProbes(fixture)) {
        results[probe.label] = {
          orgOwned: (await probe.selectById(probe.orgOwnedId)).length,
          partnerWide: (await probe.selectById(probe.partnerWideId)).length,
        };
      }
      return results;
    });

    expect(visible).toEqual({
      automations: { orgOwned: 1, partnerWide: 0 },
      automation_policies: { orgOwned: 1, partnerWide: 0 },
      automation_resource_bindings: { orgOwned: 1, partnerWide: 0 },
      alert_rules: { orgOwned: 1, partnerWide: 0 },
    });
  });

  it('the OWNING partner session still reads and writes its partner-wide rows', async () => {
    const fixture = await seedFixture();
    const ctx = partnerContext(fixture.partnerId, [fixture.orgId]);

    const visible = await withDbAccessContext(ctx, async () => {
      const results: Record<string, number> = {};
      for (const probe of tableProbes(fixture)) {
        results[probe.label] = (await probe.selectById(probe.partnerWideId)).length;
      }
      return results;
    });
    expect(visible).toEqual({
      automations: 1,
      automation_policies: 1,
      automation_resource_bindings: 1,
      alert_rules: 1,
    });

    const updated = await withDbAccessContext(ctx, () =>
      db
        .update(automations)
        .set({ name: 'Renamed by owning partner' })
        .where(eq(automations.id, fixture.automation.partnerWideId))
        .returning(),
    );
    expect(updated).toHaveLength(1);
  });

  describe('the read branch grants NO write', () => {
    it('an ORG session of the owning partner cannot UPDATE or DELETE the partner-wide rows', async () => {
      const fixture = await seedFixture();
      const probes = tableProbes(fixture);
      const ctx = orgContext(fixture.orgId, fixture.partnerId);

      const affected: Record<string, { updated: number; deleted: number }> = {};
      for (const probe of probes) {
        const updated = await withDbAccessContext(ctx, () => probe.updateById(probe.partnerWideId));
        const deleted = await withDbAccessContext(ctx, () => probe.deleteById(probe.partnerWideId));
        affected[probe.label] = { updated: updated.length, deleted: deleted.length };
      }

      expect(affected).toEqual({
        automations: { updated: 0, deleted: 0 },
        automation_policies: { updated: 0, deleted: 0 },
        automation_resource_bindings: { updated: 0, deleted: 0 },
        alert_rules: { updated: 0, deleted: 0 },
      });

      // Zero rows affected is only half the proof: re-read under system scope
      // (RLS bypassed) and confirm every partner-wide row is still there and
      // untouched.
      const stillThere: Record<string, number> = {};
      for (const probe of probes) {
        stillThere[probe.label] = (await reReadUnderSystem(probe, probe.partnerWideId)).length;
      }
      expect(stillThere).toEqual({
        automations: 1,
        automation_policies: 1,
        automation_resource_bindings: 1,
        alert_rules: 1,
      });

      const names = await withDbAccessContext(SYSTEM_CTX, async () => ({
        automation: (await db.select({ name: automations.name }).from(automations).where(eq(automations.id, fixture.automation.partnerWideId)))[0]?.name,
        policy: (await db.select({ name: automationPolicies.name }).from(automationPolicies).where(eq(automationPolicies.id, fixture.automationPolicy.partnerWideId)))[0]?.name,
        bindingState: (await db.select({ state: automationResourceBindings.state }).from(automationResourceBindings).where(eq(automationResourceBindings.id, fixture.resourceBinding.partnerWideId)))[0]?.state,
        rule: (await db.select({ name: alertRules.name, isActive: alertRules.isActive }).from(alertRules).where(eq(alertRules.id, fixture.alertRule.partnerWideId)))[0],
      }));
      expect(names).toEqual({
        automation: 'Partner-wide automation',
        policy: 'Partner-wide automation policy',
        bindingState: 'active',
        rule: { name: 'Partner-wide alert rule', isActive: true },
      });

      // The org-owned rows are still writable — the branch did not freeze the
      // table's ordinary org path.
      const orgOwnedUpdate = await withDbAccessContext(ctx, () =>
        db.update(automations).set({ name: 'Org rename' }).where(eq(automations.id, fixture.automation.orgOwnedId)).returning(),
      );
      expect(orgOwnedUpdate).toHaveLength(1);
    });

    // WITH CHECK (unlike USING) raises rather than filters, so an INSERT forge
    // is where the write denial is observable as an error — and where a branch
    // accidentally appended to a FOR ALL policy would show up.
    it('an ORG session cannot INSERT a partner-wide row for its own partner (42501)', async () => {
      const fixture = await seedFixture();

      for (const probe of tableProbes(fixture)) {
        await expectSqlState(
          () => withDbAccessContext(orgContext(fixture.orgId, fixture.partnerId), () => probe.forgePartnerWide()),
          '42501',
        );
      }
    });
  });
});
