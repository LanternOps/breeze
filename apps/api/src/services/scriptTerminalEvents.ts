import { runAfterDbContextCommit } from '../db';
import { publishEvent, EVENT_TYPES, type EventType } from './eventBus';
import { captureException } from './sentry';

/**
 * Public `script.completed` / `script.failed` events (#7277).
 *
 * Emitted by the two paths that drive a `script_executions` row terminal —
 * `handleScriptResult` (agent result) and `finalizeScriptExecutionTerminal`
 * (reaper / timeout propagation) — and ONLY by the writer that won the
 * pending|queued|running → terminal compare-and-swap, so one execution emits at
 * most once. The #3607 late-result recovery and #3525 late-output paths re-fill
 * an already-terminal row and deliberately do not emit.
 *
 * Mapping: completed → script.completed; failed | timeout → script.failed;
 * cancelled → NO event. An operator stop is not a failure (the #3525 honesty
 * rule), and no `script.cancelled` type exists to carry it.
 *
 * AFTER COMMIT. Both callers run inside the request/heartbeat transaction.
 * Publishing inside it would let a subscriber (automation fan-out, webhook)
 * read the pre-commit row, and a rollback would leave an event for a state that
 * never existed. `runAfterDbContextCommit` drops the event on rollback.
 *
 * The payload is ids + outcome only. Stdout/stderr are deliberately excluded:
 * webhooks ship event payloads to third-party URLs.
 *
 * Loop guard: `automationRunId` identifies the automation run that queued the
 * execution; the automation fan-out uses it (see `isScriptEventLoop` in
 * jobs/automationWorker.ts) so "on script completed → run script" cannot
 * trigger itself.
 */

export type ScriptTerminalEventStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface ScriptTerminalEventInput {
  executionId: string;
  orgId: string;
  deviceId: string;
  scriptId: string | null;
  triggerType: string;
  /** The automation run that queued this execution, when it was automation-triggered. */
  automationRunId: string | null;
  exitCode: number | null;
  status: ScriptTerminalEventStatus;
}

export function scriptEventTypeForStatus(status: ScriptTerminalEventStatus): EventType | null {
  switch (status) {
    case 'completed': return EVENT_TYPES.SCRIPT_COMPLETED;
    case 'failed':
    case 'timeout': return EVENT_TYPES.SCRIPT_FAILED;
    case 'cancelled': return null;
  }
}

/** Queues the event for after the surrounding transaction commits. Never throws. */
export function emitScriptTerminalEvent(input: ScriptTerminalEventInput): void {
  try {
    const type = scriptEventTypeForStatus(input.status);
    if (!type) return;
    const payload = {
      executionId: input.executionId,
      scriptId: input.scriptId,
      deviceId: input.deviceId,
      status: input.status,
      exitCode: input.exitCode,
      triggerType: input.triggerType,
      automationRunId: input.automationRunId,
    };
    runAfterDbContextCommit(`scriptTerminalEvents.${type}`, async () => {
      try {
        await publishEvent(type, input.orgId, payload, 'script-execution');
      } catch (err) {
        console.error(`[ScriptEvents] Failed to publish ${type} for execution ${input.executionId}:`, err);
        captureException(err, undefined, { area: 'script_terminal_event', executionId: input.executionId });
      }
    });
  } catch (err) {
    // Result ingestion is the durable record; an event must never fail it.
    console.error(`[ScriptEvents] Failed to queue terminal event for execution ${input.executionId}:`, err);
    captureException(err, undefined, { area: 'script_terminal_event', executionId: input.executionId });
  }
}
