// apps/api/src/services/aiAgents/patchEpisode.test.ts
//
// TDD red-first coverage for patchEpisode.ts (AI patch agent W02 Task 2,
// docs/superpowers/plans/ai-mcp/2026-09-13-ai-patch-agent-02-actionable-installs.md).

import { describe, expect, it } from 'vitest';
import {
  PATCH_EPISODE_COMPLETED_COOLDOWN_DAYS,
  PATCH_EPISODE_SUPPRESSION_DAYS,
  type PatchEpisodeHistoryEntry,
  patchEpisodeIdempotencyKey,
  shouldSuppressPatchEpisode,
} from './patchEpisode';

const NOW = new Date('2026-09-14T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function entry(
  status: PatchEpisodeHistoryEntry['status'],
  createdDaysAgo: number,
  decidedDaysAgo: number | null = createdDaysAgo,
): PatchEpisodeHistoryEntry {
  return {
    status,
    createdAt: daysAgo(createdDaysAgo),
    decidedAt: decidedDaysAgo === null ? null : daysAgo(decidedDaysAgo),
  };
}

describe('patchEpisodeIdempotencyKey', () => {
  it('produces the stable problem-scoped literal key', () => {
    expect(patchEpisodeIdempotencyKey('o', 'd', 'p')).toBe('patch:o:d:p');
  });
});

describe('shouldSuppressPatchEpisode', () => {
  it('suppresses for each live status regardless of age', () => {
    for (const status of ['pending_approval', 'approved', 'executing'] as const) {
      const result = shouldSuppressPatchEpisode([entry(status, 100, null)], NOW);
      expect(result).toEqual({ suppress: true, reason: 'live_intent_exists' });
    }
  });

  it('suppresses a rejection just under the 14-day boundary', () => {
    const result = shouldSuppressPatchEpisode([entry('rejected', 13.9)], NOW);
    expect(result).toEqual({ suppress: true, reason: 'recently_rejected' });
  });

  it('does not suppress a rejection at or after the 14-day boundary', () => {
    const atBoundary = shouldSuppressPatchEpisode([entry('rejected', 14.0)], NOW);
    expect(atBoundary).toEqual({ suppress: false });

    const pastBoundary = shouldSuppressPatchEpisode([entry('rejected', 20)], NOW);
    expect(pastBoundary).toEqual({ suppress: false });
  });

  it('suppresses a cancellation just under the 14-day boundary, not at/after it', () => {
    const within = shouldSuppressPatchEpisode([entry('cancelled', 13.9)], NOW);
    expect(within).toEqual({ suppress: true, reason: 'recently_cancelled' });

    const atBoundary = shouldSuppressPatchEpisode([entry('cancelled', 14.0)], NOW);
    expect(atBoundary).toEqual({ suppress: false });
  });

  it('suppresses a completion just under the 7-day boundary, not at/after it', () => {
    const within = shouldSuppressPatchEpisode([entry('completed', 6.9)], NOW);
    expect(within).toEqual({ suppress: true, reason: 'recently_completed' });

    const atBoundary = shouldSuppressPatchEpisode([entry('completed', 7.0)], NOW);
    expect(atBoundary).toEqual({ suppress: false });
  });

  it('never suppresses on an expired card — nobody decided, the problem is still real', () => {
    const result = shouldSuppressPatchEpisode([entry('expired', 0.1)], NOW);
    expect(result).toEqual({ suppress: false });
  });

  it('never suppresses on a failed install — must be re-proposable for W03 chase', () => {
    const result = shouldSuppressPatchEpisode([entry('failed', 0.1)], NOW);
    expect(result).toEqual({ suppress: false });
  });

  it('takes the most recent decision when history has several entries, regardless of array order', () => {
    const oldRejectedThenRecentCompleted = shouldSuppressPatchEpisode(
      [entry('rejected', 20), entry('completed', 1)],
      NOW,
    );
    expect(oldRejectedThenRecentCompleted).toEqual({ suppress: true, reason: 'recently_completed' });

    // Reversed array order must give the same answer — the function sorts,
    // it does not trust caller ordering.
    const reversedOrder = shouldSuppressPatchEpisode(
      [entry('completed', 1), entry('rejected', 20)],
      NOW,
    );
    expect(reversedOrder).toEqual({ suppress: true, reason: 'recently_completed' });

    const recentExpiredAfterOlderRejection = shouldSuppressPatchEpisode(
      [entry('rejected', 3), entry('expired', 1)],
      NOW,
    );
    expect(recentExpiredAfterOlderRejection).toEqual({ suppress: false });
  });

  it('uses decidedAt when present, else falls back to createdAt', () => {
    // decidedAt 20 days ago (outside window) even though createdAt is recent
    // (1 day ago) — decidedAt must win, so this is NOT suppressed.
    const decidedLongAgo = shouldSuppressPatchEpisode(
      [entry('rejected', 1, 20)],
      NOW,
    );
    expect(decidedLongAgo).toEqual({ suppress: false });

    // No decidedAt at all — falls back to createdAt (1 day ago, inside the
    // 14-day rejection window) so it IS suppressed.
    const fallsBackToCreatedAt = shouldSuppressPatchEpisode(
      [entry('rejected', 1, null)],
      NOW,
    );
    expect(fallsBackToCreatedAt).toEqual({ suppress: true, reason: 'recently_rejected' });
  });

  it('does not suppress on empty history', () => {
    expect(shouldSuppressPatchEpisode([], NOW)).toEqual({ suppress: false });
  });

  it('exposes the documented suppression windows as named constants', () => {
    expect(PATCH_EPISODE_SUPPRESSION_DAYS).toBe(14);
    expect(PATCH_EPISODE_COMPLETED_COOLDOWN_DAYS).toBe(7);
  });
});
