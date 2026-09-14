// Orchestration for the reprovision-portal-report-definitions script, split
// out so the unit test can drive the sweep's branching (dry run vs apply,
// skip-on-no-creator, per-org failure isolation, exit-code arithmetic) without
// importing the CLI, whose top-level main() opens the DB pool and sets
// process.exitCode.
//
// Every I/O dependency is injected. This file performs none of its own.

export type ReprovisionSummary = {
  orgs: number;
  provisioned: number;
  skippedNoCreator: number;
  failed: number;
};

export type ReprovisionDeps = {
  /** Org ids whose portal_branding has enable_reports = true. */
  listReportEnabledOrgs: () => Promise<string[]>;
  /** An existing non-null reports.created_by for the org, or null. */
  existingCreator: (orgId: string) => Promise<string | null>;
  provision: (args: { orgId: string; createdBy: string }) => Promise<void>;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, cause: unknown) => void;
};

export const TAG = '[reprovision-portal-report-definitions]';

export async function runReprovisionSweep(
  deps: ReprovisionDeps,
  opts: { apply: boolean },
): Promise<ReprovisionSummary> {
  const summary: ReprovisionSummary = {
    orgs: 0,
    provisioned: 0,
    skippedNoCreator: 0,
    failed: 0,
  };

  deps.log(
    `${TAG} mode: ${opts.apply ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`,
  );

  const orgIds = await deps.listReportEnabledOrgs();
  summary.orgs = orgIds.length;
  deps.log(`${TAG} ${orgIds.length} org(s) have portal reports enabled`);

  for (const orgId of orgIds) {
    const createdBy = await deps.existingCreator(orgId);

    if (!createdBy) {
      // Nothing in this org carries a usable author, so new definitions have
      // no principal to attribute to. Leave it: the next time the MSP touches
      // the flag, the normal path provisions with a real user id.
      summary.skippedNoCreator += 1;
      deps.warn(`${TAG} SKIP ${orgId}: no report definition with a usable creator`);
      continue;
    }

    if (!opts.apply) {
      summary.provisioned += 1;
      deps.log(`${TAG} would provision ${orgId} (createdBy ${createdBy})`);
      continue;
    }

    try {
      await deps.provision({ orgId, createdBy });
      summary.provisioned += 1;
      deps.log(`${TAG} provisioned ${orgId}`);
    } catch (cause) {
      // One org's failure must not abort the sweep; the script is re-runnable,
      // so report and continue.
      summary.failed += 1;
      deps.error(`${TAG} FAILED ${orgId}:`, cause);
    }
  }

  deps.log(
    `${TAG} done — orgs=${summary.orgs} provisioned=${summary.provisioned}`
    + ` skippedNoCreator=${summary.skippedNoCreator} failed=${summary.failed}`,
  );

  return summary;
}

/**
 * A partial sweep is a real failure: the caller exits non-zero so an operator
 * notices instead of reading "done" and moving on. Skips are deliberate and do
 * NOT fail the run.
 */
export function exitCodeFor(summary: ReprovisionSummary): number {
  return summary.failed > 0 ? 1 : 0;
}
