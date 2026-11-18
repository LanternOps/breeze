import { readInstallFailure } from '../patches/patchHelpers';

// ---------------------------------------------------------------------------
// Post-install polling for the device Patches tab (#10250).
//
// A per-device install is fire-and-forget: the API queues an `install_patches`
// command, the agent installs, reports the command result, and then rescans
// so `device_patches` catches up. The tab polls until it can say what
// happened to the patches it asked for. A targeted patch is resolved when it:
//   - leaves the pending list (the rescan saw it installed or no longer offered), or
//   - gains a NEW install failure or awaiting-restart marker (both come from the
//     command result itself, so they show up before any rescan).
// Watching only the pending count was the bug: a failed, skipped or
// reboot-pending install never shrinks it, so the tab spun for 30 minutes.
// ---------------------------------------------------------------------------

export const INSTALL_POLL_INTERVAL_MS = 5_000;
// macOS softwareupdate installs can take 30+ minutes, and the command stays
// non-terminal for that whole time, so this cap is only the outer bound.
export const INSTALL_POLL_MAX_DURATION_MS = 1_800_000;
// Once the command has finished (or a targeted patch reports an outcome), how
// long to keep waiting for the agent's post-install rescan to clear the rest.
// Covers the agent's settle delay (60 s on macOS, 5 s elsewhere) plus a scan.
export const INSTALL_POLL_SETTLE_MS = 180_000;

const TERMINAL_COMMAND_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout', 'expired']);
// The device never ran (or never finished) the install, so no outcome and no
// rescan is coming — there is nothing left to wait for.
const ABANDONED_COMMAND_STATUSES = new Set(['cancelled', 'timeout', 'expired']);

export function isTerminalCommandStatus(status: string | null | undefined): status is string {
  return typeof status === 'string' && TERMINAL_COMMAND_STATUSES.has(status);
}

export function readAwaitingRestart(value: unknown): { installedAt: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const installedAt = (value as Record<string, unknown>).installedAt;
  return typeof installedAt === 'string' ? { installedAt } : undefined;
}

/** The fields of a pending patch row the poller reads. */
export type InstallPollPatch = {
  id?: string;
  installFailure?: unknown;
  awaitingRestart?: unknown;
};

function outcomeKey(patch: InstallPollPatch): string {
  const failedAt = readInstallFailure(patch.installFailure)?.failedAt ?? '';
  const restartAt = readAwaitingRestart(patch.awaitingRestart)?.installedAt ?? '';
  return `${failedAt}|${restartAt}`;
}

/**
 * The failure / restart markers each targeted patch carried when the install
 * was queued, so a marker left over from an earlier attempt is not mistaken
 * for this attempt's outcome. Compared by value, so no browser/server clock
 * comparison is involved.
 */
export function snapshotInstallOutcomes(
  pending: readonly InstallPollPatch[],
  patchIds: readonly string[],
): Map<string, string> {
  const targeted = new Set(patchIds);
  const baseline = new Map<string, string>();
  for (const patch of pending) {
    if (patch.id && targeted.has(patch.id)) baseline.set(patch.id, outcomeKey(patch));
  }
  return baseline;
}

export type InstallPollState = {
  startedAt: number;
  patchIds: readonly string[];
  baseline: ReadonlyMap<string, string>;
  /** When the settle window opened (command terminal or first outcome); null until then. */
  settleFrom: number | null;
};

export type InstallPollObservation = {
  now: number;
  pending: readonly InstallPollPatch[];
  /** Latest `install_patches` command status, or null when unknown / not fetched. */
  commandStatus: string | null;
};

export type InstallPollSummary = {
  /** Targeted patches no longer pending. */
  installed: number;
  /** Targeted patches with a new install failure. */
  failed: number;
  /** Targeted patches installed but waiting for a restart. */
  awaitingRestart: number;
  /** Targeted patches still pending with no outcome when polling stopped. */
  unresolved: number;
  /** Everything still pending on the device. */
  pending: number;
};

export type InstallPollDecision =
  | { kind: 'continue'; settleFrom: number | null }
  | { kind: 'done'; summary: InstallPollSummary }
  | { kind: 'command_ended'; status: string }
  | { kind: 'timed_out' };

export function summarizeInstallPoll(
  state: Pick<InstallPollState, 'patchIds' | 'baseline'>,
  pending: readonly InstallPollPatch[],
): InstallPollSummary {
  const pendingById = new Map<string, InstallPollPatch>();
  for (const patch of pending) {
    if (patch.id) pendingById.set(patch.id, patch);
  }
  const summary: InstallPollSummary = { installed: 0, failed: 0, awaitingRestart: 0, unresolved: 0, pending: pending.length };
  for (const patchId of new Set(state.patchIds)) {
    const patch = pendingById.get(patchId);
    if (!patch) {
      summary.installed++;
      continue;
    }
    const key = outcomeKey(patch);
    if (key === (state.baseline.get(patchId) ?? '|')) {
      summary.unresolved++;
    } else if (readInstallFailure(patch.installFailure)) {
      summary.failed++;
    } else if (readAwaitingRestart(patch.awaitingRestart)) {
      summary.awaitingRestart++;
    } else {
      // A marker was cleared (e.g. a retry of a previously failed patch
      // succeeded) but the rescan has not dropped the row yet.
      summary.unresolved++;
    }
  }
  return summary;
}

/** One poll tick: decide whether to keep polling and, if not, what to report. */
export function decideInstallPoll(state: InstallPollState, observation: InstallPollObservation): InstallPollDecision {
  const { now, pending, commandStatus } = observation;
  const summary = summarizeInstallPoll(state, pending);

  if (summary.unresolved === 0) return { kind: 'done', summary };

  if (commandStatus && ABANDONED_COMMAND_STATUSES.has(commandStatus)) {
    return { kind: 'command_ended', status: commandStatus };
  }

  let settleFrom = state.settleFrom;
  if (settleFrom === null && (isTerminalCommandStatus(commandStatus) || summary.failed + summary.awaitingRestart > 0)) {
    settleFrom = now;
  }
  if (settleFrom !== null && now - settleFrom >= INSTALL_POLL_SETTLE_MS) {
    return { kind: 'done', summary };
  }

  if (now - state.startedAt >= INSTALL_POLL_MAX_DURATION_MS) return { kind: 'timed_out' };

  return { kind: 'continue', settleFrom };
}
