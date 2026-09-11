/**
 * Partner-wide READ branch on the configuration-policy chain (#2468, wave 1 of #4673).
 *
 * Migration under test: 2026-10-05-110000-config-policy-partner-wide-select.sql.
 *
 * A partner-wide configuration policy is `org_id NULL, partner_id = P`. Before
 * this migration an ORG-scoped session could not see it at all:
 * `breeze_has_org_access(NULL)` is false, and `breeze_has_partner_access(P)` is
 * false because org scope carries `accessiblePartnerIds: []`. Every request-path
 * reader therefore had to escalate into a nested `withSystemDbAccessContext`,
 * which acquires a SECOND pooled connection while the request's own transaction
 * still holds the first (#1105 pool-starvation shape) and bypasses RLS entirely.
 *
 * The fix is a SELECT-only own-partner branch, added as a SEPARATE permissive
 * policy per table:
 *
 *   <table>_partner_wide_select  FOR SELECT USING (
 *     org_id IS NULL AND partner_id = public.breeze_current_partner_id()   -- direct-column
 *     -- or the equivalent EXISTS-join to configuration_policies for children
 *   )
 *
 * Kept separate from each table's existing FOR ALL / per-command policies on
 * purpose: appending the branch to a FOR ALL `USING` would also widen
 * UPDATE/DELETE row targeting to partner-wide rows. Postgres never consults a
 * FOR SELECT policy when computing UPDATE/DELETE target rows, so a separate
 * policy ORs into reads only. Same mechanism as
 * `cis_baselines_partner_wide_select` (2026-08-10) and
 * 2026-06-13-catalog-partner-read-branch.sql.
 *
 * Three properties this suite has to prove, none of which a mocked unit test
 * can reach (no RLS runs there) and none of which rls-coverage proves either
 * (it is a pg_catalog shape inspection, not a functional one):
 *
 *  1. An org session of the OWNING partner can SELECT the partner-wide parent
 *     AND every child in the chain — direct-column children and both
 *     one-hop and two-hop EXISTS-join children.
 *  2. The branch grants NO write. UPDATE/DELETE from that same org session
 *     must affect ZERO rows and leave the row byte-identical. Note this is a
 *     silent no-op, not a 42501 — RLS hides the target row from the write
 *     command rather than raising. A test that only asserted "it threw" would
 *     be vacuous; assert rowCount AND re-read under system scope. The 42501
 *     guarantee is proven separately via a cross-partner INSERT forge, where
 *     WITH CHECK does raise.
 *  3. A DIFFERENT partner's partner-wide rows stay invisible, and an
 *     agent-shaped context (`currentPartnerId` NULL, so
 *     `breeze_current_partner_id()` is NULL) sees nothing — the branch must
 *     not accidentally fire on a NULL GUC. Wave 2 populates that GUC for agent
 *     sessions deliberately; until then agents must be unaffected.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAlertRules,
  configPolicyAutomations,
  configPolicyComplianceRules,
  configPolicyPatchSettings,
  configPolicyMaintenanceSettings,
  configPolicyEventLogSettings,
  configPolicySensitiveDataSettings,
  configPolicyMonitoringSettings,
  configPolicyMonitoringWatches,
  configPolicyRemoteAccessSettings,
  configPolicyBackupSettings,
  backupProfiles,
} from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';

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
 * partnerId for org scope too (`buildDbAccessContext`, middleware/auth.ts),
 * which is exactly what the read branch keys on — so it is set here
 * deliberately. `accessiblePartnerIds` stays EMPTY: an org token never passes
 * `breeze_has_partner_access`, and that is what keeps the branch read-only.
 *
 * Passing `currentPartnerId: null` yields the AGENT session shape
 * (middleware/agentAuth.ts sets it null today).
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

const createdPolicies: string[] = [];
const createdProfiles: string[] = [];

afterEach(async () => {
  if (createdPolicies.length === 0 && createdProfiles.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdPolicies.length > 0) {
      // feature links / assignments / per-feature children all cascade.
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.id, createdPolicies));
    }
    if (createdProfiles.length > 0) {
      await db.delete(backupProfiles).where(inArray(backupProfiles.id, createdProfiles));
    }
  });
  createdPolicies.length = 0;
  createdProfiles.length = 0;
});

interface Chain {
  partnerId: string;
  orgId: string;
  policyId: string;
  /** feature link ids, keyed by feature type */
  links: Record<string, string>;
  assignmentPartnerId: string;
  assignmentOrgId: string;
  alertRuleId: string;
  automationId: string;
  complianceRuleId: string;
  patchSettingsId: string;
  maintenanceSettingsId: string;
  eventLogSettingsId: string;
  sensitiveDataSettingsId: string;
  monitoringSettingsId: string;
  monitoringWatchId: string;
  remoteAccessSettingsId: string;
  backupSettingsId: string;
  backupProfileId: string;
}

