#!/usr/bin/env tsx
// One-time re-provisioning for the Hardware Lifecycle portal report (#5719),
// extended (#5784 W01) to also cover managed-evidence definitions and their
// config drift.
//
// provisionPortalReportDefinitions() only runs when an MSP flips
// enable_reports ON. Orgs that turned reports on BEFORE hardware_lifecycle
// joined PORTAL_DEFINITIONS therefore have the first two definitions and not
// the third, so their portal's "Generate hardware lifecycle plan" button would
// 404 forever. This walks every org with enable_reports = true and re-runs
// provisioning, which is idempotent (onConflictDoNothing on the
// (org_id, type) partial index), so re-running it is safe and a no-op for orgs
// that are already complete.
//
// The sweep's target population is two lists, not one: an org can also acquire
// a managed evidence definition by way of a linked deliverable
// (`resolveManagedEvidenceDefinition`) while portal reports are OFF, so it
// never shows up in `listReportEnabledOrgs` — `listEvidenceLinkedOrgs` covers
// that org too. See `selectTargetOrgs` in the .lib file.
//
//   pnpm --filter @breeze/api reports:reprovision-portal-definitions
//   pnpm --filter @breeze/api reports:reprovision-portal-definitions -- --apply
//   pnpm --filter @breeze/api reports:reprovision-portal-definitions -- --apply --repair
//
// Defaults to a DRY RUN that only reports what it would do. Pass --apply to
// write. Confirm the run mode with the owner before pointing this at
// production.
//
// --repair additionally rewrites any managed-evidence definition whose stored
// config has drifted from the registry default back to that default (only
// under --apply; without --apply it just logs what it would change). This is
// the ONLY place drift is repaired — resolveManagedEvidenceDefinition never
// rewrites an adopted definition's config on its own.
//
// Runs under withSystemDbAccessContext: this is a background maintenance
// script that spans every tenant, not a request path.
//
// The sweep's branching lives in reprovision-portal-report-definitions.lib.ts
// so it can be unit tested without opening a pool; this file is the I/O shell.

import { and, eq, isNotNull } from 'drizzle-orm';
import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { portalBranding, reports } from '../src/db/schema';
import { serviceDeliverables } from '../src/db/schema/serviceDeliverables';
import { provisionPortalReportDefinitions } from '../src/services/portal/reportsSelfService';
import { loadManagedEvidenceDefinition } from '../src/services/managedEvidenceDefinitions';
import type { ManagedEvidenceType } from '../src/services/managedEvidenceRegistry';
import {
  exitCodeFor,
  runReprovisionSweep,
  TAG,
} from './reprovision-portal-report-definitions.lib';

async function listReportEnabledOrgs(): Promise<string[]> {
  const rows = await db
    .select({ orgId: portalBranding.orgId })
    .from(portalBranding)
    .where(eq(portalBranding.enableReports, true));

  return rows.map((row) => row.orgId);
}

// The simple half — "has any deliverable with a resolved auto_evidence_report_id"
// — is sufficient here because apply-time resolution
// (`resolveManagedEvidenceDefinition`, called from `applyTemplateSet` and
// `link-evidence-reports.ts`) always sets the id at the moment a definition is
// provisioned for that org. There is no state where an org has a managed
// definition but every deliverable pointing at it has since gone back to NULL,
// so walking `deliverable_template_items.auto_evidence_report_type` (the
// not-yet-resolved half) would only add orgs that resolve to the same set.
async function listEvidenceLinkedOrgs(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: serviceDeliverables.orgId })
    .from(serviceDeliverables)
    .where(isNotNull(serviceDeliverables.autoEvidenceReportId));

  return rows.map((row) => row.orgId);
}

// provisionPortalReportDefinitions stamps created_by as the principal that owns
// the definition. There is no human behind a maintenance sweep, so reuse a
// creator the org already has.
//
// reports.created_by is NULLABLE (the FK to users is not NOT NULL, so a
// tombstoned author leaves it null). Filter on isNotNull rather than taking an
// arbitrary row and testing it afterwards: without the filter this would draw a
// null-authored row and skip an org that does have a usable creator.
async function existingCreator(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: reports.createdBy })
    .from(reports)
    .where(and(
      eq(reports.orgId, orgId),
      isNotNull(reports.createdBy),
    ))
    .limit(1);

  return row?.createdBy ?? null;
}

async function loadManagedConfig(
  orgId: string,
  type: ManagedEvidenceType,
): Promise<Record<string, unknown> | null> {
  const definition = await loadManagedEvidenceDefinition(orgId, type);
  return definition?.config ?? null;
}

async function updateConfig(
  orgId: string,
  type: ManagedEvidenceType,
  config: Record<string, unknown>,
): Promise<void> {
  await db
    .update(reports)
    .set({ config })
    .where(and(
      eq(reports.orgId, orgId),
      eq(reports.type, type),
      eq(reports.portalSelfService, true),
    ));
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const repair = process.argv.includes('--repair');

  const summary = await withSystemDbAccessContext(
    () => runReprovisionSweep({
      listReportEnabledOrgs,
      listEvidenceLinkedOrgs,
      existingCreator,
      provision: provisionPortalReportDefinitions,
      loadManagedConfig,
      updateConfig,
      log: (message) => console.log(message),
      warn: (message) => console.warn(message),
      error: (message, cause) => console.error(
        message,
        cause instanceof Error ? cause.message : cause,
      ),
    }, { apply, repair }),
    'reprovisionPortalReportDefinitions',
  );

  process.exitCode = exitCodeFor(summary);
}

main()
  .catch((error) => {
    console.error(`${TAG} Failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
