import type { AiStreamEvent } from '@breeze/shared/types/ai';
import { AsyncEventQueue } from '../utils/asyncQueue';

const EVENT_RING_BUFFER_SIZE = 100;

// ============================================
// SessionEventBus
// ============================================

/**
 * Pub/sub for AiStreamEvent. Multiple SSE subscribers can listen.
 * Ring buffer stores last N events for potential reconnection replay.
 */
export class SessionEventBus {
  private subscribers = new Map<string, AsyncEventQueue<AiStreamEvent>>();
  private ringBuffer: AiStreamEvent[] = [];

  /** Subscribe to events. Returns an async iterable. Closes any existing subscription with the same ID. */
  subscribe(id: string): AsyncIterable<AiStreamEvent> {
    // Close existing subscriber with same ID to prevent resource leak
    const existing = this.subscribers.get(id);
    if (existing) {
      existing.close();
    }
    const queue = new AsyncEventQueue<AiStreamEvent>();
    this.subscribers.set(id, queue);
    return queue;
  }

  /** Unsubscribe and close the subscriber's queue */
  unsubscribe(id: string): void {
    const queue = this.subscribers.get(id);
    if (queue) {
      queue.close();
      this.subscribers.delete(id);
    }
  }

  /** Publish an event to all subscribers and the ring buffer */
  publish(event: AiStreamEvent): void {
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > EVENT_RING_BUFFER_SIZE) {
      this.ringBuffer.shift();
    }

    for (const queue of this.subscribers.values()) {
      queue.push(event);
    }
  }

  /** Get recent events from the ring buffer for reconnection replay */
  getReplayEvents(fromIndex = 0): AiStreamEvent[] {
    return this.ringBuffer.slice(fromIndex);
  }

  /** Close all subscriber queues */
  closeAll(): void {
    for (const queue of this.subscribers.values()) {
      queue.close();
    }
    this.subscribers.clear();
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