/**
 * Seed a complete partner-wide policy chain under a PARTNER context (the only
 * scope that may write partner-wide rows). Returns every row id so each test
 * can probe the whole chain rather than a single representative table — the
 * per-table policies are hand-written and one omission is a silent
 * zero-rows-forever bug on that feature only.
 */
async function seedPartnerWideChain(): Promise<Chain> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const ctx = partnerContext(partner.id, [org.id]);

  return withDbAccessContext(ctx, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: null, partnerId: partner.id, name: 'Partner-wide baseline' })
      .returning();
    createdPolicies.push(policy!.id);

    // The backup profile has to exist BEFORE the backup feature link: the
    // deferred parity trigger (2026-07-27-c) requires
    // feature_links.feature_policy_id === backup_settings.backup_profile_id
    // whenever a profile is referenced.
    const [backupProfile] = await db
      .insert(backupProfiles)
      .values({ orgId: null, partnerId: partner.id, name: 'Partner-wide profile', selections: {} })
      .returning();
    createdProfiles.push(backupProfile!.id);

    const links: Record<string, string> = {};
    const featureTypes = [
      'alert_rule',
      'automation',
      'compliance',
      'patch',
      'maintenance',
      'event_log',
      'sensitive_data',
      'monitoring',
      'remote_access',
      'backup',
    ] as const;
    for (const featureType of featureTypes) {
      const [link] = await db
        .insert(configPolicyFeatureLinks)
        .values({
          configPolicyId: policy!.id,
          featureType,
          featurePolicyId: featureType === 'backup' ? backupProfile!.id : null,
          inlineSettings: featureType === 'backup' ? null : {},
        })
        .returning();
      links[featureType] = link!.id;
    }

    const [assignmentPartner] = await db
      .insert(configPolicyAssignments)
      .values({ configPolicyId: policy!.id, level: 'partner', targetId: partner.id })
      .returning();
    const [assignmentOrg] = await db
      .insert(configPolicyAssignments)
      .values({ configPolicyId: policy!.id, level: 'organization', targetId: org.id })
      .returning();

    const [alertRule] = await db
      .insert(configPolicyAlertRules)
      .values({
        featureLinkId: links.alert_rule!,
        name: 'CPU high',
        severity: 'high',
        conditions: { metric: 'cpu', op: '>', value: 90 },
      })
      .returning();

    const [automation] = await db
      .insert(configPolicyAutomations)
      .values({
        featureLinkId: links.automation!,
        name: 'Nightly cleanup',
        triggerType: 'schedule',
        cronExpression: '0 3 * * *',
        actions: [],
      })
      .returning();

    const [complianceRule] = await db
      .insert(configPolicyComplianceRules)
      .values({ featureLinkId: links.compliance!, name: 'Disk encryption', rules: [] })
      .returning();

    const [patchSettings] = await db
      .insert(configPolicyPatchSettings)
      .values({ featureLinkId: links.patch! })
      .returning();

    const [maintenanceSettings] = await db
      .insert(configPolicyMaintenanceSettings)
      .values({ featureLinkId: links.maintenance! })
      .returning();

    const [eventLogSettings] = await db
      .insert(configPolicyEventLogSettings)
      .values({ featureLinkId: links.event_log! })
      .returning();

    const [sensitiveDataSettings] = await db
      .insert(configPolicySensitiveDataSettings)
      .values({ featureLinkId: links.sensitive_data! })
      .returning();

    const [monitoringSettings] = await db
      .insert(configPolicyMonitoringSettings)
      .values({ featureLinkId: links.monitoring! })
      .returning();

    const [monitoringWatch] = await db
      .insert(configPolicyMonitoringWatches)
      .values({ settingsId: monitoringSettings!.id, watchType: 'service', name: 'spooler' })
      .returning();

    const [remoteAccessSettings] = await db
      .insert(configPolicyRemoteAccessSettings)
      .values({ featureLinkId: links.remote_access! })
      .returning();

    const [backupSettings] = await db
      .insert(configPolicyBackupSettings)
      .values({
        featureLinkId: links.backup!,
        orgId: null,
        partnerId: partner.id,
        backupProfileId: backupProfile!.id,
      })
      .returning();

    return {
      partnerId: partner.id,
      orgId: org.id,
      policyId: policy!.id,
      links,
      assignmentPartnerId: assignmentPartner!.id,
      assignmentOrgId: assignmentOrg!.id,
      alertRuleId: alertRule!.id,
      automationId: automation!.id,
      complianceRuleId: complianceRule!.id,
      patchSettingsId: patchSettings!.id,
      maintenanceSettingsId: maintenanceSettings!.id,
      eventLogSettingsId: eventLogSettings!.id,
      sensitiveDataSettingsId: sensitiveDataSettings!.id,
      monitoringSettingsId: monitoringSettings!.id,
      monitoringWatchId: monitoringWatch!.id,
      remoteAccessSettingsId: remoteAccessSettings!.id,
      backupSettingsId: backupSettings!.id,
      backupProfileId: backupProfile!.id,
    };
  });
}

