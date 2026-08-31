// Durable event subscriber registry (wave 3.5c, #4085).
//
// This is the registration surface production subscribers migrate onto in
// Task 3 (replacing `eventBus.subscribe()`), and the source `invokeLocalHandlers`
// consults for registry-aware local delivery. `partitionSubscribersForEvent` is
// the single place that decides local-vs-queue routing, so both the eventBus
// local-delivery path and the future eventDispatchWorker (queue path) agree on
// the exactly-one-of invariant: `local ∩ queue = ∅`, `local ∪ queue = matched`.
import { eventDispatchMode, eventDispatchQueueSubscribers } from '../config/env';
import type { SubscriberId } from './eventSubscriberIds';
import type { BreezeEvent, EventType } from './eventBus';

export interface DurableEventSubscriber {
  id: SubscriberId;
  eventTypes: readonly EventType[] | '*';
  /** MUST throw on failure (queue mode relies on it). Local delivery wraps. */
  handler: (event: BreezeEvent) => Promise<void>;
  /** Per-subscriber BullMQ retry policy for deliver-event jobs. */
  retry?: { attempts: number; backoffMs: number };
}

const registry = new Map<SubscriberId, DurableEventSubscriber>();

export function registerEventSubscriber(sub: DurableEventSubscriber): void {
  if (registry.has(sub.id)) {
    throw new Error(`duplicate event subscriber id: ${sub.id}`);
  }
  registry.set(sub.id, sub);
}

export function getRegisteredSubscribers(): readonly DurableEventSubscriber[] {
  return [...registry.values()];
}

export function getSubscriberById(id: SubscriberId): DurableEventSubscriber | undefined {
  return registry.get(id);
}

/** '*' or exact type match, sorted by id (deterministic — see #4085 wave-3.5c). */
export function subscribersMatching(type: EventType): DurableEventSubscriber[] {
  return [...registry.values()]
    .filter((sub) => sub.eventTypes === '*' || sub.eventTypes.includes(type))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function partitionSubscribersForEvent(type: EventType): {
  matched: SubscriberId[];
  local: DurableEventSubscriber[];
  queue: DurableEventSubscriber[];
} {
  const matchedSubs = subscribersMatching(type);
  const matched = matchedSubs.map((sub) => sub.id);

  if (eventDispatchMode() !== 'enforce') {
    return { matched, local: matchedSubs, queue: [] };
  }

  const queueSubscribers = eventDispatchQueueSubscribers();
  const local: DurableEventSubscriber[] = [];
  const queue: DurableEventSubscriber[] = [];
  for (const sub of matchedSubs) {
    if (queueSubscribers.has(sub.id)) queue.push(sub);
    else local.push(sub);
  }
  return { matched, local, queue };
}

export function _resetEventSubscriberRegistryForTests(): void {
  registry.clear();
}
