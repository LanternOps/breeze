import type { ActionPlanStep, AiAttachState, AiStreamEvent } from '@breeze/shared/types/ai';
import { AsyncEventQueue } from '../utils/asyncQueue';

type AiTurnModel = NonNullable<AiAttachState['turnModel']>;

// ============================================
// SessionEventBus
// ============================================

/**
 * Gate B #3 (#9427): the most an attach replay may hold for one turn, in UTF-8
 * bytes of the serialized (screenshot-stripped) events. Past it the replay is
 * dropped and an attaching client is told the snapshot is `partial`.
 */
export const ATTACH_REPLAY_MAX_BYTES = 256 * 1024;

/** `imageBase64` of a `plan_screenshot` as held in the replay buffer. */
export const SCREENSHOT_REPLAY_PLACEHOLDER = '';

export interface SequencedEvent {
  seq: number;
  event: AiStreamEvent;
}

export interface SessionEventBusSnapshot {
  /** Highest seq published so far (0 when none). */
  lastSeq: number;
  /**
   * Every event up to `lastSeq` (screenshots with `imageBase64` emptied);
   * `[]` when `partial`.
   */
  replay: AiStreamEvent[];
  partial: boolean;
  /**
   * `done` has been published. The processor-exit path publishes `done` and
   * only then (across awaits) moves the session out of `processing`, so the
   * session state alone cannot say the turn is over.
   */
  sawDone: boolean;
  activePlan: AiAttachState['activePlan'];
  turnModel: AiTurnModel | null;
}

type Subscriber =
  | { kind: 'plain'; queue: AsyncEventQueue<AiStreamEvent> }
  | { kind: 'sequenced'; queue: AsyncEventQueue<SequencedEvent> };

type ActivePlanState = NonNullable<AiAttachState['activePlan']>;

function copyPlan(plan: ActivePlanState | null): ActivePlanState | null {
  return plan ? { ...plan, steps: plan.steps.map((s) => ({ ...s })) } : null;
}

/**
 * Pub/sub for the AiStreamEvents of ONE turn. `/messages` tears the in-memory
 * session (and so this bus) down before every turn (`streamingSessionManager
 * .remove()` → `closeAll()`), so a bus lives for exactly one turn.
 *
 * Besides fan-out it keeps what an attaching client (#9427,
 * `GET /ai/sessions/:id/stream`) needs to join mid-turn: a per-bus `seq`
 * stamped on every event, a byte-capped buffer of the whole turn, whether
 * `done` was published, the last `turn_model`, and the live action-plan state.
 * Plan state and `sawDone` are kept even after the buffer overflows, so a
 * snapshot is right at any `lastSeq`.
 *
 * Single-threaded by construction: `subscribeSequenced()` followed by
 * `snapshot()` in the same tick sees exactly the events with
 * `seq <= snapshot().lastSeq` in the snapshot and every later one on the
 * subscription — no duplicate and no gap.
 */
export class SessionEventBus {
  private subscribers = new Map<string, Subscriber>();
  private seq = 0;
  private isClosed = false;
  private buffer: AiStreamEvent[] = [];
  private bufferBytes = 0;
  private overflowed = false;
  private doneSeen = false;
  private lastTurnModel: AiTurnModel | null = null;
  /** Steps of each plan offered for approval this turn, by plan id. */
  private offeredPlans = new Map<string, ActionPlanStep[]>();
  private plan: ActivePlanState | null = null;

  /** Subscribe to events. Returns an async iterable. Closes any existing subscription with the same ID. */
  subscribe(id: string): AsyncIterable<AiStreamEvent> {
    const queue = new AsyncEventQueue<AiStreamEvent>();
    this.register(id, { kind: 'plain', queue });
    return queue;
  }

  /** Like `subscribe()`, but every event carries the bus's `seq`. */
  subscribeSequenced(id: string): AsyncIterable<SequencedEvent> {
    const queue = new AsyncEventQueue<SequencedEvent>();
    this.register(id, { kind: 'sequenced', queue });
    return queue;
  }