/**
 * Every table in the chain, as (label, id-selector) so each visibility
 * assertion covers ALL of them instead of a representative sample. Adding a
 * table to the migration without adding it here would leave it unproven.
 */
function chainProbes(chain: Chain): Array<{ label: string; probe: () => Promise<unknown[]> }> {
  return [
    { label: 'configuration_policies', probe: () => db.select().from(configurationPolicies).where(eq(configurationPolicies.id, chain.policyId)) },
    { label: 'config_policy_feature_links', probe: () => db.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, chain.policyId)) },
    { label: 'config_policy_assignments (partner level)', probe: () => db.select().from(configPolicyAssignments).where(eq(configPolicyAssignments.id, chain.assignmentPartnerId)) },
    { label: 'config_policy_assignments (org level)', probe: () => db.select().from(configPolicyAssignments).where(eq(configPolicyAssignments.id, chain.assignmentOrgId)) },
    { label: 'config_policy_alert_rules', probe: () => db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, chain.alertRuleId)) },
    { label: 'config_policy_automations', probe: () => db.select().from(configPolicyAutomations).where(eq(configPolicyAutomations.id, chain.automationId)) },
    { label: 'config_policy_compliance_rules', probe: () => db.select().from(configPolicyComplianceRules).where(eq(configPolicyComplianceRules.id, chain.complianceRuleId)) },
    { label: 'config_policy_patch_settings', probe: () => db.select().from(configPolicyPatchSettings).where(eq(configPolicyPatchSettings.id, chain.patchSettingsId)) },
    { label: 'config_policy_maintenance_settings', probe: () => db.select().from(configPolicyMaintenanceSettings).where(eq(configPolicyMaintenanceSettings.id, chain.maintenanceSettingsId)) },
    { label: 'config_policy_event_log_settings', probe: () => db.select().from(configPolicyEventLogSettings).where(eq(configPolicyEventLogSettings.id, chain.eventLogSettingsId)) },
    { label: 'config_policy_sensitive_data_settings', probe: () => db.select().from(configPolicySensitiveDataSettings).where(eq(configPolicySensitiveDataSettings.id, chain.sensitiveDataSettingsId)) },
    { label: 'config_policy_monitoring_settings', probe: () => db.select().from(configPolicyMonitoringSettings).where(eq(configPolicyMonitoringSettings.id, chain.monitoringSettingsId)) },
    { label: 'config_policy_monitoring_watches', probe: () => db.select().from(configPolicyMonitoringWatches).where(eq(configPolicyMonitoringWatches.id, chain.monitoringWatchId)) },
    { label: 'config_policy_remote_access_settings', probe: () => db.select().from(configPolicyRemoteAccessSettings).where(eq(configPolicyRemoteAccessSettings.id, chain.remoteAccessSettingsId)) },
    { label: 'config_policy_backup_settings', probe: () => db.select().from(configPolicyBackupSettings).where(eq(configPolicyBackupSettings.id, chain.backupSettingsId)) },
    { label: 'backup_profiles', probe: () => db.select().from(backupProfiles).where(eq(backupProfiles.id, chain.backupProfileId)) },
  ];
}

