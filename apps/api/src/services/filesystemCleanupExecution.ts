/**
 * Disk-cleanup execution (spec §5.2).
 *
 * This lives outside the route for three reasons: the route is already at the
 * file-size guideline, the loop needs to be testable without a Hono context or
 * a device, and the AI lane will call the same function so the two lanes
 * cannot drift in what they dispatch.
 *
 * The contract, in one place:
 *   - Nothing is deleted that was not previewed. A requested path outside the
 *     pinned candidate set is `rejected`, reported, and never dispatched.
 *   - Rules are enforced TWICE (§10.2). Here, against the shared rule table, so
 *     a stale snapshot captured before W01 (Chrome Bookmarks, UWP LocalState)
 *     cannot be executed; and again on the device under `cleanupGuard`.
 *   - Cleanup deletes are PERMANENT by construction (§10.3). Without
 *     `permanent: true` the agent MOVES the file to ~/.breeze-trash on the same
 *     volume, freeing nothing — and across volumes it falls back to copy+remove,
 *     so cleaning D:\ grew C:\ (defect 1).
 *   - `contentsOnly` comes from the matched rule's granularity, never from a
 *     field on the candidate, so an old agent's snapshot still yields the right
 *     flag for a recycle bin.
 */
import {
  CLEANUP_GUARD_REJECTED_PREFIX,
  classifyCleanupPath,
  isCleanupDeniedRoot,
  type CleanupGranularity,
  type CleanupOs,
} from '@breeze/shared';
import { compareAgentVersions, parseComparableVersion } from './agentEditionCompat';
import type { FilesystemCleanupCandidate } from './filesystemAnalysis';

/**
 * Wall-clock ceiling for one cleanup-execute request. Deletes are SEQUENTIAL
 * and each command carries a 30s timeout, so 200 candidates is a 100-minute
 * worst case on a request thread holding a database context. Paths not reached
 * are reported `skipped_budget` and the run is recorded `executed` with
 * `partial: true` — the operator re-runs rather than waiting (spec §5.2).
 */
export const CLEANUP_EXECUTE_BUDGET_MS = 240_000;

export type CleanupActionStatus =
  | 'completed'
  | 'partial'
  | 'failed'
  | 'skipped_locked'
  | 'rejected'
  | 'skipped_budget';

/**
 * The agent release that introduced `cleanupGuard` (spec §13 row 3).
 *
 * An agent WITHOUT the guard that is handed `permanent: true` performs an
 * unguarded recursive permanent delete of whatever path it is given — strictly
 * worse than today's trash-move, which is why spec §3's "cosmetic degradation"
 * paragraph is withdrawn. Both cleanup lanes refuse older agents with
 * `409 agent_update_required`.
 *
 * W01 ships in the release after v0.114.0. If the wave lands in a different
 * release, bump this AND its test in the same PR.
 */
export const MIN_AGENT_VERSION_CLEANUP_GUARD = '0.115.0';

/**
 * Fail-CLOSED version gate. `compareAgentVersions` returns 0 for an unparseable
 * input (agentEditionCompat.ts:48-51), so a naive `compare(...) < 0` would fail
 * OPEN on an empty or malformed `devices.agent_version` and hand an unknown
 * build a permanent recursive delete. Parse first; compare CORE only, so an RC
 * of the gate release (`0.115.0-rc1`) counts as carrying the guard.
 */
export function agentSupportsCleanupGuard(agentVersion: string | null | undefined): boolean {
  if (!agentVersion) return false;
  const parsed = parseComparableVersion(agentVersion);
  if (!parsed) return false;
  return compareAgentVersions(parsed.core.join('.'), MIN_AGENT_VERSION_CLEANUP_GUARD) >= 0;
}

/**
 * The volume the agent must confine the rule anchor to. On Windows that is the
 * candidate's own drive root, which stops a junction at the anchor relocating
 * the whole operation onto another volume; on POSIX W01 uses `/` and W02
 * narrows it to the scanned volume once `scan_path` exists.
 */
export function cleanupVolumeRoot(os: CleanupOs, path: string): string {
  if (os !== 'windows') return '/';
  const drive = /^([a-zA-Z]:)/.exec(path.trim());
  return drive ? `${drive[1]}\\` : '\\';
}

export type CleanupRejectionReason = 'not_in_plan' | 'rule_rejected' | 'denied_root' | 'agent_guard';

