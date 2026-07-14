import { describe, expect, it } from 'vitest';
import {
  getS1MetricsSnapshot,
  recordS1ActionDispatch,
  recordS1ActionPollTransition,
  recordS1SyncRun,
  resetS1MetricsForTesting,
} from './metrics';

describe('SentinelOne metrics state', () => {
  it('clears populated snapshots during a test reset', () => {
    recordS1SyncRun('sync-integration', 'success', 25);
    recordS1ActionDispatch('isolate', 'accepted');
    recordS1ActionPollTransition('completed');

    expect(getS1MetricsSnapshot()).toEqual({
      syncRuns: [{ labels: { job: 'sync-integration', outcome: 'success' }, value: 1 }],
      actionDispatches: [{ labels: { action: 'isolate', outcome: 'accepted' }, value: 1 }],
      actionPollTransitions: [{ labels: { status: 'completed' }, value: 1 }],
    });

    resetS1MetricsForTesting();

    expect(getS1MetricsSnapshot()).toEqual({
      syncRuns: [],
      actionDispatches: [],
      actionPollTransitions: [],
    });
  });
});