describe('config-policy chain — partner-wide SELECT branch (#2468)', () => {
  describe('an ORG session of the OWNING partner can READ the whole partner-wide chain', () => {
    it('sees every table in the chain', async () => {
      const chain = await seedPartnerWideChain();

      const visible = await withDbAccessContext(orgContext(chain.orgId, chain.partnerId), async () => {
        const results: Record<string, number> = {};
        for (const { label, probe } of chainProbes(chain)) {
          results[label] = (await probe()).length;
        }
        return results;
      });

      // Every entry must be >= 1. Reported as one object so a failure names
      // EVERY missing table at once instead of stopping at the first.
      const missing = Object.entries(visible).filter(([, count]) => count === 0).map(([label]) => label);
      expect(missing, `tables invisible to an org session of the owning partner: ${missing.join(', ')}`).toEqual([]);
    });
  });

  describe('the branch is scoped to the caller’s OWN partner', () => {
    it('an ORG session of a DIFFERENT partner sees nothing', async () => {
      const chain = await seedPartnerWideChain();
      const otherPartner = await createPartner();
      const otherOrg = await createOrganization({ partnerId: otherPartner.id });

      const visible = await withDbAccessContext(orgContext(otherOrg.id, otherPartner.id), async () => {
        const results: Record<string, number> = {};
        for (const { label, probe } of chainProbes(chain)) {
          results[label] = (await probe()).length;
        }
        return results;
      });

      const leaked = Object.entries(visible).filter(([, count]) => count > 0).map(([label]) => label);
      expect(leaked, `cross-partner leak on: ${leaked.join(', ')}`).toEqual([]);
    });

    it('a PARTNER session of a DIFFERENT partner sees nothing', async () => {
      const chain = await seedPartnerWideChain();
      const otherPartner = await createPartner();

      const visible = await withDbAccessContext(partnerContext(otherPartner.id), async () => {
        const results: Record<string, number> = {};
        for (const { label, probe } of chainProbes(chain)) {
          results[label] = (await probe()).length;
        }
        return results;
      });

      const leaked = Object.entries(visible).filter(([, count]) => count > 0).map(([label]) => label);
      expect(leaked, `cross-partner leak on: ${leaked.join(', ')}`).toEqual([]);
    });

    // The GUC is NULL for agent sessions today (middleware/agentAuth.ts).
    // `partner_id = NULL` is NULL, never true, so the branch must not fire —
    // otherwise wave 1 would silently widen agent reads before wave 2 decides
    // to. Guards against writing the predicate as `partner_id IS NOT DISTINCT
    // FROM breeze_current_partner_id()`, which WOULD match NULL partner rows.
    it('an AGENT-shaped session (currentPartnerId NULL) sees nothing', async () => {
      const chain = await seedPartnerWideChain();

      const visible = await withDbAccessContext(orgContext(chain.orgId, null), async () => {
        const results: Record<string, number> = {};
        for (const { label, probe } of chainProbes(chain)) {
          results[label] = (await probe()).length;
        }
        return results;
      });

      const leaked = Object.entries(visible).filter(([, count]) => count > 0).map(([label]) => label);
      expect(leaked, `agent context saw partner-wide rows on: ${leaked.join(', ')}`).toEqual([]);
    });
  });

  describe('the read branch grants NO write', () => {
    it('an ORG session of the owning partner cannot UPDATE the partner-wide policy', async () => {
      const chain = await seedPartnerWideChain();

      const updated = await withDbAccessContext(orgContext(chain.orgId, chain.partnerId), () =>
        db.update(configurationPolicies).set({ name: 'HIJACKED' }).where(eq(configurationPolicies.id, chain.policyId)).returning(),
      );
      expect(updated).toHaveLength(0);

      const [after] = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select().from(configurationPolicies).where(eq(configurationPolicies.id, chain.policyId)),
      );
      expect(after?.name).toBe('Partner-wide baseline');
    });

    it('an ORG session of the owning partner cannot DELETE the partner-wide policy', async () => {
      const chain = await seedPartnerWideChain();

      const deleted = await withDbAccessContext(orgContext(chain.orgId, chain.partnerId), () =>
        db.delete(configurationPolicies).where(eq(configurationPolicies.id, chain.policyId)).returning(),
      );
      expect(deleted).toHaveLength(0);

      const still = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select().from(configurationPolicies).where(eq(configurationPolicies.id, chain.policyId)),
      );
      expect(still).toHaveLength(1);
    });

    it('an ORG session of the owning partner cannot UPDATE or DELETE the chain children', async () => {
      const chain = await seedPartnerWideChain();
      const ctx = orgContext(chain.orgId, chain.partnerId);

      const writes = await withDbAccessContext(ctx, async () => ({
        featureLink: (await db.update(configPolicyFeatureLinks).set({ inlineSettings: { hijacked: true } }).where(eq(configPolicyFeatureLinks.id, chain.links.monitoring!)).returning()).length,
        assignment: (await db.delete(configPolicyAssignments).where(eq(configPolicyAssignments.id, chain.assignmentOrgId)).returning()).length,
        alertRule: (await db.update(configPolicyAlertRules).set({ name: 'HIJACKED' }).where(eq(configPolicyAlertRules.id, chain.alertRuleId)).returning()).length,
        monitoringSettings: (await db.update(configPolicyMonitoringSettings).set({ checkIntervalSeconds: 9999 }).where(eq(configPolicyMonitoringSettings.id, chain.monitoringSettingsId)).returning()).length,
        monitoringWatch: (await db.update(configPolicyMonitoringWatches).set({ name: 'HIJACKED' }).where(eq(configPolicyMonitoringWatches.id, chain.monitoringWatchId)).returning()).length,
        remoteAccess: (await db.update(configPolicyRemoteAccessSettings).set({ sessionPromptMode: 'silent' }).where(eq(configPolicyRemoteAccessSettings.id, chain.remoteAccessSettingsId)).returning()).length,
        backupSettings: (await db.update(configPolicyBackupSettings).set({ paths: ['HIJACKED'] }).where(eq(configPolicyBackupSettings.id, chain.backupSettingsId)).returning()).length,
        backupProfile: (await db.update(backupProfiles).set({ name: 'HIJACKED' }).where(eq(backupProfiles.id, chain.backupProfileId)).returning()).length,
        sensitiveData: (await db.update(configPolicySensitiveDataSettings).set({ workers: 99 }).where(eq(configPolicySensitiveDataSettings.id, chain.sensitiveDataSettingsId)).returning()).length,
      }));

      expect(writes).toEqual({
        featureLink: 0,
        assignment: 0,
        alertRule: 0,
        monitoringSettings: 0,
        monitoringWatch: 0,
        remoteAccess: 0,
        backupSettings: 0,
        backupProfile: 0,
        sensitiveData: 0,
      });

      // Nothing was actually mutated or removed.
      const after = await withDbAccessContext(SYSTEM_CTX, async () => ({
        alertRuleName: (await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, chain.alertRuleId)))[0]?.name,
        profileName: (await db.select().from(backupProfiles).where(eq(backupProfiles.id, chain.backupProfileId)))[0]?.name,
        assignments: (await db.select().from(configPolicyAssignments).where(eq(configPolicyAssignments.id, chain.assignmentOrgId))).length,
      }));
      expect(after).toEqual({ alertRuleName: 'CPU high', profileName: 'Partner-wide profile', assignments: 1 });
    });

    // The 42501 half of the acceptance criterion: WITH CHECK (unlike USING)
    // does raise rather than filter, so an INSERT forge is where the write
    // denial is observable as an error.
    it('an ORG session cannot INSERT a partner-wide row for its own partner (42501)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await expectSqlState(
        () => withDbAccessContext(orgContext(org.id, partner.id), () =>
          db.insert(configurationPolicies).values({ orgId: null, partnerId: partner.id, name: 'forged' }).returning(),
        ),
        '42501',
      );

      await expectSqlState(
        () => withDbAccessContext(orgContext(org.id, partner.id), () =>
          db.insert(backupProfiles).values({ orgId: null, partnerId: partner.id, name: 'forged', selections: {} }).returning(),
        ),
        '42501',
      );
    });

    it('a PARTNER session cannot forge a partner-wide row for ANOTHER partner (42501)', async () => {
      const attacker = await createPartner();
      const victim = await createPartner();

      await expectSqlState(
        () => withDbAccessContext(partnerContext(attacker.id), () =>
          db.insert(configurationPolicies).values({ orgId: null, partnerId: victim.id, name: 'forged' }).returning(),
        ),
        '42501',
      );
    });
  });

  describe('existing visibility is unchanged', () => {
    it('the owning PARTNER session still reads and writes the whole chain', async () => {
      const chain = await seedPartnerWideChain();

      const visible = await withDbAccessContext(partnerContext(chain.partnerId, [chain.orgId]), async () => {
        const results: Record<string, number> = {};
        for (const { label, probe } of chainProbes(chain)) {
          results[label] = (await probe()).length;
        }
        return results;
      });
      const missing = Object.entries(visible).filter(([, count]) => count === 0).map(([label]) => label);
      expect(missing).toEqual([]);

      const updated = await withDbAccessContext(partnerContext(chain.partnerId, [chain.orgId]), () =>
        db.update(configurationPolicies).set({ name: 'Renamed by owner' }).where(eq(configurationPolicies.id, chain.policyId)).returning(),
      );
      expect(updated).toHaveLength(1);
    });

    it('an ORG-OWNED policy is still readable and writable by its own org, and invisible cross-org', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const [policy] = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
        db.insert(configurationPolicies).values({ orgId: orgA.id, partnerId: null, name: 'Org A policy' }).returning(),
      );
      createdPolicies.push(policy!.id);

      const ownRows = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
        db.select().from(configurationPolicies).where(eq(configurationPolicies.id, policy!.id)),
      );
      expect(ownRows).toHaveLength(1);

      const updated = await withDbAccessContext(orgContext(orgA.id, partner.id), () =>
        db.update(configurationPolicies).set({ name: 'Org A renamed' }).where(eq(configurationPolicies.id, policy!.id)).returning(),
      );
      expect(updated).toHaveLength(1);

      // Same partner, different org — the read branch requires org_id IS NULL,
      // so it must NOT make sibling ORG-OWNED policies visible.
      const siblingRows = await withDbAccessContext(orgContext(orgB.id, partner.id), () =>
        db.select().from(configurationPolicies).where(eq(configurationPolicies.id, policy!.id)),
      );
      expect(siblingRows).toHaveLength(0);
    });
  });
});