export interface CleanupExecutionAction {
  path: string;
  category: string;
  sizeBytes: number;
  status: CleanupActionStatus;
  /**
   * LOGICAL bytes: the agent's own sum of `Lstat` sizes. Sparse files,
   * compression, dedup and cluster slack all make the real free-space delta
   * differ, and the pre-W01 `file_delete` result carried no byte count at all.
   * The measured figure arrives with the native cleaners in W04.
   */
  bytesFreed: number;
  skippedLockedCount: number;
  skippedLinkCount: number;
  /** Children held back because they changed after the preview. */
  skippedRecentCount: number;
  /** Children a `contentsOnly` delete could not remove; capped for the row. */
  failedChildren: string[];
  reason?: CleanupRejectionReason;
  error?: string;
}

export interface FileDeleteDispatchResult {
  status: 'completed' | 'failed' | 'timeout';
  stdout?: string;
  error?: string;
}

export interface ParsedFileDeleteResult {
  deleted: boolean;
  bytesFreed: number;
  skippedLocked: string[];
  skippedLinks: string[];
  /**
   * Children the agent left alone because their mtime is newer than the
   * preview. The contentsOnly CONTAINER is exempt from that check (a bin's
   * mtime bumps on every add), so this is where the freshness refusals land.
   */
  skippedRecent: string[];
  failedChildren: string[];
}

export interface CleanupExecutionOutcome {
  actions: CleanupExecutionAction[];
  rejectedPaths: string[];
  bytesReclaimed: number;
  partial: boolean;
  budgetMs: number;
}

