/**
 * HISTORICAL ONE-SHOT MIGRATION — already run in production. DO NOT re-run.
 *
 * After the 2026-06 partner-scoping of update rings, patch_policies no longer
 * carries org_id; ring discovery in migratePatchPoliciesLive now resolves by
 * partner_id. Per-org ring selection is therefore BEST-EFFORT: a partner with
 * multiple rings across orgs may resolve the same ring for every org.
 *
 * Retained for historical reference and to keep the build green. For any fresh
 * migration, write a new script that accounts for the current schema.
 */

/**
 * One-shot data migration script: Standalone feature tables -> Configuration Policies.
 *
 * Reads standalone feature tables (alertRules, automations, automationPolicies,
 * patchPolicies, maintenanceWindows) and populates the normalized configuration
 * policy tables (configurationPolicies, configPolicyFeatureLinks, and their
 * per-feature child tables).
 *
 * For each org that has legacy data, creates a single umbrella policy named
 * "Migrated from legacy - [orgName]" with feature links per feature type.
 *
 * Usage:
 *   npx tsx apps/api/src/scripts/migrateToConfigPolicies.ts
 *   npx tsx apps/api/src/scripts/migrateToConfigPolicies.ts --dry-run
 *
 * Idempotent: skips orgs that already have a "Migrated from legacy" policy.
 * Atomic: uses db.transaction() per org.
 */

import { pathToFileURL } from 'node:url';
import { eq, and, like, isNull } from 'drizzle-orm';
import { db, closeDb, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import type { AuthContext } from '../middleware/auth';
import { createSystemAuthContext } from '../services/featureConfigResolver';
import { convertRuleToMonitor } from '../services/monitors/ruleConversionService';
import {
  // Source tables
  organizations,
  alertRules,
  automations,
  automationPolicies,
  patchPolicies,
  maintenanceWindows,
  // Target tables
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAutomations,
  configPolicyComplianceRules,
  configPolicyPatchSettings,
  configPolicyMaintenanceSettings,
} from '../db/schema';

// ---------------------------------------------------------------------------
// Types for JSONB blobs we destructure from legacy tables
// ---------------------------------------------------------------------------

interface AutomationTrigger {
  type?: string;
  schedule?: string;
  cron?: string;
  cronExpression?: string;
  timezone?: string;
  eventType?: string;
  [key: string]: unknown;
}

interface PatchAutoApprove {
  enabled?: boolean;
  severities?: string[];
  [key: string]: unknown;
}

interface PatchSchedule {
  frequency?: string;
  time?: string;
  dayOfWeek?: string;
  dayOfMonth?: number;
  [key: string]: unknown;
}

interface PatchRebootPolicy {
  action?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  const prefix = DRY_RUN ? '[DRY-RUN] ' : '';
  console.log(`${prefix}${msg}`);
}

/** Safely interpret an unknown JSONB value as a record. */
function asObj<T>(val: unknown): T | undefined {
  if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
    return val as T;
  }
  return undefined;
}

/** Calculate whole hours between two timestamps; returns fallback when invalid. */
function hoursBetween(
  start: Date | null,
  end: Date | null,
  fallback = 2,
): number {
  if (!start || !end) return fallback;
  const diffMs = end.getTime() - start.getTime();
  if (diffMs <= 0) return fallback;
  return Math.max(1, Math.round(diffMs / (1000 * 60 * 60)));
}

// Drizzle transaction type shorthand
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Summary counters
// ---------------------------------------------------------------------------

const summary = {
  orgsProcessed: 0,
  orgsSkipped: 0,
  policiesCreated: 0,
  featureLinksCreated: 0,
  alertRulesCreated: 0,
  automationsCreated: 0,
  complianceRulesCreated: 0,
  patchSettingsCreated: 0,
  maintenanceSettingsCreated: 0,
  assignmentsCreated: 0,
};

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

