/**
 * Full-control W16 PR B (#6786, T8): the material of the four-eyes
 * `manage_fleet_designs:apply` and `:rollback` pins. A leaf loaded on demand, so the
 * resolver registrations in effectDigest.ts stay one line and that module does not
 * take the Fleet Design graph. `null` means there is nothing to pin: not a Fleet
 * Design report of the intent's org, or arguments no handler could run.
 */
import { fleetDesignApprovalSchema } from '@breeze/shared';
import type { Database } from '../../db';
import { snapshotFleetDesignApplyTargets, snapshotFleetDesignRollbackTargets } from '../fleetDesign/applyTargets';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A non-uuid id must not reach a query: 22P02 would read as a digest failure. */
export function fleetDesignReportRunIdArg(args: Record<string, unknown>): string | null {
  return typeof args.reportRunId === 'string' && UUID_RE.test(args.reportRunId) ? args.reportRunId : null;
}

export async function fleetDesignApplyDigestMaterial(args: Record<string, unknown>, intentOrgId: string, database: Database) {
  const reportRunId = fleetDesignReportRunIdArg(args);
  const approval = fleetDesignApprovalSchema.safeParse(args.approval);
  if (!reportRunId || !approval.success) return null;
  const targets = await snapshotFleetDesignApplyTargets(reportRunId, intentOrgId, approval.data, database);
  return targets ? { v: 1, reportRunId, ...targets } : null;
}

export async function fleetDesignRollbackDigestMaterial(args: Record<string, unknown>, intentOrgId: string, database: Database) {
  const reportRunId = fleetDesignReportRunIdArg(args);
  if (!reportRunId) return null;
  const targets = await snapshotFleetDesignRollbackTargets(reportRunId, intentOrgId, database);
  return targets ? { v: 1, reportRunId, ...targets } : null;
}