export function buildFileDeletePayload(params: {
  path: string;
  granularity: CleanupGranularity;
  volumeRoot: string;
  previewedAt: string;
}): Record<string, unknown> {
  const contentsOnly = params.granularity === 'contents';
  return {
    path: params.path,
    // §13 row 2: only a contents rule deletes a subtree. A file-granularity
    // candidate that has become a directory since the preview must be refused,
    // not recursed into — which is why `recursive` tracks granularity.
    recursive: contentsOnly,
    permanent: true,
    cleanupGuard: true,
    contentsOnly,
    volumeRoot: params.volumeRoot,
    previewedAt: params.previewedAt,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Returns null for an OLD agent, whose success body is `{path, deleted,
 * permanent}` with no `bytesFreed`, or an unparseable body. The caller retains
 * the snapshot-size fallback for such results; callers must gate dispatch with
 * `agentSupportsCleanupGuard` so an old agent never receives a permanent delete.
 */
export function parseFileDeleteResult(stdout: string | undefined): ParsedFileDeleteResult | null {
  if (!stdout) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.bytesFreed !== 'number' || !Number.isFinite(body.bytesFreed)) return null;
  return {
    deleted: body.deleted === true,
    bytesFreed: Math.max(0, body.bytesFreed),
    skippedLocked: asStringArray(body.skippedLocked),
    skippedLinks: asStringArray(body.skippedLinks),
    skippedRecent: asStringArray(body.skippedRecent),
    failedChildren: asStringArray(body.failedChildren),
  };
}

export function mapFileDeleteStatus(
  dispatch: FileDeleteDispatchResult,
  parsed: ParsedFileDeleteResult | null,
): CleanupActionStatus {
  if (dispatch.status !== 'completed') {
    // CommandResult.status has no `rejected` member, so the agent's cleanupGuard
    // rides a pinned error prefix (spec §5.2, shared constant).
    return (dispatch.error ?? '').startsWith(CLEANUP_GUARD_REJECTED_PREFIX) ? 'rejected' : 'failed';
  }
  if (!parsed) return 'completed';
  if (parsed.failedChildren.length > 0) {
    // §13 row 13: "emptied most of the bin, three children failed" must never
    // read as a clean success. Only a run that freed nothing at all is `failed`.
    return parsed.bytesFreed === 0 && parsed.skippedLocked.length === 0 ? 'failed' : 'partial';
  }
  // A child kept back as changed-since-preview means the bin is not empty and
  // the operator approved something that no longer matches what is on disk.
  if (parsed.skippedRecent.length > 0) return 'partial';
  if (parsed.bytesFreed === 0 && parsed.skippedLocked.length > 0) return 'skipped_locked';
  return 'completed';
}

type Rejection = { reason: CleanupRejectionReason };

function screen(
  os: CleanupOs | null,
  candidate: FilesystemCleanupCandidate,
): Rejection | { granularity: CleanupGranularity } {
  // A device whose os_type does not map to a rule grammar cannot be screened,
  // and an unscreenable delete is not a delete we make.
  if (!os) return { reason: 'rule_rejected' };
  if (isCleanupDeniedRoot(os, candidate.path)) return { reason: 'denied_root' };
  const classification = classifyCleanupPath(os, candidate.path, { modifiedAt: candidate.modifiedAt ?? null });
  if (!classification.category || !classification.granularity) return { reason: 'rule_rejected' };
  return { granularity: classification.granularity };
}

export async function runCleanupExecution(params: {
  os: CleanupOs | null;
  requestedPaths: string[];
  candidates: FilesystemCleanupCandidate[];
  /**
   * When the operator looked at this plan — the pinned run's `requestedAt`, or
   * the snapshot's `capturedAt` on the unpinned fallback. The agent refuses a
   * target whose mtime is newer than it (spec §13 row 2).
   */
  previewedAt: Date;
  dispatch: (path: string, payload: Record<string, unknown>) => Promise<FileDeleteDispatchResult>;
  budgetMs?: number;
  /** Injected clock, so the budget is testable without real time. */
  now?: () => number;
}): Promise<CleanupExecutionOutcome> {
  const budgetMs = params.budgetMs ?? CLEANUP_EXECUTE_BUDGET_MS;
  const now = params.now ?? (() => Date.now());
  const startedAt = now();

  const byPath = new Map(params.candidates.map((candidate) => [candidate.path, candidate]));
  const requested = Array.from(new Set(params.requestedPaths));

  const actions: CleanupExecutionAction[] = [];
  let bytesReclaimed = 0;
  let budgetSpent = false;

  for (const path of requested) {
    const candidate = byPath.get(path);
    if (!candidate) {
      actions.push({
        path,
        category: 'unknown',
        sizeBytes: 0,
        status: 'rejected',
        reason: 'not_in_plan',
        bytesFreed: 0,
        skippedLockedCount: 0,
        skippedLinkCount: 0,
        skippedRecentCount: 0,
        failedChildren: [],
      });
      continue;
    }

    const screened = screen(params.os, candidate);
    if ('reason' in screened) {
      actions.push({
        path,
        category: candidate.category,
        sizeBytes: candidate.sizeBytes,
        status: 'rejected',
        reason: screened.reason,
        bytesFreed: 0,
        skippedLockedCount: 0,
        skippedLinkCount: 0,
        skippedRecentCount: 0,
        failedChildren: [],
      });
      continue;
    }

    // Screening happens BEFORE the budget check so a rejection is reported even
    // for a path the budget would otherwise have skipped: "we refused this" and
    // "we ran out of time" are different answers and the operator needs both.
    if (budgetSpent || now() - startedAt >= budgetMs) {
      budgetSpent = true;
      actions.push({
        path,
        category: candidate.category,
        sizeBytes: candidate.sizeBytes,
        status: 'skipped_budget',
        bytesFreed: 0,
        skippedLockedCount: 0,
        skippedLinkCount: 0,
        skippedRecentCount: 0,
        failedChildren: [],
      });
      continue;
    }

    const result = await params.dispatch(path, buildFileDeletePayload({
      path,
      granularity: screened.granularity,
      // `screen` already refused a null os, so this narrowing is total.
      volumeRoot: cleanupVolumeRoot(params.os as CleanupOs, path),
      previewedAt: params.previewedAt.toISOString(),
    }));
    const parsed = parseFileDeleteResult(result.stdout);
    const status = mapFileDeleteStatus(result, parsed);
    const bytesFreed = parsed
      ? parsed.bytesFreed
      : status === 'completed'
        ? candidate.sizeBytes
        : 0;
    if (status === 'completed' || status === 'partial' || status === 'skipped_locked') {
      bytesReclaimed += bytesFreed;
    }
    actions.push({
      path,
      category: candidate.category,
      sizeBytes: candidate.sizeBytes,
      status,
      reason: status === 'rejected' ? 'agent_guard' : undefined,
      bytesFreed,
      skippedLockedCount: parsed?.skippedLocked.length ?? 0,
      skippedLinkCount: parsed?.skippedLinks.length ?? 0,
      skippedRecentCount: parsed?.skippedRecent.length ?? 0,
      failedChildren: (parsed?.failedChildren ?? []).slice(0, 20),
      error: result.error ?? undefined,
    });
  }

  return {
    actions,
    rejectedPaths: actions.filter((action) => action.status === 'rejected').map((action) => action.path),
    bytesReclaimed,
    partial: actions.some((action) => action.status === 'skipped_budget'),
    budgetMs,
  };
}