async function migrate(auth: AuthContext) {
  log('Starting configuration policy migration...');
  if (DRY_RUN) {
    log('Dry-run mode enabled -- no data will be written.\n');
  }

  // 1. Collect all unique orgIds that have any legacy feature data.
  // NOTE: patchPolicies is now partner-scoped (no orgId column) — it is not used
  // for org discovery here. Orgs that only had patch policies will be skipped,
  // which is correct: their settings are now managed at partner scope.
  const [
    orgFromAlertRules,
    orgFromAutomations,
    orgFromAutomationPolicies,
    orgFromMaintenanceWindows,
  ] = await Promise.all([
    db.selectDistinct({ orgId: alertRules.orgId }).from(alertRules),
    db.selectDistinct({ orgId: automations.orgId }).from(automations),
    db.selectDistinct({ orgId: automationPolicies.orgId }).from(automationPolicies),
    db.selectDistinct({ orgId: maintenanceWindows.orgId }).from(maintenanceWindows),
  ]);

  const orgIdSet = new Set<string>();
  for (const row of [
    ...orgFromAlertRules,
    ...orgFromAutomations,
    ...orgFromAutomationPolicies,
    ...orgFromMaintenanceWindows,
  ]) {
    // Partner-wide alert rules (org_id NULL, #2128) are not legacy org data —
    // this migrator only sweeps per-org rows.
    if (row.orgId !== null) orgIdSet.add(row.orgId);
  }

  if (orgIdSet.size === 0) {
    log('No legacy feature data found in any org. Nothing to migrate.');
    return;
  }

  log(`Found ${orgIdSet.size} org(s) with legacy feature data.\n`);

  // 2. Process each org.
  for (const orgId of Array.from(orgIdSet)) {
    if (DRY_RUN) {
      await migrateOrgDryRun(orgId);
    } else {
      await migrateOrgLive(orgId, auth);
    }
  }

  // 3. Print summary.
  log('');
  log('=== Migration Summary ===');
  log(`Orgs processed:             ${summary.orgsProcessed}`);
  log(`Orgs skipped (idempotent):  ${summary.orgsSkipped}`);
  log(`Policies created:           ${summary.policiesCreated}`);
  log(`Feature links created:      ${summary.featureLinksCreated}`);
  log(`Alert rules migrated:       ${summary.alertRulesCreated}`);
  log(`Automations migrated:       ${summary.automationsCreated}`);
  log(`Compliance rules migrated:  ${summary.complianceRulesCreated}`);
  log(`Patch settings migrated:    ${summary.patchSettingsCreated}`);
  log(`Maintenance settings:       ${summary.maintenanceSettingsCreated}`);
  log(`Assignments created:        ${summary.assignmentsCreated}`);
  log('=========================');
}

// ---------------------------------------------------------------------------
// Shared: load org metadata and check idempotency
// ---------------------------------------------------------------------------

async function loadOrg(orgId: string): Promise<{ id: string; name: string } | null> {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return org ?? null;
}

async function alreadyMigrated(orgId: string): Promise<boolean> {
  const existing = await db
    .select({ id: configurationPolicies.id })
    .from(configurationPolicies)
    .where(
      and(
        eq(configurationPolicies.orgId, orgId),
        like(configurationPolicies.name, 'Migrated from legacy%'),
      ),
    )
    .limit(1);

  return existing.length > 0;
}

// ---------------------------------------------------------------------------
// Live migration (writes data inside a transaction)
// ---------------------------------------------------------------------------

async function migrateOrgLive(orgId: string, auth: AuthContext) {
  const org = await loadOrg(orgId);
  if (!org) {
    log(`  [WARN] Org ${orgId} not found in organizations table -- skipping.`);
    return;
  }

  if (await alreadyMigrated(orgId)) {
    log(`  Org "${org.name}" (${orgId}) already has a migrated policy -- skipping.`);
    summary.orgsSkipped++;
    return;
  }

  log(`  Migrating org "${org.name}" (${orgId})...`);

  await db.transaction(async (tx) => {
    // Create the umbrella configuration policy.
    const [policy] = await tx
      .insert(configurationPolicies)
      .values({
        orgId,
        name: `Migrated from legacy - ${org.name}`,
        description: `Auto-migrated from standalone feature tables on ${new Date().toISOString()}.`,
        status: 'active',
      })
      .returning({ id: configurationPolicies.id });

    if (!policy) throw new Error(`Failed to create configuration policy for org ${orgId}`);
    const policyId = policy.id;
    summary.policiesCreated++;

    // Track assignments to deduplicate within this policy.
    const assignmentKeys = new Set<string>();

    const createAssignment = async (
      level: 'partner' | 'organization' | 'site' | 'device_group' | 'device',
      targetId: string,
    ) => {
      const key = `${level}:${targetId}`;
      if (assignmentKeys.has(key)) return;
      assignmentKeys.add(key);
      await tx.insert(configPolicyAssignments).values({
        configPolicyId: policyId,
        level,
        targetId,
        priority: 0,
      });
      summary.assignmentsCreated++;
    };

    // ---- Alert Rules ----
    const convertedAlerts = await migrateAlertRulesLive(tx, orgId, auth);
    summary.alertRulesCreated += convertedAlerts;
    log(`    Alert monitors: ${convertedAlerts} converted with original target assignments`);

    // ---- Automations ----
    await migrateAutomationsLive(tx, orgId, policyId, createAssignment);

    // ---- Patch Policies ----
    await migratePatchPoliciesLive(tx, orgId, policyId, createAssignment);

    // ---- Maintenance Windows ----
    await migrateMaintenanceWindowsLive(tx, orgId, policyId, createAssignment);

    // ---- Compliance (automationPolicies) ----
    await migrateComplianceLive(tx, orgId, policyId, createAssignment);

    summary.orgsProcessed++;
    log(`    Created policy "${`Migrated from legacy - ${org.name}`}" with ${assignmentKeys.size} assignment(s).`);
  });
}

