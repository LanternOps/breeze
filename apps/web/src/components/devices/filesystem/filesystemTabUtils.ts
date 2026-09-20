/**
 * Pure helpers and wire types for the Disk Cleanup tab (spec §8).
 *
 * Extracted verbatim from the 958-line DeviceFilesystemTab.tsx so they can be
 * unit-tested without jsdom and shared by the panels the tab now composes.
 * Nothing here touches the network, i18next or React — a change that needs any
 * of those belongs in a hook or a component, not in this file.
 */

import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import { formatNumber } from '@/lib/i18n/format';

export type FilesystemSummary = {
  filesScanned?: number;
  dirsScanned?: number;
  bytesScanned?: number;
  maxDepthReached?: number;
  permissionDeniedCount?: number;
};

export type SizedPath = {
  path?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  estimated?: boolean;
};

export type FilesystemSnapshot = {
  id: string;
  capturedAt: string;
  trigger: 'on_demand' | 'threshold';
  partial: boolean;
  reason?: string | null;
  /** Legacy field read off `rawPayload`; W02 adds the first-class `scanPath`. */
  path?: string | null;
  scanPath?: string | null;
  scanMode?: string | null;
  summary: FilesystemSummary;
  cleanupCandidates?: SizedPath[];
  topLargestFiles?: SizedPath[];
  topLargestDirectories?: SizedPath[];
  tempAccumulation?: Array<{ category?: string; bytes?: number }>;
  oldDownloads?: SizedPath[];
  unrotatedLogs?: SizedPath[];
  trashUsage?: SizedPath[];
  duplicateCandidates?: Array<{ key?: string; sizeBytes?: number; count?: number }>;
  errors?: Array<{ path?: string; error?: string }>;
};

export type CleanupCandidate = { path: string; category: string; sizeBytes: number };

export type FilesystemCleanupPreview = {
  cleanupRunId: string | null;
  snapshotId: string;
  scanPath: string;
  estimatedBytes: number;
  candidateCount: number;
  categories: Array<{ category: string; count: number; estimatedBytes: number }>;
  candidates: CleanupCandidate[];
};

/** Per-path outcomes the execute route reports (spec §5.2). */
export type CleanupActionStatus =
  | 'completed'
  | 'failed'
  | 'skipped_locked'
  | 'rejected'
  | 'skipped_budget';

export type CleanupAction = {
  path: string;
  category: string;
  sizeBytes: number;
  status: CleanupActionStatus;
  error?: string;
};

export type CleanupExecuteResult = {
  cleanupRunId: string;
  /** The volume this run acted on (W02 Task 10). */
  scanPath?: string | null;
  status: 'executed' | 'failed';
  bytesReclaimed: number;
  selectedCount: number;
  failedCount: number;
  rejectedPaths: string[];
  /** W01's wall-clock budget stopped the run part-way (W01 Task 9/10). */
  partial: boolean;
  budgetMs: number;
  /** W01 already sends per-status totals; `summariseActionStatuses` stays the
   *  renderer's source so a truncated `actions[]` can never disagree with it. */
  counts?: Record<CleanupActionStatus, number>;
  actions: CleanupAction[];
};

export type CommandRow = {
  id: string;
  type?: string;
  status?: string;
  createdAt?: string;
  payload?: unknown;
};

export type ThresholdEvent = { id: string; status: string; createdAt: string; path: string };