  private register(id: string, subscriber: Subscriber): void {
    // A closed bus never publishes again: hand back an iterable that has
    // already ended instead of one nothing would ever close.
    if (this.isClosed) {
      subscriber.queue.close();
      return;
    }
    // Close existing subscriber with same ID to prevent resource leak
    this.subscribers.get(id)?.queue.close();
    this.subscribers.set(id, subscriber);
  }

  /** Unsubscribe and close the subscriber's queue */
  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id);
    if (subscriber) {
      subscriber.queue.close();
      this.subscribers.delete(id);
    }
  }

  /** Stamp the next seq, record the event for attach, and publish it to all subscribers. */
  publish(event: AiStreamEvent): void {
    const seq = ++this.seq;
    this.record(event);

    for (const subscriber of this.subscribers.values()) {
      if (subscriber.kind === 'plain') subscriber.queue.push(event);
      else subscriber.queue.push({ seq, event });
    }
  }

  private record(event: AiStreamEvent): void {
    switch (event.type) {
      case 'done':
        this.doneSeen = true;
        break;
      case 'turn_model':
        this.lastTurnModel = event.turnModel;
        break;
      case 'plan_approval_required':
        this.offeredPlans.set(event.planId, event.steps.map((s) => ({ ...s })));
        break;
      case 'plan_step_start':
        if (this.plan?.planId === event.planId) {
          this.plan.currentStepIndex = event.stepIndex;
        } else {
          const offered = this.offeredPlans.get(event.planId) ?? [];
          this.plan = {
            planId: event.planId,
            steps: offered.map((s) => ({ ...s })),
            currentStepIndex: event.stepIndex,
            status: 'executing',
          };
        }
        break;
      case 'plan_step_complete':
        if (this.plan?.planId === event.planId) {
          const step = this.plan.steps[event.stepIndex];
          if (step) step.status = event.isError ? 'failed' : 'completed';
          this.plan.currentStepIndex = event.stepIndex + 1;
        }
        break;
      case 'plan_complete':
        if (this.plan?.planId === event.planId) this.plan.status = event.status;
        break;
      default:
        break;
    }

    if (this.overflowed) return;
    const stored: AiStreamEvent = event.type === 'plan_screenshot'
      ? { ...event, imageBase64: SCREENSHOT_REPLAY_PLACEHOLDER }
      : event;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
    } catch (err) {
      // Accounting must never stop fan-out (publish() is called from the SDK
      // loop and from inside approval waits). An event the replay cannot hold
      // makes the replay partial, exactly like an oversized one.
      console.warn('[AI] Session event not serializable for attach replay; replay is now partial:', event.type, err);
      bytes = Number.POSITIVE_INFINITY;
    }
    if (this.bufferBytes + bytes > ATTACH_REPLAY_MAX_BYTES) {
      this.overflowed = true;
      this.buffer = [];
      this.bufferBytes = 0;
      return;
    }
    this.buffer.push(stored);
    this.bufferBytes += bytes;
  }

  /**
   * The turn's events as an attaching client would receive them (screenshots
   * stripped; empty once the turn outgrew the buffer). Kept for tests that
   * inspect what a turn published.
   */
  getReplayEvents(fromIndex = 0): AiStreamEvent[] {
    return this.buffer.slice(fromIndex);
  }

  /** What an attach needs, as of `lastSeq`. Returns copies. */
  snapshot(): SessionEventBusSnapshot {
    return {
      lastSeq: this.seq,
      replay: this.overflowed ? [] : [...this.buffer],
      partial: this.overflowed,
      sawDone: this.doneSeen,
      activePlan: copyPlan(this.plan),
      turnModel: this.lastTurnModel,
    };
  }

  /** Close all subscriber queues; the bus accepts no further subscribers. */
  closeAll(): void {
    this.isClosed = true;
    for (const subscriber of this.subscribers.values()) {
      subscriber.queue.close();
    }
    this.subscribers.clear();
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get lastSeq(): number {
    return this.seq;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
