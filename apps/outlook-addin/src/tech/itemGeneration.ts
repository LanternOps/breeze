/**
 * Item-generation store: a monotonically increasing counter bumped on every
 * mailbox ItemChanged (pinned-pane item switch), plus a REAL subscribe/
 * unsubscribe so callers (e.g. a stale in-flight header read) can tell whether
 * the open item changed out from under them.
 *
 * Built on top of `subscribeOutlookItemChanged` (host/outlookSelection.ts),
 * which supports real per-subscriber unsubscribe — this store just adds
 * the "which generation am I" counter on top of that raw event stream.
 */
import { subscribeOutlookItemChanged } from '../host/outlookSelection';

export interface ItemGenerationStore {
  /** The current generation number (starts at 0, bumps by 1 on each item switch). */
  current(): number;
  /** Subscribe to generation bumps. Returns a real unsubscribe — after calling
   *  it, `onChange` is never invoked again for this store. */
  subscribe(onChange: (generation: number) => void): () => void;
}

export function createItemGenerationStore(): ItemGenerationStore {
  let generation = 0;
  const subscribers = new Set<(generation: number) => void>();

  subscribeOutlookItemChanged(() => {
    generation += 1;
    // Isolate subscribers from each other: a throwing subscriber must not
    // abort the loop and starve every later subscriber of this bump.
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(generation);
      } catch (error) {
        console.error('createItemGenerationStore: subscriber threw', error);
      }
    }
  });

  return {
    current: () => generation,
    subscribe(onChange: (generation: number) => void): () => void {
      subscribers.add(onChange);
      return () => {
        subscribers.delete(onChange);
      };
    },
  };
}
