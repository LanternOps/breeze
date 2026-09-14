#!/usr/bin/env tsx
// One-time re-provisioning for the Hardware Lifecycle portal report (#5719).
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
//   pnpm --filter @breeze/api tsx scripts/reprovision-portal-report-definitions.ts
//   pnpm --filter @breeze/api tsx scripts/reprovision-portal-report-definitions.ts --apply
//
// Defaults to a DRY RUN that only reports what it would do. Pass --apply to
// write. Confirm the run mode with the owner before pointing this at
// production.
//
// Runs under withSystemDbAccessContext: this is a background maintenance
// script that spans every tenant, not a request path.
//
// The sweep's branching lives in reprovision-portal-report-definitions.lib.ts
// so it can be unit tested without opening a pool; this file is the I/O shell.

import { and, eq, isNotNull } from 'drizzle-orm';
import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { portalBranding, reports } from '../src/db/schema';
import { provisionPortalReportDefinitions } from '../src/services/portal/reportsSelfService';
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

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const summary = await withSystemDbAccessContext(
    () => runReprovisionSweep({
      listReportEnabledOrgs,
      existingCreator,
      provision: provisionPortalReportDefinitions,
      log: (message) => console.log(message),
      warn: (message) => console.warn(message),
      error: (message, cause) => console.error(
        message,
        cause instanceof Error ? cause.message : cause,
      ),
    }, { apply }),
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
