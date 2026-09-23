import semver from 'semver';
import type { BreakingChangeEntry, BreakingChangesManifest } from './breakingChangesManifest';

/**
 * Upgrade preflight (#6605): before `autoMigrate` touches the database, diff
 * what this deployment has run (its recorded version history and applied
 * migrations) against the image's cumulative breaking-change manifest, and
 * tell the operator every retirement the upgrade crosses.
 *
 * This file is the pure half — no I/O — so every branch is unit-testable. The
 * database reads and the boot/CLI wiring live in `upgradePreflightRunner.ts`.
 *
 * Two rules shape everything here:
 * - Report, never refuse. Boot always continues; only the operator-invoked
 *   `--strict` CLI turns a crossing into a non-zero exit.
 * - Missing history widens the report. A deployment that cannot show which
 *   versions it ran is told about every retirement in effect for this image,
 *   never "no issues".
 */

export interface VersionHistoryRow {
  version: string;
  firstSeenAt: Date;
}

export interface DeploymentState {
  /** The image's own version (APP_VERSION), raw. */
  currentVersion: string | null | undefined;
  history:
    | { status: 'ok'; versions: VersionHistoryRow[] }
    | { status: 'missing'; reason: string };
  ledger:
    | { status: 'ok'; appliedCount: number; pendingCount: number }
    | { status: 'missing'; reason: string };
}

export type Milestone = 'deprecation' | 'removal';

export interface Crossing {
  entry: BreakingChangeEntry;
  /** The furthest milestone crossed: a jump over both reports the removal. */
  milestone: Milestone;
  /**
   * `definite`: the recorded history proves this deployment has not yet run a
   * version at or past the milestone. `possible`: history (or this image's own
   * version) is unknown, so it cannot be ruled out.
   */
  certainty: 'definite' | 'possible';
}

export interface PreflightReport {
  /** This image's release version, normalised; null when not a release version. */
  currentVersion: string | null;
  rawCurrentVersion: string | null;
  /** Highest release version this deployment has recorded, normalised. */
  lastRecordedVersion: string | null;
  historyKnown: boolean;
  historyNote: string | null;
  ledger: DeploymentState['ledger'];
  crossing: Crossing[];
  /** Deprecated or announced, with removal still ahead of this image. */
  upcoming: Array<{ entry: BreakingChangeEntry }>;
  /** Removed at or before a version this deployment already ran. */
  inEffect: Array<{ entry: BreakingChangeEntry }>;
  manifestError: string | null;
}

/**
 * `0.2.0` is not a release: it is the `ARG APP_VERSION=0.2.0` default in
 * apps/api/Dockerfile and the fallback in src/version.ts, i.e. what an image
 * built without a version reports. Treating it as real would place a build of
 * current main before every retirement and print "crosses no retirement".
 */
const PLACEHOLDER_VERSIONS: ReadonlySet<string> = new Set(['0.2.0']);

/**
 * Reduce a version string to the release it belongs to. A prerelease maps to
 * its release core: `0.116.0-rc.1` already carries 0.116.0's removals, so it
 * must count as having crossed them. Anything that is not a release version
 * (`release-build-check`, `workspace-local`, the `0.2.0` placeholder) → null.
 */
export function normalizeReleaseVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parsed = semver.parse(raw.trim().replace(/^v/, ''));
  if (!parsed) return null;
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return PLACEHOLDER_VERSIONS.has(core) ? null : core;
}

function highestRecorded(rows: VersionHistoryRow[]): string | null {
  let best: string | null = null;
  for (const row of rows) {
    const v = normalizeReleaseVersion(row.version);
    if (v && (best === null || semver.gt(v, best))) best = v;
  }
  return best;
}

export function buildPreflightReport(
  manifest: BreakingChangesManifest,
  state: DeploymentState,
  options: { manifestError?: string | null } = {},
): PreflightReport {
  const current = normalizeReleaseVersion(state.currentVersion);
  const last = state.history.status === 'ok' ? highestRecorded(state.history.versions) : null;
  const historyKnown = last !== null;
  let historyNote: string | null = null;
  if (state.history.status === 'missing') {
    historyNote = state.history.reason;
  } else if (state.history.versions.length === 0) {
    historyNote = 'the version history is empty';
  } else if (!historyKnown) {
    historyNote = 'the version history holds no release versions';
  }

  const crossing: Crossing[] = [];
  const upcoming: Array<{ entry: BreakingChangeEntry }> = [];
  const inEffect: Array<{ entry: BreakingChangeEntry }> = [];

  for (const entry of manifest.entries) {
    if (current === null) {
      // This image cannot place itself on the timeline: everything may apply.
      crossing.push({ entry, milestone: entry.removedIn ? 'removal' : 'deprecation', certainty: 'possible' });
      continue;
    }

    const removedHere = entry.removedIn !== null && semver.lte(entry.removedIn, current);
    const deprecatedHere = semver.lte(entry.deprecatedIn, current);

    if (!removedHere) upcoming.push({ entry });
    if (!deprecatedHere) continue;

    const milestone: Milestone = removedHere ? 'removal' : 'deprecation';
    const milestoneVersion = removedHere ? entry.removedIn! : entry.deprecatedIn;

    if (!historyKnown) {
      crossing.push({ entry, milestone, certainty: 'possible' });
    } else if (semver.gt(milestoneVersion, last)) {
      crossing.push({ entry, milestone, certainty: 'definite' });
    } else if (removedHere) {
      inEffect.push({ entry });
    }
  }

  return {
    currentVersion: current,
    rawCurrentVersion: state.currentVersion ?? null,
    lastRecordedVersion: last,
    historyKnown,
    historyNote,
    ledger: state.ledger,
    crossing,
    upcoming,
    inEffect,
    manifestError: options.manifestError ?? null,
  };
}