// ---------------------------------------------------------------------------
// Per-feature live migration functions
// ---------------------------------------------------------------------------

export async function migrateAlertRulesLive(tx: Tx, orgId: string, auth: AuthContext): Promise<number> {
  const rules = await tx.select({ id: alertRules.id, templateId: alertRules.templateId }).from(alertRules).where(and(
    eq(alertRules.orgId, orgId), isNull(alertRules.managedByMonitorId), isNull(alertRules.retiredAt),
  ));
  let converted = 0;
  const templates = new Set<string>();
  for (const rule of rules) {
    if (templates.has(rule.templateId)) continue;
    templates.add(rule.templateId);
    const result = await convertRuleToMonitor(rule.id, auth, tx);
    if (!result.ok) throw new Error(`${rule.id}: ${result.failure.kind}`);
    converted += result.data.convertedRuleIds.length;
  }
  return converted;
}

async function migrateAutomationsLive(
  tx: Tx,
  orgId: string,
  policyId: string,
  createAssignment: (level: 'partner' | 'organization' | 'site' | 'device_group' | 'device', targetId: string) => Promise<void>,
) {
  const legacyAutos = await tx.select().from(automations).where(eq(automations.orgId, orgId));
  if (legacyAutos.length === 0) return;

  const [featureLink] = await tx
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policyId, featureType: 'automation' })
    .returning({ id: configPolicyFeatureLinks.id });
  if (!featureLink) throw new Error('Failed to create automation feature link');
  summary.featureLinksCreated++;

  for (let i = 0; i < legacyAutos.length; i++) {
    const auto = legacyAutos[i]!;
    const trigger = asObj<AutomationTrigger>(auto.trigger);

    // Map trigger type: 'schedule' -> 'schedule', 'event' -> 'event', etc.
    const triggerType = trigger?.type ?? 'manual';
    const cronExpression = trigger?.cron ?? trigger?.cronExpression ?? trigger?.schedule ?? null;
    const timezone = trigger?.timezone ?? null;
    const eventType = trigger?.eventType ?? null;

    await tx.insert(configPolicyAutomations).values({
      featureLinkId: featureLink.id,
      name: auto.name,
      enabled: auto.enabled,
      triggerType,
      cronExpression,
      timezone,
      eventType,
      actions: auto.actions ?? {},
      onFailure: auto.onFailure,
      sortOrder: i,
    });
    summary.automationsCreated++;
  }

  // Assign at organization level.
  await createAssignment('organization', orgId);
  log(`    Automations: ${legacyAutos.length} migrated`);
}

