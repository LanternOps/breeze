import { relativeTime } from '../../lib/relativeTime';
import {
  findingSeverityRank,
  findingStatusLabel,
  type FleetFindingSeverity,
  type FleetFindingStatus,
} from './findingActions';

/**
 * State and copy for the findings list screen (#5365) — the screen behind an
 * ACTIVE ISSUES "N open findings" row on Systems.
 *
 * Pure leaf module (no React Native imports) so the reducer is unit-tested in
 * Vitest's node environment; `FindingsListScreen.tsx` is a straight
 * state-to-JSX mapping over it. See `apps/mobile/vitest.config.ts` for why
 * anything worth asserting has to live outside a `.tsx`.
 */

/** The subset of `FleetFindingRow` the list renders. */
export interface FindingListItem {
  id: string;
  title: string;
  status: FleetFindingStatus;
  severity: FleetFindingSeverity;
  deviceCount: number;
  lastSeenAt: string;
}

export interface FindingsListState {
  phase: 'loading' | 'ready' | 'error';
  findings: FindingListItem[];
  /** Server-side total for the filter, which may exceed `findings.length`. */
  total: number;
  refreshing: boolean;
  errorMessage: string | null;
}

export const initialFindingsListState: FindingsListState = {
  phase: 'loading',
  findings: [],
  total: 0,
  refreshing: false,
  errorMessage: null,
};

export type FindingsListEvent =
  | { type: 'load' }
  | { type: 'loaded'; findings: FindingListItem[]; total: number }
  /** A 404 from the findings endpoint — an org with nothing to show, not a fault. */
  | { type: 'empty' }
  | { type: 'failed'; message: string };

function lastSeenMillis(item: FindingListItem): number {
  const t = new Date(item.lastSeenAt).getTime();
  // An unparseable timestamp sorts last within its severity rather than
  // poisoning the comparator with NaN (every comparison against NaN is false,
  // which makes the sort order implementation-defined).
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Worst severity first, then most recently seen, then title. The final tie
 * break is what stops rows swapping places between refreshes.
 */
export function sortFindings(findings: readonly FindingListItem[]): FindingListItem[] {
  return [...findings].sort((a, b) => {
    const bySeverity = findingSeverityRank(b.severity) - findingSeverityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    const byRecency = lastSeenMillis(b) - lastSeenMillis(a);
    if (byRecency !== 0) return byRecency;
    return a.title.localeCompare(b.title);
  });
}

export function findingsListReducer(
  state: FindingsListState,
  event: FindingsListEvent,
): FindingsListState {
  switch (event.type) {
    case 'load':
      // First load shows the skeleton; a reload with rows already on screen
      // keeps them and spins the pull-to-refresh control instead of blanking.
      return state.findings.length > 0
        ? { ...state, refreshing: true, errorMessage: null }
        : { ...state, phase: 'loading', refreshing: false, errorMessage: null };
    case 'loaded':
      return {
        phase: 'ready',
        findings: sortFindings(event.findings),
        total: event.total,
        refreshing: false,
        errorMessage: null,
      };
    case 'empty':
      return { ...initialFindingsListState, phase: 'ready' };
    case 'failed':
      // With rows already on screen a failed refresh is a banner, not a wipe:
      // stale findings beat an empty screen when a tech is mid-triage.
      return state.findings.length > 0
        ? { ...state, refreshing: false, errorMessage: event.message }
        : {
            phase: 'error',
            findings: [],
            total: 0,
            refreshing: false,
            errorMessage: event.message,
          };
    default:
      return state;
  }
}

/** e.g. "Open · 3 devices · 2h ago". Segments with nothing to say are dropped. */
export function findingRowSubtitle(item: FindingListItem): string {
  const segments: string[] = [findingStatusLabel(item.status)];
  if (item.deviceCount > 0) {
    segments.push(`${item.deviceCount} ${item.deviceCount === 1 ? 'device' : 'devices'}`);
  }
  const seen = relativeTime(item.lastSeenAt);
  if (seen) segments.push(seen);
  return segments.join(' · ');
}

export function findingsListEmptyCopy(orgName: string): { title: string; body: string } {
  const who = orgName.trim() || 'This organization';
  return {
    title: 'No open findings',
    body: `${who} has no open or acknowledged findings right now.`,
  };
}

/**
 * Narrows an API finding row to what the list renders. The API row carries a
 * dozen fields this screen never shows (evidence timestamps, dismiss notes,
 * kind); keeping them out of reducer state means a change to the API shape
 * cannot silently change what the list is asserted to hold.
 */
export function toFindingListItem(row: {
  id: string;
  title: string;
  status: FleetFindingStatus;
  severity: FleetFindingSeverity;
  deviceCount: number;
  lastSeenAt: string;
}): FindingListItem {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    severity: row.severity,
    deviceCount: row.deviceCount,
    lastSeenAt: row.lastSeenAt,
  };
}
