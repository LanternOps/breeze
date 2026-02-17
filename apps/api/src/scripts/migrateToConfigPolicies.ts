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

import { eq, and, like } from 'drizzle-orm';
import { db, closeDb } from '../db';
import {
  // Source tables
  organizations,
  alertRules,
  alertTemplates,
  automations,
  automationPolicies,
  patchPolicies,
  maintenanceWindows,
  // Target tables
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyAlertRules,
  configPolicyAutomations,
  configPolicyComplianceRules,
  configPolicyPatchSettings,
  configPolicyMaintenanceSettings,
} from '../db/schema';

// ---------------------------------------------------------------------------
// Types for JSONB blobs we destructure from legacy tables
// ---------------------------------------------------------------------------

interface AlertOverrideSettings {
  severity?: string;
  conditions?: unknown;
  cooldownMinutes?: number;
  autoResolve?: boolean;
  autoResolveConditions?: unknown;
  titleTemplate?: string;
  messageTemplate?: string;
}

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

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
type AlertSeverity = (typeof VALID_SEVERITIES)[number];

/** Map legacy targetType to configAssignmentLevelEnum value. */
function mapTargetType(
  targetType: string,
): 'organization' | 'site' | 'device' {
  switch (targetType) {
    case 'org':
    case 'organization':
      return 'organization';
    case 'site':
      return 'site';
    case 'device':
      return 'device';
    default:
      return 'organization';
  }
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

async function migrate() {
  log('Starting configuration policy migration...');
  if (DRY_RUN) {
    log('Dry-run mode enabled -- no data will be written.\n');
  }

  // 1. Collect all unique orgIds that have any legacy feature data.
  const [
    orgFromAlertRules,
    orgFromAutomations,
    orgFromAutomationPolicies,
    orgFromPatchPolicies,
    orgFromMaintenanceWindows,
  ] = await Promise.all([
    db.selectDistinct({ orgId: alertRules.orgId }).from(alertRules),
    db.selectDistinct({ orgId: automations.orgId }).from(automations),
    db.selectDistinct({ orgId: automationPolicies.orgId }).from(automationPolicies),
    db.selectDistinct({ orgId: patchPolicies.orgId }).from(patchPolicies),
    db.selectDistinct({ orgId: maintenanceWindows.orgId }).from(maintenanceWindows),
  ]);

  const orgIdSet = new Set<string>();
  for (const row of [
    ...orgFromAlertRules,
    ...orgFromAutomations,
    ...orgFromAutomationPolicies,
    ...orgFromPatchPolicies,
    ...orgFromMaintenanceWindows,
  ]) {
    orgIdSet.add(row.orgId);
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
      await migrateOrgLive(orgId);
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

async function migrateOrgLive(orgId: string) {
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
    await migrateAlertRulesLive(tx, orgId, policyId, createAssignment);

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

async function migrateAlertRulesLive(
  tx: Tx,
  orgId: string,
  policyId: string,
  createAssignment: (level: 'partner' | 'organization' | 'site' | 'device_group' | 'device', targetId: string) => Promise<void>,
) {
  const legacyRules = await tx.select().from(alertRules).where(eq(alertRules.orgId, orgId));
  if (legacyRules.length === 0) return;

  // Build a template lookup for extracting conditions/severity/etc.
  const allTemplates = await tx.select().from(alertTemplates);
  const templateMap = new Map(allTemplates.map((t) => [t.id, t]));

  const [featureLink] = await tx
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policyId, featureType: 'alert_rule' })
    .returning({ id: configPolicyFeatureLinks.id });
  if (!featureLink) throw new Error('Failed to create alert_rule feature link');
  summary.featureLinksCreated++;

  for (let i = 0; i < legacyRules.length; i++) {
    const rule = legacyRules[i]!;
    const template = templateMap.get(rule.templateId);
    const overrides = asObj<AlertOverrideSettings>(rule.overrideSettings);

    // Severity: override -> template -> default 'medium'
    const rawSeverity = overrides?.severity ?? template?.severity ?? 'medium';
    const severity: AlertSeverity = VALID_SEVERITIES.includes(rawSeverity as AlertSeverity)
      ? (rawSeverity as AlertSeverity)
      : 'medium';

    // Conditions: override -> template -> empty object
    const conditions = overrides?.conditions ?? template?.conditions ?? {};

    // Other fields with fallback chain
    const cooldownMinutes = overrides?.cooldownMinutes ?? template?.cooldownMinutes ?? 5;
    const autoResolve = overrides?.autoResolve ?? template?.autoResolve ?? false;
    const autoResolveConditions =
      overrides?.autoResolveConditions ?? template?.autoResolveConditions ?? null;
    const titleTemplate =
      overrides?.titleTemplate ??
      template?.titleTemplate ??
      '{{ruleName}} triggered on {{deviceName}}';
    const messageTemplate =
      overrides?.messageTemplate ??
      template?.messageTemplate ??
      '{{ruleName}} condition met';

    await tx.insert(configPolicyAlertRules).values({
      featureLinkId: featureLink.id,
      name: rule.name,
      severity,
      conditions,
      cooldownMinutes,
      autoResolve,
      autoResolveConditions,
      titleTemplate,
      messageTemplate,
      sortOrder: i,
    });
    summary.alertRulesCreated++;

    // Create assignment based on the rule's targetType/targetId.
    const level = mapTargetType(rule.targetType);
    await createAssignment(level, rule.targetId);
  }

  log(`    Alert rules: ${legacyRules.length} migrated`);
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
  const legacyPatches = await tx.select().from(patchPolicies).where(eq(patchPolicies.orgId, orgId));
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

  // sources is a patchSourceEnum[] on the legacy table, text[] on the target.
  const sources: string[] = (primary.sources as string[] | null) ?? ['os'];

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

  const [legacyAlerts, legacyAutos, legacyPatches, legacyMaint, legacyComp] =
    await Promise.all([
      db.select().from(alertRules).where(eq(alertRules.orgId, orgId)),
      db.select().from(automations).where(eq(automations.orgId, orgId)),
      db.select().from(patchPolicies).where(eq(patchPolicies.orgId, orgId)),
      db.select().from(maintenanceWindows).where(eq(maintenanceWindows.orgId, orgId)),
      db.select().from(automationPolicies).where(eq(automationPolicies.orgId, orgId)),
    ]);

  summary.policiesCreated++;

  const parts: string[] = [];

  if (legacyAlerts.length > 0) {
    parts.push(`${legacyAlerts.length} alert rule(s)`);
    summary.alertRulesCreated += legacyAlerts.length;
    summary.featureLinksCreated++;
    // Count unique assignments from alert rules.
    const uniqueAssignments = new Set(
      legacyAlerts.map((r) => `${mapTargetType(r.targetType)}:${r.targetId}`),
    );
    summary.assignmentsCreated += uniqueAssignments.size;
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

migrate()
  .then(() => {
    log('Migration complete.');
    return closeDb();
  })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    closeDb().finally(() => process.exit(1));
  });