async function migratePatchPoliciesLive(
  tx: Tx,
  orgId: string,
  policyId: string,
  createAssignment: (level: 'partner' | 'organization' | 'site' | 'device_group' | 'device', targetId: string) => Promise<void>,
) {
  // Rings are partner-scoped; derive partnerId from org before querying.
  const [orgRow] = await tx.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!orgRow?.partnerId) return;
  const legacyPatches = await tx.select().from(patchPolicies).where(eq(patchPolicies.partnerId, orgRow.partnerId));
  if (legacyPatches.length === 0) return;

  // One feature link for patch; take the first enabled policy (or just the first).
  const primary = legacyPatches.find((p) => p.enabled) ?? legacyPatches[0]!;

  const autoApproveObj = asObj<PatchAutoApprove>(primary.autoApprove);
  const scheduleObj = asObj<PatchSchedule>(primary.schedule);
  const rebootObj = asObj<PatchRebootPolicy>(primary.rebootPolicy);

  const [featureLink] = await tx
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policyId, featureType: 'patch' })
    .returning({ id: configPolicyFeatureLinks.id });
  if (!featureLink) throw new Error('Failed to create patch feature link');
  summary.featureLinksCreated++;

  // The legacy patch_policies.sources column was dropped (spec 2026-08-04,
  // never consumed by the approval path) — default to ['os'].
  // Acceptable only because this script is retained as a one-shot, not a
  // repeatable sync: re-running it for a legacy partner whose ring already
  // opted in to third-party auto-approve would silently drop that opt-in
  // by re-writing sources to ['os'] here.
  const sources: string[] = ['os'];

  await tx.insert(configPolicyPatchSettings).values({
    featureLinkId: featureLink.id,
    sources,
    autoApprove: autoApproveObj?.enabled ?? false,
    autoApproveSeverities: autoApproveObj?.severities ?? [],
    scheduleFrequency: scheduleObj?.frequency ?? 'weekly',
    scheduleTime: scheduleObj?.time ?? '02:00',
    scheduleDayOfWeek: scheduleObj?.dayOfWeek ?? 'sun',
    scheduleDayOfMonth: scheduleObj?.dayOfMonth ?? 1,
    rebootPolicy: rebootObj?.action ?? 'if_required',
  });
  summary.patchSettingsCreated++;

  // Assign at organization level.
  await createAssignment('organization', orgId);
  log(`    Patch policies: 1 migrated (from ${legacyPatches.length} legacy polic${legacyPatches.length === 1 ? 'y' : 'ies'})`);
}

async function migrateMaintenanceWindowsLive(
  tx: Tx,
  orgId: string,
  policyId: string,
  createAssignment: (level: 'partner' | 'organization' | 'site' | 'device_group' | 'device', targetId: string) => Promise<void>,
) {
  const legacyMaint = await tx
    .select()
    .from(maintenanceWindows)
    .where(eq(maintenanceWindows.orgId, orgId));

  if (legacyMaint.length === 0) return;

  // Take the first active/scheduled window as the representative.
  const primary = (
    legacyMaint.find((w) => w.status === 'active' || w.status === 'scheduled') ??
    legacyMaint[0]
  )!;

  const [featureLink] = await tx
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policyId, featureType: 'maintenance' })
    .returning({ id: configPolicyFeatureLinks.id });
  if (!featureLink) throw new Error('Failed to create maintenance feature link');
  summary.featureLinksCreated++;

  const durationHours = hoursBetween(primary.startTime, primary.endTime);

  await tx.insert(configPolicyMaintenanceSettings).values({
    featureLinkId: featureLink.id,
    recurrence: primary.recurrence ?? 'weekly',
    durationHours,
    timezone: primary.timezone ?? 'UTC',
    // For 'once' recurrence, store the original startTime as windowStart
    windowStart: primary.recurrence === 'once' && primary.startTime
      ? primary.startTime.toISOString()
      : null,
    suppressAlerts: primary.suppressAlerts ?? true,
    suppressPatching: primary.suppressPatching ?? false,
    suppressAutomations: primary.suppressAutomations ?? false,
    suppressScripts: primary.suppressScripts ?? false,
    notifyBeforeMinutes: primary.notifyBefore ?? 15,
    notifyOnStart: primary.notifyOnStart ?? true,
    notifyOnEnd: primary.notifyOnEnd ?? true,
  });
  summary.maintenanceSettingsCreated++;

  // Assign at organization level.
  await createAssignment('organization', orgId);
  log(`    Maintenance windows: 1 migrated (from ${legacyMaint.length} legacy window${legacyMaint.length === 1 ? '' : 's'})`);
}