/**
 * Exit code for the operator-invoked CLI. Outside strict mode it is always 0:
 * the preflight informs, it never gates. In strict mode, any removal that is or
 * may be crossed — or a manifest this image could not read — is a 1.
 * Deprecations alone never fail: nothing stops working when one is entered.
 */
export function preflightExitCode(report: PreflightReport, options: { strict: boolean }): number {
  if (!options.strict) return 0;
  if (report.manifestError) return 1;
  return report.crossing.some((c) => c.milestone === 'removal') ? 1 : 0;
}

function describeEntry(entry: BreakingChangeEntry, milestone: Milestone): string[] {
  const lines = [`  - ${entry.title} [${entry.id}]`];
  lines.push(
    `      deprecated in ${entry.deprecatedIn}; ` +
      (entry.removedIn ? `removed in ${entry.removedIn}` : `removal not before ${entry.earliestRemovalDate}`),
  );
  for (const surface of entry.surfaces) {
    lines.push(`      ${surface.endpoint}${surface.fields.length ? `: ${surface.fields.join(', ')}` : ''}`);
  }
  lines.push(`      now: ${milestone === 'removal' ? entry.removalBehaviour : entry.deprecationBehaviour}`);
  lines.push(`      replacement: ${entry.replacement}`);
  if (entry.references.length) lines.push(`      see: ${entry.references.join(' ')}`);
  return lines;
}

export function formatPreflightReport(report: PreflightReport): string[] {
  const lines: string[] = [];
  const current = report.currentVersion ?? `unknown (APP_VERSION=${JSON.stringify(report.rawCurrentVersion ?? '')})`;
  const last = report.lastRecordedVersion ?? 'none recorded';
  lines.push(`[upgrade-preflight] Image ${current}; last version this deployment recorded: ${last}.`);

  if (report.manifestError) {
    lines.push(`[upgrade-preflight] WARNING: ${report.manifestError}. Retirements cannot be checked.`);
  }

  if (report.ledger.status === 'ok') {
    lines.push(
      `[upgrade-preflight] Migrations: ${report.ledger.appliedCount} applied, ${report.ledger.pendingCount} pending migration(s) in this image.`,
    );
  } else {
    lines.push(`[upgrade-preflight] Migrations: ledger unavailable (${report.ledger.reason}).`);
  }

  if (report.currentVersion === null) {
    lines.push(
      '[upgrade-preflight] This image does not carry a release version, so every retirement in the manifest is listed.',
    );
  } else if (!report.historyKnown) {
    lines.push(
      `[upgrade-preflight] No version history for this deployment (${report.historyNote ?? 'unknown'}). ` +
        'Every retirement in effect for this image is listed, because the preflight cannot tell which ones this upgrade crosses.',
    );
  }

  if (report.crossing.length === 0) {
    lines.push(
      `[upgrade-preflight] This upgrade crosses no retirement (${report.inEffect.length} already in effect, ${report.upcoming.length} upcoming).`,
    );
  } else {
    const removals = report.crossing.filter((c) => c.milestone === 'removal');
    const deprecations = report.crossing.filter((c) => c.milestone === 'deprecation');
    const range = report.historyKnown && report.currentVersion
      ? ` (${report.lastRecordedVersion} -> ${report.currentVersion})`
      : '';
    if (removals.length) {
      lines.push(
        `[upgrade-preflight] ${removals.length} removal(s) ${report.historyKnown ? 'crossed' : 'possibly crossed'}${range}. ` +
          'Integrations that still use these now get an error:',
      );
      for (const c of removals) lines.push(...describeEntry(c.entry, 'removal'));
    }
    if (deprecations.length) {
      lines.push(
        `[upgrade-preflight] ${deprecations.length} deprecation(s) ${report.historyKnown ? 'entered' : 'possibly entered'}${range}:`,
      );
      for (const c of deprecations) lines.push(...describeEntry(c.entry, 'deprecation'));
    }
  }

  const upcomingOnly = report.upcoming.filter((u) => !report.crossing.some((c) => c.entry.id === u.entry.id));
  if (upcomingOnly.length) {
    lines.push(`[upgrade-preflight] ${upcomingOnly.length} upcoming retirement(s):`);
    for (const u of upcomingOnly) lines.push(...describeEntry(u.entry, 'deprecation'));
  }
  return lines;
}