export const CLEANUP_ACTION_STATUSES: readonly CleanupActionStatus[] = [
  'completed',
  'failed',
  'skipped_locked',
  'rejected',
  'skipped_budget',
];

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  if (value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) {
    return `${formatNumber(value / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${formatNumber(value / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  }
  if (value < 1024 * 1024 * 1024 * 1024) {
    return `${formatNumber(value / (1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`;
  }
  return `${formatNumber(value / (1024 * 1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TB`;
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return formatUserDateTime(parsed, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function normalizeHierarchyPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, '/');
  while (normalized.includes('//')) normalized = normalized.replaceAll('//', '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    const isWindowsDriveRoot =
      normalized.length === 3 && normalized[1] === ':' && normalized[2] === '/';
    if (!isWindowsDriveRoot) {
      normalized = normalized.slice(0, -1);
    }
  }
  return normalized.toLowerCase();
}

export function isDescendantPath(path: string, ancestor: string): boolean {
  const normalizedPath = normalizeHierarchyPath(path);
  const normalizedAncestor = normalizeHierarchyPath(ancestor);
  if (!normalizedPath || !normalizedAncestor || normalizedPath === normalizedAncestor) return false;
  if (normalizedAncestor === '/') return normalizedPath.startsWith('/') && normalizedPath !== '/';
  if (
    normalizedAncestor.length === 3 &&
    normalizedAncestor[1] === ':' &&
    normalizedAncestor[2] === '/'
  ) {
    return normalizedPath.startsWith(normalizedAncestor) && normalizedPath !== normalizedAncestor;
  }
  return normalizedPath.startsWith(`${normalizedAncestor}/`);
}

/**
 * Drop a directory whose reported size is essentially one child's size, so the
 * "largest directories" list shows distinct wins rather than one chain. The
 * ratio tightens when the ancestor is an estimate and the child is measured
 * (a measured child can only be a LOWER bound on an estimated parent) and
 * loosens the other way round.
 */
export function collapseAncestorDirectories<T extends SizedPath>(
  directories: T[],
  limit: number,
  descendantRatio = 0.7,
): T[] {
  if (limit <= 0 || directories.length === 0) return [];
  const items = directories
    .filter((item) => typeof item.path === 'string' && item.path.length > 0)
    .slice()
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

  const pruned = new Set<number>();
  for (let i = 0; i < items.length; i += 1) {
    if (pruned.has(i)) continue;
    const ancestorPath = items[i].path ?? '';
    const ancestorBytes = items[i].sizeBytes ?? 0;
    if (!ancestorPath || ancestorBytes <= 0) continue;

    for (let j = 0; j < items.length; j += 1) {
      if (i === j || pruned.has(j)) continue;
      const childPath = items[j].path ?? '';
      const childBytes = items[j].sizeBytes ?? 0;
      if (!childPath || childBytes <= 0) continue;
      if (!isDescendantPath(childPath, ancestorPath)) continue;
      const ancestorEstimated = Boolean(items[i].estimated);
      const childEstimated = Boolean(items[j].estimated);
      let effectiveRatio = descendantRatio;
      if (ancestorEstimated && !childEstimated) {
        effectiveRatio = Math.min(effectiveRatio, 0.45);
      } else if (ancestorEstimated && childEstimated) {
        effectiveRatio = Math.min(effectiveRatio, 0.6);
      } else if (!ancestorEstimated && childEstimated) {
        effectiveRatio = Math.max(effectiveRatio, 0.85);
      }
      if (childBytes >= ancestorBytes * effectiveRatio) {
        pruned.add(i);
        break;
      }
    }
  }

  return items.filter((_, index) => !pruned.has(index)).slice(0, limit);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readThresholdEvents(commands: CommandRow[]): ThresholdEvent[] {
  return commands
    .filter((command) => command.type === 'filesystem_analysis')
    .map((command) => {
      const payload = asRecord(command.payload);
      const trigger = typeof payload?.trigger === 'string' ? payload.trigger : '';
      if (trigger !== 'threshold') return null;
      const path = typeof payload?.path === 'string' ? payload.path : '-';
      return {
        id: command.id,
        status: command.status ?? 'pending',
        createdAt: command.createdAt ?? '',
        path,
      };
    })
    .filter((event): event is ThresholdEvent => event !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8);
}

/**
 * Every bucket is present even at zero. A result panel that only renders the
 * non-zero counts silently hides "3 rejected" behind an absent row, which is
 * exactly the opaque partial execution defect 10 describes.
 */
export function summariseActionStatuses(
  actions: CleanupAction[],
): Record<CleanupActionStatus, number> {
  const counts = {
    completed: 0,
    failed: 0,
    skipped_locked: 0,
    rejected: 0,
    skipped_budget: 0,
  } as Record<CleanupActionStatus, number>;
  for (const action of actions) {
    if (action.status in counts) counts[action.status] += 1;
  }
  return counts;
}

export function selectedBytes(
  candidates: CleanupCandidate[],
  selected: ReadonlySet<string>,
): number {
  return candidates.reduce(
    (sum, candidate) => (selected.has(candidate.path) ? sum + candidate.sizeBytes : sum),
    0,
  );
}
