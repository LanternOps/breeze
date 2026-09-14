// Orchestration for the reprovision-portal-report-definitions script, split
// out so the unit test can drive the sweep's branching (dry run vs apply,
// skip-on-no-creator, per-org failure isolation, exit-code arithmetic, config
// repair) without importing the CLI, whose top-level main() opens the DB pool
// and sets process.exitCode.
//
// Every I/O dependency is injected. This file performs none of its own.

import {
  MANAGED_EVIDENCE_REGISTRY,
  managedEvidenceEntry,
  type ManagedEvidenceType,
} from '../src/services/managedEvidenceRegistry';

export type ReprovisionSummary = {
  orgs: number;
  provisioned: number;
  skippedNoCreator: number;
  failed: number;
  /** Configs rewritten to the registry default under --repair. */
  repaired: number;
};

export type ReprovisionDeps = {
  /** Org ids whose portal_branding has enable_reports = true. */
  listReportEnabledOrgs: () => Promise<string[]>;
  /** Org ids that have at least one deliverable linked to managed evidence,
   *  independent of the portal-reports flag (#5784 W01 §5.1 item 4). */
  listEvidenceLinkedOrgs: () => Promise<string[]>;
  /** An existing non-null reports.created_by for the org, or null. */
  existingCreator: (orgId: string) => Promise<string | null>;
  provision: (args: { orgId: string; createdBy: string }) => Promise<void>;
  /** The org's stored managed-definition config for a registry type, or null
   *  when no such definition exists yet. */
  loadManagedConfig: (orgId: string, type: ManagedEvidenceType) => Promise<Record<string, unknown> | null>;
  /** Overwrite the org's managed-definition config for a registry type. */
  updateConfig: (orgId: string, type: ManagedEvidenceType, config: Record<string, unknown>) => Promise<void>;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string, cause: unknown) => void;
};

export const TAG = '[reprovision-portal-report-definitions]';

/**
 * The sweep target is the union of two populations, not just the flag: an org
 * that turned portal reports off (or never turned them on) can still have a
 * deliverable linked to managed evidence, and that definition needs the same
 * re-provisioning and repair coverage as a portal-visible one.
 */
export async function selectTargetOrgs(
  deps: Pick<ReprovisionDeps, 'listReportEnabledOrgs' | 'listEvidenceLinkedOrgs'>,
): Promise<string[]> {
  const [reportEnabled, evidenceLinked] = await Promise.all([
    deps.listReportEnabledOrgs(),
    deps.listEvidenceLinkedOrgs(),
  ]);
  return [...new Set([...reportEnabled, ...evidenceLinked])];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ));
  }
  return false;
}

/** A short, human-readable list of the keys that differ, for the log line. */
function diffKeys(stored: Record<string, unknown>, target: Record<string, unknown>): string {
  const keys = new Set([...Object.keys(stored), ...Object.keys(target)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (!deepEqual(stored[key], target[key])) {
      changed.push(`${key}: ${JSON.stringify(stored[key])} -> ${JSON.stringify(target[key])}`);
    }
  }
  return changed.join(', ');
}

/**
 * Rewrite drifted managed-definition configs back to the registry default.
 * Only runs when --repair is passed; only ever WRITES under --apply too — a
 * repair-only dry run (`--repair` without `--apply`) logs what it would change
 * and touches nothing.
 */
async function repairConfigs(
  deps: ReprovisionDeps,
  orgIds: string[],
  opts: { apply: boolean; repair?: boolean },
  summary: ReprovisionSummary,
): Promise<void> {
  if (!opts.repair) return;

  const types = Object.keys(MANAGED_EVIDENCE_REGISTRY) as ManagedEvidenceType[];

  for (const orgId of orgIds) {
    let orgRepairs = 0;

    for (const type of types) {
      try {
        const stored = await deps.loadManagedConfig(orgId, type);
        if (stored === null) continue; // org has no managed definition of this type

        const target = managedEvidenceEntry(type).defaultConfig as Record<string, unknown>;
        if (deepEqual(stored, target)) continue;

        const diff = diffKeys(stored, target);
        if (opts.apply) {
          await deps.updateConfig(orgId, type, { ...target });
          summary.repaired += 1;
          orgRepairs += 1;
          deps.log(`${TAG} repaired ${orgId} ${type} config drift: ${diff}`);
        } else {
          deps.log(`${TAG} would repair ${orgId} ${type} config drift: ${diff}`);
        }
      } catch (cause) {
        // One org/type's repair failure must not abort the sweep; the script
        // is re-runnable, so report and continue — same isolation contract as
        // the provisioning loop above.
        summary.failed += 1;
        deps.error(`${TAG} REPAIR FAILED ${orgId}/${type}:`, cause);
      }
    }

    deps.log(`${TAG} repair summary ${orgId}: ${orgRepairs} config(s) repaired`);
  }
}

export async function runReprovisionSweep(
  deps: ReprovisionDeps,
  opts: { apply: boolean; repair?: boolean },
): Promise<ReprovisionSummary> {
  const summary: ReprovisionSummary = {
    orgs: 0,
    provisioned: 0,
    skippedNoCreator: 0,
    failed: 0,
    repaired: 0,
  };

  deps.log(
    `${TAG} mode: ${opts.apply ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`
    + `${opts.repair ? ' + REPAIR' : ''}`,
  );

  const orgIds = await selectTargetOrgs(deps);
  summary.orgs = orgIds.length;
  deps.log(`${TAG} ${orgIds.length} org(s) in scope (portal reports on OR evidence-linked)`);

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

  await repairConfigs(deps, orgIds, opts, summary);

  deps.log(
    `${TAG} done — orgs=${summary.orgs} provisioned=${summary.provisioned}`
    + ` skippedNoCreator=${summary.skippedNoCreator} failed=${summary.failed} repaired=${summary.repaired}`,
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