async function migrateComplianceLive(
  tx: Tx,
  orgId: string,
  policyId: string,
  createAssignment: (level: 'partner' | 'organization' | 'site' | 'device_group' | 'device', targetId: string) => Promise<void>,
) {
  const legacyCompliance = await tx
    .select()
    .from(automationPolicies)
    .where(eq(automationPolicies.orgId, orgId));

  if (legacyCompliance.length === 0) return;

  const [featureLink] = await tx
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policyId, featureType: 'compliance' })
    .returning({ id: configPolicyFeatureLinks.id });
  if (!featureLink) throw new Error('Failed to create compliance feature link');
  summary.featureLinksCreated++;

  for (let i = 0; i < legacyCompliance.length; i++) {
    const policy = legacyCompliance[i]!;

    await tx.insert(configPolicyComplianceRules).values({
      featureLinkId: featureLink.id,
      name: policy.name,
      rules: policy.rules ?? {},
      enforcementLevel: policy.enforcement,
      checkIntervalMinutes: policy.checkIntervalMinutes,
      remediationScriptId: policy.remediationScriptId,
      sortOrder: i,
    });
    summary.complianceRulesCreated++;
  }

  // Assign at organization level.
  await createAssignment('organization', orgId);
  log(`    Compliance rules: ${legacyCompliance.length} migrated`);
}

// ---------------------------------------------------------------------------
// Dry-run variant: queries legacy data and reports what would be created.
// ---------------------------------------------------------------------------

async function migrateOrgDryRun(orgId: string) {
  const org = await loadOrg(orgId);
  if (!org) {
    log(`  [WARN] Org ${orgId} not found in organizations table -- skipping.`);
    return;
  }

  if (await alreadyMigrated(orgId)) {
    log(`  Org "${org.name}" (${orgId}) already has a migrated policy -- skipping.`);
    summary.orgsSkipped++;
    return;
  }

  log(`  Org "${org.name}" (${orgId}):`);

  // Rings are partner-scoped; derive partnerId from org before querying.
  const [orgForPartner] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const orgPartnerId = orgForPartner?.partnerId ?? null;

  const [legacyAlerts, legacyAutos, legacyPatches, legacyMaint, legacyComp] =
    await Promise.all([
      db.select().from(alertRules).where(and(
        eq(alertRules.orgId, orgId), isNull(alertRules.managedByMonitorId), isNull(alertRules.retiredAt),
      )),
      db.select().from(automations).where(eq(automations.orgId, orgId)),
      orgPartnerId
        ? db.select().from(patchPolicies).where(eq(patchPolicies.partnerId, orgPartnerId))
        : Promise.resolve([]),
      db.select().from(maintenanceWindows).where(eq(maintenanceWindows.orgId, orgId)),
      db.select().from(automationPolicies).where(eq(automationPolicies.orgId, orgId)),
    ]);

  summary.policiesCreated++;

  const parts: string[] = [];

  if (legacyAlerts.length > 0) {
    parts.push(`${legacyAlerts.length} candidate monitor conversion(s), each retaining its original target; equivalence/convertibility not checked in this historical dry-run`);
  }

  if (legacyAutos.length > 0) {
    parts.push(`${legacyAutos.length} automation(s)`);
    summary.automationsCreated += legacyAutos.length;
    summary.featureLinksCreated++;
    summary.assignmentsCreated++;
  }

  if (legacyPatches.length > 0) {
    parts.push(`1 patch setting (from ${legacyPatches.length} legacy polic${legacyPatches.length === 1 ? 'y' : 'ies'})`);
    summary.patchSettingsCreated++;
    summary.featureLinksCreated++;
    summary.assignmentsCreated++;
  }

  if (legacyMaint.length > 0) {
    parts.push(`1 maintenance setting (from ${legacyMaint.length} legacy window${legacyMaint.length === 1 ? '' : 's'})`);
    summary.maintenanceSettingsCreated++;
    summary.featureLinksCreated++;
    summary.assignmentsCreated++;
  }

  if (legacyComp.length > 0) {
    parts.push(`${legacyComp.length} compliance rule(s)`);
    summary.complianceRulesCreated += legacyComp.length;
    summary.featureLinksCreated++;
    summary.assignmentsCreated++;
  }

  summary.orgsProcessed++;
  log(`    Would create "Migrated from legacy - ${org.name}" with: ${parts.join(', ') || 'no feature data (skipped)'}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function runHistoricalMigration() {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const base = createSystemAuthContext();
    if (DRY_RUN) return migrate(base);
    return migrate(base); // system writes persist null actors through the shared converter
  }, 'historical-config-policy-migration'));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHistoricalMigration()
    .then(() => { log('Migration complete.'); return closeDb(); })
    .then(() => { process.exitCode = 0; })
    .catch(async (error) => {
      console.error('Migration failed:', error);
      process.exitCode = 1;
      await closeDb();
    });
}
