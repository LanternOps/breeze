import { sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbTransaction, withSystemDbAccessContext } from '../db';
import type { BreakingChangeEntry, BreakingChangesManifest } from './breakingChangesManifest';
import { buildPreflightReport, type DeploymentState, type Milestone, type PreflightReport } from './upgradePreflight';
import { readDeploymentStateWith, type PreflightQuery } from './upgradePreflightRunner';

/**
 * Settings → System → Deprecations (#6605 wave 2): the upgrade preflight's
 * report for the running deployment, shaped for the admin page.
 *
 * The diff itself is `buildPreflightReport`; this module only projects its
 * lists onto one status per manifest entry and reads the deployment state on
 * the request's database connection. It never writes. A read that fails
 * degrades to the broad report, exactly like the boot preflight: the page
 * never says "no issues" when it cannot tell.
 */

/**
 * `crossed` / `possibly_crossed`: this upgrade crossed (or, with no usable
 * history, may have crossed) the entry's `milestone`. `in_effect`: removed at
 * or before a version this deployment already ran. `upcoming`: removal still
 * ahead of this image (the entry may already be deprecated).
 */
export type DeploymentEntryStatus = 'crossed' | 'possibly_crossed' | 'in_effect' | 'upcoming';

export interface DeprecationsViewEntry extends BreakingChangeEntry {
  status: DeploymentEntryStatus;
  /** The milestone the status refers to; null for `upcoming`. */
  milestone: Milestone | null;
}

export interface DeprecationsView {
  currentVersion: string | null;
  rawCurrentVersion: string | null;
  lastRecordedVersion: string | null;
  historyKnown: boolean;
  historyNote: string | null;
  manifestError: string | null;
  ledger: PreflightReport['ledger'];
  /** Recorded versions, newest first. */
  history:
    | { status: 'ok'; versions: Array<{ version: string; firstSeenAt: string }> }
    | { status: 'missing'; reason: string };
  /** Every manifest entry, in manifest order. */
  entries: DeprecationsViewEntry[];
}

function statusFor(report: PreflightReport, entry: BreakingChangeEntry): Pick<DeprecationsViewEntry, 'status' | 'milestone'> {
  const crossing = report.crossing.find((c) => c.entry.id === entry.id);
  if (crossing) {
    return { status: crossing.certainty === 'definite' ? 'crossed' : 'possibly_crossed', milestone: crossing.milestone };
  }
  if (report.inEffect.some((e) => e.entry.id === entry.id)) return { status: 'in_effect', milestone: 'removal' };
  // buildPreflightReport places every remaining entry in `upcoming`.
  return { status: 'upcoming', milestone: null };
}

export function buildDeprecationsView(
  manifest: BreakingChangesManifest,
  state: DeploymentState,
  manifestError: string | null,
): DeprecationsView {
  const report = buildPreflightReport(manifest, state, { manifestError });
  const history: DeprecationsView['history'] = state.history.status === 'ok'
    ? {
        status: 'ok',
        versions: [...state.history.versions]
          .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())
          .map((v) => ({ version: v.version, firstSeenAt: v.firstSeenAt.toISOString() })),
      }
    : state.history;

  return {
    currentVersion: report.currentVersion,
    rawCurrentVersion: report.rawCurrentVersion,
    lastRecordedVersion: report.lastRecordedVersion,
    historyKnown: report.historyKnown,
    historyNote: report.historyNote,
    manifestError: report.manifestError,
    ledger: report.ledger,
    history,
    entries: manifest.entries.map((entry) => ({ ...entry, ...statusFor(report, entry) })),
  };
}

/**
 * Read the deployment state on the request's database connection
 * (`breeze_app`, which holds SELECT on `breeze_version_history`).
 *
 * Each statement runs in its own savepoint (`withDbTransaction`): a failed read
 * (a revoked grant, a missing table) rolls back only that savepoint, so it
 * degrades that half of the report without poisoning the request transaction.
 * No second pool connection is opened while the request transaction is held.
 */
export async function readRequestDeploymentState(currentVersion: string | null | undefined): Promise<DeploymentState> {
  const query: PreflightQuery = async <T extends Record<string, unknown>>(text: string) =>
    (await withDbTransaction(() => db.execute(sql.raw(text)))) as unknown as T[];
  const read = () => readDeploymentStateWith(query, currentVersion);
  return hasDbAccessContext() ? read() : withSystemDbAccessContext(read, 'upgrade-deprecations-report');
}
