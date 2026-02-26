type S1SyncJob = 'sync-integration' | 'sync-all-agents' | 'sync-all-threats' | 'poll-actions';
type S1SyncOutcome = 'success' | 'failure';
type S1DispatchOutcome = 'accepted' | 'untracked' | 'failed';
type S1PollStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

interface CounterValue {
  labels: Record<string, string>;
  value: number;
}

interface S1MetricsRecorder {
  onSyncRun?: (job: S1SyncJob, outcome: S1SyncOutcome, durationMs: number) => void;
  onActionDispatch?: (action: string, outcome: S1DispatchOutcome) => void;
  onActionPollTransition?: (status: S1PollStatus) => void;
}

const s1SyncRunState = new Map<string, CounterValue>();
const s1ActionDispatchState = new Map<string, CounterValue>();
const s1ActionPollTransitionState = new Map<string, CounterValue>();
let recorder: S1MetricsRecorder | null = null;

function upsertCounterState(state: Map<string, CounterValue>, labels: Record<string, string>, amount = 1): void {
  const key = JSON.stringify(labels);
  const existing = state.get(key);
  if (existing) {
    existing.value += amount;
    return;
  }

  state.set(key, {
    labels,
    value: amount
  });
}

export function setS1MetricsRecorder(next: S1MetricsRecorder | null): void {
  recorder = next;
}

export function recordS1SyncRun(
  job: S1SyncJob,
  outcome: S1SyncOutcome,
  durationMs: number
): void {
  const safeDuration = Number.isFinite(durationMs) ? Math.max(durationMs, 0) : 0;
  upsertCounterState(s1SyncRunState, { job, outcome });
  recorder?.onSyncRun?.(job, outcome, safeDuration);
}

export function recordS1ActionDispatch(action: string, outcome: S1DispatchOutcome): void {
  const normalizedAction = action.trim().toLowerCase() || 'unknown';
  upsertCounterState(s1ActionDispatchState, { action: normalizedAction, outcome });
  recorder?.onActionDispatch?.(normalizedAction, outcome);
}

export function recordS1ActionPollTransition(status: S1PollStatus): void {
  upsertCounterState(s1ActionPollTransitionState, { status });
  recorder?.onActionPollTransition?.(status);
}

export function getS1MetricsSnapshot(): {
  syncRuns: CounterValue[];
  actionDispatches: CounterValue[];
  actionPollTransitions: CounterValue[];
} {
  return {
    syncRuns: Array.from(s1SyncRunState.values()),
    actionDispatches: Array.from(s1ActionDispatchState.values()),
    actionPollTransitions: Array.from(s1ActionPollTransitionState.values())
  };
}
