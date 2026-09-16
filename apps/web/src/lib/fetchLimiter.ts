export const DEFAULT_FETCH_LIMIT = 6;

type Waiter = { grant: () => void };
type Semaphore = { active: number; limit: number; queue: Waiter[] };

const semaphores = new Map<string, Semaphore>();
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

/** Callers sharing a key share its limit until all slots have been released. */
export function acquire(
  key: string,
  limit = DEFAULT_FETCH_LIMIT,
  signal?: AbortSignal,
): Promise<() => void> {
  if (!Number.isInteger(limit) || limit < 1) {
    return Promise.reject(new RangeError('Fetch limit must be a positive integer.'));
  }
  if (signal?.aborted) return Promise.reject(abortError());

  let semaphore = semaphores.get(key);
  if (!semaphore) {
    semaphore = { active: 0, limit, queue: [] };
    semaphores.set(key, semaphore);
  }
  const state = semaphore;

  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      grant() {
        signal?.removeEventListener('abort', onAbort);
        state.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          state.active--;
          const next = state.queue.shift();
          if (next) next.grant();
          else if (state.active === 0) semaphores.delete(key);
        });
      },
    };
    const onAbort = () => {
      const index = state.queue.indexOf(waiter);
      if (index !== -1) state.queue.splice(index, 1);
      reject(abortError());
    };

    if (state.active < state.limit) waiter.grant();
    else {
      state.queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}
