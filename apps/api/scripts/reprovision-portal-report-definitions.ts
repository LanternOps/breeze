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

import { eq } from 'drizzle-orm';
import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { portalBranding, reports } from '../src/db/schema';
import { provisionPortalReportDefinitions } from '../src/services/portal/reportsSelfService';

const TAG = '[reprovision-portal-report-definitions]';

// reports.created_by is NOT NULL, and provisioning stamps it as the principal
// that owns the definition. There is no human behind a maintenance sweep, so
// reuse the org's existing portal definitions' creator when there is one.
async function existingCreator(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: reports.createdBy })
    .from(reports)
    .where(eq(reports.orgId, orgId))
    .limit(1);

  return row?.createdBy ?? null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`${TAG} mode: ${apply ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);

  const summary = { orgs: 0, provisioned: 0, skippedNoCreator: 0, failed: 0 };

  await withSystemDbAccessContext(async () => {
    const orgs = await db
      .select({ orgId: portalBranding.orgId })
      .from(portalBranding)
      .where(eq(portalBranding.enableReports, true));

    summary.orgs = orgs.length;
    console.log(`${TAG} ${orgs.length} org(s) have portal reports enabled`);

    for (const { orgId } of orgs) {
      const createdBy = await existingCreator(orgId);
      if (!createdBy) {
        // No report definition of any kind in this org, so there is no
        // principal to attribute new ones to. Leave it: the next time the MSP
        // touches the flag, the normal path provisions with a real user id.
        summary.skippedNoCreator += 1;
        console.warn(`${TAG} SKIP ${orgId}: no existing report definition to attribute to`);
        continue;
      }

      if (!apply) {
        summary.provisioned += 1;
        console.log(`${TAG} would provision ${orgId} (createdBy ${createdBy})`);
        continue;
      }

      try {
        await provisionPortalReportDefinitions({ orgId, createdBy });
        summary.provisioned += 1;
        console.log(`${TAG} provisioned ${orgId}`);
      } catch (error) {
        // One org's failure must not abort the sweep; the script is
        // re-runnable, so report and continue.
        summary.failed += 1;
        console.error(
          `${TAG} FAILED ${orgId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }, 'reprovisionPortalReportDefinitions');

  console.log(
    `${TAG} done — orgs=${summary.orgs} provisioned=${summary.provisioned}`
    + ` skippedNoCreator=${summary.skippedNoCreator} failed=${summary.failed}`,
  );

  // A partial sweep is a real failure: exit non-zero so an operator running
  // this from a shell or a job notices instead of reading "done" and moving on.
  if (summary.failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`${TAG} Failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
